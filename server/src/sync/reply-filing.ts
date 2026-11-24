/**
 * The rule to file an email when a reply the person writes in Gmail or Outlook finishes its to-dos. An owner or admin
 * switches it on in Settings. Ticking the to-dos happens either way (projectThread in ingest.ts); with the rule on,
 * the email is filed too, as if the person had ticked its last to-do in Timmy (finishedPlace in src/state/store.tsx):
 * archived, or to Waiting when their reply asked the other side for something. In Timmy at once, and in the mailbox
 * through the gateway: one effect record per email, approved by the rule, written once whatever retries. A reply
 * written before the rule was switched on files nothing, in Timmy or the mailbox.
 */
import { fileFinished, finishedPlace, openTodos, type State } from '../../../src/state/store';
import type { Tx } from '../db/pool';
import { audit, propose } from '../gateway/gateway';
import { newId } from '../lib/ids';
import type { Loaded } from '../state/docs';
import { filingProposal } from './labels';

export const REPLY_FILING_SCOPE = { file: 'when-a-reply-finishes-its-to-dos' } as const;

export interface ReplyFilingRule {
  id: string;
  /** When it was switched on. Replies written before this file nothing. */
  since: Date;
  by: string;
}

export async function replyFilingRule(tx: Tx, workspaceId: string): Promise<ReplyFilingRule | null> {
  const { rows } = await tx.query(
    `select id, created_at, created_by from policy where workspace_id = $1 and kind = 'mail.modify' and enabled and scope = $2::jsonb order by created_at desc limit 1`,
    [workspaceId, JSON.stringify(REPLY_FILING_SCOPE)],
  );
  const r = rows[0];
  return r ? { id: r.id as string, since: new Date(r.created_at as string), by: r.created_by as string } : null;
}

/** Switches the rule on or off. Only an owner or admin may (the caller checks); it names them. */
export async function setReplyFiling(tx: Tx, workspaceId: string, userId: string, on: boolean): Promise<boolean> {
  const current = await replyFilingRule(tx, workspaceId);
  if (on === !!current) return false;
  await tx.query(`update policy set enabled = false, updated_at = now() where workspace_id = $1 and kind = 'mail.modify' and enabled and scope = $2::jsonb`, [workspaceId, JSON.stringify(REPLY_FILING_SCOPE)]);
  if (on) {
    const id = newId('pol');
    await tx.query('insert into policy (id, workspace_id, kind, scope, enabled, label, created_by) values ($1, $2, $3, $4::jsonb, true, $5, $6)', [
      id,
      workspaceId,
      'mail.modify',
      JSON.stringify(REPLY_FILING_SCOPE),
      'File an email when my reply in Gmail or Outlook finishes its to-dos: archived, or to Waiting when my reply asked for something.',
      userId,
    ]);
    await audit(tx, workspaceId, { actor: userId, action: 'replyfiling.switched_on', detail: { rule: id } });
  } else await audit(tx, workspaceId, { actor: userId, action: 'replyfiling.switched_off', detail: {} });
  return true;
}

/**
 * Files the emails in `ids` that a reply in the mailbox just finished: open to-dos before this batch of mail, none
 * after it, the person's own message the newest, still in Triage or Follow Up with no draft waiting. Only with the
 * rule on, and only for a reply written after it was switched on.
 */
export async function fileAfterReplies(tx: Tx, loaded: Loaded, before: State, state: State, ids: Set<string>): Promise<State> {
  const finished = state.threads.filter((t) => {
    const newest = t.messages[t.messages.length - 1];
    return ids.has(t.id) && (t.box === 'inbox' || t.box === 'follow-up') && !t.draft && newest?.from === 'me' && openTodos(before.ws.tasks, t.id).length > 0 && openTodos(state.ws.tasks, t.id).length === 0;
  });
  if (!finished.length) return state;
  const rule = await replyFilingRule(tx, loaded.workspace.id);
  if (!rule) return state;
  const now = new Date();
  let next = state;
  for (const t of finished) {
    const mine = t.messages[t.messages.length - 1]!;
    if (new Date(mine.at).getTime() < rule.since.getTime()) continue;
    const app = t.ext?.app === 'outlook' ? 'Outlook' : 'Gmail';
    const place = finishedPlace(t, now);
    const where = place.box === 'waiting' ? 'moved it to [02] Waiting' : 'archived it';
    const filed = fileFinished(t, place, `Your reply in ${app} finished its to-dos, so Timmy ${where}, as your rule says`, now);
    next = {
      ...next,
      threads: next.threads.map((x) => (x.id === t.id ? filed : x)),
      activity: [{ id: newId('act'), at: now, kind: 'move' as const, text: `“${t.subject}” ${place.box === 'waiting' ? 'moved to Waiting' : 'archived'}: your reply in ${app} finished its to-dos (your rule)`, threadId: t.id }, ...next.activity],
    };
    const filing = filingProposal(filed, filed.box);
    if (!filing) continue;
    const p = await propose(tx, loaded, next, null, {
      ...filing,
      why: 'Your reply finished its to-dos, and your rule says to file such emails.',
      idempotencyKey: `replyfile:${t.id}:${mine.id}`,
      source: 'rule',
      meta: { ...REPLY_FILING_SCOPE },
    });
    if (p.outcome !== 'blocked') next = p.state;
  }
  return next;
}
