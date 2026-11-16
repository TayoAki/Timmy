/**
 * Preparing an email for the gateway. Whether a person pressed Send or Timmy
 * prepared it in chat, the same checks apply and the same record is built:
 * real addresses, which mailbox it leaves from, and one send per thread at a time.
 */
import type { Tx } from '../db/pool';
import type { Proposal } from './gateway';

export const ADDRESS = /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[a-z]{2,}$/i;

export interface MailSend {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  /** The thread it belongs to on Timmy's side, when there is one. */
  threadId?: string;
  /** Set for a thread that already exists: where it lives in the mailbox. */
  existing?: { threadKey?: string; connectionId?: string };
  /** The id the screen gave the message, so the sent copy can take its place. */
  localMessageId?: string;
}

export type PreparedMail = { ok: false; reason: string } | { ok: true; proposal: Pick<Proposal, 'kind' | 'payload' | 'preview' | 'title' | 'target' | 'thread'> };

export async function prepareMailSend(tx: Tx, workspaceId: string, m: MailSend): Promise<PreparedMail> {
  const to = m.to.map((x) => x.trim().toLowerCase());
  const bad = to.find((x) => !ADDRESS.test(x));
  if (bad !== undefined) return { ok: false, reason: `“${bad}” isn’t an email address Timmy can send to.` };
  if (!to.length) return { ok: false, reason: 'Add a recipient first.' };
  const cc = m.cc.map((x) => x.trim().toLowerCase()).filter((x) => ADDRESS.test(x));

  const boxes = (await tx.query(`select id, account_label from connection where workspace_id = $1 and status = 'active' and purpose = 'primary' and app_id = 'gmail' order by created_at`, [workspaceId])).rows as { id: string; account_label: string | null }[];
  if (!boxes.length) return { ok: false, reason: 'Connect Gmail first, then send.' };
  // A reply leaves from the mailbox its thread arrived in, in that thread. Anything else leaves from the workspace's mailbox as a new email.
  const home = m.existing?.connectionId ? boxes.find((b) => b.id === m.existing!.connectionId) : undefined;
  const mailbox = home ?? boxes[0]!;
  const threadKey = m.existing?.threadKey && (home || !m.existing.connectionId) ? m.existing.threadKey : undefined;

  if (m.existing && m.threadId) {
    // One send per thread at a time: a second one while the first is waiting or going out would send it twice.
    const live = await tx.query(`select 1 from effect where workspace_id = $1 and kind in ('email.send', 'email.reply') and preview->>'thread' = $2 and status in ('intended', 'approved', 'executing', 'uncertain') limit 1`, [workspaceId, m.threadId]);
    if (live.rows[0]) return { ok: false, reason: 'This thread already has an email waiting to go out. Undo or decide that one first.' };
  }
  return {
    ok: true,
    proposal: {
      kind: threadKey ? 'email.reply' : 'email.send',
      payload: { connectionId: mailbox.id, to, cc, subject: m.subject, body: m.body, threadKey, ...(m.localMessageId ? { localMessageId: m.localMessageId } : {}) },
      preview: { from: mailbox.account_label ?? undefined, to, cc, subject: m.subject, body: m.body },
      title: `${threadKey ? 'Reply' : 'Send'} “${m.subject}” to ${to.join(', ')}`,
      target: to.join(', '),
      thread: m.threadId,
    },
  };
}
