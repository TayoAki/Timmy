/**
 * Editing a Drive file in Timmy's own editors (the Craft apps), and saving the result back over the original.
 *
 *   open: the file's bytes as an Office or PDF file the editor opens. A Google Doc, Sheet or Slides deck is exported
 *         by Google as .docx, .xlsx or .pptx; a Word, Excel, PowerPoint or PDF file kept in Drive is downloaded as it
 *         is. Each comes with Drive's version number for the file, so a save can tell whether someone changed it
 *         in the meantime.
 *   save: the edited file goes up as a new version of the same Drive file (Drive's own update of a file's content).
 *         Drive keeps the earlier versions in the file's version history. It is an outside write, so it goes through
 *         the Action gateway as `file.update`: the person's own press of Save is the approval, it is recorded and
 *         audited like a send, and the executor checks the bytes against the ones approved before anything leaves.
 *
 * Only Google Drive files are saved back. OneDrive files open in the editor to read, and to download a copy.
 * Nothing about the file is kept in Timmy beyond what the file list already holds; the edited bytes go through the
 * workspace's file store (the same as an attachment), because that is how the gateway hands approved bytes to its
 * executor.
 */
import { composio } from '../providers/composio';
import { log } from '../lib/log';
import { withWorkspace } from '../db/pool';
import { loadState } from '../state/docs';
import { actorOf, type Ctx } from '../state/engine';
import { executeEffect, propose, type EffectRow } from '../gateway/gateway';
import { callTool } from '../sync/tools';
import { readAsset, sha256Of } from './assets';
import { CHANGED, OFFICE, driveState, editingOf, type CraftApp, type DriveState, type EditFormat, type FileUpdatePayload } from './drive-write';
import { listed } from './view';

export type { CraftApp, EditFormat } from './drive-write';

/** The most a file opened for editing may weigh: what Google exports at most, and what Timmy keeps of an upload. */
export const EDIT_MAX_BYTES = 10 * 1024 * 1024;

const APP_NAMES: Record<string, string> = { googledrive: 'Google Drive', one_drive: 'OneDrive' };
const payload = (data: Record<string, unknown>) => (data.response_data ?? data) as Record<string, unknown>;

/** The name the editor shows and saves under: the Drive name, with the format's ending when it has none. */
const withFormat = (name: string, format: EditFormat) => (name.toLowerCase().endsWith(`.${format}`) ? name : `${name}.${format}`);

export type Opened =
  | { ok: true; name: string; format: EditFormat; app: CraftApp; type: string; bytes: Uint8Array; version: string | null; saves: boolean; reason?: string; appName: string }
  | { ok: false; status: 404 | 409 | 413 | 415 | 502; error: string };

/** The file as the editor opens it, with what saving it back would take. */
export async function openForEditing(workspaceId: string, itemId: string): Promise<Opened> {
  const f = await listed(workspaceId, itemId);
  if (!f) return { ok: false, status: 404, error: 'That file isn’t on this workspace’s list.' };
  const appName = APP_NAMES[f.toolkit] ?? 'Files';
  const how = editingOf(f.toolkit, f.mime, f.name);
  if (!how) return { ok: false, status: 415, error: `Timmy’s editors don’t open a ${f.kind.toLowerCase()}. Open it in ${appName}.` };
  if (f.size != null && f.size > EDIT_MAX_BYTES) return { ok: false, status: 413, error: `This file is too large to edit in Timmy (over 10 MB). Open it in ${appName}.` };
  const refused = (): Opened => ({ ok: false, status: 502, error: `${appName} didn’t hand over this file just now. Try again, or open it in ${appName}.` });

  let bytes: Uint8Array | null = null;
  let state: DriveState | null = null;
  try {
    if (f.toolkit === 'googledrive') {
      state = await driveState(workspaceId, f.connectionId, f.id);
      if (!state) return refused();
      if (state.trashed) return { ok: false, status: 404, error: 'This file is in the Drive trash.' };
      const res = how.native
        ? await callTool(workspaceId, f.connectionId, 'GOOGLEDRIVE_EXPORT_GOOGLE_WORKSPACE_FILE', { fileId: f.id, mimeType: OFFICE[how.format] }, 'agent')
        : await callTool(workspaceId, f.connectionId, 'GOOGLEDRIVE_DOWNLOAD_FILE', { fileId: f.id }, 'agent');
      if (!res.successful) return refused();
      const d = payload(res.data);
      const ref = (how.native ? d.file : d.downloaded_file_content) as { s3url?: unknown } | undefined;
      if (typeof ref?.s3url !== 'string') return refused();
      bytes = await composio().download(ref.s3url, EDIT_MAX_BYTES);
    } else if (f.toolkit === 'one_drive') {
      const res = await callTool(workspaceId, f.connectionId, 'ONE_DRIVE_DOWNLOAD_FILE', { item_id: f.id, file_name: f.name, ...(f.driveId ? { drive_id: f.driveId } : {}) }, 'agent');
      if (!res.successful) return refused();
      const ref = payload(res.data).content as { s3url?: unknown } | undefined;
      if (typeof ref?.s3url !== 'string') return refused();
      bytes = await composio().download(ref.s3url, EDIT_MAX_BYTES);
    }
  } catch (e) {
    const message = (e as Error).message;
    log.warn('file could not be opened for editing', { workspaceId, connectionId: f.connectionId, error: message });
    if (/larger|too large|maxBytes/i.test(message)) return { ok: false, status: 413, error: `This file is too large to edit in Timmy (over 10 MB). Open it in ${appName}.` };
    return refused();
  }
  if (!bytes) return refused();

  const reason = !how.saves ? `Saving back to ${appName} isn’t available yet. Download keeps a copy of your changes.` : state && !state.canEdit ? `You can view this file but not change it in ${appName}. Download keeps a copy of your changes.` : undefined;
  return {
    ok: true,
    name: withFormat(f.name, how.format),
    format: how.format,
    app: how.app,
    type: OFFICE[how.format],
    bytes,
    version: state?.version ?? null,
    saves: how.saves && !reason,
    ...(reason ? { reason } : {}),
    appName,
  };
}

