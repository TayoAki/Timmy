/**
 * The automation engine's known gaps, closed (see STATUS.md, "Known gaps to close in phase 1"):
 *   1. the editor's Test run is the server's dry run, with sample data or a chosen recent email;
 *   2. Draft then Send is one card in Approvals, and deciding it settles the draft too;
 *   3. a member sees who an automation's card waits for, not buttons they may not press;
 *   4. with no mailbox, New-email automations are paused and fire nothing, and carry on when one is connected;
 *   5. automation runs count against the workspace's limit on work at once, and wait their turn;
 *   6. a page saved from a copy made before “Add to a doc” added a line keeps the line;
 *   7. an automation switches off when the owner or admin who switched it on loses that role or leaves.
 *
 * Each keeps the safety properties: nothing is sent without a person, nothing runs twice, nothing crosses workspaces.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keepTimmyLines } from '../src/automations/doc-lines';
import { NO_MAILBOX } from '../src/automations/mailbox';
import { runAutomation } from '../src/automations/runner';
import type { EffectRow } from '../src/gateway/gateway';
import type { FakeMessage } from '../src/providers/composio';
import { setModelForTests, type ModelProvider } from '../src/providers/model';
import { MAX_BLOCKS } from '../src/state/ws-check';
import { mayDecideCard, openApprovals } from '../../src/state/approvals';
import { timmyAdditions } from '../../src/areas/docs/editor/timmy-lines';
import type { Block } from '../../src/data/ws-types';
import type { State } from '../../src/state/store';
import { addMember, authPool, boot, connectApp, connectGmail, fake, jobs, model, newWorkspace, releaseHolds, rows, sysPool, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };

/* ───────────── Drawing an automation (as in automations.test.ts) ───────────── */

type Node = { id: string; kind: string; x: number; y: number; config: Record<string, string> };
type Edge = { id: string; from: string; to: string; branch?: 'yes' | 'no' };
const node = (id: string, kind: string, config: Record<string, string> = {}): Node => ({ id, kind, x: 0, y: 0, config });
const edge = (from: string, to: string, branch?: 'yes' | 'no'): Edge => ({ id: `${from}-${to}`, from, to, ...(branch ? { branch } : {}) });
const chain = (...nodes: Node[]) => ({ nodes, edges: nodes.slice(1).map((n, i) => edge(nodes[i]!.id, n.id)) });
const automation = (id: string, graph: { nodes: Node[]; edges: Edge[] }, extra: Record<string, unknown> = {}) => ({ id, name: `Automation ${id}`, description: '', on: false, ...graph, updated: new Date(), ...extra });

const EMAIL = node('t', 'email');
const TASK = node('task', 'task', { title: 'Follow up with {{name}}', due: 'Tomorrow' });
const DRAFT = node('draft', 'draft', { message: 'Hi {{name}}, thanks for writing.', tone: 'Brief' });
const SEND = node('send', 'send', { when: 'Right away' });
const ASK = node('ask', 'approve', { note: 'Check “{{subject}}” first' });
const WAIT = node('wait', 'wait', { for: '5 minutes' });

const save = (c: Client, a: Record<string, unknown>) => c.cmd({ type: 'ws', ops: [{ op: 'put', col: 'automations', item: a }] });
const patch = (c: Client, id: string, change: Record<string, unknown>) => c.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'automations', id, patch: change }] });
async function live(id: string, graph: { nodes: Node[]; edges: Edge[] }, c: Client = w) {
  expect((await save(c, automation(id, graph))).ok).toBe(true);
  const on = await patch(c, id, { on: true });
  expect(on.error).toBeUndefined();
  expect(on.ok).toBe(true);
}

/* ───────────── What happened ───────────── */

interface RunView {
  id: string;
  status: string;
  error: string | null;
  steps: { id: string; kind: string; status: string; text: string }[];
}
const runsOf = async (id: string, c: Client = w) => (await c.json<{ runs: RunView[] }>('GET', `/api/v1/automations/${id}/runs`)).runs;
const post = async (webhook: { headers: Record<string, string>; body: string }) => (await boot()).request('/api/hooks/composio', { method: 'POST', headers: webhook.headers, body: webhook.body });
async function deliver(subject: string, more: Partial<FakeMessage> = {}, account = box.account) {
  const d = fake().deliver(account, { from: 'Jamie Lee <jamie@brightwave.co>', subject, body: 'Hi, could you send pricing for 40 seats?', ...more });
  expect((await post(d.webhook)).status).toBe(200);
  await jobs().drain();
  return d.message;
}
const sent = () => fake().sent(box.account);
const effects = (c: Client = w) => rows<EffectRow>('select * from effect where workspace_id = $1 order by created_at, id', [c.workspaceId]);
const auditActions = async (c: Client = w) => (await rows<{ action: string }>('select action from audit_log where workspace_id = $1 order by id', [c.workspaceId])).map((a) => a.action);
const liveRow = async (id: string, c: Client = w) => (await rows<{ enabled: boolean; enabled_by: string; paused_reason: string | null; off_reason: string | null }>('select * from automation_live where workspace_id = $1 and automation_id = $2', [c.workspaceId, id]))[0];
const decide = (c: Client, effectId: string, verb: 'approve' | 'decline') => c.post(`/api/v1/actions/${effectId}/${verb}`);
const tasks = async (c: Client = w) => Object.values((await c.state()).ws.tasks);
async function tick(c: Client = w) {
  await sysPool.query(`update automation_run set wake_at = now() - interval '1 second' where workspace_id = $1 and wake_at is not null`, [c.workspaceId]);
  await jobs().enqueue('automation.sweep', {});
  await jobs().drain();
}
/** The person signed in, as the Approvals screen knows them. */
const viewer = (c: Client, can: { policy: boolean; approveSends: boolean }) => ({ user: { id: c.userId }, can });
const AS_MEMBER = { policy: false, approveSends: true };
const AS_OWNER = { policy: true, approveSends: true };

