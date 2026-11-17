/**
 * An event added in Timmy is written to Google Calendar through the gateway. With guests it sends
 * invitations, so it waits for approval and the undo window like an email; it is never created twice.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import type { EffectRow } from '../src/gateway/gateway';
import { reconcileEffect } from '../src/gateway/gateway';
import { syncCalendar } from '../src/sync/calendar';
import { addMember, boot, connectApp, fake, jobs, newWorkspace, releaseHolds, rows, sysPool, type Client } from './helpers';

let w: Client;
let cal: { connectionId: string; account: string };
const at = (hoursFromNow: number) => new Date(Math.round((Date.now() + hoursFromNow * 3600_000) / 60_000) * 60_000);
const google = () => fake().accounts.get(cal.account)!.events;
const creates = () => fake().calls.filter((c) => c.connectedAccountId === cal.account && c.slug === 'GOOGLECALENDAR_CREATE_EVENT');
const effects = () => rows<EffectRow>(`select * from effect where workspace_id = $1 and kind = 'calendar.create' order by created_at, id`, [w.workspaceId]);
const events = async (c: Client = w) => Object.values((await c.state()).ws.events);
const add = (c: Client, id: string, title: string, guests: string[] = [], id2 = `add-${id}`) =>
  c.cmd({ type: 'ws', ops: [{ op: 'put', col: 'events', item: { id, title, start: at(24), end: at(25), kind: guests.length ? 'meeting' : 'focus', with: guests } }] }, id2);

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  jobs().queue = [];
  w = await newWorkspace('CalWrite');
  cal = await connectApp(w, 'gcal', 'owner@calwrite.test');
  await jobs().drain();
});

describe('an event with no guests', () => {
  it('goes onto the person’s Google Calendar after the undo window, once, and invites nobody', async () => {
    expect((await add(w, 'ev-focus', 'Focus: write the proposal')).ok).toBe(true);
    const [e] = await effects();
    expect(e).toMatchObject({ status: 'approved', source: 'user', approved_by: w.userId, approved_via: 'click' });
    expect(e!.hold_until).not.toBeNull();
    expect(e!.payload).toMatchObject({ connectionId: cal.connectionId, title: 'Focus: write the proposal', attendees: [] });
    await jobs().drain();
    expect(creates()).toHaveLength(0);

    await releaseHolds(w);
    await releaseHolds(w);
    expect(creates()).toHaveLength(1);
    expect(google()).toMatchObject([{ summary: 'Focus: write the proposal', attendees: [], invited: false }]);
    expect(new Date(google()[0]!.start).getTime()).toBe(at(24).getTime());
    expect(new Date(google()[0]!.end).getTime()).toBe(at(25).getTime());
  });

  it('shows once on Timmy’s calendar: the Google copy takes the place of the one made in Timmy, and a sync does not double it', async () => {
    await add(w, 'ev-focus', 'Focus: write the proposal');
    await releaseHolds(w);
    let list = await events();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toMatch(/^gcal-/);
    expect(list[0]).toMatchObject({ title: 'Focus: write the proposal', kind: 'focus' });
    await syncCalendar(w.workspaceId, cal.connectionId);
    list = await events();
    expect(list.filter((x) => x.title === 'Focus: write the proposal')).toHaveLength(1);
  });

  it('sending the same command again creates nothing new; changing it while it waits replaces the waiting create, and it is still created once', async () => {
    await add(w, 'ev-focus', 'Focus: write the proposal');
    await add(w, 'ev-focus', 'Focus: write the proposal');
    expect(await effects()).toHaveLength(1);
    await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'events', item: { id: 'ev-focus', title: 'Focus: renamed', start: at(24), end: at(25), kind: 'focus', with: [] } }] });
    // The change used to leave the waiting create as it was, so Google got the old title (see state/event-creates.ts).
    expect((await effects()).map((e) => e.status)).toEqual(['cancelled', 'approved']);
    await releaseHolds(w);
    await releaseHolds(w);
    expect(creates()).toHaveLength(1);
    expect(google()).toMatchObject([{ summary: 'Focus: renamed' }]);
  });
});

describe('an event with guests', () => {
  it('invites them only after the undo window, with the guests shown to the person who approves', async () => {
    await add(w, 'ev-meet', 'Pricing review', ['mail:dana@client.test', 'me']);
    const [e] = await effects();
    expect(e!.payload).toMatchObject({ attendees: ['dana@client.test'] });
    expect(e!.preview).toMatchObject({ to: ['dana@client.test'], subject: 'Pricing review' });
    expect((await w.state()).pending[0]).toMatchObject({ kind: 'calendar', status: 'holding' });
    await jobs().drain();
    expect(google()).toHaveLength(0);
    await releaseHolds(w);
    expect(google()).toMatchObject([{ summary: 'Pricing review', attendees: ['dana@client.test'], invited: true }]);
    const log = await rows<{ action: string }>('select action from audit_log where workspace_id = $1 and effect_id = $2 order by id', [w.workspaceId, e!.id]);
    expect(log.map((x) => x.action)).toEqual(['effect.proposed', 'effect.approved', 'effect.executing', 'effect.completed']);
  });

  it('Undo inside the window takes the event back and nobody is invited', async () => {
    const made = await add(w, 'ev-meet', 'Pricing review', ['mail:dana@client.test']);
    expect((await w.cmd({ type: 'undo', command: made.id })).ok).toBe(true);
    await releaseHolds(w);
    await jobs().drain();
    expect(google()).toHaveLength(0);
    expect(await events()).toHaveLength(0);
    expect((await effects())[0]!.status).toBe('cancelled');
  });

  it('a guest Timmy has no address for stops the event being added, with a reason, instead of leaving them off', async () => {
    const out = await add(w, 'ev-meet', 'Mystery guest', ['someone-without-an-address']);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no email address/);
    expect(await events()).toHaveLength(0);
    expect(await effects()).toHaveLength(0);
  });

  it('an assistant’s invitation waits for the exec; it is not sent until they approve', async () => {
    const assistant = await addMember(w.workspaceId, 'assistant', 'Jess EA');
    expect((await add(assistant, 'ev-ea', 'Board prep', ['mail:chair@board.test'])).ok).toBe(true);
    const [e] = await effects();
    expect(e).toMatchObject({ status: 'intended', approver_route: 'exec', requested_by: assistant.userId, approved_by: null });
    await releaseHolds(w);
    expect(google()).toHaveLength(0);
    expect((await assistant.cmd({ type: 'effect', id: e!.id, approve: true })).ok).toBe(false);
    expect((await w.cmd({ type: 'effect', id: e!.id, approve: true })).ok).toBe(true);
    await releaseHolds(w);
    expect(google()).toMatchObject([{ summary: 'Board prep', invited: true }]);
  });
});

describe('how much one command may do', () => {
  it('a command that adds more events than the limit is refused whole', async () => {
    const before = config.maxEventsPerCommand;
    config.maxEventsPerCommand = 2;
    try {
      const item = (i: number) => ({ id: `bulk-${i}`, title: `Bulk ${i}`, start: at(24 + i), end: at(25 + i), kind: 'meeting', with: ['mail:dana@client.test'] });
      const tooMany = await w.cmd({ type: 'ws', ops: [0, 1, 2].map((i) => ({ op: 'put', col: 'events', item: item(i) })) });
      expect(tooMany.ok).toBe(false);
      expect(tooMany.error).toMatch(/adds up to 2 at a time/);
      expect(await events()).toHaveLength(0);
      expect(await effects()).toHaveLength(0);
      expect((await w.cmd({ type: 'ws', ops: [0, 1].map((i) => ({ op: 'put', col: 'events', item: item(i) })) })).ok).toBe(true);
      expect(await effects()).toHaveLength(2);
    } finally {
      config.maxEventsPerCommand = before;
    }
  });
});

describe('when it can’t be written, or the answer is lost', () => {
  it('with no calendar connected the event stays on Timmy’s calendar and nothing is proposed', async () => {
    const lone = await newWorkspace('NoCalendar');
    expect((await add(lone, 'ev-local', 'Just for me')).ok).toBe(true);
    expect(await events(lone)).toMatchObject([{ id: 'ev-local', title: 'Just for me' }]);
    expect(await rows('select 1 from effect where workspace_id = $1', [lone.workspaceId])).toHaveLength(0);
  });

  it('a refusal by Google is recorded as failed and the event stays in Timmy; nothing is retried on its own', async () => {
    fake().failNext.set('GOOGLECALENDAR_CREATE_EVENT', 'error');
    await add(w, 'ev-focus', 'Focus: refused');
    await releaseHolds(w);
    await releaseHolds(w);
    expect((await effects())[0]).toMatchObject({ status: 'failed' });
    expect(google()).toHaveLength(0);
    expect(await events()).toMatchObject([{ id: 'ev-focus', title: 'Focus: refused' }]);
  });

  it('a timeout after Google made the event is confirmed from the calendar, and the event is not made a second time', async () => {
    fake().failNext.set('GOOGLECALENDAR_CREATE_EVENT', 'sent-then-timeout');
    await add(w, 'ev-meet', 'Lost answer', ['mail:dana@client.test']);
    await releaseHolds(w);
    const [e] = await effects();
    expect(e!.status).toBe('uncertain');
    expect(google()).toHaveLength(1);
    await releaseHolds(w);
    expect(creates()).toHaveLength(1);
    await sysPool.query(`update effect set updated_at = now() - interval '2 minutes' where id = $1`, [e!.id]);
    expect(await reconcileEffect(w.workspaceId, e!.id)).toMatchObject({ status: 'completed' });
    expect(creates()).toHaveLength(1);
    expect((await events()).filter((x) => x.title === 'Lost answer')).toHaveLength(1);
    expect((await events())[0]!.id).toMatch(/^gcal-/);
  });

  it('with sending switched off the event is added in Timmy only', async () => {
    await w.request('PATCH', '/api/v1/settings', { killSwitch: true });
    expect((await add(w, 'ev-focus', 'Focus: offline')).ok).toBe(true);
    await releaseHolds(w);
    expect(await effects()).toHaveLength(0);
    expect(google()).toHaveLength(0);
    expect(await events()).toMatchObject([{ id: 'ev-focus' }]);
  });
});
