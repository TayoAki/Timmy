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
import { addMember, boot, connectApp, connectGmail, fake, jobs, model, newWorkspace, rows, type Client } from './helpers';

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

describe('a reply written in Gmail or Outlook ticks off what it does', () => {
  /** The person's own message on a thread, as their mailbox would show it once they send it there. */
  const sendFromMailbox = async (account: string, from: string, threadKey: string, body: string, at?: Date) => {
    const d = fake().deliver(account, { from, to: ['dana@acme.test'], subject: 'Re: mail', body, threadId: threadKey, labels: ['SENT'], ...(at ? { at } : {}) });
    await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
    await jobs().drain();
  };

  it('a Gmail reply ticks the reply-type to-do, says so, and leaves the email where it is with no write to the mailbox', async () => {
    const t = await deliver('Quote from Gmail');
    await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    await jobs().drain();
    const writesBefore = (await filings()).length;
    await addTasks(task('t-g', 'Reply to Dana with the quote', t.id), task('t-o', 'Book the kickoff', t.id));
    await sendFromMailbox(box.account, 'owner@follow.test', t.ext!.threadKey!, 'It is $58 per seat.');
    expect(await statusOf('t-g')).toBe('done');
    expect(await statusOf('t-o')).toBe('todo');
    const after = await threadOf(t.id);
    expect(after.box).toBe('follow-up');
    expect(after.history?.at(-1)?.text).toBe('Your reply in Gmail ticked off: Reply to Dana with the quote');
    expect((await w.state()).activity[0]!.text).toBe('Your reply in Gmail ticked off: Reply to Dana with the quote (“Quote from Gmail”)');
    expect((await filings()).length).toBe(writesBefore);
  });

  it('says when that was the last one; a promise, or a reply sent before the to-do was made, ticks nothing', async () => {
    const t = await deliver('Several replies');
    await addTasks(task('t-1', 'Send Dana the deck', t.id, { created: new Date(Date.now() - 60_000) }));
    // Sent an hour before the to-do existed: old mail read in late is not a reply to it.
    await sendFromMailbox(box.account, 'owner@follow.test', t.ext!.threadKey!, 'Deck attached.', new Date(Date.now() - 3600_000));
    expect(await statusOf('t-1')).toBe('todo');
    await sendFromMailbox(box.account, 'owner@follow.test', t.ext!.threadKey!, 'Thanks! I’ll send the deck tomorrow.');
    expect(await statusOf('t-1')).toBe('todo');
    await sendFromMailbox(box.account, 'owner@follow.test', t.ext!.threadKey!, 'Deck attached, as promised.');
    expect(await statusOf('t-1')).toBe('done');
    expect((await threadOf(t.id)).history?.at(-1)?.text).toBe('Your reply in Gmail ticked off: Send Dana the deck. All its to-dos are done');
  });

  it('Timmy’s own reply coming back from Gmail doesn’t tick or say anything twice', async () => {
    const t = await deliver('Sent from Timmy');
    await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    await addTasks(task('t-t', 'Reply to Dana', t.id));
    await w.cmd({ type: 'reply', id: t.id, body: 'Done, thanks.' });
    await w.post('/api/test/release-holds', {});
    await jobs().drain();
    const sent = fake().sent(box.account).at(-1)!;
    await sendFromMailbox(box.account, 'owner@follow.test', t.ext!.threadKey!, sent.body);
    const notes = ((await threadOf(t.id)).history ?? []).map((h) => h.text).filter((x) => /ticked off/.test(x));
    expect(notes).toEqual(['The reply ticked off: Reply to Dana']);
  });

  it('an Outlook reply ticks it too, and says Outlook', async () => {
    const ow = await newWorkspace('Follow Outlook');
    const out = await connectApp(ow, 'outlook', 'owner@outlook-follow.test');
    await jobs().drain();
    const d = fake().deliver(out.account, { from: 'Dana Whitfield <dana@acme.test>', subject: 'Outlook quote', body: 'Could you send the quote?' });
    await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
    await jobs().drain();
    const t = (await ow.state()).threads.find((x) => x.subject === 'Outlook quote')!;
    expect((await ow.cmd({ type: 'ws', ops: [{ op: 'put', col: 'tasks', item: task('t-ol', 'Send Dana the quote', t.id) }] })).ok).toBe(true);
    await sendFromMailbox(out.account, 'owner@outlook-follow.test', d.message.threadId, 'Quote attached.');
    const s = await ow.state();
    expect(s.ws.tasks['t-ol']!.status).toBe('done');
    expect(s.threads.find((x) => x.id === t.id)!.history?.at(-1)?.text).toBe('Your reply in Outlook ticked off: Send Dana the quote. All its to-dos are done');
  });
});

