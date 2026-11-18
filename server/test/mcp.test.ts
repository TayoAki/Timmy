/**
 * Timmy as an MCP server (src/http/mcp.ts, the OAuth server in src/auth/auth.ts): an app registers, the person signs
 * in, picks a workspace and says yes, the app trades the code for a token bound to /mcp, and calls tools as that
 * person in that workspace, under Ask's rules. Revoking the app, or leaving the workspace, stops it at once.
 */
import { createHash, randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EffectRow } from '../src/gateway/gateway';
import { addMember, boot, connectGmail, fake, jobs, model, newWorkspace, rows, type Client } from './helpers';

const BASE = 'http://localhost:8787';
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = 'http://127.0.0.1:9999/callback';

let w: Client;
let box: { connectionId: string; account: string };

const app = async () => boot();
const json = async <T = Record<string, unknown>>(res: Response) => JSON.parse(await res.text()) as T;

/** An app registering itself, the way an MCP client does on first contact (RFC 7591). */
async function register(name = 'Test MCP client', redirect = REDIRECT) {
  const res = await (await app()).request('/api/auth/oauth2/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  expect(res.status).toBe(201);
  return (await json<{ client_id: string }>(res)).client_id;
}

/** The whole connection, as a person in a browser and the app between them would make it. */
async function connect(person: Client, opts: { clientId?: string; workspace?: string } = {}) {
  const clientId = opts.clientId ?? (await register());
  const verifier = randomBytes(32).toString('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 's1', scope: 'openid offline_access', resource: RESOURCE });
  const authorize = await person.request('GET', `/api/auth/oauth2/authorize?${q}`);
  const pick = new URL(authorize.headers.get('location')!, BASE);
  expect(pick.pathname).toBe('/connect/workspace');
  // The workspace page: the person picks one (it becomes the session's active one), then the flow carries on.
  if (opts.workspace) await person.setActive(opts.workspace);
  const moved = await json<{ url: string }>(await person.request('POST', '/api/auth/oauth2/continue', { postLogin: true, oauth_query: pick.search.slice(1) }));
  const consent = new URL(moved.url, BASE);
  expect(consent.pathname).toBe('/connect/consent');
  const said = await json<{ url: string }>(await person.request('POST', '/api/auth/oauth2/consent', { accept: true, oauth_query: consent.search.slice(1) }));
  const code = new URL(said.url).searchParams.get('code')!;
  const tokens = await json<{ access_token: string; refresh_token: string }>(await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: RESOURCE }));
  return { clientId, token: tokens.access_token, refresh: tokens.refresh_token };
}

const tokenRequest = async (form: Record<string, string>, headers: Record<string, string> = {}) =>
  (await app()).request('/api/auth/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(form).toString() });

/** One JSON-RPC message to /mcp; the answer may come as a plain JSON body or as one server-sent event. */
async function rpc(token: string | null, method: string, params: Record<string, unknown> = {}) {
  const res = await (await app()).request('/mcp', {
    method: 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  const data = text.startsWith('event:') || text.includes('\ndata: ') ? text.split('\n').find((l) => l.startsWith('data: '))!.slice(6) : text;
  return { status: res.status, headers: res.headers, body: JSON.parse(data) as { result?: { content?: { text: string }[]; tools?: { name: string }[]; isError?: boolean }; error?: { message: string } } };
}
const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  return { ...r, text: r.body.result?.content?.map((c) => c.text).join('\n') ?? '', isError: !!r.body.result?.isError };
};
const deliver = async (m: { from: string; subject: string; body: string }) => {
  const d = fake().deliver(box.account, m);
  await (await app()).request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
  await jobs().drain();
};

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  model().reset();
  jobs().queue = [];
  w = await newWorkspace('Headless');
  box = await connectGmail(w, 'owner@headless.test');
  await jobs().drain();
});

