import { withWorkspace } from '../db/pool';
import { composio, type ToolResult } from '../providers/composio';

export interface ConnectionRow {
  id: string;
  workspace_id: string;
  user_id: string;
  app_id: string;
  toolkit: string;
  composio_user_id: string;
  connected_account_id: string | null;
  auth_config_id: string | null;
  status: 'pending' | 'active' | 'failed' | 'disconnected';
  account_label: string | null;
  meta: Record<string, unknown>;
}

/** `changes` is the periodic look at what the person changed in the mailbox itself (see mailbox-check.ts). */
export type Phase = 'connect' | 'backfill' | 'sync' | 'reconcile' | 'changes' | 'agent' | 'send';

export async function connectionById(workspaceId: string, connectionId: string): Promise<ConnectionRow | null> {
  return withWorkspace({ workspaceId }, async (tx) => ((await tx.query('select * from connection where id = $1 and workspace_id = $2', [connectionId, workspaceId])).rows[0] as ConnectionRow | undefined) ?? null);
}

/** Every Composio call is counted against the workspace, by phase, so cost per user can be measured. */
export async function meter(workspaceId: string, op: string, phase: Phase, ok: boolean, ms: number) {
  await withWorkspace({ workspaceId }, (tx) => tx.query('insert into provider_call (workspace_id, provider, op, phase, ok, ms) values ($1, $2, $3, $4, $5, $6)', [workspaceId, 'composio', op, phase, ok, ms])).catch(() => {});
}

/**
 * The only tools Timmy runs on the apps it just reads. Any other tool on such an account is refused here, before
 * anything reaches Composio, so no mistake elsewhere in the code can write to someone's files.
 */
export const READ_ONLY_TOOLS: Record<string, ReadonlySet<string>> = {
  googledrive: new Set(['GOOGLEDRIVE_GET_ABOUT', 'GOOGLEDRIVE_FIND_FILE', 'GOOGLEDRIVE_GET_FILE_METADATA', 'GOOGLEDRIVE_GET_DOCUMENT', 'GOOGLEDRIVE_EXPORT_GOOGLE_WORKSPACE_FILE', 'GOOGLEDRIVE_GET_SPREADSHEET_VALUES', 'GOOGLEDRIVE_GET_PRESENTATION']),
  one_drive: new Set(['ONE_DRIVE_LIST_DRIVES', 'ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES', 'ONE_DRIVE_DOWNLOAD_FILE']),
};

/**
 * Runs one Composio tool on a workspace's connection. The connection is looked
 * up inside the workspace's own scope, so a connection id from another
 * workspace finds nothing.
 */
export async function callTool(workspaceId: string, connectionId: string, slug: string, args: Record<string, unknown>, phase: Phase): Promise<ToolResult> {
  const conn = await connectionById(workspaceId, connectionId);
  if (!conn || conn.status !== 'active' || !conn.connected_account_id) return { successful: false, data: {}, error: 'This app is not connected.' };
  const readOnly = Object.hasOwn(READ_ONLY_TOOLS, conn.toolkit) ? READ_ONLY_TOOLS[conn.toolkit] : undefined;
  if (readOnly && !readOnly.has(slug)) return { successful: false, data: {}, error: 'Timmy only reads this app; that tool is not one it uses.' };
  const started = Date.now();
  try {
    const res = await composio().execute(slug, args, { userId: conn.composio_user_id, connectedAccountId: conn.connected_account_id });
    await meter(workspaceId, slug, phase, res.successful, Date.now() - started);
    return res;
  } catch (err) {
    await meter(workspaceId, slug, phase, false, Date.now() - started);
    throw err;
  }
}
