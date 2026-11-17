/**
 * The apps that are file lists (Google Drive and OneDrive) behind one set of calls, so the connect flow, the
 * webhook and the jobs don't need to know which one a connection is.
 */
import type { FilesSync } from './file-kinds';
import { driveAddress, syncFiles } from './files';
import { oneDriveAddress, syncOneDrive } from './onedrive';
import { connectionById } from './tools';

export const FILE_TOOLKITS = ['googledrive', 'one_drive'];

/** Who the connected account is, asked of the app itself. */
export async function fileAccount(workspaceId: string, connectionId: string, toolkit: string): Promise<string | null> {
  if (toolkit === 'one_drive') return oneDriveAddress(workspaceId, connectionId);
  if (toolkit === 'googledrive') return driveAddress(workspaceId, connectionId);
  return null;
}

/** One pass over a connection's file list, whichever app it is. */
export async function syncFileList(workspaceId: string, connectionId: string, opts: { maxPages?: number; pageSize?: number } = {}): Promise<FilesSync> {
  const conn = await connectionById(workspaceId, connectionId);
  if (conn?.toolkit === 'one_drive') return syncOneDrive(workspaceId, connectionId, opts);
  return syncFiles(workspaceId, connectionId, opts);
}

/**
 * What an app's event about a file asks for: a file thrown away leaves the list at once; anything else means "the
 * list changed", and one pass per connection covers a burst. Null for an event that isn't about files.
 */
export function fileEvent(toolkit: string, triggerSlug: string, data: Record<string, unknown>): { remove: string } | { sync: true } | null {
  if (toolkit === 'googledrive') {
    const gone = triggerSlug === 'GOOGLEDRIVE_FILE_DELETED_OR_TRASHED_TRIGGER' ? String(data.file_id ?? '') : '';
    return gone ? { remove: gone } : { sync: true };
  }
  if (toolkit === 'one_drive') {
    const item = (data.item ?? {}) as { item_id?: unknown; deleted?: unknown };
    const id = typeof item.item_id === 'string' ? item.item_id : '';
    if (id && (triggerSlug === 'ONE_DRIVE_ITEM_DELETED_TRIGGER' || item.deleted === true)) return { remove: id };
    return { sync: true };
  }
  return null;
}
