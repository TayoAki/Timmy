/**
 * Card payments for invoices, through Stripe Connect (payments/):
 *   GET  /api/v1/payments/status              whether card payments are on here, and where this business stands
 *   POST /api/v1/payments/stripe/connect      { country } → { url } of Stripe's onboarding page (owner or admin)
 *   GET  /api/v1/payments/stripe/return       where Stripe sends the person back; asks Stripe how it went
 *   GET  /api/v1/payments/stripe/refresh      Stripe's page expired: a fresh one
 *   POST /api/v1/payments/stripe/disconnect   no more links on that account (owner or admin)
 *   POST /api/v1/invoices/:id/pay-link        the invoice's "Pay online" link, made if needed (through the gateway)
 *   POST /api/v1/invoices/:id/pay-check       asks Stripe whether it has been paid
 *   POST /api/hooks/stripe                    Stripe's signed events (mounted ahead of the same-origin check)
 */
import type { Hono } from 'hono';
import { checkPayment, makePayLink } from '../payments/links';
import { connectStripe, disconnectStripe, freshOnboardingLink, paymentsStatus, refreshAccount } from '../payments/accounts';
import { stripeEvent } from '../payments/events';
import { ctxOf, requireRead, requireWorkspace, type Env } from './session';

export function stripeEventRoutes(app: Hono<Env>): void {
  app.post('/api/hooks/stripe', async (c) => {
    const raw = await c.req.text();
    const r = await stripeEvent(raw, c.req.header('stripe-signature'));
    return c.json(r.body, r.status as 200);
  });
}

const ID = /^[\w-]{1,100}$/;

export function paymentRoutes(app: Hono<Env>): void {
  app.get('/api/v1/payments/status', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    // "Check again" while Stripe is reviewing the business: Stripe is asked, not just what was last heard.
    if (c.req.query('refresh') === '1') await refreshAccount(ctx.workspaceId);
    return c.json(await paymentsStatus(ctx));
  });

  app.post('/api/v1/payments/stripe/connect', requireWorkspace, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { country?: unknown };
    const country = typeof body.country === 'string' && /^[a-z]{2}$/i.test(body.country) ? body.country : '';
    const r = await connectStripe(ctxOf(c), country);
    if (!r.ok) return c.json({ error: r.error }, r.status as 400);
    return c.json({ url: r.url });
  });

  // Stripe's own page sends the person back here, signed in as they were. Nothing in the address is trusted: Timmy
  // asks Stripe where the account stands.
  app.get('/api/v1/payments/stripe/return', requireWorkspace, async (c) => {
    const row = await refreshAccount(ctxOf(c).workspaceId);
    return c.redirect(`/?payments=${row?.ready ? 'ready' : row ? 'pending' : 'failed'}`);
  });

  app.get('/api/v1/payments/stripe/refresh', requireWorkspace, async (c) => {
    const url = await freshOnboardingLink(ctxOf(c));
    return url ? c.redirect(url) : c.redirect('/?payments=failed');
  });

  app.post('/api/v1/payments/stripe/disconnect', requireWorkspace, async (c) => {
    const r = await disconnectStripe(ctxOf(c));
    if (!r.ok) return c.json({ error: r.error }, (r.status ?? 400) as 400);
    return c.json({ ok: true });
  });

  app.post('/api/v1/invoices/:id/pay-link', requireWorkspace, async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: 'That invoice isn’t in this workspace.' }, 404);
    const r = await makePayLink(ctxOf(c), id);
    if (!r.ok) return c.json({ error: r.error }, r.status as 400);
    return c.json({ url: r.url, amount: r.amount, currency: r.currency });
  });

  app.post('/api/v1/invoices/:id/pay-check', requireWorkspace, requireRead, async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: 'That invoice isn’t in this workspace.' }, 404);
    const r = await checkPayment(ctxOf(c), id);
    if (!r.ok) return c.json({ error: r.error }, r.status as 400);
    return c.json({ paid: r.paid, clearing: r.clearing });
  });
}
