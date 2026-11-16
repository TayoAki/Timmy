import type { Box } from '../../../src/data/types';
import { labelPlan, timmyLabels } from '../sync/labels';
import { callTool, connectionById } from '../sync/tools';
import type { EffectRow, Outcome } from './gateway';
import type { EffectKind } from './policy';

/**
 * One executor per kind of write. An executor gets the stored payload, exactly
 * as it was approved, and reports what happened:
 *   completed — the provider confirmed it;
 *   failed    — the provider refused, and nothing left;
 *   a thrown error means the outcome is unknown, and the gateway marks it uncertain.
 *
 * Composio does not deduplicate executions. Its SDK (@composio/core 0.29) sends tool executions
 * with retries off for that reason; when upgrading it, check that `tools.execute` still does
 * (search its build for `withoutRetries`), or a timed-out send could be repeated by the SDK itself.
 */
type Executor = (e: EffectRow) => Promise<Outcome>;

interface MailPayload {
  connectionId: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  threadKey?: string;
}

const sendMail: Executor = async (e) => {
  const p = e.payload as unknown as MailPayload;
  if (!p.to?.length) return { status: 'failed', error: 'There is no recipient.' };
  const conn = await connectionById(e.workspace_id, p.connectionId);
  if (!conn || conn.status !== 'active') return { status: 'failed', error: 'The mailbox is no longer connected.' };
  const reply = e.kind === 'email.reply' && !!p.threadKey;
  const [first, ...rest] = p.to;

  // Each mail provider has its own send call; one that isn't wired here is refused, never sent through another's.
  if (conn.toolkit !== 'gmail') return { status: 'failed', error: 'Sending from this kind of mailbox isn’t available yet.' };

  const res = reply
    ? await callTool(e.workspace_id, conn.id, 'GMAIL_REPLY_TO_THREAD', { thread_id: p.threadKey, message_body: p.body, recipient_email: first, extra_recipients: rest, cc: p.cc ?? [], is_html: false }, 'send')
    : await callTool(e.workspace_id, conn.id, 'GMAIL_SEND_EMAIL', { recipient_email: first, extra_recipients: rest, cc: p.cc ?? [], subject: p.subject, body: p.body, is_html: false }, 'send');
  if (!res.successful) return { status: 'failed', error: res.error ?? 'Gmail refused the message.' };
  const sent = ((res.data.response_data ?? res.data) as { id?: string; threadId?: string }) ?? {};
  return { status: 'completed', result: { via: 'gmail', id: sent.id, threadId: sent.threadId ?? p.threadKey }, externalId: sent.id };
};

interface FilePayload {
  connectionId: string;
  threadKey: string;
  box: Box;
}

/** Writes a thread's place (a label, or archived) to the mailbox. */
const fileMail: Executor = async (e) => {
  const p = e.payload as unknown as FilePayload;
  const conn = await connectionById(e.workspace_id, p.connectionId);
  if (!conn || conn.status !== 'active') return { status: 'failed', error: 'The mailbox is no longer connected.' };
  if (conn.toolkit !== 'gmail') return { status: 'failed', error: 'Filing in this kind of mailbox isn’t available yet.' };
  const change = async (refresh: boolean) => {
    const plan = labelPlan(p.box, await timmyLabels(e.workspace_id, conn, refresh));
    return { plan, res: await callTool(e.workspace_id, conn.id, 'GMAIL_MODIFY_THREAD_LABELS', { thread_id: p.threadKey, add_label_ids: plan.add, remove_label_ids: plan.remove }, 'send') };
  };
  const remembered = !!conn.meta.labels;
  let { plan, res } = await change(false);
  // The label ids are remembered. If the person deleted a label in Gmail the remembered id is refused, so a
  // refusal is tried once more with the labels looked up afresh. A refused change changed nothing.
  if (!res.successful && remembered) ({ plan, res } = await change(true));
  if (!res.successful) return { status: 'failed', error: res.error ?? 'Gmail refused the change.' };
  return { status: 'completed', result: { via: 'gmail', added: plan.add, removed: plan.remove } };
};

