/**
 * "Do it with Timmy" and booking from Ask (src/agent/tools.ts, http/agent.ts, gateway/screens.ts):
 *   - a run started from a task links what it prepares to the task: a draft reply carries it (sending ticks it), an
 *     email or a meeting carries it to the gateway, and the task is ticked off only once that has gone out;
 *   - book_meeting puts a meeting on the connected calendar through the gateway, waiting for the person's OK, and
 *     says when it clashes; list_events shows the calendar between two days, as outside content.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '../../src/data/ws-types';
import { startRun } from '../src/agent/loop';
import { ASK_SYSTEM } from '../src/agent/prompts';
import { TOOL_BY_NAME } from '../src/agent/tools';
import { rulesFor } from '../src/auth/roles';
import type { EffectRow } from '../src/gateway/gateway';
import { boot, connectApp, connectGmail, fake, jobs, model, newWorkspace, releaseHolds, rows, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };
const ctxOf = (c: Client) => ({ user: { id: c.userId, name: 'Owner', email: c.email }, workspaceId: c.workspaceId, role: 'owner', rules: rulesFor('owner') });
const ask = (text: string, taskId?: string, attended = true) => startRun(ctxOf(w), { kind: attended ? 'ask' : 'routine', attended, system: ASK_SYSTEM, messages: [{ role: 'user', content: text }], threadId: 'chat-task', ...(taskId ? { taskId } : {}) });
const effects = (kind: string) => rows<EffectRow>('select * from effect where workspace_id = $1 and kind = $2 order by created_at', [w.workspaceId, kind]);
const task = async (id: string) => (await w.state()).ws.tasks[id] as Task | undefined;
const addTask = (id: string, title: string, thread?: string) => w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'tasks', item: { id, title, status: 'todo', priority: 'normal', created: new Date(), ...(thread ? { thread } : {}) } }] });
/** A wall-clock time tomorrow in the workspace's zone, as book_meeting takes it. */
const tomorrowAt = (hh: number) => `${new Date(Date.now() + 86400_000).toISOString().slice(0, 10)}T${String(hh).padStart(2, '0')}:00`;

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  model().reset();
  jobs().queue = [];
  w = await newWorkspace('Do it');
  box = await connectGmail(w, 'owner@doit.test');
  await jobs().drain();
  await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Dana Whitfield <dana@acme.test>', subject: 'Revised quote', body: 'Hi, could you send the revised quote?\n\nDana' } });
  await jobs().drain();
  model().reset();
});

