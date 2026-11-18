/**
 * Ask through CopilotKit's runtime (src/http/copilotkit.ts): the runtime is mounted at /api/copilotkit behind the same
 * sign-in as the rest of the app, it offers one agent, Timmy, and a run is Timmy's own Ask run as the person who asked,
 * streamed as AG-UI events. A conversation belongs to the person who started it.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { boot, connectGmail, fake, jobs, model, newWorkspace, rows, type Client } from './helpers';

let w: Client;

const runInput = (threadId: string, text: string) => ({
  threadId,
  runId: `run-${Math.random().toString(36).slice(2, 8)}`,
  state: {},
  messages: [{ id: `m-${Math.random().toString(36).slice(2, 8)}`, role: 'user', content: text }],
  tools: [],
  context: [],
  forwardedProps: {},
});

/** The AG-UI events of one run, from the SSE body. */
async function events(res: Response): Promise<{ type: string; [k: string]: unknown }[]> {
  const text = await res.text();
  return text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5).trim()) as { type: string });
}

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  model().reset();
  jobs().queue = [];
  w = await newWorkspace('Copilot');
});

describe('CopilotKit runtime', () => {
  it('needs a sign-in, like every other part of the app', async () => {
    const res = await (await boot()).request('/api/copilotkit/info');
    expect(res.status).toBe(401);
  });

  it('offers one agent, Timmy, with conversations kept in this process when Intelligence is off', async () => {
    const res = await w.request('GET', '/api/copilotkit/info');
    expect(res.status).toBe(200);
    const info = (await res.json()) as { agents?: Record<string, unknown>; mode?: string };
    expect(Object.keys(info.agents ?? {})).toEqual(['timmy']);
    expect(info.mode).toBe('sse');
  });

  it('a run is Timmy’s own Ask run as the person, streamed as AG-UI events', async () => {
    const box = await connectGmail(w, 'me@copilot.test');
    const d = fake().deliver(box.account, { from: 'Dana Whitfield <dana@acme.test>', subject: 'Quote for 120 seats', body: 'Here is the quote.' });
    await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
    await jobs().drain();
    const res = await w.request('POST', '/api/copilotkit/agent/timmy/run', runInput('thread-a', 'What is waiting for me?'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const ev = await events(res);
    expect(ev[0]!.type).toBe('RUN_STARTED');
    expect(ev.at(-1)!.type).toBe('RUN_FINISHED');
    expect(ev.some((e) => e.type === 'TEXT_MESSAGE_CONTENT')).toBe(true);
    // The model was asked as this person, in this workspace, with Timmy's own tools.
    const ask = model().requests.find((r) => r.route === 'ask')!;
    expect(ask.workspaceId).toBe(w.workspaceId);
    expect(ask.messages.at(-1)!.content).toContain('What is waiting for me?');
    expect((ask.tools ?? []).map((t) => t.name)).toContain('search_mail');
    // And it is a run like any other: recorded, and metered.
    expect(await rows(`select 1 from run where workspace_id = $1 and kind = 'ask'`, [w.workspaceId])).not.toHaveLength(0);
  });

  it('a conversation belongs to the person who started it', async () => {
    await w.request('POST', '/api/copilotkit/agent/timmy/run', runInput('thread-private', 'Hello'));
    const other = await newWorkspace('Other');
    const res = await other.request('POST', '/api/copilotkit/agent/timmy/run', { ...runInput('thread-private', 'Let me in') });
    // Refused as if it didn't exist, so nobody learns which conversations there are.
    expect(res.status).toBe(404);
    // Its owner carries on as before.
    const mine = await w.request('POST', '/api/copilotkit/agent/timmy/run', runInput('thread-private', 'And again'));
    expect(mine.status).toBe(200);
    expect((await events(mine)).at(-1)!.type).toBe('RUN_FINISHED');
  });

  it('refuses a request from another site', async () => {
    const res = await (await boot()).request('/api/copilotkit/agent/timmy/run', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json', cookie: [...w.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: JSON.stringify(runInput('thread-x', 'Hello')),
    });
    expect(res.status).toBe(403);
  });
});

describe('organizing by asking, through CopilotKit', () => {
  it('Ask puts an email in a project and adds a to-do for it, inside Timmy only', async () => {
    const box = await connectGmail(w, 'me@copilot.test');
    const d = fake().deliver(box.account, { from: 'Gene Kranz <gene@mission.test>', subject: 'Flight plan', body: 'Here is the plan.' });
    await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
    await jobs().drain();
    await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'projects', item: { id: 'apollo', num: '10', name: 'Apollo launch', color: 'var(--c-blue)', status: 'active', folder: 'f02-10', sources: [] } }] });
    const thread = (await w.state()).threads.find((t) => t.subject === 'Flight plan')!;
    const calls = fake().calls.length;
    model().reset();
    model().script.push(
      { toolCalls: [{ name: 'put_in_project', arguments: { thread: thread.id, project: 'Apollo launch' } }] },
      { toolCalls: [{ name: 'add_task', arguments: { title: 'Review the flight plan', due: '2026-12-01', thread: thread.id } }] },
      { content: 'Done: the email is in Apollo launch, with a to-do to review it.' },
    );
    const res = await w.request('POST', '/api/copilotkit/agent/timmy/run', runInput('thread-org', 'Put the flight plan email in Apollo launch and remind me to review it by Dec 1'));
    const ev = await events(res);
    expect(ev.at(-1)!.type).toBe('RUN_FINISHED');
    const after = await w.state();
    expect(after.threads.find((t) => t.id === thread.id)!.project).toBe('apollo');
    const task = Object.values(after.ws.tasks).find((t) => t.title === 'Review the flight plan')!;
    expect(task).toMatchObject({ project: 'apollo', thread: thread.id });
    // Nothing was asked of the mailbox for it.
    expect(fake().calls.slice(calls).filter((c) => !/FETCH|LIST|GET/.test(c.slug))).toEqual([]);
  });

  it('two to-dos added in one conversation are two to-dos', async () => {
    model().script.push(
      { toolCalls: [{ name: 'add_task', arguments: { title: 'Book the venue' } }, { name: 'add_task', arguments: { title: 'Send the invites' } }] },
      { content: 'Added both.' },
    );
    await events(await w.request('POST', '/api/copilotkit/agent/timmy/run', runInput('thread-two', 'Remind me to book the venue and send the invites')));
    const titles = Object.values((await w.state()).ws.tasks).map((t) => t.title).sort();
    expect(titles).toEqual(['Book the venue', 'Send the invites']);
  });
});

