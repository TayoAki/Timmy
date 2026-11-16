/**
 * App connections. Every connection is a Composio connected account: the
 * person presses Connect, signs in on Composio's page, and comes back here.
 * Timmy never sees a password or a token.
 */
import { config } from '../config';
import { withWorkspace } from '../db/pool';
import { audit } from '../gateway/gateway';
import { newId } from '../lib/ids';
import { log } from '../lib/log';
import { composio } from '../providers/composio';
import type { Ctx } from '../state/engine';
import { mutate } from '../state/mutate';
import { callTool, meter, type ConnectionRow } from './tools';

/** The frontend's app ids, and the Composio toolkit behind each. */
export const TOOLKITS: Record<string, { toolkit: string; kind: 'mail' | 'calendar' | 'files'; triggers: { slug: string; config?: Record<string, unknown> }[] }> = {
  gmail: { toolkit: 'gmail', kind: 'mail', triggers: [{ slug: 'GMAIL_NEW_GMAIL_MESSAGE', config: { labelIds: 'INBOX' } }] },
  gcal: { toolkit: 'googlecalendar', kind: 'calendar', triggers: [{ slug: 'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER', config: { calendarId: 'primary' } }] },
  gdrive: { toolkit: 'googledrive', kind: 'files', triggers: [] },
  outlook: { toolkit: 'outlook', kind: 'mail', triggers: [{ slug: 'OUTLOOK_MESSAGE_TRIGGER' }] },
};

export class ConnectError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Each workspace member is their own Composio user, so one workspace can never run tools on another's accounts. */
const composioUser = (ctx: Ctx) => `${ctx.workspaceId}.${ctx.user.id}`;

/** Starts a connection and returns the page to send the person to. */
export async function startConnect(ctx: Ctx, appId: string, purpose: 'primary' | 'sending' = 'primary'): Promise<{ redirectUrl: string; connectionId: string }> {
  const app = TOOLKITS[appId];
  if (!app) throw new ConnectError('That app can’t be connected yet.');
  if (!ctx.rules.connect) throw new ConnectError('Your role can’t connect apps in this workspace.', 403);
  const id = newId('conn');
  const started = Date.now();
  const link = await composio().link({ userId: composioUser(ctx), toolkit: app.toolkit, callbackUrl: `${config.publicUrl}/api/v1/connections/callback?c=${id}` });
  await meter(ctx.workspaceId, 'connect.link', 'connect', true, Date.now() - started);
  await withWorkspace({ workspaceId: ctx.workspaceId, userId: ctx.user.id }, async (tx) => {
    await tx.query(
      `insert into connection (id, workspace_id, user_id, app_id, toolkit, composio_user_id, connected_account_id, auth_config_id, status, purpose)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)`,
      [id, ctx.workspaceId, ctx.user.id, appId, app.toolkit, composioUser(ctx), link.connectedAccountId, link.authConfigId, purpose],
    );
    await audit(tx, ctx.workspaceId, { actor: ctx.user.id, action: 'connection.started', detail: { app: appId, connectionId: id, purpose } });
  });
  return { redirectUrl: link.redirectUrl, connectionId: id };
}

/**
 * The person came back from the connect page. Confirms with Composio that the
 * account is active (the redirect's own query string is not trusted), records
 * the address, and turns on the app's triggers.
 */
