/**
 * A New-email automation reads the workspace's mailbox. While none is connected nothing can start it, so it shows
 * as paused with the reason, instead of a switch that says On while nothing can happen. It stays switched on: once
 * a mailbox is connected again it carries on by itself, from mail that arrives after that (triggers.ts only counts
 * mail newer than the connection).
 *
 * Runs that started from mail in a mailbox that is disconnected are stopped: their email has left Timmy with the
 * mailbox, so their remaining steps would only fail.
 */
import type { State } from '../../../src/state/store';
import type { Tx } from '../db/pool';
import { audit } from '../gateway/gateway';
import type { Loaded } from '../state/docs';
import { MAIL_TOOLKITS } from '../sync/mailbox';
import { TIMMY, stopRuns } from './stop';

/** What a paused automation says, in the words the person sees. */
export const NO_MAILBOX = 'Connect a mailbox to run this.';

/** Whether the workspace has its everyday mailbox (Gmail or Outlook) connected. */
export async function hasMailbox(tx: Tx, workspaceId: string): Promise<boolean> {
  const { rows } = await tx.query(`select 1 from connection where workspace_id = $1 and status = 'active' and purpose = 'primary' and toolkit = any($2::text[]) limit 1`, [workspaceId, MAIL_TOOLKITS]);
  return rows.length > 0;
}

/** The state with `paused` set (or cleared) on these automations. */
function withPaused(state: State, ids: string[], paused: string | undefined): State {
  const automations = { ...state.ws.automations };
  for (const id of ids) {
    const a = automations[id];
    if (!a) continue;
    const { paused: _was, ...rest } = a;
    automations[id] = paused ? { ...rest, paused } : rest;
  }
  return { ...state, ws: { ...state.ws, automations } };
}

/**
 * Called in the transaction that disconnects connections, after they are marked disconnected. Stops the runs that
 * started from mail in them, and, when no mailbox is left, pauses every New-email automation that is on.
 */
export async function pauseWithoutMailbox(tx: Tx, loaded: Loaded, state: State, closed: string[]): Promise<State> {
  const workspaceId = loaded.workspace.id;
  const stopped = await stopRuns(tx, loaded, state, TIMMY, { connectionIds: closed }, 'The mailbox this run started from was disconnected.');
  if (await hasMailbox(tx, workspaceId)) return stopped.state;
  const { rows } = await tx.query(
    `update automation_live set paused_reason = $2, updated_at = now() where workspace_id = $1 and enabled and trigger_kind = 'email' and paused_reason is null returning automation_id`,
    [workspaceId, NO_MAILBOX],
  );
  const ids = rows.map((r) => r.automation_id as string);
  if (!ids.length) return stopped.state;
  await audit(tx, workspaceId, { actor: 'system', action: 'automation.paused', detail: { automations: ids, reason: NO_MAILBOX, runsStopped: stopped.stopped } });
  return withPaused(stopped.state, ids, NO_MAILBOX);
}

/** Called in the transaction that makes a mailbox active: the automations that were waiting for one carry on. */
export async function resumeWithMailbox(tx: Tx, loaded: Loaded, state: State): Promise<State> {
  const workspaceId = loaded.workspace.id;
  const { rows } = await tx.query(`update automation_live set paused_reason = null, updated_at = now() where workspace_id = $1 and paused_reason is not null returning automation_id, enabled`, [workspaceId]);
  if (!rows.length) return state;
  const resumed = rows.filter((r) => r.enabled).map((r) => r.automation_id as string);
  if (resumed.length) await audit(tx, workspaceId, { actor: 'system', action: 'automation.resumed', detail: { automations: resumed } });
  return withPaused(state, rows.map((r) => r.automation_id as string), undefined);
}
