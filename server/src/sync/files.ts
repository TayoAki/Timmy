/**
 * Google Drive, through Composio's `googledrive` toolkit.
 *
 * Timmy keeps a list of the person's files: name, what kind of file, who owns
 * it, when it last changed and a link to open it. That is enough for "find the
 * Acme proposal" to return the right file. It does not read inside files yet,
 * and it writes nothing to Drive.
 */
import { config } from '../config';
import { withWorkspace, type Tx } from '../db/pool';
import { newId } from '../lib/ids';
import { log } from '../lib/log';
import { callTool, connectionById } from './tools';

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  createdTime?: string;
  trashed?: boolean;
  webViewLink?: string;
  size?: string | number;
  shared?: boolean;
  owners?: { displayName?: string; emailAddress?: string }[];
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
}

const FIELDS = 'id,name,mimeType,modifiedTime,createdTime,trashed,webViewLink,size,shared,owners,lastModifyingUser';
const FOLDER = 'application/vnd.google-apps.folder';
const payload = (data: Record<string, unknown>) => (data.response_data ?? data) as Record<string, unknown>;

/** What a person would call the file's type. */
export function fileKind(mimeType: string): string {
  const known: Record<string, string> = {
    'application/vnd.google-apps.document': 'Google Doc',
    'application/vnd.google-apps.spreadsheet': 'Google Sheet',
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/vnd.google-apps.form': 'Google Form',
    'application/pdf': 'PDF',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
    'application/msword': 'Word document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel workbook',
    'application/vnd.ms-excel': 'Excel workbook',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint deck',
    'text/csv': 'CSV file',
    'text/plain': 'Text file',
  };
  if (Object.hasOwn(known, mimeType)) return known[mimeType]!;
  if (mimeType.startsWith('image/')) return 'Image';
  if (mimeType.startsWith('video/')) return 'Video';
  if (mimeType.startsWith('audio/')) return 'Audio';
  return 'File';
}

/** The address of the connected Drive account. */
export async function driveAddress(workspaceId: string, connectionId: string): Promise<string | null> {
  const res = await callTool(workspaceId, connectionId, 'GOOGLEDRIVE_GET_ABOUT', { fields: 'user' }, 'connect').catch(() => null);
  const user = res?.successful ? ((payload(res.data).user ?? {}) as { emailAddress?: string }) : {};
  return user.emailAddress?.toLowerCase() ?? null;
}

export interface FilesSync {
  pages: number;
  files: number;
  done: boolean;
}

/**
 * Brings the list of files up to date. The first time it covers files changed in the last
 * `driveBackfillDays`; after that, files changed since the last finished pass. It stops after `maxPages`
 * and remembers where it was, so a job can run it again until `done`.
 */
