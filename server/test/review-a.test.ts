/**
 * Review A: proof tests from an independent safety review of what can cause an outside write or lets a
 * stranger in (the gateway's new kinds, automations, the website chat, calendar changes, changes picked up
 * from the mailbox).
 *
 * Each test states the safe behaviour. On the code as it was reviewed, each one fails; the comment above it
 * says what happens instead and which property it is about.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatWidget } from '../../src/data/ws-types';
import type { Lead } from '../../src/data/outbound-types';
import { resetLimits } from '../src/chat/limits';
import type { EffectRow } from '../src/gateway/gateway';
import type { FakeMessage } from '../src/providers/composio';
import type { Draft } from '../../src/data/types';
import { mutate } from '../src/state/mutate';
import { checkMailbox } from '../src/sync/mailbox-check';
import { addMember, authPool, boot, connectGmail, fake, jobs, model, newWorkspace, rows, sysPool, type Client } from './helpers';

const DAY = 86400_000;
const ORIGIN = 'http://localhost:8787';

/* ───────────── Shared helpers ───────────── */

type Node = { id: string; kind: string; x: number; y: number; config: Record<string, string> };
const node = (id: string, kind: string, config: Record<string, string> = {}): Node => ({ id, kind, x: 0, y: 0, config });
const chain = (...nodes: Node[]) => ({ nodes, edges: nodes.slice(1).map((n, i) => ({ id: `${nodes[i]!.id}-${n.id}`, from: nodes[i]!.id, to: n.id })) });
const automation = (id: string, graph: { nodes: Node[]; edges: unknown[] }) => ({ id, name: `Automation ${id}`, description: '', on: false, ...graph, updated: new Date() });
async function live(c: Client, id: string, graph: { nodes: Node[]; edges: unknown[] }) {
  expect((await c.cmd({ type: 'ws', ops: [{ op: 'put', col: 'automations', item: automation(id, graph) }] })).ok).toBe(true);
  const on = await c.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'automations', id, patch: { on: true } }] });
  expect(on.error).toBeUndefined();
}
const post = async (webhook: { headers: Record<string, string>; body: string }) => (await boot()).request('/api/hooks/composio', { method: 'POST', headers: webhook.headers, body: webhook.body });
const effectsOf = (c: Client) => rows<EffectRow>('select * from effect where workspace_id = $1 order by created_at, id', [c.workspaceId]);
const runsOf = (c: Client, id: string) => rows<{ id: string; status: string }>('select id, status from automation_run where workspace_id = $1 and automation_id = $2', [c.workspaceId, id]);

/** Every workspace a test here makes, left quiet when the test ends (other suites sweep every connected mailbox). */
const made: string[] = [];
async function workspace(name: string): Promise<Client> {
  const c = await newWorkspace(name);
  made.push(c.workspaceId);
  return c;
}

beforeAll(async () => {
  await boot();
});
beforeEach(() => {
  model().reset();
  jobs().queue = [];
  resetLimits();
});
afterEach(async () => {
  await sysPool.query(`update automation_live set enabled = false, next_fire_at = null where workspace_id = any($1::text[])`, [made]);
  await sysPool.query(`update connection set status = 'disconnected', disconnected_at = now() where workspace_id = any($1::text[]) and status = 'active'`, [made]);
  made.length = 0;
  jobs().queue = [];
});

/* ───────────── B. Automations ───────────── */

