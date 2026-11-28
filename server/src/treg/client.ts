/**
 * Treg (https://treg.to): one token for many data providers, used to find leads that fit a workspace's offer and to
 * read a business's website. Treg routes each lookup to a provider, falls back on a miss, and reports what it cost.
 *
 * Following Treg's guide for products that call it for their own customers:
 *   - one team token, on the server only (`TREG_TOKEN`), sent as `X-Treg-Token`;
 *   - every call tagged `X-Treg-Meta: workspace=timmy-<id>,feature=<what>` by this code, never by the model, so
 *     Treg can cap and report spend per workspace;
 *   - `X-Treg-Route-Max-Cost` caps each call in dollars (`TREG_MAX_COST_USD`, $0.25 by default);
 *   - an `Idempotency-Key` on each call, so a retry is answered from Treg's store and charged once;
 *   - `X-Treg-Cost-Micro` and `X-Treg-Call-Id` are recorded with the call, in the usage log the model uses, so one
 *     monthly limit covers the model, Kontract and Treg;
 *   - Treg's own refusals carry `X-Treg-Error: 1`. Those about the workspace (its cap, or it being blocked) are told
 *     to the person; those about the team's account (balance, funds, its daily cap) are logged and never forwarded.
 *
 * Off until `TREG_TOKEN` is set. Tests and the stand-in providers use a fake (testing/treg.ts).
 */
import { createHash } from 'node:crypto';
import { config } from '../config';
import { withWorkspace } from '../db/pool';
import { log } from '../lib/log';
import { checkBudget } from '../providers/model';
import { FakeTreg } from '../testing/treg';
import { TregError, tregRefusal } from './errors';

export { TregError, tregRefusal };

/** The routed lookups Timmy uses, by Treg's catalog id. */
export const TREG = {
  companiesSearch: 'treg.companies.search',
  peopleSearch: 'treg.people.search',
  emailFind: 'treg.people.email.find',
  emailVerify: 'treg.people.email.verify',
  companiesEnrich: 'treg.companies.enrich',
  webExtract: 'treg.web.extract',
} as const;
export type TregRoute = (typeof TREG)[keyof typeof TREG];

/** Treg's answer to a routed lookup: the normalized `output`, the provider's own `raw`, and Treg's notes. */
export interface TregAnswer<T = Record<string, unknown>> {
  output: T;
  raw?: unknown;
  _treg?: { served_by?: string; tried?: unknown[]; charged_micro?: number; verification?: { verdict?: string }; domain_match?: unknown; advice?: string };
}

export interface TregCall<T> {
  answer: TregAnswer<T>;
  costMicro: number;
  callId: string | null;
  servedBy: string | null;
}

/** What the engine is asked for one call. `headers` are Treg's routing options (`X-Treg-Route-Verify` and the like). */
export interface TregRequest {
  route: TregRoute;
  body: Record<string, unknown>;
  /** `X-Treg-Meta`, built by tregMeta(): never anything the model wrote. */
  meta: string;
  idempotencyKey: string;
  maxCostUsd: number;
  headers?: Record<string, string>;
}

export interface TregEngine {
  call<T>(req: TregRequest): Promise<TregCall<T>>;
}

export class HttpTreg implements TregEngine {
  constructor(
    private base: string,
    private token: string,
    private timeoutMs = 60_000,
  ) {}

