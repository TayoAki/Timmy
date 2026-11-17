/**
 * How fast one visitor or one network address may use the public chat routes.
 *
 * These counters live in this process's memory. They slow a flood down at the door; the caps that hold across
 * restarts and instances (messages per conversation, conversations and messages per widget per day) are counted
 * in the database, in visitor.ts.
 */
import type { Context } from 'hono';

interface Count {
  n: number;
  /** When this window ends and the count starts again. */
  until: number;
}

const counts = new Map<string, Count>();
const open = new Map<string, number>();
/** Past this many keys the expired ones are swept; past twice this, new keys are refused until some expire. */
const MAX_KEYS = 50_000;

function sweep(now: number) {
  for (const [k, c] of counts) if (c.until <= now) counts.delete(k);
}

/** Counts one use of `key` and says whether it is still within `limit` per `windowMs`. */
export function allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const c = counts.get(key);
  if (c && c.until > now) {
    if (c.n >= limit) return false;
    c.n++;
    return true;
  }
  if (counts.size >= MAX_KEYS) sweep(now);
  // Full of live keys: someone is inventing them faster than they expire. Refusing new ones keeps memory bounded.
  if (counts.size >= MAX_KEYS * 2) return false;
  counts.set(key, { n: 1, until: now + windowMs });
  return limit >= 1;
}

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

/** Forgets every count. For tests. */
export function resetLimits() {
  counts.clear();
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
