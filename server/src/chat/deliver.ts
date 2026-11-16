/**
 * Shows an approved reply to the visitor. This is the executor for the `chat.reply` effect: the Action gateway
 * calls it once for an approved record, and nothing else makes a reply visible.
 *
 * "Shown" means the message gets its place in the conversation's order. That is one database update on a row
 * that can only be updated once, so the same reply is never shown twice, whoever retries.
 */
import type { EffectRow, Outcome } from '../gateway/gateway';
import { config } from '../config';
import { withWorkspace } from '../db/pool';
import { mutate } from '../state/mutate';
import { announce, announceEverywhere } from './hub';
import { withMessage } from './shown';
import { textMark } from './token';

export interface ReplyPayload {
  conversationId: string;
  messageId: string;
  /** Fingerprint of the text that was approved (see token.ts). */
  mark: string;
  sender: 'timmy' | 'member';
}

/** A reply that never reached the visitor says so on the Chats screen, instead of looking sent. */
async function markUndelivered(e: EffectRow, p: ReplyPayload, reason: string): Promise<Outcome> {
  await mutate(e.workspace_id, 'chat', async (tx, loaded) => {
    const row = (await tx.query('update chat_message set failed = $3 where id = $1 and workspace_id = $2 and seq is null returning sender, client_id', [p.messageId, e.workspace_id, reason])).rows[0] as { sender: string; client_id: string | null } | undefined;
    if (!row) return { result: null };
    // A teammate's reply is listed on the screen under the id their own screen gave it.
    const shownId = row.sender === 'member' && row.client_id ? row.client_id : p.messageId;
    return { state: withMessage(loaded.state, p.conversationId, shownId, { undelivered: true }), result: null };
  });
  return { status: 'failed', error: reason };
}

export async function sendChatReply(e: EffectRow): Promise<Outcome> {
  const p = e.payload as unknown as ReplyPayload;
  const workspaceId = e.workspace_id;
  // The workspace's lock is held while the message takes its place, so places are handed out in the order they are committed.
  const refused = await withWorkspace<string | null>({ workspaceId, lock: true }, async (tx) => {
    const m = (
      await tx.query(
        `select m.id, m.body, m.seq, m.sender, m.created_at, c.live from chat_message m join chat_conversation c on c.id = m.conversation_id
         where m.id = $1 and m.workspace_id = $2 and m.conversation_id = $3 and m.effect_id = $4 for update of m`,
        [p.messageId, workspaceId, p.conversationId, e.id],
      )
    ).rows[0] as { id: string; body: string; seq: number | null; sender: string; created_at: Date; live: boolean } | undefined;
    if (!m) return 'The conversation was deleted before the reply was shown.';
    // Already shown: saying so again is all there is to do.
    if (m.seq !== null) return null;
    if ((await textMark(m.body)) !== p.mark) return 'The reply is not the one that was approved.';
    const on = (await tx.query('select 1 from chat_widget where workspace_id = $1 and is_on', [workspaceId])).rowCount;
    if (!on) return 'The website chat was switched off before the reply was shown.';
    if (m.sender === 'timmy' && m.live) return 'A teammate took over the chat before Timmy’s reply was shown.';
    // An approval is for now. A reply held up this long (sending was switched off, the server was down) would arrive out of nowhere.
    if (Date.now() - new Date(m.created_at).getTime() > config.chat.replyFreshSeconds * 1000) return 'Too much time passed before the reply could be shown.';
    await tx.query(`update chat_message set seq = nextval('chat_message_seq'), sent_at = now() where id = $1 and workspace_id = $2 and seq is null`, [m.id, workspaceId]);
    await announceEverywhere(tx, p.conversationId);
    return null;
  });
  if (refused) return markUndelivered(e, p, refused);
  announce(p.conversationId);
  return { status: 'completed', result: { conversationId: p.conversationId, messageId: p.messageId }, externalId: p.messageId };
}

/**
 * For a reply whose outcome was never recorded (the process stopped mid-way). Unlike an email, there is no
 * doubt to live with: the message row says whether it was shown.
 */
export async function reconcileChatReply(e: EffectRow): Promise<Outcome> {
  const p = e.payload as unknown as ReplyPayload;
  const shown = await withWorkspace({ workspaceId: e.workspace_id }, async (tx) => (await tx.query('select 1 from chat_message where id = $1 and workspace_id = $2 and seq is not null', [p.messageId, e.workspace_id])).rowCount);
  if (shown) return { status: 'completed', result: { conversationId: p.conversationId, messageId: p.messageId, reconciled: true }, externalId: p.messageId };
  return markUndelivered(e, p, 'It was never shown to the visitor.');
}
