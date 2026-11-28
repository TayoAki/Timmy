/**
 * Leads through Treg (server/src/treg/client.ts, treg/leads.ts, http/leads.ts, agent/lead-tools.ts):
 *   - the client for the real Treg, against a local server: the token, the workspace tag, the cost cap, the
 *     idempotency key, the cost and call-id headers, and each refusal in the person's words: a workspace's own
 *     limits are said, the team account's never are, and neither the token nor a balance is repeated;
 *   - suggesting leads: companies like the ideal customer, the right person at each, an email found and checked in
 *     the same call and kept only when it takes mail; why each fits and where each detail came from; a first line
 *     kept only when the company's description states it; no company twice; a daily limit; the monthly limit
 *     checked before any lookup; every lookup logged with its cost; nobody contacted;
 *   - the offer from a website, its proof kept only when the page has it; a sequence written by the model, with a
 *     step that makes up a figure or uses a merge field Timmy doesn't fill replaced by Timmy's own;
 *   - Ask's suggest_leads, only in a conversation and only while Treg is set up; roles.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Lead, Offer } from '../../src/data/outbound-types';
import { startRun } from '../src/agent/loop';
import { ASK_SYSTEM } from '../src/agent/prompts';
import { rulesFor } from '../src/auth/roles';
import { config } from '../src/config';
import { sysPool } from '../src/db/pool';
import { forgetServiceSpend } from '../src/providers/model';
import { FAKE_TREG_COST } from '../src/testing/treg';
import { fakeTreg, HttpTreg, setTregForTests, treg, TregError, tregMeta } from '../src/treg/client';
import { openerHolds, readAsk, stepHolds, SUGGESTED_LIST } from '../src/treg/leads';
import { addMember, boot, jobs, model, newWorkspace, rows, type Client } from './helpers';

const OFFER: Offer = {
  name: 'Chair Reminders',
  product: 'Text reminders that cut no-shows for dental practices',
  audience: 'Dental practices with 5 to 50 staff',
  pain: 'patients miss appointments and chairs sit empty',
  hook: 'no-shows',
  outcome: 'fewer missed appointments',
  proof: 'Harbor Dental cut missed appointments by 30% in three months.',
  cta: 'Open to a 15-minute demo next week?',
  icp: { titles: ['Practice Manager'], industries: ['Dental'], minEmployees: 5, maxEmployees: 120 },
};

describe('the client for the real Treg', () => {
  let server: Server;
  let base = '';
  const seen: { url: string; headers: Record<string, unknown>; body: string }[] = [];
  let answer: () => { status: number; body: unknown; headers?: Record<string, string> } = () => ({ status: 200, body: { output: {} } });
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ url: req.url!, headers: req.headers, body });
        const a = answer();
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
  const call = (k: HttpTreg) => k.call<{ email: string | null }>({ route: 'treg.people.email.find', body: { domain: 'a.example', first_name: 'Ada', last_name: 'Byron' }, meta: 'workspace=timmy-w1,feature=lead-suggest', idempotencyKey: 'k1', maxCostUsd: 0.25, headers: { 'x-treg-route-verify': 'true' } });

  it('sends the token, the workspace tag, the cost cap and an idempotency key, and reads the cost and call id', async () => {
    answer = () => ({ status: 200, body: { output: { email: 'ada.byron@a.example' }, _treg: { served_by: 'prov', verification: { verdict: 'valid' } } }, headers: { 'x-treg-cost-micro': '950', 'x-treg-call-id': 'call_1', 'x-treg-served-by': 'prov' } });
    const r = await call(new HttpTreg(base, 'tok_secret'));
    expect(seen[0]!.url).toBe('/call/treg.people.email.find');
    expect(seen[0]!.headers).toMatchObject({ 'x-treg-token': 'tok_secret', 'x-treg-meta': 'workspace=timmy-w1,feature=lead-suggest', 'x-treg-route-max-cost': '0.2500', 'idempotency-key': 'k1', 'x-treg-route-verify': 'true' });
    expect(JSON.parse(seen[0]!.body)).toEqual({ domain: 'a.example', first_name: 'Ada', last_name: 'Byron' });
    expect(r).toMatchObject({ costMicro: 950, callId: 'call_1', servedBy: 'prov', answer: { output: { email: 'ada.byron@a.example' } } });
  });

  it('says a workspace’s own limits, never the team account’s, and never repeats the token or a balance', async () => {
    const k = new HttpTreg(base, 'tok_secret');
    const refusal = async (status: number, body: unknown, headers: Record<string, string> = { 'x-treg-error': '1' }) => {
      answer = () => ({ status, body, headers });
      return call(k).then(
        () => null,
        (e: TregError) => e,
      );
    };
    const team = (await refusal(402, { error: 'insufficient_balance', balance_micro: 120, topup_url: 'https://treg.to/topup' }))!;
    expect(team).toMatchObject({ status: 503, message: 'Finding leads is paused for this server just now. The people who run Timmy have been told.' });
    expect(team.message).not.toMatch(/balance|topup|120/);
    expect((await refusal(429, { error: 'platform_daily_cap_reached' }))!.status).toBe(503);
    expect((await refusal(429, { error: 'tag_spend_cap_reached', dim: 'workspace', spent_micro: 5, cap_micro: 5 }))!).toMatchObject({ status: 429, message: 'This workspace has used today’s allowance for finding leads. It starts again tomorrow.' });
    expect((await refusal(403, { error: 'tag_blocked' }))!.message).toBe('Finding leads is switched off for this workspace.');
    expect((await refusal(402, { error: 'route_max_cost', max_cost_micro: 1, estimated_cost_micro: 9 }))!.status).toBe(402);
    expect((await refusal(429, { error: 'provider_rate_limited', retry_after_s: 12 }, { 'x-treg-error': '1', 'retry-after': '12' }))!).toMatchObject({ status: 429, retryAfter: 12 });
    expect((await refusal(502, { error: 'route_failed', tried: [] }))!.message).toBe('No data provider could answer just now. Try again in a moment.');
    const unauthorized = (await refusal(401, { detail: 'bad token tok_secret' }, {}))!;
    expect(unauthorized.status).toBe(502);
    expect(unauthorized.message).not.toContain('tok_secret');
    const down = await call(new HttpTreg('http://127.0.0.1:9', 't', 2000)).catch((e: TregError) => e);
    expect(down).toMatchObject({ status: 502 });
  });

  it('tags a workspace by its id alone, in the characters Treg allows', () => {
    expect(tregMeta('W_01JQ9ZX', 'lead-suggest')).toBe('workspace=timmy-w_01jq9zx,feature=lead-suggest');
    expect(tregMeta('a b@c', 'ask')).toBe('workspace=timmy-a-b-c,feature=ask');
  });
});

describe('the checks on what the model writes', () => {
  it('keeps a first line only when the company’s description states it', () => {
    const about = 'Cedar Dental Studio is a dental practices business in Portland with 3 locations.';
    expect(openerHolds('Running 3 locations in Portland keeps a front desk busy.', about, 'Cedar Dental Studio')).toBe(true);
    expect(openerHolds('Congrats on growing Cedar Dental Studio by 40% this year.', about, 'Cedar Dental Studio')).toBe(false);
    expect(openerHolds('Saw your new office in Seattle.', about, 'Cedar Dental Studio')).toBe(false);
    expect(openerHolds('See https://cedar.example for more.', about, 'Cedar Dental Studio')).toBe(false);
  });

  it('keeps a step only with known merge fields, no made-up figure, and no link in the first email', () => {
    expect(stepHolds({ channel: 'email', subject: '{{offerHook}} at {{companyName}}', body: 'Hi {{firstName}}, {{offerProof}} {{offerCta}}' }, OFFER, true)).toBe(true);
    expect(stepHolds({ channel: 'email', subject: 'Re: {{companyName}}', body: 'Hi {{firstName}}, we cut no-shows by 45% for practices like yours.' }, OFFER, false)).toBe(false);
    expect(stepHolds({ channel: 'email', subject: 'Re: hi', body: 'Hi {{firstName}}, 30% fewer no-shows at Harbor Dental, from our proof.' }, OFFER, false)).toBe(true);
    expect(stepHolds({ channel: 'email', subject: 'Hi', body: 'Hi {{firstName}}, your {{revenue}} could grow.' }, OFFER, false)).toBe(false);
    expect(stepHolds({ channel: 'email', subject: 'Hi', body: 'Hi {{firstName}}, see https://x.example for a demo of it all.' }, OFFER, true)).toBe(false);
    expect(readAsk('find 15 dental practices in Austin')).toEqual({ count: 15, words: 'dental practices in Austin' });
  });
});

describe('leads on a workspace', () => {
  let w: Client;
  const ft = () => fakeTreg()!;
  const leads = async () => Object.values((await w.state()).out.leads) as Lead[];
  const suggested = async () => (await leads()).filter((l) => l.list === SUGGESTED_LIST);
  const usage = () => rows<{ route: string; cost_usd: string; generation_id: string | null; provider: string }>(`select route, cost_usd, generation_id, provider from usage_event where workspace_id = $1 and model = 'treg' order by id`, [w.workspaceId]);
  const setOffer = (offer: Offer = OFFER) => w.cmd({ type: 'out', op: { op: 'offer', offer } });
  const perDay = config.treg.leadsPerDay;

  beforeAll(async () => {
    await boot();
  });
  beforeEach(async () => {
    model().reset();
    jobs().queue = [];
    ft().reset();
    forgetServiceSpend();
    config.treg.leadsPerDay = perDay;
    w = await newWorkspace('Chair Reminders Co');
  });
  afterAll(() => {
    config.treg.leadsPerDay = perDay;
  });

  it('suggests people at companies that fit the offer, each with a checked email, and contacts nobody', async () => {
    expect((await setOffer()).ok).toBe(true);
    expect(await w.json('GET', '/api/v1/leads/status')).toEqual({ on: true, sample: true, today: 0, left: 25, perDay: 25 });
    const r = await w.json<{ added: number; skipped: Record<string, number>; left: number }>('POST', '/api/v1/leads/suggest', { ask: 'dental practices in Portland', count: 12 });
    // One company had nobody with the title, one no findable address, and one an address that couldn't be confirmed.
    expect(r).toEqual({ added: 12, skipped: { known: 0, noPerson: 1, noEmail: 1, unconfirmed: 1 }, left: 13 });
    const list = await suggested();
    expect(list).toHaveLength(12);
    const lead = list.find((l) => l.company === 'Cedar Dental Studio')!;
    expect(lead).toMatchObject({ source: 'found', status: 'new', title: 'Practice Manager', website: 'cedar-dental-studio.example', industry: 'Dental Practices', city: 'Portland, OR, US' });
    expect(lead.email).toMatch(/^[a-z]+\.[a-z]+@cedar-dental-studio\.example$/);
    expect(lead.suggested!.why).toEqual(expect.arrayContaining(['Practice Manager', 'Dental Practices']));
    expect(lead.suggested!.sources.map((s) => s.field)).toEqual(['company', 'person', 'email']);
    expect(lead.suggested!.sources[2]!.from).toBe('Treg (sample), checked: takes mail');
    expect(list.some((l) => /granite|northgate|maple/.test(l.email))).toBe(false);
    expect((await w.state()).out.lists[SUGGESTED_LIST]).toMatchObject({ name: 'Suggested by Timmy' });
    // Nobody was written to.
    expect((await w.state()).out.messages).toHaveLength(0);

    // Every call carried this workspace's tag, and the email lookups asked for the check.
    expect(new Set(ft().calls.map((c) => c.meta))).toEqual(new Set([`workspace=${`timmy-${w.workspaceId.toLowerCase()}`},feature=lead-suggest`]));
    expect(ft().calls.filter((c) => c.route === 'treg.people.email.find').every((c) => c.headers?.['x-treg-route-verify'] === 'true' && c.headers?.['x-treg-route-domain-match'] === 'strict')).toBe(true);
    // And each is in the usage log with what it cost and Treg's id for it.
    const used = await usage();
    expect(used.filter((u) => u.route === 'treg:companies.search').map((u) => Number(u.cost_usd))).toEqual([FAKE_TREG_COST['treg.companies.search']! / 1e6]);
    expect(used.every((u) => u.generation_id?.startsWith('fake-call-'))).toBe(true);
    expect(used.filter((u) => u.route === 'treg:people.email.find' && Number(u.cost_usd) === 0)).toHaveLength(1);
  });

  it('writes a first line from each company’s description, and drops one that adds a figure', async () => {
    await setOffer();
    await w.json('POST', '/api/v1/leads/suggest', { ask: 'dental practices in Portland', count: 3 });
    const [a, b, c] = await suggested();
    expect(a!.opener).toMatch(/^Running \d locations in Portland keeps a front desk busy\.$/);
    expect(b!.opener).toBeUndefined();
    expect(c!.opener).toMatch(/^Running/);
    expect(model().requests.at(-1)!.messages[1]!.content).toMatch(/<untrusted source="companies">/);
  });

  it('never suggests a company twice, stops at the daily limit, and checks the monthly limit before any lookup', async () => {
    await setOffer();
    config.treg.leadsPerDay = 15;
    expect((await w.json<{ added: number }>('POST', '/api/v1/leads/suggest', { ask: 'dental practices in Portland', count: 10 })).added).toBe(10);
    const again = await w.json<{ added: number; skipped: { known: number }; left: number }>('POST', '/api/v1/leads/suggest', { ask: 'dental practices in Portland', count: 10 });
    expect(again.skipped.known).toBeGreaterThan(0);
    expect(again.added).toBe(5);
    expect(again.left).toBe(0);
    const emails = (await suggested()).map((l) => l.email);
    expect(new Set(emails).size).toBe(emails.length);
    const full = await w.request('POST', '/api/v1/leads/suggest', { ask: 'dental' });
    expect(full.status).toBe(429);
    expect(((await full.json()) as { error: string }).error).toBe('Timmy has suggested 15 leads today, this workspace’s daily limit. More tomorrow.');

    config.treg.leadsPerDay = 25;
    await sysPool.query('update workspace set monthly_spend_cap_usd = 0.000001 where id = $1', [w.workspaceId]);
    const before = ft().calls.length;
    const over = await w.request('POST', '/api/v1/leads/suggest', { ask: 'dental' });
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: string }).error).toMatch(/monthly limit/);
    expect(ft().calls.length).toBe(before);
  });

  it('says what Treg refused about the workspace, keeps the team’s account to itself, and needs something to look for', async () => {
    expect((await w.request('POST', '/api/v1/leads/suggest', {})).status).toBe(400);
    await setOffer();
    ft().failNext['treg.companies.search'] = { status: 429, body: { error: 'tag_spend_cap_reached', dim: 'workspace' } };
    const capped = await w.request('POST', '/api/v1/leads/suggest', { ask: 'dental' });
    expect(capped.status).toBe(429);
    expect(((await capped.json()) as { error: string }).error).toBe('This workspace has used today’s allowance for finding leads. It starts again tomorrow.');
    ft().failNext['treg.companies.search'] = { status: 402, body: { error: 'insufficient_balance', balance_micro: 3, topup_url: 'https://treg.to/topup' } };
    const paused = await w.request('POST', '/api/v1/leads/suggest', { ask: 'dental' });
    expect(paused.status).toBe(503);
    expect(JSON.stringify(await paused.json())).not.toMatch(/balance|topup/);
  });

  it('fills in the offer from the business’s website, with the proof only when the page has it', async () => {
    const r = await w.json<{ offer: Offer; proofFound: boolean }>('POST', '/api/v1/outbound/offer-draft', { website: 'brightreminders.example' });
    expect(r.proofFound).toBe(true);
    expect(r.offer.proof).toBe('Clinics that switched to Brightreminders cut missed appointments by 30% in three months.');
    expect(r.offer.icp).toEqual({ titles: ['Practice Manager', 'Owner'], industries: ['Dental'], minEmployees: 5, maxEmployees: 50 });
    // Not saved: the person checks it first.
    expect((await w.state()).out.offer.name).not.toBe(r.offer.name);
    const none = await w.json<{ offer: Offer; proofFound: boolean }>('POST', '/api/v1/outbound/offer-draft', { website: 'https://brightreminders.example/no-proof' });
    expect(none).toMatchObject({ proofFound: false, offer: { proof: '' } });
    expect(ft().calls.find((c) => c.route === 'treg.web.extract')!.meta).toMatch(/feature=offer-draft$/);
    for (const bad of ['javascript:alert(1)', 'http://localhost/admin', 'http://10.0.0.1/', 'not a site']) expect((await w.request('POST', '/api/v1/outbound/offer-draft', { website: bad })).status).toBe(400);
  });

  it('writes a sequence with the model, replacing a step that makes up a figure or a merge field', async () => {
    expect((await w.request('POST', '/api/v1/outbound/sequence', {})).status).toBe(400);
    await setOffer();
    const r = await w.json<{ steps: { channel: string; wait: number; variants: { subject: string; body: string }[] }[]; written: number; replaced: number }>('POST', '/api/v1/outbound/sequence', { call: true });
    expect(r.steps.map((s) => s.channel)).toEqual(['email', 'email', 'call', 'email', 'email']);
    expect(r).toMatchObject({ written: 3, replaced: 2 });
    expect(r.steps[0]!.variants[0]!.body.startsWith('{{opener}}')).toBe(true);
    expect(r.steps[0]!.wait).toBe(0);
    const all = JSON.stringify(r.steps);
    expect(all).not.toContain('45%');
    expect(all).not.toContain('{{revenue}}');
  });

  it('Ask suggests leads in a conversation someone is having, and only while Treg is set up', async () => {
    await setOffer();
    const ask = (attended: boolean) => startRun({ user: { id: w.userId, name: 'Owner', email: w.email }, workspaceId: w.workspaceId, role: 'owner', rules: rulesFor('owner') }, { kind: attended ? 'ask' : 'routine', attended, system: ASK_SYSTEM, messages: [{ role: 'user', content: 'Find me 3 leads' }], threadId: 'chat-leads' });
    const toolSays = async (attended: boolean) => {
      let said = '';
      model().script.push({ toolCalls: [{ name: 'suggest_leads', arguments: { ask: 'dental practices in Portland', count: 3 } }] });
      // The fake answers every model call in turn: finding leads makes one of its own, for their first lines.
      if (attended)
        model().script.push((req) => {
          expect(req.route).toBe('opener');
          return { content: '{"lines":[]}' };
        });
      model().script.push((req) => {
        said = String(req.messages.at(-1)!.content);
        return { content: 'Done.' };
      });
      await ask(attended);
      return said;
    };
    expect(await toolSays(false)).toBe('Leads can only be found in a conversation with the user. Nothing was searched.');
    const said = await toolSays(true);
    expect(said).toMatch(/^<untrusted source="suggested-leads">/);
    expect(said).toContain('"added":3');
    expect(said).toContain('Nobody was contacted.');
    const engine = treg();
    setTregForTests(null);
    try {
      let names: string[] = [];
      model().script.push((req) => {
        names = (req.tools ?? []).map((t) => t.name);
        return { content: 'Hi.' };
      });
      await ask(true);
      expect(names).not.toContain('suggest_leads');
      expect((await w.json<{ on: boolean }>('GET', '/api/v1/leads/status')).on).toBe(false);
      expect((await w.request('POST', '/api/v1/leads/suggest', { ask: 'dental' })).status).toBe(503);
    } finally {
      setTregForTests(engine);
    }
  });

  it('a read-only role can see the status, but can’t look up, draft or write', async () => {
    await setOffer();
    const revops = await addMember(w.workspaceId, 'revops');
    expect((await revops.request('GET', '/api/v1/leads/status')).status).toBe(200);
    expect((await revops.request('POST', '/api/v1/leads/suggest', { ask: 'dental' })).status).toBe(403);
    expect((await revops.request('POST', '/api/v1/outbound/offer-draft', { website: 'a.example' })).status).toBe(403);
    expect((await revops.request('POST', '/api/v1/outbound/sequence', {})).status).toBe(403);
    expect(ft().calls).toHaveLength(0);
  });
});
