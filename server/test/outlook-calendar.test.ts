/**
 * Outlook's calendar: the same account as Outlook mail, read into the same store and shown on Timmy's calendar like
 * Google's, and written to under the same rules. Nothing is created, changed or deleted there except through an
 * approved effect record.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EffectRow } from '../src/gateway/gateway';
import { executeEffect, reconcileEffect } from '../src/gateway/gateway';
import type { FakeEvent } from '../src/testing/composio';
import { syncCalendar } from '../src/sync/calendar';
import { when } from '../src/sync/calendar-write';
import { fromOutlookEvent } from '../src/sync/outlook-calendar';
import { addMember, boot, connectApp, fake, jobs, newWorkspace, releaseHolds, rows, sysPool, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };
const base = Math.ceil(Date.now() / 3600_000) * 3600_000;
const at = (hoursFromNow: number) => new Date(base + hoursFromNow * 3600_000);
const iso = (hoursFromNow: number) => at(hoursFromNow).toISOString();
/** A time the way Outlook's calendar tools are given it: a wall clock, read in UTC. */
const wall = (hoursFromNow: number) => iso(hoursFromNow).slice(0, 19);

// Ids shaped like Outlook's: long, with characters Timmy's own ids never carry.
const SOLO = 'AAMkAGI2NGVhZTVlLTI1OGMtNDI4My1iZmE5-solo_AAA=';
const MEET = 'AAMkAGI2NGVhZTVlLTI1OGMtNDI4My1iZmE5-meet_AAA=';
const THEIRS = 'AAMkAGI2NGVhZTVlLTI1OGMtNDI4My1iZmE5-theirs_AAA=';

const outlook = () => fake().accounts.get(box.account)!;
const onOutlook = (id: string) => outlook().events.find((e) => e.id === id);
const calls = (slug?: string) => fake().calls.filter((c) => c.connectedAccountId === box.account && (!slug || c.slug === slug));
const writes = () => calls().filter((c) => /OUTLOOK_(CALENDAR_CREATE_EVENT|UPDATE_CALENDAR_EVENT|DELETE_CALENDAR_EVENT|CANCEL_EVENT)$/.test(c.slug));
const effects = (kind?: string) => rows<EffectRow>(`select * from effect where workspace_id = $1 and ($2::text is null or kind = $2) order by created_at, id`, [w.workspaceId, kind ?? null]);
const events = async (c: Client = w) => Object.values((await c.state()).ws.events);
const shown = async (title: string, c: Client = w) => (await events(c)).find((e) => e.title === title)!;
type Shown = Awaited<ReturnType<typeof shown>>;
const add = (c: Client, id: string, title: string, guests: string[] = [], more: Record<string, unknown> = {}) =>
  c.cmd({ type: 'ws', ops: [{ op: 'put', col: 'events', item: { id, title, start: at(24), end: at(25), kind: guests.length ? 'meeting' : 'focus', with: guests, ...more } }] });
const change = (c: Client, ev: Shown, patch: Record<string, unknown>) => c.cmd({ type: 'ws', ops: [{ op: 'put', col: 'events', item: { ...ev, ...patch } }] });
const remove = (c: Client, ev: Shown) => c.cmd({ type: 'ws', ops: [{ op: 'remove', col: 'events', id: ev.id }] });
const put = (e: Partial<FakeEvent> & { id: string; summary: string }, from = 26) => outlook().events.push({ start: iso(from), end: iso(from + 1), attendees: [], ...e });
/** What Composio sends when Outlook announces something on the account. */
const announce = async (slug: string, data: Record<string, unknown>) => {
  const said = fake().event(box.account, slug, data);
  return (await boot()).request('/api/hooks/composio', { method: 'POST', headers: said.webhook.headers, body: said.webhook.body });
};

beforeAll(async () => {
  await boot();
});
// Every test here connects a mailbox. None is left connected afterwards: the suites share one database, and the
// nightly mail check that a later file runs looks at every connected mailbox there is.
const used: string[] = [];
afterEach(async () => {
  await sysPool.query(`update connection set status = 'disconnected', disconnected_at = now() where status in ('active', 'pending') and workspace_id = any($1::text[])`, [used.splice(0)]);
});
// Nor is anything left waiting in the shared job queue or the stand-in provider.
afterAll(() => {
  jobs().queue = [];
  fake().failNext.clear();
});
beforeEach(async () => {
  jobs().queue = [];
  fake().failNext.clear();
  w = await newWorkspace('Redmond Calendar');
  used.push(w.workspaceId);
  box = await connectApp(w, 'outlook', 'owner@outlook.test');
  put({ id: SOLO, summary: 'Focus: write the proposal' }, 26);
  put({ id: MEET, summary: 'Pricing review', attendees: ['dana@client.test'], description: 'Bring the numbers.' }, 50);
  put({ id: THEIRS, summary: 'Their all-hands', attendees: ['owner@outlook.test', 'sam@corp.test'], organizer: 'boss@corp.test', location: 'Room 4B' }, 74);
});

