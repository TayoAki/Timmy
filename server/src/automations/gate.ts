/**
 * The gate every change to an automation's On switch, or to an automation that is on, passes through.
 *
 * The screens change automations with plain workspace operations, and Undo puts earlier records back. So
 * the gate does not look at what the command was called: it compares the automations before the command
 * with the automations after it, and decides on the difference.
 *
 *   - Switching one on, or changing the steps of one that is on, needs an owner or admin, a finished
 *     graph, and blocks that can really run on this workspace. It freezes a version: runs point at a
 *     version, so a later edit never changes a run in progress.
 *   - Switching one off, or deleting it, is open to anyone who may work here. It stops new runs and the
 *     runs still in progress, and takes back what those runs had waiting in Approvals.
 *   - Drawing and saving one that is off is not the engine's business.
 */
import type { State } from '../../../src/state/store';
import type { Automation } from '../../../src/data/ws-types';
import type { Tx } from '../db/pool';
import { audit, cancelHeld } from '../gateway/gateway';
import type { Actor } from '../gateway/policy';
import { newId } from '../lib/ids';
import { modelReady } from '../providers/model';
import type { Loaded } from '../state/docs';
import type { Ctx } from '../state/engine';
import { automationProblems } from '../state/ws-check';
import { MAIL_TOOLKITS } from '../sync/mailbox';
import { frozen, runProblems, type RunEnv } from './canrun';
import { graphHash, graphOf, triggerOf } from './graph';
import type { LiveRow } from './rows';
import { nextFire } from './when';

export interface Gated {
  state: State;
  /** Why the whole command is refused, in words for the person. */
  reject?: string;
  toast?: { text: string; tone?: 'warn' };
}

export async function runEnv(tx: Tx, loaded: Loaded, state: State): Promise<RunEnv> {
  const mailbox = (await tx.query(`select 1 from connection where workspace_id = $1 and status = 'active' and purpose = 'primary' and toolkit = any($2::text[]) limit 1`, [loaded.workspace.id, MAIL_TOOLKITS])).rows.length > 0;
  return { mailbox, model: modelReady(), ws: state.ws, timeZone: loaded.workspace.timezone };
}

/** The engine's record of an automation, locked for the rest of the transaction. */
async function liveRow(tx: Tx, workspaceId: string, automationId: string): Promise<(LiveRow & { graph_hash: string }) | undefined> {
  const { rows } = await tx.query(
    `select l.*, v.graph_hash from automation_live l join automation_version v on v.id = l.version_id where l.workspace_id = $1 and l.automation_id = $2 for update of l`,
    [workspaceId, automationId],
  );
  return rows[0] as (LiveRow & { graph_hash: string }) | undefined;
}

/**
 * Stops the runs of an automation that are still going, and takes back what they had waiting for a
 * decision (an “Ask me first”, or an email put forward for approval). A send that has already left stays sent.
 */
async function stopRuns(tx: Tx, loaded: Loaded, state: State, actor: Actor, automationId: string, why: string): Promise<{ state: State; stopped: number }> {
  const { rows } = await tx.query(
    `update automation_run set status = 'cancelled', error = $3, finished_at = now(), lease_token = null, lease_until = null, wake_at = null, updated_at = now()
     where workspace_id = $1 and automation_id = $2 and status in ('queued', 'running', 'waiting') returning id, waiting_effect_id`,
    [loaded.workspace.id, automationId, why],
  );
  if (!rows.length) return { state, stopped: 0 };
  await tx.query(`update automation_step set status = 'cancelled', finished_at = now() where workspace_id = $1 and run_id = any($2::text[]) and status in ('running', 'waiting')`, [loaded.workspace.id, rows.map((r) => r.id)]);
  let next = state;
  for (const r of rows) if (r.waiting_effect_id) next = (await cancelHeld(tx, loaded, next, actor, r.waiting_effect_id as string)).state;
  return { state: next, stopped: rows.length };
}

