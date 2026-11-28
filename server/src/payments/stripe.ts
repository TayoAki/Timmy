/**
 * Stripe Connect: card payments for invoices, paid into each business's own Stripe account.
 *
 * Timmy is the platform (its key is `STRIPE_SECRET_KEY`, on the server only). Following Stripe's guide for software
 * platforms (docs.stripe.com/connect/interactive-platform-guide, Accounts v2):
 *   - each business gets its own Stripe account, created by Timmy with the Merchant configuration, the full Stripe
 *     Dashboard, and Stripe as the one that charges its fees and covers losses (`fees_collector` and
 *     `losses_collector` are `stripe`). The business fills in its details on Stripe's own onboarding page;
 *   - a payment for an invoice is a direct charge on that account (the `Stripe-Account` header), through a Payment
 *     Link: Stripe's own page, which takes the card, so payment details never reach Timmy. A link is good for one
 *     payment (`restrictions.completed_sessions.limit = 1`) and is switched off when the invoice is paid another way
 *     or voided;
 *   - Stripe says when one is paid through a signed event to one webhook endpoint, set to "Connected accounts";
 *   - no application fee is taken: what the client pays, less Stripe's own fee, is the business's.
 *
 * Every call carries the pinned `Stripe-Version` and, where it writes, an `Idempotency-Key`, so a retried request
 * makes one account or one link. Off until both `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are set. Tests and the
 * stand-in providers use a fake (testing/stripe.ts).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { log } from '../lib/log';
import { FakeStripe } from '../testing/stripe';
import { StripeError, stripeRefusal } from './stripe-errors';

export { StripeError, stripeRefusal };

export interface StripeAccount {
  id: string;
  /** Card payments are switched on: links can be made for it. */
  ready: boolean;
  /** The business has been through Stripe's form but Stripe still wants something. */
  submitted: boolean;
  name?: string;
  email?: string;
  country?: string;
}

export interface PaymentLink {
  id: string;
  url: string;
}

export interface PaidSession {
  id: string;
  /** Whole cents (the currency's smallest unit). */
  amount: number;
  currency: string;
  /** paid, or unpaid while a bank payment clears. */
  paid: boolean;
  at: Date;
  paymentIntent?: string;
}

export interface LinkRequest {
  /** What the client sees on Stripe's page: "Invoice INV-0003". */
  name: string;
  /** Whole cents. */
  amount: number;
  /** Lower case, as Stripe wants it: "usd". */
  currency: string;
  /** Shown on the client's card statement and in the business's Dashboard. */
  description: string;
  /** Shown once they have paid. */
  thanks: string;
  /** Shown if they open the link once it is switched off. */
  closed: string;
  metadata: Record<string, string>;
}

export interface StripeEngine {
  /** Whether the key is a live one: events from the other mode are ignored. */
  readonly livemode: boolean;
  createAccount(input: { name: string; email?: string; country: string }, idempotencyKey: string): Promise<{ id: string }>;
  onboardingLink(account: string, returnUrl: string, refreshUrl: string): Promise<{ url: string }>;
  account(account: string): Promise<StripeAccount>;
  createPaymentLink(account: string, req: LinkRequest, idempotencyKey: string): Promise<PaymentLink>;
  setLinkActive(account: string, link: string, active: boolean): Promise<void>;
  /** Finished checkouts through a link, newest first: how a payment is confirmed when an event was missed. */
  paidSessions(account: string, link: string): Promise<PaidSession[]>;
}

/* ───────────── The HTTP client ───────────── */

/** Stripe's v1 form encoding: { a: { b: [ { c: 1 } ] } } → a[b][0][c]=1. */
export function formOf(obj: Record<string, unknown>, prefix = ''): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' && x !== null ? out.push(...formOf(x as Record<string, unknown>, `${key}[${i}]`)) : out.push([`${key}[${i}]`, String(x)])));
    else if (typeof v === 'object') out.push(...formOf(v as Record<string, unknown>, key));
    else out.push([key, String(v)]);
  }
  return out;
}

