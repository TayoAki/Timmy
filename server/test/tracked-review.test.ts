/**
 * The review screen for what Timmy tracks, beyond its first version: accepting a kind reads recent mail for it;
 * two things that may be the same one are offered to merge and merged only by a person; and a kind that was
 * turned down or stopped can be brought back.
 *
 * Safety properties this file holds:
 *   - text from outside is information: what a model read out of mail is kept only when the thread backs it;
 *   - unattended work stays inside its budget: the look back is counted as work nobody asked for, and stops when
 *     that share of the monthly limit is used up;
 *   - no cross-workspace reads or writes: another workspace can't merge, keep apart or bring back anything here.
 *
 * The stand-in model reads lines like "Deal: company Acme Corp; value $40,000." (see providers/fake-things.ts) and
 * always invents a value for each field a line left out, and one thing whose sentence is in no thread.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TrackedOverview, TrackedThing } from '../../src/live/tracked';
import { READ_MAX_TOKENS, READ_SYSTEM } from '../src/agent/read';
import { config } from '../src/config';
import { Client, addMember, boot, connectGmail, jobs, model, newWorkspace, rows, sysPool } from './helpers';

let w: Client;
let n = 0;
const made: string[] = [];
const DAY = 86400_000;

/** An email from a person, `daysAgo` days old. Its first read is dropped unless asked for, as for mail older than the first read reaches. */
const deliver = async (body: string, opts: { daysAgo?: number; from?: string; subject?: string; threadId?: string; read?: boolean } = {}, c: Client = w) => {
  const subject = opts.subject ?? `Note ${++n}`;
  const res = await c.post('/api/test/fake', { op: 'deliver', message: { from: opts.from ?? 'Dana Whitfield <dana@acme.test>', subject, body, ...(opts.threadId ? { threadId: opts.threadId } : {}) } });
  expect(res.status).toBe(200);
  // The stored message is made as old as asked.
  if (opts.daysAgo) await sysPool.query(`update item set occurred_at = now() - make_interval(secs => $3) where workspace_id = $1 and subject = $2`, [c.workspaceId, subject, opts.daysAgo * DAY / 1000]);
  if (!opts.read) jobs().queue = jobs().queue.filter((j) => j.name !== 'mail.read');
  await jobs().drain();
  return subject;
};
const overview = (c: Client = w) => c.json<TrackedOverview>('GET', '/api/v1/tracked');
const accept = (key: string, c: Client = w) => c.post(`/api/v1/tracked/proposals/${encodeURIComponent(key)}/accept`, {});
const kindId = async (name: string, c: Client = w) => (await overview(c)).tracked.find((t) => t.name === name)!.id;
const thingsOf = async (id: string, c: Client = w) => (await c.json<{ things: TrackedThing[] }>('GET', `/api/v1/tracked/${id}/things`)).things;
const entities = (c: Client = w) => rows<{ id: string; name: string; attrs: Record<string, string>; mentions: number }>(`select id, name, attrs, mentions from entity where workspace_id = $1 and type = 'thing' order by name`, [c.workspaceId]);
const evidence = (entityId: string) => rows<{ quote: string; fields: Record<string, string>; subject: string }>(`select e.quote, e.fields, i.subject from evidence e join item i on i.id = e.item_id where e.entity_id = $1 order by i.occurred_at, e.id`, [entityId]);
const rereads = () => model().requests.filter((r) => r.route === 'reread');
const deal = (company: string, value = '$40,000') => `Deal: company ${company}; value ${value}; stage negotiation.`;

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  model().reset();
  jobs().queue = [];
  w = await newWorkspace('Trade');
  made.push(w.workspaceId);
  await connectGmail(w, `owner${++n}@trade.test`);
  await jobs().drain();
});
afterAll(async () => {
  await sysPool.query(`update connection set status = 'disconnected', disconnected_at = now() where workspace_id = any($1::text[]) and status = 'active'`, [made]);
});

/* ───────────── Reading recent mail on accept ───────────── */

