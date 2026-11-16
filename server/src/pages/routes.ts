/**
 * The API for a page's version history, and for what the trash dialog tells people.
 *
 * Reading versions needs a role that can read the workspace; putting one back needs a role that can change
 * pages. The workspace always comes from the session, never from the address: a page id from another
 * workspace finds nothing here.
 */
import type { Hono } from 'hono';
import { config } from '../config';
import { sysPool, withWorkspace } from '../db/pool';
import { ctxOf, requireRead, requireWorkspace, type Env } from '../http/session';
import { readState } from '../state/mutate';
import { restoreVersion } from './restore';
import { listVersions, readVersion } from './versions';

const PAGE_ID = /^[\w.:@+-]{1,200}$/;
const NUMBER = /^[1-9]\d{0,8}$/;
const GONE = 'That page is no longer here.';

export function pageRoutes(app: Hono<Env>): void {
  // How long the trash keeps a page, so the app can say so.
  app.get('/api/v1/pages/trash', requireWorkspace, requireRead, (c) => c.json({ keptDays: config.trashRetentionDays }));

  // Newest first, without the blocks: enough to pick one from a list.
  app.get('/api/v1/pages/:id/versions', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const id = c.req.param('id');
    if (!PAGE_ID.test(id)) return c.json({ error: GONE }, 404);
    const { state } = await readState(ctx.workspaceId);
    // A page in the trash still shows its history; it just can't be changed until it is out of the trash.
    const trashed = !!state.ws.trash[id];
    const file = state.ws.files[id] ?? state.ws.trash[id];
    if (!file || file.kind !== 'doc') return c.json({ error: GONE }, 404);
    const versions = await withWorkspace({ workspaceId: ctx.workspaceId }, (tx) => listVersions(tx, ctx.workspaceId, id));
    return c.json({ versions, canRestore: ctx.rules.work && !trashed, keeps: { versions: config.pageVersionsKept, days: config.pageVersionDays, minutes: config.pageVersionMinutes } });
  });

  // One version with its blocks, for a preview.
  app.get('/api/v1/pages/:id/versions/:n', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const id = c.req.param('id');
    const n = c.req.param('n');
    if (!PAGE_ID.test(id) || !NUMBER.test(n)) return c.json({ error: 'That version is no longer kept.' }, 404);
    const version = await withWorkspace({ workspaceId: ctx.workspaceId }, (tx) => readVersion(tx, ctx.workspaceId, id, Number(n)));
    return version ? c.json(version) : c.json({ error: 'That version is no longer kept.' }, 404);
  });

  app.post('/api/v1/pages/:id/versions/:n/restore', requireWorkspace, async (c) => {
    const id = c.req.param('id');
    const n = c.req.param('n');
    if (!PAGE_ID.test(id) || !NUMBER.test(n)) return c.json({ error: 'That version is no longer kept.' }, 404);
    const out = await restoreVersion(ctxOf(c), id, Number(n));
    return out.ok ? c.json(out) : c.json({ error: out.reason }, out.status);
  });
}

/**
 * Only for tests (mounted with the other test hooks): makes a page's versions look older, so a browser test can
 * cross the few minutes between two versions without waiting them out.
 */
export function pageTestRoutes(app: Hono<Env>): void {
  app.post('/api/test/pages/age-versions', requireWorkspace, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { page?: unknown; minutes?: unknown };
    const minutes = Number(body.minutes);
    if (typeof body.page !== 'string' || !PAGE_ID.test(body.page) || !Number.isFinite(minutes)) return c.json({ error: 'page and minutes are needed' }, 400);
    // The app role may not change a kept version, so this runs as the system role, pinned to the caller's own workspace.
    const aged = await sysPool.query(`update doc_revision set created_at = created_at - ($3::float8 * interval '1 minute') where workspace_id = $1 and file_id = $2`, [ctxOf(c).workspaceId, body.page, minutes]);
    return c.json({ aged: aged.rowCount ?? 0 });
  });
}