export async function finishConnect(ctx: Ctx, connectionId: string): Promise<ConnectionRow | null> {
  const conn = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => ((await tx.query('select * from connection where id = $1 and workspace_id = $2', [connectionId, ctx.workspaceId])).rows[0] as ConnectionRow | undefined) ?? null);
  if (!conn || !conn.connected_account_id) return null;
  if (conn.status === 'active') return conn;
  let acct = await composio().account(conn.connected_account_id);
  // Right after consent the provider can still be finishing the account; give it a moment.
  const deadline = Date.now() + config.connectWaitMs;
  while (acct.status !== 'ACTIVE' && /^(INITIALIZING|INITIATED|PENDING)$/i.test(acct.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    acct = await composio().account(conn.connected_account_id);
  }
  if (acct.status !== 'ACTIVE') {
    // Still in progress is not a failure: opening the callback again later can finish it.
    const over = !/^(INITIALIZING|INITIATED|PENDING)$/i.test(acct.status);
    if (over) await withWorkspace({ workspaceId: ctx.workspaceId }, (tx) => tx.query(`update connection set status = 'failed', updated_at = now() where id = $1`, [connectionId]));
    return { ...conn, status: over ? 'failed' : 'pending' };
  }
  await withWorkspace({ workspaceId: ctx.workspaceId }, (tx) => tx.query(`update connection set status = 'active', updated_at = now() where id = $1`, [connectionId]));

  let label = acct.label ?? null;
  if (conn.toolkit === 'gmail') {
    const profile = await callTool(ctx.workspaceId, connectionId, 'GMAIL_GET_PROFILE', {}, 'connect').catch(() => null);
    const data = (profile?.data.response_data ?? profile?.data ?? {}) as { emailAddress?: string };
    label = data.emailAddress ?? label;
  }
  const app = TOOLKITS[conn.app_id]!;
  const triggers: string[] = [];
  for (const t of app.triggers) {
    try {
      const made = await composio().createTrigger(t.slug, { userId: conn.composio_user_id, connectedAccountId: conn.connected_account_id, config: t.config });
      await meter(ctx.workspaceId, `trigger.create:${t.slug}`, 'connect', true, 0);
      triggers.push(made.triggerId);
      await withWorkspace({ workspaceId: ctx.workspaceId }, (tx) => tx.query('insert into trigger_instance (id, connection_id, workspace_id, slug) values ($1, $2, $3, $4) on conflict (id) do nothing', [made.triggerId, connectionId, ctx.workspaceId, t.slug]));
    } catch (err) {
      // Without the trigger, new mail still arrives through the regular reconcile pass.
      log.warn('could not create trigger', { slug: t.slug, error: (err as Error).message });
    }
  }

  await mutate(ctx.workspaceId, 'connect', async (tx, loaded) => {
    await tx.query('update connection set account_label = $2, updated_at = now() where id = $1', [connectionId, label]);
    await audit(tx, ctx.workspaceId, { actor: ctx.user.id, action: 'connection.active', detail: { app: conn.app_id, connectionId, account: label, triggers: triggers.length } });
    if (conn.purpose !== 'primary') return { result: null };
    const s = loaded.state;
    return { state: { ...s, conn: { ...s.conn, apps: { ...s.conn.apps, [conn.app_id]: { connected: true, account: label ?? undefined, at: new Date() } } } }, result: null };
  });
  // The mailbox owner's address is who "me" is in this workspace's mail.
  if (app.kind === 'mail' && conn.purpose === 'primary' && label) {
    await withWorkspace({ workspaceId: ctx.workspaceId }, (tx) => tx.query('update workspace set owner_email = $2 where id = $1', [ctx.workspaceId, label]));
  }
  return { ...conn, status: 'active', account_label: label };
}

export async function disconnect(ctx: Ctx, appId: string): Promise<void> {
  if (!ctx.rules.connect) throw new ConnectError('Your role can’t disconnect apps in this workspace.', 403);
  const conns = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query(`select * from connection where workspace_id = $1 and app_id = $2 and status in ('active', 'pending')`, [ctx.workspaceId, appId])).rows as ConnectionRow[]);
  for (const conn of conns) {
    const triggers = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query('delete from trigger_instance where connection_id = $1 returning id', [conn.id])).rows as { id: string }[]);
    for (const t of triggers) await composio().deleteTrigger(t.id).catch(() => {});
    if (conn.connected_account_id) await composio().disconnect(conn.connected_account_id).catch((e) => log.warn('disconnect failed at the provider', { error: (e as Error).message }));
  }
  await mutate(ctx.workspaceId, 'connect', async (tx, loaded) => {
    await tx.query(`update connection set status = 'disconnected', disconnected_at = now(), updated_at = now() where workspace_id = $1 and app_id = $2 and status in ('active', 'pending')`, [ctx.workspaceId, appId]);
    await audit(tx, ctx.workspaceId, { actor: ctx.user.id, action: 'connection.removed', detail: { app: appId } });
    const s = loaded.state;
    return { state: { ...s, conn: { ...s.conn, apps: { ...s.conn.apps, [appId]: { connected: false } } } }, result: null };
  });
}