describe('accepting a kind reads recent mail for it', () => {
  it('once, newest first, only threads a person wrote in the last 30 days, at most the set number, as unattended work with the same read', async () => {
    for (const [i, company] of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].entries()) await deliver(`Hi Taylor,\n\n${deal(company)}\n\nDana`, { daysAgo: i + 1, subject: `About ${company}` });
    await deliver(deal('Old Co'), { daysAgo: 40, subject: 'Too old' });
    await deliver(deal('Bulk Co'), { daysAgo: 1, subject: 'Our newsletter', from: 'News <noreply@bulk.test>' });
    expect(model().requests).toEqual([]);
    const kept = config.kindReread.threads;
    config.kindReread.threads = 3;
    try {
      expect((await accept('deal')).status).toBe(200);
      // Said at once on the screen, before the job has run.
      expect((await overview()).tracked[0]!.reread).toEqual({ status: 'reading', threads: 0, found: 0, days: 30 });
      await jobs().drain();
    } finally {
      config.kindReread.threads = kept;
    }
    // Three reads: the three newest threads a person wrote. Not the one from 40 days ago, not the newsletter.
    const asked = rereads();
    expect(asked).toHaveLength(3);
    expect(model().requests.every((r) => r.route === 'reread')).toBe(true);
    const subjects = asked.map((r) => /"subject":"([^"]+)"/.exec(r.messages.at(-1)!.content)![1]);
    expect(subjects).toEqual(['About Alpha', 'About Bravo', 'About Charlie']);
    for (const r of asked) {
      // The first read's own prompt and limits, told about this one kind only, as outside content.
      expect(r).toMatchObject({ unattended: true, maxTokens: READ_MAX_TOKENS, effort: 'low' });
      expect(r.messages[0]!.content).toBe(READ_SYSTEM);
      expect(r.messages[1]!.content).toContain('<untrusted source="types">\n- Deal: company, value, stage, close date\n</untrusted>');
      expect(r.messages[1]!.content).not.toContain('Lead');
      expect(r.messages[1]!.content).toContain('<untrusted source="mail">');
    }
    expect(await rows(`select count(*)::int as n from usage_event where workspace_id = $1 and route = 'reread' and unattended`, [w.workspaceId])).toEqual([{ n: 3 }]);

    // What was found is held to the threads' own words: no invented close date, no thing named after a subject line.
    const found = await entities();
    expect(found.map((e) => [e.name, e.attrs])).toEqual([
      ['Alpha', { company: 'Alpha', value: '$40,000', stage: 'negotiation' }],
      ['Bravo', { company: 'Bravo', value: '$40,000', stage: 'negotiation' }],
      ['Charlie', { company: 'Charlie', value: '$40,000', stage: 'negotiation' }],
    ]);
    expect(await evidence(found[0]!.id)).toEqual([{ quote: deal('Alpha'), fields: { company: 'Alpha', value: '$40,000', stage: 'negotiation' }, subject: 'About Alpha' }]);
    expect((await overview()).tracked[0]).toMatchObject({ known: 3, reread: { status: 'done', threads: 3, found: 3, days: 30 } });

    // Run again, it reads only threads that still show nothing of the kind.
    model().reset();
    await jobs().enqueue('tracking.reread', { workspaceId: w.workspaceId, typeId: await kindId('Deal') });
    await jobs().drain();
    expect(rereads().map((r) => /"subject":"([^"]+)"/.exec(r.messages.at(-1)!.content)![1])).toEqual(['About Delta', 'About Echo']);
    expect((await entities()).map((e) => e.name)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);
  });

  it('mail that arrives after the accept is left to the ordinary read, and a thread already showing the kind is not read again', async () => {
    // Read before the accept, as a proposal: counted, then adopted when accepted.
    await deliver(deal('Counted'), { daysAgo: 2, read: true });
    model().reset();
    expect((await accept('deal')).status).toBe(200);
    await deliver(deal('Later'), { read: true });
    // The ordinary read of the new mail, with the kind in it; the look back found nothing it had not seen.
    expect(model().requests.map((r) => r.route)).toEqual(['read']);
    expect((await entities()).map((e) => e.name)).toEqual(['Counted', 'Later']);
    expect((await overview()).tracked[0]!.reread).toEqual({ status: 'done', threads: 0, found: 0, days: 30 });
  });

  it('only things of the accepted kind, backed by the thread, are kept; the rest of the answer changes nothing', async () => {
    await deliver(`${deal('Acme Corp')}\nShould we sign now or wait?`, { daysAgo: 3, subject: 'Acme renewal' });
    // Leads are tracked too, so a lead in the answer would be kept by an ordinary read; here it is not asked for.
    await accept('lead');
    await jobs().drain();
    model().reset();
    const before = (await w.state()).threads.find((t) => t.subject === 'Acme renewal')!;
    model().script.push({
      content: JSON.stringify({
        box: 'archived',
        confidence: 'high',
        effort: 'quick',
        ask: 'Archive this.',
        reason: 'x',
        due: null,
        commitments: [{ who: 'them', what: 'pay', due: null, quote: 'Should we sign now or wait?' }],
        decision: { question: 'Sign now or wait?', options: ['Sign now', 'Wait'], facts: [], same_as: null },
        things: [
          { kind: 'Deal', fields: { company: 'Acme Corp', value: '$999,999', stage: 'negotiation' }, quote: deal('Acme Corp') },
          { kind: 'Lead', fields: { name: 'Acme Corp' }, quote: deal('Acme Corp') },
          { kind: 'Deal', fields: { company: 'Ghost Inc' }, quote: 'A sentence nobody wrote.' },
        ],
        new_kinds: [{ kind: 'Contract', name: 'Acme Corp', fields: [], quote: deal('Acme Corp') }],
      }),
    });
    await accept('deal');
    await jobs().drain();
    expect(rereads()).toHaveLength(1);
    // The deal, without the value the thread never gave; no lead, no ghost, no sighting of a new kind.
    expect((await entities()).map((e) => [e.name, e.attrs])).toEqual([['Acme Corp', { company: 'Acme Corp', stage: 'negotiation' }]]);
    expect(await rows(`select 1 from type_sighting where workspace_id = $1`, [w.workspaceId])).toEqual([]);
    // The thread is as it was: not moved, no decision card, no promise noted.
    const after = (await w.state()).threads.find((t) => t.id === before.id)!;
    expect([after.box, after.ask, after.suggestion]).toEqual([before.box, before.ask, before.suggestion]);
    expect((await w.state()).decisions).toEqual([]);
    expect(await rows(`select 1 from entity where workspace_id = $1 and type = 'commitment'`, [w.workspaceId])).toEqual([]);
  });

  it('stops as soon as the share of the monthly limit kept for unattended work is used up, and says so', async () => {
    for (const company of ['One', 'Two']) await deliver(deal(company), { daysAgo: 2 });
    // The unattended share (half of $50 by default) is spent.
    await sysPool.query(`insert into usage_event (workspace_id, route, model, cost_usd, unattended) values ($1, 'read', 'm', 26, true)`, [w.workspaceId]);
    expect((await accept('deal')).status).toBe(200);
    await jobs().drain();
    expect(model().requests).toEqual([]);
    expect((await overview()).tracked[0]!.reread).toEqual({ status: 'stopped', threads: 0, found: 0, days: 30, note: 'Timmy stopped early: the part of this month’s limit kept for reading mail on its own is used up.' });
    expect(await entities()).toEqual([]);
  });

  it('a kind stopped before the pass runs is not read for', async () => {
    await deliver(deal('Never'), { daysAgo: 2 });
    expect((await accept('deal')).status).toBe(200);
    const id = await kindId('Deal');
    expect((await w.request('DELETE', `/api/v1/tracked/${id}`)).status).toBe(200);
    await jobs().drain();
    expect(model().requests).toEqual([]);
    expect(await entities()).toEqual([]);
  });
});