const made: string[] = [];
async function workspace(name: string): Promise<Client> {
  const c = await newWorkspace(name);
  made.push(c.workspaceId);
  return c;
}

beforeAll(async () => {
  await boot();
});
afterEach(async () => {
  await sysPool.query(`update automation_live set enabled = false, next_fire_at = null where workspace_id = any($1::text[])`, [made]);
  await sysPool.query(`update connection set status = 'disconnected', disconnected_at = now() where workspace_id = any($1::text[]) and status = 'active'`, [made]);
  await sysPool.query(`update run set status = 'completed' where workspace_id = any($1::text[]) and status = 'running'`, [made]);
  made.length = 0;
  jobs().queue = [];
});
beforeEach(async () => {
  model().reset();
  jobs().queue = [];
  w = await workspace('Gaps');
  box = await connectGmail(w, 'owner@gaps.test');
  await jobs().drain();
});

/* ───────────── 1. Test run ───────────── */

describe('the editor’s Test run, on the server', () => {
  type DryRun = { source: string; fields: Record<string, string>; steps: { id: string; kind: string; text: string; wouldAsk?: { kind: string; title: string; to?: string[]; subject?: string } }[]; skipped: string[]; problems: string[] };

  it('lists the recent emails to pick from, newest first, and only this workspace’s', async () => {
    await deliver('Older one', { from: 'Dana Whitfield <dana@acme.test>', at: new Date(Date.now() - 60_000) });
    await deliver('Newer one');
    const out = await w.json<{ emails: { id: string; from: string; subject: string; at: string }[] }>('GET', '/api/v1/automations/test-emails');
    expect(out.emails.map((e) => [e.from, e.subject])).toEqual([
      ['Jamie Lee <jamie@brightwave.co>', 'Newer one'],
      ['Dana Whitfield <dana@acme.test>', 'Older one'],
    ]);
    // Who sent it and the subject: nothing of the message itself.
    expect(Object.keys(out.emails[0]!).sort()).toEqual(['at', 'from', 'id', 'subject']);

    const other = await workspace('Elsewhere');
    expect((await other.json<{ emails: unknown[] }>('GET', '/api/v1/automations/test-emails')).emails).toEqual([]);
    // Someone whose role can't work here gets nothing.
    expect((await (await addMember(w.workspaceId, 'client')).get('/api/v1/automations/test-emails')).status).toBe(403);
    expect((await (await addMember(w.workspaceId, 'revops')).get('/api/v1/automations/test-emails')).status).toBe(403);
  });

  it('runs the drawing as it is on the canvas with a chosen email: it shows what would be put forward, and writes nothing and asks no model', async () => {
    // Saved with one step; the canvas has more that aren't saved yet.
    await save(w, automation('a1', chain(EMAIL, TASK)));
    await deliver('Pricing for the Berlin office', { from: 'Dana Whitfield <dana@acme.test>' });
    const [email] = (await w.json<{ emails: { id: string }[] }>('GET', '/api/v1/automations/test-emails')).emails;
    await jobs().drain();
    const before = { rev: (await w.state()).rev, model: model().requests.length, calls: fake().calls.length, audit: (await auditActions()).length };

    const canvas = chain(EMAIL, TASK, ASK, DRAFT, SEND);
    const out = await w.json<DryRun>('POST', '/api/v1/automations/a1/test', { eventId: email!.id, graph: canvas });
    expect(out).toMatchObject({ source: 'email', skipped: [], problems: [] });
    expect(out.fields).toMatchObject({ name: 'Dana Whitfield', email: 'dana@acme.test', subject: 'Pricing for the Berlin office' });
    expect(out.steps.map((s) => s.kind)).toEqual(['email', 'task', 'approve', 'draft', 'send']);
    expect(out.steps[1]!.text).toBe('Task “Follow up with Dana Whitfield”, due tomorrow');
    expect(out.steps[2]!.wouldAsk).toMatchObject({ kind: 'automation.ask', title: '“Automation a1” is asking before it carries on' });
    expect(out.steps[4]!.wouldAsk).toMatchObject({ kind: 'email.reply', to: ['dana@acme.test'], subject: 'Re: Pricing for the Berlin office' });

    // Nothing was done: no state change, no record, no run, no frozen version, no model, no provider, no audit line.
    await jobs().drain();
    await tick();
    const s = await w.state();
    expect(s.rev).toBe(before.rev);
    expect([Object.keys(s.ws.tasks), s.pending, s.threads.filter((t) => t.draft)]).toEqual([[], [], []]);
    expect(s.ws.automations.a1!.nodes.map((n) => n.kind)).toEqual(['email', 'task']);
    expect(await effects()).toEqual([]);
    expect(await rows('select id from automation_run where workspace_id = $1', [w.workspaceId])).toEqual([]);
    expect(await rows('select id from automation_version where workspace_id = $1', [w.workspaceId])).toEqual([]);
    expect(model().requests.length).toBe(before.model);
    expect(fake().calls.length).toBe(before.calls);
    expect((await auditActions()).length).toBe(before.audit);
    expect(sent()).toEqual([]);
  });

  it('says what would stop it being switched on, and checks the canvas like a save', async () => {
    await save(w, automation('a1', chain(EMAIL, TASK)));
    const blocked = await w.json<DryRun>('POST', '/api/v1/automations/a1/test', { sample: true, graph: chain(EMAIL, SEND) });
    expect(blocked.problems).toEqual(['“Send the email” needs a “Draft a reply” step before it, so there is something to send.']);
    // Without a mailbox, a New-email automation can't be switched on, and the test run says so.
    await w.post('/api/v1/connections/gmail/disconnect', {});
    await jobs().drain();
    expect((await w.json<DryRun>('POST', '/api/v1/automations/a1/test', { sample: true })).problems).toEqual(['“New email” needs a mailbox. Connect Gmail or Outlook in Connections first.']);

    // A canvas that isn't an automation is refused like a save would be.
    for (const graph of ['nope', { nodes: 'x', edges: [] }, { nodes: [node('t', 'email'), node('x', 'no-such-block')], edges: [] }, chain(EMAIL, node('t2', 'email'))])
      expect((await w.post('/api/v1/automations/a1/test', { sample: true, graph })).status).toBe(400);
    // An email from another workspace is not there, whatever its id.
    const other = await workspace('Elsewhere');
    const otherBox = await connectGmail(other, 'owner@elsewhere.test');
    await jobs().drain();
    const d = fake().deliver(otherBox.account, { from: 'Sam <sam@x.test>', subject: 'Theirs', body: 'Private' });
    await post(d.webhook);
    await jobs().drain();
    const [theirs] = (await other.json<{ emails: { id: string }[] }>('GET', '/api/v1/automations/test-emails')).emails;
    expect((await w.post('/api/v1/automations/a1/test', { eventId: theirs!.id })).status).toBe(404);
  });
});

