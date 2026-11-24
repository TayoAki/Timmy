/**
 * The email follows its tasks (src/state/store.tsx, followTasks and doneByReply):
 *   - ticking off the last open to-do of an email in Triage or Follow Up files it: archived, or to Waiting when the
 *     person's own newest message asked for something; written to Gmail like any move, and Undo puts it all back;
 *   - a reply sent from Timmy ticks off the email's reply-type to-dos ("Reply to…", "Send…"), and any other to-do
 *     still open keeps the email in Follow Up instead of archiving it.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Thread } from '../../src/data/types';
import type { EffectRow } from '../src/gateway/gateway';
import { LABEL_NAMES } from '../src/sync/labels';
import { boot, connectGmail, fake, jobs, model, newWorkspace, rows, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };
const filings = () => rows<EffectRow>(`select * from effect where workspace_id = $1 and kind = 'mail.modify' order by created_at, id`, [w.workspaceId]);
const mailbox = () => fake().accounts.get(box.account)!;
const labelsOf = (threadKey: string) => {
  const names = new Map([...mailbox().labels].map(([name, id]) => [id, name]));
  const all = new Set(mailbox().messages.filter((m) => m.threadId === threadKey).flatMap((m) => m.labels));
  return [...all].map((id) => names.get(id) ?? id).sort();
};
const deliver = async (subject: string, body = 'Could you take a look?') => {
  await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Dana Whitfield <dana@acme.test>', subject, body } });
  await jobs().drain();
  return (await w.state()).threads.find((t) => t.subject === subject)!;
};
const threadOf = async (id: string) => (await w.state()).threads.find((t) => t.id === id)!;
const statusOf = async (id: string) => (await w.state()).ws.tasks[id]?.status;
const task = (id: string, title: string, thread: string, extra: Record<string, unknown> = {}) => ({ id, title, status: 'todo', priority: 'normal', created: new Date(), thread, ...extra });
const addTasks = async (...items: Record<string, unknown>[]) => expect((await w.cmd({ type: 'ws', ops: items.map((item) => ({ op: 'put', col: 'tasks', item })) })).ok).toBe(true);
const tick = (id: string, status = 'done') => w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'tasks', id, patch: { status } }], toast: `Done: ${id}`, undo: true });

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  model().reset();
  jobs().queue = [];
  w = await newWorkspace('Follow');
  box = await connectGmail(w, 'owner@follow.test');
  await jobs().drain();
});

describe('ticking off the last to-do files the email', () => {
  it('archives it, in Gmail too, with a line in its history; one Undo puts the email and the to-do back', async () => {
    const t = await deliver('Two things');
    await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    await jobs().drain();
    await addTasks(task('tsk-a', 'Send the deck', t.id), task('tsk-b', 'Book the room', t.id));
    await tick('tsk-a');
    await jobs().drain();
    expect((await threadOf(t.id)).box).toBe('follow-up');

    const last = await tick('tsk-b');
    expect(last.ok).toBe(true);
    await jobs().drain();
    const done = await threadOf(t.id);
    expect(done.box).toBe('archived');
    expect(done.history?.at(-1)?.text).toBe('Its to-dos are done; archived');
    expect(labelsOf(t.ext!.threadKey!)).not.toContain('INBOX');
    expect((await filings()).at(-1)).toMatchObject({ status: 'completed', source: 'user', approved_by: w.userId });
    expect((await w.state()).activity[0]!.text).toBe('“Two things” archived: its to-dos are done');

    expect((await w.cmd({ type: 'undo', command: last.id })).ok).toBe(true);
    await jobs().drain();
    expect((await threadOf(t.id)).box).toBe('follow-up');
    expect(await statusOf('tsk-b')).toBe('todo');
    expect(labelsOf(t.ext!.threadKey!)).toEqual(['INBOX', LABEL_NAMES['follow-up'], 'UNREAD'].sort());
  });

  it('moves it to Waiting when the person’s own newest message asked for something', async () => {
    const t = await deliver('Over to them');
    await addTasks(task('tsk-q', 'Draft the plan', t.id));
    // The person wrote last, asking a question (sent from Gmail; it arrives as their own message).
    const mine = fake().deliver(box.account, { from: 'owner@follow.test', to: ['dana@acme.test'], subject: 'Re: Over to them', body: 'Here is the plan. Could you confirm the budget?', threadId: t.ext!.threadKey, labels: ['SENT'] });
    await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: mine.webhook.headers, body: mine.webhook.body });
    await jobs().drain();
    const before = await threadOf(t.id);
    if (before.messages.at(-1)!.from !== 'me') return expect.fail('the stand-in did not record the person’s own message');
    await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    await tick('tsk-q');
    await jobs().drain();
    const after = await threadOf(t.id);
    expect(after.box).toBe('waiting');
    expect(after.waiting).toMatchObject({ on: before.messages[0]!.from, item: 'An answer to your email' });
    const due = new Date(after.waiting!.due!);
    expect([1, 2, 3, 4, 5]).toContain(due.getDay());
    expect(due.getTime()).toBeGreaterThan(Date.now() + 2 * 86400_000);
  });

  it('leaves it alone while another to-do is open, a draft waits, or it is in Read Through or Waiting; unticking moves nothing', async () => {
    const a = await deliver('Still open');
    const b = await deliver('Has a draft');
    const c = await deliver('Reference');
    for (const t of [a, b]) await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    await w.cmd({ type: 'move', id: c.id, box: 'read-through' });
    await w.cmd({ type: 'makeDraft', id: b.id });
    await jobs().drain();
    expect((await threadOf(b.id)).draft).toBeDefined();
    await addTasks(task('t-a1', 'Call Dana', a.id), task('t-a2', 'Sign the form', a.id), task('t-b', 'Check the numbers', b.id), task('t-c', 'Read the report', c.id));
    await tick('t-a1');
    await tick('t-b');
    await tick('t-c');
    await tick('t-a1', 'todo');
    await jobs().drain();
    expect((await threadOf(a.id)).box).toBe('follow-up');
    expect((await threadOf(b.id)).box).toBe('follow-up');
    expect((await threadOf(c.id)).box).toBe('read-through');
  });
});

describe('a reply ticks off what it does', () => {
  it('a reply-type to-do is ticked and, with nothing else open, the email is archived as before', async () => {
    const t = await deliver('Quote please');
    await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    await addTasks(task('t-r', 'Reply to Dana with the quote', t.id));
    const out = await w.cmd({ type: 'reply', id: t.id, body: 'It is $58 per seat.' });
    expect(out.ok).toBe(true);
    expect(await statusOf('t-r')).toBe('done');
    const after = await threadOf(t.id);
    expect(after.box).toBe('archived');
    expect(after.history?.some((h) => h.text === 'The reply ticked off: Reply to Dana with the quote')).toBe(true);
  });

  it('another to-do still open keeps the email in Follow Up instead of archiving it', async () => {
    const t = await deliver('Two asks');
    await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    await addTasks(task('t-s', 'Send Dana the deck', t.id), task('t-k', 'Book the kickoff', t.id));
    await w.cmd({ type: 'reply', id: t.id, body: 'Deck attached.' });
    expect(await statusOf('t-s')).toBe('done');
    expect(await statusOf('t-k')).toBe('todo');
    const after = (await threadOf(t.id)) as Thread;
    expect(after.box).toBe('follow-up');
    expect(after.history?.some((h) => h.text === 'Replied; 1 to-do still open, so it stays in [01] Follow Up')).toBe(true);
  });

  it('a reply that only promises ticks nothing', async () => {
    const t = await deliver('Later');
    await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    await addTasks(task('t-p', 'Send Dana the contract', t.id));
    await w.cmd({ type: 'reply', id: t.id, body: 'Thanks! I’ll send the contract tomorrow.' });
    expect(await statusOf('t-p')).toBe('todo');
  });

  it('sending Timmy’s draft ticks the reply-type to-do too, and Undo inside the send window takes it back', async () => {
    const t = await deliver('Draft it');
    await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    await addTasks(task('t-d', 'Answer Dana’s question', t.id));
    await w.cmd({ type: 'makeDraft', id: t.id });
    await jobs().drain();
    expect((await threadOf(t.id)).draft).toBeDefined();
    const sent = await w.cmd({ type: 'sendDraft', id: t.id, track: false });
    expect(sent.ok).toBe(true);
    expect(await statusOf('t-d')).toBe('done');
    expect((await threadOf(t.id)).box).toBe('archived');
    expect((await w.cmd({ type: 'undo', command: sent.id })).ok).toBe(true);
    expect(await statusOf('t-d')).toBe('todo');
  });
});