/* ───────────── The same thing under two names ───────────── */

describe('“same thing?”', () => {
  beforeEach(async () => {
    expect((await accept('deal')).status).toBe(200);
    await jobs().drain();
  });
  const offers = async (c: Client = w) => (await overview(c)).sameThing ?? [];

  it('two things of one kind, one name’s words inside the other’s, are offered; nothing is merged on its own', async () => {
    await deliver(deal('Acme', '$10,000'), { read: true, subject: 'First' });
    await deliver(deal('Acme Corp', '$12,000'), { read: true, subject: 'Second' });
    await deliver(deal('Globex'), { read: true });
    await deliver(deal('Acme Industries'), { read: true });
    const kind = await kindId('Deal');
    const names = Object.fromEntries((await entities()).map((e) => [e.name, e.id]));
    expect(await offers()).toEqual([
      { kind: { id: kind, name: 'Deal' }, a: { id: names.Acme, name: 'Acme' }, b: { id: names['Acme Industries'], name: 'Acme Industries' } },
      { kind: { id: kind, name: 'Deal' }, a: { id: names.Acme, name: 'Acme' }, b: { id: names['Acme Corp'], name: 'Acme Corp' } },
    ]);
    // More mail about either changes nothing about that: they stay two things.
    await deliver(deal('Acme', '$11,000'), { read: true });
    expect((await entities()).map((e) => e.name)).toEqual(['Acme', 'Acme Corp', 'Acme Industries', 'Globex']);
  });

  it('an owner merges them: every sentence moves to the kept thing, and later mail under the merged name adds to it', async () => {
    await deliver(deal('Acme', '$10,000'), { read: true, subject: 'First' });
    await deliver(deal('Acme Corp', '$12,000'), { read: true, subject: 'Second' });
    const kind = await kindId('Deal');
    const [acme, corp] = await entities();
    const res = await w.post(`/api/v1/tracked/${kind}/merge`, { keep: corp!.id, merge: acme!.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, moved: 1 });
    const [only, ...rest] = await entities();
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ id: corp!.id, name: 'Acme Corp', mentions: 2, attrs: { company: 'Acme Corp', value: '$12,000', stage: 'negotiation' } });
    expect((await evidence(corp!.id)).map((e) => [e.subject, e.quote])).toEqual([['First', deal('Acme', '$10,000')], ['Second', deal('Acme Corp', '$12,000')]]);
    expect((await thingsOf(kind)).map((t) => t.sources.length)).toEqual([2]);
    expect(await offers()).toEqual([]);
    expect(await rows(`select actor, detail from audit_log where workspace_id = $1 and action = 'tracking.merged'`, [w.workspaceId])).toEqual([{ actor: w.userId, detail: { kind: 'deal', kept: 'Acme Corp', merged: 'Acme' } }]);
    // An email that calls it "Acme" now adds to Acme Corp.
    await deliver('Deal: company Acme; stage won.', { read: true, subject: 'Third' });
    expect((await entities()).map((e) => [e.name, e.attrs.stage, e.mentions])).toEqual([['Acme Corp', 'won', 3]]);
  });

  it('when both rest on the same email, that email keeps both sentences and both sets of values', async () => {
    const first = deal('Acme', '$10,000');
    const second = 'Deal: company Acme Corp; stage signed.';
    await deliver(`${first}\n${second}`, { read: true, subject: 'Both' });
    const kind = await kindId('Deal');
    const names = Object.fromEntries((await entities()).map((e) => [e.name, e.id]));
    expect((await w.post(`/api/v1/tracked/${kind}/merge`, { keep: names['Acme Corp'], merge: names.Acme })).status).toBe(200);
    const [kept] = await evidence(names['Acme Corp']!);
    expect(kept!.quote.split('\n').sort()).toEqual([first, second].sort());
    // The kept thing's own values win where both gave one; the other's fill the gaps.
    expect(kept!.fields).toEqual({ company: 'Acme Corp', value: '$10,000', stage: 'signed' });
    expect((await entities()).map((e) => e.mentions)).toEqual([1]);
  });

  it('saying they differ stops the offer for good, and both stay', async () => {
    await deliver(deal('Acme'), { read: true });
    await deliver(deal('Acme Corp'), { read: true });
    const kind = await kindId('Deal');
    const [acme, corp] = await entities();
    expect((await w.post(`/api/v1/tracked/${kind}/apart`, { a: corp!.id, b: acme!.id })).status).toBe(200);
    expect(await offers()).toEqual([]);
    await deliver(deal('Acme', '$1'), { read: true });
    expect(await offers()).toEqual([]);
    expect((await entities()).map((e) => e.name)).toEqual(['Acme', 'Acme Corp']);
  });

  it('only an owner or admin may merge or keep apart, only things of that kind, and another workspace can do nothing here', async () => {
    await deliver(deal('Acme'), { read: true });
    await deliver(deal('Acme Corp'), { read: true });
    await deliver('Lead: name Acme Corp; company Acme Corp.', { read: true });
    const kind = await kindId('Deal');
    const [acme, corp] = await entities();
    const member = await addMember(w.workspaceId, 'member', 'Mia Member');
    for (const path of ['merge', 'apart']) {
      const res = await member.post(`/api/v1/tracked/${kind}/${path}`, { keep: corp!.id, merge: acme!.id, a: corp!.id, b: acme!.id });
      expect([path, res.status]).toEqual([path, 403]);
    }
    const admin = await addMember(w.workspaceId, 'admin', 'Ada Admin');
    // Not the same thing twice, not something that isn't a thing of this kind, not nothing.
    for (const body of [{ keep: corp!.id, merge: corp!.id }, { keep: corp!.id, merge: 'ent_nope' }, { keep: corp!.id }, { keep: corp!.id, merge: [acme!.id] }]) expect((await admin.post(`/api/v1/tracked/${kind}/merge`, body)).status).toBe(404);
    const other = await newWorkspace('Elsewhere');
    made.push(other.workspaceId);
    expect((await other.post(`/api/v1/tracked/${kind}/merge`, { keep: corp!.id, merge: acme!.id })).status).toBe(404);
    expect((await other.post(`/api/v1/tracked/${kind}/apart`, { a: corp!.id, b: acme!.id })).status).toBe(404);
    expect((await overview(other)).sameThing).toBeUndefined();
    expect((await entities()).map((e) => e.name)).toEqual(['Acme', 'Acme Corp']);
    // The admin can.
    expect((await admin.post(`/api/v1/tracked/${kind}/merge`, { keep: corp!.id, merge: acme!.id })).status).toBe(200);
    expect((await entities()).map((e) => e.name)).toEqual(['Acme Corp']);
  });
});