/* ───────────── 2. One card for Draft then Send ───────────── */

describe('Draft then Send is one card in Approvals', () => {
  const graph = chain(EMAIL, DRAFT, SEND, TASK);

  it('shows the automation’s card with the draft’s words, not the draft’s own card; the thread’s own Send can’t send it a second time', async () => {
    await live('a1', graph);
    await deliver('Quote for 40 seats?');
    const s = await w.state();
    const thread = s.threads.find((t) => t.subject === 'Quote for 40 seats?')!;
    expect(thread.draft).toBeDefined();
    const [e] = await effects();
    expect(s.pending).toHaveLength(1);
    expect(s.pending[0]).toMatchObject({ id: e!.id, replacesDraft: true, thread: thread.id });

    const cards = openApprovals(s).filter((a) => a.thread === thread.id);
    expect(cards.map((a) => a.key)).toEqual([`eff:${e!.id}`]);
    expect(cards[0]!.email!.body).toBe(thread.draft!.body);
    expect(cards[0]!.email!.to).toEqual(['mail:jamie@brightwave.co']);

    // The thread's own Send, while the automation's waits, is refused: the same email can't go twice.
    const own = await w.cmd({ type: 'sendDraft', id: thread.id, track: false });
    expect(own.ok).toBe(false);
    expect(own.error).toMatch(/already has an email waiting/);
    const fromCard = await w.cmd({ type: 'resolve', key: `draft:${thread.id}`, option: 'send' });
    expect(fromCard.ok).toBe(false);
    expect((await effects()).length).toBe(1);

    // Deciding the one card settles both: it goes out once, the draft is gone, and nothing is left in Approvals.
    expect((await decide(w, e!.id, 'approve')).status).toBe(200);
    expect(await releaseHolds(w)).toBe(1);
    await jobs().drain();
    expect(sent()).toHaveLength(1);
    const after = await w.state();
    expect(after.threads.find((t) => t.id === thread.id)!.draft).toBeUndefined();
    expect(openApprovals(after)).toEqual([]);
    // Pressing Send again anywhere sends nothing more.
    await w.cmd({ type: 'sendDraft', id: thread.id, track: false });
    await w.cmd({ type: 'resolve', key: `draft:${thread.id}`, option: 'send' });
    await releaseHolds(w);
    await tick();
    expect(sent()).toHaveLength(1);
    expect((await effects()).filter((x) => x.kind.startsWith('email.'))).toHaveLength(1);
  });

  it('turned down, the card goes and the draft goes with it; no second card comes back', async () => {
    await live('a1', graph);
    await deliver('Quote for 40 seats?');
    const [e] = await effects();
    expect((await decide(w, e!.id, 'decline')).status).toBe(200);
    await jobs().drain();
    const s = await w.state();
    expect(s.threads.find((t) => t.subject === 'Quote for 40 seats?')!.draft).toBeUndefined();
    expect(openApprovals(s)).toEqual([]);
    expect(sent()).toEqual([]);
    expect((await runsOf('a1'))[0]!.status).toBe('cancelled');
  });

  it('a draft the person changed while it waited is theirs: turning the card down leaves it, with its own card', async () => {
    await live('a1', graph);
    await deliver('Quote for 40 seats?');
    const thread = (await w.state()).threads.find((t) => t.subject === 'Quote for 40 seats?')!;
    expect((await w.cmd({ type: 'updateDraft', id: thread.id, body: 'My own words instead.' })).ok).toBe(true);
    const [e] = await effects();
    // While the automation's card waits, it is still the only card for the thread.
    expect(openApprovals(await w.state()).filter((a) => a.thread === thread.id).map((a) => a.key)).toEqual([`eff:${e!.id}`]);
    await decide(w, e!.id, 'decline');
    await jobs().drain();
    const s = await w.state();
    expect(s.threads.find((t) => t.id === thread.id)!.draft!.body).toBe('My own words instead.');
    expect(openApprovals(s).map((a) => a.key)).toEqual([`draft:${thread.id}`]);
    expect(sent()).toEqual([]);
  });

  it('Undo inside the hold brings the draft back as a draft, to send or change by hand', async () => {
    await live('a1', graph);
    await deliver('Quote for 40 seats?');
    const [e] = await effects();
    await decide(w, e!.id, 'approve');
    // While it waits out its hold, the one card says so.
    expect(openApprovals(await w.state()).map((a) => [a.key, a.options.map((o) => o.id)])).toEqual([[`eff:${e!.id}`, ['undo']]]);
    await decide(w, e!.id, 'decline');
    await jobs().drain();
    await releaseHolds(w);
    expect(sent()).toEqual([]);
    const s = await w.state();
    const thread = s.threads.find((t) => t.subject === 'Quote for 40 seats?')!;
    expect(thread.draft).toBeDefined();
    expect(openApprovals(s).map((a) => a.key)).toEqual([`draft:${thread.id}`]);
  });
});

