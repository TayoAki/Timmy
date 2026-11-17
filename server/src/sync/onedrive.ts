/**
 * OneDrive, through Composio's `one_drive` toolkit. Read-only, like Google Drive, and a separate app from Outlook.
 *
 * Timmy keeps a list of the person's files: name, kind, owner, when it last changed and a link. Microsoft lists a
 * drive's changes as a feed (Graph's "delta"): the first pass walks the drive once and keeps what changed inside the
 * window, and from then on each pass asks only for what changed since the last, deletions included, so a file that
 * goes to the recycle bin leaves the list on the next pass even if its event never came.
 *
 * The words of Word, Excel and PowerPoint files are read by downloading the file and opening it here
 * (office-text.ts): Microsoft's tools that return a workbook's cells as text need write permission, and Word and
 * PowerPoint have no such tool at all. Timmy asks Microsoft only to read the person's own files.
 */
import { config } from '../config';
import { withWorkspace, type Tx } from '../db/pool';
import { newId } from '../lib/ids';
import { log } from '../lib/log';
import { composio } from '../providers/composio';
import { DownloadRefused } from '../providers/composio-download';
import { MAX_FILE_TEXT, fileKind, type FilesSync, type ListedFile, type Read } from './file-kinds';
import { OfficeError, officeKind, officeText } from './office-text';
import { callTool, connectionById, meter, type Phase } from './tools';

/** What Microsoft is asked for about each file. Only these come back, which keeps each page small. */
const SELECT = 'id,name,size,webUrl,lastModifiedDateTime,createdDateTime,file,folder,root,deleted,createdBy,lastModifiedBy,parentReference,shared';
const PAGE = 200;

interface Person {
  user?: { displayName?: string; display_name?: string; email?: string };
}

interface GraphItem {
  id?: string;
  name?: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  createdDateTime?: string;
  file?: { mimeType?: string };
  folder?: unknown;
  root?: unknown;
  deleted?: unknown;
  createdBy?: Person;
  lastModifiedBy?: Person;
  shared?: { owner?: Person };
  parentReference?: { driveId?: string };
}

const payload = (data: Record<string, unknown>) => (data.response_data ?? data) as Record<string, unknown>;

/** The type an Office file's name implies, for an item Microsoft listed without one. */
const MIME_BY_EXT: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
};

/** Who the connected account is, from its drive: the address Microsoft gives, or else the name. */
export async function oneDriveAddress(workspaceId: string, connectionId: string): Promise<string | null> {
  const res = await callTool(workspaceId, connectionId, 'ONE_DRIVE_LIST_DRIVES', { select: 'id,driveType,owner' }, 'connect').catch(() => null);
  if (!res?.successful) return null;
  const drives = (payload(res.data).value ?? []) as { driveType?: string; owner?: Person }[];
  const own = drives.find((d) => d.driveType === 'personal' || d.driveType === 'business') ?? drives[0];
  const user = own?.owner?.user;
  const email = typeof user?.email === 'string' && /^[^\s@]+@[^\s@]+$/.test(user.email) ? user.email.toLowerCase() : null;
  return email ?? (user?.display_name || user?.displayName || null);
}

interface Cursor {
  /** The link to the next page of the walk or of the changes. */
  next?: string;
  /** The link to the changes after the last finished pass. Absent while the first walk is going on. */
  delta?: string;
  /** While walking: how many pages so far, and the start of the window. */
  walked?: number;
  since?: string;
}

/**
 * Brings the list of OneDrive files up to date, one page of changes at a time, stopping after `maxPages`. Like
 * syncFiles for Drive, a job runs it again until `done`.
 */