/* ───────────── Bringing a kind back ───────────── */

describe('bringing back a kind that was turned down or stopped', () => {
  const bringBack = (key: string, c: Client = w) => c.post(`/api/v1/tracked/proposals/${encodeURIComponent(key)}/bring-back`);

  it('a dismissed suggestion is listed, and an owner or admin can bring it back as a suggestion', async () => {
    expect((await w.post('/api/v1/tracked/proposals/lead/dismiss')).status).toBe(200);
    expect((await overview()).turnedDown).toEqual([{ key: 'lead', name: 'Lead', stopped: false }]);
    const member = await addMember(w.workspaceId, 'member', 'Mia Member');
    expect((await bringBack('lead', member)).status).toBe(403);
    const other = await newWorkspace('Elsewhere');
    made.push(other.workspaceId);
    expect((await bringBack('lead', other)).status).toBe(404);
    expect((await bringBack('lead')).status).toBe(200);
    const after = await overview();
    expect(after.turnedDown).toBeUndefined();
    expect(after.proposals.map((p) => [p.key, p.why])).toEqual([['deal', 'trade'], ['lead', 'trade']]);
    expect(await rows(`select actor, detail from audit_log where workspace_id = $1 and action = 'tracking.brought-back'`, [w.workspaceId])).toEqual([{ actor: w.userId, detail: { kind: 'lead', wasTracked: false } }]);
    // Nothing is read for it until someone accepts it.
    await deliver('Lead: name Sam Rivera; company Globex.', { read: true });
    expect(await entities()).toEqual([]);
  });

  it('a stopped kind comes back as a suggestion; accepted again, it reads recent mail again', async () => {
    await deliver(deal('Acme'), { daysAgo: 3 });
    expect((await accept('deal')).status).toBe(200);
    await jobs().drain();
    expect((await entities()).map((e) => e.name)).toEqual(['Acme']);
    expect((await w.request('DELETE', `/api/v1/tracked/${await kindId('Deal')}`)).status).toBe(200);
    expect(await entities()).toEqual([]);
    expect((await overview()).turnedDown).toEqual([{ key: 'deal', name: 'Deal', stopped: true }]);
    expect((await bringBack('deal')).status).toBe(200);
    expect((await overview()).proposals.map((p) => p.key)).toEqual(['deal', 'lead']);
    // Stopping forgot what it knew; bringing it back alone learns nothing.
    expect(await entities()).toEqual([]);
    model().reset();
    expect((await accept('deal')).status).toBe(200);
    await jobs().drain();
    expect(rereads()).toHaveLength(1);
    expect((await entities()).map((e) => e.name)).toEqual(['Acme']);
  });

  it('a kind Timmy noticed comes back with the fields it was offered with, and accepting it reads the mail it was noticed in', async () => {
    const property = (n2: number) => `Property: address ${n2} Oak Street; price $450,000; status viewing.`;
    for (const n2 of [12, 14, 16]) await deliver(property(n2), { read: true });
    expect((await w.post('/api/v1/tracked/proposals/property/dismiss')).status).toBe(200);
    expect((await overview()).turnedDown).toEqual([{ key: 'property', name: 'Property', stopped: false }]);
    expect((await bringBack('property')).status).toBe(200);
    const offered = (await overview()).proposals.find((p) => p.key === 'property')!;
    expect(offered).toMatchObject({ name: 'Property', why: 'seen', threads: 0 });
    expect(offered.fields.map((f) => f.label)).toEqual(['address', 'price', 'status']);
    model().reset();
    expect((await accept('property')).status).toBe(200);
    await jobs().drain();
    expect(rereads()).toHaveLength(3);
    expect((await entities()).map((e) => [e.name, e.attrs.price])).toEqual([['12 Oak Street', '$450,000'], ['14 Oak Street', '$450,000'], ['16 Oak Street', '$450,000']]);
  });

  it('only something that was turned down can be brought back', async () => {
    expect((await bringBack('deal')).status).toBe(404);
    expect((await bringBack('no such kind')).status).toBe(404);
    expect((await accept('deal')).status).toBe(200);
    expect((await bringBack('deal')).status).toBe(404);
  });
});