/* ───────────── 3. Who may decide ───────────── */

describe('an automation’s card, seen by someone who may not decide it', () => {
  it('“Ask me first”: a member is told it waits for an owner or admin, and can’t answer it', async () => {
    await live('a1', chain(EMAIL, ASK, TASK));
    await deliver('Quote?');
    const member = await addMember(w.workspaceId, 'member');
    const s = await member.state();
    expect(s.pending[0]).toMatchObject({ kind: 'decision', decidedBy: {} });
    const [card] = openApprovals(s);
    expect(card!.decidedBy).toEqual({ who: 'an owner or admin' });
    expect(mayDecideCard(card!, viewer(member, AS_MEMBER))).toBe(false);
    expect(mayDecideCard(card!, viewer(w, AS_OWNER))).toBe(true);
    // The screen's view matches the server's: the member's answer is refused, the owner's is taken.
    const [e] = await effects();
    expect((await decide(member, e!.id, 'approve')).status).toBe(409);
    expect((await member.cmd({ type: 'resolve', key: `eff:${e!.id}`, option: 'decline' })).ok).toBe(false);
    expect((await effects())[0]!.status).toBe('intended');
    expect((await decide(w, e!.id, 'approve')).status).toBe(200);
    await jobs().drain();
    expect(await tasks()).toHaveLength(1);
  });

  it('“Send the email”: it waits for whoever’s mailbox it leaves from, or an owner or admin', async () => {
    // Here a member connected the mailbox, so the reply leaves from theirs.
    const v = await workspace('Gaps Member Box');
    const mailboxOwner = await addMember(v.workspaceId, 'member', 'Mailbox Owner');
    const theirs = await connectApp(mailboxOwner, 'gmail', 'member@gaps.test');
    await jobs().drain();
    w = v;
    box = theirs;
    await live('a1', chain(EMAIL, DRAFT, SEND));
    await deliver('Quote?');
    const other = await addMember(v.workspaceId, 'member', 'Another Member');
    const [card] = openApprovals(await other.state());
    expect(card!.decidedBy).toEqual({ person: mailboxOwner.userId, who: 'the person whose mailbox it leaves from (member@gaps.test), or an owner or admin' });
    expect(mayDecideCard(card!, viewer(other, AS_MEMBER))).toBe(false);
    expect(mayDecideCard(card!, viewer(mailboxOwner, AS_MEMBER))).toBe(true);
    expect(mayDecideCard(card!, viewer(v, AS_OWNER))).toBe(true);
    const [e] = await effects(v);
    expect((await decide(other, e!.id, 'approve')).status).toBe(409);
    expect((await decide(mailboxOwner, e!.id, 'approve')).status).toBe(200);
    await releaseHolds(v);
    await jobs().drain();
    expect(fake().sent(theirs.account)).toHaveLength(1);
  });

  it('cards that aren’t an automation’s are left as they were', async () => {
    // A draft on its own (no Send step after it) is an ordinary draft card, for anyone who may send.
    await live('a1', chain(EMAIL, DRAFT));
    await deliver('Hello');
    const member = await addMember(w.workspaceId, 'member');
    const cards = openApprovals(await member.state());
    expect(cards.map((a) => a.key.split(':')[0])).toEqual(['draft']);
    expect(cards[0]!.decidedBy).toBeUndefined();
    expect(mayDecideCard(cards[0]!, viewer(member, AS_MEMBER))).toBe(true);
  });
});

/* ───────────── 4. No mailbox ───────────── */

