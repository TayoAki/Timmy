/**
 * Carries a run through its steps.
 *
 * A run is a row. A worker takes it by writing its own token on the row (the lease); every write the worker
 * then makes checks the token is still there, in the same transaction as the write. So two workers can
 * never both carry the same run forward, and a worker that stalled and was replaced writes nothing more.
 *
 * Steps follow the frozen version's arrows, in code. A run stops in one of three ways before its end:
 * a Wait (it is picked up again when the time comes), a step waiting for a person in Approvals (picked up
 * when they decide), or a step that failed (tried again three times, each after a longer pause, then the run fails).
 */
import type { State } from '../../../src/state/store';
import { KIND } from '../../../src/areas/automations/catalog';
import { config } from '../config';
import { withWorkspace, type Tx } from '../db/pool';
import type { EffectRow } from '../gateway/gateway';
import { enqueueSoon } from '../jobs/jobs';
import { newId } from '../lib/ids';
import { log } from '../lib/log';
import type { Loaded } from '../state/docs';
import { mutate } from '../state/mutate';
import { MAX_STEPS } from '../state/ws-check';
import { nextOf, nodeOf, type RunNode } from './graph';
import { safe, sentence } from './render';
import { logged, nameOf, switchOff, type RunRow, type StepRow, type VersionRow } from './rows';
import { STEPS, StepError, type StepResult } from './steps';

/** The run is no longer this worker's: it was stopped, or another worker took it over. */
class LostLease extends Error {}

const label = (kind: string) => KIND[kind]?.label ?? kind;
const FINAL: EffectRow['status'][] = ['completed', 'failed', 'declined', 'cancelled'];

interface Held {
  run: RunRow;
  version: VersionRow;
  timeZone: string;
}

/**
 * Takes a run that is ready: newly queued, back from a pause whose time has come, or left behind by a
 * worker that died. One UPDATE decides, so only one caller can win. 'missing' means there is no such run
 * (yet): the transaction that queued it may not have finished.
 */
async function claim(workspaceId: string, runId: string): Promise<Held | 'missing' | null> {
  return withWorkspace({ workspaceId }, async (tx) => {
    const { rows } = await tx.query(
      `with ready as (
         select id, status as was from automation_run
         where id = $1 and workspace_id = $2 and (
           (status = 'queued' and (wake_at is null or wake_at <= now())) or
           (status = 'waiting' and waiting_effect_id is null and wake_at is not null and wake_at <= now()) or
           (status = 'running' and lease_until < now()))
         for update)
       update automation_run r set status = 'running', lease_token = $3, lease_until = now() + make_interval(secs => $4), started_at = coalesce(r.started_at, now()), wake_at = null, updated_at = now()
       from ready where r.id = ready.id
       returning r.*, ready.was`,
      [runId, workspaceId, newId('lease'), config.automations.leaseSeconds],
    );
    const run = rows[0] as (RunRow & { was: string }) | undefined;
    if (!run) return (await tx.query('select 1 from automation_run where id = $1 and workspace_id = $2', [runId, workspaceId])).rows[0] ? null : 'missing';
    // Back from a pause whose time has come: the step that paused is told so, and remembers it through any later retry.
    if (run.was === 'waiting' && run.cursor) await tx.query(`update automation_step set output = output || '{"resumed": true}'::jsonb where run_id = $1 and node_id = $2 and status = 'waiting'`, [run.id, run.cursor]);
    const version = (await tx.query('select * from automation_version where id = $1 and workspace_id = $2', [run.version_id, workspaceId])).rows[0] as VersionRow;
    const timeZone = ((await tx.query('select timezone from workspace where id = $1', [workspaceId])).rows[0]?.timezone as string | undefined) ?? 'UTC';
    return { run, version, timeZone };
  });
}

/** Checks, inside a transaction that is about to write, that the run is still this worker's. Keeps the row locked until the transaction ends. */
async function hold(tx: Tx, run: RunRow): Promise<void> {
  const { rows } = await tx.query(`update automation_run set lease_until = now() + make_interval(secs => $3), updated_at = now() where id = $1 and status = 'running' and lease_token = $2 returning id`, [run.id, run.lease_token, config.automations.leaseSeconds]);
  if (!rows[0]) throw new LostLease();
}