describe('a task handed to Ask', () => {
  it('a draft reply it writes carries the task, and sending the draft ticks the task off', async () => {
    const thread = (await w.state()).threads.find((t) => t.subject === 'Revised quote')!;
    await addTask('tsk-q', 'Send Dana the revised quote', thread.id);
    model().script.push({ toolCalls: [{ name: 'draft_reply', arguments: { id: thread.id, body: 'Hi Dana, the revised quote is $58 per seat.' } }] }, { content: 'The draft is waiting for your OK.' });
    await ask('Do my task “Send Dana the revised quote”.', 'tsk-q');
    const drafted = (await w.state()).threads.find((t) => t.id === thread.id)!;
    expect(drafted.draft?.completes).toEqual(['tsk-q']);
    expect((await task('tsk-q'))!.status).toBe('todo');
    expect((await w.cmd({ type: 'sendDraft', id: thread.id, track: false })).ok).toBe(true);
    expect((await task('tsk-q'))!.status).toBe('done');
  });

  it('an email it prepares ticks the task off once it has gone out, and not when it is turned down', async () => {
    await addTask('tsk-e', 'Email Sam the deck');
    model().script.push({ toolCalls: [{ name: 'send_email', arguments: { to: ['sam@acme.test'], subject: 'The deck', body: 'Hi Sam, the deck is attached.' } }] });
    await ask('Do my task “Email Sam the deck”.', 'tsk-e');
    const [e] = await effects('email.send');
    expect(e!.preview).toMatchObject({ completes: 'tsk-e', why: 'Timmy prepared this for your task “Email Sam the deck”, which is ticked off once it goes out.' });
    expect((await task('tsk-e'))!.status).toBe('todo');
    await w.cmd({ type: 'effect', id: e!.id, approve: true });
    expect((await task('tsk-e'))!.status).toBe('todo');
    await releaseHolds(w);
    expect(fake().sent(box.account)).toHaveLength(1);
    expect((await task('tsk-e'))!.status).toBe('done');
    expect((await w.state()).activity.some((a) => a.text === 'Ticked off “Email Sam the deck”: the email Timmy prepared for it went out')).toBe(true);

    await addTask('tsk-n', 'Email Lee the notes');
    model().script.push({ toolCalls: [{ name: 'send_email', arguments: { to: ['lee@acme.test'], subject: 'Notes', body: 'Notes attached.' } }] });
    await ask('Do my task “Email Lee the notes”.', 'tsk-n');
    const [, no] = await effects('email.send');
    await w.cmd({ type: 'effect', id: no!.id, approve: false });
    await releaseHolds(w);
    expect((await task('tsk-n'))!.status).toBe('todo');
  });

  it('a run not started from a task, or from one already done, links nothing', async () => {
    await addTask('tsk-d', 'Already done');
    await w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'tasks', id: 'tsk-d', patch: { status: 'done' } }] });
    model().script.push({ toolCalls: [{ name: 'send_email', arguments: { to: ['sam@acme.test'], subject: 'Hi', body: 'Hello.' } }] });
    await ask('Email Sam hello.');
    model().script.push({ toolCalls: [{ name: 'send_email', arguments: { to: ['sam@acme.test'], subject: 'Again', body: 'Hello again.' } }] });
    await ask('Do my task “Already done”.', 'tsk-d');
    for (const e of await effects('email.send')) expect(e.preview.completes).toBeUndefined();
  });

  it('the chat endpoint takes the task from the browser, and only an open task of this workspace', async () => {
    const thread = (await w.state()).threads.find((t) => t.subject === 'Revised quote')!;
    await addTask('tsk-h', 'Reply to Dana', thread.id);
    let seen = '';
    model().script.push((req) => {
      seen = req.messages[req.messages.length - 1]!.content;
      return { content: 'On it.' };
    });
    const res = await w.request('POST', '/api/v1/agent/runs', { threadId: 'chat-h', runId: 'r-h', messages: [{ id: 'u1', role: 'user', content: 'Do my task “Reply to Dana”.' }], tools: [], context: [], forwardedProps: { task: 'tsk-h' } });
    await res.text();
    // The task travels with what is on screen, as marked data: its title may come from an email.
    expect(seen).toMatch(/<untrusted source="screen">[\s\S]*The task the user asked you to do: \{"id":"tsk-h","title":"Reply to Dana"/);
    model().script.push((req) => {
      seen = req.messages[req.messages.length - 1]!.content;
      return { content: 'Nothing to do.' };
    });
    const other = await w.request('POST', '/api/v1/agent/runs', { threadId: 'chat-x', runId: 'r-x', messages: [{ id: 'u1', role: 'user', content: 'Do it.' }], tools: [], context: [], forwardedProps: { task: 'tsk-not-here' } });
    await other.text();
    expect(seen).not.toMatch(/The task the user asked you to do/);
  });
});