describe('a New-email automation with no mailbox', () => {
  it('is paused when the mailbox is disconnected, fires nothing, and carries on once one is connected again', async () => {
    await live('a1', chain(EMAIL, TASK));
    await live('s1', chain(node('t', 'schedule', { every: 'Mondays at 9:00 AM' }), TASK));
    const old = box.account;
    expect((await w.post('/api/v1/connections/gmail/disconnect', {})).status).toBe(200);
    // The stand-in mailbox is kept for a moment (its removal at the provider waits), so mail can still be sent to it.
    jobs().queue = jobs().queue.filter((j) => !j.name.startsWith('connection.'));
    await jobs().drain();

    let s = await w.state();
    expect(s.ws.automations.a1).toMatchObject({ on: true, paused: NO_MAILBOX });
    expect(NO_MAILBOX).toBe('Connect a mailbox to run this.');
    // A schedule doesn't need a mailbox.
    expect(s.ws.automations.s1!.paused).toBeUndefined();
    expect(await liveRow('a1')).toMatchObject({ enabled: true, paused_reason: NO_MAILBOX });
    expect(await auditActions()).toContain('automation.paused');

    // Mail to the old mailbox goes nowhere, and the once-a-minute pass starts nothing.
    await deliver('While it was gone', {}, old);
    await tick();
    expect(await runsOf('a1')).toEqual([]);
    // Even if mail did reach Timmy through that mailbox somehow, a paused automation would start nothing.
    await sysPool.query(`update connection set status = 'active' where workspace_id = $1 and connected_account_id = $2`, [w.workspaceId, old]);
    await deliver('Through the back door', {}, old);
    await sysPool.query(`update connection set status = 'disconnected' where workspace_id = $1 and connected_account_id = $2`, [w.workspaceId, old]);
    expect(await runsOf('a1')).toEqual([]);
    expect(await tasks()).toEqual([]);

    // A screen can't clear the pause, or set it.
    await patch(w, 'a1', { paused: null, name: 'Renamed' });
    expect((await w.state()).ws.automations.a1).toMatchObject({ name: 'Renamed', paused: NO_MAILBOX });
    await patch(w, 's1', { paused: 'Made up' });
    expect((await w.state()).ws.automations.s1!.paused).toBeUndefined();

    // Connecting a mailbox again: it carries on, from mail that arrives from now on.
    box = await connectGmail(w, 'owner@gaps.test');
    await jobs().drain();
    s = await w.state();
    expect(s.ws.automations.a1!.paused).toBeUndefined();
    expect(s.ws.automations.a1!.on).toBe(true);
    expect(await liveRow('a1')).toMatchObject({ enabled: true, paused_reason: null });
    expect(await auditActions()).toContain('automation.resumed');
    await deliver('Sent while nothing was connected', { at: new Date(Date.now() - 10 * 60_000) });
    expect(await runsOf('a1')).toEqual([]);
    await deliver('A new one');
    const runs = await runsOf('a1');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'done' });
  });

  it('can’t be switched on without a mailbox, and switching it off clears the pause', async () => {
    await live('a1', chain(EMAIL, TASK));
    await w.post('/api/v1/connections/gmail/disconnect', {});
    await jobs().drain();
    const off = await patch(w, 'a1', { on: false });
    expect(off.ok).toBe(true);
    expect((await w.state()).ws.automations.a1).toMatchObject({ on: false });
    expect((await w.state()).ws.automations.a1!.paused).toBeUndefined();
    expect((await liveRow('a1'))!.paused_reason).toBeNull();
    const on = await patch(w, 'a1', { on: true });
    expect(on.ok).toBe(false);
    expect(on.error).toMatch(/“New email” needs a mailbox/);
    await save(w, automation('a2', chain(EMAIL, TASK)));
    expect((await patch(w, 'a2', { on: true })).ok).toBe(false);
    // Connected again, it is switched on as usual; nothing was left paused.
    box = await connectGmail(w, 'owner@gaps.test');
    await jobs().drain();
    expect((await w.state()).ws.automations.a1!.on).toBe(false);
    expect((await patch(w, 'a1', { on: true })).ok).toBe(true);
  });

  it('runs that started from the mailbox stop with it, and what they had waiting is taken back', async () => {
    await live('a1', chain(EMAIL, WAIT, TASK));
    await live('a2', chain(EMAIL, DRAFT, SEND));
    await deliver('Quote?');
    expect((await effects()).map((e) => e.status)).toEqual(['intended']);
    await w.post('/api/v1/connections/gmail/disconnect', {});
    await jobs().drain();
    for (const id of ['a1', 'a2']) {
      const [run] = await runsOf(id);
      expect([id, run!.status, run!.error]).toEqual([id, 'cancelled', 'The mailbox this run started from was disconnected.']);
    }
    expect((await effects()).map((e) => e.status)).toEqual(['cancelled']);
    expect((await w.state()).pending).toEqual([]);
    // Stopping them is not the automation failing.
    expect((await rows<{ failures_in_a_row: number }>('select failures_in_a_row from automation_live where workspace_id = $1', [w.workspaceId])).map((r) => r.failures_in_a_row)).toEqual([0, 0]);
    await tick();
    expect(await tasks()).toEqual([]);
    expect(sent()).toEqual([]);
  });
});

/* ───────────── 5. The limit on work at once ───────────── */

