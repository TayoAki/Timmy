/**
 * Detecting projects from the Projects screen (projects/detect.ts, scan.ts, apply.ts).
 *
 *   POST /api/v1/projects/detect               start a scan (one at a time per workspace)
 *   GET  /api/v1/projects/detect               the latest scan: running, ready with what it found, failed or applied
 *   POST /api/v1/projects/detect/:id/apply     keep, rename, merge or drop each project found
 *   GET  /api/v1/projects/:id/links            the files and meetings linked to a project
 */
import type { Hono } from 'hono';
import { withWorkspace } from '../db/pool';
import { ApplyError, applyScan, type Choice } from '../projects/apply';
import { latestScan, startScan } from '../projects/scan';
import { ctxOf, requireRead, requireWorkspace, type Env } from './session';

export function projectRoutes(app: Hono<Env>): void {
  app.post('/api/v1/projects/detect', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.work) return c.json({ error: 'Your role can’t make changes in this workspace.' }, 403);
    return c.json(await startScan(ctx.workspaceId, ctx.user.id));
  });

  app.get('/api/v1/projects/detect', requireWorkspace, requireRead, async (c) => c.json({ scan: await latestScan(ctxOf(c).workspaceId) }));

  app.post('/api/v1/projects/detect/:id/apply', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.work) return c.json({ error: 'Your role can’t make changes in this workspace.' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { choices?: Choice[] };
    try {
      return c.json(await applyScan(ctx.workspaceId, ctx.user.id, c.req.param('id'), body.choices ?? []));
    } catch (e) {
      if (e instanceof ApplyError) return c.json({ error: e.message }, e.status as 400);
      throw e;
    }
  });

  app.get('/api/v1/projects/:id/links', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const rows = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) =>
      (
        await tx.query(
          `select i.id, i.kind, i.subject, i.occurred_at, i.meta->>'link' as link, i.snippet
           from project_link l join item i on i.id = l.item_id join connection c on c.id = i.connection_id
           where l.workspace_id = $1 and l.project_id = $2 and c.status = 'active'
           order by i.occurred_at desc limit 200`,
          [ctx.workspaceId, c.req.param('id')],
        )
      ).rows,
    );
    const safe = (l: unknown) => (typeof l === 'string' && /^https:\/\/((docs|drive|sheets|slides|forms)\.google\.com|[\w-]+\.sharepoint\.com|onedrive\.live\.com|1drv\.ms)\//.test(l) ? l : undefined);
    return c.json({
      files: rows.filter((r) => r.kind === 'file').map((r) => ({ id: r.id, name: r.subject, kind: r.snippet ?? 'File', changed: new Date(r.occurred_at).toISOString(), link: safe(r.link) })),
      meetings: rows.filter((r) => r.kind === 'event').map((r) => ({ id: r.id, title: r.subject || 'Meeting', at: new Date(r.occurred_at).toISOString() })),
    });
  });
}
