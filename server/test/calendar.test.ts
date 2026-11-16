import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { syncCalendar } from '../src/sync/calendar';
import { boot, connectApp, fake, jobs, newWorkspace, rows, type Client } from './helpers';

let w: Client;
let cal: { connectionId: string; account: string };
const at = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * 3600_000).toISOString();

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  jobs().queue = [];
  w = await newWorkspace('Cal');
  cal = await connectApp(w, 'gcal', 'owner@cal.test');
  fake().accounts.get(cal.account)!.events.push(
    { id: 'ev-1', summary: 'Pricing review with Dana', start: at(2), end: at(3), attendees: ['owner@cal.test', 'dana@client.test'] },
    { id: 'ev-2', summary: 'Focus: write the proposal', start: at(26), end: at(28), attendees: [] },
  );
});

describe('calendar sync', () => {
  it('connecting a calendar queues a sync, and the events appear on Timmy’s calendar', async () => {
    expect((await w.state()).conn.apps.gcal).toMatchObject({ connected: true });
    expect(jobs().queue.map((j) => j.name)).toContain('calendar.sync');
    await jobs().drain();
    const events = Object.values((await w.state()).ws.events);
    expect(events).toHaveLength(2);
    const meeting = events.find((e) => e.title === 'Pricing review with Dana')!;
    expect(meeting).toMatchObject({ kind: 'meeting', with: ['mail:dana@client.test'] });
    expect(meeting.start).toBeInstanceOf(Date);
    expect(events.find((e) => e.title.startsWith('Focus'))).toMatchObject({ kind: 'focus', with: [] });
    expect((await rows<{ n: number }>(`select count(*)::int as n from item where workspace_id = $1 and kind = 'event'`, [w.workspaceId]))[0]!.n).toBe(2);
  });

  it('a second sync changes nothing, a cancelled event disappears, and events made in Timmy stay', async () => {
    await jobs().drain();
    await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'events', item: { id: 'mine-1', title: 'Made in Timmy', start: new Date(at(5)), end: new Date(at(6)), kind: 'focus', with: [] } }] });
    const before = (await w.state()).rev;
    const again = await syncCalendar(w.workspaceId, cal.connectionId);
    expect(again).toMatchObject({ events: 2, shown: 2, removed: 0 });
    expect((await w.state()).rev).toBe(before);

    const box = fake().accounts.get(cal.account)!;
    box.events = box.events.filter((e) => e.id !== 'ev-2');
    const after = await syncCalendar(w.workspaceId, cal.connectionId);
    expect(after).toMatchObject({ events: 1, shown: 1, removed: 1 });
    const titles = Object.values((await w.state()).ws.events).map((e) => e.title).sort();
    expect(titles).toEqual(['Made in Timmy', 'Pricing review with Dana']);
  });

  it('a calendar change announced by the provider triggers a sync for that workspace only', async () => {
    await jobs().drain();
    const other = await newWorkspace('OtherCal');
    fake().accounts.get(cal.account)!.events.push({ id: 'ev-3', summary: 'New: contract signing', start: at(50), end: at(51), attendees: ['legal@client.test'] });
    const body = JSON.stringify({ id: `evt_cal_${Date.now()}`, metadata: { trigger_slug: 'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER', connected_account_id: cal.account, user_id: 'x' }, data: { event_id: 'ev-3' } });
    const { signWebhook } = await import('../src/providers/composio');
    const ts = String(Math.floor(Date.now() / 1000));
    const id = `wh_cal_${Date.now()}`;
    const res = await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signWebhook(id, ts, body, fake().secret) }, body });
    expect(res.status).toBe(200);
    expect(jobs().queue.map((j) => j.name)).toEqual(['calendar.sync']);
    await jobs().drain();
    expect(Object.values((await w.state()).ws.events).some((e) => e.title === 'New: contract signing')).toBe(true);
    expect(Object.values((await other.state()).ws.events)).toHaveLength(0);
  });
});
