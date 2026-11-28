/**
 * Kontract's engine API (`/api/v1`): where Timmy gets public contracting data, the way Magpie does.
 *
 * Kontract keeps the public data: federal notices from SAM.gov's daily file, state and local bids, what a bid's
 * documents say, past awards from USAspending, local businesses, what a business's website says, building permits.
 * Timmy keeps each workspace's own records (its bids, their prices, subs and proposals) and never stores anything
 * of theirs in Kontract. Kontract never sees a Timmy session or anyone's records, only which workspace a call is for.
 *
 * Every call carries the service key (`KONTRACT_SERVICE_KEY`, one of the keys in Kontract's `KONTRACT_SERVICE_KEYS`)
 * and `X-Workspace-Id: timmy-<workspace id>`. Calls that cost Kontract money (Claude, business search, website
 * reading) say what they cost in `X-Kontract-Cost-Micro`. Timmy checks the workspace's monthly limit before one, and
 * records each call's cost in the same usage log as the model, so the limit covers both.
 *
 * Off until `KONTRACT_URL` and `KONTRACT_SERVICE_KEY` are set on the server. Tests and the stand-in providers use
 * a fake engine (testing/kontract.ts).
 */
import { config } from '../config';
import { withWorkspace } from '../db/pool';
import { log } from '../lib/log';
import { checkBudget } from '../providers/model';
import { FakeKontract } from '../testing/kontract';
import { KontractError } from './errors';

export { KontractError };
import type {
  BreakdownResponse,
  DetailsResponse,
  HealthResponse,
  Opportunity,
  OpportunitiesResponse,
  OpportunityResponse,
  PermitContractorsResponse,
  PricingQuery,
  PricingResponse,
  QuotesResponse,
  SubcontractorsResponse,
  TextResponse,
  WebsiteResponse,
} from '../../../src/data/kontract-api';

/** What one engine call gave back, and what it cost in millionths of a dollar. */
export interface Paid<T> {
  data: T;
  costMicro: number;
}

/** The search parameters Kontract takes for open notices (the query params of its /api/opportunities). */
export interface OpportunitySearch {
  q?: string;
  state?: string;
  naics?: string;
  setAside?: string;
  postedWithinDays?: number;
  minDaysToRespond?: number;
  servicesOnly?: boolean;
  biddableOnly?: boolean;
  sort?: 'fit' | 'deadline' | 'posted';
  level?: 'federal' | 'sled';
  limit?: number;
  offset?: number;
}

/** The engine's calls, each for one Kontract workspace (`timmy-<workspace id>`). */
export interface KontractEngine {
  health(): Promise<HealthResponse>;
  opportunities(ws: string, search: OpportunitySearch): Promise<Paid<OpportunitiesResponse>>;
  opportunity(ws: string, id: string): Promise<Paid<OpportunityResponse>>;
  details(ws: string, id: string, body: { claude?: boolean; opportunity?: Opportunity }): Promise<Paid<DetailsResponse>>;
  breakdown(ws: string, id: string, body: { opportunity?: Opportunity }): Promise<Paid<BreakdownResponse>>;
  text(ws: string, id: string, body: { offset?: number; limit?: number; opportunity?: Opportunity }): Promise<Paid<TextResponse>>;
  quotes(ws: string, id: string, body: { quotes: { quote: string; doc?: string }[]; opportunity?: Opportunity }): Promise<Paid<QuotesResponse>>;
  pricing(ws: string, body: { query: PricingQuery; context?: { agency?: string; state?: string } }): Promise<Paid<PricingResponse>>;
  subcontractors(ws: string, body: { query: string; location: string }): Promise<Paid<SubcontractorsResponse>>;
  website(ws: string, url: string): Promise<Paid<WebsiteResponse>>;
  permitContractors(ws: string, q: { state: string; city?: string; work?: string }): Promise<Paid<PermitContractorsResponse>>;
}

/** Kontract's own words for a failed call are kept only when they are short plain sentences about the request. */
const ownWords = (s: unknown) => (typeof s === 'string' && s.length <= 200 && !/[<>{}]/.test(s) ? s : '');

export class HttpKontract implements KontractEngine {
  constructor(
    private base: string,
    private key: string,
    private timeoutMs = 120_000,
  ) {}

