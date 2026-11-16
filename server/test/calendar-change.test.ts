/**
 * Changing or deleting, in Timmy, an event that is on the connected Google Calendar. The change is an effect record:
 * with guests it is approved like an email and says who is told and what changes; with none it is the person's own
 * action with the undo window. It is written once, only by the event's organizer, and never to anyone who was not shown.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import type { EffectRow } from '../src/gateway/gateway';
import { executeEffect, reconcileEffect } from '../src/gateway/gateway';
import type { FakeEvent } from '../src/providers/composio';
import { syncCalendar } from '../src/sync/calendar';
import { storedEvent } from '../src/sync/calendar-change';
import { when } from '../src/sync/calendar-write';
import { addMember, boot, connectApp, fake, jobs, newWorkspace, releaseHolds, rows, sysPool, withWorkspace, type Client } from './helpers';

let w: Client;
let cal: { connectionId: string; account: string };
// One fixed hour to count from, so a time asked for twice is the same time.
const base = Math.ceil(Date.now() / 3600_000) * 3600_000;
const at = (hoursFromNow: number) => new Date(base + hoursFromNow * 3600_000);
const iso = (hoursFromNow: number) => at(hoursFromNow).toISOString();
/** An instant the way the Google tools are given it: with its zone, to the second. */
const rfc = (hoursFromNow: number) => iso(hoursFromNow).replace('.000Z', 'Z');

const google = () => fake().accounts.get(cal.account)!;
const onGoogle = (id: string) => google().events.find((e) => e.id === id);
const calls = (slug: string) => fake().calls.filter((c) => c.connectedAccountId === cal.account && c.slug === slug);
const writes = () => fake().calls.filter((c) => c.connectedAccountId === cal.account && /PATCH_EVENT|DELETE_EVENT|CREATE_EVENT/.test(c.slug));
const effects = (kind?: string, c: Client = w) => rows<EffectRow>(`select * from effect where workspace_id = $1 and ($2::text is null or kind = $2) order by created_at, id`, [c.workspaceId, kind ?? null]);
const events = async (c: Client = w) => Object.values((await c.state()).ws.events);
const shown = async (title: string, c: Client = w) => (await events(c)).find((e) => e.title === title)!;
type Shown = Awaited<ReturnType<typeof shown>>;
/** What the Edit dialog does: puts the whole event back with what was changed. */
const change = (c: Client, ev: Shown, patch: Record<string, unknown>, id?: string) => c.cmd({ type: 'ws', ops: [{ op: 'put', col: 'events', item: { ...ev, ...patch } }] }, id);
const remove = (c: Client, ev: Shown, id?: string) => c.cmd({ type: 'ws', ops: [{ op: 'remove', col: 'events', id: ev.id }] }, id);
const put = (e: Partial<FakeEvent> & { id: string; summary: string }, from = 26) => google().events.push({ start: iso(from), end: iso(from + 1), attendees: [], ...e });

beforeAll(async () => {
  await boot();
});
// The suites share one job queue and one stand-in provider; nothing waiting in either is left for the next file.
afterAll(() => {
  jobs().queue = [];
  fake().failNext.clear();
});
beforeEach(async () => {
  jobs().queue = [];
  fake().failNext.clear();
  w = await newWorkspace('Change');
  cal = await connectApp(w, 'gcal', 'owner@change.test');
  put({ id: 'evsolo', summary: 'Focus: write the proposal' }, 26);
  put({ id: 'evmeet', summary: 'Pricing review', attendees: ['owner@change.test', 'dana@client.test'], description: 'Bring the numbers.' }, 50);
  put({ id: 'evtheirs', summary: 'Their all-hands', attendees: ['owner@change.test', 'boss@corp.test'], organizer: 'boss@corp.test' }, 74);
  await jobs().drain();
  fake().calls = [];
});

