import { beforeAll, describe, expect, it } from 'vitest';
import { subscribe } from '../src/state/hub';
import { startHub, stopHub } from '../src/state/hub';
import { forget } from '../src/state/docs';
import { mutate } from '../src/state/mutate';
import { addMember, boot, newWorkspace, rows, type Client } from './helpers';

let w: Client;
beforeAll(async () => {
  await boot();
  w = await newWorkspace('Cmd');
});

describe('a new workspace', () => {
  it('starts empty, with the product’s defaults and none of the demo’s sample data', async () => {
    const s = await w.state();
    expect(s.threads).toEqual([]);
    expect(s.deals).toEqual({});
    expect(Object.keys(s.ws.tasks)).toEqual([]);
    expect(s.out.leads).toEqual({});
    expect(s.conn.apps).toEqual({});
    expect(s.rules.find((r) => r.id === 'p1')).toMatchObject({ locked: true, enabled: true });
    expect(s.rules.find((r) => r.id === 'w3')!.text).toContain('Best, Cmd');
    expect(JSON.stringify(s)).not.toMatch(/Northpeak|Taylor|Acme|northwind/i);
    expect(Object.values(s.out.channels).every((c) => !c.connected)).toBe(true);
  });
});

describe('commands', () => {
  it('apply the reducer’s change, persist it and report it as patches', async () => {
    const out = await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'tasks', item: { id: 't1', title: 'Write the plan', done: false, due: new Date('2026-11-20T17:00:00Z') } }] });
    expect(out.ok).toBe(true);
    expect(out.patches).toMatchObject([{ s: 'ws.tasks', id: 't1' }]);
    forget();
    const s = await w.state();
    expect(s.ws.tasks.t1).toMatchObject({ title: 'Write the plan' });
    expect((s.ws.tasks.t1 as unknown as { due: Date }).due).toBeInstanceOf(Date);
    expect(s.rev).toBe(out.rev);
  });

  it('a retry with the same id is answered from the record and changes nothing', async () => {
    const a = await w.cmd({ type: 'addRule', group: 'triage', text: 'Only once' }, 'same-id');
    const b = await w.cmd({ type: 'addRule', group: 'triage', text: 'Only once' }, 'same-id');
    expect(b.rev).toBe(a.rev);
    expect((await w.state()).rules.filter((r) => r.text === 'Only once')).toHaveLength(1);
  });

  it('a recorded answer is only given back to the person who sent the command', async () => {
    const mine = await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'notes', item: { id: 'private-retry', text: 'for my eyes' } }] }, 'retry-owner-1');
    expect(mine.ok).toBe(true);
    const colleague = await addMember(w.workspaceId, 'member');
    const client = await addMember(w.workspaceId, 'client');
    for (const other of [colleague, client]) {
      const got = await other.cmd({ type: 'ws', ops: [] }, 'retry-owner-1');
      expect(got.ok).toBe(false);
      expect(JSON.stringify(got)).not.toContain('for my eyes');
    }
    expect((await w.cmd({ type: 'ws', ops: [] }, 'retry-owner-1')).patches).toEqual(mine.patches);
  });

  it('ui-only actions change nothing on the server', async () => {
    const before = (await w.state()).rev;
    for (const action of [{ type: 'navigate', route: { view: 'approvals' } }, { type: 'search', open: true }, { type: 'toast', text: 'hi' }, { type: 'setFocus', on: true }]) expect((await w.cmd(action)).patches).toEqual([]);
    expect((await w.state()).rev).toBe(before);
  });

  it('undo puts back exactly what the command changed', async () => {
    await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'tasks', item: { id: 't2', title: 'Keep me' } }] });
    const out = await w.cmd({ type: 'ws', ops: [{ op: 'remove', col: 'tasks', id: 't2' }, { op: 'put', col: 'notes', item: { id: 'n1', text: 'New note' } }] });
    expect((await w.state()).ws.tasks.t2).toBeUndefined();
    expect((await w.cmd({ type: 'undo', command: out.id })).ok).toBe(true);
    const s = await w.state();
    expect(s.ws.tasks.t2).toMatchObject({ title: 'Keep me' });
    expect(s.ws.notes.n1).toBeUndefined();
    // Undoing twice is harmless.
    expect((await w.cmd({ type: 'undo', command: out.id })).ok).toBe(true);
    expect((await w.state()).ws.tasks.t2).toBeDefined();
  });

  it('undo leaves alone anything changed since', async () => {
    await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'tasks', item: { id: 't3', title: 'v1' } }] });
    const edit = await w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'tasks', id: 't3', patch: { title: 'v2' } }] });
    await w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'tasks', id: 't3', patch: { title: 'v3' } }] });
    const undone = await w.cmd({ type: 'undo', command: edit.id });
    expect(undone.toast?.text).toMatch(/except what has changed since/);
    expect((await w.state()).ws.tasks.t3).toMatchObject({ title: 'v3' });
  });

  it('activity gets real times and ids that never repeat', async () => {
    const lead = (id: string) => ({ id, first: 'L', last: id, email: `${id}@x.test`, company: 'C', title: 'T', status: 'new', source: 'csv', fit: 1, added: new Date() });
    await w.cmd({ type: 'out', op: { op: 'import', list: { id: 'list-1', name: 'L1', added: new Date(), count: 1 }, leads: [lead('la')] } });
    forget();
    await w.cmd({ type: 'out', op: { op: 'import', list: { id: 'list-2', name: 'L2', added: new Date(), count: 1 }, leads: [lead('lb')] } });
    const s = await w.state();
    const ids = s.activity.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of s.activity) expect(Math.abs(new Date(a.at).getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('commands for one workspace apply in order, even when sent at once', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'notes', item: { id: `burst-${i}`, text: `${i}` } }] })));
    const s = await w.state();
    expect(Object.keys(s.ws.notes).filter((k) => k.startsWith('burst-'))).toHaveLength(12);
    const revs = await rows<{ rev: number }>('select rev from state_change where workspace_id = $1 order by rev', [w.workspaceId]);
    expect(revs.map((r) => r.rev)).toEqual(revs.map((_, i) => revs[0]!.rev + i));
  });

  it('malformed commands are refused without changing anything', async () => {
    const before = (await w.state()).rev;
    expect((await w.post('/api/v1/commands', {})).status).toBe(400);
    expect((await w.cmd({ nope: true })).ok).toBe(false);
    const unknown = await w.cmd({ type: 'no-such-action' });
    expect(unknown).toMatchObject({ ok: false, patches: [] });
    expect((await w.state()).rev).toBe(before);
  });
});