describe('finding Timmy', () => {
  it('publishes where to sign in, and asks for a token, without one', async () => {
    const prm = await json<{ resource: string; authorization_servers: string[] }>(await (await app()).request('/.well-known/oauth-protected-resource/mcp'));
    expect(prm).toMatchObject({ resource: RESOURCE, authorization_servers: [`${BASE}/api/auth`] });
    const asm = await json<Record<string, unknown>>(await (await app()).request('/.well-known/oauth-authorization-server/api/auth'));
    expect(asm).toMatchObject({ issuer: `${BASE}/api/auth`, registration_endpoint: `${BASE}/api/auth/oauth2/register`, code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'] });
    const none = await rpc(null, 'tools/list');
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    expect(none.headers.get('access-control-allow-origin')).toBe('*');
    expect((await rpc('not.a.token', 'tools/list')).status).toBe(401);
  });

  it('an app can register and trade codes from another origin, but a person’s consent still needs Timmy’s own page', async () => {
    const res = await (await app()).request('/api/auth/oauth2/register', { method: 'POST', headers: { origin: 'https://claude.ai', 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' }) });
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    const consent = await w.request('POST', '/api/auth/oauth2/consent', { accept: true, oauth_query: 'x=1' }, { origin: 'https://evil.test' });
    expect(consent.status).toBe(403);
  });
});

describe('a connected app', () => {
  it('works in the workspace the person chose, as that person, with no Timmy model call', async () => {
    await deliver({ from: 'Dana Whitfield <dana@acme.test>', subject: 'Revised quote for 120 seats', body: 'Hi, please send the revised quote by Friday.' });
    model().reset();
    const { token } = await connect(w);
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({ sub: w.userId, workspace: w.workspaceId, aud: expect.arrayContaining([RESOURCE]) });
    const init = await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.body.result).toMatchObject({ serverInfo: { name: 'timmy' } });
    const tools = (await rpc(token, 'tools/list')).body.result!.tools!.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['whats_waiting', 'search_mail', 'read_thread', 'draft_reply', 'send_email', 'file_thread', 'save_rule', 'add_task', 'list_projects', 'put_in_project']));
    const waiting = await call(token, 'whats_waiting');
    expect(waiting.text).toContain('<untrusted source="brief">');
    expect(waiting.text).toContain('Revised quote for 120 seats');
    expect((await call(token, 'search_mail', { query: 'revised quote' })).text).toContain('Revised quote for 120 seats');
    // The app's own AI does the thinking: Timmy's model was not asked anything.
    expect(model().requests).toHaveLength(0);
    // Each tool call (not connecting or listing the tools) is on record as a run of its own, for this person.
    expect(await rows<{ kind: string; user_id: string }>(`select kind, user_id from run where workspace_id = $1 and kind = 'mcp'`, [w.workspaceId])).toEqual([
      { kind: 'mcp', user_id: w.userId },
      { kind: 'mcp', user_id: w.userId },
    ]);
  });

  it('anything that would send or file is only prepared, for the person to approve in Timmy; to-dos and projects are kept at once', async () => {
    await deliver({ from: 'Dana Whitfield <dana@acme.test>', subject: 'Kickoff', body: 'Can we meet Tuesday?' });
    const { token } = await connect(w);
    const sent = await call(token, 'send_email', { to: ['dana@acme.test'], subject: 'Tuesday works', body: 'Tuesday at 10?' });
    expect(sent.text).toMatch(/waiting for the user’s OK in Timmy/);
    const [e] = await rows<EffectRow>(`select * from effect where workspace_id = $1 and kind = 'email.send'`, [w.workspaceId]);
    expect(e).toMatchObject({ status: 'intended', source: 'agent', requested_by: w.userId });
    await jobs().drain();
    expect(fake().sent(box.account)).toHaveLength(0);
    const rule = await call(token, 'save_rule', { from: ['newsletters.test'], box: 'archived' });
    expect(rule.text).toMatch(/Save a sorting rule: Mail from anyone at newsletters\.test: archive it\.: prepared and waiting/);
    expect((await w.state()).rules.some((r) => r.mail)).toBe(false);

    const added = await call(token, 'add_task', { title: 'Book the kickoff room', due: '2026-12-01' });
    expect(added.text).toBe('Added to the user’s to-dos: “Book the kickoff room”, due 2026-12-01.');
    const task = Object.values((await w.state()).ws.tasks).find((x) => x.title === 'Book the kickoff room')!;
    expect((await call(token, 'list_tasks')).text).toContain('Book the kickoff room');
    expect((await call(token, 'complete_task', { id: task.id })).text).toBe('Done: “Book the kickoff room”.');
    expect((await w.state()).ws.tasks[task.id]!.status).toBe('done');
    await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'projects', item: { id: 'acme', num: '12', name: 'Acme', color: 'var(--c-sky)', status: 'active', folder: 'f02-12', sources: [] } }] });
    const thread = (await w.state()).threads.find((x) => x.subject === 'Kickoff')!;
    expect((await call(token, 'put_in_project', { thread: thread.id, project: 'acme' })).text).toBe('The thread is in Acme now.');
    expect((await w.state()).threads.find((x) => x.id === thread.id)!.project).toBe('acme');
    expect((await call(token, 'list_projects')).text).toContain('"name":"Acme"');
  });

  it('a person with two workspaces gets the one they picked, and the app sees nothing of the other', async () => {
    await deliver({ from: 'Dana <dana@acme.test>', subject: 'Only in the first', body: 'Hello.' });
    const second = await w.json<{ id: string }>('POST', '/api/auth/organization/create', { name: 'Second', slug: `second-${Math.random().toString(36).slice(2, 8)}`, trade: 'sales' });
    const { token } = await connect(w, { workspace: second.id });
    expect(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).workspace).toBe(second.id);
    expect((await call(token, 'search_mail', { query: 'only in the first' })).text).not.toContain('Only in the first');
    // Nothing a request carries can move it to another workspace: the workspace comes from the token alone.
    const other = await newWorkspace('Stranger');
    const theirs = await connect(other);
    expect((await call(theirs.token, 'whats_waiting')).text).not.toContain('Only in the first');
  });

  it('refreshes, and stops at once when the person revokes it or leaves the workspace', async () => {
    const member = await addMember(w.workspaceId, 'member', 'Mo Member');
    const conn = await connect(member);
    expect((await call(conn.token, 'whats_waiting')).status).toBe(200);
    const fresh = await json<{ access_token: string }>(await tokenRequest({ grant_type: 'refresh_token', refresh_token: conn.refresh, client_id: conn.clientId, resource: RESOURCE }));
    expect((await call(fresh.access_token, 'whats_waiting')).status).toBe(200);
    // Revoked: the token hasn't expired, but it no longer opens anything.
    const consents = await json<{ id: string; clientId: string }[]>(await member.request('GET', '/api/auth/oauth2/get-consents'));
    const mine = consents.find((c) => c.clientId === conn.clientId)!;
    expect((await member.request('POST', '/api/auth/oauth2/delete-consent', { id: mine.id })).status).toBe(200);
    expect((await call(fresh.access_token, 'whats_waiting')).status).toBe(403);
    // Connected again, then removed from the workspace: out at once.
    const again = await connect(member, { clientId: conn.clientId });
    expect((await call(again.token, 'whats_waiting')).status).toBe(200);
    expect((await w.post('/api/auth/organization/remove-member', { memberIdOrEmail: member.email, organizationId: w.workspaceId })).status).toBe(200);
    expect((await call(again.token, 'whats_waiting')).status).toBe(403);
  });

  it('a read-only role reads, but can’t keep a to-do or prepare anything', async () => {
    const revops = await addMember(w.workspaceId, 'revops', 'Ray Ops');
    const { token } = await connect(revops);
    expect((await call(token, 'whats_waiting')).status).toBe(200);
    expect((await call(token, 'add_task', { title: 'Something' })).text).toMatch(/^Nothing was added: /);
    expect((await call(token, 'save_rule', { from: ['x.test'], box: 'archived' })).text).toMatch(/Only an owner or admin/);
  });
});