export async function syncFiles(workspaceId: string, connectionId: string, opts: { maxPages?: number; pageSize?: number } = {}): Promise<FilesSync> {
  const conn = await connectionById(workspaceId, connectionId);
  const out: FilesSync = { pages: 0, files: 0, done: true };
  if (!conn || conn.status !== 'active' || conn.toolkit !== 'googledrive') return out;
  const started = new Date();
  const cur = await withWorkspace({ workspaceId }, async (tx) => {
    await tx.query(`insert into sync_cursor (connection_id, workspace_id, kind, state, started_at) values ($1, $2, 'files', 'running', now()) on conflict (connection_id, kind) do nothing`, [connectionId, workspaceId]);
    return (await tx.query(`select cursor from sync_cursor where connection_id = $1 and kind = 'files'`, [connectionId])).rows[0] as { cursor: { since?: string; pageToken?: string; passStarted?: string } };
  });
  const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const since = cur.cursor.since ?? stamp(new Date(Date.now() - config.driveBackfillDays * 86400_000));
  // A pass that was cut short carries on from its page; its own start time is what the next pass begins from.
  const passStarted = cur.cursor.pageToken && cur.cursor.passStarted ? cur.cursor.passStarted : stamp(started);
  let pageToken = cur.cursor.pageToken;
  out.done = false;

  while (out.pages < (opts.maxPages ?? 20)) {
    const res = await callTool(
      workspaceId,
      connectionId,
      'GOOGLEDRIVE_LIST_FILES',
      { q: `modifiedTime > '${since}' and trashed = false and mimeType != '${FOLDER}'`, fields: FIELDS, orderBy: 'modifiedTime desc', pageSize: opts.pageSize ?? 200, ...(pageToken ? { pageToken } : {}) },
      'sync',
    );
    if (!res.successful) {
      log.warn('drive page failed', { workspaceId, connectionId, error: res.error });
      throw new Error(res.error ?? 'the Drive file list could not be read');
    }
    const data = payload(res.data);
    const files = ((data.files ?? []) as DriveFile[]).filter((f) => f.id && f.name && !f.trashed && f.mimeType !== FOLDER);
    const next = (data.nextPageToken as string | null | undefined) || undefined;
    out.pages++;
    out.files += files.length;
    await withWorkspace({ workspaceId }, async (tx) => {
      // Asked again inside the write: a Drive disconnected while this page was being fetched stores nothing more.
      const live = await tx.query(`select 1 from connection where id = $1 and workspace_id = $2 and status = 'active' for share`, [connectionId, workspaceId]);
      if (!live.rows[0]) return;
      for (const f of files) await upsertFile(tx, workspaceId, connectionId, f);
      // When the last page is in, the next pass starts a little before this one began, so nothing changed meanwhile is missed.
      const cursor = next ? { since, pageToken: next, passStarted } : { since: stamp(new Date(new Date(passStarted).getTime() - 5 * 60_000)) };
      await tx.query(`update sync_cursor set cursor = $2::jsonb, items_done = items_done + $3, state = $4, finished_at = case when $4 = 'done' then now() else finished_at end, updated_at = now() where connection_id = $1 and kind = 'files'`, [
        connectionId,
        JSON.stringify(cursor),
        files.length,
        next ? 'running' : 'done',
      ]);
    });
    pageToken = next;
    if (!pageToken) {
      out.done = true;
      break;
    }
  }
  return out;
}

async function upsertFile(tx: Tx, workspaceId: string, connectionId: string, f: DriveFile): Promise<void> {
  const owner = f.owners?.[0];
  const mimeType = String(f.mimeType ?? '');
  const changed = new Date(f.modifiedTime ?? f.createdTime ?? '');
  // A link is kept only if it is Google's own; anything else in that field is dropped rather than shown as something to click.
  const link = typeof f.webViewLink === 'string' && /^https:\/\/(docs|drive|sheets|slides|forms)\.google\.com\//.test(f.webViewLink) ? f.webViewLink : null;
  await tx.query(
    `insert into item (id, workspace_id, connection_id, kind, external_id, occurred_at, sender, recipients, subject, snippet, meta)
     values ($1, $2, $3, 'file', $4, $5, $6, '{}'::jsonb, $7, $8, $9::jsonb)
     on conflict (workspace_id, connection_id, kind, external_id)
     do update set occurred_at = excluded.occurred_at, sender = excluded.sender, subject = excluded.subject, snippet = excluded.snippet, meta = excluded.meta, updated_at = now()`,
    [
      newId('itm'),
      workspaceId,
      connectionId,
      f.id,
      Number.isNaN(changed.getTime()) ? new Date() : changed,
      (owner?.emailAddress ?? '').toLowerCase(),
      String(f.name).replace(/\u0000/g, '').slice(0, 500),
      fileKind(mimeType),
      JSON.stringify({ mimeType, link, ownerName: owner?.displayName, changedBy: f.lastModifyingUser?.displayName, shared: !!f.shared, size: f.size != null ? Number(f.size) : undefined }).replace(/\\u0000/g, ''),
    ],
  );
}

/** A file was deleted or moved to the trash in Drive: it leaves Timmy's list too. */
export async function removeFile(workspaceId: string, connectionId: string, fileId: string): Promise<number> {
  return withWorkspace({ workspaceId }, async (tx) => (await tx.query(`delete from item where workspace_id = $1 and connection_id = $2 and kind = 'file' and external_id = $3`, [workspaceId, connectionId, fileId])).rowCount ?? 0);
}