describe('reading Outlook’s calendar', () => {
  it('turns Outlook’s event into the one shape Timmy stores, and reads a time only in the zone it asked for', () => {
    const raw = {
      id: MEET,
      subject: ' Pricing review ',
      start: { dateTime: '2026-11-20T15:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-11-20T15:30:00.0000000', timeZone: 'UTC' },
      isOrganizer: true,
      organizer: { emailAddress: { name: 'Owner', address: 'Owner@Outlook.test' } },
      attendees: [{ type: 'optional', status: { response: 'accepted' }, emailAddress: { name: 'Dana Whitfield', address: 'Dana@Client.test' } }],
      location: { displayName: 'Room 4B' },
      bodyPreview: 'Bring the numbers.\r\nAnd the contract.',
      type: 'singleInstance',
      seriesMasterId: null,
    };
    const e = fromOutlookEvent(raw, 'owner@outlook.test')!;
    expect(e).toMatchObject({ id: MEET, title: 'Pricing review', allDay: false, mine: true, organizer: 'owner@outlook.test', guests: ['dana@client.test'], location: 'Room 4B', note: 'Bring the numbers.\nAnd the contract.', noteWhole: true, recurring: false });
    expect(e.attendees).toEqual([{ email: 'dana@client.test', name: 'Dana Whitfield', response: 'accepted', optional: true }]);
    expect(e.start.toISOString()).toBe('2026-11-20T15:00:00.000Z');
    expect(e.end.toISOString()).toBe('2026-11-20T15:30:00.000Z');
    // Someone else's meeting: the organizer counts among the people on it, and it is not the account's to change.
    const theirs = fromOutlookEvent({ ...raw, isOrganizer: false, organizer: { emailAddress: { address: 'boss@corp.test' } }, attendees: [{ emailAddress: { address: 'owner@outlook.test' } }], type: 'occurrence' }, 'owner@outlook.test')!;
    expect(theirs).toMatchObject({ mine: false, guests: ['boss@corp.test'], recurring: true });
    // Without `isOrganizer` in the answer, an event is never taken for the account's own.
    expect(fromOutlookEvent({ ...raw, isOrganizer: undefined }, 'owner@outlook.test')!.mine).toBe(false);
    // A preview as long as Outlook's limit may have been cut short, so it is not taken for the whole description.
    expect(fromOutlookEvent({ ...raw, bodyPreview: 'x'.repeat(255) }, null)!.noteWhole).toBe(false);
    // A cancelled meeting, and a time in a zone that was not asked for, are left out rather than guessed at.
    expect(fromOutlookEvent({ ...raw, isCancelled: true }, null)).toBeNull();
    expect(fromOutlookEvent({ ...raw, start: { dateTime: '2026-11-20T15:00:00.0000000', timeZone: 'Pacific Standard Time' } }, null)).toBeNull();
    expect(fromOutlookEvent({ ...raw, start: { dateTime: '2026-11-20T07:00:00-08:00', timeZone: 'Pacific Standard Time' } }, null)!.start.toISOString()).toBe('2026-11-20T15:00:00.000Z');
  });

  it('connecting Outlook reads its calendar as well as its mail: the events are stored and shown like Google’s', async () => {
    expect(jobs().queue.map((j) => j.name).sort()).toEqual(['calendar.sync', 'mail.backfill']);
    await jobs().drain();
    const list = await events();
    expect(list.map((e) => e.title).sort()).toEqual(['Focus: write the proposal', 'Pricing review', 'Their all-hands']);
    // Ids on Timmy's calendar are made from a fingerprint of Outlook's, and are ones the app's own commands accept.
    for (const e of list) expect(e.id).toMatch(new RegExp(`^ocal-${box.connectionId.slice(-6)}-[0-9a-f]{24}$`));
    expect(await shown('Focus: write the proposal')).toMatchObject({ kind: 'focus', with: [] });
    const meeting = await shown('Pricing review');
    expect(meeting).toMatchObject({ kind: 'meeting', with: ['mail:dana@client.test'], note: 'Bring the numbers.' });
    expect(meeting.start.getTime()).toBe(at(50).getTime());
    expect(meeting.end.getTime()).toBe(at(51).getTime());
    expect(await shown('Their all-hands')).toMatchObject({ kind: 'meeting', with: ['mail:boss@corp.test', 'mail:sam@corp.test'], note: 'Room 4B' });

    const stored = await rows<{ external_id: string; subject: string; sender: string; meta: { mine: boolean; guests: string[]; shown: string } }>(`select external_id, subject, sender, meta from item where workspace_id = $1 and kind = 'event' order by occurred_at`, [w.workspaceId]);
    expect(stored.map((s) => [s.external_id, s.subject, s.sender, s.meta.mine, s.meta.guests])).toEqual([
      [SOLO, 'Focus: write the proposal', 'owner@outlook.test', true, []],
      [MEET, 'Pricing review', 'owner@outlook.test', true, ['dana@client.test']],
      [THEIRS, 'Their all-hands', 'boss@corp.test', false, ['boss@corp.test', 'sam@corp.test']],
    ]);
    expect(stored[1]!.meta.shown).toBe(meeting.id);

    // The same window as Google's: two weeks back, two months ahead, asked for in UTC, with who organizes each event.
    const asked = calls('OUTLOOK_GET_CALENDAR_VIEW')[0]!.args as { start_datetime: string; end_datetime: string; timezone: string; select: string[]; top: number };
    expect(asked).toMatchObject({ timezone: 'UTC', top: 100 });
    expect(asked.select).toContain('isOrganizer');
    expect(Math.round((Date.now() - new Date(asked.start_datetime).getTime()) / 86400_000)).toBe(14);
    expect(Math.round((new Date(asked.end_datetime).getTime() - Date.now()) / 86400_000)).toBe(60);
    // No Google tool is ever run on an Outlook account.
    expect(calls().filter((c) => c.slug.startsWith('GOOGLE'))).toEqual([]);
  });

  it('shows a repeating event as its single times, leaves out what is outside the window, and reads a long calendar page by page', async () => {
    put({ id: 'AAMkAGweekly-1=', summary: 'Weekly sync', recurring: true }, 100);
    put({ id: 'AAMkAGweekly-2=', summary: 'Weekly sync', recurring: true }, 268);
    put({ id: 'AAMkAGold=', summary: 'Long ago' }, -24 * 30);
    put({ id: 'AAMkAGfar=', summary: 'Far ahead' }, 24 * 90);
    for (let i = 0; i < 120; i++) put({ id: `AAMkAGbulk-${i}=`, summary: `Bulk ${i}` }, 300 + i);
    const out = await syncCalendar(w.workspaceId, box.connectionId);
    expect(out).toMatchObject({ events: 125, shown: 125, pages: 2 });
    const list = await events();
    expect(list.filter((e) => e.title === 'Weekly sync')).toHaveLength(2);
    expect(list.some((e) => e.title === 'Long ago' || e.title === 'Far ahead')).toBe(false);
    expect(calls('OUTLOOK_GET_CALENDAR_VIEW').map((c) => c.args.page_token)).toEqual([undefined, '100']);
  });
});

