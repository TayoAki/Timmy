/**
 * Bids, for the Bids screens. The public data comes from Kontract's engine API (kontract/client.ts); what the
 * workspace keeps is its own state, changed here only where Kontract's data goes into it:
 *   GET  /api/v1/bids/status                 whether Kontract is set up on this server
 *   GET  /api/v1/bids/search?q=&state=…      open notices (federal, state and local)
 *   GET  /api/v1/bids/notice/:id             one notice, with its description
 *   POST /api/v1/bids/track      { notice }  starts a bid with Kontract's copy of the notice, and a to-do for its deadline
 *   POST /api/v1/bids/:id/read               what the documents say (Kontract's free rules) and a plain-English read
 *   POST /api/v1/bids/:id/pricing            past awards like it, from USAspending
 *   POST /api/v1/bids/:id/subs/search { query, location }   local businesses (costs a little)
 *   GET  /api/v1/bids/:id/subs/nearby        businesses pulling permits near the job (free)
 *   POST /api/v1/bids/website   { url }      what a business's website says: emails, phones, licenses (costs a little)
 * Searching and reading need a role that can read the workspace; anything that changes it, or costs money, needs one
 * that can work in it. The price lines, subs, stage and notes are changed through ordinary commands.
 */
import type { Context, Hono } from 'hono';
import type { Opportunity } from '../../../src/data/kontract-api';
import type { Bid } from '../../../src/data/ws-types';
import { linesFromBreakdown, pricingQueryFor, trimDetails, trimNotice, LIMITS } from '../../../src/state/bids';
import { callKontract, fakeKontract, kontractReady, KontractError, type OpportunitySearch } from '../kontract/client';
import { newId } from '../lib/ids';
import { BudgetError } from '../providers/model';
import { reduce } from '../state/engine';
import { mutate, readState } from '../state/mutate';
import { ctxOf, requireRead, requireWorkspace, type Env } from './session';

const NOTICE_ID = /^[\w.:-]{1,200}$/;

/** A refusal in the person's words, with Retry-After when Kontract asked for a pause. */
function failed(c: Context<Env>, e: unknown) {
  if (e instanceof KontractError) {
    if (e.retryAfter) c.header('retry-after', String(e.retryAfter));
    return c.json({ error: e.message }, e.status as 400);
  }
  if (e instanceof BudgetError) return c.json({ error: e.message }, 429);
  throw e;
}

/** The search parameters a screen may send, each checked; anything else is dropped. */
function searchFrom(q: Record<string, string | undefined>): OpportunitySearch {
  const s: OpportunitySearch = {};
  const words = (q.q ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (words) s.q = words;
  if (q.state && /^[A-Za-z]{2}$/.test(q.state)) s.state = q.state.toUpperCase();
  if (q.naics && /^\d{2,6}$/.test(q.naics)) s.naics = q.naics;
  if (q.setAside && /^[A-Za-z0-9]{1,20}$/.test(q.setAside)) s.setAside = q.setAside;
  if (q.level === 'federal' || q.level === 'sled') s.level = q.level;
  if (q.servicesOnly === '1') s.servicesOnly = true;
  if (q.sort === 'deadline' || q.sort === 'posted' || q.sort === 'fit') s.sort = q.sort;
  const limit = Number(q.limit ?? 25);
  s.limit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 50) : 25;
  const offset = Number(q.offset ?? 0);
  s.offset = Number.isInteger(offset) ? Math.min(Math.max(offset, 0), 5000) : 0;
  return s;
}

/** A bid of this workspace, or null. */
async function bidOf(workspaceId: string, id: string): Promise<Bid | null> {
  const { state } = await readState(workspaceId);
  return Object.hasOwn(state.ws.bids ?? {}, id) ? state.ws.bids[id]! : null;
}

/** Changes one bid in the workspace's state, if it is still there. */
async function changeBid(workspaceId: string, id: string, change: (b: Bid) => Bid): Promise<Bid | null> {
  return mutate<Bid | null>(workspaceId, 'bids', async (_tx, loaded) => {
    const cur = loaded.state.ws.bids?.[id];
    if (!cur) return { result: null };
    const next = { ...change(cur), updated: new Date() };
    return { state: { ...loaded.state, ws: { ...loaded.state.ws, bids: { ...loaded.state.ws.bids, [id]: next } } }, result: next };
  });
}

