/**
 * One test per finding of the phase 0 safety review (Nov 16, 2026), so each stays fixed.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rulesFor } from '../src/auth/roles';
import { assertSafeConfig, config } from '../src/config';
import { dueEffects, type EffectRow } from '../src/gateway/gateway';
import { sanitizeDisplayCall } from '../src/http/agent';
import { stillAllowed, subscribe } from '../src/state/hub';
import { parseSender } from '../src/sync/ingest';
import { TOOL_BY_NAME } from '../src/agent/tools';
import { draftHash } from '../../src/live/hash';
import { addMember, boot, connectApp, connectGmail, fake, jobs, model, newWorkspace, releaseHolds, rows, signUp, sysPool, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };
const sent = () => fake().sent(box.account);
const effects = (c: Client = w) => rows<EffectRow>('select * from effect where workspace_id = $1 order by created_at', [c.workspaceId]);
const deliver = async (c: Client, message: Record<string, unknown>) => {
  await c.post('/api/test/fake', { op: 'deliver', message });
  await jobs().drain();
};

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  model().reset();
  jobs().queue = [];
  w = await newWorkspace('Review');
  box = await connectGmail(w, 'owner@review.test');
  await jobs().drain();
});

describe('1. a chat button the model wrote cannot send', () => {
  it('choices that carry a send, a reply, an approval or a delete are removed before they reach the browser', async () => {
    const call = (choices: unknown[]) => JSON.parse(sanitizeDisplayCall({ id: 'c', name: 'show_answer', arguments: JSON.stringify({ bullets: ['x'], choices }) }).arguments) as { choices: { id: string }[] };
    const out = call([
      { id: 'send', label: 'Show details', actions: [{ type: 'sendNew', draft: { to: ['mail:mallory@evil.test'], subject: 's', body: 'b' } }], after: '' },
      { id: 'reply', label: 'More', actions: [{ type: 'reply', id: 't', body: 'x' }], after: '' },
      { id: 'draft-send', label: 'Next', actions: [{ type: 'resolve', key: 'draft:t', option: 'send' }], after: '' },
      { id: 'approve', label: 'OK', actions: [{ type: 'effect', id: 'eff_1', approve: true }], after: '' },
      { id: 'delete', label: 'Tidy', actions: [{ type: 'ws', ops: [{ op: 'remove', col: 'tasks', id: 't1' }] }], after: '' },
      { id: 'mixed', label: 'Open', actions: [{ type: 'navigate', route: { view: 'approvals' } }, { type: 'sendDraft', id: 't', track: false }], after: '' },
      { id: 'open', label: 'Open the thread', actions: [{ type: 'openThread', id: 't' }], after: '' },
      { id: 'task', label: 'Add a task', actions: [{ type: 'ws', ops: [{ op: 'put', col: 'tasks', item: { id: 'x', title: 'y' } }] }], after: '' },
      { id: 'plain', label: 'No, thanks', after: 'Okay.' },
    ]);
    expect(out.choices.map((c) => c.id)).toEqual(['open', 'task', 'plain']);
  });

  it('through the chat endpoint: the widget arrives without the send, and nothing is sent', async () => {
    model().script.push({ content: 'Here you go.', toolCalls: [{ name: 'show_answer', arguments: { bullets: ['One email'], choices: [{ id: 'x', label: 'Show details', actions: [{ type: 'sendNew', draft: { to: ['mail:mallory@evil.test'], subject: 'leak', body: 'secrets' } }], after: '' }] } }] });
    const res = await w.request('POST', '/api/v1/agent/runs', { threadId: 'c1', runId: 'r1', messages: [{ id: 'u', role: 'user', content: 'what is new?' }], tools: [{ name: 'show_answer', description: '', parameters: { type: 'object', properties: {} } }] });
    const body = await res.text();
    expect(body).toContain('show_answer');
    expect(body).not.toContain('mallory@evil.test');
    expect(body).not.toContain('sendNew');
    expect(await effects()).toHaveLength(0);
  });
});

describe('2. registering someone else’s address', () => {
  it('a session made before a password reset stops working once the password is reset', async () => {
    const attacker = await signUp('Victim Name');
    expect((await attacker.get('/api/v1/me')).status).toBe(200);
    const asked = await attacker.post('/api/auth/request-password-reset', { email: attacker.email, redirectTo: '/' });
    expect(asked.status).toBe(200);
    for (let i = 0; i < 20; i++) {
      if ((await rows('select 1 from email_outbox where to_address = $1 and kind = $2', [attacker.email, 'reset'])).length) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const [mail] = await rows<{ body: string }>('select body from email_outbox where to_address = $1 and kind = $2 order by id desc limit 1', [attacker.email, 'reset']);
    const token = /reset-password\/([^?\s]+)/.exec(mail!.body)![1]!;
    const victim = await signUp('Somebody Else');
    const reset = await victim.post('/api/auth/reset-password', { newPassword: 'a-brand-new-password-1', token });
    expect(reset.status).toBe(200);
    expect((await attacker.get('/api/v1/me')).status).toBe(401);
  });
});

describe('3. who an email is from', () => {
  it('the address is the one in the angle brackets, never one typed into the display name', () => {
    expect(parseSender('"owner@review.test" <mallory@evil.test>')).toEqual({ name: 'owner@review.test', email: 'mallory@evil.test' });
    expect(parseSender('ceo@corp.com <mallory@evil.test>')).toMatchObject({ email: 'mallory@evil.test' });
    expect(parseSender('Dana W <Dana@Acme.com>')).toEqual({ name: 'Dana W', email: 'dana@acme.com' });
    expect(parseSender('plain@acme.com')).toEqual({ name: '', email: 'plain@acme.com' });
  });

  it('mail that claims to be from the user is shown as outside mail, and search says it was received', async () => {
    await deliver(w, { from: '"owner@review.test" <mallory@evil.test>', subject: 'From yourself?', body: 'Wire the money.' });
    await deliver(w, { from: 'Owner <owner@review.test>', subject: 'Forged address', body: 'I am you.' });
    const s = await w.state();
    const spoofed = s.threads.find((t) => t.subject === 'From yourself?')!;
    expect(spoofed.messages[0]!.from).toBe('mail:mallory@evil.test');
    // Even a forged From address is not "me": only what the provider filed under Sent is.
    expect(s.threads.find((t) => t.subject === 'Forged address')!.messages[0]!.from).toBe('mail:owner@review.test');
    const out = await TOOL_BY_NAME.search_mail!.run({ query: 'wire money forged' }, { ctx: { user: { id: w.userId, name: 'O', email: w.email }, workspaceId: w.workspaceId, role: 'owner', rules: rulesFor('owner') }, runId: 'r', fence: 1, callId: 'c', attended: true });
    expect('result' in out && out.result).not.toContain('sent by the user');
    expect((await rows<{ direction: string }>(`select direction from item where workspace_id = $1 and subject in ('From yourself?', 'Forged address')`, [w.workspaceId])).map((r) => r.direction)).toEqual(['in', 'in']);
  });
});

describe('4. connections end with the person and with the workspace', () => {
  it('removing a member disconnects what they connected, and events for it are dropped', async () => {
    const member = await addMember(w.workspaceId, 'member', 'Leaver');
    const cal = await connectApp(member, 'gcal', 'leaver@review.test');
    await jobs().drain();
    const removed = await w.post('/api/auth/organization/remove-member', { memberIdOrEmail: member.email, organizationId: w.workspaceId });
    expect(removed.status).toBe(200);
    await jobs().drain();
    expect(await rows('select status from connection where id = $1', [cal.connectionId])).toEqual([{ status: 'disconnected' }]);
    expect(fake().accounts.has(cal.account)).toBe(false);
    expect((await rows('select status from connection where id = $1', [box.connectionId]))[0]).toEqual({ status: 'active' });
    expect((await w.state()).conn.apps.gcal).toMatchObject({ connected: false });
  });

  it('deleting the workspace disconnects everything and switches sending off', async () => {
    const d = fake().deliver(box.account, { from: 'x@y.test', subject: 'After the end', body: 'hello' });
    const gone = await w.post('/api/auth/organization/delete', { organizationId: w.workspaceId });
    expect(gone.status).toBe(200);
    await jobs().drain();
    expect(await rows(`select status from connection where workspace_id = $1 and status <> 'disconnected'`, [w.workspaceId])).toEqual([]);
    expect((await rows<{ kill_switch: boolean }>('select kill_switch from workspace where id = $1', [w.workspaceId]))[0]!.kill_switch).toBe(true);
    const res = await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
    expect(res.status).toBe(200);
    expect(jobs().queue.filter((j) => j.name === 'mail.ingest')).toHaveLength(0);
  });
});

describe('5. the stream ends when membership does', () => {
  it('a tab whose person was removed gets nothing more', async () => {
    const got: string[] = [];
    let member = true;
    const sub = { workspaceId: w.workspaceId, rev: (await w.state()).rev, send: (e: string) => got.push(e), allowed: async () => member, checkedAt: 0 };
    const off = subscribe(sub);
    member = false;
    sub.checkedAt = 0;
    expect(await stillAllowed(sub)).toBe(false);
    await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'notes', item: { id: 'after-removal', text: 'secret' } }] });
    await new Promise((r) => setTimeout(r, 300));
    expect(got).toContain('gone');
    expect(got).not.toContain('patch');
    off();
  });
});

describe('6. which mailbox an email leaves from', () => {
  it('a workspace has one everyday mailbox; a second is refused', async () => {
    const res = await w.post('/api/v1/connections/gmail/connect', {});
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('owner@review.test');
    // Outlook can't be connected at all until Timmy reads it: there is no way round the one-mailbox rule through another provider.
    const outlook = await w.post('/api/v1/connections/outlook/connect', {});
    expect(outlook.status).toBe(400);
    expect(JSON.stringify(await outlook.json())).toContain('can’t be connected yet');
  });

  it('the approver is shown the mailbox it will be sent from', async () => {
    await w.cmd({ type: 'sendNew', draft: { to: ['mail:dana@client.test'], subject: 'From where', body: 'Hello' } });
    expect((await w.state()).pending[0]!.preview).toMatchObject({ from: 'owner@review.test', to: ['dana@client.test'] });
    const [e] = await effects();
    expect(e!.payload.connectionId).toBe(box.connectionId);
  });
});

describe('8. a send that waited for someone else', () => {
  it('shows as sent once it goes out, and a second press cannot send it again', async () => {
    await deliver(w, { from: 'Dana <dana@client.test>', subject: 'Board pack', body: 'Please send the board pack.' });
    const thread = (await w.state()).threads.find((t) => t.subject === 'Board pack')!;
    const ea = await addMember(w.workspaceId, 'assistant', 'Jess EA');
    await ea.cmd({ type: 'updateDraft', id: thread.id, body: 'Here is the board pack.' });
    await w.cmd({ type: 'makeDraft', id: thread.id });
    await jobs().drain();
    await ea.cmd({ type: 'updateDraft', id: thread.id, body: 'Here is the board pack.' });
    expect((await ea.cmd({ type: 'sendDraft', id: thread.id, track: false })).ok).toBe(true);
    const [e] = await effects();
    expect(e).toMatchObject({ status: 'intended', approver_route: 'exec' });
    // While it waits, pressing Send again does not make a second one.
    expect((await ea.cmd({ type: 'sendDraft', id: thread.id, track: false })).error).toMatch(/already has an email waiting/);
    expect((await w.cmd({ type: 'sendDraft', id: thread.id, track: false })).error).toMatch(/already has an email waiting/);
    await w.cmd({ type: 'effect', id: e!.id, approve: true });
    await releaseHolds(w);
    expect(sent()).toHaveLength(1);
    const after = (await w.state()).threads.find((t) => t.id === thread.id)!;
    expect(after.draft).toBeUndefined();
    expect(after.messages.filter((m) => m.from === 'me')).toHaveLength(1);
    expect(after.messages.some((m) => m.id === sent()[0]!.id)).toBe(true);
    // Nothing left to send: another press sends nothing.
    await w.cmd({ type: 'sendDraft', id: thread.id, track: false });
    await releaseHolds(w);
    expect(sent()).toHaveLength(1);
    expect(await effects()).toHaveLength(1);
  });

  it('an email Timmy prepared in chat is on the thread once sent, and the old draft is gone', async () => {
    await deliver(w, { from: 'Dana <dana@client.test>', subject: 'Contract', body: 'Where is the contract?' });
    const thread = (await w.state()).threads.find((t) => t.subject === 'Contract')!;
    await w.cmd({ type: 'makeDraft', id: thread.id });
    await jobs().drain();
    const ctx = { user: { id: w.userId, name: 'O', email: w.email }, workspaceId: w.workspaceId, role: 'owner', rules: rulesFor('owner') };
    await sysPool.query(`insert into run (id, workspace_id, user_id, kind, status, input, model, fence) values ('run_rev8', $1, $2, 'ask', 'running', '{}', 'm', 1)`, [w.workspaceId, w.userId]);
    const out = await TOOL_BY_NAME.send_reply!.run({ id: thread.id, body: 'It is attached.' }, { ctx, runId: 'run_rev8', fence: 1, callId: 'call-1', attended: true });
    expect('effect' in out).toBe(true);
    const [e] = await effects();
    await w.cmd({ type: 'effect', id: e!.id, approve: true });
    await releaseHolds(w);
    const after = (await w.state()).threads.find((t) => t.id === thread.id)!;
    expect(after.draft).toBeUndefined();
    expect(after.messages.filter((m) => m.from === 'me').map((m) => m.body.join(' '))).toEqual(['It is attached.']);
    expect(sent()).toHaveLength(1);
  });
});

describe('9. drafts cannot be swapped under the person who sends them', () => {
  it('a read-only role cannot write a draft through chat, and an existing draft is never replaced from chat', async () => {
    await deliver(w, { from: 'Dana <dana@client.test>', subject: 'Quote', body: 'Please send the quote.' });
    const thread = (await w.state()).threads.find((t) => t.subject === 'Quote')!;
    const revops = await addMember(w.workspaceId, 'revops');
    const tool = (c: Client, role: string) => TOOL_BY_NAME.draft_reply!.run({ id: thread.id, body: 'Swapped text.' }, { ctx: { user: { id: c.userId, name: role, email: c.email }, workspaceId: w.workspaceId, role, rules: rulesFor(role) }, runId: 'run_rev9', fence: 1, callId: 'c', attended: true });
    await sysPool.query(`insert into run (id, workspace_id, user_id, kind, status, input, model, fence) values ('run_rev9', $1, $2, 'ask', 'running', '{}', 'm', 1)`, [w.workspaceId, w.userId]);
    const refused = await tool(revops, 'revops');
    expect('result' in refused && refused.result).toMatch(/role can’t change drafts/);
    expect((await w.state()).threads.find((t) => t.id === thread.id)!.draft).toBeUndefined();
    await w.cmd({ type: 'updateDraft', id: thread.id, body: 'x' });
    await w.cmd({ type: 'makeDraft', id: thread.id });
    await jobs().drain();
    await w.cmd({ type: 'updateDraft', id: thread.id, body: 'The reviewed text.' });
    const kept = await tool(w, 'owner');
    expect('result' in kept && kept.result).toMatch(/already has a draft/);
    expect((await w.state()).threads.find((t) => t.id === thread.id)!.draft!.body).toBe('The reviewed text.');
  });

  it('Send is refused when the draft is not the one the person was looking at', async () => {
    await deliver(w, { from: 'Dana <dana@client.test>', subject: 'Seen', body: 'Question?' });
    const thread = (await w.state()).threads.find((t) => t.subject === 'Seen')!;
    await w.cmd({ type: 'makeDraft', id: thread.id });
    await jobs().drain();
    const shown = (await w.state()).threads.find((t) => t.id === thread.id)!.draft!;
    await w.cmd({ type: 'updateDraft', id: thread.id, body: 'Changed by someone else.' });
    const stale = await w.cmd({ type: 'sendDraft', id: thread.id, track: false, seen: draftHash(shown) });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/changed after you opened it/);
    expect(await effects()).toHaveLength(0);
    const current = (await w.state()).threads.find((t) => t.id === thread.id)!.draft!;
    expect((await w.cmd({ type: 'resolve', key: `draft:${thread.id}`, option: 'send', seen: draftHash(current) })).ok).toBe(true);
    await releaseHolds(w);
    expect(sent()[0]!.body).toBe('Changed by someone else.');
  });
});

describe('10. finishing a connection', () => {
  it('only the person who started it can finish it, and a disconnected one is never switched back on', async () => {
    fake().nextAddress = 'cal@review.test';
    const start = await w.json<{ redirectUrl: string; connectionId: string }>('POST', '/api/v1/connections/gcal/connect', {});
    fake().completeConnect(new URL(start.redirectUrl).searchParams.get('account')!);
    const client = await addMember(w.workspaceId, 'client');
    const member = await addMember(w.workspaceId, 'member');
    for (const other of [client, member]) {
      expect((await other.get(`/api/v1/connections/callback?c=${start.connectionId}`)).headers.get('location')).toMatch(/connect=failed/);
      expect((await rows('select status from connection where id = $1', [start.connectionId]))[0]).toEqual({ status: 'pending' });
    }
    expect((await w.get(`/api/v1/connections/callback?c=${start.connectionId}`)).headers.get('location')).toMatch(/connect=ok/);

    // Disconnect while the provider refuses to delete the account: it is unused on our side at once, and stays that way.
    const original = fake().disconnect.bind(fake());
    fake().disconnect = async () => {
      throw new Error('provider down');
    };
    await w.post('/api/v1/connections/gcal/disconnect', {});
    await jobs().drain().catch(() => {});
    fake().disconnect = original;
    expect((await rows('select status from connection where id = $1', [start.connectionId]))[0]).toEqual({ status: 'disconnected' });
    expect((await w.get(`/api/v1/connections/callback?c=${start.connectionId}`)).headers.get('location')).toMatch(/connect=failed/);
    expect((await rows('select status from connection where id = $1', [start.connectionId]))[0]).toEqual({ status: 'disconnected' });
    expect((await w.state()).conn.apps.gcal).toMatchObject({ connected: false });
  });
});

describe('11. test hooks and fake providers fail closed', () => {
  it('the server refuses to start with them in production, or on a deployed server without a token', () => {
    const saved = { ...config };
    try {
      Object.assign(config, { stage: 'production', fakeProviders: true });
      expect(() => assertSafeConfig()).toThrow(/cannot be switched on in production/);
      Object.assign(config, { stage: 'staging', fakeProviders: true, testHooks: true, publicUrl: 'https://app-staging.example.test', testToken: '' });
      expect(() => assertSafeConfig()).toThrow(/need TIMMY_TEST_TOKEN/);
      Object.assign(config, { testToken: 'x'.repeat(32) });
      expect(() => assertSafeConfig()).not.toThrow();
    } finally {
      Object.assign(config, saved);
    }
  });

  it('on a deployed server the hooks need the token, and the consent stand-in only returns to our own callback', async () => {
    const saved = { ...config };
    const app = await boot();
    try {
      Object.assign(config, { publicUrl: 'https://app-staging.example.test', testToken: 't'.repeat(32) });
      expect((await app.request('/api/test/outbox?to=a@b.test')).status).toBe(404);
      expect((await app.request('/api/test/outbox?to=a@b.test', { headers: { 'x-test-token': 'wrong' } })).status).toBe(404);
      expect((await app.request('/api/test/outbox?to=a@b.test', { headers: { 'x-test-token': 't'.repeat(32) } })).status).toBe(200);
      expect((await app.request('/api/test/fake-connect?account=x&to=https://evil.example/phish')).status).toBe(404);
    } finally {
      Object.assign(config, saved);
    }
  });

  it('the fake provider’s webhook secret is not a constant', () => {
    expect(fake().secret).not.toBe('fake-webhook-secret');
    expect(fake().secret.length).toBeGreaterThan(24);
  });
});

describe('12. answers say what actually happened', () => {
  it('declining something already sent says so; approving something undone says so; cancelling from Approvals puts the thread back', async () => {
    const first = await w.cmd({ type: 'sendNew', draft: { to: ['mail:dana@client.test'], subject: 'Held', body: 'Body' } });
    const [e] = await effects();
    const before = (await w.state()).threads.length;
    // Cancel from the Approvals queue: the thread is no longer shown as sent.
    const cancelled = await w.cmd({ type: 'resolve', key: `eff:${e!.id}`, option: 'undo' });
    expect(cancelled.ok).toBe(true);
    const s = await w.state();
    expect(s.threads.length).toBe(before - 1);
    expect(s.threads.some((t) => t.subject === 'Held')).toBe(false);
    expect(s.pending).toEqual([]);
    expect((await w.cmd({ type: 'effect', id: e!.id, approve: true })).error).toMatch(/already undone/);
    await releaseHolds(w);
    expect(sent()).toHaveLength(0);
    expect(first.ok).toBe(true);

    await w.cmd({ type: 'sendNew', draft: { to: ['mail:dana@client.test'], subject: 'Gone', body: 'Body' } });
    await releaseHolds(w);
    const done = (await effects())[1]!;
    const late = await w.cmd({ type: 'effect', id: done.id, approve: false });
    expect(late.ok).toBe(false);
    expect(late.error).toMatch(/already sent/);
  });
});

describe('14. one workspace cannot hold up another’s sends', () => {
  it('sends in a switched-off workspace are not offered to the sweep', async () => {
    const other = await newWorkspace('Stuck');
    await connectGmail(other, 'stuck@review.test');
    for (let i = 0; i < 3; i++) await other.cmd({ type: 'sendNew', draft: { to: ['mail:a@b.test'], subject: `S${i}`, body: 'b' } });
    await other.request('PATCH', '/api/v1/settings', { killSwitch: true });
    await w.cmd({ type: 'sendNew', draft: { to: ['mail:dana@client.test'], subject: 'Mine', body: 'b' } });
    await sysPool.query(`update effect set hold_until = now() where workspace_id = any($1)`, [[w.workspaceId, other.workspaceId]]);
    const due = await dueEffects(sysPool, 200);
    expect(due.some((d) => d.workspace_id === w.workspaceId)).toBe(true);
    expect(due.some((d) => d.workspace_id === other.workspaceId)).toBe(false);
  });

  it('an approval that sat unsent for a day is cancelled, not sent late', async () => {
    const { expireStaleApprovals, executeEffect } = await import('../src/gateway/gateway');
    await w.cmd({ type: 'sendNew', draft: { to: ['mail:dana@client.test'], subject: 'Old', body: 'b' } });
    const [e] = await effects();
    await sysPool.query(`alter table effect disable trigger effect_guard`);
    await sysPool.query(`update effect set approved_at = now() - interval '2 days', hold_until = now() - interval '2 days' where id = $1`, [e!.id]);
    await sysPool.query(`alter table effect enable trigger effect_guard`);
    expect(await expireStaleApprovals(sysPool)).toBeGreaterThanOrEqual(1);
    expect(await executeEffect(w.workspaceId, e!.id)).toBeNull();
    expect((await effects())[0]!.status).toBe('cancelled');
    expect(sent()).toHaveLength(0);
  });
});

describe('15. smaller gaps', () => {
  it('a reports-only role cannot read settings, usage or an effect', async () => {
    await w.cmd({ type: 'sendNew', draft: { to: ['mail:dana@client.test'], subject: 'S', body: 'b' } });
    const [e] = await effects();
    const client = await addMember(w.workspaceId, 'client');
    for (const path of ['/api/v1/settings', '/api/v1/usage', `/api/v1/effects/${e!.id}`]) expect((await client.get(path)).status, path).toBe(403);
  });

  it('a member cannot undo another person’s action; the owner can', async () => {
    const member = await addMember(w.workspaceId, 'member', 'M One');
    const other = await addMember(w.workspaceId, 'member', 'M Two');
    const made = await member.cmd({ type: 'sendNew', draft: { to: ['mail:dana@client.test'], subject: 'Theirs', body: 'b' } });
    expect((await other.cmd({ type: 'undo', command: made.id })).error).toMatch(/isn’t yours to undo/);
    expect((await effects())[0]!.status).toBe('approved');
    expect((await w.cmd({ type: 'undo', command: made.id })).ok).toBe(true);
    expect((await effects())[0]!.status).toBe('cancelled');
  });

  it('a recipient that is not one address is refused', async () => {
    for (const to of ['mail:a@x.test, b@y.test', 'mail:not-an-address', 'mail:a@x.test>']) {
      const out = await w.cmd({ type: 'sendNew', draft: { to: [to], subject: 'S', body: 'b' } });
      expect(out.ok, to).toBe(false);
    }
    expect(await effects()).toHaveLength(0);
  });

  it('delegate mode cannot be switched on as a setting; it is a role', async () => {
    const out = await w.cmd({ type: 'conn', op: { op: 'delegate', patch: { on: true } } });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/assistant role/);
    expect((await w.state()).conn.delegate.on).toBe(false);
  });

  it('what the approver was shown cannot be edited afterwards, even by the database owner', async () => {
    await w.cmd({ type: 'sendNew', draft: { to: ['mail:dana@client.test'], subject: 'Fixed', body: 'b' } });
    const [e] = await effects();
    for (const sql of [`update effect set preview = '{"to":["evil@x.test"]}'::jsonb where id = $1`, `update effect set approver_route = 'revops' where id = $1`, `update effect set on_behalf_of = 'someone' where id = $1`, `update effect set target = 'evil@x.test' where id = $1`]) {
      await expect(sysPool.query(sql, [e!.id]), sql).rejects.toThrow(/cannot change/);
    }
  });
});