describe('automations: what a stranger’s email can make an automation do', () => {
  // Property: unattended runs act only on what the person set (“From contains”), and text from outside is never
  // obeyed. mailMatches() compares “From contains” with the whole From header, display name and comments included,
  // so a stranger who writes the trusted name into their display name passes the filter: the run drafts a reply
  // with the model (spend), adds tasks, notices and doc lines carrying their words, and puts a reply addressed to
  // them into Approvals under the trusted automation's name. (server/src/automations/triggers.ts, mailMatches)
  it('“From contains” is matched against the address the email came from, not the display name a stranger chose', async () => {
    const w = await workspace('RevA From');
    const box = await connectGmail(w, 'owner@reva-from.test');
    await jobs().drain();
    await live(w, 'vip', chain(node('t', 'email', { from: 'bigclient.test' }), node('draft', 'draft', { tone: 'Brief' }), node('send', 'send', { when: 'Right away' })));

    for (const from of ['"ceo@bigclient.test" <mallory@evil.test>', 'mallory@evil.test (ceo@bigclient.test)', 'BigClient.test Billing <mallory@evil.test>']) {
      const d = fake().deliver(box.account, { from, subject: `Invoice ${from.length}`, body: 'Please confirm the new bank details for the invoice.' });
      expect((await post(d.webhook)).status).toBe(200);
      await jobs().drain();
    }
    // Safe: none of these came from bigclient.test, so the automation started nothing and asked the model nothing.
    expect(await runsOf(w, 'vip')).toEqual([]);
    expect(model().requests.filter((r) => r.route !== 'read')).toEqual([]);
    expect((await effectsOf(w)).map((e) => e.preview.to)).toEqual([]);

    // The real sender still starts it.
    const real = fake().deliver(box.account, { from: 'Dana <ceo@bigclient.test>', subject: 'Renewal', body: 'Can we renew?' });
    await post(real.webhook);
    await jobs().drain();
    expect(await runsOf(w, 'vip')).toHaveLength(1);
  });

  // Property: “a Send step only ever puts the reply the run itself drafted into Approvals”. The step checks that its
  // own Draft step reported drafted: true, then puts forward whatever draft the thread holds now. If the run's draft
  // was replaced while the run waited (here at “Ask me first”), the card says “the reply Timmy drafted” about text
  // Timmy never wrote. (server/src/automations/steps.ts, send: `const reply = thread.draft`)
  it('a Send step puts forward only the draft its own Draft step wrote, not one that replaced it while the run waited', async () => {
    const w = await workspace('RevA Draft');
    const box = await connectGmail(w, 'owner@reva-draft.test');
    await jobs().drain();
    await live(w, 'a1', chain(node('t', 'email'), node('draft', 'draft', { tone: 'Brief' }), node('ask', 'approve', { note: 'Check it' }), node('send', 'send', { when: 'Right away' })));
    const d = fake().deliver(box.account, { from: 'Jamie Lee <jamie@brightwave.co>', subject: 'Quote?', body: 'Could you send pricing?' });
    await post(d.webhook);
    await jobs().drain();
    const thread = (await w.state()).threads.find((t) => t.subject === 'Quote?')!;
    const timmys = thread.draft!.body;
    expect(timmys).toBeTruthy();

    // While the run waits at “Ask me first”, Timmy's draft is discarded and someone starts a different, unfinished one.
    await mutate(w.workspaceId, 'test', async (_tx, loaded) => ({
      state: { ...loaded.state, threads: loaded.state.threads.map((t) => (t.id === thread.id ? { ...t, draft: { to: ['mail:jamie@brightwave.co'], subject: 'Re: Quote?', body: 'Half a thought, not ready to', sources: [] } as Draft } : t)) },
      result: null,
    }));
    const ask = (await effectsOf(w)).find((e) => e.kind === 'automation.ask')!;
    expect((await w.post(`/api/v1/actions/${ask.id}/approve`)).status).toBe(200);
    await jobs().drain();

    const reply = (await effectsOf(w)).find((e) => e.kind === 'email.reply');
    // Safe: what goes forward as “the reply Timmy drafted” is the reply Timmy drafted, or nothing.
    if (reply) expect((reply.payload as { body: string }).body).toBe(timmys);
  });

  // Property: approval by the right person and role. “Ask me first” may be answered by an owner or admin, or by
  // whoever switched the automation on. That person is fixed when the version is frozen and is never checked again:
  // an admin who has since been made a member still answers it, and the automation they switched on keeps running.
  // (server/src/gateway/policy.ts mayDecide, `k.domain === 'decision'`; steps.ts approve: onBehalfOf: version.created_by)
  it('someone who is no longer an owner or admin can’t answer an automation’s “Ask me first”', async () => {
    const w = await workspace('RevA Ask');
    const box = await connectGmail(w, 'owner@reva-ask.test');
    await jobs().drain();
    const admin = await addMember(w.workspaceId, 'admin', 'Former Admin');
    await live(admin, 'a1', chain(node('t', 'email'), node('ask', 'approve', { note: 'Check it' }), node('task', 'task', { title: 'Follow up with {{name}}', due: 'Tomorrow' })));
    // The admin is made a member.
    await authPool.query('update member set role = $1 where "organizationId" = $2 and "userId" = $3', ['member', w.workspaceId, admin.userId]);

    const d = fake().deliver(box.account, { from: 'Jamie Lee <jamie@brightwave.co>', subject: 'Quote?', body: 'Could you send pricing?' });
    await post(d.webhook);
    await jobs().drain();
    const ask = (await effectsOf(w)).find((e) => e.kind === 'automation.ask');
    if (!ask) return; // Also safe: an automation whose enabler lost the right to switch it on starts no run.
    const res = await admin.post(`/api/v1/actions/${ask.id}/approve`);
    expect(res.status).toBe(409);
    expect((await effectsOf(w)).find((e) => e.id === ask.id)!.status).toBe('intended');
  });
});

/* ───────────── C. The website chat ───────────── */

const hex = (n = 32) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
let addr = 0;
class Visitor {
  id = hex();
  address = `10.77.${(++addr >> 8) & 255}.${addr & 255}`;
  conversation?: string;
  token?: string;
  after = 0;
  constructor(public siteKey: string) {}
  async say(text: string) {
    const res = await (await boot()).request(`/api/public/chat/${this.siteKey}/messages`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-real-ip': this.address },
      body: JSON.stringify({ visitor: this.id, id: hex(), text, after: this.after, ...(this.conversation ? { conversation: this.conversation, token: this.token } : {}) }),
    });
    const body = (await res.json()) as { ok: boolean; conversation?: string; token?: string; messages?: { seq: number; from: string; text: string }[] };
    if (body.ok) {
      this.conversation = body.conversation;
      this.token = body.token;
      this.after = Math.max(this.after, ...(body.messages ?? []).map((m) => m.seq));
    }
    return body;
  }
}
const settings = (c: Client, patch: Record<string, unknown>) => c.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'chat', id: 'site', patch }] });

