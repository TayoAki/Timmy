/**
 * A stand-in for Stripe Connect, for tests and the stand-in providers (TIMMY_FAKE_PROVIDERS). It behaves the way the
 * real one does where Timmy depends on it:
 *   - an account can't take card payments until the business has been through onboarding (here, the stand-in
 *     onboarding page, or `completeOnboarding`);
 *   - a payment link is for one payment: once paid, or switched off, it can't be paid again;
 *   - the same idempotency key makes the same account or link once;
 *   - amounts under 50 cents, or over $9,999.99, are refused, as Stripe refuses them by default;
 *   - a payment is announced by a signed event, `checkout.session.completed`, sent as Stripe would send it.
 * Nothing here leaves the machine.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { config } from '../config';
import type { LinkRequest, PaidSession, PaymentLink, StripeAccount, StripeEngine } from '../payments/stripe';
import { StripeError, stripeRefusal } from '../payments/stripe-errors';

interface FakeAccount {
  id: string;
  name: string;
  email?: string;
  country: string;
  status: 'restricted' | 'pending' | 'active';
}

interface FakeLink extends LinkRequest {
  id: string;
  url: string;
  account: string;
  active: boolean;
}

interface FakeSession {
  id: string;
  link: string;
  account: string;
  amount: number;
  currency: string;
  paid: boolean;
  created: number;
  paymentIntent: string;
  metadata: Record<string, string>;
}

/** Countries the stand-in opens accounts in (Stripe's list is longer). */
const COUNTRIES = new Set(['US', 'CA', 'GB', 'IE', 'AU', 'NZ', 'DE', 'FR', 'ES', 'IT', 'NL']);

export class FakeStripe implements StripeEngine {
  readonly livemode = false;
  readonly secret = `whsec_fake_${randomBytes(12).toString('hex')}`;
  accounts = new Map<string, FakeAccount>();
  links = new Map<string, FakeLink>();
  sessions = new Map<string, FakeSession>();
  /** Every call, for tests to see what was asked (never a key: the stand-in has none). */
  calls: { op: string; account?: string; idempotencyKey?: string; body?: unknown }[] = [];
  private byKey = new Map<string, string>();
  private n = 0;
  /** Set to make the next call fail as Stripe would, with this status and code. */
  failNext: { status: number; code: string } | null = null;

  /** Stripe's ids are unique everywhere: each stand-in's carry a tag of their own, so two never make the same one. */
  private tag = randomBytes(3).toString('hex');
  private next(prefix: string) {
    this.n += 1;
    return `${prefix}_fake${this.tag}${String(this.n).padStart(4, '0')}`;
  }
  private refuse(op: string) {
    if (!this.failNext) return;
    const f = this.failNext;
    this.failNext = null;
    this.calls.push({ op: `${op}:refused` });
    // The same words the real client would give: built from Stripe's status and code.
    throw refusal(f.status, f.code);
  }

  async createAccount(input: { name: string; email?: string; country: string }, idempotencyKey: string): Promise<{ id: string }> {
    this.calls.push({ op: 'createAccount', idempotencyKey, body: input });
    this.refuse('createAccount');
    const had = this.byKey.get(`acct:${idempotencyKey}`);
    if (had) return { id: had };
    if (!COUNTRIES.has(input.country.toUpperCase())) throw new StripeError(400, 'Stripe can’t open an account for a business in that country through Timmy.', 'account_country_invalid_address');
    const id = this.next('acct');
    this.accounts.set(id, { id, name: input.name, ...(input.email ? { email: input.email } : {}), country: input.country.toUpperCase(), status: 'restricted' });
    this.byKey.set(`acct:${idempotencyKey}`, id);
    return { id };
  }

  async onboardingLink(account: string, returnUrl: string, refreshUrl: string): Promise<{ url: string }> {
    this.calls.push({ op: 'onboardingLink', account, body: { returnUrl, refreshUrl } });
    this.refuse('onboardingLink');
    if (!this.accounts.has(account)) throw new StripeError(409, 'That Stripe account is no longer connected to Timmy. Connect Stripe again in Business details.', 'resource_missing');
    // Stands in for Stripe's onboarding form: the test hook marks the account done and goes back to the return address.
    return { url: `${config.publicUrl}/api/test/fake-stripe-onboard?account=${encodeURIComponent(account)}&to=${encodeURIComponent(returnUrl)}` };
  }

  completeOnboarding(account: string, status: FakeAccount['status'] = 'active') {
    const a = this.accounts.get(account);
    if (a) a.status = status;
  }

  async account(account: string): Promise<StripeAccount> {
    this.calls.push({ op: 'account', account });
    this.refuse('account');
    const a = this.accounts.get(account);
    if (!a) throw new StripeError(409, 'That Stripe account is no longer connected to Timmy. Connect Stripe again in Business details.', 'resource_missing');
    return { id: a.id, ready: a.status === 'active', submitted: a.status === 'pending', name: a.name, ...(a.email ? { email: a.email } : {}), country: a.country };
  }

