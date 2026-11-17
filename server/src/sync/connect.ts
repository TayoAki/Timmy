/**
 * App connections. Every connection is a Composio connected account: the
 * person presses Connect, signs in on Composio's page, and comes back here.
 * Timmy never sees a password or a token.
 */
import { forgetFromHistory } from '../state/forget';
import type { ConnectableApp } from '../../../src/live/connectable';
import { config } from '../config';
import { withWorkspace } from '../db/pool';
import { audit } from '../gateway/gateway';
import { enqueueSoon } from '../jobs/jobs';
import { newId } from '../lib/ids';
import { log } from '../lib/log';
import { composio } from '../providers/composio';
import type { Ctx } from '../state/engine';
import { mutate } from '../state/mutate';
import { shownPrefixes } from './calendars';
import { driveAddress } from './files';
import { mailboxFor } from './mailbox';
import { meter, type ConnectionRow } from './tools';

/**
 * The apps that can be connected, by the frontend's app id, with the Composio toolkit behind each.
 * An app is listed here only once Timmy reads it or acts through it: a connection that does nothing would be a false promise.
 */
const CONNECT: Record<ConnectableApp, { toolkit: string; kind: 'mail' | 'calendar' | 'files'; triggers: { slug: string; config?: Record<string, unknown> }[] }> = {
  // New mail in the inbox, and mail the person sent themselves (how Timmy learns a hand-sent cold email went out).
  gmail: { toolkit: 'gmail', kind: 'mail', triggers: [{ slug: 'GMAIL_NEW_GMAIL_MESSAGE', config: { labelIds: 'INBOX' } }, { slug: 'GMAIL_EMAIL_SENT_TRIGGER' }] },
  gcal: { toolkit: 'googlecalendar', kind: 'calendar', triggers: [{ slug: 'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER', config: { calendarId: 'primary' } }] },
  // The same two events as Gmail: mail arriving in the inbox, and mail leaving through Sent Items. An Outlook account is
  // also a calendar, so it announces a third: an event made, changed or deleted there.
  outlook: { toolkit: 'outlook', kind: 'mail', triggers: [{ slug: 'OUTLOOK_MESSAGE_TRIGGER' }, { slug: 'OUTLOOK_SENT_MESSAGE_TRIGGER' }, { slug: 'OUTLOOK_EVENT_CHANGE_TRIGGER' }] },
  // A file made, changed, or thrown away. Drive is checked every couple of minutes by Composio rather than pushed.
  gdrive: { toolkit: 'googledrive', kind: 'files', triggers: [{ slug: 'GOOGLEDRIVE_FILE_CREATED_TRIGGER' }, { slug: 'GOOGLEDRIVE_FILE_UPDATED_TRIGGER' }, { slug: 'GOOGLEDRIVE_FILE_DELETED_OR_TRASHED_TRIGGER' }] },
};
export const TOOLKITS: Record<string, (typeof CONNECT)[ConnectableApp] | undefined> = CONNECT;
const MAIL_APPS = Object.entries(CONNECT).filter(([, app]) => app.kind === 'mail').map(([id]) => id);

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
export async function startConnect(ctx: Ctx, appId: string): Promise<{ redirectUrl: string; connectionId: string }> {
  const app = TOOLKITS[appId];
  if (!app) throw new ConnectError('That app can’t be connected yet.');
  if (!ctx.rules.connect) throw new ConnectError('Your role can’t connect apps in this workspace.', 403);
  if (app.kind === 'mail') {
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
      `insert into connection (id, workspace_id, user_id, app_id, toolkit, composio_user_id, connected_account_id, auth_config_id, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
      [id, ctx.workspaceId, ctx.user.id, appId, app.toolkit, composioUser(ctx), link.connectedAccountId, link.authConfigId],
    );
    await audit(tx, ctx.workspaceId, { actor: ctx.user.id, action: 'connection.started', detail: { app: appId, connectionId: id } });
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
export async function finishConnect(ctx: Ctx, connectionId: string): Promise<(ConnectionRow & { justConnected?: boolean }) | null> {
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
  const app = TOOLKITS[conn.app_id]!;
  // Two people can each start connecting a mailbox before either finishes. Only the first to finish becomes the
  // workspace's mailbox: the check is part of the same statement that activates it, and a unique index backs it.
  const won = await withWorkspace({ workspaceId: ctx.workspaceId, lock: true }, (tx) =>
    tx
      .query(
        `update connection set status = 'active', updated_at = now() where id = $1 and status = 'pending'
           and ($2::boolean is false or not exists (select 1 from connection o where o.workspace_id = connection.workspace_id and o.status = 'active' and o.app_id = any($3::text[]) and o.id <> connection.id))`,
        [connectionId, app.kind === 'mail', MAIL_APPS],
      )
      .then((r) => r.rowCount ?? 0)
      .catch((e: { code?: string }) => (e.code === '23505' ? 0 : Promise.reject(e))),
  );
  if (!won) {
    // Whatever the reason it lost, this account is not kept: it is marked failed here and removed at the provider.
    await withWorkspace({ workspaceId: ctx.workspaceId }, (tx) => tx.query(`update connection set status = 'failed', updated_at = now() where id = $1 and status = 'pending'`, [connectionId]));
    enqueueSoon('connection.revoke', { connectedAccountId: conn.connected_account_id, triggers: [] });
    return { ...conn, status: 'failed' };
  }

  // Which account this is, asked of the app itself: it is what the Connections screen shows, and for a mailbox it is who "me" is.
  let label = acct.label ?? null;
  const box = mailboxFor(conn.toolkit);
  if (box) label = (await box.address(ctx.workspaceId, connectionId)) ?? label;
  if (app.kind === 'files') label = (await driveAddress(ctx.workspaceId, connectionId)) ?? label;
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
    const s = loaded.state;
    return { state: { ...s, conn: { ...s.conn, apps: { ...s.conn.apps, [conn.app_id]: { connected: true, account: label ?? undefined, at: new Date() } } } }, result: null };
  });
  // The mailbox owner's address is who "me" is in this workspace's mail.
  if (app.kind === 'mail' && label) {
    await withWorkspace({ workspaceId: ctx.workspaceId }, (tx) => tx.query('update workspace set owner_email = $2 where id = $1', [ctx.workspaceId, label]));
  }
  return { ...conn, status: 'active', account_label: label, justConnected: true };
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
       returning id, app_id, connected_account_id`,
      [workspaceId, filter.appId ?? null, filter.userId ?? null],
    );
    const list = rows as { id: string; app_id: string; connected_account_id: string | null }[];
    if (!list.length) return { result: [] as { id: string; account: string | null; triggers: string[] }[] };
    const out: { id: string; account: string | null; triggers: string[] }[] = [];
    for (const c of list) {
      const triggers = (await tx.query('delete from trigger_instance where connection_id = $1 returning id', [c.id])).rows.map((r) => r.id as string);
      out.push({ id: c.id, account: c.connected_account_id, triggers });
      await audit(tx, workspaceId, { actor, action: 'connection.removed', detail: { app: c.app_id, connectionId: c.id } });
    }
    const apps = { ...loaded.state.conn.apps };
    for (const c of list) apps[c.app_id] = { connected: false };
    // What came from a disconnected account leaves the screens with it: its mail threads and its calendar events.
    const gone = new Set(list.map((c) => c.id));
    const eventPrefixes = list.flatMap((c) => shownPrefixes(c.id));
    const threads = loaded.state.threads.filter((t) => !t.ext?.connectionId || !gone.has(t.ext.connectionId));
    const events = Object.fromEntries(Object.entries(loaded.state.ws.events).filter(([id]) => !eventPrefixes.some((p) => id.startsWith(p))));
    // A lead's reply is also copied into the Unibox, under "gm-<message>-<lead>". Those copies go with the mailbox.
    const fromThere = new Set(
      (await tx.query(`select external_id from item where workspace_id = $1 and connection_id = any($2::text[]) and kind = 'message'`, [workspaceId, [...gone]])).rows.map((r) => r.external_id as string),
    );
    const copied = (m: { id: string; lead: string }) => m.id.startsWith('gm-') && m.id.endsWith(`-${m.lead}`) && fromThere.has(m.id.slice(3, m.id.length - m.lead.length - 1));
    const messages = loaded.state.out.messages.filter((m) => !copied(m));
    // And out of the workspace's history: what tabs catch up from, and what Undo would put back.
    await forgetFromHistory(tx, workspaceId, [
      { s: 'threads', ids: loaded.state.threads.filter((t) => !threads.includes(t)).map((t) => t.id) },
      { s: 'ws.events', ids: Object.keys(loaded.state.ws.events).filter((id) => !Object.hasOwn(events, id)) },
      { s: 'out.messages', ids: loaded.state.out.messages.filter(copied).map((m) => m.id) },
    ]);
    // The transcripts of Ask's finished runs can hold what its searches found in that mailbox. They are only kept to
    // resume a run that is waiting, so a finished one's go now.
    await tx.query(`delete from run_checkpoint where workspace_id = $1 and run_id in (select id from run where workspace_id = $1 and status in ('completed', 'failed', 'cancelled'))`, [workspaceId]);
    return { state: { ...loaded.state, threads, ws: { ...loaded.state.ws, events }, out: { ...loaded.state.out, messages }, conn: { ...loaded.state.conn, apps } }, result: out };
  });
  for (const c of closed) {
    enqueueSoon('connection.revoke', { connectedAccountId: c.account, triggers: c.triggers });
    // The stored copy of its mail and events is deleted by a job, so a large mailbox doesn't hold the request.
    enqueueSoon('connection.purge', { workspaceId, connectionId: c.id }, { singletonKey: `purge:${c.id}` });
  }
  return closed.length;
}

