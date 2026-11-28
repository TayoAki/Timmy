/**
 * Leads that fit the offer, found through Treg, and the words Timmy writes for cold email (treg/leads.ts):
 *   GET  /api/v1/leads/status                  whether Treg is set up, and today's suggestions left
 *   POST /api/v1/leads/suggest  { ask?, count? }   finds and adds leads with checked emails to "Suggested by Timmy"
 *   POST /api/v1/outbound/offer-draft { website }   the offer, filled in from the business's website (not saved)
 *   POST /api/v1/outbound/sequence { call? }        a sequence written by the model from the offer (not saved)
 * Anything that looks up data or writes with the model needs a role that can work in the workspace. Nothing here
 * contacts anyone: cold email is still opened in the person's own mail app, one email at a time.
 */
import type { Hono } from 'hono';
import { config } from '../config';
import { fakeTreg, tregReady } from '../treg/client';
import { draftOffer, suggestionsLeft, suggestLeads, writeSequenceModel } from '../treg/leads';
import { ctxOf, requireRead, requireWorkspace, type Env } from './session';

export function leadRoutes(app: Hono<Env>): void {
  app.get('/api/v1/leads/status', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    return c.json({ on: tregReady(), sample: !!fakeTreg(), ...(tregReady() ? await suggestionsLeft(ctx.workspaceId) : { today: 0, left: 0, perDay: config.treg.leadsPerDay }) });
  });

  app.post('/api/v1/leads/suggest', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.work) return c.json({ error: 'Your role can’t add leads in this workspace.' }, 403);
    if (!tregReady()) return c.json({ error: 'Finding leads isn’t switched on for this server yet.' }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { ask?: unknown; count?: unknown };
    const ask = typeof body.ask === 'string' ? body.ask.slice(0, 200) : '';
    const count = Number.isInteger(body.count) ? Math.min(Math.max(body.count as number, 1), 25) : undefined;
    const r = await suggestLeads(ctx.workspaceId, { ask, ...(count ? { count } : {}) });
    if (!r.ok) return c.json({ error: r.error }, r.status as 400);
    return c.json({ added: r.added, skipped: r.skipped, left: r.left });
  });

  app.post('/api/v1/outbound/offer-draft', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.work) return c.json({ error: 'Your role can’t change the offer in this workspace.' }, 403);
    if (!tregReady()) return c.json({ error: 'Reading websites isn’t switched on for this server yet.' }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { website?: unknown };
    let url = typeof body.website === 'string' ? body.website.trim() : '';
    if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
    let ok = false;
    try {
      const u = new URL(url);
      ok = (u.protocol === 'https:' || u.protocol === 'http:') && url.length <= 500 && u.hostname.includes('.') && !/^(localhost|[\d.]+)$/.test(u.hostname);
    } catch {
      ok = false;
    }
    if (!ok) return c.json({ error: 'That isn’t a website address.' }, 400);
    const r = await draftOffer(ctx.workspaceId, url);
    if (!r.ok) return c.json({ error: r.error }, r.status as 400);
    return c.json({ offer: r.offer, proofFound: r.proofFound });
  });

  app.post('/api/v1/outbound/sequence', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.work) return c.json({ error: 'Your role can’t write campaigns in this workspace.' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { call?: unknown };
    const r = await writeSequenceModel(ctx.workspaceId, { call: body.call === true });
    if (!r.ok) return c.json({ error: r.error }, r.status as 400);
    return c.json({ steps: r.steps, written: r.written, replaced: r.replaced });
  });
}
