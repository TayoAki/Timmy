import { sysPool } from '../db/pool';

export interface OutgoingMail {
  to: string;
  subject: string;
  body: string;
  kind: 'magic-link' | 'invite' | 'reset';
}

/**
 * Timmy's own account mail: sign-in links, invitations and password resets.
 * This is not the user's mailbox and never carries their mail.
 *
 * No delivery provider is chosen yet, so messages wait in `email_outbox`.
 * When one is configured it sends from here and stamps `sent_at`.
 */
export async function sendMail(mail: OutgoingMail): Promise<void> {
  await sysPool.query('insert into email_outbox (to_address, subject, body, kind) values ($1, $2, $3, $4)', [mail.to.toLowerCase(), mail.subject, mail.body, mail.kind]);
}

/** Test hook: the newest message to an address. */
export async function lastMailTo(to: string): Promise<{ subject: string; body: string; kind: string } | null> {
  const { rows } = await sysPool.query('select subject, body, kind from email_outbox where to_address = $1 order by id desc limit 1', [to.toLowerCase()]);
  return rows[0] ?? null;
}
