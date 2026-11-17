import type { Hono } from 'hono';
import { initAuth } from '../src/auth/auth';
import { migrate } from '../src/db/migrate';
import { appPool, authPool, sysPool, withWorkspace } from '../src/db/pool';
import { buildApp } from '../src/http/app';
import type { Env } from '../src/http/session';
import { registerJobs } from '../src/jobs/handlers';
import { inlineJobs } from '../src/jobs/jobs';
import { fakeComposio, type FakeComposio } from '../src/providers/composio';
import { fakeModel, type FakeModel } from '../src/providers/model';
import type { CommandResult } from '../src/state/engine';
import { fromWire } from '../../src/live/patches';
import type { Action, State } from '../../src/state/store';
import { withSlices } from '../../src/live/patches';
import { blankState } from '../../src/live/blank';

let app: Hono<Env> | null = null;
let n = 0;

export async function boot(): Promise<Hono<Env>> {
  if (app) return app;
  await migrate();
  await initAuth();
  registerJobs();
  app = buildApp();
  return app;
}

export const fake = (): FakeComposio => fakeComposio()!;
export const model = (): FakeModel => fakeModel()!;
export const jobs = () => inlineJobs()!;
export { appPool, authPool, sysPool, withWorkspace };

const ORIGIN = 'http://localhost:8787';

/** A signed-in browser: keeps its cookies between requests. */
export class Client {
  cookies = new Map<string, string>();
  userId = '';
  workspaceId = '';
  email = '';

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await (await boot()).request(path, {
      method,
      headers: { origin: ORIGIN, cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const at = pair!.indexOf('=');
      const value = pair!.slice(at + 1);
      if (value) this.cookies.set(pair!.slice(0, at), value);
      else this.cookies.delete(pair!.slice(0, at));
    }
    return res;
  }
  get = (path: string) => this.request('GET', path);
  post = (path: string, body: unknown = {}) => this.request('POST', path, body);
  async json<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body);
    return fromWire<T>(await res.text());
  }

  /** Sends one reducer action, as the frontend would. */
  async cmd(action: Action | Record<string, unknown>, id = `cmd-${++n}-${Math.random().toString(36).slice(2, 8)}`): Promise<CommandResult & { id: string }> {
    const out = await this.json<CommandResult>('POST', '/api/v1/commands', { id, action });
    return { ...out, id };
  }

  /** The state as a browser would hold it. */
  async state(): Promise<State & { rev: number }> {
    const snap = await this.json<{ rev: number; slices: Record<string, unknown> }>('GET', '/api/v1/state');
    return { ...withSlices(blankState({ first: 'T', company: 'T' }), snap.slices), rev: snap.rev };
  }

  async setActive(workspaceId: string) {
    await this.post('/api/auth/organization/set-active', { organizationId: workspaceId });
    this.workspaceId = workspaceId;
  }
}

export async function signUp(name = 'Ada Test'): Promise<Client> {
  const c = new Client();
  c.email = `${name.toLowerCase().replace(/\W+/g, '.')}.${++n}.${Math.random().toString(36).slice(2, 6)}@example.test`;
  const out = await c.json<{ user: { id: string } }>('POST', '/api/auth/sign-up/email', { name, email: c.email, password: 'correct-horse-battery-9' });
  c.userId = out.user.id;
  return c;
}

/** A new person with their own new workspace (they are its owner). */
export async function newWorkspace(name = 'Acme'): Promise<Client> {
  const c = await signUp(`${name} Owner`);
  const org = await c.json<{ id: string }>('POST', '/api/auth/organization/create', { name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${++n}-${Math.random().toString(36).slice(2, 6)}`, trade: 'sales' });
  c.workspaceId = org.id;
  return c;
}

/** Adds a new person to a workspace with a role, the way an accepted invitation would. */
export async function addMember(workspaceId: string, role: string, name = `${role} person`): Promise<Client> {
  const c = await signUp(name);
  await authPool.query('insert into member (id, "organizationId", "userId", role, "createdAt") values ($1, $2, $3, $4, now())', [`mem_${++n}_${Math.random().toString(36).slice(2, 8)}`, workspaceId, c.userId, role]);
  await c.setActive(workspaceId);
  return c;
}

/** Connects a fake account for an app the way a person would: start, consent, come back. Returns its Composio account id. */
export async function connectApp(c: Client, app: string, address: string): Promise<{ connectionId: string; account: string }> {
  fake().nextAddress = address;
  const start = await c.json<{ redirectUrl: string; connectionId: string }>('POST', `/api/v1/connections/${app}/connect`, {});
  const consent = new URL(start.redirectUrl);
  const back = await c.get(consent.pathname + consent.search);
  const callback = new URL(back.headers.get('location')!);
  await c.get(callback.pathname + callback.search);
  const account = new URL(start.redirectUrl).searchParams.get('account')!;
  return { connectionId: start.connectionId, account };
}
export const connectGmail = (c: Client, address: string) => connectApp(c, 'gmail', address);

/** Ends the undo window now and runs whatever was waiting on it. */
export async function releaseHolds(c: Client): Promise<number> {
  const out = await c.json<{ ran: number }>('POST', '/api/test/release-holds', {});
  return out.ran;
}

/** A task as the screens make one. The server refuses a task the board could not draw, so fixtures use a whole one. */
export const task = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, status: 'todo', priority: 'normal', created: new Date('2026-11-16T09:00:00Z'), ...extra });

export const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await sysPool.query(sql, params)).rows as T[];

/* ───────────── Uploaded files ───────────── */

/** A request whose body is raw bytes, with the client's cookies, as a browser sends a file. */
export async function sendBytes(c: Client, method: string, path: string, bytes: Uint8Array, headers: Record<string, string> = {}) {
  return (await boot()).request(path, { method, headers: { origin: ORIGIN, cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...headers }, body: bytes as BodyInit });
}

/** The smallest files of a few kinds: each begins the way a real one does, followed by `fill`. */
const text = (s: string) => new TextEncoder().encode(s);
export const samples = {
  png: (fill = 'timmy') => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...text(fill)]),
  jpeg: (fill = 'timmy') => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...text(fill)]),
  pdf: (fill = 'A quote.') => text(`%PDF-1.4\n${fill}\n%%EOF\n`),
  text,
};

export interface Uploaded {
  status: number;
  assetId: string;
  error?: string;
}

/** Uploads a file the way the browser does: announce it, then send the bytes. `status` is the last answer's. */
export async function uploadFile(c: Client, f: { purpose: string; type: string; bytes: Uint8Array; name?: string }): Promise<Uploaded> {
  const announced = await c.post('/api/v1/uploads', { purpose: f.purpose, type: f.type, size: f.bytes.length, ...(f.name ? { name: f.name } : {}) });
  const told = (await announced.json()) as { assetId?: string; error?: string; upload?: { url: string; method: string } };
  if (announced.status !== 200 || !told.upload) return { status: announced.status, assetId: '', error: told.error };
  const put = await sendBytes(c, told.upload.method, told.upload.url, f.bytes, { 'content-type': f.type });
  const kept = (await put.json()) as { error?: string };
  return { status: put.status, assetId: told.assetId!, error: kept.error };
}