describe('changing an event that has no guests', () => {
  it('writes the new time to Google Calendar once, after the undo window, and tells nobody', async () => {
    const ev = await shown('Focus: write the proposal');
    const out = await change(w, ev, { start: at(28), end: at(29) });
    expect(out.ok).toBe(true);
    expect(out.toast?.text).toBe('Changing “Focus: write the proposal” on the calendar in 30 seconds. Undo to stop it.');
    expect(out.holding).toMatchObject({ seconds: 30 });
    const [e] = await effects();
    expect(e).toMatchObject({ kind: 'calendar.update', status: 'approved', source: 'user', approved_by: w.userId, approved_via: 'click', command_id: out.id, idempotency_key: `cmd:${out.id}:event-update:${ev.id}` });
    expect(e!.hold_until).not.toBeNull();
    // The record holds what the calendar had and what it becomes; that is what is sent.
    expect(e!.payload).toEqual({
      connectionId: cal.connectionId,
      externalId: 'evsolo',
      eventId: ev.id,
      before: { title: 'Focus: write the proposal', start: iso(26), end: iso(27), attendees: [] },
      after: { title: 'Focus: write the proposal', start: iso(28), end: iso(29), attendees: [] },
      changed: ['time'],
    });
    expect(e!.preview).toMatchObject({ to: [], subject: 'Focus: write the proposal', title: `Move “Focus: write the proposal” to ${when(at(28), at(29))} on your Google Calendar` });
    expect(e!.preview.lines).toEqual([`Now: ${when(at(26), at(27))}`, `Moves to: ${when(at(28), at(29))}`, 'On your calendar only; nobody is told']);
    expect((await w.state()).pending[0]).toMatchObject({ kind: 'calendar', status: 'holding' });

    // Timmy's calendar shows it at once. Google has heard nothing while the window is open.
    expect((await shown('Focus: write the proposal')).start.getTime()).toBe(at(28).getTime());
    await jobs().drain();
    expect(writes()).toHaveLength(0);
    expect(onGoogle('evsolo')!.start).toBe(iso(26));

    await releaseHolds(w);
    await releaseHolds(w);
    await Promise.all([executeEffect(w.workspaceId, e!.id), executeEffect(w.workspaceId, e!.id)]);
    expect(calls('GOOGLECALENDAR_PATCH_EVENT')).toHaveLength(1);
    // Only the time is sent: nothing else on the event is touched, and nobody is written to.
    expect(calls('GOOGLECALENDAR_PATCH_EVENT')[0]!.args).toEqual({ calendar_id: 'primary', event_id: 'evsolo', start_time: rfc(28), end_time: rfc(29), send_updates: 'none' });
    expect(onGoogle('evsolo')).toMatchObject({ summary: 'Focus: write the proposal', start: iso(28), end: iso(29), attendees: [] });
    expect(google().notices).toEqual([]);
    expect((await effects())[0]).toMatchObject({ status: 'completed', external_id: 'evsolo', attempt: 1 });
    const log = await rows<{ action: string }>('select action from audit_log where workspace_id = $1 and effect_id = $2 order by id', [w.workspaceId, e!.id]);
    expect(log.map((x) => x.action)).toEqual(['effect.proposed', 'effect.approved', 'effect.executing', 'effect.completed']);
  });

  it('shows one event afterwards, not two: the next read of the calendar finds the same event at its new time', async () => {
    const ev = await shown('Focus: write the proposal');
    await change(w, ev, { start: at(28), end: at(29) });
    await releaseHolds(w);
    // Writing asks for the calendar to be read again; that read is the next sync.
    expect(jobs().queue.map((j) => j.name)).toContain('calendar.sync');
    await jobs().drain();
    await syncCalendar(w.workspaceId, cal.connectionId);
    const list = (await events()).filter((x) => x.title === 'Focus: write the proposal');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: ev.id, kind: 'focus' });
    expect(list[0]!.start.getTime()).toBe(at(28).getTime());
    expect(await events()).toHaveLength(3);
    const stored = await rows<{ occurred_at: Date }>(`select occurred_at from item where workspace_id = $1 and kind = 'event' and external_id = 'evsolo'`, [w.workspaceId]);
    expect(stored.map((s) => new Date(s.occurred_at).getTime())).toEqual([at(28).getTime()]);
  });

  it('sends only what changed: a new title is one field, and a new note is the description', async () => {
    const ev = await shown('Focus: write the proposal');
    expect((await change(w, ev, { title: 'Focus: finish the proposal', note: 'Section 3 first.' })).ok).toBe(true);
    const [e] = await effects();
    expect(e!.payload).toMatchObject({ changed: ['title', 'note'], before: { title: 'Focus: write the proposal' }, after: { title: 'Focus: finish the proposal', note: 'Section 3 first.' } });
    expect(e!.preview.lines).toEqual([when(at(26), at(27)), 'Renamed from “Focus: write the proposal” to “Focus: finish the proposal”', 'The description becomes: Section 3 first.', 'On your calendar only; nobody is told']);
    await releaseHolds(w);
    expect(calls('GOOGLECALENDAR_PATCH_EVENT').map((c) => c.args)).toEqual([{ calendar_id: 'primary', event_id: 'evsolo', summary: 'Focus: finish the proposal', description: 'Section 3 first.', send_updates: 'none' }]);
    expect(onGoogle('evsolo')).toMatchObject({ summary: 'Focus: finish the proposal', description: 'Section 3 first.', start: iso(26) });
    await jobs().drain();
    expect(await shown('Focus: finish the proposal')).toMatchObject({ id: ev.id, note: 'Section 3 first.' });
  });

  it('the same command sent again, or the same change made again, writes nothing more', async () => {
    const ev = await shown('Focus: write the proposal');
    const first = await change(w, ev, { start: at(28), end: at(29) }, 'move-once');
    const again = await change(w, ev, { start: at(28), end: at(29) }, 'move-once');
    expect(again).toMatchObject({ ok: true, rev: first.rev });
    // A second command that asks for what the screen already shows changes nothing, so it asks nothing of the calendar.
    expect((await change(w, await shown('Focus: write the proposal'), {})).ok).toBe(true);
    expect(await effects()).toHaveLength(1);
    await releaseHolds(w);
    await releaseHolds(w);
    expect(calls('GOOGLECALENDAR_PATCH_EVENT')).toHaveLength(1);
  });

  it('what only Timmy keeps about an event (its kind, a linked task) is not a change to the calendar, and survives a read of it', async () => {
    const ev = await shown('Focus: write the proposal');
    await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'tasks', item: { id: 'task-1', title: 'Write the proposal', status: 'todo' } }] });
    expect((await change(w, ev, { kind: 'review', task: 'task-1' })).ok).toBe(true);
    expect(await effects()).toHaveLength(0);
    await syncCalendar(w.workspaceId, cal.connectionId);
    expect(await shown('Focus: write the proposal')).toMatchObject({ id: ev.id, task: 'task-1' });
    expect(writes()).toHaveLength(0);
  });

  it('one change to an event at a time: a second one is refused until the first has gone through, so they can’t arrive out of order', async () => {
    await change(w, await shown('Focus: write the proposal'), { start: at(28), end: at(29) });
    const second = await change(w, await shown('Focus: write the proposal'), { start: at(30), end: at(31) });
    expect(second.ok).toBe(false);
    expect(second.error).toBe('“Focus: write the proposal” already has a change on its way to the calendar. Undo it, or wait until it has gone through, then change it again.');
    expect((await remove(w, await shown('Focus: write the proposal'))).ok).toBe(false);
    expect(await effects()).toHaveLength(1);
    expect((await shown('Focus: write the proposal')).start.getTime()).toBe(at(28).getTime());
    // What only Timmy keeps can still be changed meanwhile; it asks nothing of the calendar.
    expect((await change(w, await shown('Focus: write the proposal'), { kind: 'review' })).ok).toBe(true);

    await releaseHolds(w);
    await jobs().drain();
    expect((await change(w, await shown('Focus: write the proposal'), { start: at(30), end: at(31) })).ok).toBe(true);
    // The second record starts from what the calendar holds now.
    expect((await effects()).map((e) => (e.payload as { before: { start: string }; after: { start: string } }).before.start)).toEqual([iso(26), iso(28)]);
    await releaseHolds(w);
    expect(calls('GOOGLECALENDAR_PATCH_EVENT').map((c) => c.args.start_time)).toEqual([rfc(28), rfc(30)]);
    expect(onGoogle('evsolo')!.start).toBe(iso(30));
    await jobs().drain();
    expect((await shown('Focus: write the proposal')).start.getTime()).toBe(at(30).getTime());
  });

  it('a change that is waiting for someone’s approval also has to be decided before another is made', async () => {
    const assistant = await addMember(w.workspaceId, 'assistant', 'Jess EA');
    expect((await change(assistant, await shown('Focus: write the proposal', assistant), { start: at(28), end: at(29) })).ok).toBe(true);
    const again = await change(assistant, await shown('Focus: write the proposal', assistant), { start: at(30), end: at(31) });
    expect(again.ok).toBe(false);
    expect(again.error).toBe('“Focus: write the proposal” already has a change waiting for approval. That one has to be decided first.');
    expect(await effects()).toHaveLength(1);
  });

  it('a read of the calendar that arrives inside the undo window leaves the change on the screen', async () => {
    const ev = await shown('Focus: write the proposal');
    await change(w, ev, { start: at(28), end: at(29) });
    const before = (await w.state()).rev;
    await syncCalendar(w.workspaceId, cal.connectionId);
    expect((await shown('Focus: write the proposal')).start.getTime()).toBe(at(28).getTime());
    expect((await w.state()).rev).toBe(before);
    // So Undo still has the event as the command left it, and puts it back.
    const [e] = await effects();
    expect((await w.cmd({ type: 'undo', command: e!.command_id })).toast?.text).toBe('Undone. Nothing was sent.');
    expect((await shown('Focus: write the proposal')).start.getTime()).toBe(at(26).getTime());
  });
});