/**
 * Deletes everything synced through a connection that is no longer in use: messages, their bodies, events and
 * sync positions. Runs in batches and returns how many items went. A connection that is active is never touched.
 */
export async function purgeConnection(workspaceId: string, connectionId: string, batch = 2000): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await withWorkspace({ workspaceId }, async (tx) => {
      const { rowCount } = await tx.query(
        `delete from item where id in (
           select i.id from item i join connection c on c.id = i.connection_id
           where i.workspace_id = $1 and i.connection_id = $2 and c.status <> 'active' limit $3)`,
        [workspaceId, connectionId, batch],
      );
      return rowCount ?? 0;
    });
    total += n;
    if (n < batch) break;
  }
  await withWorkspace({ workspaceId }, (tx) => tx.query(`delete from sync_cursor where connection_id = $1 and exists (select 1 from connection c where c.id = $1 and c.status <> 'active')`, [connectionId]));
  // What the mailbox last showed for each thread (kept to pick up changes made there) goes with the mail.
  await withWorkspace({ workspaceId }, (tx) => tx.query(`delete from mailbox_seen where connection_id = $1 and exists (select 1 from connection c where c.id = $1 and c.status <> 'active')`, [connectionId]));
  // And what each of its messages carried when first seen.
  await withWorkspace({ workspaceId }, (tx) => tx.query(`delete from mailbox_message_seen where connection_id = $1 and exists (select 1 from connection c where c.id = $1 and c.status <> 'active')`, [connectionId]));
  return total;
}