describe('website chat: what one stranger can do to what another stranger left', () => {
  // Property: text from outside is data, and one visitor reaches nothing of another's. withLead() finds an existing
  // lead by the email address a visitor types; for a lead that came from a chat it merges the new visitor's answers
  // over the old ones. Anyone who types the same address (it is only typed, never checked) rewrites the answers the
  // first visitor gave, on the lead the business reads. (server/src/chat/visitor.ts, withLead: `existing.source === 'chat'`)
  it('a second visitor who types the same address can’t rewrite the answers the first visitor left on the lead', async () => {
    const owner = await workspace('RevA Chat');
    expect((await settings(owner, { domain: 'reva-chat.example', name: 'Support', questions: [{ id: 'q1', text: 'What’s your budget?' }], faq: [] })).ok).toBe(true);
    expect((await settings(owner, { on: true })).ok).toBe(true);
    const siteKey = ((await owner.state()).ws.chat.site as ChatWidget).siteKey!;

    const a = new Visitor(siteKey);
    expect((await a.say('Hi, I want a quote')).ok).toBe(true);
    expect((await a.say('pat@buyer.test')).ok).toBe(true);
    expect((await a.say('About 40,000 a year')).ok).toBe(true);
    const lead = async () => Object.values((await owner.state()).out.leads as Record<string, Lead>).find((l) => l.email === 'pat@buyer.test')!;
    expect((await lead()).extra).toEqual({ 'What’s your budget': 'About 40,000 a year' });

    const b = new Visitor(siteKey);
    await b.say('Hello');
    await b.say('pat@buyer.test');
    await b.say('Zero. We have no budget at all');
    // Safe: what the first visitor said stays as they said it.
    expect((await lead()).extra).toEqual({ 'What’s your budget': 'About 40,000 a year' });
  });
});

/* ───────────── E. Changes picked up from the mailbox ───────────── */

describe('changes picked up from the mailbox: what a stranger’s email can move', () => {
  // Property: a picked-up change reflects what the person did in the mailbox, and a crafted email causes no move.
  // A look reads only the last three days. When a thread's earlier messages are older than that and the only
  // recent message is one a stranger sent into the thread that the provider put in Spam, seenIn() reads the thread
  // as “gone”, followMailbox() finds the older messages still in the inbox and turns that into “its latest messages
  // were deleted”, and the thread is archived in Timmy with a line saying the person deleted them.
  // (server/src/sync/mailbox-changes.ts, seenIn + the `deleted` / `inPart` branch of followMailbox)
  it('a reply from a stranger that lands in Spam doesn’t archive the thread it joined', async () => {
    const w = await workspace('RevA Spam');
    const box = await connectGmail(w, 'owner@reva-spam.test');
    await jobs().drain();
    const first = fake().deliver(box.account, { from: 'Dana Whitfield <dana@client.test>', subject: 'Lease renewal', body: 'Shall we renew for another year?', at: new Date(Date.now() - 2 * DAY) });
    await post(first.webhook);
    await jobs().drain();
    // The first look remembers the thread as it is: in the inbox.
    await checkMailbox(w.workspaceId, box.connectionId);
    const shown = async () => (await w.state()).threads.find((t) => t.subject === 'Lease renewal')!;
    expect((await shown()).box).toBe('inbox');

    // Three days pass. Dana's message is now older than the days a look reads; nobody touches the thread.
    const mailbox = fake().accounts.get(box.account)!;
    mailbox.messages.find((m) => m.id === first.message.id)!.at = new Date(Date.now() - 5 * DAY);
    await sysPool.query(`update item set occurred_at = occurred_at - interval '3 days' where workspace_id = $1 and kind = 'message'`, [w.workspaceId]);
    await sysPool.query(`update mailbox_seen set seen_at = seen_at - interval '3 days' where workspace_id = $1`, [w.workspaceId]);
    // A stranger replies into the thread, and Gmail files the reply under Spam. No trigger fires for spam.
    const spam: FakeMessage = { id: `m_spam_${hex(8)}`, threadId: first.message.threadId, from: 'Mallory <mallory@evil.test>', to: ['owner@reva-spam.test'], subject: 'Re: Lease renewal', body: 'Cheap watches', at: new Date(), labels: ['SPAM', 'UNREAD'] };
    mailbox.messages.push(spam);

    await checkMailbox(w.workspaceId, box.connectionId);
    // Safe: the person did nothing to this thread, so it stays where it was, and nothing claims they deleted mail.
    const after = await shown();
    expect(after.box).toBe('inbox');
    expect((await w.state()).activity.map((a) => a.text).filter((t) => /Lease renewal/.test(t))).toEqual([]);
  });
});