/** Notes that a step is being tried. A step coming back from its own pause is the same try; anything else is one more. */
async function begin(workspaceId: string, run: RunRow, node: RunNode): Promise<StepRow> {
  return withWorkspace({ workspaceId }, async (tx) => {
    await hold(tx, run);
    const { rows } = await tx.query(
      `insert into automation_step (run_id, workspace_id, node_id, seq, kind, status, input, attempt)
       values ($1, $2, $3, (select count(*) from automation_step where run_id = $1), $4, 'running', $5::jsonb, 1)
       on conflict (run_id, node_id) do update set attempt = automation_step.attempt + (case when automation_step.status = 'waiting' then 0 else 1 end)
       returning *`,
      [run.id, workspaceId, node.id, node.kind, JSON.stringify(safe(node.config))],
    );
    return rows[0] as StepRow;
  });
}

/** Saves what a step did and where the run stands now, in the transaction that did the step's work. */
async function record(tx: Tx, run: RunRow, node: RunNode, result: StepResult, version: VersionRow): Promise<RunRow> {
  const output = safe(result.output);
  const context = JSON.stringify({ ...run.context, steps: { ...run.context.steps, [node.id]: output } }).replace(/\\u0000/g, '');
  const out = JSON.stringify(output).replace(/\\u0000/g, '');
  let rows: unknown[];
  if (result.then === 'next') {
    const cursor = nextOf(version.graph, node.id, result.branch);
    await tx.query(`update automation_step set status = 'done', output = $3::jsonb, error = null, finished_at = now() where run_id = $1 and node_id = $2`, [run.id, node.id, out]);
    if (cursor) {
      ({ rows } = await tx.query(`update automation_run set context = $2::jsonb, cursor = $3, error = null, updated_at = now() where id = $1 returning *`, [run.id, context, cursor]));
    } else {
      // No arrow leads on: the run is finished, and the automation's count of failures in a row starts again.
      ({ rows } = await tx.query(`update automation_run set context = $2::jsonb, cursor = null, status = 'done', error = null, finished_at = now(), lease_token = null, lease_until = null, updated_at = now() where id = $1 returning *`, [run.id, context]));
      await tx.query(`update automation_live set failures_in_a_row = 0 where workspace_id = $1 and automation_id = $2 and failures_in_a_row <> 0`, [run.workspace_id, run.automation_id]);
    }
  } else if (result.then === 'sleep') {
    await tx.query(`update automation_step set status = 'waiting', output = $3::jsonb, error = null where run_id = $1 and node_id = $2`, [run.id, node.id, out]);
    ({ rows } = await tx.query(`update automation_run set context = $2::jsonb, status = 'waiting', wake_at = $3, waiting_effect_id = null, lease_token = null, lease_until = null, error = null, updated_at = now() where id = $1 returning *`, [run.id, context, result.until]));
  } else {
    await tx.query(`update automation_step set status = 'waiting', output = $3::jsonb, effect_id = $4, error = null where run_id = $1 and node_id = $2`, [run.id, node.id, out, result.effect.id]);
    ({ rows } = await tx.query(`update automation_run set context = $2::jsonb, status = 'waiting', wake_at = null, waiting_effect_id = $3, lease_token = null, lease_until = null, error = null, updated_at = now() where id = $1 returning *`, [run.id, context, result.effect.id]));
  }
  return rows[0] as RunRow;
}

/**
 * Ends a run as failed, tells the workspace, and counts it against the automation. Enough failed runs in
 * a row switch the automation off, with a note saying why. Returns the state with the notice in it.
 */
async function failRun(tx: Tx, loaded: Loaded, run: RunRow, version: VersionRow, node: RunNode, message: string): Promise<State> {
  const why = sentence(message);
  await tx.query(`update automation_step set status = 'failed', error = $3, finished_at = now() where run_id = $1 and node_id = $2`, [run.id, node.id, why]);
  await tx.query(`update automation_run set status = 'failed', error = $2, finished_at = now(), lease_token = null, lease_until = null, wake_at = null, waiting_effect_id = null, updated_at = now() where id = $1`, [run.id, `“${label(node.kind)}” failed. ${why}`]);
  const name = nameOf(loaded.state, run.automation_id, version.name);
  let state = logged(loaded.state, 'automation', `A run of the automation “${name}” stopped at “${label(node.kind)}”. ${why}`);
  const live = (await tx.query(`update automation_live set failures_in_a_row = failures_in_a_row + 1, updated_at = now() where workspace_id = $1 and automation_id = $2 returning failures_in_a_row, enabled`, [run.workspace_id, run.automation_id])).rows[0] as { failures_in_a_row: number; enabled: boolean } | undefined;
  const limit = config.automations.failuresToSwitchOff;
  if (live?.enabled && live.failures_in_a_row >= limit) {
    state = await switchOff(tx, state, { id: run.workspace_id, timezone: loaded.workspace.timezone }, run.automation_id, `Its last ${limit} runs all failed. The last one stopped at “${label(node.kind)}”: ${why} Fix that step, then switch it back on.`);
  }
  return state;
}

