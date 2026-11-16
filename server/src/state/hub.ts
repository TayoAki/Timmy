import type pg from 'pg';
import { sysPool, withWorkspace } from '../db/pool';
import { log } from '../lib/log';
import type { Patch } from '../../../src/live/patches';
import { changesSince } from './docs';

/**
 * Fans state changes out to open tabs. Every commit announces its workspace
 * and revision on a Postgres channel; each API instance listens and forwards
 * the patches to its own subscribers, so jobs and other instances reach the browser too.
 */
export interface Subscriber {
  workspaceId: string;
  /** The last revision this tab has. */
  rev: number;
  send: (event: string, data: unknown) => void;
  busy?: boolean;
  /** A change was announced while a catch-up was already running. */
  again?: boolean;
}

const subscribers = new Map<string, Set<Subscriber>>();
let listener: pg.PoolClient | null = null;

export async function startHub() {
  if (listener) return;
  listener = await sysPool.connect();
  listener.on('notification', (n) => {
    if (n.channel !== 'timmy_state' || !n.payload) return;
    const at = n.payload.lastIndexOf(':');
    void flush(n.payload.slice(0, at));
  });
  listener.on('error', (e) => log.error('state listener failed', { error: e.message }));
  await listener.query('listen timmy_state');
}

export async function stopHub() {
  subscribers.clear();
  if (listener) {
    await listener.query('unlisten timmy_state').catch(() => {});
    listener.release();
    listener = null;
  }
}

export function subscribe(sub: Subscriber): () => void {
  if (!subscribers.has(sub.workspaceId)) subscribers.set(sub.workspaceId, new Set());
  subscribers.get(sub.workspaceId)!.add(sub);
  void catchUp(sub);
  return () => {
    const set = subscribers.get(sub.workspaceId);
    set?.delete(sub);
    if (set && !set.size) subscribers.delete(sub.workspaceId);
  };
}

async function flush(workspaceId: string) {
  for (const sub of subscribers.get(workspaceId) ?? []) await catchUp(sub);
}

/** Sends a tab everything after the revision it has. The read is scoped to the tab's own workspace. */
async function catchUp(sub: Subscriber) {
  if (sub.busy) {
    sub.again = true;
    return;
  }
  sub.busy = true;
  try {
    do {
      sub.again = false;
      const changes = await withWorkspace({ workspaceId: sub.workspaceId }, (tx) => changesSince(tx, sub.workspaceId, sub.rev));
      if (changes === null) {
        // Too far behind to replay: the tab reloads its snapshot.
        sub.send('reload', {});
        return;
      }
      for (const c of changes) {
        sub.send('patch', { rev: c.rev, patches: c.patches as Patch[] });
        sub.rev = c.rev;
      }
      if (changes.length) sub.again = true;
    } while (sub.again);
  } catch (e) {
    log.warn('stream catch-up failed', { error: (e as Error).message });
  } finally {
    sub.busy = false;
  }
}