export async function syncOneDrive(workspaceId: string, connectionId: string, opts: { maxPages?: number; pageSize?: number } = {}): Promise<FilesSync> {
  const conn = await connectionById(workspaceId, connectionId);
  const out: FilesSync = { pages: 0, files: 0, done: true };
  if (!conn || conn.status !== 'active' || conn.toolkit !== 'one_drive') return out;
  let cur = await withWorkspace({ workspaceId }, async (tx) => {
    await tx.query(`insert into sync_cursor (connection_id, workspace_id, kind, state, started_at) values ($1, $2, 'files', 'running', now()) on conflict (connection_id, kind) do nothing`, [connectionId, workspaceId]);
    return ((await tx.query(`select cursor from sync_cursor where connection_id = $1 and kind = 'files'`, [connectionId])).rows[0]?.cursor ?? {}) as Cursor;
  });
  out.done = false;

  while (out.pages < (opts.maxPages ?? 20)) {
    const walking = !cur.delta;
    const since = cur.since ?? new Date(Date.now() - config.driveBackfillDays * 86400_000).toISOString();
    const token = cur.next ?? cur.delta;
    const res = await callTool(workspaceId, connectionId, 'ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES', { top: opts.pageSize ?? PAGE, select: SELECT, ...(token ? { token } : {}) }, 'sync');
    out.pages++;
    if (!res.successful) {
      // Microsoft lets a link to changes expire; then the drive is walked again, as on the first pass.
      if (token && /\b410\b|resync/i.test(res.error ?? '')) {
        log.warn('onedrive changes link expired; walking the drive again', { workspaceId, connectionId });
        cur = await saveCursor(workspaceId, connectionId, {}, 'running');
        continue;
      }
      log.warn('onedrive page failed', { workspaceId, connectionId, error: res.error });
      throw new Error(res.error ?? 'the OneDrive file list could not be read');
    }
    const data = payload(res.data);
    const items = ((data.value ?? []) as GraphItem[]).filter((i) => typeof i.id === 'string' && i.id);
    const nextLink = typeof data['@odata.nextLink'] === 'string' ? (data['@odata.nextLink'] as string) : undefined;
    let deltaLink = typeof data['@odata.deltaLink'] === 'string' ? (data['@odata.deltaLink'] as string) : undefined;
    const removed = items.filter((i) => i.deleted).map((i) => i.id!);
    // While walking, only what changed inside the window is kept; afterwards, every change is recent by definition.
    const files = items.filter((i) => i.file && !i.folder && !i.root && !i.deleted && i.name && (!walking || new Date(i.lastModifiedDateTime ?? 0).getTime() > new Date(since).getTime()));

    let next: Cursor;
    if (nextLink && walking && (cur.walked ?? 0) + 1 >= config.oneDriveFirstPages) {
      // A very large drive: stop walking here and follow changes from now on. What wasn't reached is listed when it next changes.
      const latest = await callTool(workspaceId, connectionId, 'ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES', { token: 'latest' }, 'sync');
      out.pages++;
      deltaLink = latest.successful && typeof payload(latest.data)['@odata.deltaLink'] === 'string' ? (payload(latest.data)['@odata.deltaLink'] as string) : undefined;
      if (!deltaLink) throw new Error(latest.error ?? 'OneDrive gave no link to follow its changes');
      next = { delta: deltaLink };
    } else if (nextLink) next = walking ? { next: nextLink, walked: (cur.walked ?? 0) + 1, since } : { next: nextLink, delta: cur.delta };
    else if (deltaLink) next = { delta: deltaLink };
    else throw new Error('OneDrive gave neither a next page nor a link to its changes');

    const stored = await withWorkspace({ workspaceId }, async (tx) => {
      // Asked again inside the write: a OneDrive disconnected while this page was being fetched stores nothing more.
      const live = await tx.query(`select 1 from connection where id = $1 and workspace_id = $2 and status = 'active' for share`, [connectionId, workspaceId]);
      if (!live.rows[0]) return false;
      for (const f of files) await upsertItem(tx, workspaceId, connectionId, f);
      if (removed.length) await tx.query(`delete from item where workspace_id = $1 and connection_id = $2 and kind = 'file' and external_id = any($3::text[])`, [workspaceId, connectionId, removed]);
      await tx.query(`update sync_cursor set cursor = $2::jsonb, items_done = items_done + $3, state = $4, finished_at = case when $4 = 'done' then now() else finished_at end, updated_at = now() where connection_id = $1 and kind = 'files'`, [
        connectionId,
        JSON.stringify(next),
        files.length,
        next.next ? 'running' : 'done',
      ]);
      return true;
    });
    if (!stored) break;
    out.files += files.length;
    cur = next;
    if (!cur.next) {
      out.done = true;
      break;
    }
  }
  return out;
}

async function saveCursor(workspaceId: string, connectionId: string, cursor: Cursor, state: string): Promise<Cursor> {
  await withWorkspace({ workspaceId }, (tx) => tx.query(`update sync_cursor set cursor = $2::jsonb, state = $3, updated_at = now() where connection_id = $1 and kind = 'files'`, [connectionId, JSON.stringify(cursor), state]));
  return cursor;
}

