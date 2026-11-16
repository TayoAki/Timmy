/**
 * Waiting: what the person asked someone for is tracked with a date, a nudge is drafted when the
 * date passes with no answer, and a reply ends the wait. Nothing here sends anything by itself.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultDue, wantsNudge } from '../src/agent/draft';
import { morningRun } from '../src/agent/morning';
import type { Thread } from '../../src/data/types';
import { draftHash } from '../../src/live/hash';
import { boot, connectGmail, fake, jobs, model, newWorkspace, releaseHolds, rows, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };
const DAY = 86400_000;
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const thread = async (subject: string) => (await w.state()).threads.find((t) => t.subject === subject)!;
const deliver = async (subject: string, extra: Record<string, unknown> = {}) => {
  await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Dana Whitfield <dana@acme.test>', subject, body: 'Here is where we are. What do you need from us?', ...extra } });
  await jobs().drain();
  return thread(subject);
};
/** Asks for a draft and returns the thread once the model has written it. */
const draft = async (t: Thread, answer: Record<string, unknown>) => {
  model().script.push({ content: JSON.stringify(answer) });
  await w.cmd({ type: 'makeDraft', id: t.id });
  await jobs().drain();
  return thread(t.subject);
};
/** Puts a thread in Waiting the way a person does: Timmy drafts a reply that asks for something, and they send and track it. */
const sendAndTrack = async (subject: string, due: Date | null) => {
  const t = await deliver(subject);
  const drafted = await draft(t, { body: 'Could you send the signed SOW?', track: { item: 'The signed SOW', due: due ? iso(due) : null } });
  const out = await w.cmd({ type: 'sendDraft', id: t.id, track: true, seen: draftHash(drafted.draft!) });
  expect(out.ok).toBe(true);
  await releaseHolds(w);
  await jobs().drain();
  return thread(subject);
};
const sent = () => fake().sent(box.account);

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  model().reset();
  jobs().queue = [];
  w = await newWorkspace('Waiting');
  box = await connectGmail(w, 'owner@waiting.test');
  await jobs().drain();
});

describe('the date someone is given', () => {
  it('is three working days out, at the end of the day, when the email names none', () => {
    const at = (s: string) => defaultDue(new Date(s));
    expect(at('2026-11-16T10:00:00').toString()).toContain('Thu Nov 19 2026 17:00'); // Monday
    expect(at('2026-11-19T10:00:00').toString()).toContain('Tue Nov 24 2026 17:00'); // Thursday, over a weekend
    expect(at('2026-11-21T10:00:00').toString()).toContain('Wed Nov 25 2026 17:00'); // Saturday
  });
});

describe('a draft that asks for something', () => {
  it('carries what the other person owes and by when, so it can be sent and tracked', async () => {
    const t = await deliver('Statement of work');
    const due = new Date(Date.now() + 5 * DAY);
    const drafted = await draft(t, { body: 'Could you send the signed SOW by then?', track: { item: 'The signed  SOW', due: iso(due) } });
    expect(drafted.draft).toMatchObject({ kind: 'reply', trackAs: { on: 'mail:dana@acme.test', item: 'The signed SOW' } });
    expect(iso(new Date(drafted.draft!.trackAs!.due))).toBe(iso(due));
  });

  it('gets the default date when the reply names none, and no tracking when it asks for nothing or the answer is not usable', async () => {
    const a = await draft(await deliver('No date'), { body: 'Could you send it over?', track: { item: 'The contract', due: null } });
    expect(iso(new Date(a.draft!.trackAs!.due))).toBe(iso(defaultDue()));
    // A date in the past or absurdly far out is not believed; the default is used instead.
    const b = await draft(await deliver('Past date'), { body: 'Send it.', track: { item: 'The deck', due: '2020-01-01' } });
    expect(iso(new Date(b.draft!.trackAs!.due))).toBe(iso(defaultDue()));
    for (const [subject, track] of [['Nothing asked', null], ['Not an object', 'yes'], ['No item', { item: '   ', due: null }]] as const) {
      const d = await draft(await deliver(subject), { body: 'Thanks, noted.', track });
      expect([subject, d.draft!.trackAs]).toEqual([subject, undefined]);
    }
  });

  it('“Send & track” sends the reply once, moves the thread to Waiting with the item and date, and labels it in the mailbox', async () => {
    const due = new Date(Date.now() + 4 * DAY);
    const t = await sendAndTrack('Statement of work', due);
    expect(t.box).toBe('waiting');
    expect(t.waiting).toMatchObject({ on: 'mail:dana@acme.test', item: 'The signed SOW' });
    expect(iso(new Date(t.waiting!.due!))).toBe(iso(due));
    expect(t.draft).toBeUndefined();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ to: ['dana@acme.test'], body: 'Could you send the signed SOW?' });
    const labels = fake().accounts.get(box.account)!;
    const waitingLabel = labels.labels.get('Timmy Waiting');
    expect(labels.messages.filter((m) => m.threadId === t.ext!.threadKey).some((m) => m.labels.includes(waitingLabel!))).toBe(true);
  });
});

