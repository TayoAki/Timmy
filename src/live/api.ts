import type { Action } from '../state/store';
import { clearsAsNull, fromWire, toWire } from './patches';
import type { TrackedOverview, TrackedThing } from './tracked';
import type { CommandResult, LiveProfile } from './types';
import type { Block, DocCover } from '../data/ws-types';

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

/** One earlier copy of a page, as the version history lists it: when it was kept, ahead of whose change, and why. */
export interface PageVersion {
  number: number;
  at: Date;
  by: string;
  why: 'edit' | 'before-timmy' | 'before-restore';
  preview: string;
  blockCount: number;
}

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
  command: (id: string, action: Action) => call<CommandResult>('POST', '/api/v1/commands', { id, action: clearsAsNull(action) }, { outliveThePage: true, repeatable: true }),
  connect: (app: string) => call<{ redirectUrl: string }>('POST', `/api/v1/connections/${app}/connect`, {}),
  disconnect: (app: string) => call('POST', `/api/v1/connections/${app}/disconnect`, {}),
  /** Detecting projects: start a scan, read the latest, keep what was found, and a project's linked files and meetings. */
  detectProjects: () => call<ProjectScan>('POST', '/api/v1/projects/detect', {}),
  projectScan: () => call<{ scan: ProjectScan | null }>('GET', '/api/v1/projects/detect'),
  keepProjects: (scanId: string, choices: { id: string; keep: boolean; name?: string; into?: string }[]) =>
    call<{ created: { id: string; name: string; threads: number; files: number; meetings: number }[] }>('POST', `/api/v1/projects/detect/${encodeURIComponent(scanId)}/apply`, { choices }),
  projectLinks: (projectId: string) =>
    call<{ files: { id: string; name: string; kind: string; changed: string; link?: string }[]; meetings: { id: string; title: string; at: string }[] }>('GET', `/api/v1/projects/${encodeURIComponent(projectId)}/links`),
  /** One email as its sender laid it out: cleaned HTML, or the plain text when it has no HTML. */
  mailOriginal: (thread: string, message: string, images = false) =>
    call<{ html?: string; text?: string; blocked: number }>('GET', `/api/v1/mail/original?thread=${encodeURIComponent(thread)}&message=${encodeURIComponent(message)}${images ? '&images=1' : ''}`),
  /** The files Timmy lists from a connected Google Drive or OneDrive, newest first. */
  connectedFiles: (q = '') =>
    call<{ apps: string[]; total: number; files: { id: string; name: string; kind: string; app: string; owner?: string; changed: string; link?: string; readable: boolean }[] }>('GET', `/api/v1/connected-files${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  settings: () =>
    call<{ model: string; models: LiveProfile['models']; approvalMode: 'ask' | 'auto'; killSwitch: boolean; timezone: string; monthlySpendCapUsd: number; maxConcurrentRuns: number; limits: { monthlySpendCapUsd: number; maxConcurrentRuns: number }; autoSort: { on: boolean; since?: string } }>('GET', '/api/v1/settings'),
  saveSettings: (patch: { model?: string; approvalMode?: 'ask' | 'auto'; killSwitch?: boolean; monthlySpendCapUsd?: number; timezone?: string; autoSort?: boolean }) =>
    call<{ ok: boolean; sorted?: { archived?: number; 'read-through'?: number } }>('PATCH', '/api/v1/settings', patch),
  /** Asks the model for a summary of the page as it is on screen. Only lines the page backs come back. */
  summarizePage: (id: string, blocks: unknown[]) => call<{ lines: { text: string; blocks: string[] }[] }>('POST', `/api/v1/pages/${encodeURIComponent(id)}/summarize`, { blocks }),
  /** A page's earlier versions, newest first, without their contents. */
  pageVersions: (id: string) => call<{ versions: PageVersion[]; canRestore: boolean; keeps: { versions: number; days: number; minutes: number } }>('GET', `/api/v1/pages/${encodeURIComponent(id)}/versions`),
  /** One version with its contents, for a preview. */
  pageVersion: (id: string, number: number) => call<PageVersion & { blocks: Block[]; icon?: string; cover?: DocCover }>('GET', `/api/v1/pages/${encodeURIComponent(id)}/versions/${number}`),
  /** Puts a version back as the page's contents. The server keeps what it replaces as a version too. */
  restorePageVersion: (id: string, number: number) => call<{ ok: true; changed: boolean; leftOut?: number; links?: { block: string; page: string }[]; note?: string }>('POST', `/api/v1/pages/${encodeURIComponent(id)}/versions/${number}/restore`, {}),
  /** How many days a page stays in the trash before it is deleted for good. */
  pageTrash: () => call<{ keptDays: number }>('GET', '/api/v1/pages/trash'),
  audit: () => call<{ entries: { id: number; at: Date; actor: string; action: string; effect_id: string | null; detail: Record<string, unknown> }[] }>('GET', '/api/v1/audit?limit=100'),
  /** What an automation has done lately: its runs, newest first, each with its steps. */
  automationRuns: (id: string) => call<AutomationRuns>('GET', `/api/v1/automations/${encodeURIComponent(id)}/runs`),
  /** A test run on the server, of the steps as drawn: what each would do with sample data or a recent email. Nothing is done. */
  automationTest: (id: string, body: ({ sample: true } | { eventId: string }) & { graph: { nodes: unknown[]; edges: unknown[] } }) => call<AutomationTest>('POST', `/api/v1/automations/${encodeURIComponent(id)}/test`, body),
  /** The recent emails a test run can start from, newest first. */
  automationTestEmails: () => call<{ emails: TestEmail[] }>('GET', '/api/v1/automations/test-emails'),
  /** What Timmy offers to track and what it tracks (deals, properties…), for the review screen on People. */
  tracked: () => call<TrackedOverview>('GET', '/api/v1/tracked'),
  trackedThings: (id: string) => call<{ things: TrackedThing[] }>('GET', `/api/v1/tracked/${encodeURIComponent(id)}/things`),
  acceptTracking: (key: string, name?: string) => call('POST', `/api/v1/tracked/proposals/${encodeURIComponent(key)}/accept`, name ? { name } : {}),
  dismissTracking: (key: string) => call('POST', `/api/v1/tracked/proposals/${encodeURIComponent(key)}/dismiss`, {}),
  changeTracked: (id: string, change: { name?: string; removeField?: string }) => call('PATCH', `/api/v1/tracked/${encodeURIComponent(id)}`, change),
  stopTracking: (id: string) => call<{ removed: number }>('DELETE', `/api/v1/tracked/${encodeURIComponent(id)}`),
  /** Offers a kind that was turned down or stopped again, as a suggestion. */
  bringBackTracking: (key: string) => call('POST', `/api/v1/tracked/proposals/${encodeURIComponent(key)}/bring-back`, {}),
  /** "Same thing?": keeps one and moves everything the other rests on to it. */
  mergeThings: (kindId: string, keep: string, merge: string) => call<{ moved: number }>('POST', `/api/v1/tracked/${encodeURIComponent(kindId)}/merge`, { keep, merge }),
  /** "Same thing?": no, they differ; not asked again. */
  keepThingsApart: (kindId: string, a: string, b: string) => call('POST', `/api/v1/tracked/${encodeURIComponent(kindId)}/apart`, { a, b }),
};

export interface AutomationRun {
  id: string;
  status: 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
  /** What set it off, in a line. */
  startedBy: string;
  createdAt: Date;
  finishedAt: Date | null;
  /** When a paused run carries on. */
  wakeAt: Date | null;
  error: string | null;
  steps: { id: string; kind: string; label: string; status: 'running' | 'waiting' | 'done' | 'failed' | 'cancelled'; text: string; error: string | null; attempt: number }[];
}

export interface AutomationRuns {
  automation: { id: string; on: boolean; note: string | null; nextRunAt: Date | null };
  runs: AutomationRun[];
}

/** An email a test run can start from. */
export interface TestEmail {
  id: string;
  from: string;
  subject: string;
  at: string;
}

/** What a test run on the server says each step would do. */
export interface AutomationTest {
  dryRun: true;
  source: 'sample' | 'email';
  fields: Record<string, string>;
  steps: {
    id: string;
    kind: string;
    label: string;
    text: string;
    /** Why this block can't run on a real workspace yet. */
    notYet?: string;
    /** What the step would put forward in Approvals. */
    wouldAsk?: { kind: 'email.reply' | 'automation.ask'; title: string; to?: string[]; subject?: string; body?: string };
  }[];
  /** Steps the test never reached (the branch not taken). */
  skipped: string[];
  /** What would stop it being switched on. Empty when nothing would. */
  problems: string[];
}

/** What a project scan found (server/src/projects/detect.ts). */
export interface DetectedProject {
  id: string;
  name: string;
  kind: 'client' | 'deal' | 'hiring' | 'vendor' | 'internal' | 'personal' | 'other';
  summary: string;
  keys: string[];
  organization?: { domain: string; name: string };
  people: { email: string; name: string; messages: number }[];
  threads: string[];
  subjects: string[];
  files: { itemId: string; name: string; link?: string }[];
  meetings: { itemId: string; title: string; at: string }[];
  last: string;
}

export interface ProjectScan {
  id: string;
  status: 'running' | 'ready' | 'failed' | 'applied';
  startedAt: string;
  finishedAt?: string;
  error?: string;
  proposals: DetectedProject[];
  looked: { threads?: number; junk?: number; meetings?: number; files?: number };
}
