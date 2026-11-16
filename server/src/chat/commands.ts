/**
 * What a teammate does to a visitor's conversation: reply, take over or hand back, star, mark as read, delete.
 *
 * Each arrives as a `chat` command. The shared reducer says what the screen shows; this file does the part
 * only a server can do, in the same transaction: a reply goes through the Action gateway before the visitor
 * sees it, taking over stops Timmy, and deleting removes the stored copy.
 */
import type { ChatOp } from '../../../src/state/chat';
import type { State } from '../../../src/state/store';
import { config } from '../config';
import type { Tx } from '../db/pool';
import { audit, executeEffect, propose, type EffectRow } from '../gateway/gateway';
import type { Actor } from '../gateway/policy';
import { newId } from '../lib/ids';
import { log } from '../lib/log';
import type { Loaded } from '../state/docs';
import type { Ctx } from '../state/engine';
import { newestMessages, withoutConversations } from './shown';
import { textMark } from './token';
import { cleanText } from './visitor';

export interface ChatHandled {
  state: State;
  reject?: string;
  toast?: { text: string };
  effects?: EffectRow[];
}

const ID = /^[\w-]{1,80}$/;
const GONE = 'That chat is no longer here.';

/**
 * Runs one chat command. `apply` is the shared reducer, bound to this workspace by the command engine.
 */
export async function chatCommand(tx: Tx, loaded: Loaded, ctx: Ctx, actor: Actor, commandId: string, op: ChatOp, apply: (op: ChatOp) => State | undefined): Promise<ChatHandled> {
  const state = loaded.state;
  const workspaceId = ctx.workspaceId;
  if (!op || typeof op !== 'object' || typeof op.id !== 'string' || !ID.test(op.id)) return { state, reject: 'That isn’t a command.' };
  const shown = state.ws.chats[op.id];
  const applied = (change: ChatOp): ChatHandled => {
    const next = apply(change);
    return next ? { state: next } : { state, reject: 'That command couldn’t be applied.' };
  };

  switch (op.op) {
    // Flags only teammates see. They live with the screen's copy; the stored conversation has no such thing.
    case 'star':
      if (!shown) return { state, reject: GONE };
      return applied({ op: 'star', id: op.id, on: op.on === true });
    case 'read':
      if (!shown) return { state, reject: GONE };
      return applied({ op: 'read', id: op.id });

    case 'takeOver': {
      // Whoever takes a chat over is about to speak for the business, so it takes the same right as sending.
      if (!ctx.rules.approveSends) return { state, reject: 'Your role can’t take over a visitor’s chat.' };
      const on = op.on === true;
      const row = (await tx.query('update chat_conversation set live = $3, urgent = case when $3 then false else urgent end where id = $1 and workspace_id = $2 returning id', [op.id, workspaceId, on])).rows[0];
      if (!row || !shown) return { state, reject: GONE };
      await audit(tx, workspaceId, { actor: ctx.user.id, action: on ? 'chat.taken_over' : 'chat.handed_back', detail: { conversation: op.id } });
      return applied({ op: 'takeOver', id: op.id, on });
    }

    case 'reply': {
      if (!ctx.rules.approveSends) return { state, reject: 'Your role can’t reply to visitors. Ask an owner, admin or member to take over the chat.' };
      if (typeof op.text !== 'string' || typeof op.message !== 'string' || !ID.test(op.message)) return { state, reject: 'That isn’t a command.' };
      const text = cleanText(op.text);
      if (!text) return { state, reject: 'Write something first.' };
      if (text.length > config.chat.maxMessageChars) return { state, reject: `That reply is too long. Keep it under ${config.chat.maxMessageChars.toLocaleString('en-US')} characters.` };
      const conv = (await tx.query('select id, live from chat_conversation where id = $1 and workspace_id = $2 for update', [op.id, workspaceId])).rows[0] as { id: string; live: boolean } | undefined;
      if (!conv || !shown) return { state, reject: GONE };
      if (!conv.live) return { state, reject: 'Take over the chat before you reply. Until then Timmy is answering.' };
      if (!(await tx.query('select 1 from chat_widget where workspace_id = $1 and is_on', [workspaceId])).rowCount) return { state, reject: 'The website chat is switched off, so the visitor can’t be reached.' };
      if (shown.messages.some((m) => m.id === op.message) || (await tx.query('select 1 from chat_message where conversation_id = $1 and client_id = $2', [conv.id, op.message])).rowCount) return { state, reject: 'That reply was already sent.' };

      // The person's own click on Send is the approval, and there is no hold. The record is made before the
      // message exists anywhere a visitor could read it.
      const id = newId('cm');
      const p = await propose(tx, loaded, state, actor, {
        kind: 'chat.reply',
        payload: { conversationId: conv.id, messageId: id, mark: await textMark(text), sender: 'member' },
        preview: { lines: ['A reply typed by a teammate to a visitor in the website chat.'] },
        title: 'Reply in the website chat',
        why: 'You pressed Send.',
        target: `chat:${conv.id}`,
        idempotencyKey: `cmd:${commandId}:chat`,
        source: 'user',
        commandId,
      });
      if (p.outcome === 'blocked') return { state, reject: p.reason };
      // Anything short of approved (this person's send would wait for someone else) is refused: a chat reply is not queued.
      if (p.outcome !== 'approved' || !p.effect) return { state, reject: 'Your role can’t reply to visitors.' };
      await tx.query(`insert into chat_message (id, workspace_id, conversation_id, sender, member_id, member_name, client_id, body, effect_id) values ($1, $2, $3, 'member', $4, $5, $6, $7, $8)`, [id, workspaceId, conv.id, ctx.user.id, ctx.user.name, op.message, text, p.effect.id]);
      await tx.query('update chat_conversation set urgent = false, last_message_at = now() where id = $1 and workspace_id = $2', [conv.id, workspaceId]);
      // Who wrote it is the server's to say, never the caller's.
      const next = apply({ op: 'reply', id: op.id, text, message: op.message, by: ctx.user.name });
      if (!next) return { state, reject: 'That command couldn’t be applied.' };
      const c = next.ws.chats[op.id]!;
      const { messages, dropped } = newestMessages(c.messages);
      const trimmed = dropped ? { ...next, ws: { ...next.ws, chats: { ...next.ws.chats, [c.id]: { ...c, messages, earlier: (c.earlier ?? 0) + dropped } } } } : next;
      return { state: trimmed, effects: [p.effect] };
    }

    case 'delete': {
      const gone = await deleteConversations(tx, workspaceId, [op.id]);
      if (!gone.length && !shown) return { state, reject: GONE };
      await audit(tx, workspaceId, { actor: ctx.user.id, action: 'chat.deleted', detail: { conversation: op.id } });
      return { state: withoutConversations(state, [op.id]), toast: { text: 'Chat deleted. Its messages are removed from Timmy.' } };
    }

    default:
      return { state, reject: 'That isn’t a command.' };
  }
}

