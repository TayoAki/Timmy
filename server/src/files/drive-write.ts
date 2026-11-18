/**
 * The write half of editing a Drive file in Timmy (files/drive-edit.ts): Drive's version of a file, and the Action
 * gateway's executor for `file.update`, which saves an approved edit over the Drive original. Kept apart from
 * drive-edit.ts, which proposes the save through the gateway, because the gateway's list of executors imports this.
 */
import { composio } from '../providers/composio';
import type { EffectRow, Outcome } from '../gateway/gateway';
import { callTool, connectionById, writeTool } from '../sync/tools';
import { readAsset, sha256Of } from './assets';

export type EditFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf';

export type CraftApp = 'wordcraft' | 'gridcraft' | 'deckcraft' | 'pdfcraft';

export const OFFICE = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
} as const satisfies Record<EditFormat, string>;

const APP_FOR: Record<EditFormat, CraftApp> = { docx: 'wordcraft', xlsx: 'gridcraft', pptx: 'deckcraft', pdf: 'pdfcraft' };

/** Google's own files, and the Office file each is exported as and saved back from. */
const GOOGLE_NATIVE: Record<string, EditFormat> = {
  'application/vnd.google-apps.document': 'docx',
  'application/vnd.google-apps.spreadsheet': 'xlsx',
  'application/vnd.google-apps.presentation': 'pptx',
};

/** How a listed file opens in an editor, or undefined when none of the editors takes it. */
export function editingOf(toolkit: string, mime: string, name: string): { format: EditFormat; app: CraftApp; native: boolean; saves: boolean } | undefined {
  const native = toolkit === 'googledrive' ? GOOGLE_NATIVE[mime] : undefined;
  const ext = /\.(docx|xlsx|pptx|pdf)$/i.exec(name)?.[1]?.toLowerCase() as EditFormat | undefined;
  const byType = (Object.keys(OFFICE) as EditFormat[]).find((f) => OFFICE[f] === mime);
  const format = native ?? byType ?? (toolkit === 'one_drive' ? ext : undefined);
  if (!format) return undefined;
  return { format, app: APP_FOR[format], native: !!native, saves: toolkit === 'googledrive' };
}

const payload = (data: Record<string, unknown>) => (data.response_data ?? data) as Record<string, unknown>;

export const CHANGED = (app: string) => `Someone changed this file in ${app} after you opened it, so your changes weren’t saved over theirs.`;

/** What the gateway approves, and the executor is handed, for one save. */
export interface FileUpdatePayload {
  connectionId: string;
  fileId: string;
  itemId: string;
  name: string;
  format: EditFormat;
  type: string;
  asset: string;
  sha256: string;
  size: number;
  /** Drive's version of the file when it was opened. The save stops if Drive's has moved on. */
  version: string;
}

export interface DriveState {
  version: string;
  canEdit: boolean;
  trashed: boolean;
}

/** Which version of the file Drive has (when it was last changed), and whether this account may change it. */
export async function driveState(workspaceId: string, connectionId: string, fileId: string): Promise<DriveState | null> {
  const res = await callTool(workspaceId, connectionId, 'GOOGLEDRIVE_GET_FILE_METADATA', { fileId, fields: 'id,version,modifiedTime,trashed,capabilities/canEdit' }, 'agent');
  if (!res.successful) return null;
  const d = payload(res.data);
  // When it last changed: Drive's own version number also moves when only its sharing changes, which would stop saves for nothing.
  const version = d.modifiedTime ?? d.version;
  if (version == null) return null;
  const caps = d.capabilities as { canEdit?: boolean } | undefined;
  return { version: String(version), canEdit: caps?.canEdit !== false, trashed: d.trashed === true };
}

/**
 * The gateway's executor for `file.update`. The approved bytes are read back and checked against the approved
 * hash, Drive's version is checked once more, and only then is the file handed to Composio and saved over the
 * original.
 */
export async function updateDriveFile(e: EffectRow): Promise<Outcome> {
  const p = e.payload as unknown as FileUpdatePayload;
  const conn = await connectionById(e.workspace_id, p.connectionId);
  if (!conn || conn.status !== 'active' || conn.toolkit !== 'googledrive') return { status: 'failed', error: 'Google Drive is no longer connected.' };
  const read = await readAsset(e.workspace_id, p.asset);
  if (!read || sha256Of(read.bytes) !== p.sha256) return { status: 'failed', error: 'The edited file changed after you saved it, so it wasn’t sent.' };
  const now = await driveState(e.workspace_id, p.connectionId, p.fileId);
  if (!now) return { status: 'failed', error: 'Google Drive didn’t answer just now. Try saving again.' };
  if (now.version !== p.version) return { status: 'failed', error: CHANGED('Google Drive'), result: { changed: true, version: now.version } };
  let staged;
  try {
    staged = await composio().stageFile({ toolSlug: 'GOOGLEDRIVE_UPLOAD_UPDATE_FILE', toolkit: 'googledrive', name: p.name, type: p.type, bytes: read.bytes });
  } catch (err) {
    // Nothing reached Drive: the file never got as far as Composio's store.
    return { status: 'failed', error: `The file couldn’t be handed to Google Drive: ${(err as Error).message.slice(0, 200)}` };
  }
  const res = await writeTool(e.workspace_id, p.connectionId, 'GOOGLEDRIVE_UPLOAD_UPDATE_FILE', { fileId: p.fileId, file_to_upload: staged, uploadType: 'media' });
  if (!res.successful) return { status: 'failed', error: `Google Drive refused the save: ${String(res.error ?? 'no reason given').slice(0, 300)}` };
  const after = await driveState(e.workspace_id, p.connectionId, p.fileId).catch(() => null);
  return { status: 'completed', result: { fileId: p.fileId, version: after?.version ?? null, size: p.size }, externalId: p.fileId };
}
