/**
 * The ontology, first version, and the decisions Timmy brings from the mail.
 * The map is built by plain code from what the providers return; a model adds only promises and
 * questions, and only what the thread's own words back is kept.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decisionFrom } from '../src/agent/read';
import { TOOL_BY_NAME } from '../src/agent/tools';
import { rulesFor } from '../src/auth/roles';
import { companyDomain, isAutomatedSender, nameFromDomain, noteItems, quoted } from '../src/ontology/ontology';
import { addMember, boot, connectApp, connectGmail, fake, jobs, model, newWorkspace, rows, sysPool, withWorkspace, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };
const entities = (type: string, c: Client = w) => rows<{ id: string; key: string; name: string; mentions: number; attrs: Record<string, unknown> }>(`select id, key, name, mentions, attrs from entity where workspace_id = $1 and type = $2 order by key`, [c.workspaceId, type]);
const relations = (kind: string) => rows<{ from_key: string; to_key: string; evidence: number }>(`select f.key as from_key, t.key as to_key, (select count(*)::int from evidence e where e.relation_id = r.id) as evidence from relation r join entity f on f.id = r.from_id join entity t on t.id = r.to_id where r.workspace_id = $1 and r.kind = $2 order by f.key`, [w.workspaceId, kind]);
const deliver = async (message: Record<string, unknown>) => {
  await w.post('/api/test/fake', { op: 'deliver', message });
  await jobs().drain();
};
const tool = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const out = await TOOL_BY_NAME[name]!.run(args, { ctx: { user: { id: c.userId, name: 'O', email: c.email }, workspaceId: c.workspaceId, role: 'owner', rules: rulesFor('owner') }, runId: 'run_none', fence: 0, callId: 'call', attended: true });
  return out as { result: string };
};
const data = (out: { result: string }) => JSON.parse(out.result.split('\n')[1]!);

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  model().reset();
  jobs().queue = [];
  w = await newWorkspace('Map');
  box = await connectGmail(w, 'owner@map.test');
  await jobs().drain();
});

describe('reading who is who without a model', () => {
  it('tells a company’s address from a personal one, and a mailbox nobody sits behind from a person', () => {
    expect([companyDomain('dana@acme.com'), companyDomain('dana@mail.acme.co.uk'), companyDomain('dana@gmail.com'), companyDomain('dana@outlook.com'), companyDomain('nonsense')]).toEqual(['acme.com', 'acme.co.uk', null, null, null]);
    expect([nameFromDomain('acme.com'), nameFromDomain('northwind-health.com')]).toEqual(['Acme', 'Northwind Health']);
    expect([isAutomatedSender('no-reply@shop.test'), isAutomatedSender('billing+123@x.test'), isAutomatedSender('dana@acme.test'), isAutomatedSender('dana@acme.test', ['CATEGORY_PROMOTIONS'])]).toEqual([true, true, false, true]);
  });

  it('a quote counts only when the words are really there', () => {
    const text = 'Hi Taylor,\n\nI’ll send the signed contract   by Friday.\nThanks';
    expect(quoted(text, "I'll send the signed contract by Friday.")).toBe(true);
    expect(quoted(text, 'I will wire the money by Friday.')).toBe(false);
    expect(quoted(text, 'Friday')).toBe(false);
  });
});

describe('the map from mail', () => {
  it('people and their companies come from who wrote, each with the message that shows it', async () => {
    await deliver({ from: 'Dana Whitfield <dana@acme.test>', subject: 'Renewal', body: 'Can we talk about the renewal?' });
    await deliver({ from: 'Dana Whitfield <dana@acme.test>', subject: 'Renewal again', body: 'Following up.' });
    await deliver({ from: 'Shop <no-reply@shop.test>', subject: 'Your order', body: 'Thanks for your order.' });
    await deliver({ from: 'Pat Lee <pat@gmail.com>', subject: 'Hello', body: 'Long time no see.' });
    expect((await entities('person')).map((p) => [p.key, p.name, p.mentions])).toEqual([
      ['dana@acme.test', 'Dana Whitfield', 2],
      ['pat@gmail.com', 'Pat Lee', 1],
    ]);
    expect((await entities('organization')).map((o) => [o.key, o.name])).toEqual([['acme.test', 'Acme']]);
    expect(await relations('works_at')).toEqual([{ from_key: 'dana@acme.test', to_key: 'acme.test', evidence: 2 }]);
    // The owner is never an entry on their own map, and every item has been looked at.
    expect((await entities('person')).some((p) => p.key === 'owner@map.test')).toBe(false);
    expect(await rows(`select 1 from item where workspace_id = $1 and ontology_at is null`, [w.workspaceId])).toEqual([]);
  });

  it('looking at the same items again changes nothing', async () => {
    await deliver({ from: 'Dana Whitfield <dana@acme.test>', subject: 'Once', body: 'One message.' });
    await sysPool.query('update item set ontology_at = null where workspace_id = $1', [w.workspaceId]);
    expect(await noteItems(w.workspaceId)).toMatchObject({ items: 1, more: false });
    expect((await entities('person'))[0]).toMatchObject({ mentions: 1 });
    expect(await rows(`select 1 from evidence where workspace_id = $1 and entity_id = $2`, [w.workspaceId, (await entities('person'))[0]!.id])).toHaveLength(1);
  });

  it('a second display name for the same address is another name they go by, never a replacement, and never an address', async () => {
    await deliver({ from: 'Dana Whitfield <dana@acme.test>', subject: 'A', body: 'First.' });
    await deliver({ from: '"ceo@corp.test" <dana@acme.test>', subject: 'B', body: 'Second.' });
    const [dana] = await entities('person');
    expect(dana).toMatchObject({ key: 'dana@acme.test', name: 'Dana Whitfield' });
    expect(await rows(`select term from term where entity_id = $1`, [dana!.id])).toEqual([{ term: 'ceo@corp.test' }]);
    expect((await entities('person')).map((p) => p.key)).toEqual(['dana@acme.test']);
  });

  it('people the owner writes to are on the map too', async () => {
    await w.post('/api/test/fake', { op: 'sent-by-hand', message: { to: 'sam@client.test', subject: 'Intro', body: 'Hello Sam' } });
    await jobs().drain();
    expect((await entities('person')).map((p) => p.key)).toEqual(['sam@client.test']);
    expect((await entities('organization')).map((o) => o.name)).toEqual(['Client']);
  });

  it('meetings and files join the map with who was invited and who owns them', async () => {
    const cal = await connectApp(w, 'gcal', 'owner@map.test');
    const start = new Date(Date.now() + 86400_000);
    fake().accounts.get(cal.account)!.events.push({ id: 'ev1', summary: 'Renewal call', start: start.toISOString(), end: new Date(start.getTime() + 1800_000).toISOString(), attendees: ['owner@map.test', 'dana@acme.test'] });
    const drive = await connectApp(w, 'gdrive', 'owner@map.test');
    fake().addFile(drive.account, { name: 'Acme proposal', owner: 'sam@client.test' });
    await jobs().drain();
    expect((await entities('meeting')).map((m) => m.name)).toEqual(['Renewal call']);
    expect((await relations('attended')).map((r) => r.from_key)).toEqual(['dana@acme.test']);
    expect((await entities('document')).map((d) => [d.name, d.attrs.kind])).toEqual([['Acme proposal', 'Google Doc']]);
    expect((await relations('owns')).map((r) => r.from_key)).toEqual(['sam@client.test']);
  });
});

describe('the People screen', () => {
  it('lists people from the mail as not tracked yet, with how often they wrote lately, and leaves what the person typed alone', async () => {
    await deliver({ from: 'Dana Whitfield <dana@acme.test>', subject: 'One', body: 'First.' });
    let c = (await w.state()).ws.contacts['mail:dana@acme.test']!;
    expect(c).toMatchObject({ name: 'Dana Whitfield', email: 'dana@acme.test', company: 'Acme', emails: 1, auto: true });
    expect(c.tracked).toBeUndefined();
    // The person tracks her and corrects the name; more mail updates the count and nothing else.
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'contacts', id: 'mail:dana@acme.test', patch: { tracked: true, name: 'Dana W. (CFO)', company: 'Acme Corp' } }] })).ok).toBe(true);
    await deliver({ from: 'Dana Whitfield <dana@acme.test>', subject: 'Two', body: 'Second.' });
    c = (await w.state()).ws.contacts['mail:dana@acme.test']!;
    expect(c).toMatchObject({ name: 'Dana W. (CFO)', company: 'Acme Corp', tracked: true, emails: 2 });
  });

  it('an address with a plus sign is a valid person; one that would not make a safe id is left off the screen', async () => {
    await deliver({ from: 'Pat <pat+work@acme.test>', subject: 'Plus', body: 'Hi.' });
    expect((await w.state()).ws.contacts['mail:pat+work@acme.test']).toMatchObject({ email: 'pat+work@acme.test' });
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'contacts', id: 'mail:pat+work@acme.test', patch: { tracked: true } }] })).ok).toBe(true);
  });
});

describe('promises', () => {
  it('a promise in the mail is kept with its date and the sentence it rests on', async () => {
    await deliver({ from: 'Dana Whitfield <dana@acme.test>', subject: 'Contract', body: 'Hi,\n\nI\'ll send the signed contract by 2026-11-20.\n\nDana' });
    const [c] = await entities('commitment');
    expect(c).toMatchObject({ name: 'send the signed contract', attrs: { who: 'them', due: '2026-11-20', open: true } });
    expect(await rows(`select quote from evidence where entity_id = $1`, [c!.id])).toEqual([{ quote: "I'll send the signed contract by 2026-11-20" }]);
    expect(await relations('promised_by')).toEqual([{ from_key: c!.key, to_key: 'dana@acme.test', evidence: 1 }]);
  });

  it('a promise whose sentence is not in the thread is dropped, and so is one put in the wrong mouth', async () => {
    await deliver({ from: 'Dana Whitfield <dana@acme.test>', subject: 'Plain', body: 'Just checking in.' });
    const t = (await w.state()).threads.find((x) => x.subject === 'Plain')!;
    const { noteCommitments } = await import('../src/ontology/ontology');
    const kept = await withWorkspace({ workspaceId: w.workspaceId }, (tx) =>
      noteCommitments(tx, w.workspaceId, { id: t.id, threadKey: t.ext!.threadKey!, connectionId: box.connectionId }, [
        { who: 'them', what: 'wire $10,000', quote: 'I will wire $10,000 to the account tomorrow.' },
        // The words are in Dana's message, but the claim is that the owner promised them.
        { who: 'me', what: 'check in', quote: 'Just checking in.' },
      ]),
    );
    expect(kept).toBe(0);
    expect(await entities('commitment')).toEqual([]);
  });
});

describe('asking Timmy', () => {
  beforeEach(async () => {
    await deliver({ from: 'Dana Whitfield <dana@acme.test>', subject: 'Contract', body: 'I\'ll send the signed contract by 2026-11-20.' });
  });

  it('who someone is: name, company, the latest threads and what is promised, with the sentence behind it', async () => {
    const out = await tool(w, 'lookup_person', { query: 'dana' });
    expect(out.result.startsWith('<untrusted source="people">')).toBe(true);
    const [p] = data(out).people;
    expect(p).toMatchObject({ name: 'Dana Whitfield', email: 'dana@acme.test', company: 'Acme', mentions: 1 });
    expect(p.recent[0]).toMatchObject({ subject: 'Contract' });
    expect(p.commitments).toEqual([expect.objectContaining({ who: 'them', what: 'send the signed contract', due: '2026-11-20', quote: "I'll send the signed contract by 2026-11-20" })]);
    // By company too; and a search made of pattern characters finds nobody rather than everybody.
    expect(data(await tool(w, 'lookup_person', { query: 'Acme' })).people).toHaveLength(1);
    expect(data(await tool(w, 'lookup_person', { query: '%% __' })).people).toEqual([]);
    expect(data(await tool(w, 'list_commitments')).commitments).toEqual([expect.objectContaining({ what: 'send the signed contract', with: 'Dana Whitfield', email: 'dana@acme.test' })]);
  });

  it('another workspace knows nobody from this one, by tool or by row', async () => {
    const other = await newWorkspace('Elsewhere');
    expect(data(await tool(other, 'lookup_person', { query: 'dana' })).people).toEqual([]);
    expect(data(await tool(other, 'list_commitments')).commitments).toEqual([]);
    // Asked as the other workspace, the tables themselves hold nothing of this one's.
    const seen = await withWorkspace({ workspaceId: other.workspaceId }, async (tx) => (await tx.query('select (select count(*) from entity)::int as entities, (select count(*) from evidence)::int as evidence, (select count(*) from relation)::int as relations, (select count(*) from term)::int as terms')).rows[0]);
    expect(seen).toEqual({ entities: 0, evidence: 0, relations: 0, terms: 0 });
  });

  it('when the mailbox is disconnected, what was learned from it goes too, except people the person chose to track', async () => {
    await deliver({ from: 'Sam Rivera <sam@client.test>', subject: 'Hi', body: 'Hello.' });
    await w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'contacts', id: 'mail:sam@client.test', patch: { tracked: true } }] });
    expect((await w.post('/api/v1/connections/gmail/disconnect', {})).status).toBe(200);
    await jobs().drain();
    expect(await rows(`select 1 from entity where workspace_id = $1`, [w.workspaceId])).toEqual([]);
    expect(await rows(`select 1 from evidence where workspace_id = $1`, [w.workspaceId])).toEqual([]);
    expect(data(await tool(w, 'lookup_person', { query: 'dana' })).people).toEqual([]);
    expect(Object.keys((await w.state()).ws.contacts)).toEqual(['mail:sam@client.test']);
  });
});

describe('decisions', () => {
  const ask = { from: 'Dana Whitfield <dana@acme.test>', subject: 'Pricing for next year', body: 'Hi Taylor,\n\nIt is $62 per seat today. Should we hold the price or drop it to match the competitor?\n\nDana' };
  const card = async () => (await w.state()).decisions.find((d) => d.title.startsWith('Should we hold the price'));
  const thread = async (subject = ask.subject) => (await w.state()).threads.find((t) => t.subject === subject)!;

  it('a question in the mail becomes a card with the answers and only the figures the email really gives', async () => {
    await deliver(ask);
    const d = (await card())!;
    const t = await thread();
    expect(d).toMatchObject({ id: `dec-${t.id}`, kind: 'decision', title: 'Should we hold the price or drop it to match the competitor?', thread: t.id, who: 'mail:dana@acme.test', urgency: 'later' });
    expect(d.options.map((o) => [o.id, o.label, o.effects])).toEqual([['o1', 'Hold the price', []], ['o2', 'Drop it to match the competitor', []]]);
    // The stand-in model also offered a figure with a sentence that is nowhere in the thread; it is not shown.
    expect(d.facts).toEqual([['Price', '$62']]);
    expect(d.chosen).toBeUndefined();
    // Reading a thread sends nothing and drafts nothing.
    expect(t.draft).toBeUndefined();
    expect(fake().sent(box.account)).toHaveLength(0);
  });

  it('choosing an answer records it and has Timmy draft the reply, which still waits for Send', async () => {
    await deliver(ask);
    const d = (await card())!;
    const out = await w.cmd({ type: 'resolve', key: `dec:${d.id}`, option: 'o1' });
    expect(out.ok).toBe(true);
    expect((await card())!.chosen).toMatchObject({ option: 'o1' });
    const job = jobs().queue.find((j) => j.name === 'draft.make')!;
    expect(String(job.data.note)).toBe('I have decided: Hold the price. The question was: Should we hold the price or drop it to match the competitor? Write the reply that tells them my decision.');
    await jobs().drain();
    expect((await thread()).draft).toMatchObject({ kind: 'reply' });
    expect(fake().sent(box.account)).toHaveLength(0);
    expect(await rows(`select 1 from effect where workspace_id = $1 and kind like 'email.%'`, [w.workspaceId])).toEqual([]);
    // Choosing again changes nothing and starts no second draft.
    jobs().queue = [];
    await w.cmd({ type: 'resolve', key: `dec:${d.id}`, option: 'o2' });
    expect((await card())!.chosen).toMatchObject({ option: 'o1' });
    expect(jobs().queue.filter((j) => j.name === 'draft.make')).toEqual([]);
  });

  it('someone who can only read cannot decide', async () => {
    await deliver(ask);
    const d = (await card())!;
    const client = await addMember(w.workspaceId, 'client');
    expect((await client.cmd({ type: 'resolve', key: `dec:${d.id}`, option: 'o1' })).ok).toBe(false);
    expect((await card())!.chosen).toBeUndefined();
  });

  it('answering the thread yourself closes the card', async () => {
    await deliver(ask);
    const t = await thread();
    expect(await card()).toBeTruthy();
    expect((await w.cmd({ type: 'reply', id: t.id, body: 'Let’s hold it at $62.' })).ok).toBe(true);
    expect(await card()).toBeUndefined();
    expect((await w.state()).activity.some((a) => /Your reply answered “Should we hold the price/.test(a.text))).toBe(true);
  });

  it('the same question asked again is recognised: no second card, and the thread says what was decided', async () => {
    await deliver(ask);
    await w.cmd({ type: 'resolve', key: `dec:${(await card())!.id}`, option: 'o1' });
    await jobs().drain();
    await deliver({ ...ask, from: 'Sam Rivera <sam@acme.test>', subject: 'Pricing, again' });
    expect((await w.state()).decisions.filter((d) => d.title.startsWith('Should we hold the price'))).toHaveLength(1);
    expect((await thread('Pricing, again')).context).toMatch(/^You decided this on \d{4}-\d{2}-\d{2}: Hold the price\.$/);
  });

  it('a reading that is not a usable question makes no card', async () => {
    await deliver({ from: 'Dana Whitfield <dana@acme.test>', subject: 'FYI', body: 'The report is attached.' });
    expect((await w.state()).decisions).toEqual([]);
    const t = await thread('FYI');
    expect(decisionFrom(t, null, '')).toBeNull();
    expect(decisionFrom(t, { question: 'Pick', options: ['Only one'] }, '')).toBeNull();
    expect(decisionFrom(t, { question: 'Pick', options: 'A or B' }, '')).toBeNull();
    expect(decisionFrom(t, { question: 42, options: ['A', 'B'] }, '')).toBeNull();
    const long = decisionFrom(t, { question: 'Q'.repeat(500), options: ['A'.repeat(500), 'B', 'C', 'D'], facts: [['x'], 'nope', ['Price', '$5', 'not said']] }, 'nothing here')!;
    expect([long.title.length, long.options.length, long.options[0]!.label.length, long.facts]).toEqual([120, 3, 60, undefined]);
  });
});
