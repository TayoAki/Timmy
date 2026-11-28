/**
 * "Pay online" links on invoices, made on the business's own Stripe account.
 *
 * A link is an outside write (it is made on the business's Stripe account), so it goes through the Action gateway
 * like a send: the person's press is the approval, the effect is recorded and audited, and this waits for Stripe's
 * answer so the screen can show the link. The executor gets exactly what was approved: the invoice's number, total
 * and currency at that moment. A link is made for one payment and that one total; an invoice whose total changes gets
 * a new one, and the old one is switched off.
 *
 * Switching a link off (paid another way, or voided) is proposed by the same person's command, so a client can't pay
 * twice. A paid link is switched off by Stripe itself.
 */
import { withWorkspace, type Tx } from '../db/pool';
import { executeEffect, propose, type EffectRow, type Outcome, type Proposed } from '../gateway/gateway';
import { log } from '../lib/log';
import { loadState, type Loaded } from '../state/docs';
import { actorOf, reduce, type Ctx } from '../state/engine';
import { mutate } from '../state/mutate';
import type { State } from '../../../src/state/store';
import type { Invoice } from '../../../src/data/ws-types';
import { defaultBilling, money, payUrl, totals } from '../../../src/state/invoices';
import { accountRow, readyAccount } from './accounts';
import { StripeError, stripe } from './stripe';

export interface LinkPayload {
  account: string;
  invoiceId: string;
  number: string;
  /** Whole cents and the ISO code, as the invoice showed them when the link was asked for. */
  amount: number;
  currency: string;
  business: string;
  workspaceId: string;
  /** A link made earlier for another total, to switch off once the new one exists. */
  replaces?: string;
}

export interface UnlinkPayload {
  account: string;
  invoiceId: string;
  link: string;
}

export type LinkResult = { ok: true; url: string; amount: number; currency: string } | { ok: false; status: number; error: string };

const refusedFor = (inv: Invoice | undefined, total: number): string | null => {
  if (!inv) return 'That invoice isn’t in this workspace.';
  if (inv.kind !== 'invoice') return 'A payment link goes on an invoice. Turn the quote into an invoice first.';
  if (inv.status === 'paid') return `${inv.number} is already paid.`;
  if (inv.status === 'void') return `${inv.number} is void.`;
  if (total <= 0) return 'Add an amount above zero first.';
  return null;
};

/**
 * The invoice's "Pay online" link: the one it has, if it is still good for the invoice's total, or a new one made on
 * Stripe through the gateway.
 */