export const EXECUTORS: Partial<Record<EffectKind, Executor>> = {
  'email.send': sendMail,
  'email.reply': sendMail,
  'mail.modify': fileMail,
};

/** Whether the mailbox already shows the filing an effect asked for. */
async function reconcileFiling(e: EffectRow): Promise<Outcome> {
  const unknown: Outcome = { status: 'uncertain', error: e.error ?? 'unknown' };
  const p = e.payload as unknown as FilePayload;
  const conn = await connectionById(e.workspace_id, p.connectionId);
  if (!conn || conn.status !== 'active' || conn.toolkit !== 'gmail') return unknown;
  const plan = labelPlan(p.box, await timmyLabels(e.workspace_id, conn));
  const res = await callTool(e.workspace_id, conn.id, 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID', { thread_id: p.threadKey }, 'send');
  const messages = res.successful ? ((res.data.messages ?? []) as { labelIds?: string[] }[]) : [];
  if (!messages.length) return unknown;
  // Sent copies never carry INBOX, so the inbox label is judged on any message; Timmy's labels on every message.
  const has = (id: string) => (id === 'INBOX' ? messages.some((m) => m.labelIds?.includes(id)) : messages.every((m) => m.labelIds?.includes(id)));
  const lacks = (id: string) => messages.every((m) => !m.labelIds?.includes(id));
  return plan.add.every(has) && plan.remove.every(lacks) ? { status: 'completed', result: { via: 'gmail', reconciled: true } } : unknown;
}

/**
 * For an effect whose outcome is unknown: look for evidence that it happened.
 * Returns completed when found and uncertain otherwise. It never returns
 * failed: absence of evidence is not evidence that nothing was sent.
 */
export async function reconcile(e: EffectRow): Promise<Outcome> {
  if (e.kind === 'mail.modify') return reconcileFiling(e);
  if (e.kind !== 'email.send' && e.kind !== 'email.reply') return { status: 'uncertain', error: e.error ?? 'unknown' };
  const p = e.payload as unknown as MailPayload;
  const started = e.executing_at ? new Date(e.executing_at) : new Date(e.created_at);
  const conn = await connectionById(e.workspace_id, p.connectionId);
  if (!conn || conn.toolkit !== 'gmail') return { status: 'uncertain', error: e.error ?? 'unknown' };
  const after = Math.floor(started.getTime() / 1000) - 120;
  const subject = e.kind === 'email.reply' ? '' : ` subject:"${p.subject.replace(/"/g, '')}"`;
  const res = await callTool(e.workspace_id, conn.id, 'GMAIL_FETCH_EMAILS', { query: `in:sent to:${p.to[0]}${subject} after:${after}`, max_results: 10, include_payload: false }, 'send');
  if (!res.successful) return { status: 'uncertain', error: res.error ?? 'could not check the Sent folder' };
  // Compare on the words only: line endings and spacing differ between what was sent and what the provider returns.
  const words = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 200);
  const found = ((res.data.messages ?? []) as { messageId: string; threadId: string; to?: string; messageText?: string }[]).find(
    (m) => (m.to ?? '').toLowerCase().includes(p.to[0]!.toLowerCase()) && (!p.threadKey || m.threadId === p.threadKey) && (!m.messageText || words(m.messageText).startsWith(words(p.body).slice(0, 80))),
  );
  if (found) return { status: 'completed', result: { via: 'gmail', id: found.messageId, threadId: found.threadId, reconciled: true }, externalId: found.messageId };
  // Not finding it proves nothing: Sent can lag, and the copy can differ. It stays unconfirmed for a person to check;
  // calling it "not sent" would invite sending it a second time.
  return { status: 'uncertain', error: e.error ?? 'unknown' };
}