describe('the workspace’s limit on work at once', () => {
  it('a run past the limit waits its turn as queued, and starts when a place is free: none is lost or failed', async () => {
    await w.request('PATCH', '/api/v1/settings', { maxConcurrentRuns: 1 });
    await live('a1', chain(EMAIL, TASK));
    // Ask is busy with something for this workspace, which takes its one place.
    await sysPool.query(
      `insert into run (id, workspace_id, user_id, kind, attended, status, input, model, lease_owner, lease_until, fence, started_at) values ('run_busy_' || $1, $1, $2, 'ask', true, 'running', '{}', 'm', 'elsewhere', now() + interval '1 hour', 1, now())`,
      [w.workspaceId, w.userId],
    );
    for (const subject of ['First', 'Second', 'Third']) await deliver(subject);
    await tick();
    let runs = await runsOf('a1');
    expect(runs.map((r) => r.status)).toEqual(['queued', 'queued', 'queued']);
    expect(runs.every((r) => r.error === null && r.steps.length === 0)).toBe(true);
    expect(await tasks()).toEqual([]);

    // Ask finishes: the runs go, one at a time, oldest first.
    await sysPool.query(`update run set status = 'completed', lease_until = null where id = $1`, [`run_busy_${w.workspaceId}`]);
    await tick();
    runs = await runsOf('a1');
    expect(runs.map((r) => r.status)).toEqual(['done', 'done', 'done']);
    expect((await tasks()).length).toBe(3);
    const started = await rows<{ started_at: Date; finished_at: Date }>(`select started_at, finished_at from automation_run where workspace_id = $1 order by created_at`, [w.workspaceId]);
    for (let i = 1; i < started.length; i++) expect(new Date(started[i]!.started_at).getTime()).toBeGreaterThanOrEqual(new Date(started[i - 1]!.finished_at).getTime());
  });

  it('runs carried at the same time never take more places than the limit, and all of them complete', async () => {
    await w.request('PATCH', '/api/v1/settings', { maxConcurrentRuns: 2 });
    await live('a1', chain(EMAIL, DRAFT, TASK));
    const real = model();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let drafting = 0;
    let most = 0;
    const slow: ModelProvider = {
      complete: async (req, onText) => {
        if (req.route === 'draft') {
          drafting++;
          most = Math.max(most, drafting);
          await gate;
          drafting--;
        }
        return real.complete(req, onText);
      },
    };
    setModelForTests(slow);
    try {
      // Four emails arrive; their runs are queued, and nothing carries them yet.
      for (const subject of ['One', 'Two', 'Three', 'Four']) {
        const d = fake().deliver(box.account, { from: `Lead ${subject} <${subject.toLowerCase()}@leads.test>`, subject, body: 'Pricing?' });
        await post(d.webhook);
        await jobs().drain('mail.ingest');
      }
      jobs().queue = jobs().queue.filter((j) => j.name !== 'automation.run');
      const ids = (await rows<{ id: string }>('select id from automation_run where workspace_id = $1 order by created_at', [w.workspaceId])).map((r) => r.id);
      expect(ids).toHaveLength(4);

      // Four workers try all four at once: two take the places, two find none and leave theirs waiting.
      const all = Promise.all(ids.map((id) => runAutomation(w.workspaceId, id)));
      for (let i = 0; i < 200 && drafting < 2; i++) await new Promise((r) => setTimeout(r, 25));
      await new Promise((r) => setTimeout(r, 150));
      expect(drafting).toBe(2);
      const now = await rows<{ status: string }>('select status from automation_run where workspace_id = $1 order by created_at', [w.workspaceId]);
      expect(now.map((r) => r.status).sort()).toEqual(['queued', 'queued', 'running', 'running']);
      open();
      expect((await all).sort()).toEqual(['busy', 'busy', 'ran', 'ran']);
      // Those two runs, as they stopped, started the ones waiting their turn.
      await jobs().drain();
      const runs = await runsOf('a1');
      expect(runs.map((r) => r.status)).toEqual(['done', 'done', 'done', 'done']);
      expect(most).toBe(2);
      expect((await tasks()).length).toBe(4);
      expect((real as unknown as { requests: { route: string }[] }).requests.filter((r) => r.route === 'draft')).toHaveLength(4);
    } finally {
      open();
      setModelForTests(real);
    }
  });
});

/* ───────────── 6. Add to a doc, with the page open ───────────── */

