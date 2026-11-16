/**
 * The scheduled morning run: when it is due, what it prepares, and what it must never do
 * (move a thread, send anything, run twice in a day, or spend past its share of the limit).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dueWorkspaces, localTime, morningRun, runDue } from '../src/agent/morning';
import type { EffectRow } from '../src/gateway/gateway';
import { addMember, boot, connectGmail, fake, jobs, model, newWorkspace, rows, sysPool, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };
const deliver = async (message: Record<string, unknown>) => {
  await w.post('/api/test/fake', { op: 'deliver', message });
  await jobs().drain();
};
const thread = async (subject: string) => (await w.state()).threads.find((t) => t.subject === subject)!;
const calls = (route: string) => model().requests.filter((r) => r.route === route).length;
const DAY = 86400_000;

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  model().reset();
  jobs().queue = [];
  w = await newWorkspace('Morning');
  box = await connectGmail(w, 'owner@morning.test');
  await jobs().drain();
});

describe('when the run is due', () => {
  const weekdays = { time: '08:00', days: [1, 2, 3, 4, 5] };
  // Monday Nov 16, 2026. New York is UTC-5 that day, Los Angeles UTC-8.
  const at = (iso: string) => new Date(iso);

  it('reads the wall clock of the workspace’s own time zone', () => {
    expect(localTime(at('2026-11-16T13:05:00Z'), 'America/New_York')).toEqual({ date: '2026-11-16', minutes: 8 * 60 + 5, weekday: 1 });
    expect(localTime(at('2026-11-16T04:30:00Z'), 'America/Los_Angeles')).toEqual({ date: '2026-11-15', minutes: 20 * 60 + 30, weekday: 0 });
    expect(localTime(at('2026-11-16T13:05:00Z'), 'Not/AZone')).toEqual(localTime(at('2026-11-16T13:05:00Z'), 'UTC'));
  });

  it('is due from the chosen time on a chosen day, once, and not hours late', () => {
    const ny = 'America/New_York';
    expect(runDue(weekdays, ny, null, at('2026-11-16T12:59:00Z'))).toBe(false); // 7:59 AM
    expect(runDue(weekdays, ny, null, at('2026-11-16T13:00:00Z'))).toBe(true); // 8:00 AM
    expect(runDue(weekdays, ny, null, at('2026-11-16T18:30:00Z'))).toBe(true); // 1:30 PM: the server was down, still today's run
    expect(runDue(weekdays, ny, null, at('2026-11-16T19:01:00Z'))).toBe(false); // more than six hours late
    expect(runDue(weekdays, ny, null, at('2026-11-15T13:00:00Z'))).toBe(false); // Sunday
    expect(runDue({ time: '08:00', days: [] }, ny, null, at('2026-11-16T13:00:00Z'))).toBe(false); // paused
    // Already ran today: not again, even if the time is moved later. Ran yesterday: due.
    expect(runDue(weekdays, ny, at('2026-11-16T13:01:00Z'), at('2026-11-16T13:10:00Z'))).toBe(false);
    expect(runDue({ ...weekdays, time: '09:00' }, ny, at('2026-11-16T13:01:00Z'), at('2026-11-16T14:05:00Z'))).toBe(false);
    expect(runDue(weekdays, ny, at('2026-11-13T13:01:00Z'), at('2026-11-16T13:10:00Z'))).toBe(true);
    // The same moment is 8 AM in New York and 5 AM in Los Angeles.
    expect(runDue(weekdays, 'America/Los_Angeles', null, at('2026-11-16T13:00:00Z'))).toBe(false);
  });

  it('lists only workspaces with a connected mailbox whose time has come, and not again once they have run', async () => {
    const noMail = await newWorkspace('NoMailbox');
    const monday8 = at('2026-11-16T08:05:00Z'); // workspaces start on UTC
    const due = await dueWorkspaces(sysPool, monday8);
    expect(due).toContain(w.workspaceId);
    expect(due).not.toContain(noMail.workspaceId);
    expect(await dueWorkspaces(sysPool, at('2026-11-16T07:55:00Z'))).not.toContain(w.workspaceId);

    // The owner moves the run to 10:30 and sets the workspace's time zone.
    expect((await w.cmd({ type: 'setSchedule', schedule: { time: '10:30' } })).ok).toBe(true);
    expect(await dueWorkspaces(sysPool, monday8)).not.toContain(w.workspaceId);
    expect((await w.request('PATCH', '/api/v1/settings', { timezone: 'America/New_York' })).status).toBe(200);
    expect(await dueWorkspaces(sysPool, at('2026-11-16T15:31:00Z'))).toContain(w.workspaceId); // 10:31 AM in New York
    expect((await w.request('PATCH', '/api/v1/settings', { timezone: 'Mars/Olympus' })).status).toBe(400);

    await morningRun(w.workspaceId, at('2026-11-16T15:31:00Z'));
    expect(await dueWorkspaces(sysPool, at('2026-11-16T15:40:00Z'))).not.toContain(w.workspaceId);
    expect(await dueWorkspaces(sysPool, at('2026-11-17T15:31:00Z'))).toContain(w.workspaceId);
  });
});

describe('what the run prepares', () => {
  it('drafts replies to mail that needs an answer, says what it did, moves nothing and sends nothing', async () => {
    await deliver({ from: 'Dana Whitfield <dana@acme.test>', subject: 'Revised quote', body: 'Could you send the revised quote by Friday?' });
    await deliver({ from: 'News <newsletter@shop.test>', subject: 'Weekly deals', body: 'Big savings. Unsubscribe here.' });
    const before = await thread('Revised quote');
    expect(before.draft).toBeUndefined();
    const drafts = calls('draft');

    const run = await morningRun(w.workspaceId);
    expect(run).toMatchObject({ sorted: 2, drafted: 1 });
    const after = await thread('Revised quote');
    expect(after.draft).toMatchObject({ kind: 'reply', to: ['mail:dana@acme.test'] });
    expect(after.draft!.body).toMatch(/Thanks for your message/);
    expect(calls('draft')).toBe(drafts + 1);
    // It only prepared: the thread is where it was, and the newsletter got no draft.
    expect(after.box).toBe(before.box);
    expect((await thread('Weekly deals')).draft).toBeUndefined();
    expect(fake().sent(box.account)).toHaveLength(0);
    expect(await rows<EffectRow>('select id from effect where workspace_id = $1', [w.workspaceId])).toHaveLength(0);

    // The brief and the activity log say what happened, and the cost is recorded as work nobody asked for.
    const s = await w.state();
    expect(s.run).toMatchObject({ sorted: 2, drafted: 1 });
    expect(s.run!.at).toBeInstanceOf(Date);
    expect(s.activity[0]).toMatchObject({ kind: 'triage', text: 'Morning run: 2 threads with new mail, 1 reply drafted.' });
    const usage = await rows<{ unattended: boolean }>(`select unattended from usage_event where workspace_id = $1 and route = 'draft'`, [w.workspaceId]);
    expect(usage).toEqual([{ unattended: true }]);
  });

  it('runs once a day: a second start the same day does nothing, and the next day it does not redraft', async () => {
    await deliver({ from: 'Dana Whitfield <dana@acme.test>', subject: 'Revised quote', body: 'Could you send the revised quote by Friday?' });
    const now = new Date();
    const [a, b] = await Promise.all([morningRun(w.workspaceId, now), morningRun(w.workspaceId, now)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const drafts = calls('draft');
    expect(await morningRun(w.workspaceId, new Date(now.getTime() + 60_000))).toBeNull();
    expect(calls('draft')).toBe(drafts);

    const tomorrow = await morningRun(w.workspaceId, new Date(now.getTime() + DAY));
    expect(tomorrow).toMatchObject({ drafted: 0 });
    expect(calls('draft')).toBe(drafts);
  });

  it('leaves alone a thread the person answered, one they drafted themselves, and one that is archived', async () => {
    await deliver({ from: 'Dana Whitfield <dana@acme.test>', subject: 'Answered', body: 'Can you confirm?' });
    await deliver({ from: 'Sam Rivera <sam@acme.test>', subject: 'Has my draft', body: 'What do you think?' });
    await deliver({ from: 'Lee Park <lee@acme.test>', subject: 'Archived', body: 'Any thoughts?' });
    const answered = await thread('Answered');
    await w.cmd({ type: 'reply', id: answered.id, body: 'Confirmed.' });
    const mine = await thread('Has my draft');
    await w.cmd({ type: 'makeDraft', id: mine.id, note: 'Say yes.' });
    await jobs().drain();
    const draftBefore = (await thread('Has my draft')).draft!.body;
    const archived = await thread('Archived');
    await w.cmd({ type: 'move', id: archived.id, box: 'archived' });
    const drafts = calls('draft');

    expect(await morningRun(w.workspaceId)).toMatchObject({ drafted: 0 });
    expect(calls('draft')).toBe(drafts);
    expect((await thread('Has my draft')).draft!.body).toBe(draftBefore);
    expect((await thread('Archived')).draft).toBeUndefined();
  });

  it('takes in mail the triggers missed before it reads and drafts', async () => {
    const mailbox = fake().accounts.get(box.account)!;
    mailbox.messages.push({ id: 'missed-am', threadId: 'th-missed-am', from: 'Sam Rivera <sam@acme.test>', to: [mailbox.address], subject: 'Never announced', body: 'Can we talk tomorrow?', at: new Date(Date.now() - 3600_000), labels: ['INBOX', 'UNREAD'] });
    expect(await thread('Never announced')).toBeUndefined();
    const run = await morningRun(w.workspaceId);
    expect(run).toMatchObject({ sorted: 1, drafted: 1 });
    const t = await thread('Never announced');
    expect(t.suggestion).toMatchObject({ box: 'follow-up', confidence: 'medium' });
    expect(t.draft).toBeDefined();
  });

  it('stops at the spending limit and says so, instead of drafting past it', async () => {
    await deliver({ from: 'Dana Whitfield <dana@acme.test>', subject: 'Revised quote', body: 'Could you send the revised quote by Friday?' });
    await sysPool.query(`insert into usage_event (workspace_id, route, model, cost_usd, unattended) values ($1, 'read', 'm', 26, true)`, [w.workspaceId]);
    const before = model().requests.length;
    const run = await morningRun(w.workspaceId);
    expect(run).toMatchObject({ drafted: 0 });
    expect(run!.note).toMatch(/monthly limit/);
    expect(model().requests.length).toBe(before);
    expect((await thread('Revised quote')).draft).toBeUndefined();
    expect((await w.state()).activity[0]!.text).toMatch(/monthly limit/);
  });

  it('the scheduled job runs it, and only an owner or admin can move the schedule', async () => {
    await deliver({ from: 'Dana Whitfield <dana@acme.test>', subject: 'Revised quote', body: 'Could you send the revised quote by Friday?' });
    await jobs().enqueue('morning.run', { workspaceId: w.workspaceId });
    await jobs().drain();
    expect((await w.state()).run).toMatchObject({ drafted: 1 });
    const member = await addMember(w.workspaceId, 'member');
    expect((await member.cmd({ type: 'setSchedule', schedule: { days: [] } })).ok).toBe(false);
    expect((await member.request('PATCH', '/api/v1/settings', { timezone: 'Asia/Tokyo' })).status).toBe(403);
  });
});