describe('the stream', () => {
  it('delivers each change once, in order, to that workspace’s tabs only', async () => {
    await startHub();
    const other = await newWorkspace('Listener');
    const mine: number[] = [];
    const theirs: number[] = [];
    const rev = (await w.state()).rev;
    const off1 = subscribe({ workspaceId: w.workspaceId, rev, send: (e, d) => e === 'patch' && mine.push((d as { rev: number }).rev) });
    const off2 = subscribe({ workspaceId: other.workspaceId, rev: (await other.state()).rev, send: (e, d) => e === 'patch' && theirs.push((d as { rev: number }).rev) });
    for (let i = 0; i < 3; i++) await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'notes', item: { id: `s-${i}`, text: 'x' } }] });
    await new Promise((r) => setTimeout(r, 400));
    expect(mine).toEqual([rev + 1, rev + 2, rev + 3]);
    expect(theirs).toEqual([]);
    off1();
    off2();
    // A tab that reconnects from an older revision is caught up from the log.
    const late: number[] = [];
    const off3 = subscribe({ workspaceId: w.workspaceId, rev: rev + 1, send: (e, d) => e === 'patch' && late.push((d as { rev: number }).rev) });
    await new Promise((r) => setTimeout(r, 300));
    expect(late).toEqual([rev + 2, rev + 3]);
    off3();
    await stopHub();
  });

  it('a change made by a command says which command, so the tab that sent it knows its own change', async () => {
    await startHub();
    const seen: { rev: number; command?: string }[] = [];
    const off = subscribe({ workspaceId: w.workspaceId, rev: (await w.state()).rev, send: (e, d) => e === 'patch' && seen.push(d as { rev: number; command?: string }) });
    const made = await w.cmd({ type: 'addRule', group: 'triage', text: 'Flag mail from my accountant.' }, 'named-command-1');
    // A change that no command made (new mail, a job) carries no command id.
    await mutate(w.workspaceId, 'job', async (_tx, loaded) => ({ state: { ...loaded.state, highlight: 'set by a job' }, result: null }));
    await new Promise((r) => setTimeout(r, 400));
    expect(seen.map((s) => s.command)).toEqual(['named-command-1', undefined]);
    expect(seen[0]!.rev).toBe(made.rev);
    off();
    await stopHub();
  });
});