describe('“Add to a doc” and someone with the page open', () => {
  const page = async () => {
    await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'files', item: { id: 'notes', name: 'Lead notes', kind: 'doc', folder: '', updated: new Date(), owner: 'me' } }, { op: 'put', col: 'docs', item: { id: 'notes', template: 'blank', blocks: [{ id: 'b1', type: 'p', text: 'Leads this month' }] } }] });
    await live('a1', chain(EMAIL, node('doc', 'doc', { doc: 'Lead notes', line: '{{name}} asked: {{subject}}' })));
  };
  const blocksOf = async () => ((await w.state()).ws.docs.notes as unknown as { blocks: Block[] }).blocks;
  /** A save from the page editor, as DocEditor sends it. */
  const saveBlocks = (blocks: unknown[], base?: string[]) => w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'docs', id: 'notes', patch: { blocks }, ...(base ? { base } : {}) }] });

  it('a save made from a copy of the page opened before the line was added keeps the line', async () => {
    await page();
    // The person opened the page: their copy has one block.
    const copy = await blocksOf();
    expect(copy.map((b) => b.id)).toEqual(['b1']);
    await deliver('Quote for 40 seats?');
    const added = (await blocksOf()).find((b) => b.id !== 'b1')!;
    expect(added).toMatchObject({ type: 'p', text: 'Jamie Lee asked: Quote for 40 seats?' });

    // They kept typing and saved what their screen had, which never showed the line.
    const out = await saveBlocks([{ id: 'b1', type: 'p', text: 'Leads this month, so far' }, { id: 'b2', type: 'p', text: 'Call Dana back' }], []);
    expect(out.ok).toBe(true);
    expect((await blocksOf()).map((b) => [b.id, (b as { text: string }).text])).toEqual([
      ['b1', 'Leads this month, so far'],
      ['b2', 'Call Dana back'],
      [added.id, 'Jamie Lee asked: Quote for 40 seats?'],
    ]);
    // A save that says nothing about what its copy had (adding a link to a sub-page, say) keeps it too.
    await saveBlocks([{ id: 'b1', type: 'p', text: 'Leads this month, so far' }, { id: 'b2', type: 'p', text: 'Call Dana back' }, { id: 'link', type: 'page', file: 'notes-2' }]);
    expect((await blocksOf()).map((b) => b.id)).toEqual(['b1', 'b2', 'link', added.id]);
  });

  it('a person who saw the line and took it out takes it out; ordinary typing is saved exactly as typed', async () => {
    await page();
    await deliver('Quote?');
    const shown = await blocksOf();
    const line = shown.find((b) => b.id !== 'b1')!;
    // Their copy had the line; they deleted it.
    await saveBlocks([shown[0]!], [line.id]);
    expect((await blocksOf()).map((b) => b.id)).toEqual(['b1']);
    // Typing on a page with no line of Timmy's in play is stored as it was sent, block for block.
    const typed = [{ id: 'b1', type: 'h2', text: 'Leads' }, { id: 'b3', type: 'todo', text: 'Ring back', checked: false }, { id: 'b4', type: 'p', text: '' }];
    await saveBlocks(typed, []);
    expect(await blocksOf()).toEqual(typed);
  });

  it('keeps each line where it was, and never past the page’s limit', () => {
    const doc = (blocks: Block[]) => ({ ws: { docs: { p: { id: 'p', template: 'blank', blocks } } } }) as unknown as State;
    const p = (id: string, text = id): Block => ({ id, type: 'p', text });
    const stored = [p('auto-r0-doc'), p('a'), p('auto-r1-doc'), p('b'), p('auto-r4-doc'), p('d'), p('auto-r2-doc'), p('auto-r3-doc')];
    const ops = [{ op: 'patch', col: 'docs', id: 'p', patch: { blocks: [p('a', 'A!'), p('b', 'B!'), p('c')] }, base: ['auto-r1-doc'] }];
    const [out] = keepTimmyLines(doc(stored), ops) as { patch: { blocks: Block[] } }[];
    // r1 was on the copy and is gone on purpose. The others weren't, and come back: r0 first, as it was; r4 after the
    // block it followed; r2 and r3, which ended the page, at the end, after what was typed below.
    expect(out!.patch.blocks.map((b) => b.id)).toEqual(['auto-r0-doc', 'a', 'b', 'auto-r4-doc', 'c', 'auto-r2-doc', 'auto-r3-doc']);
    // Saves of anything else, and saves that leave nothing of Timmy's out, are untouched.
    const other = [{ op: 'patch', col: 'tasks', id: 'p', patch: { title: 'x' } }, { op: 'patch', col: 'docs', id: 'p', patch: { icon: '📝' } }];
    expect(keepTimmyLines(doc(stored), other)).toEqual(other);
    const whole = [{ op: 'patch', col: 'docs', id: 'p', patch: { blocks: stored } }];
    expect(keepTimmyLines(doc(stored), whole)).toEqual(whole);
    // A page already at its limit isn't pushed past it.
    const full = Array.from({ length: MAX_BLOCKS }, (_, i) => p(`x${i}`));
    const big = [{ op: 'patch', col: 'docs', id: 'p', patch: { blocks: full } }];
    expect(keepTimmyLines(doc([...full.slice(1), p('auto-r9-doc')]), big)).toEqual(big);
  });

  it('the editor puts a line Timmy added beside what is being typed only when that is all that changed', () => {
    const p = (id: string, text = id): Block => ({ id, type: 'p', text });
    // Added at the end of the page, it stays at the end, below whatever is being typed.
    expect(timmyAdditions([p('a'), p('b')], [p('a'), p('b'), p('auto-r1-doc')])).toEqual([{ block: p('auto-r1-doc') }]);
    expect(timmyAdditions([p('a'), p('b')], [p('auto-r0-doc'), p('a'), p('auto-r1-doc'), p('b'), p('auto-r2-doc'), p('auto-r3-doc')])).toEqual([
      { block: p('auto-r0-doc'), after: null },
      { block: p('auto-r1-doc'), after: 'a' },
      { block: p('auto-r2-doc') },
      { block: p('auto-r3-doc') },
    ]);
    // Anything else changed too (someone else's save): not only Timmy's lines, so the editor takes the page as it is.
    expect(timmyAdditions([p('a')], [p('a', 'changed'), p('auto-r1-doc')])).toBeNull();
    expect(timmyAdditions([p('a')], [p('a'), p('b')])).toBeNull();
    expect(timmyAdditions([p('a'), p('auto-r1-doc')], [p('a'), p('auto-r1-doc')])).toBeNull();
  });
});