/**
 * Removes conversations for good: the stored messages, and every other place their words were kept (the record
 * of screen changes that tabs catch up from, and what earlier commands answered and saved for Undo). What
 * remains is the audit log and the effect records, which hold ids and fingerprints but none of the words.
 */
export async function deleteConversations(tx: Tx, workspaceId: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const { rows } = await tx.query('delete from chat_conversation where workspace_id = $1 and id = any($2::text[]) returning id', [workspaceId, ids]);
  for (const id of ids) {
    const about = JSON.stringify([{ s: 'ws.chats', id }]);
    await tx.query(
      `update state_change set patches = (select coalesce(jsonb_agg(p), '[]'::jsonb) from jsonb_array_elements(patches) p where not (p->>'s' = 'ws.chats' and p->>'id' = $2))
       where workspace_id = $1 and patches @> $3::jsonb`,
      [workspaceId, id, about],
    );
    await tx.query(
      `update command set pre = (select coalesce(jsonb_agg(p), '[]'::jsonb) from jsonb_array_elements(pre) p where not (p->>'s' = 'ws.chats' and p->>'id' = $2))
       where workspace_id = $1 and pre @> $3::jsonb`,
      [workspaceId, id, about],
    );
    await tx.query(
      `update command set result = jsonb_set(result, '{patches}', (select coalesce(jsonb_agg(p), '[]'::jsonb) from jsonb_array_elements(result->'patches') p where not (p->>'s' = 'ws.chats' and p->>'id' = $2)))
       where workspace_id = $1 and result->'patches' @> $3::jsonb`,
      [workspaceId, id, about],
    );
  }
  return rows.map((r) => r.id as string);
}

/** What is kept of a chat command for retries: which command it was, without the words of a reply. */
export function chatCommandForRecord(action: { type: 'chat'; op: ChatOp }): unknown {
  const op = action.op as Partial<ChatOp> & Record<string, unknown>;
  return { type: 'chat', op: { op: op?.op, id: op?.id, ...(op?.op === 'reply' ? { message: op.message } : {}) } };
}

/** Shows a teammate's reply to the visitor as soon as the command that made it is saved. */
export async function sendChatRepliesNow(workspaceId: string, effects: EffectRow[] | undefined) {
  for (const e of effects ?? []) {
    if (e.kind !== 'chat.reply' || e.status !== 'approved') continue;
    await executeEffect(workspaceId, e.id).catch((err) => log.warn('a chat reply could not be shown yet', { effectId: e.id, error: (err as Error).message }));
  }
}