/** A step did not work. It is tried again after a pause, up to the number of retries; after that, or when trying again can't help, the run fails. */
async function failed(workspaceId: string, held: Held, node: RunNode, step: StepRow, err: unknown): Promise<void> {
  const { run, version } = held;
  const known = err instanceof StepError;
  if (!known) log.warn('an automation step failed unexpectedly', { workspaceId, runId: run.id, node: node.id, error: (err as Error).message });
  const message = safe(known ? err.message : 'Something went wrong on Timmy’s side.').slice(0, 300);
  const pauses = config.automations.retrySeconds;
  const again = (!known || err.retry) && step.attempt <= pauses.length;
  const wake = again ? new Date(Date.now() + pauses[step.attempt - 1]! * 1000) : null;
  try {
    await mutate(workspaceId, 'automation', async (tx, loaded) => {
      await hold(tx, run);
      if (!wake) return { state: await failRun(tx, loaded, run, version, node, message), result: null };
      // Back to "being tried", so the next try is counted as one (a step coming back from its own pause is not).
      await tx.query(`update automation_step set status = 'running', error = $3 where run_id = $1 and node_id = $2`, [run.id, node.id, sentence(message)]);
      await tx.query(`update automation_run set status = 'queued', wake_at = $2, lease_token = null, lease_until = null, updated_at = now() where id = $1`, [run.id, wake]);
      return { result: null };
    });
  } catch (e) {
    if (e instanceof LostLease) return;
    throw e;
  }
  if (wake) enqueueSoon('automation.run', { workspaceId, runId: run.id }, { startAfter: wake });
}

/** Does one step. Returns the run when it should carry straight on, and null when it has stopped for now or for good. */
async function takeStep(workspaceId: string, held: Held, node: RunNode): Promise<RunRow | null> {
  const { run, version, timeZone } = held;
  let step: StepRow;
  try {
    step = await begin(workspaceId, run, node);
  } catch (e) {
    if (e instanceof LostLease) return null;
    throw e;
  }
  let done: { run: RunRow; result: StepResult };
  try {
    const exec = STEPS[node.kind];
    if (!exec) throw new StepError(`“${label(node.kind)}” can’t run on a real workspace yet.`, false);
    const work = await exec({ workspaceId, run, node, step, version, timeZone, now: new Date() });
    done = await mutate(workspaceId, 'automation', async (tx, loaded) => {
      await hold(tx, run);
      const made = await work(tx, loaded);
      return { state: made.state, result: { run: await record(tx, run, node, made.result, version), result: made.result } };
    });
  } catch (e) {
    if (!(e instanceof LostLease)) await failed(workspaceId, held, node, step, e);
    return null;
  }
  const { result } = done;
  if (result.then === 'sleep') enqueueSoon('automation.run', { workspaceId, runId: run.id }, { startAfter: result.until });
  // The decision may already have been made (the step was tried again after a crash): don't wait for the sweep to notice.
  if (result.then === 'effect' && FINAL.includes(result.effect.status)) enqueueSoon('automation.effect', { workspaceId, effectId: result.effect.id });
  return result.then === 'next' && done.run.status === 'running' ? done.run : null;
}

/** Carries a run forward as far as it can go now. Safe to call for any run at any time: a run that isn't ready is left alone. */
export async function runAutomation(workspaceId: string, runId: string): Promise<'ran' | 'missing' | 'not-ready'> {
  const held = await claim(workspaceId, runId);
  if (held === 'missing') return 'missing';
  if (!held) return 'not-ready';
  for (let i = 0; i <= MAX_STEPS; i++) {
    const node = nodeOf(held.version.graph, held.run.cursor);
    if (!node) {
      // The version has no such step. It can't happen to a version the gate froze, but a run must still end.
      await withWorkspace({ workspaceId }, (tx) => tx.query(`update automation_run set status = 'failed', error = 'The run lost its place in the steps.', finished_at = now(), lease_token = null, lease_until = null, updated_at = now() where id = $1 and status = 'running' and lease_token = $2`, [runId, held.run.lease_token]));
      return 'ran';
    }
    const next = await takeStep(workspaceId, held, node);
    if (!next) return 'ran';
    held.run = next;
  }
  return 'ran';
}

/**
 * A person has decided on what a step put forward in Approvals (or the send it approved has gone out, or
 * failed). Approved and done: the run carries on from the next step. Declined or undone: the run stops.
 * Returns false when the decision isn't final yet.
 */
