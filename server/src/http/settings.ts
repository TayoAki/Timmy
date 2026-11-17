/**
 * The workspace's settings: the model, approvals, the monthly limit, how many jobs run at once, the kill switch
 * and the time zone. Anyone who may read the workspace can see them; only an owner or admin can change them.
 */
import type { Hono } from 'hono';
import { isTimeZone } from '../agent/morning';
import { MODEL_ALLOWLIST, config, modelFor } from '../config';
import { withWorkspace } from '../db/pool';
import { audit } from '../gateway/gateway';
import { ctxOf, requireRead, requireWorkspace, type Env } from './session';

export function settingsRoutes(app: Hono<Env>): void {
  app.get('/api/v1/settings', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const ws = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query('select model_id, approval_mode, max_concurrent_runs, monthly_spend_cap_usd, kill_switch, timezone from workspace where id = $1', [ctx.workspaceId])).rows[0]);
    return c.json({
      model: modelFor(ws.model_id),
      models: MODEL_ALLOWLIST,
      approvalMode: ws.approval_mode,
      maxConcurrentRuns: ws.max_concurrent_runs,
      monthlySpendCapUsd: Number(ws.monthly_spend_cap_usd),
      limits: { monthlySpendCapUsd: config.spendCapCeilingUsd, maxConcurrentRuns: config.concurrentRunsCeiling },
      killSwitch: ws.kill_switch,
      timezone: ws.timezone,
    });
  });

  app.patch('/api/v1/settings', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.policy) return c.json({ error: 'Only an owner or admin can change this.' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { model?: string; approvalMode?: string; killSwitch?: boolean; timezone?: string; monthlySpendCapUsd?: number; maxConcurrentRuns?: number };
    if (body.model !== undefined && !MODEL_ALLOWLIST.some((m) => m.id === body.model)) return c.json({ error: 'That model isn’t on the list.' }, 400);
    if (body.approvalMode !== undefined && body.approvalMode !== 'ask' && body.approvalMode !== 'auto') return c.json({ error: 'Approval mode is ask or auto.' }, 400);
    const cap = body.monthlySpendCapUsd;
    if (cap !== undefined && !(typeof cap === 'number' && cap >= 0 && cap <= config.spendCapCeilingUsd)) return c.json({ error: `The monthly limit can be anything from $0 to $${config.spendCapCeilingUsd}.` }, 400);
    if (body.timezone !== undefined && !(typeof body.timezone === 'string' && body.timezone.length <= 64 && isTimeZone(body.timezone))) return c.json({ error: 'That isn’t a time zone Timmy knows.' }, 400);
    const runs = body.maxConcurrentRuns;
    if (runs !== undefined && !(Number.isInteger(runs) && runs >= 1 && runs <= config.concurrentRunsCeiling)) return c.json({ error: `Timmy can work on 1 to ${config.concurrentRunsCeiling} things at once.` }, 400);
    // Only the settings named here are stored and logged; anything else in the request is ignored.
    const change = { model: body.model, approvalMode: body.approvalMode, killSwitch: typeof body.killSwitch === 'boolean' ? body.killSwitch : undefined, timezone: body.timezone, monthlySpendCapUsd: cap, maxConcurrentRuns: runs };
    await withWorkspace({ workspaceId: ctx.workspaceId, userId: ctx.user.id }, async (tx) => {
      await tx.query(
        `update workspace set model_id = coalesce($2, model_id), approval_mode = coalesce($3, approval_mode), kill_switch = coalesce($4, kill_switch), timezone = coalesce($5, timezone),
           monthly_spend_cap_usd = coalesce($6, monthly_spend_cap_usd), max_concurrent_runs = coalesce($7, max_concurrent_runs) where id = $1`,
        [ctx.workspaceId, change.model ?? null, change.approvalMode ?? null, change.killSwitch ?? null, change.timezone ?? null, change.monthlySpendCapUsd ?? null, change.maxConcurrentRuns ?? null],
      );
      await audit(tx, ctx.workspaceId, { actor: ctx.user.id, action: 'settings.changed', detail: change });
    });
    return c.json({ ok: true });
  });
}