export async function makePayLink(ctx: Ctx, invoiceId: string): Promise<LinkResult> {
  if (!ctx.rules.work) return { ok: false, status: 403, error: 'Your role can’t send invoices in this workspace.' };
  if (!stripe()) return { ok: false, status: 503, error: 'Card payments aren’t set up on this server yet.' };
  const acct = await readyAccount(ctx.workspaceId);
  if (!acct) return { ok: false, status: 409, error: 'Connect Stripe in Invoices › Business details first. Card payments go into your own Stripe account.' };

  type Asked = { kind: 'refused'; error: string } | { kind: 'ready'; url: string; amount: number; currency: string } | { kind: 'proposed'; proposed: Proposed };
  const asked = await withWorkspace({ workspaceId: ctx.workspaceId, lock: true }, async (tx): Promise<Asked> => {
    const loaded = await loadState(tx, ctx.workspaceId);
    const inv = Object.hasOwn(loaded.state.ws.invoices ?? {}, invoiceId) ? loaded.state.ws.invoices[invoiceId] : undefined;
    const total = inv ? totals(inv).total : 0;
    const bad = refusedFor(inv, total);
    if (bad || !inv) return { kind: 'refused', error: bad ?? 'That invoice isn’t in this workspace.' };
    const good = payUrl(inv);
    if (good) return { kind: 'ready', url: good, amount: total, currency: inv.currency };
    const settings = loaded.state.ws.billing?.settings ?? defaultBilling(loaded.workspace.name, loaded.workspace.owner_email ?? undefined);
    const p: LinkPayload = {
      account: acct.account_id,
      invoiceId,
      number: inv.number,
      amount: total,
      currency: inv.currency,
      business: (settings.business || loaded.workspace.name).trim(),
      workspaceId: ctx.workspaceId,
      ...(inv.pay && inv.pay.link !== '' && !inv.pay.paid && inv.pay.active ? { replaces: inv.pay.link } : {}),
    };
    // One effect per invoice, total and attempt: pressing twice waits for the first; a failed one can be tried again.
    const base = `paylink:${invoiceId}:${inv.currency}:${total}:${inv.pay?.link ?? 'new'}`;
    const tried = (await tx.query(`select idempotency_key, status from effect where workspace_id = $1 and kind = 'invoice.link' and (idempotency_key = $2 or idempotency_key like $3) order by created_at desc`, [ctx.workspaceId, base, `${base}:%`])).rows as { idempotency_key: string; status: string }[];
    const last = tried[0];
    const key = !last ? base : ['failed', 'cancelled', 'declined'].includes(last.status) ? `${base}:${tried.length}` : last.idempotency_key;
    const proposed = await propose(tx, loaded, loaded.state, actorOf(ctx), {
      kind: 'invoice.link',
      payload: p as unknown as Record<string, unknown>,
      preview: { lines: [`A “Pay online” link for ${inv.number}, ${money(total, inv.currency)}, on your Stripe account. Your client pays on Stripe’s page; the money goes to your account.`] },
      title: `Payment link for ${inv.number}`,
      why: 'You asked for a payment link.',
      target: `invoice:${invoiceId}`,
      idempotencyKey: key,
      source: 'user',
    });
    return { kind: 'proposed', proposed };
  });
  if (asked.kind === 'refused') return { ok: false, status: asked.error.includes('isn’t in this') ? 404 : 400, error: asked.error };
  if (asked.kind === 'ready') return { ok: true, url: asked.url, amount: asked.amount, currency: asked.currency };
  const { proposed } = asked;
  if (proposed.outcome === 'blocked' || !proposed.effect) return { ok: false, status: 403, error: proposed.reason ?? 'That was refused.' };
  if (proposed.outcome !== 'approved') return { ok: false, status: 403, error: 'Your role can’t send invoices in this workspace.' };
  const done = await finished(ctx.workspaceId, proposed.effect);
  if (done.status === 'completed') {
    const r = done.result as { url?: string; amount?: number; currency?: string } | null;
    if (r?.url) return { ok: true, url: r.url, amount: r.amount ?? 0, currency: r.currency ?? '' };
  }
  if (done.status === 'failed') return { ok: false, status: 400, error: done.error ?? 'Stripe refused the payment link.' };
  return { ok: false, status: 504, error: 'Stripe didn’t answer in time. Try again in a moment.' };
}

