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
  purpose: 'primary' | 'sending';
  meta: Record<string, unknown>;
}

export type Phase = 'connect' | 'backfill' | 'sync' | 'agent' | 'send';

export async function connectionById(workspaceId: string, connectionId: string): Promise<ConnectionRow | null> {
  return withWorkspace({ workspaceId }, async (tx) => ((await tx.query('select * from connection where id = $1 and workspace_id = $2', [connectionId, workspaceId])).rows[0] as ConnectionRow | undefined) ?? null);
}

/** Every Composio call is counted against the workspace, by phase, so cost per user can be measured. */
export async function meter(workspaceId: string, op: string, phase: Phase, ok: boolean, ms: number) {
  await withWorkspace({ workspaceId }, (tx) => tx.query('insert into provider_call (workspace_id, provider, op, phase, ok, ms) values ($1, $2, $3, $4, $5, $6)', [workspaceId, 'composio', op, phase, ok, ms])).catch(() => {});
}

/**
 * Runs one Composio tool on a workspace's connection. The connection is looked
 * up inside the workspace's own scope, so a connection id from another
 * workspace finds nothing.
 */
export async function callTool(workspaceId: string, connectionId: string, slug: string, args: Record<string, unknown>, phase: Phase): Promise<ToolResult> {
  const conn = await connectionById(workspaceId, connectionId);
  if (!conn || conn.status !== 'active' || !conn.connected_account_id) return { successful: false, data: {}, error: 'This app is not connected.' };
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
