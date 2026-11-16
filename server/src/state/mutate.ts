import type { State } from '../../../src/state/store';
import { withWorkspace, type Tx } from '../db/pool';
import { commitState, loadState, remember, type Commit, type Loaded } from './docs';

/**
 * Changes a workspace's state from server code (sync, the gateway, the agent).
 * Takes the workspace lock, hands `fn` the current state, saves what it returns
 * as one revision, and announces it to open tabs.
 */
export async function mutate<T>(workspaceId: string, origin: string, fn: (tx: Tx, loaded: Loaded) => Promise<{ state?: State; result: T }>): Promise<T> {
  let commit: Commit | null = null;
  const result = await withWorkspace({ workspaceId, lock: true }, async (tx) => {
    const loaded = await loadState(tx, workspaceId);
    const out = await fn(tx, loaded);
    if (out.state && out.state !== loaded.state) commit = await commitState(tx, loaded, out.state, origin);
    return out.result;
  });
  if (commit) remember((commit as Commit).next);
  return result;
}

/** Reads a workspace's state without changing it. */
export async function readState(workspaceId: string): Promise<Loaded> {
  return withWorkspace({ workspaceId }, (tx) => loadState(tx, workspaceId));
}
