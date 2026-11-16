/**
 * Safety property: no cross-workspace reads.
 * Two workspaces are filled with the same kinds of data, then every way of
 * reaching the other's rows is tried: the API with the other's ids, the
 * database as the app role, and the stream.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { appPool, authPool, boot, connectGmail, fake, jobs, newWorkspace, releaseHolds, rows, signUp, withWorkspace, addMember, type Client, task } from './helpers';

let a: Client;
let b: Client;
let aConn: { connectionId: string; account: string };
let bConn: { connectionId: string; account: string };

beforeAll(async () => {
  await boot();
  a = await newWorkspace('Alpha');
  b = await newWorkspace('Bravo');
  aConn = await connectGmail(a, 'alice@alpha.test');
  bConn = await connectGmail(b, 'bob@bravo.test');
  await jobs().drain();
  fake().deliver(aConn.account, { from: 'Carol <carol@client.test>', subject: 'Alpha secret plan', body: 'The alpha launch code is 4242.' });
  fake().deliver(bConn.account, { from: 'Dave <dave@client.test>', subject: 'Bravo secret plan', body: 'The bravo launch code is 9999.' });
  await a.post('/api/test/fake', { op: 'deliver', message: { from: 'Carol <carol@client.test>', subject: 'Alpha budget', body: 'Alpha budget is 10k.' } });
  await b.post('/api/test/fake', { op: 'deliver', message: { from: 'Dave <dave@client.test>', subject: 'Bravo budget', body: 'Bravo budget is 20k.' } });
  await a.cmd({ type: 'ws', ops: [{ op: 'put', col: 'tasks', item: task('task-a', 'Alpha only task') }] });
  await b.cmd({ type: 'ws', ops: [{ op: 'put', col: 'tasks', item: task('task-b', 'Bravo only task') }] });
  await a.cmd({ type: 'sendNew', draft: { to: ['mail:x@alpha-client.test'], subject: 'From Alpha', body: 'Alpha body' } });
  await b.cmd({ type: 'sendNew', draft: { to: ['mail:y@bravo-client.test'], subject: 'From Bravo', body: 'Bravo body' } });
  await releaseHolds(a);
  await releaseHolds(b);
});

const TABLES = ['state_doc', 'state_change', 'command', 'connection', 'sync_cursor', 'trigger_instance', 'item', 'item_body', 'effect', 'approval', 'audit_log', 'provider_call'];

describe('the database, as the app role', () => {
  it('both workspaces really have rows in every table under test', async () => {
    for (const t of TABLES) {
      const n = await rows<{ n: number }>(`select count(distinct workspace_id)::int as n from ${t} where workspace_id = any($1)`, [[a.workspaceId, b.workspaceId]]);
      expect(n[0]!.n, `${t} has rows for both workspaces`).toBe(2);
    }
  });

  it('sees nothing when no workspace is set', async () => {
    const c = await appPool().connect();
    try {
      for (const t of [...TABLES, 'workspace', 'run', 'run_checkpoint', 'policy', 'usage_event']) expect((await c.query(`select count(*)::int as n from ${t}`)).rows[0].n, t).toBe(0);
    } finally {
      c.release();
    }
  });

  it('sees only its own workspace when one is set', async () => {
    await withWorkspace({ workspaceId: a.workspaceId }, async (tx) => {
      for (const t of TABLES) {
        const r = (await tx.query(`select count(*)::int as n, count(*) filter (where workspace_id <> $1)::int as other from ${t}`, [a.workspaceId])).rows[0];
        expect(r.n, `${t} is visible`).toBeGreaterThan(0);
        expect(r.other, `${t} leaks`).toBe(0);
      }
      expect((await tx.query('select id from workspace')).rows.map((r) => r.id)).toEqual([a.workspaceId]);
      // Asking for the other workspace's rows by id finds nothing.
      expect((await tx.query('select 1 from item where workspace_id = $1', [b.workspaceId])).rowCount).toBe(0);
      expect((await tx.query('select 1 from connection where id = $1', [bConn.connectionId])).rowCount).toBe(0);
    });
  });

  it('cannot write into another workspace', async () => {
    await expect(withWorkspace({ workspaceId: a.workspaceId }, (tx) => tx.query(`insert into state_doc (workspace_id, slice, id, data, rev) values ($1, 'ws.tasks', 'evil', '{}'::jsonb, 1)`, [b.workspaceId]))).rejects.toThrow(/row-level security/);
    const moved = await withWorkspace({ workspaceId: a.workspaceId }, (tx) => tx.query(`update state_doc set data = '{"hacked":true}'::jsonb where workspace_id = $1`, [b.workspaceId]));
    expect(moved.rowCount).toBe(0);
    await expect(withWorkspace({ workspaceId: a.workspaceId }, (tx) => tx.query(`update state_doc set workspace_id = $1 where workspace_id = $2 and slice = 'ws.tasks'`, [b.workspaceId, a.workspaceId]))).rejects.toThrow(/row-level security/);
  });

  it('cannot read sign-in data, raw webhooks, secrets or the mail outbox', async () => {
    const c = await appPool().connect();
    try {
      for (const sql of ['select * from auth."user"', 'select * from auth.session', 'select * from auth.account', 'select * from webhook_event', 'select * from app_secret', 'select * from email_outbox']) {
        await expect(c.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    } finally {
      c.release();
    }
  });

  it('cannot bypass row-level security or become the owner', async () => {
    const c = await appPool().connect();
    try {
      const role = (await c.query(`select rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname = current_user`)).rows[0];
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false });
      await expect(c.query('set role timmy_owner')).rejects.toThrow(/permission denied/);
      await expect(c.query('alter table item disable row level security')).rejects.toThrow(/must be owner/);
    } finally {
      c.release();
    }
  });
});

describe('the API', () => {
  it('each workspace sees only its own state', async () => {
    const sa = await a.state();
    const sb = await b.state();
    expect(Object.keys(sa.ws.tasks)).toEqual(['task-a']);
    expect(Object.keys(sb.ws.tasks)).toEqual(['task-b']);
    expect(JSON.stringify(sa)).not.toMatch(/bravo|Bravo/);
    expect(JSON.stringify(sb)).not.toMatch(/alpha|Alpha/);
    expect(sa.threads.some((t) => t.subject === 'Alpha budget')).toBe(true);
    expect(sb.threads.some((t) => t.subject === 'Alpha budget')).toBe(false);
  });

  it('another workspace’s ids find nothing', async () => {
    const [effB] = await rows<{ id: string }>('select id from effect where workspace_id = $1 limit 1', [b.workspaceId]);
    const [cmdB] = await rows<{ id: string }>('select id from command where workspace_id = $1 order by at desc limit 1', [b.workspaceId]);
    expect((await a.get(`/api/v1/effects/${effB!.id}`)).status).toBe(404);
    expect((await a.cmd({ type: 'effect', id: effB!.id, approve: true })).ok).toBe(false);
    expect((await a.cmd({ type: 'undo', command: cmdB!.id })).ok).toBe(false);
    // A patch aimed at the other workspace's task only ever touches the sender's own state.
    await a.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'tasks', id: 'task-b', patch: { title: 'hacked' } }] });
    expect((await b.state()).ws.tasks['task-b']).toMatchObject({ title: 'Bravo only task' });
    const audit = await a.json<{ entries: { effect_id: string | null }[] }>('GET', '/api/v1/audit?limit=500');
    const bEffects = new Set((await rows<{ id: string }>('select id from effect where workspace_id = $1', [b.workspaceId])).map((r) => r.id));
    expect(audit.entries.length).toBeGreaterThan(0);
    expect(audit.entries.some((e) => e.effect_id && bEffects.has(e.effect_id))).toBe(false);
  });

  it('a workspace cannot be chosen by header, query or body', async () => {
    const res = await a.request('GET', `/api/v1/state?workspaceId=${b.workspaceId}`, undefined, { 'x-workspace-id': b.workspaceId });
    expect(JSON.stringify(await res.json())).not.toMatch(/Bravo/);
    const out = await a.json<{ ok: boolean }>('POST', '/api/v1/commands', { id: 'x-ws-1', workspaceId: b.workspaceId, action: { type: 'ws', ops: [{ op: 'put', col: 'tasks', item: task('task-x', 'injected') }] } });
    expect(out.ok).toBe(true);
    expect((await b.state()).ws.tasks['task-x']).toBeUndefined();
    expect((await a.state()).ws.tasks['task-x']).toBeDefined();
  });

  it('someone who is not a member cannot switch into a workspace', async () => {
    const stranger = await signUp('Stranger');
    await stranger.post('/api/auth/organization/set-active', { organizationId: a.workspaceId });
    expect((await stranger.get('/api/v1/state')).status).toBeGreaterThanOrEqual(400);
    // Even with the session row forced to point there, the membership check refuses.
    await authPool.query('update session set "activeOrganizationId" = $1 where "userId" = $2', [a.workspaceId, stranger.userId]);
    expect((await stranger.get('/api/v1/state')).status).toBe(403);
    expect((await stranger.post('/api/v1/commands', { id: 's1', action: { type: 'toggleStar', id: 'x' } })).status).toBe(403);
    expect((await stranger.get('/api/v1/stream')).status).toBe(403);
    expect((await stranger.post('/api/v1/agent/runs', { messages: [{ role: 'user', content: 'hi' }] })).status).toBe(403);
  });

  it('nobody signed in gets nothing', async () => {
    const app = await boot();
    for (const path of ['/api/v1/state', '/api/v1/me', '/api/v1/audit', '/api/v1/settings', '/api/v1/stream', '/api/v1/usage']) expect((await app.request(path)).status, path).toBe(401);
    expect((await app.request('/api/v1/commands', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:8787' }, body: '{}' })).status).toBe(401);
  });

  it('a cross-site request is refused even with a valid session', async () => {
    const res = await a.request('POST', '/api/v1/commands', { id: 'csrf-1', action: { type: 'toggleStar', id: 'x' } }, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('a webhook for one mailbox never lands in another workspace', async () => {
    const d = fake().deliver(bConn.account, { from: 'Eve <eve@x.test>', subject: 'Only for Bravo', body: 'bravo eyes only' });
    const app = await boot();
    expect((await app.request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body })).status).toBe(200);
    await jobs().drain();
    expect((await b.state()).threads.some((t) => t.subject === 'Only for Bravo')).toBe(true);
    expect((await a.state()).threads.some((t) => t.subject === 'Only for Bravo')).toBe(false);
  });

  it('a mailbox tool call for one workspace cannot use another’s connection', async () => {
    const { callTool } = await import('../src/sync/tools');
    const res = await callTool(a.workspaceId, bConn.connectionId, 'GMAIL_FETCH_EMAILS', { max_results: 5 }, 'sync');
    expect(res.successful).toBe(false);
    expect(res.error).toMatch(/not connected/);
  });

  it('roles: a client can read nothing, RevOps and clients cannot change state, a member cannot change settings', async () => {
    const client = await addMember(a.workspaceId, 'client');
    const revops = await addMember(a.workspaceId, 'revops');
    const member = await addMember(a.workspaceId, 'member');
    expect((await client.get('/api/v1/state')).status).toBe(403);
    expect((await client.get('/api/v1/audit')).status).toBe(403);
    expect((await client.cmd({ type: 'ws', ops: [{ op: 'put', col: 'tasks', item: task('c1', 'x') }] })).ok).toBe(false);
    expect((await revops.get('/api/v1/state')).status).toBe(200);
    expect((await revops.cmd({ type: 'ws', ops: [{ op: 'put', col: 'tasks', item: task('r1', 'x') }] })).ok).toBe(false);
    expect((await member.cmd({ type: 'ws', ops: [{ op: 'put', col: 'tasks', item: task('m1', 'x') }] })).ok).toBe(true);
    expect((await member.request('PATCH', '/api/v1/settings', { approvalMode: 'auto' })).status).toBe(403);
    expect((await member.cmd({ type: 'conn', op: { op: 'delegate', patch: { on: true } } })).ok).toBe(false);
    expect((await a.request('PATCH', '/api/v1/settings', { approvalMode: 'auto' })).status).toBe(200);
    expect((await a.request('PATCH', '/api/v1/settings', { approvalMode: 'ask' })).status).toBe(200);
  });
});
