/**
 * What a workspace can look back on: the audit log, one effect record, and this month's model and provider usage.
 * Every read is scoped to the session's workspace.
 */
import type { Hono } from 'hono';
import { withWorkspace } from '../db/pool';
import { ctxOf, requireRead, requireWorkspace, type Env } from './session';

export function auditRoutes(app: Hono<Env>): void {
  app.get('/api/v1/audit', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);
    const rows = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query('select id, at, actor, on_behalf_of, action, effect_id, run_id, detail from audit_log where workspace_id = $1 order by id desc limit $2', [ctx.workspaceId, limit])).rows);
    return c.json({ entries: rows });
  });

  app.get('/api/v1/effects/:id', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const row = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query('select id, kind, status, target, source, requested_by, approved_by, approved_via, approver_route, hold_until, error, external_id, created_at, completed_at from effect where id = $1 and workspace_id = $2', [c.req.param('id'), ctx.workspaceId])).rows[0]);
    return row ? c.json(row) : c.json({ error: 'Not found' }, 404);
  });

  app.get('/api/v1/usage', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const out = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => {
      const models = (await tx.query(`select route, model, count(*)::int as calls, sum(tokens_in)::int as tokens_in, sum(tokens_out)::int as tokens_out, sum(tokens_reasoning)::int as tokens_reasoning, sum(tokens_cached)::int as tokens_cached, sum(cost_usd)::float8 as cost_usd from usage_event where workspace_id = $1 and at >= date_trunc('month', now()) group by route, model order by route`, [ctx.workspaceId])).rows;
      const calls = (await tx.query(`select phase, count(*)::int as calls from provider_call where workspace_id = $1 and at >= date_trunc('month', now()) group by phase order by phase`, [ctx.workspaceId])).rows;
      return { models, composio: calls };
    });
    return c.json(out);
  });
}