/* ───────────── Saving back ───────────── */

/** The first bytes each format starts with: an Office file is a zip archive, a PDF says so. */
function looksLike(format: EditFormat, bytes: Uint8Array): boolean {
  if (format === 'pdf') return bytes.length > 4 && String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-';
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export type Saved = { ok: true; version: string | null; effectId: string } | { ok: false; status: number; error: string; version?: string };

/**
 * Saves the edited file, already uploaded to the workspace's store as `assetId`, over the Drive file. `version` is
 * the one the editor opened. Waits for Drive's answer (a few seconds) so the editor can say whether it took.
 */
export async function saveToDrive(ctx: Ctx, itemId: string, assetId: string, version: string): Promise<Saved> {
  const workspaceId = ctx.workspaceId;
  if (!ctx.rules.work) return { ok: false, status: 403, error: 'Your role can’t change files in this workspace.' };
  const f = await listed(workspaceId, itemId);
  if (!f) return { ok: false, status: 404, error: 'That file isn’t on this workspace’s list.' };
  const how = editingOf(f.toolkit, f.mime, f.name);
  if (!how?.saves) return { ok: false, status: 400, error: `Saving back to ${APP_NAMES[f.toolkit] ?? 'this app'} isn’t available yet.` };
  const read = await readAsset(workspaceId, assetId);
  // Only the person's own upload, finished, is saved: an id from somewhere else in the workspace is refused.
  if (!read || read.asset.created_by !== ctx.user.id || !read.asset.uploaded_at || read.asset.purpose !== 'attachment') return { ok: false, status: 400, error: 'That upload isn’t one of yours. Save again.' };
  if (!looksLike(how.format, read.bytes)) return { ok: false, status: 400, error: `That isn’t a .${how.format} file.` };
  const now = await driveState(workspaceId, f.connectionId, f.id);
  if (!now) return { ok: false, status: 502, error: 'Google Drive didn’t answer just now. Try saving again.' };
  if (!now.canEdit) return { ok: false, status: 403, error: 'You can view this file but not change it in Google Drive.' };
  if (now.version !== version) return { ok: false, status: 409, error: CHANGED('Google Drive'), version: now.version };

  const sha256 = read.asset.sha256 ?? sha256Of(read.bytes);
  const p: FileUpdatePayload = { connectionId: f.connectionId, fileId: f.id, itemId, name: withFormat(f.name, how.format), format: how.format, type: OFFICE[how.format], asset: assetId, sha256, size: read.bytes.length, version };
  const proposed = await withWorkspace({ workspaceId, lock: true }, async (tx) => {
    const loaded = await loadState(tx, workspaceId);
    return propose(tx, loaded, loaded.state, actorOf(ctx), {
      kind: 'file.update',
      payload: p as unknown as Record<string, unknown>,
      preview: { lines: [`Replace the content of “${f.name}” in Google Drive with the version edited in Timmy. Drive keeps the earlier one in its version history.`] },
      title: `Save “${f.name}” to Google Drive`,
      why: 'You pressed Save.',
      target: `file:${itemId}`,
      idempotencyKey: `file-save:${itemId}:${ctx.user.id}:${version}:${sha256}`,
      source: 'user',
      meta: { fileId: f.id },
    });
  });
  if (proposed.outcome === 'blocked' || !proposed.effect) return { ok: false, status: 403, error: proposed.reason ?? 'That save was refused.' };
  if (proposed.outcome !== 'approved') return { ok: false, status: 403, error: 'Your role can’t change files in this workspace.' };

  const done = await finished(workspaceId, proposed.effect);
  if (done.status === 'completed') return { ok: true, version: (done.result?.version as string | undefined) ?? null, effectId: done.id };
  if (done.status === 'failed') {
    const changed = done.result?.changed === true;
    return { ok: false, status: changed ? 409 : 502, error: done.error ?? 'Google Drive refused the save.', ...(changed && typeof done.result?.version === 'string' ? { version: done.result.version } : {}) };
  }
  return { ok: false, status: 504, error: 'Google Drive didn’t confirm the save. Open the file in Drive to see whether it took before saving again.' };
}

/**
 * Runs the approved save and waits for its outcome. The job queue may claim it first (it is told about every
 * approved effect); then this waits for the queue's run to finish, for up to a minute.
 */
async function finished(workspaceId: string, effect: EffectRow): Promise<EffectRow> {
  const ran = effect.status === 'approved' ? await executeEffect(workspaceId, effect.id) : null;
  if (ran && ran.status !== 'executing') return ran;
  const until = Date.now() + 60_000;
  for (;;) {
    const row = await withWorkspace({ workspaceId }, async (tx) => (await tx.query('select * from effect where id = $1 and workspace_id = $2', [effect.id, workspaceId])).rows[0] as EffectRow | undefined);
    if (!row || !['approved', 'executing'].includes(row.status) || Date.now() > until) return row ?? effect;
    await new Promise((r) => setTimeout(r, 250));
  }
}
