/**
 * Four gaps in the calendars, closed:
 *   - an Outlook account connected without permission for its calendar is noticed once, left alone after that, and
 *     the Connections card says to connect it again; connecting again clears it;
 *   - every connected calendar is read again each night, so a quiet one keeps up with its moving window;
 *   - an event changed while its create is still waiting reaches the calendar, once, under the same approval rules;
 *   - a deletion whose outcome was unknown is settled by asking for the event by its id, not by its absence from the window.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectRow } from '../src/gateway/gateway';
import { reconcileEffect } from '../src/gateway/gateway';
import type { FakeEvent } from '../src/testing/composio';
import { syncCalendar } from '../src/sync/calendar';
import { refusedForPermission } from '../src/sync/calendar-access';
import { addMember, boot, connectApp, fake, jobs, newWorkspace, releaseHolds, rows, sysPool, type Client } from './helpers';

const base = Math.ceil(Date.now() / 3600_000) * 3600_000;
const at = (hoursFromNow: number) => new Date(base + hoursFromNow * 3600_000);
const iso = (hoursFromNow: number) => at(hoursFromNow).toISOString();
const DAYS = 24;
/** What an Outlook account was allowed before Nov 17: its mail and the profile, not the calendar. */
const MAIL_ONLY = ['Mail.ReadWrite', 'Mail.Send', 'User.Read', 'offline_access'];

const used: string[] = [];
const account = (a: { account: string }) => fake().accounts.get(a.account)!;
const callsOf = (a: { account: string }, slug?: string) => fake().calls.filter((c) => c.connectedAccountId === a.account && (!slug || c.slug === slug));
const effects = (w: Client, kind?: string) => rows<EffectRow>(`select * from effect where workspace_id = $1 and ($2::text is null or kind = $2) order by created_at, id`, [w.workspaceId, kind ?? null]);
const events = async (w: Client) => Object.values((await w.state()).ws.events);
const shown = async (w: Client, title: string) => (await events(w)).find((e) => e.title === title);
const put = (a: { account: string }, e: Partial<FakeEvent> & { id: string; summary: string }, from = 26) => account(a).events.push({ start: iso(from), end: iso(from + 1), attendees: [], ...e });
async function workspace(name: string) {
  const w = await newWorkspace(name);
  used.push(w.workspaceId);
  return w;
}
/** The nightly pass reads every connected calendar in the database. Other files' calendars are put out of its way. */
const onlyThese = () => sysPool.query(`update connection set status = 'disconnected', disconnected_at = now() where status = 'active' and toolkit in ('googlecalendar', 'outlook') and not (workspace_id = any($1::text[]))`, [used]);

beforeAll(async () => {
  await boot();
});
beforeEach(() => {
  jobs().queue = [];
  fake().failNext.clear();
});
// Nothing this file connects is left connected: a later file's nightly sweeps look at every connected account there is.
afterEach(async () => {
  vi.useRealTimers();
  fake().nextScopes = null;
  await sysPool.query(`update connection set status = 'disconnected', disconnected_at = now() where status in ('active', 'pending') and workspace_id = any($1::text[])`, [used.splice(0)]);
});
afterAll(() => {
  jobs().queue = [];
  fake().failNext.clear();
});

/* ═════════════════════════════ 1. Outlook connected without its calendar ═════════════════════════════ */