describe('keeping it current', () => {
  it('a change announced by Outlook is read again by the same job: the event is updated, not doubled, and a deleted one goes', async () => {
    await jobs().drain();
    const before = await shown('Pricing review');
    Object.assign(onOutlook(MEET)!, { summary: 'Pricing review (moved)', start: iso(52), end: iso(53) });
    expect((await announce('OUTLOOK_EVENT_CHANGE_TRIGGER', { event_type: 'updated', id: MEET })).status).toBe(200);
    // It is a calendar event, so the calendar is read. No mail is fetched for it.
    expect(jobs().queue.map((j) => j.name)).toEqual(['calendar.sync']);
    await jobs().drain();
    const after = await shown('Pricing review (moved)');
    expect(after.id).toBe(before.id);
    expect(after.start.getTime()).toBe(at(52).getTime());
    expect(await events()).toHaveLength(3);
    expect(await rows(`select subject from item where workspace_id = $1 and kind = 'event' and external_id = $2`, [w.workspaceId, MEET])).toEqual([{ subject: 'Pricing review (moved)' }]);

    outlook().events = outlook().events.filter((e) => e.id !== MEET);
    await announce('OUTLOOK_EVENT_CHANGE_TRIGGER', { event_type: 'deleted', id: MEET });
    await jobs().drain();
    expect((await events()).map((e) => e.title).sort()).toEqual(['Focus: write the proposal', 'Their all-hands']);
    expect(await rows(`select 1 from item where workspace_id = $1 and kind = 'event' and external_id = $2`, [w.workspaceId, MEET])).toEqual([]);
  });

  it('new mail on the same account does not set off a read of the calendar, and another workspace’s calendar is untouched', async () => {
    await jobs().drain();
    const other = await newWorkspace('Other Calendar');
    const message = fake().deliver(box.account, { from: 'Dana Whitfield <dana@client.test>', subject: 'Hello', body: 'Hi' });
    await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: message.webhook.headers, body: message.webhook.body });
    expect(jobs().queue.map((j) => j.name)).toEqual(['mail.ingest']);
    await jobs().drain();
    expect(await events(other)).toHaveLength(0);
    expect(await rows(`select 1 from item where workspace_id = $1`, [other.workspaceId])).toEqual([]);
  });

  it('disconnecting Outlook takes its events off the screens and out of the store', async () => {
    await jobs().drain();
    await add(w, 'ev-local', 'Made in Timmy, never sent', [], { start: at(200), end: at(201) });
    expect((await w.post('/api/v1/connections/outlook/disconnect', {})).status).toBe(200);
    // Off the screens at once; the stored copies are deleted by the job that follows.
    expect((await events()).map((e) => e.title)).toEqual(['Made in Timmy, never sent']);
    await jobs().drain();
    expect(await rows(`select 1 from item where workspace_id = $1`, [w.workspaceId])).toEqual([]);
    expect((await w.state()).conn.apps.outlook).toMatchObject({ connected: false });
  });
});

