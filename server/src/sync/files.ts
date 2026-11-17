/**
 * Google Drive, through Composio's `googledrive` toolkit.
 *
 * Timmy keeps a list of the person's files: name, what kind of file, who owns
 * it, when it last changed and a link to open it. That is enough for "find the
 * Acme proposal" to return the right file. The words of Google Docs, Sheets and
 * Slides changed inside the sync window are read too and kept with the file, so
 * Ask can find a file by what it says (see file-text.ts). When Ask needs what a
 * file says, it is read again at that moment, through the same connection.
 * Timmy writes nothing to Drive.
 */
import { config } from '../config';
import { withWorkspace, type Tx } from '../db/pool';
import { newId } from '../lib/ids';
import { log } from '../lib/log';
import { MAX_FILE_TEXT, fileKind, type FileText, type FilesSync, type ListedFile, type Read } from './file-kinds';
import { canReadOneDrive, readOneDriveText } from './onedrive';
import { callTool, connectionById, type Phase } from './tools';

// Kept here as well, where the Drive code and its tests have always found them.
export { MAX_FILE_TEXT, fileKind, type FileText, type FilesSync };

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

/**
 * What is asked for about each file, and the token for the next page. Drive only returns what is named here:
 * leave the token out and a long list silently ends after its first page.
 */
const FIELDS = 'nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,trashed,webViewLink,size,shared,owners,lastModifyingUser)';
const FOLDER = 'application/vnd.google-apps.folder';
const payload = (data: Record<string, unknown>) => (data.response_data ?? data) as Record<string, unknown>;

