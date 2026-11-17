/**
 * Stopping runs that are still going, and taking back what they had waiting for a decision (an “Ask me first”, or
 * an email put forward for approval). A send that has already left stays sent.
 *
 * Used when a person switches an automation off or deletes it, when the mailbox a run started from is disconnected,
 * and when the owner or admin an automation runs for no longer has that say.
 */
import type { State } from '../../../src/state/store';
import { rulesFor } from '../auth/roles';
import type { Tx } from '../db/pool';
import { cancelHeld } from '../gateway/gateway';
import type { Actor } from '../gateway/policy';
import type { Loaded } from '../state/docs';

/** Timmy itself, when nobody pressed anything: it may take back what an automation put forward, and nothing else. */
export const TIMMY: Actor = { userId: 'system', name: 'Timmy', role: '', rules: rulesFor('') };

/** Which runs to stop: one automation's, or those that started from mail in one of these mailboxes. */
export type Which = { automationId: string } | { connectionIds: string[] };

export async function stopRuns(tx: Tx, loaded: Loaded, state: State, actor: Actor, which: Which, why: string): Promise<{ state: State; stopped: number }> {
  const workspaceId = loaded.workspace.id;
  const { rows } = await tx.query(
    `update automation_run set status = 'cancelled', error = $2, finished_at = now(), lease_token = null, lease_until = null, wake_at = null, updated_at = now()
     where workspace_id = $1 and status in ('queued', 'running', 'waiting')
       and ($3::text is null or automation_id = $3) and ($4::text[] is null or context->'trigger'->>'connectionId' = any($4::text[]))
     returning id, waiting_effect_id`,
    [workspaceId, why, 'automationId' in which ? which.automationId : null, 'connectionIds' in which ? which.connectionIds : null],
  );
  if (!rows.length) return { state, stopped: 0 };
  await tx.query(`update automation_step set status = 'cancelled', finished_at = now() where workspace_id = $1 and run_id = any($2::text[]) and status in ('running', 'waiting')`, [workspaceId, rows.map((r) => r.id)]);
  let next = state;
  for (const r of rows) if (r.waiting_effect_id) next = (await cancelHeld(tx, loaded, next, actor, r.waiting_effect_id as string)).state;
  return { state: next, stopped: rows.length };
}
