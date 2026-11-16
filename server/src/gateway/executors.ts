import { reconcileChatReply, sendChatReply } from '../chat/deliver';
import { createEvent, reconcileEvent } from '../sync/calendar-write';
import { mailboxFor, type FilePayload, type MailPayload } from '../sync/mailbox';
import { connectionById } from '../sync/tools';
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

const sendMail: Executor = async (e) => {
  const p = e.payload as unknown as MailPayload;
  if (!p.to?.length) return { status: 'failed', error: 'There is no recipient.' };
  const conn = await connectionById(e.workspace_id, p.connectionId);
  if (!conn || conn.status !== 'active') return { status: 'failed', error: 'The mailbox is no longer connected.' };
  // Each mail provider has its own send call; one that isn't wired is refused, never sent through another's.
  const box = mailboxFor(conn.toolkit);
  if (!box) return { status: 'failed', error: 'Sending from this kind of mailbox isn’t available yet.' };
  return box.send(e, conn, p);
};

/** Writes a thread's place (a label or category, or archived) to the mailbox. */
const fileMail: Executor = async (e) => {
  const p = e.payload as unknown as FilePayload;
  const conn = await connectionById(e.workspace_id, p.connectionId);
  if (!conn || conn.status !== 'active') return { status: 'failed', error: 'The mailbox is no longer connected.' };
  const box = mailboxFor(conn.toolkit);
  if (!box) return { status: 'failed', error: 'Filing in this kind of mailbox isn’t available yet.' };
  return box.file(e, conn, p);
};

export const EXECUTORS: Partial<Record<EffectKind, Executor>> = {
  'email.send': sendMail,
  'email.reply': sendMail,
  'mail.modify': fileMail,
  'calendar.create': createEvent,
  'chat.reply': sendChatReply,
};

/** Whether the mailbox already shows the filing an effect asked for. */
async function reconcileFiling(e: EffectRow): Promise<Outcome> {
  const unknown: Outcome = { status: 'uncertain', error: e.error ?? 'unknown' };
  const p = e.payload as unknown as FilePayload;
  const conn = await connectionById(e.workspace_id, p.connectionId);
  const box = conn && mailboxFor(conn.toolkit);
  if (!conn || !box || conn.status !== 'active') return unknown;
  return (await box.filed(e, conn, p)) ? { status: 'completed', result: { via: conn.toolkit, reconciled: true } } : unknown;
}

/**
 * For an effect whose outcome is unknown: look for evidence that it happened.
 * Returns completed when found and uncertain otherwise. It never returns
 * failed: absence of evidence is not evidence that nothing was sent.
 */
export async function reconcile(e: EffectRow): Promise<Outcome> {
  if (e.kind === 'mail.modify') return reconcileFiling(e);
  if (e.kind === 'calendar.create') return reconcileEvent(e);
  if (e.kind === 'chat.reply') return reconcileChatReply(e);
  const unknown: Outcome = { status: 'uncertain', error: e.error ?? 'unknown' };
  if (e.kind !== 'email.send' && e.kind !== 'email.reply') return unknown;
  const p = e.payload as unknown as MailPayload;
  const started = e.executing_at ? new Date(e.executing_at) : new Date(e.created_at);
  const conn = await connectionById(e.workspace_id, p.connectionId);
  const box = conn && mailboxFor(conn.toolkit);
  if (!conn || !box) return unknown;
  let found;
  try {
    found = await box.findSent(e, conn, p, started);
  } catch (err) {
    return { status: 'uncertain', error: (err as Error).message };
  }
  if (found) return { status: 'completed', result: { via: conn.toolkit, id: found.id, threadId: found.threadKey, reconciled: true }, externalId: found.id };
  // Not finding it proves nothing: Sent can lag, and the copy can differ. It stays unconfirmed for a person to check;
  // calling it "not sent" would invite sending it a second time.
  return unknown;
}