/** The address of the connected Drive account. */
export async function driveAddress(workspaceId: string, connectionId: string): Promise<string | null> {
  const res = await callTool(workspaceId, connectionId, 'GOOGLEDRIVE_GET_ABOUT', { fields: 'user' }, 'connect').catch(() => null);
  const user = res?.successful ? ((payload(res.data).user ?? {}) as { emailAddress?: string }) : {};
  return user.emailAddress?.toLowerCase() ?? null;
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
    return (await tx.query(`select cursor from sync_cursor where connection_id = $1 and kind = 'files'`, [connectionId])).rows[0] as { cursor: { since?: string; pageToken?: string; passStarted?: string; shared?: boolean } };
  });
  const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const since = cur.cursor.since ?? stamp(new Date(Date.now() - config.driveBackfillDays * 86400_000));
  // A pass that was cut short carries on from its page; its own start time is what the next pass begins from.
  const passStarted = cur.cursor.pageToken && cur.cursor.passStarted ? cur.cursor.passStarted : stamp(started);
  let pageToken = cur.cursor.pageToken;
  out.done = false;
  const shared = cur.cursor.shared === true;

  while (out.pages < (opts.maxPages ?? 20)) {
    const res = await callTool(
      workspaceId,
      connectionId,
      'GOOGLEDRIVE_FIND_FILE',
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
      const cursor = next ? { since, pageToken: next, passStarted, shared } : { since: stamp(new Date(new Date(passStarted).getTime() - 5 * 60_000)), shared };
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
  if (out.done && !shared) {
    // A failure here leaves the mark off, so the next pass asks again; the list itself is already up to date.
    const got = await sharedFiles(workspaceId, connectionId).catch((e: Error) => {
      log.warn('drive shared files failed', { workspaceId, connectionId, error: e.message });
      return null;
    });
    if (got) {
      out.pages += got.pages;
      out.files += got.added;
    }
  }
  return out;
}

/**
 * Files shared with the person long ago and not changed since fall outside the window, so when the list is first
 * built it also takes the files most recently shared with the person, up to `driveSharedMax` (one page of 200 by
 * default). A Drive whose list was built before this existed gets them on its next pass. Returns how many were new.
 */
async function sharedFiles(workspaceId: string, connectionId: string): Promise<{ pages: number; added: number }> {
  const out = { pages: 0, added: 0 };
  let pageToken: string | undefined;
  let left = Math.max(0, config.driveSharedMax);
  while (left > 0) {
    const res = await callTool(
      workspaceId,
      connectionId,
      'GOOGLEDRIVE_FIND_FILE',
      { q: `sharedWithMe = true and trashed = false and mimeType != '${FOLDER}'`, fields: FIELDS, orderBy: 'sharedWithMeTime desc', pageSize: Math.min(200, left), ...(pageToken ? { pageToken } : {}) },
      'sync',
    );
    if (!res.successful) throw new Error(res.error ?? 'the files shared with you could not be listed');
    const data = payload(res.data);
    const files = ((data.files ?? []) as DriveFile[]).filter((f) => f.id && f.name && !f.trashed && f.mimeType !== FOLDER).slice(0, left);
    out.pages++;
    left -= Math.max(files.length, 1);
    pageToken = (data.nextPageToken as string | null | undefined) || undefined;
    const last = !pageToken || left <= 0;
    const kept = await withWorkspace({ workspaceId }, async (tx) => {
      const live = await tx.query(`select 1 from connection where id = $1 and workspace_id = $2 and status = 'active' for share`, [connectionId, workspaceId]);
      if (!live.rows[0]) return null;
      let added = 0;
      for (const f of files) if (await upsertFile(tx, workspaceId, connectionId, f)) added++;
      if (last) await tx.query(`update sync_cursor set cursor = cursor || '{"shared": true}'::jsonb, updated_at = now() where connection_id = $1 and kind = 'files'`, [connectionId]);
      return added;
    });
    if (kept === null) break;
    out.added += kept;
    if (last) break;
  }
  return out;
}

/** Puts a file on the list, or brings its entry up to date. Returns true when it was not on the list before. */
async function upsertFile(tx: Tx, workspaceId: string, connectionId: string, f: DriveFile): Promise<boolean> {
  const owner = f.owners?.[0];
  const mimeType = String(f.mimeType ?? '');
  const changed = new Date(f.modifiedTime ?? f.createdTime ?? '');
  // A link is kept only if it is Google's own; anything else in that field is dropped rather than shown as something to click.
  const link = typeof f.webViewLink === 'string' && /^https:\/\/(docs|drive|sheets|slides|forms)\.google\.com\//.test(f.webViewLink) ? f.webViewLink : null;
  const { rows } = await tx.query(
    `insert into item (id, workspace_id, connection_id, kind, external_id, occurred_at, sender, recipients, subject, snippet, meta)
     values ($1, $2, $3, 'file', $4, $5, $6, '{}'::jsonb, $7, $8, $9::jsonb)
     on conflict (workspace_id, connection_id, kind, external_id)
     do update set occurred_at = excluded.occurred_at, sender = excluded.sender, subject = excluded.subject, snippet = excluded.snippet, meta = excluded.meta, updated_at = now()
     returning (xmax = 0) as inserted`,
    [
      newId('itm'),
      workspaceId,
      connectionId,
      f.id,
      Number.isNaN(changed.getTime()) ? new Date() : changed,
      (owner?.emailAddress ?? '').toLowerCase(),
      String(f.name).replace(/\u0000/g, '').slice(0, 500),
      fileKind(mimeType),
      // Being listed shows the file is still there, so the nightly check (checkFiles) can leave it for a while.
      JSON.stringify({ mimeType, link, ownerName: owner?.displayName, changedBy: f.lastModifyingUser?.displayName, shared: !!f.shared, size: f.size != null ? Number(f.size) : undefined, checkedAt: new Date().toISOString() }).replace(/\\u0000/g, ''),
    ],
  );
  return !!rows[0]?.inserted;
}

/** A file was deleted or moved to the trash in Drive: it leaves Timmy's list too, and what it said goes with it. */
export async function removeFile(workspaceId: string, connectionId: string, fileId: string): Promise<number> {
  return withWorkspace({ workspaceId }, async (tx) => (await tx.query(`delete from item where workspace_id = $1 and connection_id = $2 and kind = 'file' and external_id = $3`, [workspaceId, connectionId, fileId])).rowCount ?? 0);
}

/**
 * Whether a refusal means the file is not there for this person any more (deleted for good, or no longer shared):
 * Drive's own "File not found", or a 404 about this very file. A problem with the account or the connection is never
 * read as the file being gone, so a lapsed sign-in can't empty the list.
 */
const isGone = (error: string, fileId: string) => !/account|connect|auth|token|credential|quota|rate/i.test(error) && (/file not found/i.test(error) || (/\b404\b|not found/i.test(error) && error.includes(fileId)));

export interface FilesCheck {
  calls: number;
  dropped: number;
}

/**
 * The nightly look for files that left Drive without Timmy hearing of it (a missed "file trashed" announcement, a
 * file deleted for good, a share taken away). In bounded batches:
 *   1. the files in the person's trash, up to `trashPages` pages of 200 ids, drop off the list;
 *   2. then up to `batch` stored files, those not seen alive for longest, are asked about one by one; one in the trash
 *      or one Drive says is not found drops off. Any other failure leaves the file where it is.
 * Every file a listing returns counts as seen alive, so a busy list is asked about rarely.
 */
export async function checkFiles(workspaceId: string, connectionId: string, opts: { batch?: number; trashPages?: number } = {}): Promise<FilesCheck> {
  const out: FilesCheck = { calls: 0, dropped: 0 };
  const conn = await connectionById(workspaceId, connectionId);
  if (!conn || conn.status !== 'active' || conn.toolkit !== 'googledrive') return out;
  const drop = async (ids: string[]) => {
    if (!ids.length) return;
    out.dropped += await withWorkspace({ workspaceId }, async (tx) => (await tx.query(`delete from item where workspace_id = $1 and connection_id = $2 and kind = 'file' and external_id = any($3::text[])`, [workspaceId, connectionId, ids])).rowCount ?? 0);
  };

  let pageToken: string | undefined;
  for (let page = 0; page < (opts.trashPages ?? 2); page++) {
    const res = await callTool(workspaceId, connectionId, 'GOOGLEDRIVE_FIND_FILE', { q: `trashed = true and mimeType != '${FOLDER}'`, fields: 'nextPageToken,files(id,trashed)', pageSize: 200, ...(pageToken ? { pageToken } : {}) }, 'reconcile');
    out.calls++;
    if (!res.successful) break;
    const data = payload(res.data);
    // Each file must say itself that it is in the trash: a query that came back wider than asked drops nothing.
    await drop(((data.files ?? []) as DriveFile[]).filter((f) => f.trashed === true).map((f) => String(f.id ?? '')).filter(Boolean));
    pageToken = (data.nextPageToken as string | null | undefined) || undefined;
    if (!pageToken) break;
  }

  const stale = await withWorkspace({ workspaceId }, async (tx) =>
    (
      await tx.query(`select external_id from item where workspace_id = $1 and connection_id = $2 and kind = 'file' order by coalesce(meta->>'checkedAt', '') asc, occurred_at asc limit $3`, [
        workspaceId,
        connectionId,
        Math.max(0, opts.batch ?? config.filesCheckBatch),
      ])
    ).rows.map((r) => r.external_id as string),
  );
  const gone: string[] = [];
  const alive: string[] = [];
  for (const id of stale) {
    const res = await callTool(workspaceId, connectionId, 'GOOGLEDRIVE_GET_FILE_METADATA', { fileId: id, fields: 'id,trashed' }, 'reconcile').catch(() => null);
    out.calls++;
    if (!res) continue;
    if (res.successful) (payload(res.data).trashed === true ? gone : alive).push(id);
    else if (isGone(res.error ?? '', id)) gone.push(id);
  }
  await drop(gone);
  if (alive.length) {
    await withWorkspace({ workspaceId }, (tx) =>
      tx.query(`update item set meta = meta || jsonb_build_object('checkedAt', $4::text) where workspace_id = $1 and connection_id = $2 and kind = 'file' and external_id = any($3::text[])`, [workspaceId, connectionId, alive, new Date().toISOString()]),
    );
  }
  return out;
}

/* ───────────── Reading inside a file ───────────── */

interface DocsElement {
  paragraph?: { elements?: { textRun?: { content?: string } }[] };
  table?: { tableRows?: { tableCells?: { content?: DocsElement[] }[] }[] };
}

/** The words of a Google Doc, from the structure Google returns: paragraphs in order, table rows as lines. */
export function docText(content: DocsElement[] | undefined): string {
  const out: string[] = [];
  for (const el of content ?? []) {
    if (el.paragraph) out.push((el.paragraph.elements ?? []).map((e) => e.textRun?.content ?? '').join(''));
    else if (el.table) for (const row of el.table.tableRows ?? []) out.push(`${(row.tableCells ?? []).map((c) => docText(c.content).trim()).join(' | ')}\n`);
  }
  return out.join('').replace(/\u0000/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

interface SlidesPage {
  pageElements?: { shape?: { text?: { textElements?: { textRun?: { content?: string } }[] } } }[];
}

/** The Google kinds Timmy reads, each through its own Google tool. `phase` says who asked: Ask (agent) or the index (sync). */
const READERS: Record<string, (workspaceId: string, connectionId: string, fileId: string, phase: Phase) => Promise<string | null>> = {
  'application/vnd.google-apps.document': async (ws, conn, id, phase) => {
    const res = await callTool(ws, conn, 'GOOGLEDRIVE_GET_DOCUMENT', { document_id: id }, phase);
    return res.successful ? docText((payload(res.data).body as { content?: DocsElement[] } | undefined)?.content) : null;
  },
  'application/vnd.google-apps.spreadsheet': async (ws, conn, id, phase) => {
    // The first sheet's top-left corner: enough to see what the sheet is, without pulling a whole workbook.
    const res = await callTool(ws, conn, 'GOOGLEDRIVE_GET_SPREADSHEET_VALUES', { spreadsheet_id: id, range: 'A1:Z200' }, phase);
    if (!res.successful) return null;
    const rows = (payload(res.data).values ?? []) as unknown[][];
    return rows.map((r) => r.map((c) => String(c ?? '').replace(/[\t\n]/g, ' ')).join('\t')).join('\n');
  },
  'application/vnd.google-apps.presentation': async (ws, conn, id, phase) => {
    const res = await callTool(ws, conn, 'GOOGLEDRIVE_GET_PRESENTATION', { presentation_id: id, fields: 'title,slides(pageElements(shape(text(textElements(textRun(content))))))' }, phase);
    if (!res.successful) return null;
    const slides = (payload(res.data).slides ?? []) as SlidesPage[];
    return slides.map((s, i) => `Slide ${i + 1}\n${(s.pageElements ?? []).map((e) => (e.shape?.text?.textElements ?? []).map((t) => t.textRun?.content ?? '').join('')).join('').trim()}`).join('\n\n');
  },
};

/** The mime types of the Google files Timmy reads. */
export const DRIVE_READABLE = Object.keys(READERS);

/** Whether Timmy can read what a file of this type says, from this app. */
export function canRead(toolkit: string, mime: string, name: string): boolean {
  if (toolkit === 'googledrive') return Object.hasOwn(READERS, mime);
  if (toolkit === 'one_drive') return canReadOneDrive(mime, name);
  return false;
}

/** Reads one listed file through its own connection: its words, or why there are none. Only call it when canRead says so. */
export async function readListed(workspaceId: string, f: ListedFile, phase: Phase): Promise<Read> {
  if (f.toolkit === 'one_drive') return readOneDriveText(workspaceId, f, phase);
  const read = Object.hasOwn(READERS, f.mime) ? READERS[f.mime] : undefined;
  const text = read ? await read(workspaceId, f.connectionId, f.id, phase) : null;
  return text === null ? { reason: 'Drive would not hand over that file’s contents.' } : { text };
}

/** A listed file by its id, on a connection of this workspace that is still active; null when there is none. */
export async function listedFile(workspaceId: string, fileId: string): Promise<ListedFile | null> {
  const row = await withWorkspace({ workspaceId }, async (tx) =>
    (
      await tx.query(
        `select i.connection_id, c.toolkit, i.external_id, i.subject, i.snippet, i.meta->>'mimeType' as mime, i.meta->>'size' as size, i.meta->>'driveId' as drive_id
         from item i join connection c on c.id = i.connection_id
         where i.workspace_id = $1 and i.kind = 'file' and i.external_id = $2 and c.status = 'active' limit 1`,
        [workspaceId, fileId],
      )
    ).rows[0],
  );
  if (!row) return null;
  return { connectionId: row.connection_id, toolkit: row.toolkit, id: row.external_id, name: row.subject ?? '', kind: row.snippet ?? 'File', mime: row.mime ?? '', size: row.size == null ? undefined : Number(row.size), driveId: row.drive_id ?? undefined };
}

/**
 * The text of one file on the workspace's list, read at this moment through its connection (Drive or OneDrive).
 * Only a file Timmy already lists can be read: the id is looked up in this workspace's own store, on a connection
 * that is still active, before anything is asked of the app.
 */
export async function readFileText(workspaceId: string, fileId: string): Promise<FileText> {
  const f = await listedFile(workspaceId, fileId);
  if (!f) return { ok: false, reason: 'That file is not on the list of files Timmy can see.' };
  if (!canRead(f.toolkit, f.mime, f.name)) {
    const can = f.toolkit === 'one_drive' ? 'Timmy can read Word, Excel and PowerPoint files from OneDrive' : 'Timmy can read Google Docs, Sheets and Slides';
    return { ok: false, reason: `${can}. “${f.name}” is a ${f.kind.toLowerCase()}, which it can’t open yet.` };
  }
  const got = await readListed(workspaceId, f, 'agent');
  if ('reason' in got) return { ok: false, reason: got.reason };
  return { ok: true, name: f.name, kind: f.kind, text: got.text.slice(0, MAX_FILE_TEXT), truncated: got.text.length > MAX_FILE_TEXT };
}
