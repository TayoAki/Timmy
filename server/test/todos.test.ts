/**
 * To-dos from email (src/agent/read.ts, todosFrom): what the newest message asks of the person becomes a task in
 * Tasks, linked to the thread and its project, resting on a sentence really in that message; made once, however often
 * the thread is read; checked off like any task; never across workspaces.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '../../src/data/ws-types';
import type { Scan } from '../src/projects/scan';
import { boot, connectGmail, fake, jobs, model, newWorkspace, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };

const deliver = async (from: string, subject: string, body: string, threadId?: string) => {
  const d = fake().deliver(box.account, { from, subject, body, ...(threadId ? { threadId } : {}) });
  await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
  await jobs().drain();
  return d.message;
};
const tasks = async (c: Client = w) => Object.values((await c.state()).ws.tasks) as Task[];

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  model().reset();
  jobs().queue = [];
  w = await newWorkspace('Todos');
  box = await connectGmail(w, 'me@mycompany.test');
  await jobs().drain();
});

describe('to-dos from email', () => {
  it('what the newest message asks becomes a task, linked to the thread, resting on a sentence really in it', async () => {
    await deliver('Dana Whitfield <dana@acme.test>', 'SOW', 'Hi,\n\nPlease send the signed SOW by 2026-11-20. Thanks!\n\nDana');
    const [t, ...more] = await tasks();
    expect(more).toHaveLength(0);
    const thread = (await w.state()).threads.find((x) => x.subject === 'SOW')!;
    expect(t).toMatchObject({ title: 'Send the signed SOW', status: 'todo', priority: 'normal', thread: thread.id, by: 'timmy' });
    expect(new Date(t!.due!).toISOString().slice(0, 10)).toBe('2026-11-20');
    expect(t!.notes).toContain('Please send the signed SOW by 2026-11-20.');
    // The stand-in also offered "Wire money to an account", resting on a sentence that isn't in the mail: dropped.
    expect((await tasks()).some((x) => /wire/i.test(x.title))).toBe(false);
    expect(thread.history?.at(-1)?.text).toMatch(/Timmy added a to-do: Send the signed SOW/);
  });

  it('is made once: a later message in the thread does not make it again, and a new ask makes a new one', async () => {
    const first = await deliver('Dana Whitfield <dana@acme.test>', 'SOW', 'Please send the signed SOW by 2026-11-20.');
    await deliver('Dana Whitfield <dana@acme.test>', 'Re: SOW', 'Just checking you saw this.', first.threadId);
    expect((await tasks()).map((t) => t.title)).toEqual(['Send the signed SOW']);
    await deliver('Dana Whitfield <dana@acme.test>', 'Re: SOW', 'Please book the kickoff call by 2026-11-22.', first.threadId);
    expect((await tasks()).map((t) => t.title).sort()).toEqual(['Book the kickoff call', 'Send the signed SOW']);
  });

  it('a thread with nothing asked makes no task', async () => {
    await deliver('Lee Park <lee@northwind.test>', 'FYI', 'The renewal went through. Nothing needed from you.');
    expect(await tasks()).toHaveLength(0);
  });

  it('checks off like any task, and stays checked off when the thread is read again', async () => {
    const first = await deliver('Dana Whitfield <dana@acme.test>', 'SOW', 'Please send the signed SOW by 2026-11-20.');
    const [t] = await tasks();
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'tasks', id: t!.id, patch: { status: 'done' } }] })).ok).toBe(true);
    await deliver('Dana Whitfield <dana@acme.test>', 'Re: SOW', 'Got it, thanks.', first.threadId);
    expect((await tasks()).map((x) => [x.title, x.status])).toEqual([['Send the signed SOW', 'done']]);
  });

  it('goes into the thread’s project, now or when the thread is put in one', async () => {
    await deliver('Dana Whitfield <dana@acme.test>', 'Website kickoff', 'Please share the brand guide by 2026-11-21.');
    await deliver('Sam Rivera <sam@acme.test>', 'Wireframes', 'Here are the wireframes.');
    await w.request('POST', '/api/v1/projects/detect', {});
    await jobs().drain();
    const scan = (await w.json<{ scan: Scan }>('GET', '/api/v1/projects/detect')).scan;
    const acme = scan.proposals.find((p) => p.keys[0] === 'org:acme.test')!;
    await w.request('POST', `/api/v1/projects/detect/${scan.id}/apply`, { choices: [{ id: acme.id, keep: true }] });
    const project = Object.values((await w.state()).ws.projects)[0]!;
    expect((await tasks()).find((t) => t.title === 'Share the brand guide')!.project).toBe(project.id);
    // New mail from Acme goes into the project as it arrives, and so does what it asks.
    await deliver('Morgan Lee <morgan@acme.test>', 'Copy', 'Please review the page copy by 2026-11-23.');
    expect((await tasks()).find((t) => t.title === 'Review the page copy')!.project).toBe(project.id);
  });

  it('another workspace sees none of it', async () => {
    await deliver('Dana Whitfield <dana@acme.test>', 'SOW', 'Please send the signed SOW by 2026-11-20.');
    const other = await newWorkspace('Elsewhere');
    expect(await tasks(other)).toHaveLength(0);
  });
});