describe('changing an event that has guests', () => {
  it('is approved like an email: the record says who is told and the old and new time, and nothing is written before the window ends', async () => {
    const ev = await shown('Pricing review');
    expect(ev).toMatchObject({ kind: 'meeting', with: ['mail:dana@client.test'], note: 'Bring the numbers.' });
    const out = await change(w, ev, { start: at(52), end: at(53) });
    expect(out.toast?.text).toBe('Changing “Pricing review” on the calendar in 30 seconds; dana@client.test will be told. Undo to stop it.');
    const [e] = await effects();
    expect(e).toMatchObject({ kind: 'calendar.update', status: 'approved', approved_by: w.userId, approved_via: 'click', target: 'dana@client.test' });
    expect(e!.payload).toMatchObject({ before: { attendees: ['dana@client.test'], start: iso(50) }, after: { attendees: ['dana@client.test'], start: iso(52) }, changed: ['time'] });
    expect(e!.preview).toMatchObject({ to: ['dana@client.test'], subject: 'Pricing review', title: `Move “Pricing review” to ${when(at(52), at(53))}, and tell dana@client.test` });
    expect(e!.preview.lines).toEqual([`Now: ${when(at(50), at(51))}`, `Moves to: ${when(at(52), at(53))}`, 'Google Calendar tells dana@client.test about the change']);
    // What the Approvals screen shows whoever has to say yes: who is told, and the old and the new time.
    const pending = (await w.state()).pending[0]!;
    expect(pending).toMatchObject({ kind: 'calendar', status: 'holding', waitingOn: 'you', title: `Move “Pricing review” to ${when(at(52), at(53))}, and tell dana@client.test` });
    expect(pending.preview).toMatchObject({ to: ['dana@client.test'], subject: 'Pricing review', body: `Now: ${when(at(50), at(51))}\n\nMoves to: ${when(at(52), at(53))}\n\nGoogle Calendar tells dana@client.test about the change` });

    await jobs().drain();
    expect(writes()).toHaveLength(0);
    expect(google().notices).toEqual([]);
    await releaseHolds(w);
    expect(calls('GOOGLECALENDAR_PATCH_EVENT').map((c) => c.args)).toEqual([{ calendar_id: 'primary', event_id: 'evmeet', start_time: rfc(52), end_time: rfc(53), send_updates: 'all' }]);
    expect(google().notices).toEqual([{ about: 'changed', event: 'evmeet', to: ['dana@client.test'] }]);
    // The guest list was not part of the change, so it was not sent and is as it was.
    expect(onGoogle('evmeet')!.attendees).toEqual(['owner@change.test', 'dana@client.test']);
  });

  it('an assistant’s change waits for the exec: the event stays as the calendar has it, and nothing is written until they approve', async () => {
    const assistant = await addMember(w.workspaceId, 'assistant', 'Jess EA');
    const out = await change(assistant, await shown('Pricing review', assistant), { start: at(52), end: at(53) });
    expect(out.ok).toBe(true);
    expect(out.toast?.text).toBe('Waiting for the exec to OK this before the calendar is changed.');
    expect(out.holding).toBeUndefined();
    const [e] = await effects();
    expect(e).toMatchObject({ kind: 'calendar.update', status: 'intended', approver_route: 'exec', requested_by: assistant.userId, approved_by: null, hold_until: null });
    expect((await shown('Pricing review')).start.getTime()).toBe(at(50).getTime());
    expect((await w.state()).pending[0]).toMatchObject({ kind: 'calendar', status: 'waiting', waitingOn: 'exec' });
    await releaseHolds(w);
    await jobs().drain();
    expect(writes()).toHaveLength(0);
    expect(google().notices).toEqual([]);

    // Their own yes is not enough; the exec's is, and even then the undo window comes first.
    expect((await assistant.cmd({ type: 'effect', id: e!.id, approve: true })).ok).toBe(false);
    expect((await w.cmd({ type: 'effect', id: e!.id, approve: true })).ok).toBe(true);
    await jobs().drain();
    expect(writes()).toHaveLength(0);
    await releaseHolds(w);
    expect(calls('GOOGLECALENDAR_PATCH_EVENT')).toHaveLength(1);
    expect(google().notices).toEqual([{ about: 'changed', event: 'evmeet', to: ['dana@client.test'] }]);
    // Now that the calendar has it, Timmy's calendar shows it, before any read of the calendar.
    expect((await shown('Pricing review')).start.getTime()).toBe(at(52).getTime());
    expect((await w.state()).pending).toHaveLength(0);
  });

  it('a change the exec turns down is never written, and the event stays as it is', async () => {
    const assistant = await addMember(w.workspaceId, 'assistant', 'Jess EA');
    await change(assistant, await shown('Pricing review', assistant), { title: 'Pricing review (moved by Jess)' });
    const [e] = await effects();
    expect((await w.cmd({ type: 'effect', id: e!.id, approve: false })).ok).toBe(true);
    await releaseHolds(w);
    await jobs().drain();
    expect((await effects())[0]!.status).toBe('declined');
    expect(writes()).toHaveLength(0);
    expect(await shown('Pricing review')).toBeTruthy();
    expect(onGoogle('evmeet')!.summary).toBe('Pricing review');
  });

  it('adding and removing a guest tells everyone who was on it or joins it, and keeps the organizer on the list', async () => {
    const ev = await shown('Pricing review');
    await change(w, ev, { with: ['mail:sam@client.test', 'me'] });
    const [e] = await effects();
    expect(e!.payload).toMatchObject({ changed: ['guests'], before: { attendees: ['dana@client.test'] }, after: { attendees: ['sam@client.test'] } });
    expect(e!.preview.to).toEqual(['dana@client.test', 'sam@client.test']);
    expect(e!.preview.lines).toEqual([when(at(50), at(51)), 'Adds sam@client.test', 'Takes dana@client.test off the event', 'Google Calendar tells dana@client.test, sam@client.test about the change']);
    await releaseHolds(w);
    expect(calls('GOOGLECALENDAR_PATCH_EVENT').map((c) => c.args)).toEqual([{ calendar_id: 'primary', event_id: 'evmeet', attendees: ['owner@change.test', 'sam@client.test'], send_updates: 'all' }]);
    expect(google().notices).toEqual([{ about: 'changed', event: 'evmeet', to: ['dana@client.test', 'sam@client.test'] }]);
    await jobs().drain();
    expect(await shown('Pricing review')).toMatchObject({ id: ev.id, with: ['mail:sam@client.test'] });
  });

  it('a guest Timmy has no address for stops the change, with the reason', async () => {
    const out = await change(w, await shown('Pricing review'), { with: ['mail:dana@client.test', 'someone-without-an-address'] });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no email address for someone-without-an-address/);
    expect(await effects()).toHaveLength(0);
    expect((await shown('Pricing review')).with).toEqual(['mail:dana@client.test']);
  });

  it('someone added to the event on the calendar after approval is not told: nothing is written', async () => {
    await change(w, await shown('Focus: write the proposal'), { start: at(28), end: at(29) });
    // The approver saw "nobody is told". Meanwhile a guest appears on the event in Google Calendar itself.
    onGoogle('evsolo')!.attendees = ['owner@change.test', 'eve@elsewhere.test'];
    await releaseHolds(w);
    const [e] = await effects();
    expect(e!.status).toBe('failed');
    expect(e!.error).toMatch(/eve@elsewhere\.test was added to this event on the calendar after this was approved/);
    expect(writes()).toHaveLength(0);
    expect(google().notices).toEqual([]);
    // The calendar is read again, and Timmy's calendar shows what it holds: the old time, and the new guest.
    await jobs().drain();
    const now = await shown('Focus: write the proposal');
    expect(now.start.getTime()).toBe(at(26).getTime());
    expect(now.with).toEqual(['mail:eve@elsewhere.test']);
  });
});

