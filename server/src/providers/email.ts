/**
 * Timmy's own account mail: sign-in links, address confirmations, invitations
 * and password resets. This is not the user's mailbox and never carries their mail.
 *
 * Every message is written to `email_outbox` first, so there is a record of it
 * whatever happens next. When a mail provider is configured (Resend), a job
 * then delivers it and stamps the row; a failed delivery is retried. With the
 * stand-in providers on (tests, staging) nothing is delivered and the outbox is
 * the mailbox the tests read.
 */
import { config } from '../config';
import { sysPool } from '../db/pool';
import { enqueueSoon } from '../jobs/jobs';
import { log } from '../lib/log';

export interface OutgoingMail {
  to: string;
  subject: string;
  body: string;
  kind: 'magic-link' | 'invite' | 'reset' | 'verify' | 'feedback';
}

/** Whether Timmy can deliver its own mail: a key for the provider, and an address on a domain it may send from. */
export const mailReady = () => config.mail.deliver && !!config.mail.resendApiKey && !!config.mail.from;

/** A link that signs someone in is useless after a few minutes; delivery is not attempted for longer than this. */
const GIVE_UP_AFTER_MINUTES = 30;

export async function sendMail(mail: OutgoingMail): Promise<void> {
  const { rows } = await sysPool.query('insert into email_outbox (to_address, subject, body, kind) values ($1, $2, $3, $4) returning id', [mail.to.toLowerCase(), mail.subject, mail.body, mail.kind]);
  if (mailReady()) enqueueSoon('email.deliver', { id: Number(rows[0].id) }, { singletonKey: `mail:${rows[0].id}` });
}

/**
 * Hands one outbox message to the provider. Safe to call again for the same
 * message: one that was already delivered is left alone, and the provider is
 * given the same key each time so a retry after a lost answer is not a second email.
 * Throws when the provider did not take it, so the job is retried.
 */
export async function deliverMail(id: number): Promise<'sent' | 'already' | 'expired' | 'off'> {
  if (!mailReady()) return 'off';
  const { rows } = await sysPool.query(`select id, to_address, subject, body, sent_at, created_at < now() - make_interval(mins => $2::int) as stale from email_outbox where id = $1`, [id, GIVE_UP_AFTER_MINUTES]);
  const m = rows[0] as { id: string; to_address: string; subject: string; body: string; sent_at: Date | null; stale: boolean } | undefined;
  if (!m || m.sent_at) return 'already';
  if (m.stale) {
    await sysPool.query(`update email_outbox set error = coalesce(error, 'not delivered in time') where id = $1`, [id]);
    return 'expired';
  }
  let status = 0;
  let answer: { id?: string; message?: string; name?: string } = {};
  try {
    const res = await fetch(`${config.mail.resendBaseUrl}/emails`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.mail.resendApiKey}`, 'idempotency-key': `timmy-outbox-${m.id}` },
      body: JSON.stringify({ from: config.mail.from, to: [m.to_address], subject: m.subject, text: m.body }),
      signal: AbortSignal.timeout(20_000),
    });
    status = res.status;
    answer = (await res.json().catch(() => ({}))) as typeof answer;
  } catch (e) {
    answer = { message: (e as Error).message };
  }
  if (status >= 200 && status < 300 && answer.id) {
    await sysPool.query('update email_outbox set sent_at = now(), provider_id = $2, attempts = attempts + 1, error = null where id = $1', [id, answer.id]);
    return 'sent';
  }
  const error = `${status || 'no answer'}: ${answer.message ?? answer.name ?? 'the mail provider did not accept the message'}`.slice(0, 300);
  await sysPool.query('update email_outbox set attempts = attempts + 1, error = $2 where id = $1', [id, error]);
  // Who the message was for is not logged; the row has it.
  log.warn('account mail was not delivered', { outboxId: id, error });
  throw new Error(`mail not delivered: ${error}`);
}

/** Messages that should have been delivered and were not (a lost job, a provider outage that has since passed). */
export async function undeliveredMail(): Promise<number[]> {
  if (!mailReady()) return [];
  const { rows } = await sysPool.query(`select id from email_outbox where sent_at is null and attempts < 6 and created_at > now() - make_interval(mins => $1::int) and created_at < now() - interval '30 seconds' order by id limit 50`, [GIVE_UP_AFTER_MINUTES]);
  return rows.map((r) => Number(r.id));
}

/** Test hook: the newest message to an address. */
export async function lastMailTo(to: string): Promise<{ subject: string; body: string; kind: string } | null> {
  const { rows } = await sysPool.query('select subject, body, kind from email_outbox where to_address = $1 order by id desc limit 1', [to.toLowerCase()]);
  return rows[0] ?? null;
}