export async function effectSettled(workspaceId: string, effectId: string): Promise<boolean> {
  const out = await mutate<{ final: boolean; resume?: string }>(workspaceId, 'automation', async (tx, loaded) => {
    const e = (await tx.query('select id, kind, status, error, payload from effect where id = $1 and workspace_id = $2', [effectId, workspaceId])).rows[0] as Pick<EffectRow, 'id' | 'kind' | 'status' | 'error' | 'payload'> | undefined;
    if (!e || !FINAL.includes(e.status)) return { result: { final: false } };
    const run = (await tx.query(`select * from automation_run where workspace_id = $1 and waiting_effect_id = $2 and status = 'waiting' for update`, [workspaceId, effectId])).rows[0] as RunRow | undefined;
    if (!run) return { result: { final: true } };
    const version = (await tx.query('select * from automation_version where id = $1 and workspace_id = $2', [run.version_id, workspaceId])).rows[0] as VersionRow;
    const node = nodeOf(version.graph, run.cursor);
    if (!node) return { result: { final: true } };

    if (e.status === 'completed') {
      const to = ((e.payload as { to?: string[] }).to ?? []).join(', ');
      const output = safe({ ...(run.context.steps[node.id] ?? {}), text: e.kind === 'automation.ask' ? 'Approved in Approvals' : `Approved in Approvals, and sent to ${to}` });
      const context = JSON.stringify({ ...run.context, steps: { ...run.context.steps, [node.id]: output } });
      const cursor = nextOf(version.graph, node.id);
      await tx.query(`update automation_step set status = 'done', output = $3::jsonb, finished_at = now() where run_id = $1 and node_id = $2`, [run.id, node.id, JSON.stringify(output)]);
      if (cursor) {
        await tx.query(`update automation_run set status = 'queued', context = $2::jsonb, cursor = $3, waiting_effect_id = null, updated_at = now() where id = $1`, [run.id, context, cursor]);
        return { result: { final: true, resume: run.id } };
      }
      await tx.query(`update automation_run set status = 'done', context = $2::jsonb, cursor = null, waiting_effect_id = null, finished_at = now(), updated_at = now() where id = $1`, [run.id, context]);
      await tx.query(`update automation_live set failures_in_a_row = 0 where workspace_id = $1 and automation_id = $2 and failures_in_a_row <> 0`, [workspaceId, run.automation_id]);
      return { result: { final: true } };
    }
    if (e.status === 'failed') return { state: await failRun(tx, loaded, run, version, node, e.error ?? 'It could not be carried out.'), result: { final: true } };

    // Declined, or undone before it left: a person said no, so the run stops here. It is not a failure.
    const why = e.status === 'declined' ? `${e.error ?? 'Declined'} in Approvals, so the run stopped at “${label(node.kind)}”.` : `${sentence(e.error ?? 'It was cancelled')} The run stopped at “${label(node.kind)}”.`;
    await tx.query(`update automation_step set status = 'cancelled', error = $3, finished_at = now() where run_id = $1 and node_id = $2`, [run.id, node.id, why]);
    await tx.query(`update automation_run set status = 'cancelled', error = $2, waiting_effect_id = null, finished_at = now(), updated_at = now() where id = $1`, [run.id, why]);
    return { result: { final: true } };
  });
  if (out.resume) await runAutomation(workspaceId, out.resume);
  return out.final;
}

/* ───────────── The safety net ───────────── */

/** Runs that are ready to be carried on and may have lost their job: queued, a pause that is over, or a worker that died. Ids only. */
export async function readyRuns(sys: { query: Tx['query'] }): Promise<{ id: string; workspace_id: string }[]> {
  const { rows } = await sys.query(
    `select r.id, r.workspace_id from automation_run r join workspace w on w.id = r.workspace_id where w.deleted_at is null and (
       (r.status = 'queued' and (r.wake_at is null or r.wake_at <= now())) or
       (r.status = 'waiting' and r.waiting_effect_id is null and r.wake_at is not null and r.wake_at <= now()) or
       (r.status = 'running' and r.lease_until < now()))
     order by r.updated_at limit 200`,
  );
  return rows as { id: string; workspace_id: string }[];
}

/** Runs waiting on a decision that has since been made. Ids only. */
export async function decidedWaits(sys: { query: Tx['query'] }): Promise<{ workspace_id: string; effect_id: string }[]> {
  const { rows } = await sys.query(
    `select r.workspace_id, r.waiting_effect_id as effect_id from automation_run r join effect e on e.id = r.waiting_effect_id join workspace w on w.id = r.workspace_id
     where w.deleted_at is null and r.status = 'waiting' and e.status in ('completed', 'failed', 'declined', 'cancelled') order by r.updated_at limit 200`,
  );
  return rows as { workspace_id: string; effect_id: string }[];
}