/* ───────────── 7. When the owner or admin who switched it on loses that role ───────────── */

describe('an automation whose owner or admin no longer is one', () => {
  const memberRow = async (c: Client) => (await authPool.query(`select id from member where "organizationId" = $1 and "userId" = $2`, [w.workspaceId, c.userId])).rows[0]!.id as string;

  it('switches off when they are made a member, says why for the owners and admins, and another can switch it on again', async () => {
    const admin = await addMember(w.workspaceId, 'admin', 'Grace Admin');
    await live('a1', chain(EMAIL, ASK, TASK), admin);
    await live('a2', chain(EMAIL, TASK));
    await deliver('Quote?');
    const [ask] = await effects();
    expect(ask).toMatchObject({ kind: 'automation.ask', status: 'intended' });

    const res = await w.post('/api/auth/organization/update-member-role', { memberId: await memberRow(admin), role: 'member', organizationId: w.workspaceId });
    expect(res.status).toBe(200);

    const s = await w.state();
    const why = 'Grace Admin, who switched it on, is no longer an owner or admin here. An owner or admin can switch it back on.';
    expect(s.ws.automations.a1).toMatchObject({ on: false });
    expect(s.ws.automations.a1!.note).toMatch(new RegExp(`^Timmy switched this off on .+\\. ${why.replace(/\./g, '\\.')}$`));
    expect(s.activity.map((a) => a.text)).toContain(`Timmy switched the automation “Automation a1” off. ${why}`);
    expect(await liveRow('a1')).toMatchObject({ enabled: false, off_reason: why });
    // Its run in progress stops, and its question is taken back.
    expect((await runsOf('a1'))[0]).toMatchObject({ status: 'cancelled' });
    expect((await effects())[0]!.status).toBe('cancelled');
    expect(s.pending).toEqual([]);
    // The owner's own automation is untouched.
    expect(s.ws.automations.a2!.on).toBe(true);
    expect((await liveRow('a2'))!.enabled).toBe(true);

    // New mail starts nothing for it.
    await deliver('Another quote?');
    expect((await runsOf('a1')).length).toBe(1);

    // Another owner or admin switches it back on, on their own say-so.
    const back = await patch(w, 'a1', { on: true });
    expect(back.ok).toBe(true);
    expect(await liveRow('a1')).toMatchObject({ enabled: true, enabled_by: w.userId });
    expect((await w.state()).ws.automations.a1!.note).toBeUndefined();
    // The lowered member can't.
    await patch(w, 'a1', { on: false });
    expect((await patch(admin, 'a1', { on: true })).ok).toBe(false);
  });

  it('switches off when they leave, or are removed', async () => {
    const leaving = await addMember(w.workspaceId, 'admin', 'Ada Leaving');
    const removed = await addMember(w.workspaceId, 'admin', 'Rex Removed');
    await live('a1', chain(EMAIL, TASK), leaving);
    await live('a2', chain(EMAIL, TASK), removed);

    expect((await leaving.post('/api/auth/organization/leave', { organizationId: w.workspaceId })).status).toBe(200);
    let s = await w.state();
    expect(s.ws.automations.a1!.on).toBe(false);
    expect(s.ws.automations.a1!.note).toMatch(/Ada Leaving, who switched it on, has left the workspace\. An owner or admin can switch it back on\.$/);
    expect(s.ws.automations.a2!.on).toBe(true);

    expect((await w.post('/api/auth/organization/remove-member', { memberIdOrEmail: await memberRow(removed), organizationId: w.workspaceId })).status).toBe(200);
    s = await w.state();
    expect(s.ws.automations.a2!.on).toBe(false);
    expect(s.ws.automations.a2!.note).toMatch(/Rex Removed, who switched it on, has left the workspace\./);
    await deliver('Quote?');
    expect([...(await runsOf('a1')), ...(await runsOf('a2'))]).toEqual([]);
    expect((await auditActions()).filter((a) => a === 'automation.off')).toHaveLength(2);
  });

  it('a role changed some other way is caught by the once-a-minute pass; so is whoever last changed its steps', async () => {
    const admin = await addMember(w.workspaceId, 'admin', 'Quiet Admin');
    await live('a1', chain(EMAIL, TASK), admin);
    // The owner switched a2 on; the admin changed its steps while it was on.
    await live('a2', chain(EMAIL, TASK));
    expect((await patch(admin, 'a2', { nodes: [EMAIL, { ...TASK, config: { ...TASK.config, title: 'Ring {{name}}' } }] })).ok).toBe(true);
    await authPool.query('update member set role = $1 where "organizationId" = $2 and "userId" = $3', ['member', w.workspaceId, admin.userId]);
    expect((await w.state()).ws.automations.a1!.on).toBe(true);
    await tick();
    const s = await w.state();
    expect(s.ws.automations.a1!.on).toBe(false);
    expect(s.ws.automations.a2!.on).toBe(false);
    expect(s.ws.automations.a2!.note).toMatch(/Quiet Admin, who last changed its steps, is no longer an owner or admin here\./);
    // Once off, the pass leaves it alone.
    const before = (await auditActions()).length;
    await tick();
    expect((await auditActions()).length).toBe(before);
  });
});