describe('shutting down', () => {
  it('stopping the stream hub twice at once does not crash', async () => {
    await startHub();
    await expect(Promise.all([stopHub(), stopHub()])).resolves.toBeDefined();
    await startHub();
    await stopHub();
  });
});

describe('settings', () => {
  it('the model can only be one from the list', async () => {
    const s = await w.json<{ model: string; models: { id: string }[] }>('GET', '/api/v1/settings');
    expect(s.model).toBe('anthropic/claude-opus-5.5');
    expect(s.models.map((m) => m.id)).toEqual(['anthropic/claude-opus-5.5']);
    expect((await w.request('PATCH', '/api/v1/settings', { model: 'openai/gpt-anything' })).status).toBe(400);
    expect((await w.request('PATCH', '/api/v1/settings', { model: 'anthropic/claude-opus-5.5' })).status).toBe(200);
    expect((await rows<{ action: string }>(`select action from audit_log where workspace_id = $1 and action = 'settings.changed'`, [w.workspaceId])).length).toBeGreaterThan(0);
  });

  it('an owner can set the monthly limit and how much runs at once, up to the server’s ceiling; nobody else can', async () => {
    type Settings = { monthlySpendCapUsd: number; maxConcurrentRuns: number; limits: { monthlySpendCapUsd: number; maxConcurrentRuns: number } };
    const start = await w.json<Settings>('GET', '/api/v1/settings');
    expect(start).toMatchObject({ monthlySpendCapUsd: 50, maxConcurrentRuns: 2, limits: { monthlySpendCapUsd: 200, maxConcurrentRuns: 4 } });

    expect((await w.request('PATCH', '/api/v1/settings', { monthlySpendCapUsd: 120, maxConcurrentRuns: 3 })).status).toBe(200);
    expect(await w.json<Settings>('GET', '/api/v1/settings')).toMatchObject({ monthlySpendCapUsd: 120, maxConcurrentRuns: 3 });

    // Past the ceiling, below zero, or not a number: refused, and the limit stays where it was.
    for (const bad of [{ monthlySpendCapUsd: 200.01 }, { monthlySpendCapUsd: -1 }, { monthlySpendCapUsd: '500' }, { monthlySpendCapUsd: null }, { maxConcurrentRuns: 5 }, { maxConcurrentRuns: 0 }, { maxConcurrentRuns: 1.5 }]) {
      const res = await w.request('PATCH', '/api/v1/settings', bad);
      expect([JSON.stringify(bad), res.status]).toEqual([JSON.stringify(bad), 400]);
    }
    expect(await w.json<Settings>('GET', '/api/v1/settings')).toMatchObject({ monthlySpendCapUsd: 120, maxConcurrentRuns: 3 });

    const member = await addMember(w.workspaceId, 'member');
    expect((await member.request('PATCH', '/api/v1/settings', { monthlySpendCapUsd: 200 })).status).toBe(403);
    expect(await w.json<Settings>('GET', '/api/v1/settings')).toMatchObject({ monthlySpendCapUsd: 120 });

    const changed = await rows<{ detail: Record<string, unknown> }>(`select detail from audit_log where workspace_id = $1 and action = 'settings.changed' order by id desc limit 1`, [w.workspaceId]);
    expect(changed[0]!.detail).toMatchObject({ monthlySpendCapUsd: 120, maxConcurrentRuns: 3 });
  });

  it('a setting the API does not know is neither stored nor written to the audit log', async () => {
    expect((await w.request('PATCH', '/api/v1/settings', { killSwitch: false, somethingElse: 'x'.repeat(50) })).status).toBe(200);
    const last = await rows<{ detail: Record<string, unknown> }>(`select detail from audit_log where workspace_id = $1 and action = 'settings.changed' order by id desc limit 1`, [w.workspaceId]);
    expect(last[0]!.detail).not.toHaveProperty('somethingElse');
  });
});