describe('booking from Ask', () => {
  let cal: { connectionId: string; account: string };
  beforeEach(async () => {
    cal = await connectApp(w, 'gcal', 'owner@doit.test');
    await jobs().drain();
    model().reset();
  });

  it('proposes the meeting with its guests, waits for the person’s OK, then books it', async () => {
    model().script.push({ toolCalls: [{ name: 'book_meeting', arguments: { title: 'Quote review', start: tomorrowAt(10), minutes: 45, guests: ['dana@acme.test'], note: 'Going over the revised quote.' } }] });
    const out = await ask('Book 45 minutes with Dana tomorrow at 10 about the quote.');
    expect(out.status).toBe('waiting_approval');
    const [e] = await effects('calendar.create');
    expect(e).toMatchObject({ status: 'intended', source: 'agent', requested_by: w.userId, approved_by: null });
    expect(e!.payload).toMatchObject({ title: 'Quote review', attendees: ['dana@acme.test'], note: 'Going over the revised quote.' });
    expect(new Date(String(e!.payload.end)).getTime() - new Date(String(e!.payload.start)).getTime()).toBe(45 * 60_000);
    await releaseHolds(w);
    expect(fake().calls.filter((c) => c.connectedAccountId === cal.account && c.slug === 'GOOGLECALENDAR_CREATE_EVENT')).toHaveLength(0);
    await w.cmd({ type: 'effect', id: e!.id, approve: true });
    await releaseHolds(w);
    expect(fake().calls.filter((c) => c.connectedAccountId === cal.account && c.slug === 'GOOGLECALENDAR_CREATE_EVENT')).toHaveLength(1);
  });

  it('says when it clashes, refuses a time that has passed, and isn’t used by a run nobody is watching', async () => {
    await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'events', item: { id: 'ev-busy', title: 'Board call', start: new Date(`${tomorrowAt(14)}:00Z`), end: new Date(`${tomorrowAt(16)}:00Z`), kind: 'meeting', with: [] } }] });
    await jobs().drain();
    const zone = (await rows<{ timezone: string }>('select timezone from workspace where id = $1', [w.workspaceId]))[0]!.timezone;
    expect(zone).toBe('UTC');
    model().script.push({ toolCalls: [{ name: 'book_meeting', arguments: { title: 'Focus', start: tomorrowAt(15) } }] });
    await ask('Block 30 minutes tomorrow at 3 for focus.');
    const [, mine] = await effects('calendar.create');
    expect((mine!.preview.lines ?? []).some((l) => l === 'At the same time as “Board call”')).toBe(true);

    // What the tool told the model, read from the model's next request.
    const toldAfter = async (args: Record<string, unknown>, attended = true) => {
      let told = '';
      model().script.push({ toolCalls: [{ name: 'book_meeting', arguments: args }] }, (req) => {
        told = req.messages[req.messages.length - 1]!.content;
        return { content: 'Done.' };
      });
      await ask('Book it.', undefined, attended);
      return told;
    };
    expect(await toldAfter({ title: 'Late', start: '2020-01-01T09:00' })).toMatch(/already passed/);
    expect(await toldAfter({ title: 'Quiet', start: tomorrowAt(9) }, false)).toMatch(/only booked when the user asks/);
    expect(await effects('calendar.create')).toHaveLength(2);
  });

  it('a meeting booked for a task ticks it off once it is on the calendar', async () => {
    await addTask('tsk-m', 'Book the kickoff call');
    model().script.push({ toolCalls: [{ name: 'book_meeting', arguments: { title: 'Kickoff', start: tomorrowAt(11), guests: ['dana@acme.test'] } }] });
    await ask('Do my task “Book the kickoff call”.', 'tsk-m');
    const [e] = await effects('calendar.create');
    expect(e!.preview.completes).toBe('tsk-m');
    await w.cmd({ type: 'effect', id: e!.id, approve: true });
    await releaseHolds(w);
    expect((await task('tsk-m'))!.status).toBe('done');
  });

  it('list_events shows the calendar between two days, as outside content', async () => {
    await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'events', item: { id: 'ev-1', title: 'Design review', start: new Date(`${tomorrowAt(9)}:00Z`), end: new Date(`${tomorrowAt(10)}:00Z`), kind: 'meeting', with: ['mail:dana@acme.test'] } }] });
    await jobs().drain();
    const day = tomorrowAt(0).slice(0, 10);
    const out = await TOOL_BY_NAME.list_events!.run({ from: day }, { ctx: ctxOf(w), runId: 'run-y', fence: 1, callId: 'c2', attended: true } as never);
    const text = (out as { result: string }).result;
    expect(text).toMatch(/^<untrusted source="calendar">/);
    expect(text).toContain('"title":"Design review"');
    expect(text).toContain(`"start":"${day}T09:00"`);
    expect(text).toContain('"with":["dana@acme.test"]');
  });
});
