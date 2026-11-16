/**
 * App connections. Every connection is a Composio connected account: the
 * person presses Connect, signs in on Composio's page, and comes back here.
 * Timmy never sees a password or a token.
 */
import { config } from '../config';
import { withWorkspace } from '../db/pool';
import { audit } from '../gateway/gateway';
import { enqueueSoon } from '../jobs/jobs';
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
const MAIL_APPS = Object.keys(TOOLKITS).filter((id) => TOOLKITS[id]!.kind === 'mail');

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
  if (app.kind === 'mail' && purpose === 'primary') {
    // One everyday mailbox per workspace: it is who "me" is, and every send says which mailbox it leaves from.
    const other = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query(`select account_label from connection where workspace_id = $1 and status = 'active' and purpose = 'primary' and app_id = any($2::text[]) limit 1`, [ctx.workspaceId, MAIL_APPS])).rows[0]);
    if (other) throw new ConnectError(`This workspace’s mailbox is ${other.account_label ?? 'already connected'}. Disconnect it before connecting another.`, 409);
  }
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
 * The person came back from the connect page. Only the person who started a
 * connection can finish it, and only a pending one: a connection that was
 * disconnected or failed is never switched back on from here. Whether the
 * account is really active is asked of Composio; the redirect's own query
 * string is not trusted.
 */
export async function finishConnect(ctx: Ctx, connectionId: string): Promise<ConnectionRow | null> {
  const conn = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => ((await tx.query('select * from connection where id = $1 and workspace_id = $2', [connectionId, ctx.workspaceId])).rows[0] as ConnectionRow | undefined) ?? null);
  if (!conn || !conn.connected_account_id) return null;
  if (conn.status === 'active') return conn;
  if (conn.status !== 'pending' || conn.user_id !== ctx.user.id || !ctx.rules.connect) return { ...conn, status: 'failed' };

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
    if (over) await withWorkspace({ workspaceId: ctx.workspaceId }, (tx) => tx.query(`update connection set status = 'failed', updated_at = now() where id = $1 and status = 'pending'`, [connectionId]));
    return { ...conn, status: over ? 'failed' : 'pending' };
  }
  const won = await withWorkspace({ workspaceId: ctx.workspaceId }, (tx) => tx.query(`update connection set status = 'active', updated_at = now() where id = $1 and status = 'pending'`, [connectionId]));
  if (!won.rowCount) return { ...conn, status: 'failed' };

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

/**
 * Stops using a set of the workspace's connections: all of them, one app's, or
 * one member's. They are marked disconnected here first, so nothing more is
 * read or sent through them whatever the provider answers. Removing them at
 * the provider is then retried by a job until it succeeds.
 */
export async function closeConnections(workspaceId: string, filter: { appId?: string; userId?: string }, actor: string): Promise<number> {
  const closed = await mutate(workspaceId, 'connect', async (tx, loaded) => {
    const { rows } = await tx.query(
      `update connection set status = 'disconnected', disconnected_at = now(), updated_at = now()
       where workspace_id = $1 and status in ('active', 'pending') and ($2::text is null or app_id = $2) and ($3::text is null or user_id = $3)
       returning id, app_id, purpose, connected_account_id`,
      [workspaceId, filter.appId ?? null, filter.userId ?? null],
    );
    const list = rows as { id: string; app_id: string; purpose: string; connected_account_id: string | null }[];
    if (!list.length) return { result: [] as { account: string | null; triggers: string[] }[] };
    const out: { account: string | null; triggers: string[] }[] = [];
    for (const c of list) {
      const triggers = (await tx.query('delete from trigger_instance where connection_id = $1 returning id', [c.id])).rows.map((r) => r.id as string);
      out.push({ account: c.connected_account_id, triggers });
      await audit(tx, workspaceId, { actor, action: 'connection.removed', detail: { app: c.app_id, connectionId: c.id } });
    }
    const apps = { ...loaded.state.conn.apps };
    for (const c of list) if (c.purpose === 'primary') apps[c.app_id] = { connected: false };
    return { state: { ...loaded.state, conn: { ...loaded.state.conn, apps } }, result: out };
  });
  for (const c of closed) enqueueSoon('connection.revoke', { connectedAccountId: c.account, triggers: c.triggers });
  return closed.length;
}

/** Removes an account and its triggers at the provider. Throws when the provider refuses, so the job is retried. */
export async function revokeAtProvider(connectedAccountId: string | null, triggers: string[]): Promise<void> {
  for (const t of triggers) await composio().deleteTrigger(t).catch((e) => log.warn('could not delete a trigger at the provider', { error: (e as Error).message }));
  if (connectedAccountId) await composio().disconnect(connectedAccountId);
}

export async function disconnect(ctx: Ctx, appId: string): Promise<void> {
  if (!ctx.rules.connect) throw new ConnectError('Your role can’t disconnect apps in this workspace.', 403);
  await closeConnections(ctx.workspaceId, { appId }, ctx.user.id);
}