describe('an event added in Timmy', () => {
  beforeEach(async () => {
    await jobs().drain();
    fake().calls = [];
  });

  it('with no guests lands on Outlook once, after the undo window, and invites nobody', async () => {
    expect((await add(w, 'ev-focus', 'Focus: budget', [], { note: 'Spreadsheet first.' })).ok).toBe(true);
    const [e] = await effects();
    expect(e).toMatchObject({ kind: 'calendar.create', status: 'approved', source: 'user', approved_by: w.userId, approved_via: 'click' });
    expect(e!.hold_until).not.toBeNull();
    expect(e!.payload).toMatchObject({ connectionId: box.connectionId, title: 'Focus: budget', attendees: [] });
    expect(e!.preview).toMatchObject({ title: 'Add “Focus: budget” to your Outlook calendar' });
    expect(e!.preview.lines).toEqual([when(at(24), at(25)), 'On your calendar only; nobody is invited']);
    await jobs().drain();
    expect(writes()).toHaveLength(0);

    await releaseHolds(w);
    await releaseHolds(w);
    await Promise.all([executeEffect(w.workspaceId, e!.id), executeEffect(w.workspaceId, e!.id)]);
    // The time goes as a wall clock with its zone named, the note as plain text, and nobody is on the guest list.
    expect(calls('OUTLOOK_CALENDAR_CREATE_EVENT').map((c) => c.args)).toEqual([{ subject: 'Focus: budget', start_datetime: wall(24), end_datetime: wall(25), time_zone: 'UTC', body: 'Spreadsheet first.', is_html: false, attendees_info: [] }]);
    const made = outlook().events.find((x) => x.summary === 'Focus: budget')!;
    expect(made).toMatchObject({ start: iso(24), end: iso(25), attendees: [], invited: false, description: 'Spreadsheet first.' });
    expect(outlook().notices).toEqual([]);
    expect((await effects())[0]).toMatchObject({ status: 'completed', external_id: made.id });

    // It shows once: Outlook's copy takes the place of the one made in Timmy, and a sync does not add a second.
    let mine = (await events()).filter((x) => x.title === 'Focus: budget');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.id).toMatch(/^ocal-[a-z0-9]{6}-[0-9a-f]{24}$/);
    await syncCalendar(w.workspaceId, box.connectionId);
    mine = (await events()).filter((x) => x.title === 'Focus: budget');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'focus', note: 'Spreadsheet first.' });
    expect(calls().filter((c) => c.slug.startsWith('GOOGLE'))).toEqual([]);
  });

  it('with guests is approved like an email: Outlook invites them only after the undo window, and Undo means nobody is invited', async () => {
    const out = await add(w, 'ev-meet', 'Contract review', ['mail:dana@client.test', 'me']);
    const [e] = await effects();
    expect(e!.payload).toMatchObject({ attendees: ['dana@client.test'] });
    expect(e!.preview).toMatchObject({ to: ['dana@client.test'], subject: 'Contract review', title: 'Invite dana@client.test to “Contract review”' });
    expect(e!.preview.lines).toEqual([when(at(24), at(25)), 'Outlook sends an invitation to dana@client.test']);
    expect((await w.state()).pending[0]).toMatchObject({ kind: 'calendar', status: 'holding' });
    await jobs().drain();
    expect(writes()).toHaveLength(0);
    await releaseHolds(w);
    await releaseHolds(w);
    expect(calls('OUTLOOK_CALENDAR_CREATE_EVENT')).toHaveLength(1);
    expect(calls('OUTLOOK_CALENDAR_CREATE_EVENT')[0]!.args.attendees_info).toEqual([{ email: 'dana@client.test', type: 'required' }]);
    const made = outlook().events.find((x) => x.summary === 'Contract review')!;
    expect(made).toMatchObject({ attendees: ['dana@client.test'], invited: true });
    expect(outlook().notices).toEqual([{ about: 'invited', event: made.id, to: ['dana@client.test'] }]);
    expect(out.ok).toBe(true);

    const second = await add(w, 'ev-undone', 'Changed my mind', ['mail:sam@client.test']);
    expect((await w.cmd({ type: 'undo', command: second.id })).ok).toBe(true);
    await releaseHolds(w);
    await jobs().drain();
    expect(calls('OUTLOOK_CALENDAR_CREATE_EVENT')).toHaveLength(1);
    expect(outlook().notices).toHaveLength(1);
    expect(await shown('Changed my mind')).toBeUndefined();
  });

  it('an assistant’s invitation waits for the exec; nothing reaches Outlook until they approve', async () => {
    const assistant = await addMember(w.workspaceId, 'assistant', 'Jess EA');
    expect((await add(assistant, 'ev-ea', 'Board prep', ['mail:chair@board.test'])).ok).toBe(true);
    const [e] = await effects();
    expect(e).toMatchObject({ status: 'intended', approver_route: 'exec', requested_by: assistant.userId, approved_by: null });
    await releaseHolds(w);
    expect(writes()).toHaveLength(0);
    expect((await assistant.cmd({ type: 'effect', id: e!.id, approve: true })).ok).toBe(false);
    expect((await w.cmd({ type: 'effect', id: e!.id, approve: true })).ok).toBe(true);
    await releaseHolds(w);
    expect(outlook().events.find((x) => x.summary === 'Board prep')).toMatchObject({ invited: true, attendees: ['chair@board.test'] });
  });

  it('a timeout after Outlook made the event is confirmed from the calendar, and the event is not made a second time', async () => {
    fake().failNext.set('OUTLOOK_CALENDAR_CREATE_EVENT', 'sent-then-timeout');
    await add(w, 'ev-meet', 'Lost answer', ['mail:dana@client.test']);
    await releaseHolds(w);
    const [e] = await effects();
    expect(e!.status).toBe('uncertain');
    await releaseHolds(w);
    expect(await executeEffect(w.workspaceId, e!.id)).toBeNull();
    expect(await reconcileEffect(w.workspaceId, e!.id)).toMatchObject({ status: 'completed' });
    expect(calls('OUTLOOK_CALENDAR_CREATE_EVENT')).toHaveLength(1);
    expect(outlook().events.filter((x) => x.summary === 'Lost answer')).toHaveLength(1);
    const mine = (await events()).filter((x) => x.title === 'Lost answer');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.id).toMatch(/^ocal-/);
  });

  it('a refusal by Outlook is recorded as failed, and the event stays in Timmy only', async () => {
    fake().failNext.set('OUTLOOK_CALENDAR_CREATE_EVENT', 'error');
    await add(w, 'ev-focus', 'Focus: refused');
    await releaseHolds(w);
    await releaseHolds(w);
    expect((await effects())[0]).toMatchObject({ status: 'failed' });
    expect(calls('OUTLOOK_CALENDAR_CREATE_EVENT')).toHaveLength(1);
    expect(await shown('Focus: refused')).toMatchObject({ id: 'ev-focus' });
  });
});

