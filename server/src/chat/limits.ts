/**
 * How fast one visitor or one network address may use the public chat routes, and how many streams may be open.
 *
 * The counts are kept in Postgres (`chat_limit`), so a limit holds however many servers answer: an address one
 * server turned away is turned away by the next. A request costs one statement, whatever it counts. Each server
 * also remembers which keys it has seen go over their limit until their window ends (within a window a count
 * only grows), so a flood from one address stops costing the database anything once it is refused.
 *
 * The caps that hold whatever the address (messages per conversation, conversations and messages per widget per
 * day) are counted in visitor.ts, inside the workspace's own transaction.
 *
 * Open streams are different: a stream is a connection to one server, held by that server's memory, so the
 * places for them are counted here, per server.
 */
import { createHmac } from 'node:crypto';
import type { Context } from 'hono';
import { sysPool } from '../db/pool';
import { chatSecret } from './token';

/** One thing to count: `key` may be used `limit` times per `windowMs`. */
export interface Limit {
  key: string;
  limit: number;
  windowMs: number;
}

interface Queryable {
  query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Counts one use of every key at once and returns each key's count in its current window. A window that has
 * ended starts again at one. Keys go in a fixed order, so two servers counting the same keys never wait on each other.
 */
const COUNT = `
  insert into chat_limit as l (key, n, until)
  select t.k, 1, now() + t.w * interval '1 millisecond' from unnest($1::text[], $2::bigint[]) with ordinality as t(k, w, i) order by t.i
  on conflict (key) do update set
    n = case when l.until <= now() then 1 else l.n + 1 end,
    until = case when l.until <= now() then excluded.until else l.until end
  returning key, n, until`;

/** Past this many remembered refusals, the ones whose window has ended are forgotten; past twice this, no more are remembered. */
const MAX_REMEMBERED = 50_000;

/** Changed by `resetLimits()` (tests only): counts made before a reset are kept under other keys and no longer apply. */
let epoch = 0;

export class LimitStore {
  /** Keys this server has seen over their limit, and when their window ends. */
  private over = new Map<string, number>();
  private since = epoch;

  constructor(private db: Queryable = sysPool) {}

  /** Counts one use of each key and says whether every one of them is still within its limit. */
  async allow(checks: Limit[], now = Date.now()): Promise<boolean> {
    if (this.since !== epoch) {
      this.over.clear();
      this.since = epoch;
    }
    if (!checks.length) return true;
    if (checks.some((c) => !(c.limit >= 1))) return false;
    const keyed = new Map<string, Limit>();
    const secret = await chatSecret();
    for (const c of checks) keyed.set(fingerprint(secret, c.key), c);
    for (const k of keyed.keys()) if ((this.over.get(k) ?? 0) > now) return false;

    const keys = [...keyed.keys()].sort();
    const { rows } = await this.db.query(COUNT, [keys, keys.map((k) => Math.max(1, Math.round(keyed.get(k)!.windowMs)))]);
    let ok = true;
    for (const r of rows) {
      const c = keyed.get(r.key as string);
      if (!c || (r.n as number) <= c.limit) continue;
      ok = false;
      this.remember(r.key as string, new Date(r.until as Date).getTime(), now);
    }
    return ok;
  }

  /**
   * Whether this server already knows one of these keys is over its limit, without asking the database or
   * counting anything. For turning a flood away before its request is even read.
   */
  async refusedHere(keys: string[], now = Date.now()): Promise<boolean> {
    if (this.since !== epoch || !this.over.size) return false;
    const secret = await chatSecret();
    return keys.some((k) => (this.over.get(fingerprint(secret, k)) ?? 0) > now);
  }

  private remember(key: string, until: number, now: number) {
    if (this.over.size >= MAX_REMEMBERED) for (const [k, t] of this.over) if (t <= now) this.over.delete(k);
    // Full of live refusals: the database still says no, it just isn't spared the question.
    if (this.over.size < MAX_REMEMBERED * 2) this.over.set(key, until);
  }
}

/**
 * What is stored for a key: a fingerprint keyed with the server's secret. The table never holds an address or a
 * visitor's id, and a fingerprint can't be turned back into one by trying addresses.
 */
function fingerprint(secret: string, key: string): string {
  return createHmac('sha256', secret).update(`chat-limit|${epoch}|${key}`).digest('base64url').slice(0, 32);
}

/** The limits every public chat route on this server counts against. */
export const limits = new LimitStore();

/** Deletes counts whose window has ended. Run from time to time; a count past its window is never read again. */
export async function sweepLimits(): Promise<number> {
  const { rowCount } = await sysPool.query(`delete from chat_limit where until < now() - interval '1 minute'`);
  return rowCount ?? 0;
}

const open = new Map<string, number>();

/** Takes one of `limit` places for `key` (an open stream). Returns the function that gives it back, or null when full. */
export function hold(key: string, limit: number): (() => void) | null {
  const n = open.get(key) ?? 0;
  if (n >= limit) return null;
  open.set(key, n + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (open.get(key) ?? 1) - 1;
    if (left <= 0) open.delete(key);
    else open.set(key, left);
  };
}

/** Forgets every count and every open place. For tests. */
export function resetLimits() {
  epoch++;
  open.clear();
}

/**
 * The address a request came from. Railway's edge sets X-Real-IP to the caller's address; X-Forwarded-For can be
 * sent by anyone, so it is not used. Without the header (a developer's machine) it is the socket's own address.
 */
export function addressOf(c: Context): string {
  const real = c.req.header('x-real-ip');
  if (real && /^[0-9a-fA-F:.]{3,45}$/.test(real)) return real.toLowerCase();
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
  return socket ?? 'unknown';
}