/** Removes an account and its triggers at the provider. Throws when the provider refuses, so the job is retried. */
export async function revokeAtProvider(connectedAccountId: string | null, triggers: string[]): Promise<void> {
  for (const t of triggers) await composio().deleteTrigger(t).catch((e) => log.warn('could not delete a trigger at the provider', { error: (e as Error).message }));
  if (connectedAccountId) await composio().disconnect(connectedAccountId);
}

export async function disconnect(ctx: Ctx, appId: string): Promise<void> {
  if (!ctx.rules.connect) throw new ConnectError('Your role can’t disconnect apps in this workspace.', 403);
  // An owner or admin may disconnect anything; everyone else only what they connected themselves.
  const closed = await closeConnections(ctx.workspaceId, { appId, ...(ctx.rules.policy ? {} : { userId: ctx.user.id }) }, ctx.user.id);
  if (!closed && !ctx.rules.policy) {
    const others = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query(`select 1 from connection where workspace_id = $1 and app_id = $2 and status in ('active', 'pending') limit 1`, [ctx.workspaceId, appId])).rows.length);
    if (others) throw new ConnectError('Someone else connected this. They, or an owner or admin, can disconnect it.', 403);
  }
}

/**
 * Connections whose person is no longer in the workspace. Leaving and being removed both close them at once;
 * this catches any other way a membership can end. Returns how many were closed.
 */
export async function closeOrphanedConnections(sys: { query: (text: string) => Promise<{ rows: Record<string, unknown>[] }> }): Promise<number> {
  const { rows } = await sys.query(
    `select distinct c.workspace_id, c.user_id from connection c
     where c.status in ('active', 'pending') and not exists (select 1 from auth.member m where m."organizationId" = c.workspace_id and m."userId" = c.user_id)`,
  );
  let closed = 0;
  for (const r of rows) closed += await closeConnections(r.workspace_id as string, { userId: r.user_id as string }, 'system');
  return closed;
}