describe('changing and deleting an Outlook event', () => {
  beforeEach(async () => {
    await jobs().drain();
    fake().calls = [];
  });

  it('a new time is written once, after the undo window; with nobody on the event nobody is told', async () => {
    const ev = await shown('Focus: write the proposal');
    const out = await change(w, ev, { start: at(28), end: at(29) });
    expect(out.toast?.text).toBe('Changing “Focus: write the proposal” on the calendar in 30 seconds. Undo to stop it.');
    const [e] = await effects();
    expect(e).toMatchObject({ kind: 'calendar.update', status: 'approved', approved_via: 'click' });
    expect(e!.payload).toMatchObject({ connectionId: box.connectionId, externalId: SOLO, eventId: ev.id, changed: ['time'] });
    expect(e!.preview).toMatchObject({ title: `Move “Focus: write the proposal” to ${when(at(28), at(29))} on your Outlook calendar` });
    await jobs().drain();
    expect(writes()).toHaveLength(0);
    await releaseHolds(w);
    await releaseHolds(w);
    await Promise.all([executeEffect(w.workspaceId, e!.id), executeEffect(w.workspaceId, e!.id)]);
    expect(calls('OUTLOOK_UPDATE_CALENDAR_EVENT').map((c) => c.args)).toEqual([{ event_id: SOLO, start_datetime: wall(28), end_datetime: wall(29), time_zone: 'UTC' }]);
    expect(onOutlook(SOLO)).toMatchObject({ summary: 'Focus: write the proposal', start: iso(28), end: iso(29) });
    expect(outlook().notices).toEqual([]);
    // The next read shows one event, at its new time.
    await jobs().drain();
    const list = (await events()).filter((x) => x.title === 'Focus: write the proposal');
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(ev.id);
    expect(list[0]!.start.getTime()).toBe(at(28).getTime());
  });

  it('with guests the record says who Outlook tells and the old and new time, and nothing is written before the window ends', async () => {
    const out = await change(w, await shown('Pricing review'), { start: at(52), end: at(53), title: 'Pricing review, round two', note: 'Bring the numbers. And the contract.' });
    expect(out.toast?.text).toBe('Changing “Pricing review” on the calendar in 30 seconds; dana@client.test will be told. Undo to stop it.');
    const [e] = await effects();
    expect(e).toMatchObject({ status: 'approved', target: 'dana@client.test' });
    expect(e!.preview.lines).toEqual([
      `Now: ${when(at(50), at(51))}`,
      `Moves to: ${when(at(52), at(53))}`,
      'Renamed from “Pricing review” to “Pricing review, round two”',
      'The description becomes: Bring the numbers. And the contract.',
      'Outlook tells dana@client.test about the change',
    ]);
    await jobs().drain();
    expect(writes()).toHaveLength(0);
    expect(outlook().notices).toEqual([]);
    await releaseHolds(w);
    expect(calls('OUTLOOK_UPDATE_CALENDAR_EVENT').map((c) => c.args)).toEqual([{ event_id: MEET, subject: 'Pricing review, round two', start_datetime: wall(52), end_datetime: wall(53), time_zone: 'UTC', body: { contentType: 'Text', content: 'Bring the numbers. And the contract.' } }]);
    expect(outlook().notices).toEqual([{ about: 'changed', event: MEET, to: ['dana@client.test'] }]);
    expect(onOutlook(MEET)!.attendees).toEqual(['dana@client.test']);
  });

  it('a new guest list is sent whole, as Outlook wants it, and everyone on it before or after is told', async () => {
    await change(w, await shown('Pricing review'), { with: ['mail:dana@client.test', 'mail:sam@client.test'] });
    expect((await effects())[0]!.preview.to).toEqual(['dana@client.test', 'sam@client.test']);
    await releaseHolds(w);
    expect(calls('OUTLOOK_UPDATE_CALENDAR_EVENT').map((c) => c.args)).toEqual([
      { event_id: MEET, attendees: [{ emailAddress: { address: 'dana@client.test' }, type: 'required' }, { emailAddress: { address: 'sam@client.test' }, type: 'required' }] },
    ]);
    expect(outlook().notices).toEqual([{ about: 'changed', event: MEET, to: ['dana@client.test', 'sam@client.test'] }]);
  });

  it('an assistant’s change waits for the exec, and the event stays as Outlook has it until then', async () => {
    const assistant = await addMember(w.workspaceId, 'assistant', 'Jess EA');
    await change(assistant, await shown('Pricing review', assistant), { start: at(52), end: at(53) });
    const [e] = await effects();
    expect(e).toMatchObject({ kind: 'calendar.update', status: 'intended', approver_route: 'exec' });
    expect((await shown('Pricing review')).start.getTime()).toBe(at(50).getTime());
    await releaseHolds(w);
    expect(writes()).toHaveLength(0);
    expect((await w.cmd({ type: 'effect', id: e!.id, approve: true })).ok).toBe(true);
    await releaseHolds(w);
    expect(calls('OUTLOOK_UPDATE_CALENDAR_EVENT')).toHaveLength(1);
    expect((await shown('Pricing review')).start.getTime()).toBe(at(52).getTime());
  });

  it('an event with nobody on it is deleted; a meeting is cancelled, which is what tells its attendees', async () => {
    const solo = await remove(w, await shown('Focus: write the proposal'));
    const meet = await remove(w, await shown('Pricing review'));
    expect(solo.toast?.text).toBe('Deleting “Focus: write the proposal” from the calendar in 30 seconds. Undo to stop it.');
    expect(meet.toast?.text).toBe('Cancelling “Pricing review” in 30 seconds; dana@client.test will be told. Undo to stop it.');
    const list = await effects('calendar.delete');
    expect(list.map((e) => e.status)).toEqual(['approved', 'approved']);
    expect(list[1]!.preview).toMatchObject({ to: ['dana@client.test'], title: 'Cancel “Pricing review” and tell dana@client.test' });
    expect(list[1]!.preview.lines).toEqual([when(at(50), at(51)), 'Outlook tells dana@client.test it is cancelled']);
    await jobs().drain();
    expect(writes()).toHaveLength(0);
    await releaseHolds(w);
    await releaseHolds(w);
    expect(calls('OUTLOOK_DELETE_CALENDAR_EVENT').map((c) => c.args)).toEqual([{ event_id: SOLO }]);
    expect(calls('OUTLOOK_CANCEL_EVENT').map((c) => c.args)).toEqual([{ user_id: 'me', event_id: MEET }]);
    expect(outlook().notices).toEqual([{ about: 'cancelled', event: MEET, to: ['dana@client.test'] }]);
    expect(outlook().events.map((e) => e.id)).toEqual([THEIRS]);
    await jobs().drain();
    expect((await events()).map((e) => e.title)).toEqual(['Their all-hands']);
    expect((await rows<{ external_id: string }>(`select external_id from item where workspace_id = $1 and kind = 'event'`, [w.workspaceId])).map((r) => r.external_id)).toEqual([THEIRS]);
  });

  it('Undo inside the window writes nothing to Outlook', async () => {
    const moved = await change(w, await shown('Pricing review'), { start: at(52), end: at(53) });
    expect((await w.cmd({ type: 'undo', command: moved.id })).ok).toBe(true);
    const gone = await remove(w, await shown('Focus: write the proposal'));
    expect((await w.cmd({ type: 'undo', command: gone.id })).ok).toBe(true);
    await releaseHolds(w);
    await jobs().drain();
    expect(writes()).toHaveLength(0);
    expect(outlook().notices).toEqual([]);
    expect((await effects()).map((e) => e.status)).toEqual(['cancelled', 'cancelled']);
    expect((await shown('Pricing review')).start.getTime()).toBe(at(50).getTime());
    expect(await shown('Focus: write the proposal')).toBeTruthy();
  });

  it('a timeout after Outlook took the change, or cancelled the meeting, is settled by looking at the calendar and never written again', async () => {
    fake().failNext.set('OUTLOOK_UPDATE_CALENDAR_EVENT', 'sent-then-timeout');
    await change(w, await shown('Focus: write the proposal'), { start: at(28), end: at(29) });
    fake().failNext.set('OUTLOOK_CANCEL_EVENT', 'sent-then-timeout');
    await remove(w, await shown('Pricing review'));
    await releaseHolds(w);
    const list = await effects();
    expect(list.map((e) => e.status)).toEqual(['uncertain', 'uncertain']);
    await releaseHolds(w);
    for (const e of list) expect(await executeEffect(w.workspaceId, e.id)).toBeNull();
    for (const e of list) expect(await reconcileEffect(w.workspaceId, e.id)).toMatchObject({ status: 'completed' });
    expect(calls('OUTLOOK_UPDATE_CALENDAR_EVENT')).toHaveLength(1);
    expect(calls('OUTLOOK_CANCEL_EVENT')).toHaveLength(1);
    expect(outlook().notices).toEqual([{ about: 'cancelled', event: MEET, to: ['dana@client.test'] }]);
    await jobs().drain();
    expect((await shown('Focus: write the proposal')).start.getTime()).toBe(at(28).getTime());
    expect(await shown('Pricing review')).toBeUndefined();
  });

  it('a timeout with no trace on the calendar stays unconfirmed and is never written again', async () => {
    fake().failNext.set('OUTLOOK_UPDATE_CALENDAR_EVENT', 'timeout');
    await change(w, await shown('Focus: write the proposal'), { start: at(28), end: at(29) });
    await releaseHolds(w);
    const [e] = await effects();
    expect(e!.status).toBe('uncertain');
    await reconcileEffect(w.workspaceId, e!.id);
    await executeEffect(w.workspaceId, e!.id);
    await jobs().drain();
    expect((await effects())[0]!.status).toBe('uncertain');
    expect(calls('OUTLOOK_UPDATE_CALENDAR_EVENT')).toHaveLength(1);
    expect((await shown('Focus: write the proposal')).start.getTime()).toBe(at(26).getTime());
  });

  it('an event someone else organizes can’t be changed or deleted, and Outlook is never asked to', async () => {
    const ev = await shown('Their all-hands');
    const moved = await change(w, ev, { start: at(76), end: at(77) });
    expect(moved.ok).toBe(false);
    expect(moved.error).toBe('“Their all-hands” is organized by boss@corp.test, so it can’t be changed from Timmy. Ask them to change it.');
    const gone = await remove(w, ev);
    expect(gone.ok).toBe(false);
    expect(gone.error).toBe('“Their all-hands” is organized by boss@corp.test, so it can’t be deleted from Timmy. To take it off your calendar, decline it in Outlook.');
    expect(await effects()).toHaveLength(0);
    expect(calls()).toEqual([]);

    // And if the store is behind, the calendar's own word is taken right before writing.
    await remove(w, await shown('Pricing review'));
    onOutlook(MEET)!.organizer = 'boss@corp.test';
    await releaseHolds(w);
    expect((await effects())[0]).toMatchObject({ status: 'failed', error: 'boss@corp.test organizes this event, so it can’t be deleted from Timmy.' });
    expect(writes()).toHaveLength(0);
    expect(outlook().notices).toEqual([]);
  });
});