describe('deleting an event', () => {
  it('with no guests it is deleted from Google Calendar once, after the undo window, and nobody is told', async () => {
    const ev = await shown('Focus: write the proposal');
    const out = await remove(w, ev);
    expect(out.toast?.text).toBe('Deleting “Focus: write the proposal” from the calendar in 30 seconds. Undo to stop it.');
    const [e] = await effects();
    expect(e).toMatchObject({ kind: 'calendar.delete', status: 'approved', approved_by: w.userId, approved_via: 'click', command_id: out.id, idempotency_key: `cmd:${out.id}:event-delete:${ev.id}` });
    expect(e!.payload).toEqual({ connectionId: cal.connectionId, externalId: 'evsolo', eventId: ev.id, before: { title: 'Focus: write the proposal', start: iso(26), end: iso(27), attendees: [] } });
    expect(e!.preview).toMatchObject({ to: [], title: 'Delete “Focus: write the proposal” from your Google Calendar' });
    expect(e!.preview.lines).toEqual([when(at(26), at(27)), 'On your calendar only; nobody is told']);
    expect(await shown('Focus: write the proposal')).toBeUndefined();
    await jobs().drain();
    expect(writes()).toHaveLength(0);
    expect(onGoogle('evsolo')).toBeTruthy();

    await releaseHolds(w);
    await releaseHolds(w);
    await Promise.all([executeEffect(w.workspaceId, e!.id), executeEffect(w.workspaceId, e!.id)]);
    expect(calls('GOOGLECALENDAR_DELETE_EVENT').map((c) => c.args)).toEqual([{ calendar_id: 'primary', event_id: 'evsolo', send_updates: 'none' }]);
    expect(onGoogle('evsolo')).toBeUndefined();
    expect(google().notices).toEqual([]);
    // After the next read it is still gone from the screen, and its stored copy is gone too.
    await jobs().drain();
    expect(await shown('Focus: write the proposal')).toBeUndefined();
    expect(await events()).toHaveLength(2);
    expect(await rows(`select 1 from item where workspace_id = $1 and kind = 'event' and external_id = 'evsolo'`, [w.workspaceId])).toEqual([]);
  });

  it('with guests it is approved like an email, says who is told, and Google tells them only after the window', async () => {
    const out = await remove(w, await shown('Pricing review'));
    expect(out.toast?.text).toBe('Cancelling “Pricing review” in 30 seconds; dana@client.test will be told. Undo to stop it.');
    const [e] = await effects();
    expect(e).toMatchObject({ kind: 'calendar.delete', status: 'approved', target: 'dana@client.test' });
    expect(e!.preview).toMatchObject({ to: ['dana@client.test'], subject: 'Pricing review', title: 'Cancel “Pricing review” and tell dana@client.test' });
    expect(e!.preview.lines).toEqual([when(at(50), at(51)), 'Google Calendar tells dana@client.test it is cancelled']);
    expect((await w.state()).pending[0]!.preview.body).toBe(`${when(at(50), at(51))}\n\nGoogle Calendar tells dana@client.test it is cancelled`);
    await jobs().drain();
    expect(writes()).toHaveLength(0);
    expect(google().notices).toEqual([]);
    await releaseHolds(w);
    expect(calls('GOOGLECALENDAR_DELETE_EVENT').map((c) => c.args)).toEqual([{ calendar_id: 'primary', event_id: 'evmeet', send_updates: 'all' }]);
    expect(google().notices).toEqual([{ about: 'cancelled', event: 'evmeet', to: ['dana@client.test'] }]);
  });

  it('an assistant’s deletion waits for the exec, and the event stays on the calendar until they approve', async () => {
    const assistant = await addMember(w.workspaceId, 'assistant', 'Jess EA');
    const out = await remove(assistant, await shown('Pricing review', assistant));
    expect(out.toast?.text).toBe('Waiting for the exec to OK this before the calendar is changed.');
    const [e] = await effects();
    expect(e).toMatchObject({ kind: 'calendar.delete', status: 'intended', approver_route: 'exec', requested_by: assistant.userId });
    expect(await shown('Pricing review')).toBeTruthy();
    await releaseHolds(w);
    await jobs().drain();
    expect(writes()).toHaveLength(0);
    expect((await w.cmd({ type: 'effect', id: e!.id, approve: true })).ok).toBe(true);
    await releaseHolds(w);
    expect(calls('GOOGLECALENDAR_DELETE_EVENT')).toHaveLength(1);
    expect(google().notices).toEqual([{ about: 'cancelled', event: 'evmeet', to: ['dana@client.test'] }]);
    expect(await shown('Pricing review')).toBeUndefined();
  });

  it('an event that is already gone from the calendar has nothing left to delete', async () => {
    await remove(w, await shown('Focus: write the proposal'));
    google().events = google().events.filter((e) => e.id !== 'evsolo');
    google().cancelled.push('evsolo');
    await releaseHolds(w);
    expect((await effects())[0]).toMatchObject({ status: 'completed' });
    expect(calls('GOOGLECALENDAR_DELETE_EVENT')).toHaveLength(0);
  });
});