describe('the rule to file an email a reply in the mailbox finishes', () => {
  const reply = async (threadKey: string, body: string, at?: Date) => {
    const d = fake().deliver(box.account, { from: 'owner@follow.test', to: ['dana@acme.test'], subject: 'Re: mail', body, threadId: threadKey, labels: ['SENT'], ...(at ? { at } : {}) });
    const hook = async () => (await boot()).request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
    await hook();
    await jobs().drain();
    return hook;
  };
  const settings = (c: Client = w) => c.json<{ replyFiling: { on: boolean; since?: string } }>('GET', '/api/v1/settings');
  const switchRule = (on: boolean, c: Client = w) => c.request('PATCH', '/api/v1/settings', { replyFiling: on });
  const ready = async (subject: string, ...todos: string[]) => {
    const t = await deliver(subject);
    await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    await jobs().drain();
    await addTasks(...todos.map((title, i) => task(`t-${subject.replace(/\W/g, '')}-${i}`, title, t.id)));
    return t;
  };

  it('is off until an owner or admin switches it on; someone who may not change policy can’t', async () => {
    expect((await settings()).replyFiling).toEqual({ on: false });
    const member = await addMember(w.workspaceId, 'member');
    expect((await switchRule(true, member)).status).toBe(403);
    expect((await settings()).replyFiling.on).toBe(false);
    expect((await switchRule(true)).status).toBe(200);
    expect((await settings()).replyFiling.on).toBe(true);
    const [row] = await rows<{ action: string }>(`select action from audit_log where workspace_id = $1 and action like 'replyfiling.%' order by id desc limit 1`, [w.workspaceId]);
    expect(row!.action).toBe('replyfiling.switched_on');
  });

  it('on: the reply that finishes the to-dos archives the email in Timmy and in Gmail, through one record the rule approves', async () => {
    await switchRule(true);
    const t = await ready('Finished by Gmail', 'Reply to Dana with the quote');
    const hook = await reply(t.ext!.threadKey!, 'It is $58 per seat.');
    await jobs().drain();
    const after = await threadOf(t.id);
    expect(after.box).toBe('archived');
    expect(after.history?.at(-1)?.text).toBe('Your reply in Gmail finished its to-dos, so Timmy archived it, as your rule says');
    expect(labelsOf(t.ext!.threadKey!)).not.toContain('INBOX');
    const mine = (await filings()).filter((e) => (e.payload as { threadId?: string }).threadId === t.id && e.source === 'rule');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'mail.modify', status: 'completed', source: 'rule', approved_via: 'rule', requested_by: 'system' });
    // The same event delivered again writes nothing more.
    await hook();
    await jobs().drain();
    expect((await filings()).filter((e) => (e.payload as { threadId?: string }).threadId === t.id && e.source === 'rule')).toHaveLength(1);
  });

  it('on: a reply that asks them something moves it to Waiting, labelled so in Gmail', async () => {
    await switchRule(true);
    const t = await ready('Asked back', 'Send Dana the plan');
    await reply(t.ext!.threadKey!, 'Plan attached. Could you confirm the budget?');
    await jobs().drain();
    const after = await threadOf(t.id);
    expect(after.box).toBe('waiting');
    expect(after.waiting?.item).toBe('An answer to your email');
    expect(labelsOf(t.ext!.threadKey!)).toContain(LABEL_NAMES.waiting);
  });

  it('on: nothing is filed while another to-do is open, a draft waits, or for a reply written before it was switched on', async () => {
    const early = await ready('Written before', 'Send Dana the deck');
    // The to-do is older than the reply, and the reply is older than the rule.
    await w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'tasks', id: 't-Writtenbefore-0', patch: { created: new Date(Date.now() - 7200_000) } }] });
    const writtenAt = new Date(Date.now() - 3600_000);
    await switchRule(true);
    await reply(early.ext!.threadKey!, 'Deck attached.', writtenAt);
    expect(await statusOf('t-Writtenbefore-0')).toBe('done');
    expect((await threadOf(early.id)).box).toBe('follow-up');

    const open = await ready('Still open', 'Send Dana the deck', 'Book the kickoff');
    await reply(open.ext!.threadKey!, 'Deck attached.');
    expect((await threadOf(open.id)).box).toBe('follow-up');

    const drafted = await ready('Draft waiting', 'Reply to Dana');
    await w.cmd({ type: 'makeDraft', id: drafted.id });
    await jobs().drain();
    await reply(drafted.ext!.threadKey!, 'Quick answer: yes.');
    expect(await statusOf('t-Draftwaiting-0')).toBe('done');
    expect((await threadOf(drafted.id)).box).toBe('follow-up');
    await jobs().drain();
    expect((await filings()).filter((e) => e.source === 'rule')).toHaveLength(0);
  });

  it('off again: replies tick their to-dos and the email stays put', async () => {
    await switchRule(true);
    await switchRule(false);
    expect((await settings()).replyFiling.on).toBe(false);
    const t = await ready('Rule off', 'Reply to Dana');
    await reply(t.ext!.threadKey!, 'Yes, that works.');
    expect(await statusOf('t-Ruleoff-0')).toBe('done');
    expect((await threadOf(t.id)).box).toBe('follow-up');
  });
});
