import type { Action } from '../state/store';
import { fromWire, toWire } from './patches';
import type { CommandResult, LiveProfile } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** One request to Timmy's API. Same origin, so the sign-in cookie travels on its own. */
async function call<T>(method: string, path: string, body?: unknown, opts: { outliveThePage?: boolean; repeatable?: boolean } = {}): Promise<T> {
  const payload = body !== undefined ? toWire(body) : undefined;
  // A change made a moment before the tab is closed or reloaded must still reach the server. The browser finishes
  // such a request after the page is gone, as long as it is small (its limit is 64 KB across requests in flight).
  const keepalive = !!opts.outliveThePage && (payload?.length ?? 0) < 30_000;
  const once = () => fetch(path, { method, credentials: 'same-origin', headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: payload, keepalive });
  // A request can be lost on the way (a dropped connection) without the server ever seeing it. One that is safe to
  // repeat is tried once more: a read, or a write the server recognises as the same one. An answer from the server,
  // whatever it says, is never retried.
  const res = await once().catch((e) => (method === 'GET' || opts.repeatable ? once() : Promise.reject(e)));
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? fromWire<Record<string, unknown>>(text) : {};
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new ApiError(String(data.error ?? data.message ?? 'Something went wrong. Try again.'), res.status);
  return data as T;
}

export interface Me {
  user: { id: string; name: string; email: string };
  workspaces: { id: string; name: string; role: string }[];
  active: (LiveProfile['workspace'] & { can: LiveProfile['can']; model: string; models: LiveProfile['models']; approvalMode: 'ask' | 'auto' }) | null;
}

export interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  organizationId: string;
  organizationName: string;
  inviterEmail: string;
}

export interface Snapshot {
  rev: number;
  slices: Record<string, unknown>;
  me: { name: string | null; email: string | null; company: string };
}

export type { CommandResult };

export const api = {
  me: () => call<Me>('GET', '/api/v1/me').catch((e) => (e instanceof ApiError && e.status === 401 ? null : Promise.reject(e))),
  /** `token` is null when the address has to be confirmed first: the account exists but nobody is signed in yet. */
  signUp: (name: string, email: string, password: string) => call<{ token: string | null }>('POST', '/api/auth/sign-up/email', { name, email, password, callbackURL: '/' }),
  signIn: (email: string, password: string) => call('POST', '/api/auth/sign-in/email', { email, password }),
  magicLink: (email: string) => call('POST', '/api/auth/sign-in/magic-link', { email, callbackURL: '/' }),
  signOut: () => call('POST', '/api/auth/sign-out', {}, { repeatable: true }),
  createWorkspace: (name: string, trade: string) => call<{ id: string }>('POST', '/api/auth/organization/create', { name, trade, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace'}-${Math.random().toString(36).slice(2, 8)}` }),
  setActive: (organizationId: string) => call('POST', '/api/auth/organization/set-active', { organizationId }),
  /** What an invitation says, for the person it was sent to. Reading it joins nothing. */
  invitation: (id: string) => call<Invitation>('GET', `/api/auth/organization/get-invitation?id=${encodeURIComponent(id)}`),
  acceptInvitation: (invitationId: string) => call<{ invitation?: { organizationId?: string } }>('POST', '/api/auth/organization/accept-invitation', { invitationId }),
  state: () => call<Snapshot>('GET', '/api/v1/state'),
  command: (id: string, action: Action) => call<CommandResult>('POST', '/api/v1/commands', { id, action }, { outliveThePage: true, repeatable: true }),
  connect: (app: string) => call<{ redirectUrl: string }>('POST', `/api/v1/connections/${app}/connect`, {}),
  disconnect: (app: string) => call('POST', `/api/v1/connections/${app}/disconnect`, {}),
  settings: () =>
    call<{ model: string; models: LiveProfile['models']; approvalMode: 'ask' | 'auto'; killSwitch: boolean; timezone: string; monthlySpendCapUsd: number; maxConcurrentRuns: number; limits: { monthlySpendCapUsd: number; maxConcurrentRuns: number } }>('GET', '/api/v1/settings'),
  saveSettings: (patch: { model?: string; approvalMode?: 'ask' | 'auto'; killSwitch?: boolean; monthlySpendCapUsd?: number; timezone?: string }) => call('PATCH', '/api/v1/settings', patch),
  /** Asks the model for a summary of the page as it is on screen. Only lines the page backs come back. */
  summarizePage: (id: string, blocks: unknown[]) => call<{ lines: { text: string; blocks: string[] }[] }>('POST', `/api/v1/pages/${encodeURIComponent(id)}/summarize`, { blocks }),
  audit: () => call<{ entries: { id: number; at: Date; actor: string; action: string; effect_id: string | null; detail: Record<string, unknown> }[] }>('GET', '/api/v1/audit?limit=100'),
};