describe('an Outlook account connected without permission for its calendar', () => {
  it('tells a refusal for lack of permission apart from a passing failure', () => {
    expect(refusedForPermission('403 Forbidden: {"error":{"code":"ErrorAccessDenied","message":"Access is denied. Check credentials and try again."}}')).toBe(true);
    expect(refusedForPermission('Access is denied. Check credentials and try again.')).toBe(true);
    expect(refusedForPermission('Insufficient privileges to complete the operation. (Authorization_RequestDenied)')).toBe(true);
    expect(refusedForPermission('Missing required scopes: Calendars.Read')).toBe(true);
    for (const passing of ['The specified object was not found in the store. (ErrorItemNotFound)', 'ETIMEDOUT', 'Too many requests (429)', 'The provider refused the request (fake)', '', null]) expect(refusedForPermission(passing)).toBe(false);
  });

  it('is noticed on the first read: recorded on the connection and on the card, and the calendar is not asked again', async () => {
    const w = await workspace('NoCalendar');
    fake().nextScopes = MAIL_ONLY;
    const box = await connectApp(w, 'outlook', 'old@outlook.test');
    await jobs().drain();
    // The mail is read as usual; the calendar was asked once and refused.
    expect(callsOf(box, 'OUTLOOK_LIST_MESSAGES').length).toBeGreaterThan(0);
    expect(callsOf(box, 'OUTLOOK_GET_CALENDAR_VIEW')).toHaveLength(1);
    const [conn] = await rows<{ meta: Record<string, unknown> }>('select meta from connection where id = $1', [box.connectionId]);
    expect(typeof conn!.meta.calendarRefused).toBe('string');
    // The Connections screen's copy of the app carries the mark its card reads; the account is still connected for mail.
    expect((await w.state()).conn.apps.outlook).toMatchObject({ connected: true, account: 'old@outlook.test', calendarRefused: true });
    expect(await rows(`select action from audit_log where workspace_id = $1 and action = 'connection.calendar_refused'`, [w.workspaceId])).toHaveLength(1);
    // Microsoft would not announce calendar changes to it either, so no event subscription was made.
    expect([...fake().triggers.values()].filter((t) => t.connectedAccountId === box.account).map((t) => t.slug).sort()).toEqual(['OUTLOOK_MESSAGE_TRIGGER', 'OUTLOOK_SENT_MESSAGE_TRIGGER']);

    // Nothing asks it again: not a read queued by an announcement or a write, not the nightly pass, not a direct sync.
    await jobs().enqueue('calendar.sync', { workspaceId: w.workspaceId, connectionId: box.connectionId });
    await onlyThese();
    await jobs().enqueue('calendar.sync.all', {});
    await jobs().drain();
    expect(await syncCalendar(w.workspaceId, box.connectionId)).toMatchObject({ events: 0, pages: 0 });
    expect(callsOf(box, 'OUTLOOK_GET_CALENDAR_VIEW')).toHaveLength(1);
    expect(await rows(`select 1 from audit_log where workspace_id = $1 and action = 'connection.calendar_refused'`, [w.workspaceId])).toHaveLength(1);

    // An event added in Timmy stays on Timmy's calendar: it is not sent to a calendar that refuses it.
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'events', item: { id: 'ev-local', title: 'Dentist', start: at(30), end: at(31), kind: 'personal', with: [] } }] })).ok).toBe(true);
    expect(await effects(w, 'calendar.create')).toEqual([]);
    expect(await shown(w, 'Dentist')).toMatchObject({ id: 'ev-local' });
  });

  it('a passing failure is not taken for a refusal: the read fails, to be tried again, and nothing is recorded', async () => {
    const w = await workspace('BusyCalendar');
    const box = await connectApp(w, 'outlook', 'busy@outlook.test');
    jobs().queue = [];
    fake().failNext.set('OUTLOOK_GET_CALENDAR_VIEW', 'error');
    await expect(syncCalendar(w.workspaceId, box.connectionId)).rejects.toThrow(/refused the request/);
    const [conn] = await rows<{ meta: Record<string, unknown> }>('select meta from connection where id = $1', [box.connectionId]);
    expect(conn!.meta.calendarRefused).toBeUndefined();
    expect((await w.state()).conn.apps.outlook!.calendarRefused).toBeUndefined();
    put(box, { id: 'AAMkAGbusy=', summary: 'Standup' });
    expect(await syncCalendar(w.workspaceId, box.connectionId)).toMatchObject({ events: 1 });
  });

  it('connecting Outlook again, with the calendar allowed, clears it: the calendar is read and its events are shown', async () => {
    const w = await workspace('Reconnect');
    fake().nextScopes = MAIL_ONLY;
    const old = await connectApp(w, 'outlook', 'again@outlook.test');
    await jobs().drain();
    expect((await w.state()).conn.apps.outlook!.calendarRefused).toBe(true);

    expect((await w.post('/api/v1/connections/outlook/disconnect', {})).status).toBe(200);
    await jobs().drain();
    expect((await w.state()).conn.apps.outlook).toEqual({ connected: false });

    const box = await connectApp(w, 'outlook', 'again@outlook.test');
    expect(box.connectionId).not.toBe(old.connectionId);
    put(box, { id: 'AAMkAGagain=', summary: 'Quarterly planning', attendees: ['dana@client.test'] });
    await jobs().drain();
    const app = (await w.state()).conn.apps.outlook!;
    expect(app).toMatchObject({ connected: true, account: 'again@outlook.test' });
    expect(app.calendarRefused).toBeUndefined();
    const [conn] = await rows<{ meta: Record<string, unknown> }>('select meta from connection where id = $1', [box.connectionId]);
    expect(conn!.meta.calendarRefused).toBeUndefined();
    expect(await shown(w, 'Quarterly planning')).toMatchObject({ with: ['mail:dana@client.test'] });
  });
});