describe('undo inside the window', () => {
  it('takes a change back and nothing is written', async () => {
    const out = await change(w, await shown('Pricing review'), { start: at(52), end: at(53) });
    expect((await w.cmd({ type: 'undo', command: out.id })).ok).toBe(true);
    await releaseHolds(w);
    await jobs().drain();
    expect(writes()).toHaveLength(0);
    expect(google().notices).toEqual([]);
    // Taking it back is not itself a change to the calendar: there is one record, and it is cancelled.
    expect((await effects()).map((e) => e.status)).toEqual(['cancelled']);
    expect((await shown('Pricing review')).start.getTime()).toBe(at(50).getTime());
    expect((await w.state()).pending).toHaveLength(0);
  });

  it('takes a deletion back: the event returns to Timmy’s calendar and stays on Google’s', async () => {
    const ev = await shown('Pricing review');
    const out = await remove(w, ev);
    expect(await shown('Pricing review')).toBeUndefined();
    expect((await w.cmd({ type: 'undo', command: out.id })).ok).toBe(true);
    await releaseHolds(w);
    await jobs().drain();
    expect(writes()).toHaveLength(0);
    expect(google().notices).toEqual([]);
    expect((await effects()).map((e) => e.status)).toEqual(['cancelled']);
    expect(await shown('Pricing review')).toMatchObject({ id: ev.id });
    expect(onGoogle('evmeet')).toBeTruthy();
  });

  it('Undo from the Approvals list does the same: the held change is cancelled, the event goes back, and nothing is written', async () => {
    await change(w, await shown('Pricing review'), { start: at(52), end: at(53) });
    const [e] = await effects();
    const out = await w.cmd({ type: 'resolve', key: `eff:${e!.id}`, option: 'undo' });
    expect(out).toMatchObject({ ok: true, toast: { text: 'Undone. Nothing was sent.' } });
    await releaseHolds(w);
    await jobs().drain();
    expect(writes()).toHaveLength(0);
    expect((await effects()).map((x) => x.status)).toEqual(['cancelled']);
    expect((await shown('Pricing review')).start.getTime()).toBe(at(50).getTime());
  });

  it('an assistant can take back a change that is still waiting for the exec, and then make another', async () => {
    const assistant = await addMember(w.workspaceId, 'assistant', 'Jess EA');
    const asked = await change(assistant, await shown('Pricing review', assistant), { start: at(52), end: at(53) });
    expect((await assistant.cmd({ type: 'undo', command: asked.id })).ok).toBe(true);
    expect((await effects()).map((x) => x.status)).toEqual(['cancelled']);
    expect((await w.state()).pending).toHaveLength(0);
    expect((await change(assistant, await shown('Pricing review', assistant), { start: at(54), end: at(55) })).ok).toBe(true);
    expect((await effects()).map((x) => x.status)).toEqual(['cancelled', 'intended']);
    await releaseHolds(w);
    expect(writes()).toHaveLength(0);
  });

  it('once the change has been written it can’t be undone, and Timmy says so', async () => {
    const out = await change(w, await shown('Focus: write the proposal'), { start: at(28), end: at(29) });
    await releaseHolds(w);
    const undo = await w.cmd({ type: 'undo', command: out.id });
    expect(undo.ok).toBe(false);
    expect(undo.error).toMatch(/already sent/);
    expect(onGoogle('evsolo')!.start).toBe(iso(28));
  });
});