  private async call<T>(ws: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Paid<T>> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.key}`, 'x-workspace-id': ws, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      log.warn('kontract unreachable', { path: path.split('?')[0], error: (e as Error).message });
      throw new KontractError(502, 'Kontract couldn’t be reached just now. Try again in a moment.');
    }
    const cost = Math.max(0, Math.round(Number(res.headers.get('x-kontract-cost-micro') ?? 0)) || 0);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const said = ownWords((json as { error?: unknown } | null)?.error);
      if (res.status === 401) {
        // The key is wrong or missing on one side. The person can't fix that; the log says which call.
        log.warn('kontract refused the service key', { path: path.split('?')[0] });
        throw new KontractError(502, 'Timmy’s connection to Kontract isn’t set up right. The people who run Timmy have been told.');
      }
      if (res.status === 429) {
        const after = Math.max(1, Math.round(Number(res.headers.get('retry-after') ?? 60)) || 60);
        throw new KontractError(429, `Kontract is busy for this workspace. Try again in ${after} second${after === 1 ? '' : 's'}.`, after);
      }
      if (res.status === 404) throw new KontractError(404, said || 'Kontract has no open notice with that id.');
      if (res.status >= 400 && res.status < 500) throw new KontractError(400, said || 'Kontract couldn’t do that with what was asked.');
      throw new KontractError(502, 'Kontract had a problem with that. Try again in a moment.');
    }
    if (json === null || typeof json !== 'object') throw new KontractError(502, 'Kontract sent back something Timmy couldn’t read.');
    return { data: json as T, costMicro: cost };
  }

  async health(): Promise<HealthResponse> {
    const res = await fetch(`${this.base}/api/v1/health`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new KontractError(502, 'Kontract isn’t answering.');
    return (await res.json()) as HealthResponse;
  }
  opportunities(ws: string, s: OpportunitySearch) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(s)) if (v !== undefined && v !== '' && v !== false) p.set(k, v === true ? '1' : String(v));
    return this.call<OpportunitiesResponse>(ws, 'GET', `/api/v1/opportunities?${p}`);
  }
  opportunity(ws: string, id: string) {
    return this.call<OpportunityResponse>(ws, 'GET', `/api/v1/opportunities/${encodeURIComponent(id)}`);
  }
  details(ws: string, id: string, body: { claude?: boolean; opportunity?: Opportunity }) {
    return this.call<DetailsResponse>(ws, 'POST', `/api/v1/opportunities/${encodeURIComponent(id)}/details`, body);
  }
  breakdown(ws: string, id: string, body: { opportunity?: Opportunity }) {
    return this.call<BreakdownResponse>(ws, 'POST', `/api/v1/opportunities/${encodeURIComponent(id)}/breakdown`, body);
  }
  text(ws: string, id: string, body: { offset?: number; limit?: number; opportunity?: Opportunity }) {
    return this.call<TextResponse>(ws, 'POST', `/api/v1/opportunities/${encodeURIComponent(id)}/text`, body);
  }
  quotes(ws: string, id: string, body: { quotes: { quote: string; doc?: string }[]; opportunity?: Opportunity }) {
    return this.call<QuotesResponse>(ws, 'POST', `/api/v1/opportunities/${encodeURIComponent(id)}/quotes`, body);
  }
  pricing(ws: string, body: { query: PricingQuery; context?: { agency?: string; state?: string } }) {
    return this.call<PricingResponse>(ws, 'POST', '/api/v1/pricing', body);
  }
  subcontractors(ws: string, body: { query: string; location: string }) {
    return this.call<SubcontractorsResponse>(ws, 'POST', '/api/v1/subcontractors', body);
  }
  website(ws: string, url: string) {
    return this.call<WebsiteResponse>(ws, 'POST', '/api/v1/websites/read', { url });
  }
  permitContractors(ws: string, q: { state: string; city?: string; work?: string }) {
    const p = new URLSearchParams({ state: q.state, ...(q.city ? { city: q.city } : {}), ...(q.work ? { work: q.work } : {}) });
    return this.call<PermitContractorsResponse>(ws, 'GET', `/api/v1/permits/contractors?${p}`);
  }
}

/* ───────────── Which engine ───────────── */

let engine: KontractEngine | null | undefined;

/** The engine this server uses, or null when Kontract isn't set up. */
export function kontract(): KontractEngine | null {
  if (engine === undefined) {
    if (config.fakeProviders) engine = new FakeKontract();
    else if (config.kontract.url && config.kontract.key) engine = new HttpKontract(config.kontract.url, config.kontract.key);
    else engine = null;
  }
  return engine;
}
export const kontractReady = () => !!kontract();
/** The stand-in engine, when this server runs on stand-ins (tests, and the live test suites). */
export function fakeKontract(): FakeKontract | null {
  const e = kontract();
  return e instanceof FakeKontract ? e : null;
}
export function setKontractForTests(e: KontractEngine | null | undefined) {
  engine = e;
}

/** The workspace as Kontract knows it: `timmy-` and Timmy's id, lowercased. Never a name or an address. */
export function kontractWorkspace(workspaceId: string): string {
  return `timmy-${workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`.slice(0, 64);
}

/** Which calls may cost money, so the workspace's monthly limit is checked before them. */
const PAID = new Set(['details', 'breakdown', 'subcontractors', 'websites/read']);

/**
 * One engine call for a workspace: the limit checked first when the call can cost money, then the call, then one
 * line in the usage log with what Kontract said it cost (0 for free and cached calls) and whether it worked.
 * `unattended` is work nobody asked for, which may only use its share of the limit.
 */
export async function callKontract<T>(workspaceId: string, endpoint: string, fn: (e: KontractEngine, ws: string) => Promise<Paid<T>>, opts: { unattended?: boolean; runId?: string } = {}): Promise<T> {
  const e = kontract();
  if (!e) throw new KontractError(503, 'Government bids aren’t switched on for this server yet.');
  if (PAID.has(endpoint)) await checkBudget(workspaceId, opts.unattended);
  const started = Date.now();
  let out: Paid<T> | null = null;
  try {
    out = await fn(e, kontractWorkspace(workspaceId));
    return out.data;
  } finally {
    const cost = (out?.costMicro ?? 0) / 1_000_000;
    await withWorkspace({ workspaceId }, async (tx) => {
      await tx.query(
        `insert into usage_event (workspace_id, route, model, provider, run_id, cost_usd, ms, ok, unattended)
         values ($1, $2, 'kontract', 'kontract', $3, $4, $5, $6, $7)`,
        [workspaceId, `kontract:${endpoint}`, opts.runId ?? null, cost, Date.now() - started, !!out, !!opts.unattended],
      );
      if (opts.runId && cost) await tx.query('update run set cost_usd = cost_usd + $2 where id = $1', [opts.runId, cost]);
    }).catch((err) => log.warn('could not record kontract usage', { error: (err as Error).message }));
  }
}