/* ═════════════════════════════ 2. The nightly re-read ═════════════════════════════ */

describe('the nightly re-read of every connected calendar', () => {
  it('reads each active Google and Outlook calendar once, a page at a time, and nothing else', async () => {
    const g = await workspace('NightGoogle');
    const gcal = await connectApp(g, 'gcal', 'night@google.test');
    const o = await workspace('NightOutlook');
    const ocal = await connectApp(o, 'outlook', 'night@outlook.test');
    const r = await workspace('NightRefused');
    fake().nextScopes = MAIL_ONLY;
    const refused = await connectApp(r, 'outlook', 'night-old@outlook.test');
    const m = await workspace('NightGmail');
    const gmail = await connectApp(m, 'gmail', 'night@gmail.test');
    // The Outlook calendar is long: 210 events, three pages of Outlook's hundred.
    for (let i = 0; i < 210; i++) put(ocal, { id: `AAMkAGnight-${i}=`, summary: `Slot ${i}` }, 2 + i);
    put(gcal, { id: 'gnight', summary: 'Board meeting' }, 40);
    await jobs().drain();
    const accounts = [gcal, ocal, refused, gmail].map((a) => a.account);
    const before = fake().calls.length;

    await onlyThese();
    await jobs().enqueue('calendar.sync.all', {});
    await jobs().drain();
    const made = fake().calls.slice(before).filter((c) => accounts.includes(c.connectedAccountId));
    // Google: one page. Outlook: three pages of a long calendar. The refused calendar and the Gmail mailbox: nothing.
    expect(made.map((c) => [c.connectedAccountId === gcal.account ? 'google' : c.connectedAccountId === ocal.account ? 'outlook' : 'other', c.slug])).toEqual([
      ['google', 'GOOGLECALENDAR_EVENTS_LIST'],
      ['outlook', 'OUTLOOK_GET_CALENDAR_VIEW'],
      ['outlook', 'OUTLOOK_GET_CALENDAR_VIEW'],
      ['outlook', 'OUTLOOK_GET_CALENDAR_VIEW'],
    ]);
    // Counted apart from the reads that follow an announcement.
    expect(await rows(`select op, count(*)::int as n from provider_call where workspace_id = any($1::text[]) and phase = 'reconcile' group by op order by op`, [[g.workspaceId, o.workspaceId, r.workspaceId, m.workspaceId]])).toEqual([
      { op: 'GOOGLECALENDAR_EVENTS_LIST', n: 1 },
      { op: 'OUTLOOK_GET_CALENDAR_VIEW', n: 3 },
    ]);
    // A read already waiting for a calendar is not doubled by the nightly pass.
    jobs().queue = [];
    await jobs().enqueue('calendar.sync', { workspaceId: g.workspaceId, connectionId: gcal.connectionId }, { singletonKey: `cal:${gcal.connectionId}` });
    await jobs().enqueue('calendar.sync.all', {});
    await jobs().drain('calendar.sync.all');
    expect(jobs().queue.filter((j) => j.name === 'calendar.sync' && j.data.connectionId === gcal.connectionId)).toHaveLength(1);
    jobs().queue = [];
  });

  it('a quiet calendar picks up events coming into the two-month window and drops those that have left it, with no announcement', async () => {
    const w = await workspace('QuietCalendar');
    const gcal = await connectApp(w, 'gcal', 'quiet@google.test');
    put(gcal, { id: 'gpast', summary: 'Kickoff, ten days ago' }, -10 * DAYS);
    put(gcal, { id: 'gsoon', summary: 'Review in a month' }, 30 * DAYS);
    put(gcal, { id: 'gfar', summary: 'Offsite in seventy days' }, 70 * DAYS);
    await jobs().drain();
    expect((await events(w)).map((e) => e.title).sort()).toEqual(['Kickoff, ten days ago', 'Review in a month']);

    // Fifteen days pass and the calendar says nothing. The night's pass reads it again.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 15 * 86400_000));
    await onlyThese();
    await jobs().enqueue('calendar.sync.all', {});
    await jobs().drain();
    vi.useRealTimers();
    expect((await events(w)).map((e) => e.title).sort()).toEqual(['Offsite in seventy days', 'Review in a month']);
    // Only reads were made: one listing, from the night's pass.
    expect(callsOf(gcal).filter((c) => c.slug !== 'GOOGLECALENDAR_EVENTS_LIST')).toEqual([]);
  });
});