export class HttpStripe implements StripeEngine {
  readonly livemode: boolean;
  constructor(
    private base: string,
    private key: string,
    private version: string,
    private timeoutMs = 30_000,
  ) {
    this.livemode = /^(sk|rk)_live_/.test(key);
  }

  private async request(method: 'GET' | 'POST', path: string, opts: { form?: Record<string, unknown>; json?: Record<string, unknown>; query?: [string, string][]; account?: string; idempotencyKey?: string } = {}): Promise<Record<string, unknown>> {
    const qs = opts.query?.length ? `?${new URLSearchParams(opts.query).toString()}` : '';
    const headers: Record<string, string> = { authorization: `Bearer ${this.key}`, 'stripe-version': this.version, accept: 'application/json' };
    if (opts.account) headers['stripe-account'] = opts.account;
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    let body: string | undefined;
    if (opts.json) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(formOf(opts.form)).toString();
    }
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}${qs}`, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      log.warn('stripe unreachable', { path: path.replace(/acct_\w+/g, 'acct_…').replace(/plink_\w+/g, 'plink_…'), error: (e as Error).message });
      throw new StripeError(502, 'Stripe couldn’t be reached just now. Try again in a moment.');
    }
    const text = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) throw stripeRefusal(res.status, parsed);
    if (!parsed) throw new StripeError(502, 'Stripe sent back something Timmy couldn’t read.');
    return parsed;
  }

  async createAccount(input: { name: string; email?: string; country: string }, idempotencyKey: string): Promise<{ id: string }> {
    const r = await this.request('POST', '/v2/core/accounts', {
      idempotencyKey,
      json: {
        display_name: input.name.slice(0, 100),
        ...(input.email ? { contact_email: input.email } : {}),
        identity: { country: input.country.toLowerCase() },
        configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
        defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
        dashboard: 'full',
        include: ['configuration.merchant'],
      },
    });
    if (typeof r.id !== 'string' || !r.id.startsWith('acct_')) throw new StripeError(502, 'Stripe sent back something Timmy couldn’t read.');
    return { id: r.id };
  }

  async onboardingLink(account: string, returnUrl: string, refreshUrl: string): Promise<{ url: string }> {
    const r = await this.request('POST', '/v2/core/account_links', {
      json: { account, use_case: { type: 'account_onboarding', account_onboarding: { configurations: ['merchant'], return_url: returnUrl, refresh_url: refreshUrl } } },
    });
    if (typeof r.url !== 'string' || !r.url.startsWith('https://')) throw new StripeError(502, 'Stripe sent back something Timmy couldn’t read.');
    return { url: r.url };
  }

  async account(account: string): Promise<StripeAccount> {
    const r = await this.request('GET', `/v2/core/accounts/${encodeURIComponent(account)}`, { query: [['include[0]', 'configuration.merchant'], ['include[1]', 'identity']] });
    return accountOf(r);
  }

  async createPaymentLink(account: string, req: LinkRequest, idempotencyKey: string): Promise<PaymentLink> {
    const r = await this.request('POST', '/v1/payment_links', {
      account,
      idempotencyKey,
      form: {
        line_items: [{ price_data: { currency: req.currency, unit_amount: req.amount, product_data: { name: req.name } }, quantity: 1 }],
        restrictions: { completed_sessions: { limit: 1 } },
        after_completion: { type: 'hosted_confirmation', hosted_confirmation: { custom_message: req.thanks } },
        inactive_message: req.closed,
        payment_intent_data: { description: req.description, metadata: req.metadata },
        metadata: req.metadata,
      },
    });
    if (typeof r.id !== 'string' || typeof r.url !== 'string' || !r.url.startsWith('https://')) throw new StripeError(502, 'Stripe sent back something Timmy couldn’t read.');
    return { id: r.id, url: r.url };
  }

  async setLinkActive(account: string, link: string, active: boolean): Promise<void> {
    await this.request('POST', `/v1/payment_links/${encodeURIComponent(link)}`, { account, form: { active } });
  }

  async paidSessions(account: string, link: string): Promise<PaidSession[]> {
    const r = await this.request('GET', '/v1/checkout/sessions', { account, query: [['payment_link', link], ['status', 'complete'], ['limit', '10']] });
    return (Array.isArray(r.data) ? r.data : []).map((x) => sessionOf(x as Record<string, unknown>)).filter((x): x is PaidSession => !!x);
  }
}

/** A v2 Account, read for what Timmy needs: whether it can take card payments. */
export function accountOf(r: Record<string, unknown>): StripeAccount {
  const merchant = ((r.configuration as Record<string, unknown> | undefined)?.merchant ?? {}) as { capabilities?: { card_payments?: { status?: string } } };
  const status = merchant.capabilities?.card_payments?.status;
  const identity = (r.identity ?? {}) as { country?: string };
  return {
    id: String(r.id ?? ''),
    ready: status === 'active',
    // Pending: the business has filled in Stripe's form and Stripe is checking it. Restricted or unrequested: Stripe still wants something.
    submitted: status === 'pending',
    ...(typeof r.display_name === 'string' ? { name: r.display_name } : {}),
    ...(typeof r.contact_email === 'string' ? { email: r.contact_email } : {}),
    ...(typeof identity.country === 'string' ? { country: identity.country.toUpperCase() } : {}),
  };
}

/** A Checkout Session, read for what confirms a payment. */
export function sessionOf(x: Record<string, unknown>): PaidSession | null {
  if (typeof x.id !== 'string' || typeof x.amount_total !== 'number' || typeof x.currency !== 'string') return null;
  return {
    id: x.id,
    amount: x.amount_total,
    currency: x.currency.toUpperCase(),
    paid: x.payment_status === 'paid',
    at: new Date((typeof x.created === 'number' ? x.created : Date.now() / 1000) * 1000),
    ...(typeof x.payment_intent === 'string' ? { paymentIntent: x.payment_intent } : {}),
  };
}

/* ───────────── Signed events ───────────── */

/**
 * Checks Stripe's signature on an event (docs.stripe.com/webhooks#verify-events): the header carries a time `t` and
 * one or more `v1` signatures, each an HMAC-SHA256 of "<t>.<the raw body>" with the endpoint's secret. Other entries
 * are ignored, in any order. An event older (or newer) than five minutes is refused, so a recorded one can't be
 * played back later.
 */
export function verifyStripeSignature(raw: string, header: string | null | undefined, secret: string, now = Date.now(), toleranceSeconds = 300): void {
  if (!secret) throw new Error('no webhook secret');
  if (!header) throw new Error('no signature');
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase());
  }
  if (t === null || !v1.length) throw new Error('malformed signature');
  if (Math.abs(now / 1000 - t) > toleranceSeconds) throw new Error('signature too old');
  const want = Buffer.from(createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex'));
  if (!v1.some((s) => s.length === want.length && timingSafeEqual(Buffer.from(s), want))) throw new Error('bad signature');
}

/** The header Stripe would send for `raw`: for the stand-in and the tests. */
export function signStripeEvent(raw: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
}

/* ───────────── Which engine ───────────── */

let engine: StripeEngine | null | undefined;

export function stripe(): StripeEngine | null {
  if (engine === undefined) {
    if (config.fakeProviders) engine = new FakeStripe();
    else if (config.stripe.secretKey && config.stripe.webhookSecret) engine = new HttpStripe(config.stripe.url, config.stripe.secretKey, config.stripe.version);
    else engine = null;
  }
  return engine;
}
export const stripeReady = () => !!stripe();
export function fakeStripe(): FakeStripe | null {
  const e = stripe();
  return e instanceof FakeStripe ? e : null;
}
export function setStripeForTests(e: StripeEngine | null | undefined) {
  engine = e;
}
/** The secret the webhook is signed with: the real endpoint's, or the stand-in's. */
export const webhookSecret = () => config.stripe.webhookSecret || fakeStripe()?.secret || '';