/** Runs the approved effect and waits for its outcome; the job queue may run it first, then this waits for that. */
async function finished(workspaceId: string, effect: EffectRow): Promise<EffectRow> {
  const ran = effect.status === 'approved' ? await executeEffect(workspaceId, effect.id) : null;
  if (ran && ran.status !== 'executing') return ran;
  const until = Date.now() + 45_000;
  for (;;) {
    const row = await withWorkspace({ workspaceId }, async (tx) => (await tx.query('select * from effect where id = $1 and workspace_id = $2', [effect.id, workspaceId])).rows[0] as EffectRow | undefined);
    if (!row || !['approved', 'executing'].includes(row.status) || Date.now() > until) return row ?? effect;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/* ───────────── The executors ───────────── */

/** Makes the link on Stripe, as approved. The effect's id is the idempotency key, so a retry makes one link. */
export async function createLink(e: EffectRow): Promise<Outcome> {
  const s = stripe();
  if (!s) return { status: 'failed', error: 'Card payments aren’t set up on this server any more.' };
  const p = e.payload as unknown as LinkPayload;
  try {
    const made = await s.createPaymentLink(
      p.account,
      {
        name: `Invoice ${p.number}`,
        amount: p.amount,
        currency: p.currency.toLowerCase(),
        description: `Invoice ${p.number} from ${p.business}`.slice(0, 1000),
        thanks: `Thank you. ${p.business} has your payment for invoice ${p.number}.`.slice(0, 500),
        closed: `Invoice ${p.number} is paid or no longer open. Write to ${p.business} if you have a question.`.slice(0, 500),
        metadata: { timmy_workspace: p.workspaceId, timmy_invoice: p.invoiceId, timmy_number: p.number.slice(0, 40) },
      },
      `timmy-${e.id}`,
    );
    if (p.replaces && p.replaces !== made.id) {
      // The link for the old total can't be paid any more. If switching it off fails, the new one still stands.
      await s.setLinkActive(p.account, p.replaces, false).catch((err) => log.warn('could not switch off an old payment link', { error: (err as Error).message }));
    }
    return { status: 'completed', result: { link: made.id, url: made.url, amount: p.amount, currency: p.currency }, externalId: made.id };
  } catch (err) {
    // Nothing reached anyone: a link nobody has been given is no harm, and the person can press again.
    return { status: 'failed', error: err instanceof StripeError ? err.message : 'Stripe couldn’t be reached just now. Try again in a moment.' };
  }
}

export async function switchOffLink(e: EffectRow): Promise<Outcome> {
  const s = stripe();
  if (!s) return { status: 'failed', error: 'Card payments aren’t set up on this server any more.' };
  const p = e.payload as unknown as UnlinkPayload;
  try {
    await s.setLinkActive(p.account, p.link, false);
    return { status: 'completed', result: { link: p.link, active: false } };
  } catch (err) {
    return { status: 'failed', error: err instanceof StripeError ? err.message : 'Stripe couldn’t be reached just now.' };
  }
}

/** What the screens show once a link has been made or switched off (gateway/screens.ts). */
export function afterLinkEffect(state: State, e: EffectRow, outcome: Outcome): State {
  const id = (e.payload as { invoiceId?: string }).invoiceId;
  const inv = id ? state.ws.invoices?.[id] : undefined;
  if (!inv) return state;
  const put = (next: Invoice, act?: string): State => ({
    ...state,
    ws: { ...state.ws, invoices: { ...state.ws.invoices, [inv.id]: next } },
    ...(act ? { activity: [{ id: `act-${e.id}`, at: new Date(), kind: 'file' as const, text: act }, ...state.activity] } : {}),
  });
  if (e.kind === 'invoice.link') {
    if (outcome.status !== 'completed' || inv.status === 'paid' || inv.status === 'void' || inv.pay?.paid) return state;
    const r = outcome.result as { link: string; url: string; amount: number; currency: string };
    return put({ ...inv, pay: { link: r.link, url: r.url, amount: r.amount, currency: r.currency, active: true, at: new Date() } }, `Made a payment link for ${inv.number} (${money(r.amount, r.currency)}) on your Stripe account`);
  }
  // invoice.unlink
  const link = (e.payload as unknown as UnlinkPayload).link;
  if (inv.pay?.link !== link) return state;
  if (outcome.status === 'completed') return put({ ...inv, pay: { ...inv.pay, active: false } });
  return put(inv, `Timmy couldn’t switch off the payment link for ${inv.number}: ${outcome.status === 'failed' ? outcome.error : 'Stripe didn’t confirm it'}. Switch it off in your Stripe Dashboard so it can’t be paid twice.`);
}

/**
 * After a person's command marks an invoice paid by hand or voids it: its live payment link is switched off, through
 * the gateway, approved by that same command. Returns the state with the effect recorded, or the state as it was.
 */
export async function unlinkAfter(tx: Tx, loaded: Loaded, ctx: Ctx, prev: State, next: State, invoiceId: string): Promise<{ state: State; effect?: EffectRow }> {
  const before = prev.ws.invoices?.[invoiceId];
  const after = next.ws.invoices?.[invoiceId];
  if (!before?.pay?.active || before.pay.sample || !after || (after.status !== 'paid' && after.status !== 'void') || before.status === after.status) return { state: next };
  const acct = (await tx.query('select account_id from payment_account where workspace_id = $1', [ctx.workspaceId])).rows[0] as { account_id: string } | undefined;
  if (!acct) return { state: next };
  const p: UnlinkPayload = { account: acct.account_id, invoiceId, link: before.pay.link };
  const proposed = await propose(tx, loaded, next, actorOf(ctx), {
    kind: 'invoice.unlink',
    payload: p as unknown as Record<string, unknown>,
    preview: { lines: [`Switch off the payment link for ${after.number}, so it can’t be paid twice.`] },
    title: `Switch off the payment link for ${after.number}`,
    why: after.status === 'paid' ? 'You marked it paid.' : 'You voided it.',
    target: `invoice:${invoiceId}`,
    idempotencyKey: `payunlink:${invoiceId}:${before.pay.link}`,
    source: 'user',
  });
  return { state: proposed.state, ...(proposed.effect ? { effect: proposed.effect } : {}) };
}

/**
 * Asks Stripe directly whether an invoice's link has been paid: for when an event didn't arrive (or hasn't yet).
 * What it finds is recorded the same way an event's news is.
 */
export async function checkPayment(ctx: Ctx, invoiceId: string): Promise<{ ok: true; paid: boolean; clearing: boolean } | { ok: false; status: number; error: string }> {
  if (!ctx.rules.read) return { ok: false, status: 403, error: 'Your role can’t see invoices in this workspace.' };
  const s = stripe();
  if (!s) return { ok: false, status: 503, error: 'Card payments aren’t set up on this server yet.' };
  const acct = await accountRow(ctx.workspaceId);
  const loaded = await withWorkspace({ workspaceId: ctx.workspaceId }, (tx) => loadState(tx, ctx.workspaceId));
  const inv = Object.hasOwn(loaded.state.ws.invoices ?? {}, invoiceId) ? loaded.state.ws.invoices[invoiceId] : undefined;
  if (!inv) return { ok: false, status: 404, error: 'That invoice isn’t in this workspace.' };
  if (!inv.pay || inv.pay.sample || !acct) return { ok: false, status: 400, error: 'That invoice has no payment link.' };
  if (inv.pay.paid) return { ok: true, paid: true, clearing: false };
  let found;
  try {
    found = await s.paidSessions(acct.account_id, inv.pay.link);
  } catch (e) {
    if (e instanceof StripeError) return { ok: false, status: e.status, error: e.message };
    throw e;
  }
  const paid = found.find((x) => x.paid);
  const clearing = !paid ? found.find((x) => !x.paid) : undefined;
  if (paid) await recordPayment(ctx.workspaceId, invoiceId, inv.pay.link, { event: 'paid', at: paid.at, amount: paid.amount, currency: paid.currency, ref: paid.paymentIntent ?? paid.id });
  else if (clearing) await recordPayment(ctx.workspaceId, invoiceId, inv.pay.link, { event: 'clearing', at: clearing.at, amount: clearing.amount, currency: clearing.currency, ref: clearing.paymentIntent ?? clearing.id });
  return { ok: true, paid: !!paid, clearing: !!clearing };
}

/**
 * Records what Stripe said about a payment, on the invoice whose link it was. Only the link the invoice carries
 * counts: a payment through a link the invoice no longer shows, or for another invoice, changes nothing here.
 */
export async function recordPayment(workspaceId: string, invoiceId: string, link: string, said: { event: 'paid' | 'clearing' | 'failed'; at: Date; amount: number; currency: string; ref: string }): Promise<boolean> {
  return mutate(workspaceId, 'stripe', async (_tx, loaded) => {
    const inv = Object.hasOwn(loaded.state.ws.invoices ?? {}, invoiceId) ? loaded.state.ws.invoices[invoiceId] : undefined;
    if (!inv || inv.kind !== 'invoice' || !inv.pay || inv.pay.link !== link) return { result: false };
    const next = reduce(loaded, loaded.state, { type: 'invoicePayment', id: invoiceId, event: said.event, at: said.at, amount: said.amount, currency: said.currency.toUpperCase(), ref: said.ref });
    return { state: next ?? loaded.state, result: !!next && next !== loaded.state };
  });
}
