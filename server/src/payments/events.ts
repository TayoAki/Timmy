/**
 * Stripe's events about connected accounts, at POST /api/hooks/stripe (one endpoint, "Events from: Connected
 * accounts", in Stripe's Workbench). Each is checked before anything is read from it:
 *   - its signature, against STRIPE_WEBHOOK_SECRET, and its time (five minutes either way);
 *   - its mode: a test event is ignored by a live server, and a live one by a test server;
 *   - the connected account it is about, which says whose it is. An account no workspace has is acknowledged and dropped;
 *   - an event already seen is acknowledged and not applied again (Stripe sends each at least once).
 * Then, for a payment, the invoice it names must be that workspace's, and the link it was paid through must be the
 * link the invoice carries. Only then is it recorded.
 */
import { sysPool } from '../db/pool';
import { log } from '../lib/log';
import { refreshAccount } from './accounts';
import { recordPayment } from './links';
import { sessionOf, stripe, verifyStripeSignature, webhookSecret } from './stripe';

export interface Handled {
  status: number;
  body: Record<string, unknown>;
}

interface StripeEvent {
  id: string;
  type: string;
  account?: string;
  livemode?: boolean;
  created?: number;
  data?: { object?: Record<string, unknown> };
}

const PAYMENT_EVENTS: Record<string, 'paid' | 'clearing' | 'failed' | 'completed'> = {
  'checkout.session.completed': 'completed',
  'checkout.session.async_payment_succeeded': 'paid',
  'checkout.session.async_payment_failed': 'failed',
};

export async function stripeEvent(raw: string, signature: string | null | undefined): Promise<Handled> {
  const s = stripe();
  const secret = webhookSecret();
  if (!s || !secret) return { status: 404, body: { error: 'Not found' } };
  try {
    verifyStripeSignature(raw, signature, secret);
  } catch (e) {
    log.warn('rejected stripe event', { error: (e as Error).message });
    return { status: 400, body: { error: 'bad signature' } };
  }
  let ev: StripeEvent;
  try {
    ev = JSON.parse(raw) as StripeEvent;
  } catch {
    return { status: 400, body: { error: 'not json' } };
  }
  if (typeof ev.id !== 'string' || typeof ev.type !== 'string') return { status: 400, body: { error: 'not an event' } };
  // A Connect endpoint on a live platform is sent test events too: they are not this server's.
  if (!!ev.livemode !== s.livemode) return { status: 200, body: { ok: true, ignored: 'other mode' } };
  const account = typeof ev.account === 'string' ? ev.account : null;
  const row = account ? ((await sysPool.query('select workspace_id from payment_account where account_id = $1', [account])).rows[0] as { workspace_id: string } | undefined) : undefined;
  const fresh = await sysPool.query(
    `insert into webhook_event (id, source, connected_account_id, workspace_id, payload) values ($1, 'stripe', $2, $3, $4::jsonb) on conflict (id) do nothing returning id`,
    [`stripe:${ev.id}`, account, row?.workspace_id ?? null, raw.replace(/\\u0000/g, '')],
  );
  if (!fresh.rows[0]) return { status: 200, body: { ok: true, duplicate: true } };
  if (!row) return { status: 200, body: { ok: true, ignored: 'unknown account' } };
  const workspaceId = row.workspace_id;
  let applied = false;
  try {
    if (ev.type === 'account.updated') {
      await refreshAccount(workspaceId);
      applied = true;
    } else if (PAYMENT_EVENTS[ev.type]) {
      applied = await paymentEvent(workspaceId, ev, PAYMENT_EVENTS[ev.type]!);
    }
    await sysPool.query('update webhook_event set processed_at = now() where id = $1', [`stripe:${ev.id}`]);
  } catch (e) {
    // Stripe sends it again later; the record is dropped so that attempt is applied rather than skipped as a repeat.
    log.error('could not apply a stripe event', { type: ev.type, error: (e as Error).message });
    await sysPool.query('delete from webhook_event where id = $1', [`stripe:${ev.id}`]).catch(() => undefined);
    return { status: 500, body: { error: 'not applied' } };
  }
  return { status: 200, body: { ok: true, applied } };
}

async function paymentEvent(workspaceId: string, ev: StripeEvent, what: 'paid' | 'clearing' | 'failed' | 'completed'): Promise<boolean> {
  const obj = ev.data?.object ?? {};
  const meta = (obj.metadata ?? {}) as Record<string, unknown>;
  const invoiceId = typeof meta.timmy_invoice === 'string' ? meta.timmy_invoice : null;
  const link = typeof obj.payment_link === 'string' ? obj.payment_link : null;
  // A checkout that isn't one of Timmy's links (the business's own, made in their Dashboard) is theirs alone.
  if (!invoiceId || !link || meta.timmy_workspace !== workspaceId) return false;
  const session = sessionOf(obj);
  if (!session) return false;
  const event = what === 'completed' ? (session.paid ? 'paid' : 'clearing') : what;
  // A bank payment is paid when it clears, which is when this event was made, not when the client started it.
  const at = what === 'paid' && typeof ev.created === 'number' ? new Date(ev.created * 1000) : session.at;
  return recordPayment(workspaceId, invoiceId, link, { event, at, amount: session.amount, currency: session.currency, ref: session.paymentIntent ?? session.id });
}