/** Kontract reads a closed federal notice from the copy kept with the bid; the copy never decides what is fetched. */
const copyOf = (b: Bid): Opportunity => b.notice;

export function bidRoutes(app: Hono<Env>): void {
  app.get('/api/v1/bids/status', requireWorkspace, requireRead, (c) => c.json({ on: kontractReady(), sample: !!fakeKontract() }));

  app.get('/api/v1/bids/search', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    try {
      const r = await callKontract(ctx.workspaceId, 'opportunities', (e, ws) => e.opportunities(ws, searchFrom(c.req.query())));
      return c.json(r);
    } catch (e) {
      return failed(c, e);
    }
  });

  app.get('/api/v1/bids/notice/:id', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const id = c.req.param('id');
    if (!NOTICE_ID.test(id)) return c.json({ error: 'That isn’t a notice id.' }, 400);
    try {
      return c.json(await callKontract(ctx.workspaceId, 'opportunity', (e, ws) => e.opportunity(ws, id)));
    } catch (e) {
      return failed(c, e);
    }
  });

  app.post('/api/v1/bids/track', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.work) return c.json({ error: 'Your role can’t start bids in this workspace.' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { notice?: unknown };
    if (typeof body.notice !== 'string' || !NOTICE_ID.test(body.notice)) return c.json({ error: 'Which notice?' }, 400);
    let notice: Opportunity;
    try {
      // The copy kept is Kontract's own, fetched here: never one a screen sends.
      notice = (await callKontract(ctx.workspaceId, 'opportunity', (e, ws) => e.opportunity(ws, body.notice as string))).opportunity;
    } catch (e) {
      return failed(c, e);
    }
    const result = await mutate<{ id: string; created: boolean } | null>(ctx.workspaceId, 'bids', async (_tx, loaded) => {
      const had = Object.values(loaded.state.ws.bids ?? {}).find((b) => b.notice.id === notice.id);
      if (had) return { result: { id: had.id, created: false } };
      const id = newId('bid');
      const made = reduce(loaded, loaded.state, { type: 'trackBid', id, notice: trimNotice(notice), task: newId('tsk') });
      if (!made.ws.bids?.[id]) return { result: null };
      // The screen opens the bid itself; the server's own state keeps where it was.
      return { state: { ...made, route: loaded.state.route, back: loaded.state.back, toasts: loaded.state.toasts }, result: { id, created: true } };
    });
    if (!result) return c.json({ error: 'Timmy couldn’t start that bid.' }, 500);
    return c.json({ bid: result });
  });

  app.post('/api/v1/bids/:id/read', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.work) return c.json({ error: 'Your role can’t change bids in this workspace.' }, 403);
    const bid = await bidOf(ctx.workspaceId, c.req.param('id'));
    if (!bid) return c.json({ error: 'That bid isn’t in this workspace.' }, 404);
    try {
      // Kontract's free rules read the documents; asking for Claude's reading as well is left for later (it costs).
      const { details } = await callKontract(ctx.workspaceId, 'details', (e, ws) => e.details(ws, bid.notice.id, { claude: false, opportunity: copyOf(bid) }));
      const { breakdown } = await callKontract(ctx.workspaceId, 'breakdown', (e, ws) => e.breakdown(ws, bid.notice.id, { opportunity: copyOf(bid) }));
      const next = await changeBid(ctx.workspaceId, bid.id, (b) => {
        const lines = b.pricing.lines.length ? b.pricing.lines : linesFromBreakdown(breakdown, (n) => `${b.id}-l${n}`);
        const periods = !b.pricing.lines.length && breakdown.periods && breakdown.periods > 1 ? Math.min(50, Math.round(breakdown.periods)) : b.pricing.periods;
        return { ...b, details: trimDetails(details), breakdown: { ...breakdown, plainEnglish: breakdown.plainEnglish.slice(0, LIMITS.text) }, pricing: { ...b.pricing, lines, periods, periodLabel: periods > 1 ? 'year' : b.pricing.periodLabel } };
      });
      if (!next) return c.json({ error: 'That bid isn’t in this workspace.' }, 404);
      const facts = [details.budget, details.bonds, details.siteVisit, details.questionsDue, details.period, details.evaluation].filter(Boolean).length + details.requirements.length + details.sizes.length;
      return c.json({ read: { documents: details.documents.length, facts, breakdown: breakdown.source } });
    } catch (e) {
      return failed(c, e);
    }
  });

  app.post('/api/v1/bids/:id/pricing', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.work) return c.json({ error: 'Your role can’t change bids in this workspace.' }, 403);
    const bid = await bidOf(ctx.workspaceId, c.req.param('id'));
    if (!bid) return c.json({ error: 'That bid isn’t in this workspace.' }, 404);
    const query = pricingQueryFor(bid);
    if (!query.keywords.length) return c.json({ error: 'Read the documents first, so Timmy knows what to look for.' }, 400);
    try {
      const r = await callKontract(ctx.workspaceId, 'pricing', (e, ws) => e.pricing(ws, { query, context: { agency: bid.notice.agency, ...(bid.notice.placeOfPerformance.state ? { state: bid.notice.placeOfPerformance.state } : {}) } }));
      const pastPricing = { at: new Date(), query, stats: r.stats, awards: r.awards.slice(0, LIMITS.awards).map((a) => ({ ...a, description: a.description.slice(0, 300) })), recipients: r.recipients.slice(0, LIMITS.recipients) };
      const next = await changeBid(ctx.workspaceId, bid.id, (b) => ({ ...b, pastPricing }));
      if (!next) return c.json({ error: 'That bid isn’t in this workspace.' }, 404);
      return c.json({ pricing: { awards: r.stats.count, medianAnnual: r.stats.medianAnnual, medianTotal: r.stats.medianTotal } });
    } catch (e) {
      return failed(c, e);
    }
  });

  app.post('/api/v1/bids/:id/subs/search', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.work) return c.json({ error: 'Your role can’t search for subcontractors in this workspace.' }, 403);
    const bid = await bidOf(ctx.workspaceId, c.req.param('id'));
    if (!bid) return c.json({ error: 'That bid isn’t in this workspace.' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { query?: unknown; location?: unknown };
    const query = typeof body.query === 'string' ? body.query.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    const location = typeof body.location === 'string' ? body.location.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    if (!query || !location) return c.json({ error: 'Say what kind of business, and where.' }, 400);
    try {
      const r = await callKontract(ctx.workspaceId, 'subcontractors', (e, ws) => e.subcontractors(ws, { query, location }));
      return c.json({ results: r.results.slice(0, 20), source: r.source, ...(r.notice ? { notice: r.notice } : {}) });
    } catch (e) {
      return failed(c, e);
    }
  });

  app.get('/api/v1/bids/:id/subs/nearby', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const bid = await bidOf(ctx.workspaceId, c.req.param('id'));
    if (!bid) return c.json({ error: 'That bid isn’t in this workspace.' }, 404);
    const place = bid.notice.placeOfPerformance;
    if (!place.state || !/^[A-Z]{2}$/.test(place.state)) return c.json({ contractors: [] });
    try {
      const r = await callKontract(ctx.workspaceId, 'permits/contractors', (e, ws) => e.permitContractors(ws, { state: place.state!, ...(place.city ? { city: place.city.slice(0, 80) } : {}) }));
      return c.json({ contractors: r.slice(0, 20) });
    } catch (e) {
      return failed(c, e);
    }
  });

  app.post('/api/v1/bids/website', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.work) return c.json({ error: 'Your role can’t do that in this workspace.' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { url?: unknown };
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    let ok = false;
    try {
      const u = new URL(url);
      ok = (u.protocol === 'https:' || u.protocol === 'http:') && url.length <= 500 && !!u.hostname.includes('.');
    } catch {
      ok = false;
    }
    if (!ok) return c.json({ error: 'That isn’t a website address.' }, 400);
    try {
      const { facts } = await callKontract(ctx.workspaceId, 'websites/read', (e, ws) => e.website(ws, url));
      return c.json({ facts: { url: facts.url, emails: facts.emails.slice(0, 5), phones: facts.phones.slice(0, 5), licenses: facts.licenses.slice(0, 5), services: facts.services.slice(0, 10), serviceArea: facts.serviceArea, insured: facts.insured, experience: facts.experience } });
    } catch (e) {
      return failed(c, e);
    }
  });
}
