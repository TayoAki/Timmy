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
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? toWire(body) : undefined });
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

export interface Snapshot {
  rev: number;
  slices: Record<string, unknown>;
  me: { name: string | null; email: string | null; company: string };
}

export type { CommandResult };

export const api = {
  me: () => call<Me>('GET', '/api/v1/me').catch((e) => (e instanceof ApiError && e.status === 401 ? null : Promise.reject(e))),
  signUp: (name: string, email: string, password: string) => call('POST', '/api/auth/sign-up/email', { name, email, password }),
  signIn: (email: string, password: string) => call('POST', '/api/auth/sign-in/email', { email, password }),
  magicLink: (email: string) => call('POST', '/api/auth/sign-in/magic-link', { email, callbackURL: '/' }),
  signOut: () => call('POST', '/api/auth/sign-out', {}),
  createWorkspace: (name: string, trade: string) => call<{ id: string }>('POST', '/api/auth/organization/create', { name, trade, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace'}-${Math.random().toString(36).slice(2, 8)}` }),
  setActive: (organizationId: string) => call('POST', '/api/auth/organization/set-active', { organizationId }),
  acceptInvitation: (invitationId: string) => call<{ invitation?: { organizationId?: string } }>('POST', '/api/auth/organization/accept-invitation', { invitationId }),
  state: () => call<Snapshot>('GET', '/api/v1/state'),
  command: (id: string, action: Action) => call<CommandResult>('POST', '/api/v1/commands', { id, action }),
  connect: (app: string) => call<{ redirectUrl: string }>('POST', `/api/v1/connections/${app}/connect`, {}),
  disconnect: (app: string) => call('POST', `/api/v1/connections/${app}/disconnect`, {}),
  settings: () =>
    call<{ model: string; models: LiveProfile['models']; killSwitch: boolean; monthlySpendCapUsd: number; maxConcurrentRuns: number; limits: { monthlySpendCapUsd: number; maxConcurrentRuns: number } }>('GET', '/api/v1/settings'),
  saveSettings: (patch: { model?: string; killSwitch?: boolean; monthlySpendCapUsd?: number }) => call('PATCH', '/api/v1/settings', patch),
  audit: () => call<{ entries: { id: number; at: Date; actor: string; action: string; effect_id: string | null; detail: Record<string, unknown> }[] }>('GET', '/api/v1/audit?limit=100'),
};