describe('when the answer is lost, or the calendar says no', () => {
  it('a timeout after Google took the change is confirmed by looking at the calendar, and the change is never written again', async () => {
    fake().failNext.set('GOOGLECALENDAR_PATCH_EVENT', 'sent-then-timeout');
    await change(w, await shown('Pricing review'), { start: at(52), end: at(53) });
    await releaseHolds(w);
    const [e] = await effects();
    expect(e!.status).toBe('uncertain');
    expect(onGoogle('evmeet')!.start).toBe(iso(52));
    // Nothing runs it again: not the release of holds, not a worker.
    await releaseHolds(w);
    expect(await executeEffect(w.workspaceId, e!.id)).toBeNull();
    expect(await reconcileEffect(w.workspaceId, e!.id)).toMatchObject({ status: 'completed', external_id: 'evmeet' });
    expect((await effects())[0]!.result).toMatchObject({ reconciled: true });
    expect(calls('GOOGLECALENDAR_PATCH_EVENT')).toHaveLength(1);
    expect(google().notices).toHaveLength(1);
    await jobs().drain();
    expect((await events()).filter((x) => x.title === 'Pricing review')).toHaveLength(1);
    expect((await shown('Pricing review')).start.getTime()).toBe(at(52).getTime());
  });

  it('a timeout with no change on the calendar stays unconfirmed, is never written again, and Timmy’s calendar goes back to what Google has', async () => {
    fake().failNext.set('GOOGLECALENDAR_PATCH_EVENT', 'timeout');
    await change(w, await shown('Focus: write the proposal'), { start: at(28), end: at(29) });
    await releaseHolds(w);
    const [e] = await effects();
    expect(e!.status).toBe('uncertain');
    await reconcileEffect(w.workspaceId, e!.id);
    await executeEffect(w.workspaceId, e!.id);
    await releaseHolds(w);
    await jobs().drain();
    expect((await effects())[0]!.status).toBe('uncertain');
    expect(calls('GOOGLECALENDAR_PATCH_EVENT')).toHaveLength(1);
    expect(onGoogle('evsolo')!.start).toBe(iso(26));
    expect((await shown('Focus: write the proposal')).start.getTime()).toBe(at(26).getTime());
  });

  it('a timeout after Google deleted the event is confirmed from the calendar’s own listing, and it is not deleted twice', async () => {
    fake().failNext.set('GOOGLECALENDAR_DELETE_EVENT', 'sent-then-timeout');
    await remove(w, await shown('Pricing review'));
    await releaseHolds(w);
    const [e] = await effects();
    expect(e!.status).toBe('uncertain');
    await releaseHolds(w);
    expect(await reconcileEffect(w.workspaceId, e!.id)).toMatchObject({ status: 'completed' });
    expect(calls('GOOGLECALENDAR_DELETE_EVENT')).toHaveLength(1);
    expect(google().notices).toEqual([{ about: 'cancelled', event: 'evmeet', to: ['dana@client.test'] }]);
    await jobs().drain();
    expect(await shown('Pricing review')).toBeUndefined();
  });

  it('a deletion whose answer was lost, with the event still on the calendar, proves nothing and stays unconfirmed', async () => {
    fake().failNext.set('GOOGLECALENDAR_DELETE_EVENT', 'timeout');
    await remove(w, await shown('Focus: write the proposal'));
    await releaseHolds(w);
    const [e] = await effects();
    await reconcileEffect(w.workspaceId, e!.id);
    await releaseHolds(w);
    await jobs().drain();
    expect((await effects())[0]!.status).toBe('uncertain');
    expect(calls('GOOGLECALENDAR_DELETE_EVENT')).toHaveLength(1);
    // It is still on Google Calendar, so it is back on Timmy's.
    expect(await shown('Focus: write the proposal')).toBeTruthy();
  });

  it('a refusal by Google is recorded as failed, nothing is retried, and the event goes back to what the calendar has', async () => {
    fake().failNext.set('GOOGLECALENDAR_PATCH_EVENT', 'error');
    await change(w, await shown('Focus: write the proposal'), { start: at(28), end: at(29) });
    await releaseHolds(w);
    await releaseHolds(w);
    expect((await effects())[0]).toMatchObject({ status: 'failed' });
    expect(calls('GOOGLECALENDAR_PATCH_EVENT')).toHaveLength(1);
    await jobs().drain();
    expect((await shown('Focus: write the proposal')).start.getTime()).toBe(at(26).getTime());
  });

  it('with sending switched off the change is refused with the reason, and the event is left as it is', async () => {
    await w.request('PATCH', '/api/v1/settings', { killSwitch: true });
    const out = await change(w, await shown('Focus: write the proposal'), { start: at(28), end: at(29) });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('Sending is switched off for this workspace. The event was left as it is.');
    expect((await remove(w, await shown('Focus: write the proposal'))).ok).toBe(false);
    expect(await effects()).toHaveLength(0);
    expect((await shown('Focus: write the proposal')).start.getTime()).toBe(at(26).getTime());
  });

  it('an event stored before its guests were kept is read again first; the change is refused until it has been', async () => {
    // What the store held for an event before this was built: no guests, no organizer, no id on Timmy's calendar.
    await sysPool.query(`update item set meta = meta - 'shown' - 'guests' - 'mine' - 'note' - 'noteWhole' - 'recurring' where workspace_id = $1 and kind = 'event'`, [w.workspaceId]);
    const ev = await shown('Pricing review');
    const out = await change(w, ev, { start: at(52), end: at(53) });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('Timmy is reading this calendar again. Try that once more in a minute.');
    expect(await effects()).toHaveLength(0);
    expect(jobs().queue.map((j) => j.name)).toEqual(['calendar.sync']);
    await jobs().drain();
    expect((await change(w, await shown('Pricing review'), { start: at(52), end: at(53) })).ok).toBe(true);
    expect((await effects())[0]!.payload).toMatchObject({ before: { attendees: ['dana@client.test'] } });
  });

  it('an event just made in Timmy is read back from the calendar before it can be changed there, so the change is never lost', async () => {
    await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'events', item: { id: 'ev-new', title: 'Made a moment ago', start: at(30), end: at(31), kind: 'personal', with: [] } }] });
    await releaseHolds(w);
    const made = await shown('Made a moment ago');
    expect(made.id).toMatch(/^gcal-/);
    // Google has it, and Timmy's screen has Google's copy, but the store has not read it yet.
    const early = await change(w, made, { start: at(32), end: at(33) });
    expect(early.ok).toBe(false);
    expect(early.error).toBe('Timmy is reading this calendar again. Try that once more in a minute.');
    expect((await shown('Made a moment ago')).start.getTime()).toBe(at(30).getTime());
    expect(await effects('calendar.update')).toHaveLength(0);
    // Making the event asked for that read already; once it has run, the change goes through.
    expect(jobs().queue.map((j) => j.name)).toContain('calendar.sync');
    await jobs().drain();
    expect((await change(w, await shown('Made a moment ago'), { start: at(32), end: at(33) })).ok).toBe(true);
    await releaseHolds(w);
    expect(calls('GOOGLECALENDAR_PATCH_EVENT')).toHaveLength(1);
    expect(google().events.find((e) => e.summary === 'Made a moment ago')!.start).toBe(iso(32));
  });

  it('an event left on the screen by a calendar that is no longer connected changes in Timmy only: there is nowhere to write it', async () => {
    const ev = await shown('Focus: write the proposal');
    // The connection is gone, but (as could happen to an older workspace) its event is still on the screen.
    await sysPool.query(`update connection set status = 'disconnected' where id = $1`, [cal.connectionId]);
    expect((await change(w, ev, { start: at(28), end: at(29) })).ok).toBe(true);
    expect(await effects()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
    await sysPool.query(`update connection set status = 'active' where id = $1`, [cal.connectionId]);
  });

  it('if the calendar was disconnected meanwhile, nothing is written', async () => {
    await change(w, await shown('Focus: write the proposal'), { start: at(28), end: at(29) });
    expect((await w.post('/api/v1/connections/gcal/disconnect', {})).status).toBe(200);
    await releaseHolds(w);
    expect((await effects())[0]).toMatchObject({ status: 'failed', error: 'The calendar is no longer connected.' });
    expect(writes()).toHaveLength(0);
  });
});