/* ═════════════════════════════ 3. Changed while its create waits ═════════════════════════════ */

describe('an event changed while its create is still waiting', () => {
  let w: Client;
  let gcal: { connectionId: string; account: string };
  const creates = () => callsOf(gcal, 'GOOGLECALENDAR_CREATE_EVENT');
  const add = (c: Client, id: string, title: string, guests: string[] = [], cmd?: string) => c.cmd({ type: 'ws', ops: [{ op: 'put', col: 'events', item: { id, title, start: at(24), end: at(25), kind: guests.length ? 'meeting' : 'focus', with: guests } }] }, cmd);
  const edit = async (c: Client, id: string, patch: Record<string, unknown>, cmd?: string) => {
    const ev = (await c.state()).ws.events[id]!;
    return c.cmd({ type: 'ws', ops: [{ op: 'put', col: 'events', item: { ...ev, ...patch } }] }, cmd);
  };

  beforeEach(async () => {
    w = await workspace('WaitingCreate');
    gcal = await connectApp(w, 'gcal', 'owner@waiting.test');
    await jobs().drain();
  });

  it('a change inside the undo window replaces the waiting create: the calendar gets the event as changed, once', async () => {
    expect((await add(w, 'ev-plan', 'Plan the launch')).ok).toBe(true);
    const out = await edit(w, 'ev-plan', { title: 'Plan the launch, v2', start: at(27), end: at(28) });
    expect(out.ok).toBe(true);
    expect(out.holding).toMatchObject({ seconds: 30 });
    const [first, second] = await effects(w, 'calendar.create');
    expect(first).toMatchObject({ status: 'cancelled', error: 'Replaced by a change made to the event before it was added' });
    expect(second).toMatchObject({ status: 'approved', source: 'user', approved_via: 'click', command_id: out.id });
    expect(second!.payload).toMatchObject({ eventId: 'ev-plan', title: 'Plan the launch, v2', start: iso(27), end: iso(28), replaces: first!.id });
    // Approvals shows the one that is waiting, not both.
    expect((await w.state()).pending.map((p) => p.id)).toEqual([second!.id]);

    await releaseHolds(w);
    await releaseHolds(w);
    expect(creates()).toHaveLength(1);
    expect(account(gcal).events).toMatchObject([{ summary: 'Plan the launch, v2', start: iso(27), end: iso(28) }]);
    // The cancelled one never ran.
    expect(await rows(`select action from audit_log where effect_id = $1 order by id`, [first!.id])).toEqual([{ action: 'effect.proposed' }, { action: 'effect.approved' }, { action: 'effect.cancelled' }]);
    // The calendar's copy takes the place of the one made in Timmy, as changed, and the read that follows keeps it.
    await jobs().drain();
    const list = await events(w);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'Plan the launch, v2' });
    expect(list[0]!.id).toMatch(/^gcal-/);
    expect(new Date(list[0]!.start).getTime()).toBe(at(27).getTime());
  });

  it('with guests, the new create is approved like the first, and the guests are invited once, to the changed time', async () => {
    await add(w, 'ev-meet', 'Pricing review', ['mail:dana@client.test']);
    await edit(w, 'ev-meet', { start: at(30), end: at(31) });
    const list = await effects(w, 'calendar.create');
    expect(list.map((e) => e.status)).toEqual(['cancelled', 'approved']);
    expect(list[1]!.preview).toMatchObject({ to: ['dana@client.test'], subject: 'Pricing review' });
    await releaseHolds(w);
    await releaseHolds(w);
    expect(creates()).toHaveLength(1);
    expect(account(gcal).events).toMatchObject([{ summary: 'Pricing review', start: iso(30), attendees: ['dana@client.test'], invited: true }]);
    expect(account(gcal).notices).toEqual([{ about: 'invited', event: account(gcal).events[0]!.id, to: ['dana@client.test'] }]);
  });

  it('an assistant’s change to an invitation waiting for the exec waits for the exec again; the first can no longer be approved', async () => {
    const assistant = await addMember(w.workspaceId, 'assistant', 'Jess EA');
    await add(assistant, 'ev-ea', 'Board prep', ['mail:chair@board.test']);
    const [first] = await effects(w, 'calendar.create');
    expect(first).toMatchObject({ status: 'intended', approver_route: 'exec' });
    expect((await edit(assistant, 'ev-ea', { start: at(33), end: at(34) })).ok).toBe(true);
    const [, second] = await effects(w, 'calendar.create');
    expect(second).toMatchObject({ status: 'intended', approver_route: 'exec', requested_by: assistant.userId, approved_by: null });
    expect((await w.state()).pending.map((p) => p.id)).toEqual([second!.id]);
    await releaseHolds(w);
    expect(creates()).toHaveLength(0);
    // The exec's OK on the old request does nothing; on the new one, the event goes out at the changed time.
    const stale = await w.cmd({ type: 'effect', id: first!.id, approve: true });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/already undone/);
    expect((await w.cmd({ type: 'effect', id: second!.id, approve: true })).ok).toBe(true);
    await releaseHolds(w);
    expect(creates()).toHaveLength(1);
    expect(account(gcal).events).toMatchObject([{ summary: 'Board prep', start: iso(33), invited: true }]);
    expect(account(gcal).notices).toHaveLength(1);
  });

  it('Undo of the change brings back the event as it was, and that is what is created, once', async () => {
    await add(w, 'ev-undo', 'Original title');
    const changed = await edit(w, 'ev-undo', { title: 'Changed title' });
    const undo = await w.cmd({ type: 'undo', command: changed.id });
    expect(undo.ok).toBe(true);
    expect(undo.toast?.text).toBe('Undone. “Original title” is added to the calendar as it was, in 30 seconds.');
    expect((await w.state()).ws.events['ev-undo']).toMatchObject({ title: 'Original title' });
    const list = await effects(w, 'calendar.create');
    expect(list.map((e) => [e.status, (e.payload as { title: string }).title])).toEqual([
      ['cancelled', 'Original title'],
      ['cancelled', 'Changed title'],
      ['approved', 'Original title'],
    ]);
    expect(list[2]!.payload).toMatchObject({ replaces: list[1]!.id });
    await releaseHolds(w);
    await releaseHolds(w);
    expect(creates()).toHaveLength(1);
    expect(account(gcal).events).toMatchObject([{ summary: 'Original title' }]);
  });

  it('Undo on the waiting row in Approvals stops the write, and never leads to another: nothing is created', async () => {
    await add(w, 'ev-row', 'Before', ['mail:dana@client.test']);
    await edit(w, 'ev-row', { title: 'After' });
    const waiting = (await effects(w, 'calendar.create')).at(-1)!;
    const out = await w.cmd({ type: 'effect', id: waiting.id, approve: false });
    expect(out.ok).toBe(true);
    expect(out.toast?.text).toMatch(/Nothing was sent/);
    // The change is taken back in Timmy; nothing waits to go out.
    expect((await w.state()).ws.events['ev-row']).toMatchObject({ title: 'Before' });
    expect((await w.state()).pending).toEqual([]);
    expect((await effects(w, 'calendar.create')).map((e) => e.status)).toEqual(['cancelled', 'cancelled']);
    await releaseHolds(w);
    expect(creates()).toHaveLength(0);
    expect(account(gcal).notices).toEqual([]);
  });

  it('deleting the event while its create waits cancels the create: nothing is written and nobody is invited', async () => {
    await add(w, 'ev-gone', 'Never mind', ['mail:dana@client.test']);
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'remove', col: 'events', id: 'ev-gone' }] })).ok).toBe(true);
    expect(await effects(w, 'calendar.create')).toMatchObject([{ status: 'cancelled', error: 'The event was deleted in Timmy before it was added' }]);
    expect((await w.state()).pending).toEqual([]);
    await releaseHolds(w);
    expect(creates()).toHaveLength(0);
    expect(account(gcal).notices).toEqual([]);
    expect(await events(w)).toEqual([]);
  });

  it('a change only to what Timmy keeps leaves the waiting create as it is', async () => {
    await add(w, 'ev-kind', 'Deep work');
    await edit(w, 'ev-kind', { kind: 'personal' });
    expect((await effects(w, 'calendar.create')).map((e) => e.status)).toEqual(['approved']);
    await releaseHolds(w);
    expect(creates()).toHaveLength(1);
  });

  it('a create that is already running is not replaced: the change is refused, to be made again in a moment', async () => {
    await add(w, 'ev-run', 'Running');
    const [e] = await effects(w, 'calendar.create');
    await sysPool.query(`update effect set status = 'executing', executing_at = now() where id = $1`, [e!.id]);
    const out = await edit(w, 'ev-run', { title: 'Too late' });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('“Running” is being added to the calendar right now. Change it again in a moment.');
    expect((await w.state()).ws.events['ev-run']).toMatchObject({ title: 'Running' });
    expect(await effects(w, 'calendar.create')).toHaveLength(1);
  });

  it('a member cannot replace someone else’s waiting create; the change is refused and the create stands', async () => {
    const member = await addMember(w.workspaceId, 'member', 'Mo Member');
    await add(w, 'ev-owner', 'Owner’s meeting', ['mail:dana@client.test']);
    const out = await edit(member, 'ev-owner', { title: 'Hijacked' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/waiting to be added to the calendar by someone else/);
    expect((await effects(w, 'calendar.create')).map((e) => e.status)).toEqual(['approved']);
    await releaseHolds(w);
    expect(account(gcal).events).toMatchObject([{ summary: 'Owner’s meeting' }]);
  });

  it('Outlook: the same, with Outlook sending the one invitation', async () => {
    const o = await workspace('WaitingOutlook');
    const box = await connectApp(o, 'outlook', 'owner@waiting-outlook.test');
    await jobs().drain();
    await add(o, 'ev-ol', 'Design review', ['mail:sam@client.test']);
    await edit(o, 'ev-ol', { title: 'Design review (moved)', start: at(40), end: at(41) });
    await releaseHolds(o);
    await releaseHolds(o);
    expect(callsOf(box, 'OUTLOOK_CALENDAR_CREATE_EVENT')).toHaveLength(1);
    expect(account(box).events).toMatchObject([{ summary: 'Design review (moved)', start: iso(40), attendees: ['sam@client.test'] }]);
    expect(account(box).notices).toHaveLength(1);
  });
});