describe('when the date passes with no answer', () => {
  it('a thread is due a nudge only when it is waiting, past its date, unanswered and has no draft', () => {
    const now = new Date('2026-11-20T12:00:00');
    const base = { id: 't', subject: 's', participants: ['me', 'mail:a@b.test'], box: 'waiting', messages: [{ id: 'm', from: 'me', to: ['mail:a@b.test'], at: new Date('2026-11-10'), body: ['x'] }], waiting: { on: 'mail:a@b.test', item: 'The SOW', due: new Date('2026-11-19'), since: new Date('2026-11-10') } } as unknown as Thread;
    expect(wantsNudge(base, now)).toBe(true);
    expect(wantsNudge({ ...base, waiting: { ...base.waiting!, due: new Date('2026-11-25') } }, now)).toBe(false);
    expect(wantsNudge({ ...base, box: 'follow-up' }, now)).toBe(false);
    expect(wantsNudge({ ...base, draft: { to: [], subject: '', body: 'x', sources: [] } }, now)).toBe(false);
    expect(wantsNudge({ ...base, messages: [...base.messages, { id: 'r', from: 'mail:a@b.test', to: ['me'], at: new Date('2026-11-18'), body: ['here'] }] }, now)).toBe(false);
    // No date was ever set: the default wait counts from when the thread went to Waiting.
    expect(wantsNudge({ ...base, waiting: { on: 'mail:a@b.test', item: 'A reply', since: new Date('2026-11-10') } }, now)).toBe(true);
    expect(wantsNudge({ ...base, waiting: { on: 'mail:a@b.test', item: 'A reply', since: new Date('2026-11-19') } }, now)).toBe(false);
  });

  it('the morning run drafts a nudge, which waits in Approvals and is not sent', async () => {
    const t = await sendAndTrack('Statement of work', new Date(Date.now() + 2 * DAY));
    const before = sent().length;
    // Not due yet: nothing is drafted.
    expect(await morningRun(w.workspaceId, new Date(Date.now() + DAY))).toMatchObject({ drafted: 0 });
    expect((await thread('Statement of work')).draft).toBeUndefined();

    model().script.push((req) => {
      const said = JSON.stringify(req.messages);
      expect(said).toContain('short follow-up email');
      expect(said).toContain('The signed SOW');
      return { content: JSON.stringify({ body: 'Hi Dana, do you have a date for the signed SOW?' }) };
    });
    const run = await morningRun(w.workspaceId, new Date(Date.now() + 3 * DAY));
    expect(run).toMatchObject({ nudged: 1 });
    const nudged = await thread('Statement of work');
    expect(nudged.draft).toMatchObject({ kind: 'nudge', to: ['mail:dana@acme.test'], body: 'Hi Dana, do you have a date for the signed SOW?', trackAs: { item: 'The signed SOW' } });
    expect(nudged.box).toBe('waiting');
    expect((await w.state()).activity[0]!.text).toMatch(/1 nudge drafted/);
    await releaseHolds(w);
    await jobs().drain();
    expect(sent()).toHaveLength(before);
    expect(await rows(`select 1 from usage_event where workspace_id = $1 and route = 'draft' and unattended`, [w.workspaceId])).toHaveLength(1);
    // The next morning does not draft a second one on top.
    expect(await morningRun(w.workspaceId, new Date(Date.now() + 4 * DAY))).not.toHaveProperty('nudged');
    expect(t.id).toBe(nudged.id);
  });

  it('sending the nudge keeps the thread in Waiting with a new date', async () => {
    await sendAndTrack('Statement of work', new Date(Date.now() + DAY));
    model().script.push({ content: JSON.stringify({ body: 'Any news on the SOW?' }) });
    await morningRun(w.workspaceId, new Date(Date.now() + 2 * DAY));
    const nudged = await thread('Statement of work');
    expect((await w.cmd({ type: 'sendDraft', id: nudged.id, track: true, seen: draftHash(nudged.draft!) })).ok).toBe(true);
    await releaseHolds(w);
    await jobs().drain();
    const after = await thread('Statement of work');
    expect(after.box).toBe('waiting');
    expect(new Date(after.waiting!.due!).getTime()).toBeGreaterThan(Date.now() + DAY);
    expect(sent().map((m) => m.body)).toEqual(['Could you send the signed SOW?', 'Any news on the SOW?']);
  });

  it('the Draft button on a thread you are waiting on writes a nudge, not a reply to yourself', async () => {
    const t = await sendAndTrack('Statement of work', new Date(Date.now() + 5 * DAY));
    model().script.push((req) => {
      expect(JSON.stringify(req.messages)).toContain('short follow-up email');
      return { content: JSON.stringify({ body: 'Checking in on the SOW.' }) };
    });
    await w.cmd({ type: 'makeDraft', id: t.id });
    await jobs().drain();
    expect((await thread('Statement of work')).draft).toMatchObject({ kind: 'nudge', to: ['mail:dana@acme.test'] });
  });
});