describe('with a Google Calendar connected as well', () => {
  it('a new event goes to the calendar that was connected first, and each event is changed on the calendar it lives on', async () => {
    await jobs().drain();
    const google = await connectApp(w, 'gcal', 'owner@gmail.test');
    fake().accounts.get(google.account)!.events.push({ id: 'gev1', summary: 'On Google', start: iso(30), end: iso(31), attendees: [] });
    await jobs().drain();
    fake().calls = [];
    expect((await events()).map((e) => e.title).sort()).toEqual(['Focus: write the proposal', 'On Google', 'Pricing review', 'Their all-hands']);

    await add(w, 'ev-new', 'Where does this go');
    await change(w, await shown('On Google'), { title: 'On Google, renamed' });
    await change(w, await shown('Focus: write the proposal'), { title: 'On Outlook, renamed' });
    await releaseHolds(w);
    // Outlook was connected first, so the new event is made there.
    expect(outlook().events.some((e) => e.summary === 'Where does this go')).toBe(true);
    expect(fake().accounts.get(google.account)!.events.map((e) => e.summary)).toEqual(['On Google, renamed']);
    expect(onOutlook(SOLO)!.summary).toBe('On Outlook, renamed');
    expect(fake().calls.filter((c) => c.connectedAccountId === google.account).map((c) => c.slug)).toEqual(['GOOGLECALENDAR_EVENTS_GET', 'GOOGLECALENDAR_PATCH_EVENT']);
    expect(calls().map((c) => c.slug).sort()).toEqual(['OUTLOOK_CALENDAR_CREATE_EVENT', 'OUTLOOK_GET_EVENT', 'OUTLOOK_UPDATE_CALENDAR_EVENT']);
  });

  it('when Google Calendar was connected first, the new event goes there', async () => {
    const first = await newWorkspace('Google First');
    used.push(first.workspaceId);
    const google = await connectApp(first, 'gcal', 'owner@gmail.test');
    const later = await connectApp(first, 'outlook', 'owner@later.test');
    await jobs().drain();
    await add(first, 'ev-new', 'Where does this go');
    await first.post('/api/test/release-holds', {});
    expect(fake().accounts.get(google.account)!.events.map((e) => e.summary)).toEqual(['Where does this go']);
    expect(fake().accounts.get(later.account)!.events).toEqual([]);
  });
});