/* ═════════════════════════════ 4. A deletion whose outcome was unknown ═════════════════════════════ */

describe('a deletion whose outcome was unknown is settled by reading the event by its id', () => {
  const remove = async (w: Client, title: string) => w.cmd({ type: 'ws', ops: [{ op: 'remove', col: 'events', id: (await shown(w, title))!.id }] });

  it('Google: an event moved out of the window is still found by its id, so it is not taken for deleted', async () => {
    const w = await workspace('UnknownGoogle');
    const gcal = await connectApp(w, 'gcal', 'owner@unknown-google.test');
    put(gcal, { id: 'gmove', summary: 'Moved far away' }, 30);
    put(gcal, { id: 'ggone', summary: 'Really deleted' }, 32);
    await jobs().drain();

    fake().failNext.set('GOOGLECALENDAR_DELETE_EVENT', 'timeout');
    await remove(w, 'Moved far away');
    await releaseHolds(w);
    // The answer was lost and nothing was deleted. Then the event is moved to three months out, beyond the window.
    const moved = account(gcal).events.find((e) => e.id === 'gmove')!;
    moved.start = iso(90 * DAYS);
    moved.end = iso(90 * DAYS + 1);
    const [e] = await effects(w, 'calendar.delete');
    expect(e!.status).toBe('uncertain');
    const before = fake().calls.length;
    expect(await reconcileEffect(w.workspaceId, e!.id)).toMatchObject({ status: 'uncertain' });
    // One read, by its id; the window was not listed.
    expect(fake().calls.slice(before).map((c) => [c.slug, c.args.event_id])).toEqual([['GOOGLECALENDAR_EVENTS_GET', 'gmove']]);

    // Deleted for real, with the answer lost: Google shows it as cancelled, and that settles it.
    fake().failNext.set('GOOGLECALENDAR_DELETE_EVENT', 'sent-then-timeout');
    await remove(w, 'Really deleted');
    await releaseHolds(w);
    const gone = (await effects(w, 'calendar.delete')).find((x) => (x.payload as { externalId: string }).externalId === 'ggone')!;
    expect(gone.status).toBe('uncertain');
    expect(await reconcileEffect(w.workspaceId, gone.id)).toMatchObject({ status: 'completed' });
    expect(callsOf(gcal, 'GOOGLECALENDAR_DELETE_EVENT')).toHaveLength(2);
  });

  it('Outlook: not found by its id settles it; still there, wherever it moved, does not; a refusal proves nothing', async () => {
    const w = await workspace('UnknownOutlook');
    const box = await connectApp(w, 'outlook', 'owner@unknown-outlook.test');
    put(box, { id: 'AAMkAGstay=', summary: 'Still there' }, 30);
    put(box, { id: 'AAMkAGgone=', summary: 'Gone for good' }, 32);
    put(box, { id: 'AAMkAGunsure=', summary: 'Cannot tell' }, 34);
    await jobs().drain();

    for (const [title, mode] of [['Still there', 'timeout'], ['Gone for good', 'sent-then-timeout'], ['Cannot tell', 'sent-then-timeout']] as const) {
      fake().failNext.set('OUTLOOK_DELETE_CALENDAR_EVENT', mode);
      await remove(w, title);
      await releaseHolds(w);
    }
    const list = await effects(w, 'calendar.delete');
    expect(list.map((e) => e.status)).toEqual(['uncertain', 'uncertain', 'uncertain']);
    const stay = account(box).events.find((e) => e.id === 'AAMkAGstay=')!;
    stay.start = iso(100 * DAYS);
    stay.end = iso(100 * DAYS + 1);

    const before = fake().calls.length;
    expect(await reconcileEffect(w.workspaceId, list[0]!.id)).toMatchObject({ status: 'uncertain' });
    expect(await reconcileEffect(w.workspaceId, list[1]!.id)).toMatchObject({ status: 'completed' });
    fake().failNext.set('OUTLOOK_GET_EVENT', 'error');
    expect(await reconcileEffect(w.workspaceId, list[2]!.id)).toMatchObject({ status: 'uncertain' });
    // Three questions, one per event, each by its id; nothing was written again and the window was not listed.
    expect(fake().calls.slice(before).map((c) => [c.slug, c.args.event_id])).toEqual([
      ['OUTLOOK_GET_EVENT', 'AAMkAGstay='],
      ['OUTLOOK_GET_EVENT', 'AAMkAGgone='],
      ['OUTLOOK_GET_EVENT', 'AAMkAGunsure='],
    ]);
    expect(callsOf(box, 'OUTLOOK_DELETE_CALENDAR_EVENT')).toHaveLength(3);
  });
});
