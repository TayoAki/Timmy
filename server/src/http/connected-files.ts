/**
 * The files Timmy keeps a list of from a connected Google Drive or OneDrive, for the Files screen.
 *
 *   GET /api/v1/connected-files?q=words   newest first, at most 200; `q` narrows to names containing the words
 *   GET /api/v1/connected-files/:id/view  one of them, shown inside Timmy (files/view.ts)
 *   GET /api/v1/connected-files/:id/office  its bytes as an Office or PDF file, for Timmy's editors (files/drive-edit.ts)
 *   POST /api/v1/connected-files/:id/save  { asset, version }: the edited file, uploaded first, saved over the Drive original
 *
 * Only files from accounts still connected are listed. Names, owners and links were written by whoever made or
 * shared the file: the screen shows them as text, and a link is only ever one of Google's or Microsoft's own.
 */
import type { Hono } from 'hono';
import { withWorkspace } from '../db/pool';
import { openForEditing, saveToDrive } from '../files/drive-edit';
import { viewFile } from '../files/view';
import { ctxOf, requireRead, requireWorkspace, type Env } from './session';

const APP_NAMES: Record<string, string> = { googledrive: 'Google Drive', one_drive: 'OneDrive' };
const SAFE_LINK = /^https:\/\/((docs|drive|sheets|slides|forms)\.google\.com|[\w-]+\.sharepoint\.com|onedrive\.live\.com|1drv\.ms)\//;
const LIMIT = 200;

export function connectedFileRoutes(app: Hono<Env>): void {
  // One file, shown inside Timmy (files/view.ts): read through its connection when opened, not stored.
  app.get('/api/v1/connected-files/:id/view', requireWorkspace, requireRead, async (c) => {
    const viewed = await viewFile(ctxOf(c).workspaceId, c.req.param('id'));
    if (!viewed) return c.json({ error: 'That file isn’t on this workspace’s list.' }, 404);
    c.header('Cache-Control', 'private, no-store');
    return c.json(viewed);
  });

  // The file as an editor opens it. What it is and whether it can be saved back come in headers, beside the bytes.
  app.get('/api/v1/connected-files/:id/office', requireWorkspace, requireRead, async (c) => {
    const opened = await openForEditing(ctxOf(c).workspaceId, c.req.param('id'));
    if (!opened.ok) return c.json({ error: opened.error }, opened.status);
    c.header('Cache-Control', 'private, no-store');
    c.header('Content-Type', opened.type);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Disposition', 'attachment');
    c.header('X-Timmy-Name', encodeURIComponent(opened.name));
    c.header('X-Timmy-Format', opened.format);
    c.header('X-Timmy-App', opened.app);
    c.header('X-Timmy-Version', opened.version ?? '');
    c.header('X-Timmy-Saves', opened.saves ? '1' : '0');
    if (opened.reason) c.header('X-Timmy-Reason', encodeURIComponent(opened.reason));
    return c.body(opened.bytes as Uint8Array<ArrayBuffer>);
  });

  // Saving an edit over the Drive original: the person's press of Save, through the Action gateway (file.update).
  app.post('/api/v1/connected-files/:id/save', requireWorkspace, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { asset?: unknown; version?: unknown };
    if (typeof body.asset !== 'string' || !/^[\w-]{1,80}$/.test(body.asset) || typeof body.version !== 'string' || body.version.length > 100) return c.json({ error: 'That isn’t a save.' }, 400);
    const saved = await saveToDrive(ctxOf(c), c.req.param('id'), body.asset, body.version);
    if (!saved.ok) return c.json({ error: saved.error, ...(saved.version ? { version: saved.version } : {}) }, saved.status as 400);
    return c.json({ ok: true, version: saved.version });
  });

  app.get('/api/v1/connected-files', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const words = String(c.req.query('q') ?? '')
      .slice(0, 200)
      .split(/\s+/)
      .map((w) => w.replace(/[%_\\]/g, ''))
      .filter(Boolean)
      .slice(0, 8);
    const { files, total, apps } = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => {
      const apps = (await tx.query(`select toolkit from connection where workspace_id = $1 and status = 'active' and toolkit = any($2::text[])`, [ctx.workspaceId, Object.keys(APP_NAMES)])).rows.map((r) => r.toolkit as string);
      const filter = words.length ? `and ${words.map((_, i) => `i.subject ilike $${i + 2}`).join(' and ')}` : '';
      const params = [ctx.workspaceId, ...words.map((w) => `%${w}%`)];
      const { rows } = await tx.query(
        `select i.id, i.subject, i.snippet, i.sender, i.occurred_at, i.meta->>'link' as link, i.meta->>'ownerName' as owner_name, c.toolkit,
                exists (select 1 from item_body b where b.item_id = i.id) as readable, count(*) over () as total,
                (select l.project_id from project_link l where l.workspace_id = i.workspace_id and l.item_id = i.id order by l.project_id limit 1) as project
         from item i join connection c on c.id = i.connection_id
         where i.workspace_id = $1 and i.kind = 'file' and c.status = 'active' ${filter}
         order by i.occurred_at desc limit ${LIMIT}`,
        params,
      );
      return { files: rows, total: rows.length ? Number(rows[0]!.total) : 0, apps };
    });
    return c.json({
      apps: apps.map((a) => APP_NAMES[a]),
      total,
      files: files.map((r) => ({
        id: r.id as string,
        name: r.subject as string,
        kind: (r.snippet as string | null) ?? 'File',
        app: APP_NAMES[r.toolkit as string] ?? 'Files',
        owner: (r.owner_name as string | null) || (r.sender as string | null) || undefined,
        changed: new Date(r.occurred_at as string).toISOString(),
        link: typeof r.link === 'string' && SAFE_LINK.test(r.link) ? r.link : undefined,
        // Its words are kept, so Ask can find it by what it says.
        readable: !!r.readable,
        // The project it belongs to (projects/file-links.ts, or a project scan), by the project's id.
        project: (r.project as string | null) ?? undefined,
      })),
    });
  });
}