async function upsertItem(tx: Tx, workspaceId: string, connectionId: string, f: GraphItem): Promise<void> {
  const name = String(f.name).replace(/\u0000/g, '').slice(0, 500);
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  const mimeType = String(f.file?.mimeType || (Object.hasOwn(MIME_BY_EXT, ext) ? MIME_BY_EXT[ext] : '') || '');
  const owner = (f.shared?.owner ?? f.createdBy)?.user;
  const changed = new Date(f.lastModifiedDateTime ?? f.createdDateTime ?? '');
  // A link is kept only if it is Microsoft's own; anything else in that field is dropped rather than shown as something to click.
  const link = typeof f.webUrl === 'string' && /^https:\/\/(onedrive\.live\.com|1drv\.ms|[a-z0-9-]+\.sharepoint\.com)\//i.test(f.webUrl) ? f.webUrl : null;
  const email = typeof owner?.email === 'string' && /^[^\s@]+@[^\s@]+$/.test(owner.email) ? owner.email.toLowerCase() : '';
  await tx.query(
    `insert into item (id, workspace_id, connection_id, kind, external_id, occurred_at, sender, recipients, subject, snippet, meta)
     values ($1, $2, $3, 'file', $4, $5, $6, '{}'::jsonb, $7, $8, $9::jsonb)
     on conflict (workspace_id, connection_id, kind, external_id)
     do update set occurred_at = excluded.occurred_at, sender = excluded.sender, subject = excluded.subject, snippet = excluded.snippet, meta = excluded.meta, updated_at = now()`,
    [
      newId('itm'),
      workspaceId,
      connectionId,
      String(f.id).slice(0, 300),
      Number.isNaN(changed.getTime()) ? new Date() : changed,
      email,
      name,
      fileKind(mimeType),
      JSON.stringify({
        mimeType,
        link,
        ownerName: owner?.displayName ?? owner?.display_name,
        changedBy: f.lastModifiedBy?.user?.displayName,
        shared: !!f.shared,
        size: typeof f.size === 'number' && Number.isFinite(f.size) ? f.size : undefined,
        driveId: typeof f.parentReference?.driveId === 'string' ? f.parentReference.driveId.slice(0, 200) : undefined,
        checkedAt: new Date().toISOString(),
      }).replace(/\\u0000/g, ''),
    ],
  );
}

/** Whether Timmy can read what a OneDrive file of this type says: Word, Excel and PowerPoint files. */
export function canReadOneDrive(mime: string, name: string): boolean {
  return officeKind(mime, name) !== null;
}

const KIND_WORDS = { docx: 'Word document', xlsx: 'Excel workbook', pptx: 'PowerPoint deck' };

/**
 * The words of one OneDrive file. The file is downloaded through the connection (Composio hands back a link to its
 * own store), fetched with a size ceiling, and opened in memory. Every way this can fail ends in a plain reason.
 */
export async function readOneDriveText(workspaceId: string, f: ListedFile, phase: Phase): Promise<Read> {
  const kind = officeKind(f.mime, f.name);
  if (!kind) return { reason: `Timmy can read Word, Excel and PowerPoint files from OneDrive. “${f.name}” is a ${f.kind.toLowerCase()}, which it can’t open yet.` };
  const max = config.fileText.maxBytes;
  const tooLarge = { reason: `“${f.name}” is larger than the ${Math.round(max / 1024 / 1024)} MB Timmy reads, so it can only be found by its name.` };
  if (f.size !== undefined && f.size > max) return tooLarge;
  // The name given for the download is Timmy's own: the file's name was chosen by whoever made it.
  const res = await callTool(workspaceId, f.connectionId, 'ONE_DRIVE_DOWNLOAD_FILE', { item_id: f.id, file_name: `file.${kind}`, ...(f.driveId ? { drive_id: f.driveId } : {}) }, phase);
  const url = res.successful ? (payload(res.data).content as { s3url?: unknown } | undefined)?.s3url : undefined;
  if (typeof url !== 'string') return { reason: 'OneDrive would not hand over that file’s contents.' };
  let bytes: Uint8Array;
  const started = Date.now();
  try {
    bytes = await composio().download(url, max);
    await meter(workspaceId, 'file.download', phase, true, Date.now() - started);
  } catch (e) {
    await meter(workspaceId, 'file.download', phase, false, Date.now() - started);
    if (e instanceof DownloadRefused && /larger/.test(e.message)) return tooLarge;
    log.warn('onedrive download refused', { workspaceId, error: (e as Error).message });
    return { reason: 'OneDrive would not hand over that file’s contents.' };
  }
  try {
    return { text: officeText(bytes, kind, MAX_FILE_TEXT) };
  } catch (e) {
    if (!(e instanceof OfficeError)) throw e;
    return { reason: `“${f.name}” could not be read: it is damaged, locked with a password, or not really a ${KIND_WORDS[kind]}.` };
  }
}
