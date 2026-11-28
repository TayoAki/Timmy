/**
 * Card payments for invoices, through Stripe Connect (server/src/payments/, the reducer's invoicePayment, the gateway's
 * invoice.link and invoice.unlink):
 *   - the real client against a local server: the key as a bearer, the pinned version, the connected account, an
 *     idempotency key, Stripe's nested form fields and v2's JSON; refusals in plain words, never Stripe's own or the key;
 *   - signed events: the signature, its age, and unknown entries in the header;
 *   - connecting: only an owner or admin; one Stripe account per business, made on Stripe and prefilled; Stripe's page;
 *     back, and card payments on only when Stripe says so; the account id never in the workspace's state;
 *   - a link: through the gateway, approved by the person's click and only by one, on the business's account, for the
 *     invoice's total, once; a new total gets a new link and the old one is switched off; quotes, empty and paid
 *     invoices get none; a read-only role can't make one;
 *   - a screen can't set, change or drop a link, or say an invoice was paid online;
 *   - paid through it: Stripe's signed event marks it paid and ends the wait on its email, once; a bank payment clears
 *     later or fails; an event from another mode, account, workspace or link changes nothing;
 *   - paid by hand or voided: the link is switched off; paid online after all is recorded and flagged;
 *   - Check Stripe finds a payment whose event never came; paid online can't be opened again;
 *   - with Stripe off nothing is offered; disconnected, no new links, and links already sent still count.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Invoice } from '../../src/data/ws-types';
import { defaultBilling, emailFor, totals } from '../../src/state/invoices';
import { withWorkspace } from '../src/db/pool';
import { propose } from '../src/gateway/gateway';
import { fakeStripe, HttpStripe, setStripeForTests, signStripeEvent, StripeError, verifyStripeSignature } from '../src/payments/stripe';
import { loadState } from '../src/state/docs';
import { addMember, boot, connectGmail, jobs, model, newWorkspace, rows, type Client } from './helpers';

const line = (id: string, qty: number, unitPrice: number) => ({ id, description: id, qty, unitPrice });

describe('the client for the real Stripe', () => {
  let server: Server;
  let base = '';
  const seen: { method: string; url: string; headers: Record<string, unknown>; body: string }[] = [];
  let answer: () => { status: number; body: unknown } = () => ({ status: 200, body: {} });
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        const a = answer();
        res.writeHead(a.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(a.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    seen.length = 0;
  });
  const key = ['sk', 'test', 'platformkey123'].join('_');

  it('makes the business’s account and its onboarding page with v2’s JSON, and reads whether card payments are on', async () => {
    const s = new HttpStripe(base, key, '2026-11-18.endive');
    expect(s.livemode).toBe(false);
    answer = () => ({ status: 200, body: { id: 'acct_1', object: 'v2.core.account' } });
    expect(await s.createAccount({ name: 'Northpeak', email: 'billing@northpeak.test', country: 'US' }, 'timmy-account-w1')).toEqual({ id: 'acct_1' });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/v2/core/accounts' });
    expect(seen[0]!.headers).toMatchObject({ authorization: `Bearer ${key}`, 'stripe-version': '2026-11-18.endive', 'idempotency-key': 'timmy-account-w1', 'content-type': 'application/json' });
    expect(JSON.parse(seen[0]!.body)).toEqual({
      display_name: 'Northpeak',
      contact_email: 'billing@northpeak.test',
      identity: { country: 'us' },
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
      dashboard: 'full',
      include: ['configuration.merchant'],
    });

    answer = () => ({ status: 200, body: { object: 'v2.core.account_link', url: 'https://connect.stripe.com/setup/s/abc' } });
    expect(await s.onboardingLink('acct_1', 'https://app.test/return', 'https://app.test/refresh')).toEqual({ url: 'https://connect.stripe.com/setup/s/abc' });
    expect(JSON.parse(seen[1]!.body)).toEqual({ account: 'acct_1', use_case: { type: 'account_onboarding', account_onboarding: { configurations: ['merchant'], return_url: 'https://app.test/return', refresh_url: 'https://app.test/refresh' } } });

    answer = () => ({ status: 200, body: { id: 'acct_1', display_name: 'Northpeak', identity: { country: 'us' }, configuration: { merchant: { capabilities: { card_payments: { status: 'active' } } } } } });
    expect(await s.account('acct_1')).toMatchObject({ id: 'acct_1', ready: true, submitted: false, country: 'US' });
    expect(seen[2]).toMatchObject({ method: 'GET', url: '/v2/core/accounts/acct_1?include%5B0%5D=configuration.merchant&include%5B1%5D=identity' });
    answer = () => ({ status: 200, body: { id: 'acct_1', configuration: { merchant: { capabilities: { card_payments: { status: 'pending' } } } } } });
    expect(await s.account('acct_1')).toMatchObject({ ready: false, submitted: true });
  });

  it('makes a payment link on the connected account, for one payment, with Stripe’s form fields, and reads paid checkouts', async () => {
    const s = new HttpStripe(base, key, '2026-11-18.endive');
    answer = () => ({ status: 200, body: { id: 'plink_1', url: 'https://buy.stripe.com/test_1' } });
    const made = await s.createPaymentLink('acct_1', { name: 'Invoice INV-0003', amount: 123450, currency: 'usd', description: 'Invoice INV-0003 from Northpeak', thanks: 'Thank you.', closed: 'Paid.', metadata: { timmy_invoice: 'inv-3', timmy_workspace: 'w1' } }, 'timmy-eff_1');
    expect(made).toEqual({ id: 'plink_1', url: 'https://buy.stripe.com/test_1' });
    expect(seen[0]!.headers).toMatchObject({ 'stripe-account': 'acct_1', 'idempotency-key': 'timmy-eff_1', 'content-type': 'application/x-www-form-urlencoded' });
    const form = Object.fromEntries(new URLSearchParams(seen[0]!.body));
    expect(form).toMatchObject({
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '123450',
      'line_items[0][price_data][product_data][name]': 'Invoice INV-0003',
      'line_items[0][quantity]': '1',
      'restrictions[completed_sessions][limit]': '1',
      'after_completion[type]': 'hosted_confirmation',
      'payment_intent_data[metadata][timmy_invoice]': 'inv-3',
      'metadata[timmy_workspace]': 'w1',
    });

    answer = () => ({ status: 200, body: { id: 'plink_1', active: false } });
    await s.setLinkActive('acct_1', 'plink_1', false);
    expect(seen[1]).toMatchObject({ method: 'POST', url: '/v1/payment_links/plink_1', body: 'active=false' });

    answer = () => ({ status: 200, body: { data: [{ id: 'cs_1', amount_total: 123450, currency: 'usd', payment_status: 'paid', created: 1764300000, payment_intent: 'pi_1' }] } });
    expect(await s.paidSessions('acct_1', 'plink_1')).toEqual([{ id: 'cs_1', amount: 123450, currency: 'USD', paid: true, at: new Date(1764300000 * 1000), paymentIntent: 'pi_1' }]);
    expect(seen[2]!.url).toBe('/v1/checkout/sessions?payment_link=plink_1&status=complete&limit=10');
  });

  it('says Stripe’s refusals in plain words, never what Stripe said or the key', async () => {
    const s = new HttpStripe(base, key, '2026-11-18.endive');
    const refusal = async (status: number, body: unknown) => {
      answer = () => ({ status, body });
      return s.account('acct_1').then(
        () => null,
        (e: StripeError) => e,
      );
    };
    const bad = (await refusal(401, { error: { type: 'invalid_request_error', message: `Invalid API Key provided: ${key}` } }))!;
    expect(bad).toMatchObject({ status: 503, message: 'Card payments are paused on this server just now. The people who run Timmy have been told.' });
    expect(bad.message).not.toContain(key);
    expect((await refusal(400, { error: { code: 'platform_registration_required', message: 'sign up for Connect' } }))!.status).toBe(503);
    expect((await refusal(400, { error: { code: 'amount_too_small', message: 'Amount must be at least $0.50 usd' } }))!.message).toBe('Stripe can’t take a card payment that small.');
    expect((await refusal(404, { error: { code: 'resource_missing', message: 'No such account: acct_1' } }))!).toMatchObject({ status: 409 });
    expect((await refusal(429, { error: { code: 'rate_limit' } }))!.status).toBe(503);
    expect((await refusal(500, { error: { type: 'api_error', message: 'boom' } }))!.status).toBe(502);
    const odd = (await refusal(400, { error: { code: 'parameter_unknown', param: 'foo', message: 'Received unknown parameter: foo' } }))!;
    expect(odd.message).not.toMatch(/foo|parameter/);
    const down = await new HttpStripe('http://127.0.0.1:9', key, 'v', 2000).account('acct_1').catch((e: StripeError) => e);
    expect(down).toMatchObject({ status: 502 });
  });

  it('checks an event’s signature and age, and reads a header with entries in any order', () => {
    const secret = 'whsec_test_secret';
    const raw = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
    const now = Date.now();
    expect(() => verifyStripeSignature(raw, signStripeEvent(raw, secret, Math.floor(now / 1000)), secret, now)).not.toThrow();
    const t = Math.floor(now / 1000);
    const good = signStripeEvent(raw, secret, t).split(',')[1]!;
    expect(() => verifyStripeSignature(raw, `v0=old,v1=${'0'.repeat(64)},t=${t},${good},secret=whsec_****`, secret, now)).not.toThrow();
    expect(() => verifyStripeSignature(raw.replace('evt_1', 'evt_2'), signStripeEvent(raw, secret, t), secret, now)).toThrow('bad signature');
    expect(() => verifyStripeSignature(raw, signStripeEvent(raw, 'whsec_other', t), secret, now)).toThrow('bad signature');
    expect(() => verifyStripeSignature(raw, signStripeEvent(raw, secret, t - 600), secret, now)).toThrow('too old');
    expect(() => verifyStripeSignature(raw, null, secret, now)).toThrow();
    expect(() => verifyStripeSignature(raw, `t=${t}`, secret, now)).toThrow('malformed');
  });
});

describe('card payments in a workspace', () => {
  let w: Client;
  const stripe = () => fakeStripe()!;
  const inv = async (id: string) => (await w.state()).ws.invoices[id] as Invoice;
  const put = (c: Client, item: Record<string, unknown>) => c.cmd({ type: 'ws', ops: [{ op: 'put', col: 'invoices', item }] });
  const hook = async (x: { headers: Record<string, string>; body: string }) => {
    const res = await (await boot()).request('/api/hooks/stripe', { method: 'POST', headers: x.headers, body: x.body });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const accountOf = async (c: Client) => (await rows<{ account_id: string }>('select account_id from payment_account where workspace_id = $1', [c.workspaceId]))[0]?.account_id;
  /** Connects Stripe as the owner and finishes Stripe's form. */
  const connected = async (c: Client) => {
    const r = await c.json<{ url: string }>('POST', '/api/v1/payments/stripe/connect', { country: 'US' });
    expect(r.url, JSON.stringify(r)).toContain('/api/test/fake-stripe-onboard');
    stripe().completeOnboarding((await accountOf(c))!);
    expect((await c.get('/api/v1/payments/stripe/return')).headers.get('location')).toBe('/?payments=ready');
  };
  /** An invoice for Sam at $1,234.50, ready to send. */
  const invoice = async (c: Client, id: string, cents = 123450) => {
    await c.cmd({ type: 'newInvoice', kind: 'invoice', id });
    const s = await c.state();
    await put(c, { ...s.ws.invoices[id], client: { name: 'Sam Rivera', email: 'sam@acme.test' }, items: [line('Design work', 1, cents)] });
  };
  const link = (c: Client, id: string) => c.request('POST', `/api/v1/invoices/${id}/pay-link`, {});

  beforeAll(async () => {
    await boot();
  });
  beforeEach(async () => {
    model().reset();
    jobs().queue = [];
    stripe().calls.length = 0;
    w = await newWorkspace('Northpeak');
    await connectGmail(w, 'owner@northpeak.test');
    await jobs().drain();
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'billing', item: { ...defaultBilling('Northpeak'), email: 'billing@northpeak.test' } }] })).ok).toBe(true);
  });
  afterEach(() => setStripeForTests(undefined));

  it('only an owner or admin connects Stripe; one account, made on Stripe; card payments on when Stripe says so', async () => {
    expect(await w.json('GET', '/api/v1/payments/status')).toEqual({ on: true, stripe: 'none', canConnect: true });
    const member = await addMember(w.workspaceId, 'member');
    expect((await member.request('POST', '/api/v1/payments/stripe/connect', { country: 'US' })).status).toBe(403);
    expect(await member.json('GET', '/api/v1/payments/status')).toMatchObject({ canConnect: false });
    expect((await w.request('POST', '/api/v1/payments/stripe/connect', { country: 'XX' })).status).toBe(400);

    const r = await w.json<{ url: string }>('POST', '/api/v1/payments/stripe/connect', { country: 'US' });
    expect(r.url).toMatch(/^http:\/\/localhost:8787\/api\/test\/fake-stripe-onboard\?account=acct_fake\w+&to=/);
    const acct = (await accountOf(w))!;
    expect(stripe().accounts.get(acct)).toMatchObject({ name: 'Northpeak', email: 'billing@northpeak.test', country: 'US', status: 'restricted' });
    // Pressing again carries on with the same account.
    await w.json('POST', '/api/v1/payments/stripe/connect', { country: 'US' });
    expect(stripe().calls.filter((x) => x.op === 'createAccount')).toHaveLength(1);
    expect(await rows('select 1 from payment_account where workspace_id = $1', [w.workspaceId])).toHaveLength(1);

    // Back from Stripe before the form is done: not on. Stripe checking it: still not on.
    expect((await w.get('/api/v1/payments/stripe/return')).headers.get('location')).toBe('/?payments=pending');
    expect(await w.json('GET', '/api/v1/payments/status')).toMatchObject({ stripe: 'started' });
    stripe().completeOnboarding(acct, 'pending');
    expect(await w.json('GET', '/api/v1/payments/status?refresh=1')).toMatchObject({ stripe: 'checking' });
    stripe().completeOnboarding(acct);
    expect((await w.get('/api/v1/payments/stripe/return')).headers.get('location')).toBe('/?payments=ready');
    expect(await w.json('GET', '/api/v1/payments/status')).toEqual({ on: true, stripe: 'ready', country: 'US', canConnect: true });
    // The account is the server's to know: no screen can see or point it anywhere.
    expect(JSON.stringify(await w.state())).not.toContain(acct);
    expect((await rows('select action from audit_log where workspace_id = $1 and action like $2 order by id', [w.workspaceId, 'payments.%'])).map((x) => x.action)).toEqual(['payments.account_created', 'payments.ready']);
  });

  it('a payment link: through the gateway, approved by the click, on the business’s account, for the invoice’s total, once', async () => {
    await connected(w);
    await invoice(w, 'inv-a');
    const res = await link(w, 'inv-a');
    expect(res.status).toBe(200);
    const made = (await res.json()) as { url: string; amount: number; currency: string };
    expect(made).toMatchObject({ amount: 123450, currency: 'USD' });
    expect(made.url).toMatch(/^https:\/\//);
    const call = stripe().calls.find((x) => x.op === 'createPaymentLink')!;
    expect(call.account).toBe(await accountOf(w));
    expect(call.body).toMatchObject({ name: 'Invoice INV-0001', amount: 123450, currency: 'usd', metadata: { timmy_invoice: 'inv-a', timmy_workspace: w.workspaceId } });
    const [eff] = await rows<{ kind: string; status: string; approved_via: string; requested_by: string; source: string; idempotency_key: string }>(`select * from effect where workspace_id = $1 and kind = 'invoice.link'`, [w.workspaceId]);
    expect(eff).toMatchObject({ status: 'completed', approved_via: 'click', requested_by: w.userId, source: 'user' });
    expect(call.idempotencyKey).toMatch(/^timmy-eff/);

    const a = await inv('inv-a');
    expect(a.pay).toMatchObject({ url: made.url, amount: 123450, currency: 'USD', active: true });
    expect(a.pay!.paid).toBeUndefined();
    // Asked again: the same link, and Stripe isn't asked.
    const again = (await (await link(w, 'inv-a')).json()) as { url: string };
    expect(again.url).toBe(made.url);
    expect(stripe().calls.filter((x) => x.op === 'createPaymentLink')).toHaveLength(1);

    // The email and the PDF carry it.
    const mail = emailFor(a, (await w.state()).ws.billing.settings!, 'Taylor');
    expect(mail.body).toContain(`Pay online by card:\n${made.url}`);
    const pdf = new TextDecoder('latin1').decode(new Uint8Array(await (await w.request('GET', '/api/v1/invoices/inv-a/pdf')).arrayBuffer()));
    expect(pdf).toContain(made.url);
  });

  it('no link for a quote, an empty or paid invoice, a read-only role, or a business that hasn’t connected Stripe', async () => {
    await invoice(w, 'inv-a');
    expect((await link(w, 'inv-a')).status).toBe(409);
    await connected(w);
    await w.cmd({ type: 'newInvoice', kind: 'quote', id: 'quo-a' });
    expect((await link(w, 'quo-a')).status).toBe(400);
    await w.cmd({ type: 'newInvoice', kind: 'invoice', id: 'inv-empty' });
    expect((await link(w, 'inv-empty')).status).toBe(400);
    expect((await link(w, 'nope')).status).toBe(404);
    const revops = await addMember(w.workspaceId, 'revops');
    expect((await link(revops, 'inv-a')).status).toBe(403);
    await w.cmd({ type: 'invoice', op: 'paid', id: 'inv-a' });
    expect((await link(w, 'inv-a')).status).toBe(400);
    expect(stripe().calls.filter((x) => x.op === 'createPaymentLink')).toHaveLength(0);
  });

  it('a screen can’t set, change or drop a link, or say an invoice was paid online', async () => {
    await connected(w);
    await invoice(w, 'inv-a');
    await link(w, 'inv-a');
    const real = (await inv('inv-a')).pay!;
    const a = await inv('inv-a');
    // Saved with a forged link, and with none: the server's stays.
    expect((await put(w, { ...a, pay: { ...real, url: 'https://evil.example/pay', paid: { at: new Date(), amount: 1, ref: 'x' } } })).ok).toBe(true);
    expect((await inv('inv-a')).pay).toEqual(real);
    const { pay: _p, ...without } = a;
    expect((await put(w, { ...without, notes: 'Thanks!' })).ok).toBe(true);
    expect(await inv('inv-a')).toMatchObject({ notes: 'Thanks!', pay: real });
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'invoices', id: 'inv-a', patch: { pay: null } }] })).ok).toBe(true);
    expect((await inv('inv-a')).pay).toEqual(real);
    // A new invoice can't start with one.
    await w.cmd({ type: 'newInvoice', kind: 'invoice', id: 'inv-b' });
    await put(w, { ...(await inv('inv-b')), pay: { ...real } });
    expect((await inv('inv-b')).pay).toBeUndefined();
    // Only Stripe says it was paid; the sample demo's link is the demo's.
    expect((await w.cmd({ type: 'invoicePayment', id: 'inv-a', event: 'paid', at: new Date(), amount: 123450, currency: 'USD', ref: 'x' })).ok).toBe(false);
    expect((await w.cmd({ type: 'samplePayLink', id: 'inv-b' })).ok).toBe(false);
    expect((await inv('inv-a')).status).toBe('draft');
  });

  it('a changed total gets a new link, and the old one is switched off', async () => {
    await connected(w);
    await invoice(w, 'inv-a');
    const first = (await (await link(w, 'inv-a')).json()) as { url: string };
    const old = (await inv('inv-a')).pay!.link;
    await put(w, { ...(await inv('inv-a')), items: [line('Design work', 2, 50000)] });
    // A link for the old total isn't offered any more.
    expect(emailFor(await inv('inv-a'), (await w.state()).ws.billing.settings!, 'T').body).not.toContain('Pay online');
    const second = (await (await link(w, 'inv-a')).json()) as { url: string; amount: number };
    expect(second.amount).toBe(100000);
    expect(second.url).not.toBe(first.url);
    expect(stripe().links.get(old)!.active).toBe(false);
    expect((await inv('inv-a')).pay).toMatchObject({ amount: 100000, url: second.url });
  });

  it('paid through the link: Stripe’s signed event marks it paid and ends the wait on its email, once', async () => {
    await connected(w);
    await invoice(w, 'inv-a');
    await link(w, 'inv-a');
    const out = await w.cmd({ type: 'sendNew', draft: { to: ['mail:sam@acme.test'], subject: 'Invoice INV-0001 from Northpeak', body: 'Attached.', invoice: 'inv-a', track: { on: 'mail:sam@acme.test', item: 'Payment of INV-0001' } } });
    expect(out.ok).toBe(true);
    const sent = await inv('inv-a');
    expect((await w.state()).threads.find((t) => t.id === sent.thread)!.box).toBe('waiting');

    const paid = stripe().pay(sent.pay!.link);
    const r = await hook(paid.webhook);
    expect(r).toEqual({ status: 200, body: { ok: true, applied: true } });
    const after = await inv('inv-a');
    expect(after).toMatchObject({ status: 'paid', pay: { active: false, paid: { amount: 123450 } } });
    expect(after.paidAt).toBeDefined();
    const s = await w.state();
    expect(s.threads.find((t) => t.id === sent.thread)!.box).toBe('archived');
    expect(s.activity[0]!.text).toBe('INV-0001 paid online: $1,234.50 from Sam Rivera');
    // Stripe sends it again: nothing happens twice.
    expect((await hook(paid.webhook)).body).toMatchObject({ duplicate: true });
    expect((await w.state()).activity.filter((x) => /paid online/.test(x.text))).toHaveLength(1);
    // The money is in Stripe: it can't be opened again here.
    await w.cmd({ type: 'invoice', op: 'reopen', id: 'inv-a' });
    expect((await inv('inv-a')).status).toBe('paid');
  });

  it('an event is checked first: its signature, its mode, the account, the workspace and the link', async () => {
    await connected(w);
    await invoice(w, 'inv-a');
    await link(w, 'inv-a');
    const acct = (await accountOf(w))!;
    const a = await inv('inv-a');
    const session = (extra: Record<string, unknown> = {}) => ({ id: 'cs_x', object: 'checkout.session', amount_total: 123450, currency: 'usd', payment_status: 'paid', created: Math.floor(Date.now() / 1000), payment_intent: 'pi_x', payment_link: a.pay!.link, metadata: { timmy_invoice: 'inv-a', timmy_workspace: w.workspaceId }, ...extra });
    const good = stripe().event('checkout.session.completed', acct, session());
    expect((await hook({ ...good, body: good.body.replace('pi_x', 'pi_y') })).status).toBe(400);
    expect((await hook(stripe().event('checkout.session.completed', acct, session(), { t: Math.floor(Date.now() / 1000) - 900 }))).status).toBe(400);
    expect((await hook(stripe().event('checkout.session.completed', acct, session(), { livemode: true }))).body).toMatchObject({ ignored: 'other mode' });
    expect((await hook(stripe().event('checkout.session.completed', 'acct_nobody', session()))).body).toMatchObject({ ignored: 'unknown account' });
    // Another workspace's invoice id, a link the invoice doesn't carry, or the business's own checkout: nothing.
    expect((await hook(stripe().event('checkout.session.completed', acct, session({ metadata: { timmy_invoice: 'inv-a', timmy_workspace: 'ws_other' } })))).body).toMatchObject({ applied: false });
    expect((await hook(stripe().event('checkout.session.completed', acct, session({ payment_link: 'plink_other' })))).body).toMatchObject({ applied: false });
    expect((await hook(stripe().event('checkout.session.completed', acct, session({ metadata: {} })))).body).toMatchObject({ applied: false });
    expect((await inv('inv-a')).status).toBe('draft');
    expect((await hook(good)).body).toMatchObject({ applied: true });
    expect((await inv('inv-a')).status).toBe('paid');
  });

  it('a bank payment clears days later; one that fails leaves the invoice open', async () => {
    await connected(w);
    await invoice(w, 'inv-a');
    await link(w, 'inv-a');
    const started = stripe().pay((await inv('inv-a')).pay!.link, { bank: true });
    await hook(started.webhook);
    expect(await inv('inv-a')).toMatchObject({ status: 'draft', pay: { active: false } });
    expect((await inv('inv-a')).pay!.clearing).toBeDefined();
    await hook(stripe().clear(started.session));
    expect(await inv('inv-a')).toMatchObject({ status: 'paid', pay: { paid: { amount: 123450 } } });

    await invoice(w, 'inv-b', 5000);
    await link(w, 'inv-b');
    const b = stripe().pay((await inv('inv-b')).pay!.link, { bank: true });
    await hook(b.webhook);
    await hook(stripe().clear(b.session, false));
    const after = await inv('inv-b');
    expect(after.status).toBe('draft');
    expect(after.pay!.clearing).toBeUndefined();
    expect((await w.state()).activity[0]!.text).toBe('The bank payment for INV-0002 didn’t go through. The invoice is still open.');
  });

  it('paid by hand or voided: the link is switched off; paid online after all is recorded and flagged', async () => {
    await connected(w);
    await invoice(w, 'inv-a');
    await link(w, 'inv-a');
    const l = (await inv('inv-a')).pay!.link;
    expect((await w.cmd({ type: 'invoice', op: 'paid', id: 'inv-a' })).ok).toBe(true);
    await jobs().drain();
    expect(stripe().links.get(l)!.active).toBe(false);
    expect((await inv('inv-a')).pay!.active).toBe(false);
    const [eff] = await rows<{ status: string; approved_via: string }>(`select * from effect where workspace_id = $1 and kind = 'invoice.unlink'`, [w.workspaceId]);
    expect(eff).toMatchObject({ status: 'completed', approved_via: 'click' });

    await invoice(w, 'inv-b', 5000);
    await link(w, 'inv-b');
    const lb = (await inv('inv-b')).pay!.link;
    const paidLater = stripe().pay(lb); // the client paid at the same moment it was voided
    expect((await w.cmd({ type: 'invoice', op: 'void', id: 'inv-b' })).ok).toBe(true);
    await jobs().drain();
    await hook(paidLater.webhook);
    expect(await inv('inv-b')).toMatchObject({ status: 'void', pay: { paid: { amount: 5000 } } });
    expect((await w.state()).activity[0]!.text).toBe('INV-0002 is void, but Sam Rivera paid $50.00 online. Refund it in your Stripe Dashboard if it shouldn’t have been paid.');
  });

  it('Check Stripe finds a payment whose event never came', async () => {
    await connected(w);
    await invoice(w, 'inv-a');
    await link(w, 'inv-a');
    stripe().pay((await inv('inv-a')).pay!.link); // the event is lost
    expect((await inv('inv-a')).status).toBe('draft');
    expect(await w.json('POST', '/api/v1/invoices/inv-a/pay-check', {})).toEqual({ paid: true, clearing: false });
    expect((await inv('inv-a')).status).toBe('paid');
    expect(await w.json('POST', '/api/v1/invoices/inv-a/pay-check', {})).toEqual({ paid: true, clearing: false });
    expect((await w.state()).activity.filter((x) => /paid online/.test(x.text))).toHaveLength(1);
  });

  it('only a person’s click makes or switches off a link: not Timmy on its own, and not a rule', async () => {
    await connected(w);
    await invoice(w, 'inv-a');
    const blocked = await withWorkspace({ workspaceId: w.workspaceId }, async (tx) => {
      const loaded = await loadState(tx, w.workspaceId);
      const payload = { account: await accountOf(w), invoiceId: 'inv-a', number: 'INV-0001', amount: 123450, currency: 'USD', business: 'Northpeak', workspaceId: w.workspaceId };
      return Promise.all([
        propose(tx, loaded, loaded.state, null, { kind: 'invoice.link', payload, preview: { lines: [] }, title: 't', why: 'w', idempotencyKey: 'agent-link', source: 'agent' }),
        propose(tx, loaded, loaded.state, null, { kind: 'invoice.unlink', payload, preview: { lines: [] }, title: 't', why: 'w', idempotencyKey: 'rule-unlink', source: 'rule' }),
      ]);
    });
    expect(blocked.map((b) => b.outcome)).toEqual(['blocked', 'blocked']);
    expect(blocked[0]!.reason).toBe('Only a person’s own click can do that.');
    expect(stripe().calls.filter((x) => x.op === 'createPaymentLink')).toHaveLength(0);
  });

  it('with Stripe off nothing is offered; disconnected, no new links, and a link already sent still counts', async () => {
    await connected(w);
    await invoice(w, 'inv-a');
    await link(w, 'inv-a');
    const l = (await inv('inv-a')).pay!.link;
    const member = await addMember(w.workspaceId, 'admin');
    expect((await member.request('POST', '/api/v1/payments/stripe/disconnect', {})).status).toBe(200);
    expect(await w.json('GET', '/api/v1/payments/status')).toMatchObject({ stripe: 'none' });
    await invoice(w, 'inv-b', 9900);
    expect((await link(w, 'inv-b')).status).toBe(409);
    // The client pays the link they were sent before the disconnect: the invoice is still marked paid.
    await hook(stripe().pay(l).webhook);
    expect((await inv('inv-a')).status).toBe('paid');
    // Connecting again picks up the same account.
    await w.json('POST', '/api/v1/payments/stripe/connect', { country: 'US' });
    expect(stripe().calls.filter((x) => x.op === 'createAccount')).toHaveLength(1);

    setStripeForTests(null);
    expect(await w.json('GET', '/api/v1/payments/status')).toMatchObject({ on: false });
    expect((await link(w, 'inv-b')).status).toBe(503);
    expect((await (await boot()).request('/api/hooks/stripe', { method: 'POST', body: '{}' })).status).toBe(404);
    expect(totals(await inv('inv-b')).total).toBe(9900);
  });
});