describe('when the answer arrives', () => {
  it('the thread comes back to the inbox, the wait is over, and a nudge that was drafted is dropped', async () => {
    const t = await sendAndTrack('Statement of work', new Date(Date.now() + DAY));
    model().script.push({ content: JSON.stringify({ body: 'Any news on the SOW?' }) });
    await morningRun(w.workspaceId, new Date(Date.now() + 2 * DAY));
    expect((await thread('Statement of work')).draft).toMatchObject({ kind: 'nudge' });

    await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Dana Whitfield <dana@acme.test>', subject: 'Re: Statement of work', body: 'Signed copy attached.', threadId: t.ext!.threadKey } });
    await jobs().drain();
    const back = await thread('Statement of work');
    expect(back.box).toBe('inbox');
    expect(back.waiting).toBeUndefined();
    expect(back.draft).toBeUndefined();
    expect(back.history!.at(-1)!.text).toMatch(/nudge Timmy drafted was dropped/);
    // And nothing is nudged the next morning.
    expect(await morningRun(w.workspaceId, new Date(Date.now() + 3 * DAY))).not.toHaveProperty('nudged');
  });

  it('only a nudge is dropped: a reply draft on the thread is kept when more mail arrives', async () => {
    const t = await deliver('Scope question');
    await draft(t, { body: 'Thanks, that covers it.', track: null });
    await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Dana Whitfield <dana@acme.test>', subject: 'Re: Scope question', body: 'PS: the invoice follows.', threadId: t.ext!.threadKey } });
    await jobs().drain();
    const after = await thread('Scope question');
    expect(after.messages).toHaveLength(2);
    expect(after.draft).toMatchObject({ kind: 'reply', body: 'Thanks, that covers it.' });
  });
});
