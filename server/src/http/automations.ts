/**
 * The automation engine's two endpoints: a test run that does nothing, and the list of recent runs behind
 * the editor's Runs panel. Which workspace they act in comes from the session, never from the request,
 * and every read is scoped to it: an automation, run or email id from another workspace finds nothing.
 */
import type { Hono } from 'hono';
import { KIND } from '../../../src/areas/automations/catalog';
import { dryRun } from '../automations/dryrun';
import type { RunRow, StepRow } from '../automations/rows';
import { withWorkspace } from '../db/pool';
import { readState } from '../state/mutate';
import { ctxOf, requireRead, requireWorkspace, type Env } from './session';

const ID = /^[\w.:@-]{1,200}$/;

/** What started a run, in a line. */
function startedBy(run: Pick<RunRow, 'context'>): string {
  const f = run.context.fields ?? {};
  return run.context.trigger?.kind === 'schedule' ? `Its schedule, ${f.date ?? ''}`.trim() : `An email from ${f.name || f.email || 'someone'}: “${f.subject ?? ''}”`;
}

export function automationRoutes(app: Hono<Env>): void {
  // A dry run: the steps are walked and what they would put forward is shown, and nothing is carried out.
  app.post('/api/v1/automations/:id/test', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.work) return c.json({ error: 'Your role can’t test automations in this workspace.' }, 403);
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: 'Not found' }, 404);
    const body = ((await c.req.json().catch(() => null)) ?? {}) as { sample?: unknown; eventId?: unknown };
    const out = await dryRun(ctx.workspaceId, id, body);
    return c.json(out.body, out.status);
  });

  // Recent runs, newest first, each with what its steps did and any error.
  app.get('/api/v1/automations/:id/runs', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: 'Not found' }, 404);
    const limit = Math.max(1, Math.min(Number(c.req.query('limit') ?? 30) || 30, 100));
    const automation = (await readState(ctx.workspaceId)).state.ws.automations[id];
    const found = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => {
      const live = (await tx.query(`select enabled, off_reason, version_id, enabled_at, next_fire_at from automation_live where workspace_id = $1 and automation_id = $2`, [ctx.workspaceId, id])).rows[0] as { enabled: boolean; off_reason: string | null; version_id: string; enabled_at: Date; next_fire_at: Date | null } | undefined;
      const runs = (await tx.query(`select * from automation_run where workspace_id = $1 and automation_id = $2 order by created_at desc, id desc limit $3`, [ctx.workspaceId, id, limit])).rows as RunRow[];
      const steps = runs.length ? ((await tx.query(`select * from automation_step where workspace_id = $1 and run_id = any($2::text[]) order by seq`, [ctx.workspaceId, runs.map((r) => r.id)])).rows as StepRow[]) : [];
      return { live, runs, steps };
    });
    // An automation this workspace has never had: the same answer whether or not another workspace has one by that id.
    if (!automation && !found.live && !found.runs.length) return c.json({ error: 'Not found' }, 404);
    return c.json({
      automation: { id, on: !!automation?.on, note: automation?.note ?? null, runsOn: found.live?.enabled ? found.live.version_id : null, nextRunAt: found.live?.enabled ? found.live.next_fire_at : null },
      runs: found.runs.map((r) => ({
        id: r.id,
        status: r.status,
        version: r.version_id,
        startedBy: startedBy(r),
        createdAt: r.created_at,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        // A run that is paused says until when; one waiting on a person says so through its step.
        wakeAt: r.wake_at,
        error: r.error,
        steps: found.steps
          .filter((s) => s.run_id === r.id)
          .map((s) => ({ id: s.node_id, kind: s.kind, label: KIND[s.kind]?.label ?? s.kind, status: s.status, text: typeof s.output.text === 'string' ? s.output.text : '', error: s.error, attempt: s.attempt, startedAt: s.started_at, finishedAt: s.finished_at, effectId: s.effect_id })),
      })),
    });
  });
}