  async call<T>(req: TregRequest): Promise<TregCall<T>> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/call/${req.route}`, {
        method: 'POST',
        headers: {
          'x-treg-token': this.token,
          'x-treg-meta': req.meta,
          'x-treg-route-max-cost': req.maxCostUsd.toFixed(4),
          'idempotency-key': req.idempotencyKey,
          'content-type': 'application/json',
          accept: 'application/json',
          ...(req.headers ?? {}),
        },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      log.warn('treg unreachable', { route: req.route, error: (e as Error).message });
      throw new TregError(502, 'The lead data couldn’t be reached just now. Try again in a moment.');
    }
    const cost = Math.max(0, Math.round(Number(res.headers.get('x-treg-cost-micro') ?? 0)) || 0);
    const callId = res.headers.get('x-treg-call-id');
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    if (!res.ok) throw tregRefusal(res.status, json, res.headers.get('x-treg-error') === '1', res.headers.get('retry-after'));
    if (!json || typeof json.output !== 'object' || json.output === null) throw new TregError(502, 'The lead data sent back something Timmy couldn’t read.');
    return { answer: json as unknown as TregAnswer<T>, costMicro: cost, callId, servedBy: res.headers.get('x-treg-served-by') ?? ((json._treg as { served_by?: string } | undefined)?.served_by ?? null) };
  }
}

/* ───────────── Which engine ───────────── */

let engine: TregEngine | null | undefined;

export function treg(): TregEngine | null {
  if (engine === undefined) {
    if (config.fakeProviders) engine = new FakeTreg();
    else if (config.treg.token) engine = new HttpTreg(config.treg.url, config.treg.token);
    else engine = null;
  }
  return engine;
}
export const tregReady = () => !!treg();
export function fakeTreg(): FakeTreg | null {
  const e = treg();
  return e instanceof FakeTreg ? e : null;
}
export function setTregForTests(e: TregEngine | null | undefined) {
  engine = e;
}

/**
 * The tags on a call: the workspace as Treg knows it, and what the call is for. Built here from Timmy's own ids, in
 * the characters Treg allows, and never from anything a person or the model typed.
 */
export function tregMeta(workspaceId: string, feature: 'lead-suggest' | 'offer-draft' | 'lead-email' | 'ask'): string {
  const ws = `timmy-${workspaceId.toLowerCase().replace(/[^a-z0-9._:-]/g, '-')}`.slice(0, 128);
  return `workspace=${ws},feature=${feature}`;
}

/**
 * One Treg lookup for a workspace: the monthly limit checked first (every Treg lookup can cost money), the call, and
 * one line in the usage log with what Treg charged, which provider answered and Treg's id for the call. The
 * idempotency key comes from what was asked and `key`, so asking the same thing again within a day is answered from
 * Treg's store and charged once.
 */
export async function callTreg<T>(
  workspaceId: string,
  route: TregRoute,
  body: Record<string, unknown>,
  opts: { feature: Parameters<typeof tregMeta>[1]; key: string; headers?: Record<string, string>; unattended?: boolean; runId?: string },
): Promise<TregCall<T>> {
  const e = treg();
  if (!e) throw new TregError(503, 'Finding leads isn’t switched on for this server yet.');
  await checkBudget(workspaceId, opts.unattended);
  const idempotencyKey = createHash('sha256').update(`${workspaceId}|${route}|${opts.key}|${JSON.stringify(body)}`).digest('hex').slice(0, 64);
  const started = Date.now();
  let out: TregCall<T> | null = null;
  try {
    out = await e.call<T>({ route, body, meta: tregMeta(workspaceId, opts.feature), idempotencyKey, maxCostUsd: config.treg.maxCostUsd, ...(opts.headers ? { headers: opts.headers } : {}) });
    return out;
  } finally {
    const cost = (out?.costMicro ?? 0) / 1_000_000;
    await withWorkspace({ workspaceId }, async (tx) => {
      await tx.query(
        `insert into usage_event (workspace_id, route, model, provider, run_id, cost_usd, generation_id, ms, ok, unattended)
         values ($1, $2, 'treg', $3, $4, $5, $6, $7, $8, $9)`,
        [workspaceId, `treg:${route.replace(/^treg\./, '')}`, (out?.servedBy ?? 'treg').slice(0, 100), opts.runId ?? null, cost, out?.callId?.slice(0, 200) ?? null, Date.now() - started, !!out, !!opts.unattended],
      );
      if (opts.runId && cost) await tx.query('update run set cost_usd = cost_usd + $2 where id = $1', [opts.runId, cost]);
    }).catch((err) => log.warn('could not record treg usage', { error: (err as Error).message }));
  }
}