export async function gateAutomations(tx: Tx, loaded: Loaded, ctx: Ctx, next: State): Promise<Gated> {
  const before = loaded.state.ws.automations;
  const after = next.ws.automations;
  if (before === after) return { state: next };

  const workspaceId = loaded.workspace.id;
  const actor: Actor = { userId: ctx.user.id, name: ctx.user.name, role: ctx.role, rules: ctx.rules };
  let state = next;
  let toast: Gated['toast'];
  let env: RunEnv | null = null;

  /** Sets or clears the note on an automation in the state being built. */
  const withNote = (s: State, id: string, note: string | undefined): State => ({ ...s, ws: { ...s.ws, automations: { ...s.ws.automations, [id]: { ...s.ws.automations[id]!, note } } } });

  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was: Automation | undefined = before[id];
    const now: Automation | undefined = after[id];
    if (was === now) continue;
    // The note is Timmy's own word on why it switched an automation off. A screen can't write or change it.
    if (now && now.note !== was?.note) state = withNote(state, id, was?.note);
    if (!was?.on && !now?.on) continue;

    if (!now?.on) {
      // Switched off, or deleted while on.
      const live = await liveRow(tx, workspaceId, id);
      if (!live?.enabled) continue;
      const why = now ? 'The automation was switched off.' : 'The automation was deleted.';
      await tx.query(`update automation_live set enabled = false, off_reason = $3, next_fire_at = null, updated_at = now() where workspace_id = $1 and automation_id = $2`, [workspaceId, id, why]);
      const stopped = await stopRuns(tx, loaded, state, actor, id, why);
      state = stopped.state;
      await audit(tx, workspaceId, { actor: ctx.user.id, action: 'automation.off', detail: { automation: id, name: was!.name, runsStopped: stopped.stopped, ...(now ? {} : { deleted: true }) } });
      if (stopped.stopped) toast = { text: `“${was!.name}” is off. ${stopped.stopped === 1 ? 'The 1 run that was in progress was stopped.' : `The ${stopped.stopped} runs that were in progress were stopped.`}` };
      continue;
    }

    const live = await liveRow(tx, workspaceId, id);
    const hash = graphHash(graphOf(now));
    const alreadyOn = !!was?.on && !!live?.enabled;
    // On before and after with the same steps: a new name, a moved card, a test-run count. Nothing for the engine.
    if (alreadyOn && live!.graph_hash === hash) continue;

    if (!ctx.rules.policy) {
      return {
        state: loaded.state,
        reject: alreadyOn
          ? `“${now.name}” is on, and only an owner or admin can change the steps of an automation while it is on. Switch it off to change it, then ask an owner or admin to switch it back on.`
          : 'Only an owner or admin can switch an automation on. You can draw, save and test it.',
      };
    }
    env ??= await runEnv(tx, loaded, next);
    const unfinished = automationProblems(now, true);
    const problems = unfinished.length ? unfinished : runProblems(now, env);
    if (problems.length) return { state: loaded.state, reject: `${alreadyOn ? `“${now.name}” is on, and it can’t run with this change.` : `“${now.name}” can’t be switched on yet.`} ${problems.join(' ')}` };

    // Freeze what will run. From here on a run reads this copy and never the drawing.
    const versionId = newId('aver');
    const trigger = triggerOf(graphOf(now))!;
    await tx.query(`insert into automation_version (id, workspace_id, automation_id, name, graph, graph_hash, created_by) values ($1, $2, $3, $4, $5::jsonb, $6, $7)`, [versionId, workspaceId, id, now.name, JSON.stringify(frozen(now, env)), hash, ctx.user.id]);
    const fire = trigger.kind === 'schedule' ? nextFire(trigger.config.every, env.timeZone, new Date()) : null;
    if (alreadyOn) {
      await tx.query(`update automation_live set version_id = $3, trigger_kind = $4, next_fire_at = $5, updated_at = now() where workspace_id = $1 and automation_id = $2`, [workspaceId, id, versionId, trigger.kind, fire]);
      toast = { text: `Saved. “${now.name}” uses these steps from its next run; runs already in progress finish on the steps they started with.` };
    } else {
      await tx.query(
        `insert into automation_live (workspace_id, automation_id, version_id, enabled, trigger_kind, enabled_by, enabled_at, next_fire_at, failures_in_a_row, off_reason)
         values ($1, $2, $3, true, $4, $5, now(), $6, 0, null)
         on conflict (workspace_id, automation_id) do update set version_id = excluded.version_id, enabled = true, trigger_kind = excluded.trigger_kind, enabled_by = excluded.enabled_by,
           enabled_at = now(), next_fire_at = excluded.next_fire_at, failures_in_a_row = 0, off_reason = null, updated_at = now()`,
        [workspaceId, id, versionId, trigger.kind, ctx.user.id, fire],
      );
    }
    await audit(tx, workspaceId, { actor: ctx.user.id, action: alreadyOn ? 'automation.changed' : 'automation.on', detail: { automation: id, name: now.name, version: versionId, trigger: trigger.kind } });
    // The note said why Timmy had switched it off. It is on again, so the note goes.
    if (state.ws.automations[id]?.note !== undefined) state = withNote(state, id, undefined);
  }
  return { state, ...(toast ? { toast } : {}) };
}
