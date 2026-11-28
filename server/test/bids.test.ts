/**
 * Bids, with Kontract as the engine (server/src/kontract/client.ts, http/bids.ts, src/state/bids.ts):
 *   - the client Timmy uses for the real engine, against a local server: the key and workspace headers, the cost
 *     header, and each kind of refusal in the person's words without the key or Kontract's internals;
 *   - each workspace is its own Kontract workspace (`timmy-<id>`), and never sends a name;
 *   - searching, tracking a bid with Kontract's own copy of the notice and a to-do for its deadline, reading what the
 *     documents say, past awards, local businesses and a business's website;
 *   - what costs money is checked against the monthly limit first and logged with what it cost;
 *   - the sums in whole cents, the records the server refuses, and a quote request that marks the sub asked;
 *   - roles: a read-only role can search but not start or change bids, or spend.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Bid } from '../../src/data/ws-types';
import { bidTotals, priceFromMarkup, proposalBlocks, quoteRequest, defaultProfile, dueText } from '../../src/state/bids';
import { fakeKontract, HttpKontract, KontractError, kontractWorkspace } from '../src/kontract/client';
import { FAKE_COST } from '../src/testing/kontract';
import { forgetServiceSpend } from '../src/providers/model';
import { sysPool } from '../src/db/pool';
import { addMember, boot, connectGmail, jobs, model, newWorkspace, releaseHolds, rows, type Client } from './helpers';

describe('the client for the real engine', () => {
  let server: Server;
  let base = '';
  const seen: { method: string; url: string; headers: Record<string, unknown>; body: string }[] = [];
  let answer: (url: string) => { status: number; body: unknown; headers?: Record<string, string> } = () => ({ status: 200, body: {} });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        const a = answer(req.url!);
        res.writeHead(a.status, { 'content-type': 'application/json', ...(a.headers ?? {}) });
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

  it('sends the key and the workspace, the search as query parameters, and reads the cost header', async () => {
    answer = () => ({ status: 200, body: { results: [], total: 0, offset: 0, source: 'bulk' }, headers: { 'x-kontract-cost-micro': '0' } });
    const k = new HttpKontract(base, 'k'.repeat(40));
    const r = await k.opportunities('timmy-w1', { q: 'janitorial services', state: 'OR', servicesOnly: true, limit: 10 });
    expect(r).toEqual({ data: { results: [], total: 0, offset: 0, source: 'bulk' }, costMicro: 0 });
    expect(seen[0]).toMatchObject({ method: 'GET', headers: { authorization: `Bearer ${'k'.repeat(40)}`, 'x-workspace-id': 'timmy-w1' } });
    expect(seen[0]!.url).toBe('/api/v1/opportunities?q=janitorial+services&state=OR&servicesOnly=1&limit=10');

    answer = () => ({ status: 200, body: { results: [], source: 'google' }, headers: { 'x-kontract-cost-micro': '35000' } });
    const subs = await k.subcontractors('timmy-w1', { query: 'commercial cleaning', location: 'Portland, OR' });
    expect(subs.costMicro).toBe(35000);
    expect(seen[1]).toMatchObject({ method: 'POST', url: '/api/v1/subcontractors' });
    expect(JSON.parse(seen[1]!.body)).toEqual({ query: 'commercial cleaning', location: 'Portland, OR' });
  });

  it('turns each refusal into words for the person, and never repeats the key or Kontract’s internals', async () => {
    const k = new HttpKontract(base, 'secret-key-'.repeat(4));
    const refusal = async (status: number, body: unknown, headers?: Record<string, string>) => {
      answer = () => ({ status, body, headers });
      return k.opportunity('timmy-w1', 'abc').then(
        () => null,
        (e: KontractError) => e,
      );
    };
    const unauthorized = (await refusal(401, { error: 'Unauthorized.' }))!;
    expect(unauthorized).toBeInstanceOf(KontractError);
    expect(unauthorized.status).toBe(502);
    expect(unauthorized.message).not.toContain('secret-key');
    const busy = (await refusal(429, { error: 'Too many requests' }, { 'retry-after': '17' }))!;
    expect(busy).toMatchObject({ status: 429, retryAfter: 17, message: 'Kontract is busy for this workspace. Try again in 17 seconds.' });
    expect((await refusal(404, { error: 'No open notice with that id.' }))!).toMatchObject({ status: 404, message: 'No open notice with that id.' });
    // Words that look like markup or internals are not passed on.
    expect((await refusal(400, { error: '<html>stack trace {…}</html>' }))!.message).toBe('Kontract couldn’t do that with what was asked.');
    expect((await refusal(500, { error: 'database is locked' }))!).toMatchObject({ status: 502, message: 'Kontract had a problem with that. Try again in a moment.' });
    const down = await new HttpKontract('http://127.0.0.1:9', 'x'.repeat(40), 2000).opportunity('timmy-w1', 'abc').catch((e: KontractError) => e);
    expect(down).toMatchObject({ status: 502, message: 'Kontract couldn’t be reached just now. Try again in a moment.' });
  });

  it('names a workspace by its id alone', () => {
    expect(kontractWorkspace('W_01JQ9ZX')).toBe('timmy-w-01jq9zx');
    expect(kontractWorkspace('w'.repeat(80))).toHaveLength(64);
    expect(kontractWorkspace('abc')).toMatch(/^[a-z0-9-]{1,64}$/);
  });
});

describe('the sums and the words', () => {
  const bid = (lines: Bid['pricing']['lines'], periods = 1) => ({ pricing: { periods, periodLabel: 'year' as const, markupPct: 20, lines } });

  it('adds whole cents per period and over the contract, with the margin', () => {
    const t = bidTotals(bid([{ id: 'a', description: 'Cleaning', unit: 'month', quantity: 12, subCost: 1_000_000, price: 1_200_000 }, { id: 'b', description: 'Floors', unit: 'quarter', quantity: 4, subCost: 250_000, price: 312_550 }], 5));
    expect(t).toMatchObject({ price: 15_650_200, cost: 13_000_000, profit: 2_650_200, contractPrice: 78_251_000, contractProfit: 13_251_000 });
    expect(t.margin).toBeCloseTo(0.16934, 4);
    expect(priceFromMarkup(1_000_000, 18)).toBe(1_180_000);
    expect(priceFromMarkup(333, 15)).toBe(383);
    expect(dueText(new Date(Date.now() + 3 * 86_400_000 - 1000).toISOString(), new Date())).toBe('3 days left');
    expect(dueText(new Date(Date.now() - 86_400_000).toISOString(), new Date())).toBe('Closed');
  });
});

describe('bids on a workspace', () => {
  let w: Client;
  const state = async () => w.state();
  const bids = async () => Object.values((await state()).ws.bids) as Bid[];
  const fk = () => fakeKontract()!;
  const usage = (route: string) => rows<{ cost_usd: string; ok: boolean; model: string }>('select cost_usd, ok, model from usage_event where workspace_id = $1 and route = $2 order by id', [w.workspaceId, route]);
  const track = async (notice = 'sample-janitorial-va') => (await w.json<{ bid: { id: string; created: boolean } }>('POST', '/api/v1/bids/track', { notice })).bid;

  beforeAll(async () => {
    await boot();
  });
  beforeEach(async () => {
    model().reset();
    jobs().queue = [];
    fk().reset();
    forgetServiceSpend();
    w = await newWorkspace('Bidding Co');
  });

  it('searches open notices as this workspace’s own Kontract workspace, with only the parameters it checks', async () => {
    expect(await w.json('GET', '/api/v1/bids/status')).toEqual({ on: true, sample: true });
    const r = await w.json<{ results: { id: string; description?: string }[]; total: number }>('GET', '/api/v1/bids/search?q=janitorial&state=or&servicesOnly=1&limit=999&evil=1');
    expect(r.results.map((x) => x.id)).toEqual(['sample-janitorial-va']);
    expect(r.results[0]!.description).toBeUndefined();
    const call = fk().calls[0]!;
    expect(call.ws).toBe(kontractWorkspace(w.workspaceId));
    expect(call.ws).not.toContain('bidding');
    expect(call.body).toEqual({ q: 'janitorial', state: 'OR', servicesOnly: true, limit: 50, offset: 0 });
    // Services only leaves out the paper; federal only leaves out the city's bid.
    const all = await w.json<{ results: { id: string }[] }>('GET', '/api/v1/bids/search?servicesOnly=1&level=federal');
    expect(all.results.map((x) => x.id).sort()).toEqual(['sample-grounds-usfs', 'sample-hvac-gsa', 'sample-janitorial-va']);
    expect((await usage('kontract:opportunities')).every((u) => Number(u.cost_usd) === 0 && u.model === 'kontract')).toBe(true);
  });

  it('tracks a bid with Kontract’s own copy of the notice, puts its deadline on the to-do list, and only once', async () => {
    const made = await track();
    expect(made.created).toBe(true);
    const [bid] = await bids();
    expect(bid).toMatchObject({ id: made.id, stage: 'found', notice: { id: 'sample-janitorial-va', agency: 'Department of Veterans Affairs' }, subs: [], pricing: { lines: [], markupPct: 20 } });
    const task = (await state()).ws.tasks[bid!.task!];
    expect(task).toMatchObject({ title: 'Submit the bid: Janitorial Services, Cascade VA Medical Center', status: 'todo', priority: 'high' });
    expect(new Date(task!.due!).toISOString()).toBe(bid!.notice.responseDeadline);
    expect((await track()).created).toBe(false);
    expect(await bids()).toHaveLength(1);
    // A screen can't make one itself with a notice of its own.
    const forged = await w.cmd({ type: 'trackBid', id: 'bid-x', task: 'tsk-x', notice: { ...bid!.notice, id: 'made-up', title: 'Anything' } });
    expect(forged.ok).toBe(false);
    expect(forged.error).toBe('Track a bid from the Bids screen.');
    expect((await w.request('POST', '/api/v1/bids/track', { notice: 'no-such-notice' })).status).toBe(404);
    expect((await w.request('POST', '/api/v1/bids/track', { notice: '../etc' })).status).toBe(400);
  });

  it('reads the documents into the bid: each fact with its words, a plain-English read, and price lines to fill', async () => {
    const { id } = await track();
    const r = await w.json<{ read: { documents: number; facts: number; breakdown: string } }>('POST', `/api/v1/bids/${id}/read`, {});
    expect(r.read).toEqual({ documents: 3, facts: 6, breakdown: 'rules' });
    const bid = (await bids())[0]!;
    expect(bid.details!.budget).toMatchObject({ value: { low: 180000, high: 240000, kind: 'estimate' }, quote: 'The estimated annual value is $180,000 to $240,000.', doc: 'Statement of Work.pdf' });
    expect(bid.breakdown!.subcontractorSearchTerms).toEqual(['commercial cleaning', 'janitorial services']);
    expect(bid.pricing).toMatchObject({ periods: 5, periodLabel: 'year' });
    expect(bid.pricing.lines.map((l) => [l.description, l.quantity, l.price])).toEqual([
      ['Daily cleaning, Buildings 100 and 101', 12, 0],
      ['Floor stripping and waxing', 4, 0],
    ]);
    // Kontract was asked with the copy kept, for when the notice closes, and without Claude (which costs).
    expect(fk().calls.find((c) => c.endpoint === 'details')!.body).toMatchObject({ claude: false, opportunity: { id: 'sample-janitorial-va' } });
    // Read again after the notice closed: Kontract reads the federal notice from the kept copy.
    fk().closed.add('sample-janitorial-va');
    expect((await w.request('POST', `/api/v1/bids/${id}/read`, {})).status).toBe(200);
    expect(await usage('kontract:details')).toHaveLength(2);
  });

  it('looks up past awards like it and keeps a short summary', async () => {
    const { id } = await track();
    await w.json('POST', `/api/v1/bids/${id}/read`, {});
    const r = await w.json<{ pricing: { awards: number; medianAnnual: number } }>('POST', `/api/v1/bids/${id}/pricing`, {});
    expect(r.pricing).toEqual({ awards: 4, medianAnnual: 201000, medianTotal: 1005000 });
    const bid = (await bids())[0]!;
    expect(bid.pastPricing!.query).toMatchObject({ keywords: ['commercial cleaning', 'janitorial services'], naics: '561720', state: 'OR' });
    expect(bid.pastPricing!.recipients[0]).toMatchObject({ name: 'Northwest Building Care (sample)', awards: 2 });
  });

  it('finds local businesses for what costs money only within the monthly limit, and logs what it cost', async () => {
    const { id } = await track();
    const r = await w.json<{ results: { name: string }[]; source: string }>('POST', `/api/v1/bids/${id}/subs/search`, { query: 'commercial cleaning', location: 'Portland, OR' });
    expect(r.source).toBe('sample');
    expect(r.results.map((x) => x.name)[0]).toBe('Evergreen Commercial Cleaning (sample)');
    expect((await usage('kontract:subcontractors')).map((u) => Number(u.cost_usd))).toEqual([FAKE_COST.subcontractors / 1e6]);
    const near = await w.json<{ contractors: { name: string }[] }>('GET', `/api/v1/bids/${id}/subs/nearby`);
    expect(near.contractors.length).toBeGreaterThan(0);
    const site = await w.json<{ facts: { emails: string[] } }>('POST', '/api/v1/bids/website', { url: 'https://evergreen-clean.example' });
    expect(site.facts.emails).toEqual(['bids@evergreen-clean.example']);
    expect((await w.request('POST', '/api/v1/bids/website', { url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await w.request('POST', '/api/v1/bids/website', { url: 'http://localhost/admin' })).status).toBe(400);

    // At the limit, nothing that costs money is asked of Kontract; free calls still work.
    await sysPool.query('update workspace set monthly_spend_cap_usd = 0.000001 where id = $1', [w.workspaceId]);
    const before = fk().calls.length;
    const over = await w.request('POST', `/api/v1/bids/${id}/subs/search`, { query: 'commercial cleaning', location: 'Portland, OR' });
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: string }).error).toMatch(/monthly limit/);
    expect(fk().calls.length).toBe(before);
    expect((await w.request('GET', '/api/v1/bids/search?q=hvac')).status).toBe(200);
  });

  it('passes on Kontract asking for a pause, and says when it isn’t there', async () => {
    fk().failNext.opportunities = { status: 429, message: 'Kontract is busy for this workspace. Try again in 30 seconds.', retryAfter: 30 };
    const busy = await w.request('GET', '/api/v1/bids/search?q=hvac');
    expect(busy.status).toBe(429);
    expect(busy.headers.get('retry-after')).toBe('30');
    expect(((await busy.json()) as { error: string }).error).toBe('Kontract is busy for this workspace. Try again in 30 seconds.');
    expect((await usage('kontract:opportunities')).at(-1)!.ok).toBe(false);
  });

  it('keeps the price lines and subs a person edits, and refuses records no screen or sum could use', async () => {
    const { id } = await track();
    await w.json('POST', `/api/v1/bids/${id}/read`, {});
    const bid = (await bids())[0]!;
    const put = (item: Bid) => w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'bids', item }] });
    const priced = { ...bid, stage: 'sourcing' as const, pricing: { ...bid.pricing, lines: bid.pricing.lines.map((l) => ({ ...l, subCost: 1_000_000, price: priceFromMarkup(1_000_000, 20) })) }, subs: [{ id: 's1', name: 'Evergreen Commercial Cleaning', email: 'bids@evergreen.test', website: 'https://evergreen.test', source: 'search' as const, status: 'new' as const }] };
    expect((await put(priced)).ok).toBe(true);
    expect((await put({ ...priced, pricing: { ...priced.pricing, lines: [{ ...priced.pricing.lines[0]!, price: 10.5 }] } })).ok).toBe(false);
    expect((await put({ ...priced, stage: 'maybe' as never })).ok).toBe(false);
    expect((await put({ ...priced, pricing: { ...priced.pricing, periods: 0 } })).ok).toBe(false);
    expect((await put({ ...priced, subs: [{ ...priced.subs[0]!, email: 'not an address' }] })).ok).toBe(false);
    expect((await put({ ...priced, subs: [{ ...priced.subs[0]!, website: 'javascript:alert(1)' }] })).ok).toBe(false);
    expect((await put({ ...priced, notice: { ...priced.notice, description: 'x'.repeat(50_000) } })).ok).toBe(false);
    const profile = { ...defaultProfile('Bidding Co', 'owner@bidding.test'), uei: 'ABCDEF123456', naics: ['561720'], states: ['OR'] };
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'bidding', item: profile }] })).ok).toBe(true);
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'bidding', item: { ...profile, states: ['Oregon'] } }] })).ok).toBe(false);
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'remove', col: 'bidding', id: 'profile' }] })).ok).toBe(false);
  });

  it('a quote request sent to a sub marks them asked, keeps the email and moves the bid to sourcing; it never shows the bid’s own price', async () => {
    await connectGmail(w, 'owner@bidding.test');
    await jobs().drain();
    const { id } = await track();
    await w.json('POST', `/api/v1/bids/${id}/read`, {});
    let bid = (await bids())[0]!;
    bid = { ...bid, pricing: { ...bid.pricing, lines: bid.pricing.lines.map((l) => ({ ...l, subCost: 1_000_000, price: 1_234_567 })) }, subs: [{ id: 's1', name: 'Evergreen Commercial Cleaning', email: 'bids@evergreen.test', source: 'search', status: 'new' }] };
    await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'bids', item: bid }] });
    const mail = quoteRequest(bid, bid.subs[0]!, { companyName: 'Bidding Co', contactName: 'Ada' }, new Date());
    expect(mail.subject).toBe('Quote request: Janitorial Services, Cascade VA Medical Center');
    expect(mail.body).toContain('Can your staff pass a VA background check?');
    expect(mail.body).not.toMatch(/12,345\.67|1234567|markup/i);
    const sent = await w.cmd({ type: 'sendNew', draft: { to: ['mail:bids@evergreen.test'], subject: mail.subject, body: mail.body, bidSub: { bid: id, sub: 's1' } } });
    expect(sent.ok).toBe(true);
    await releaseHolds(w);
    const after = (await bids())[0]!;
    expect(after.subs[0]).toMatchObject({ status: 'asked' });
    expect(after.subs[0]!.thread).toBeDefined();
    // Asking a sub to price it is sourcing.
    expect(after.stage).toBe('sourcing');
    expect((await w.cmd({ type: 'sendNew', draft: { to: ['mail:x@y.test'], subject: 'Hi', body: 'Hi', bidSub: { bid: id, sub: 'nobody' } } })).ok).toBe(false);
  });

  it('the proposal page fills in what is known and leaves every other blank bracketed', async () => {
    const { id } = await track();
    await w.json('POST', `/api/v1/bids/${id}/read`, {});
    const bid = (await bids())[0]!;
    let n = 0;
    const blocks = proposalBlocks(bid, defaultProfile('Bidding Co'), () => `b${++n}`);
    const words = JSON.stringify(blocks);
    expect(words).toContain('Proposal: Janitorial Services, Cascade VA Medical Center');
    expect(words).toContain('[UEI]');
    expect(words).toContain('[similar contracts you have done: buyer, value, dates, and a reference]');
    expect(words).toContain('Cleaning staff must pass a VA background check: [how you meet it]');
  });

  it('a read-only role can search, but can’t start or change a bid, or spend', async () => {
    const { id } = await track();
    const revops = await addMember(w.workspaceId, 'revops');
    expect((await revops.request('GET', '/api/v1/bids/search?q=hvac')).status).toBe(200);
    expect((await revops.request('POST', '/api/v1/bids/track', { notice: 'sample-hvac-gsa' })).status).toBe(403);
    expect((await revops.request('POST', `/api/v1/bids/${id}/read`, {})).status).toBe(403);
    expect((await revops.request('POST', `/api/v1/bids/${id}/subs/search`, { query: 'x', location: 'y' })).status).toBe(403);
    expect((await revops.request('POST', '/api/v1/bids/website', { url: 'https://a.example' })).status).toBe(403);
  });
});
