/**
 * The files Timmy keeps a list of from a connected Google Drive or OneDrive, for the Files screen.
 *
 *   GET /api/v1/connected-files?q=words   newest first, at most 200; `q` narrows to names containing the words
 *
 * Only files from accounts still connected are listed. Names, owners and links were written by whoever made or
 * shared the file: the screen shows them as text, and a link is only ever one of Google's or Microsoft's own.
 */
import type { Hono } from 'hono';
import { withWorkspace } from '../db/pool';
import { ctxOf, requireRead, requireWorkspace, type Env } from './session';

const APP_NAMES: Record<string, string> = { googledrive: 'Google Drive', one_drive: 'OneDrive' };
const SAFE_LINK = /^https:\/\/((docs|drive|sheets|slides|forms)\.google\.com|[\w-]+\.sharepoint\.com|onedrive\.live\.com|1drv\.ms)\//;
const LIMIT = 200;

export function connectedFileRoutes(app: Hono<Env>): void {
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
                exists (select 1 from item_body b where b.item_id = i.id) as readable, count(*) over () as total
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
      })),
    });
  });
}