  async createPaymentLink(account: string, req: LinkRequest, idempotencyKey: string): Promise<PaymentLink> {
    this.calls.push({ op: 'createPaymentLink', account, idempotencyKey, body: req });
    this.refuse('createPaymentLink');
    const had = this.byKey.get(`link:${idempotencyKey}`);
    if (had) {
      const l = this.links.get(had)!;
      return { id: l.id, url: l.url };
    }
    const a = this.accounts.get(account);
    if (!a) throw new StripeError(409, 'That Stripe account is no longer connected to Timmy. Connect Stripe again in Business details.', 'resource_missing');
    if (a.status !== 'active') throw new StripeError(400, 'Stripe refused that. The people who run Timmy can see why in the server’s log.', 'account_not_ready');
    if (!Number.isInteger(req.amount) || req.amount < 50) throw new StripeError(400, 'Stripe can’t take a card payment that small.', 'amount_too_small');
    if (req.amount > 999_999) throw new StripeError(400, 'That is more than Stripe takes in one card payment for this account. Ask Stripe to raise the limit, or add your bank details for this one.', 'amount_too_large');
    const id = this.next('plink');
    const link: FakeLink = { ...req, id, url: `https://pay.stripe-standin.example/${id}`, account, active: true };
    this.links.set(id, link);
    this.byKey.set(`link:${idempotencyKey}`, id);
    return { id, url: link.url };
  }

  async setLinkActive(account: string, link: string, active: boolean): Promise<void> {
    this.calls.push({ op: 'setLinkActive', account, body: { link, active } });
    this.refuse('setLinkActive');
    const l = this.links.get(link);
    if (!l || l.account !== account) throw new StripeError(409, 'That Stripe account is no longer connected to Timmy. Connect Stripe again in Business details.', 'resource_missing');
    // A link that has been paid stays off: Stripe won't take a second payment through it.
    l.active = active && ![...this.sessions.values()].some((x) => x.link === link);
  }

  async paidSessions(account: string, link: string): Promise<PaidSession[]> {
    this.calls.push({ op: 'paidSessions', account, body: { link } });
    this.refuse('paidSessions');
    return [...this.sessions.values()]
      .filter((x) => x.link === link && x.account === account)
      .sort((a, b) => b.created - a.created)
      .map((x) => ({ id: x.id, amount: x.amount, currency: x.currency.toUpperCase(), paid: x.paid, at: new Date(x.created * 1000), paymentIntent: x.paymentIntent }));
  }

  /* ───────────── What the client does on Stripe's page ───────────── */

  /**
   * The client pays through a link. `bank` is a payment that takes days to clear: the checkout finishes unpaid and
   * a second event says when it has. Returns the event Stripe would send, signed.
   */
  pay(link: string, opts: { bank?: boolean; amount?: number } = {}) {
    const l = this.links.get(link);
    if (!l || !l.active) throw new Error('This link is no longer active.');
    const id = this.next('cs');
    const s: FakeSession = { id, link, account: l.account, amount: opts.amount ?? l.amount, currency: l.currency, paid: !opts.bank, created: Math.floor(Date.now() / 1000), paymentIntent: this.next('pi'), metadata: { ...l.metadata } };
    this.sessions.set(id, s);
    // One payment per link: Stripe switches it off once a checkout through it is complete.
    l.active = false;
    return { session: id, webhook: this.event('checkout.session.completed', l.account, this.sessionObject(s)) };
  }

  /** A bank payment clears (or fails). */
  clear(session: string, ok = true) {
    const s = this.sessions.get(session);
    if (!s) throw new Error('no such checkout');
    s.paid = ok;
    return this.event(ok ? 'checkout.session.async_payment_succeeded' : 'checkout.session.async_payment_failed', s.account, this.sessionObject(s));
  }

  sessionObject(s: FakeSession) {
    return { id: s.id, object: 'checkout.session', amount_total: s.amount, currency: s.currency, payment_status: s.paid ? 'paid' : 'unpaid', status: 'complete', created: s.created, payment_intent: s.paymentIntent, payment_link: s.link, metadata: s.metadata, mode: 'payment' };
  }

  /** Any event about a connected account, signed as Stripe signs them. */
  event(type: string, account: string, object: Record<string, unknown>, opts: { livemode?: boolean; t?: number; id?: string } = {}) {
    const body = JSON.stringify({ id: opts.id ?? this.next('evt'), object: 'event', type, account, livemode: opts.livemode ?? false, created: Math.floor(Date.now() / 1000), data: { object } });
    const t = opts.t ?? Math.floor(Date.now() / 1000);
    return { headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${createHmac('sha256', this.secret).update(`${t}.${body}`).digest('hex')}` }, body };
  }
}

/** The stand-in's refusals: the same words the real client gives for Stripe's status and code. */
function refusal(status: number, code: string) {
  return stripeRefusal(status, { error: { code, type: 'invalid_request_error', message: `stand-in: ${code}` } });
}