describe('an event someone else organizes', () => {
  it('can’t be changed or deleted from Timmy: the command is refused with the reason, and Google is never asked', async () => {
    const ev = await shown('Their all-hands');
    expect(ev).toMatchObject({ kind: 'meeting', with: ['mail:boss@corp.test'] });
    const moved = await change(w, ev, { start: at(76), end: at(77) });
    expect(moved.ok).toBe(false);
    expect(moved.error).toBe('“Their all-hands” is organized by boss@corp.test, so it can’t be changed from Timmy. Ask them to change it.');
    const gone = await remove(w, ev);
    expect(gone.ok).toBe(false);
    expect(gone.error).toBe('“Their all-hands” is organized by boss@corp.test, so it can’t be deleted from Timmy. To take it off your calendar, decline it in Google Calendar.');
    expect(await effects()).toHaveLength(0);
    expect(fake().calls).toEqual([]);
    const still = await shown('Their all-hands');
    expect(still.start.getTime()).toBe(at(74).getTime());
    expect(onGoogle('evtheirs')).toMatchObject({ start: iso(74) });
  });

  it('is checked on the calendar itself right before writing, in case the store is behind', async () => {
    // Timmy last saw this event as the person's own. On the calendar it now belongs to someone else.
    await change(w, await shown('Focus: write the proposal'), { title: 'Mine, I think' });
    await remove(w, await shown('Pricing review'));
    onGoogle('evsolo')!.organizer = 'boss@corp.test';
    onGoogle('evmeet')!.organizer = 'boss@corp.test';
    await releaseHolds(w);
    const list = await effects();
    expect(list.map((e) => e.status)).toEqual(['failed', 'failed']);
    expect(list[0]!.error).toBe('boss@corp.test organizes this event, so it can’t be changed from Timmy.');
    expect(list[1]!.error).toBe('boss@corp.test organizes this event, so it can’t be deleted from Timmy.');
    expect(writes()).toHaveLength(0);
    expect(google().notices).toEqual([]);
    await jobs().drain();
    expect((await events()).map((e) => e.title).sort()).toEqual(['Focus: write the proposal', 'Pricing review', 'Their all-hands']);
  });
});

