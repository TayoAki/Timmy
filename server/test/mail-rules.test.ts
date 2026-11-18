/**
 * Sorting rules a person writes (src/state/mail-rules.ts, src/sync/mail-rules.ts), and putting an email in a project
 * by hand. A rule is applied by plain code exactly as written. One that files mail away files new mail in the mailbox
 * too, through a policy row that names who saved it, and only mail that arrived after it; what is already waiting is
 * only suggested. "Always show it to me" outranks the automatic sort and Timmy's own read.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Thread } from '../../src/data/types';
import type { Project } from '../../src/data/ws-types';
import { checkMailRule, ruleMatches } from '../../src/state/mail-rules';
import type { EffectRow } from '../src/gateway/gateway';
import { addMember, boot, connectGmail, fake, jobs, model, newWorkspace, rows, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };

const writes = () => fake().calls.filter((c) => c.connectedAccountId === box.account && c.slug === 'GMAIL_MODIFY_THREAD_LABELS');
const filings = () => rows<EffectRow>(`select * from effect where workspace_id = $1 and kind = 'mail.modify' order by created_at, id`, [w.workspaceId]);
const policies = () => rows<{ id: string; scope: Record<string, unknown>; enabled: boolean; created_by: string }>(`select id, scope, enabled, created_by from policy where workspace_id = $1 and scope ? 'mailRule' order by created_at, id`, [w.workspaceId]);
const deliver = async (m: { from: string; subject: string; body?: string; labels?: string[]; at?: Date }) => {
  const d = fake().deliver(box.account, { body: 'Hello there.', ...m });
  await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
  await jobs().drain();
  return (await w.state()).threads.find((t) => t.subject === m.subject)!;
};
const thread = async (subject: string) => (await w.state()).threads.find((t) => t.subject === subject)!;
const addRule = (mail: Record<string, unknown>, c: Client = w, text = '') => c.cmd({ type: 'addRule', group: 'triage', text, mail });
const rule = async (id?: string) => {
  const rules = (await w.state()).rules.filter((r) => r.mail);
  return id ? rules.find((r) => r.id === id)! : rules[rules.length - 1]!;
};
const project = async (name: string): Promise<Project> => {
  const p: Project = { id: name.toLowerCase().replace(/\W+/g, '-'), num: String(10 + Math.floor(Math.random() * 80)), name, color: 'var(--c-sky)', status: 'active', folder: `f02-${name}`, sources: [] };
  const r = await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'projects', item: p }] });
  expect(r.ok).toBe(true);
  return p;
};

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  model().reset();
  jobs().queue = [];
  w = await newWorkspace('Rules');
  box = await connectGmail(w, 'owner@rules.test');
  await jobs().drain();
});

describe('a rule as written', () => {
  it('is kept in one form: domains and addresses tidied, anything else refused', () => {
    const ok = checkMailRule({ when: { from: ['LinkedIn.com', ' Dana@Acme.test ', 'anyone at shop.test', 'linkedin.com'], subject: [' Invoice ', 'invoice'] }, then: { box: 'archived' } }, {});
    expect(ok).toEqual({ rule: { when: { from: ['@linkedin.com', 'dana@acme.test', '@shop.test'], subject: ['invoice'] }, then: { box: 'archived' } } });
    expect(checkMailRule({ when: { from: ['not an address'] }, then: { box: 'archived' } }, {})).toEqual({ problem: '“not an address” isn’t an email address or a domain.' });
    expect('problem' in checkMailRule({ when: {}, then: { box: 'archived' } }, {})).toBe(true);
    expect('problem' in checkMailRule({ when: { from: ['a.test'] }, then: {} }, {})).toBe(true);
    expect('problem' in checkMailRule({ when: { from: ['a.test'] }, then: { box: 'deleted' } }, {})).toBe(true);
    expect('problem' in checkMailRule({ when: { from: ['a.test'] }, then: { project: 'gone' } }, {})).toBe(true);
    // Nothing besides the listed fields survives.
    expect(checkMailRule({ when: { from: ['a.test'], sql: 'x' }, then: { box: 'archived', send: true } }, {})).toEqual({ rule: { when: { from: ['@a.test'] }, then: { box: 'archived' } } });
  });

  it('matches whole words, a domain with its subdomains, and the newest email someone else sent', () => {
    const t = (from: string, subject: string, body = 'Hi', mine = false): Thread => ({
      id: 't',
      subject,
      ask: '',
      box: 'inbox',
      participants: [],
      messages: [{ id: 'm1', from, to: ['me'], at: new Date(), body: [body] }, ...(mine ? [{ id: 'm2', from: 'me', to: [from], at: new Date(), body: ['Thanks'] }] : [])],
    } as unknown as Thread);
    const linkedin = { when: { from: ['@linkedin.com'] }, then: { box: 'archived' as const } };
    expect(ruleMatches(linkedin, t('mail:jobs@linkedin.com', 'x'))).toBe(true);
    expect(ruleMatches(linkedin, t('mail:news@e.linkedin.com', 'x'))).toBe(true);
    expect(ruleMatches(linkedin, t('mail:me@notlinkedin.com', 'x'))).toBe(false);
    // The person's own reply after it doesn't change who the mail is from.
    expect(ruleMatches(linkedin, t('mail:jobs@linkedin.com', 'x', 'Hi', true))).toBe(true);
    const pay = { when: { subject: ['pay'] }, then: { box: 'read-through' as const } };
    expect(ruleMatches(pay, t('mail:a@b.test', 'Pay run done'))).toBe(true);
    expect(ruleMatches(pay, t('mail:a@b.test', 'Payroll is ready'))).toBe(false);
    const words = { when: { from: ['@b.test'], words: ['webinar'] }, then: { box: 'read-through' as const } };
    expect(ruleMatches(words, t('mail:a@b.test', 'Next week', 'Join our Webinar.'))).toBe(true);
    // Every condition given has to hold.
    expect(ruleMatches(words, t('mail:a@c.test', 'Next week', 'Join our webinar.'))).toBe(false);
  });
});

describe('saving a rule', () => {
  it('only an owner or admin may, it is stored as checked, and one that files mail away is backed by a rule naming them', async () => {
    const member = await addMember(w.workspaceId, 'member', 'Mo Member');
    expect((await addRule({ when: { from: ['linkedin.com'] }, then: { box: 'archived' } }, member)).ok).toBe(false);
    const bad = await addRule({ when: { from: ['nonsense'] }, then: { box: 'archived' } });
    expect(bad).toMatchObject({ ok: false, error: '“nonsense” isn’t an email address or a domain.' });
    expect((await addRule({ when: { from: ['LinkedIn.com'], extra: 1 }, then: { box: 'archived' } })).ok).toBe(true);
    const r = await rule();
    expect(r).toMatchObject({ group: 'triage', enabled: true, hits: 0, text: 'Mail from anyone at linkedin.com: archive it.', mail: { when: { from: ['@linkedin.com'] }, then: { box: 'archived' } } });
    expect(await policies()).toEqual([{ id: expect.any(String), scope: { mailRule: r.id }, enabled: true, created_by: w.userId }]);
    // "Show it to me" files nothing, so it needs no such rule.
    expect((await addRule({ when: { from: ['dana@acme.test'] }, then: { box: 'follow-up' } })).ok).toBe(true);
    expect(await policies()).toHaveLength(1);
    // Off, on again (mail from then on), deleted: the policy row follows.
    expect((await member.cmd({ type: 'toggleRule', id: r.id })).ok).toBe(false);
    await w.cmd({ type: 'toggleRule', id: r.id });
    expect((await policies()).map((p) => p.enabled)).toEqual([false]);
    await w.cmd({ type: 'toggleRule', id: r.id });
    expect((await policies()).map((p) => p.enabled)).toEqual([false, true]);
    expect((await member.cmd({ type: 'removeRule', id: r.id })).ok).toBe(false);
    await w.cmd({ type: 'removeRule', id: r.id });
    expect((await policies()).map((p) => p.enabled)).toEqual([false, false]);
    expect((await w.state()).rules.some((x) => x.id === r.id)).toBe(false);
  });

  it('what is already waiting gets the rule as Timmy’s sure suggestion, and nothing is filed in the mailbox', async () => {
    const t = await deliver({ from: 'LinkedIn <news@linkedin.test>', subject: 'You appeared in 5 searches' });
    expect(t.suggestion).toMatchObject({ box: 'archived', confidence: 'medium' });
    expect((await addRule({ when: { from: ['linkedin.test'] }, then: { box: 'archived' } })).ok).toBe(true);
    const id = (await rule()).id;
    expect(await thread('You appeared in 5 searches')).toMatchObject({ box: 'inbox', suggestion: { box: 'archived', confidence: 'high', rule: id, reason: 'Your rule: Mail from anyone at linkedin.test: archive it.' } });
    expect(writes()).toHaveLength(0);
    expect(await filings()).toHaveLength(0);
  });
});

describe('new mail', () => {
  it('a rule that archives files new mail in Timmy and in the mailbox, and mail older than the rule inside Timmy only', async () => {
    await addRule({ when: { from: ['linkedin.test'] }, then: { box: 'archived' } });
    const id = (await rule()).id;
    const fresh = await deliver({ from: 'LinkedIn <jobs@linkedin.test>', subject: 'New jobs for you' });
    expect(fresh).toMatchObject({ box: 'archived' });
    expect(fresh.history!.at(-1)!.text).toBe('Timmy filed this to the archive, as your rule says: Mail from anyone at linkedin.test: archive it.');
    const [filing] = await filings();
    expect(filing).toMatchObject({ status: 'completed', source: 'rule', approved_via: 'rule' });
    expect(filing!.approved_by).toBe(`rule:${(await policies())[0]!.id}`);
    expect(writes()).toHaveLength(1);
    // Mail that arrived before the rule was made (here, a day before) is filed inside Timmy, and not in Gmail.
    const old = await deliver({ from: 'LinkedIn <jobs@linkedin.test>', subject: 'Last week’s jobs', at: new Date(Date.now() - 86_400_000) });
    expect(old).toMatchObject({ box: 'archived' });
    expect(writes()).toHaveLength(1);
    expect((await rule(id)).hits).toBe(2);
    // A person who doesn't match is left alone.
    expect(await deliver({ from: 'Dana <dana@acme.test>', subject: 'Contract' })).toMatchObject({ box: 'inbox' });
  });

  it('“always show it to me” keeps mail in Triage over the automatic sort and over Timmy’s read', async () => {
    expect((await w.request('PATCH', '/api/v1/settings', { autoSort: true })).status).toBe(200);
    await addRule({ when: { from: ['shop.test'] }, then: { box: 'follow-up' } });
    const keep = await deliver({ from: 'Shop <deals@shop.test>', subject: 'Your order is ready to collect', labels: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'] });
    expect(keep).toMatchObject({ box: 'inbox', suggestion: { box: 'follow-up', confidence: 'high' } });
    expect(writes()).toHaveLength(0);
    // Without the rule the same mail is filed away by the automatic sort.
    expect(await deliver({ from: 'Brand <deals@brand.test>', subject: 'Autumn sale', labels: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'] })).toMatchObject({ box: 'archived' });

    // Timmy still reads mail a person wrote under such a rule, for what it asks, but the rule keeps its place.
    await addRule({ when: { from: ['dana@acme.test'] }, then: { box: 'follow-up' } });
    const id = (await rule()).id;
    model().script.push({ content: JSON.stringify({ box: 'archived', confidence: 'high', effort: 'quick', ask: 'Dana says thanks.', reason: 'A thank-you.', due: null, commitments: [], decision: null, todos: [], things: [], new_kinds: [] }) });
    const read = await deliver({ from: 'Dana Whitfield <dana@acme.test>', subject: 'Thanks!' });
    expect(model().requests.filter((r) => r.route === 'read')).toHaveLength(1);
    expect(read).toMatchObject({ box: 'inbox', ask: 'Dana says thanks.', suggestion: { box: 'follow-up', confidence: 'high', rule: id } });
    expect(read.suggestion!.provisional).toBeUndefined();
  });

  it('a rule that archives needs no read by the model', async () => {
    await addRule({ when: { from: ['dana@acme.test'] }, then: { box: 'archived' } });
    await deliver({ from: 'Dana Whitfield <dana@acme.test>', subject: 'FYI', body: 'Could you look at the contract before Friday?' });
    expect(model().requests.filter((r) => r.route === 'read')).toHaveLength(0);
  });

  it('a rule with a project puts new mail, and what it asks, in the project; mail already in one stays put', async () => {
    const acme = await project('Acme website');
    const other = await project('Other');
    const before = await deliver({ from: 'Dana <dana@acme.test>', subject: 'Earlier', body: 'Please send the brief by 2026-12-01.' });
    expect((await w.cmd({ type: 'setProject', id: before.id, project: other.id })).ok).toBe(true);
    const r = await addRule({ when: { from: ['acme.test'] }, then: { project: acme.id } });
    // Mail already here that is in no project goes in now; mail in another project stays where the person put it.
    expect((await thread('Earlier')).project).toBe(other.id);
    expect(r.ok).toBe(true);
    const t = await deliver({ from: 'Sam <sam@acme.test>', subject: 'Homepage copy', body: 'Please review the homepage copy by 2026-12-02.' });
    expect(t).toMatchObject({ project: acme.id, box: 'inbox' });
    const todo = Object.values((await w.state()).ws.tasks).find((x) => x.thread === t.id && x.title.startsWith('Review the homepage copy'));
    expect(todo?.project).toBe(acme.id);
  });
});

describe('putting an email in a project by hand', () => {
  it('moves it with its to-dos, can take it out again, writes nothing to the mailbox, and refuses a project that isn’t open', async () => {
    const acme = await project('Acme');
    const t = await deliver({ from: 'Dana <dana@acme.test>', subject: 'Brief', body: 'Please send the signed brief by 2026-12-01.' });
    const todo = async () => Object.values((await w.state()).ws.tasks).find((x) => x.thread === t.id);
    expect((await todo())!.project).toBeUndefined();
    const r = await w.cmd({ type: 'setProject', id: t.id, project: acme.id });
    expect(r.ok).toBe(true);
    expect((await thread('Brief')).project).toBe(acme.id);
    expect((await todo())!.project).toBe(acme.id);
    expect(writes()).toHaveLength(0);
    await w.cmd({ type: 'setProject', id: t.id, project: null });
    expect((await thread('Brief')).project).toBeUndefined();
    expect((await todo())!.project).toBeUndefined();
    expect((await w.cmd({ type: 'setProject', id: t.id, project: 'nope' })).ok).toBe(false);
    const viewer = await addMember(w.workspaceId, 'revops', 'Ray Ops');
    expect((await viewer.cmd({ type: 'setProject', id: t.id, project: acme.id })).ok).toBe(false);
  });
});

describe('rules written in plain words', () => {
  it('the ones the person added go with each email Timmy reads, outside the mail; the ones every workspace starts with don’t', async () => {
    await w.cmd({ type: 'addRule', group: 'triage', text: 'Mail about webinars goes to Read Through.' });
    await deliver({ from: 'Dana <dana@acme.test>', subject: 'Question', body: 'Could you look at this?' });
    const [read] = model().requests.filter((r) => r.route === 'read');
    const content = read!.messages[1]!.content;
    expect(content).toContain("The user's own sorting rules:\n- Mail about webinars goes to Read Through.");
    expect(content.indexOf('Mail about webinars')).toBeLessThan(content.indexOf('<untrusted source="mail">'));
    expect(content).not.toContain('If a reply takes about two minutes');
  });
});

describe('learning from how the person files mail', () => {
  const learned = async () => Object.values((await w.state()).ws.learned).filter((r) => r.mail);
  const move = (id: string, box: string) => w.cmd({ type: 'move', id, box });

  it('after the person files the same sender’s mail the same way twice, Timmy offers it as a rule', async () => {
    const a = await deliver({ from: 'Medium <noreply@medium.test>', subject: 'Daily digest 1' });
    const b = await deliver({ from: 'Medium Daily <digest@medium.test>', subject: 'Daily digest 2' });
    await move(a.id, 'archived');
    expect(await learned()).toHaveLength(0);
    await move(b.id, 'archived');
    const [offer] = await learned();
    expect(offer).toMatchObject({ group: 'triage', text: 'Mail from anyone at medium.test: archive it.', evidence: 'You moved 2 emails from anyone at medium.test to the archive yourself.', mail: { when: { from: ['@medium.test'] }, then: { box: 'archived' } }, dismissKey: 'learn:@medium.test:archived' });
    // Accepting saves it as a sorting rule, exactly as offered.
    await w.cmd({ type: 'addRule', group: 'triage', text: '', mail: offer!.mail });
    expect((await rule()).text).toBe('Mail from anyone at medium.test: archive it.');
    // With the rule in place, filing more of their mail offers nothing new.
    await w.cmd({ type: 'ws', ops: [{ op: 'remove', col: 'learned', id: offer!.id }] });
    const c = await deliver({ from: 'Medium <noreply@medium.test>', subject: 'Daily digest 3', at: new Date(Date.now() - 86_400_000 * 2) });
    if (c.box === 'inbox') await move(c.id, 'archived');
    expect(await learned()).toHaveLength(0);
  });

  it('a declined offer doesn’t come back, and Timmy’s own filing or a move to Waiting doesn’t count', async () => {
    const ids = [];
    for (const n of [1, 2, 3]) ids.push((await deliver({ from: `Lee <lee${n}@northwind.test>`, subject: `Renewal ${n}` })).id);
    await move(ids[0]!, 'waiting');
    await move(ids[1]!, 'waiting');
    expect(await learned()).toHaveLength(0);
    await move(ids[0]!, 'inbox');
    await move(ids[0]!, 'read-through');
    await move(ids[2]!, 'read-through');
    const [offer] = await learned();
    expect(offer!.mail).toEqual({ when: { from: ['@northwind.test'] }, then: { box: 'read-through' } });
    await w.cmd({ type: 'dismiss', key: offer!.dismissKey });
    await w.cmd({ type: 'ws', ops: [{ op: 'remove', col: 'learned', id: offer!.id }] });
    await move(ids[1]!, 'inbox');
    await move(ids[1]!, 'read-through');
    expect(await learned()).toHaveLength(0);
  });

  it('a colleague, or someone writing from a free mail service, is offered by address, not for everyone there', async () => {
    for (const n of [1, 2]) await move((await deliver({ from: 'Jo <jo.designs@gmail.com>', subject: `Sketches ${n}` })).id, 'read-through');
    expect((await learned())[0]!.mail!.when.from).toEqual(['jo.designs@gmail.com']);
  });
});
