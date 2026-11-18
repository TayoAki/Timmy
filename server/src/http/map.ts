/**
 * People › Map (ontology/map.ts): the people, companies, projects, files, meetings and open promises Timmy knows of,
 * and how they connect, for the caller's own workspace.
 *
 *   GET /api/v1/map
 */
import type { Hono } from 'hono';
import { workspaceMap } from '../ontology/map';
import { readState } from '../state/mutate';
import { ctxOf, requireRead, requireWorkspace, type Env } from './session';

export function mapRoutes(app: Hono<Env>): void {
  app.get('/api/v1/map', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const { state } = await readState(ctx.workspaceId);
    c.header('Cache-Control', 'private, no-store');
    return c.json(await workspaceMap(ctx.workspaceId, state));
  });
}