describe('notes and repeating events', () => {
  it('a description longer than the note Timmy shows can’t be overwritten from Timmy; the time still can', async () => {
    put({ id: 'evlong', summary: 'Quarterly plan', description: 'Agenda. '.repeat(400) }, 98);
    put({ id: 'evrich', summary: 'Launch notes', description: '<p>See the <a href="https://example.test/doc">doc</a>.</p>' }, 100);
    await syncCalendar(w.workspaceId, cal.connectionId);
    fake().calls = [];
    const long = await shown('Quarterly plan');
    expect(long.note).toHaveLength(2000);
    const out = await change(w, long, { note: 'Short now.' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/longer than the note Timmy shows, or has formatting, so changing it here would lose part of it/);
    // A description with markup is shown as its words, and is not written back from them either.
    const rich = await shown('Launch notes');
    expect(rich.note).toBe('See the doc.');
    expect((await change(w, rich, { note: 'See the doc. And the sheet.' })).ok).toBe(false);
    expect(await effects()).toHaveLength(0);
    expect((await change(w, long, { start: at(99), end: at(100) })).ok).toBe(true);
    await releaseHolds(w);
    expect(calls('GOOGLECALENDAR_PATCH_EVENT').map((c) => Object.keys(c.args).sort())).toEqual([['calendar_id', 'end_time', 'event_id', 'send_updates', 'start_time']]);
    expect(onGoogle('evlong')!.description).toHaveLength(3200);
  });

  it('one time of a repeating event is changed alone, and the record says so', async () => {
    put({ id: 'evweekly_20261120T100000Z', summary: 'Weekly sync', recurring: true, attendees: ['owner@change.test', 'dana@client.test'] }, 120);
    put({ id: 'evweekly_20261127T100000Z', summary: 'Weekly sync', recurring: true, attendees: ['owner@change.test', 'dana@client.test'] }, 288);
    await syncCalendar(w.workspaceId, cal.connectionId);
    fake().calls = [];
    const times = (await events()).filter((e) => e.title === 'Weekly sync').sort((a, b) => a.start.getTime() - b.start.getTime());
    expect(times).toHaveLength(2);
    await change(w, times[0]!, { start: at(121), end: at(122) });
    const [e] = await effects();
    expect(e!.payload).toMatchObject({ externalId: 'evweekly_20261120T100000Z', recurring: true });
    expect(e!.preview.lines).toContain('This is one time of a repeating event; only this one changes');
    await releaseHolds(w);
    expect(calls('GOOGLECALENDAR_PATCH_EVENT').map((c) => c.args.event_id)).toEqual(['evweekly_20261120T100000Z']);
    expect(onGoogle('evweekly_20261127T100000Z')!.start).toBe(iso(288));
  });
});

describe('how much one command may do, and whose calendar it is', () => {
  it('a command that changes more events than the limit is refused whole', async () => {
    const before = config.maxEventsPerCommand;
    config.maxEventsPerCommand = 1;
    try {
      const a = await shown('Focus: write the proposal');
      const b = await shown('Pricing review');
      const both = await w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'events', id: a.id, patch: { title: 'A' } }, { op: 'remove', col: 'events', id: b.id }] });
      expect(both.ok).toBe(false);
      expect(both.error).toBe('That would change 2 events on the calendar at once. Timmy changes up to 1 at a time.');
      expect(await effects()).toHaveLength(0);
      expect((await events()).map((e) => e.title).sort()).toEqual(['Focus: write the proposal', 'Pricing review', 'Their all-hands']);
    } finally {
      config.maxEventsPerCommand = before;
    }
  });

  it('a member’s change to a calendar someone else connected waits for that person', async () => {
    const member = await addMember(w.workspaceId, 'member', 'Mo Member');
    const out = await change(member, await shown('Focus: write the proposal', member), { start: at(28), end: at(29) });
    expect(out.toast?.text).toBe('Waiting for the person whose calendar this is to OK this before the calendar is changed.');
    expect((await effects())[0]).toMatchObject({ status: 'intended', approver_route: 'exec', on_behalf_of: w.userId, requested_by: member.userId });
    await releaseHolds(w);
    expect(writes()).toHaveLength(0);
  });

  it('a role that can’t make changes can’t change the calendar either', async () => {
    const reader = await addMember(w.workspaceId, 'revops', 'Rae RevOps');
    const out = await reader.cmd({ type: 'ws', ops: [{ op: 'remove', col: 'events', id: (await shown('Focus: write the proposal')).id }] });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('Your role can’t make changes in this workspace.');
    expect(await effects()).toHaveLength(0);
    expect(await shown('Focus: write the proposal')).toBeTruthy();
  });

  it('another workspace can’t touch these events by their ids', async () => {
    const mine = await shown('Pricing review');
    const other = await newWorkspace('Elsewhere');
    await connectApp(other, 'gcal', 'owner@elsewhere.test');
    await jobs().drain();
    fake().calls = [];

    // Removing or patching an id that is not in their own workspace does nothing at all.
    expect((await other.cmd({ type: 'ws', ops: [{ op: 'remove', col: 'events', id: mine.id }] })).ok).toBe(true);
    expect((await other.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'events', id: mine.id, patch: { title: 'Hijacked' } }] })).ok).toBe(true);
    // And they can't plant an event under an id that only a calendar sync gives out.
    const planted = await other.cmd({ type: 'ws', ops: [{ op: 'put', col: 'events', item: { ...mine, title: 'Hijacked' } }] });
    expect(planted.ok).toBe(false);
    expect(planted.error).toBe('That event isn’t on a connected calendar.');
    expect(await effects(undefined, other)).toHaveLength(0);
    expect(await effects()).toHaveLength(0);
    expect(await events(other)).toHaveLength(0);
    expect(fake().calls).toEqual([]);
    expect(await shown('Pricing review')).toMatchObject({ id: mine.id });
    expect(onGoogle('evmeet')!.summary).toBe('Pricing review');

    // The stored event can only be found from inside its own workspace, whichever workspace is named.
    const find = (scope: string, named: string) => withWorkspace({ workspaceId: scope }, (tx) => storedEvent(tx, named, mine.id));
    expect(await find(w.workspaceId, w.workspaceId)).toMatchObject({ externalId: 'evmeet', connectionId: cal.connectionId });
    expect(await find(other.workspaceId, other.workspaceId)).toBeNull();
    expect(await find(other.workspaceId, w.workspaceId)).toBeNull();

    // Nor can they decide a change that is waiting in this workspace.
    await change(w, mine, { start: at(52), end: at(53) });
    const [e] = await effects();
    const res = await other.post(`/api/v1/actions/${e!.id}/decline`, {});
    expect(res.status).toBe(409);
    expect((await effects())[0]!.status).toBe('approved');
  });
});
