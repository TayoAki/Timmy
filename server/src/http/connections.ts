/**
 * Connecting apps: the connect flow a person goes through, and the signed events the provider sends about the
 * accounts once they are connected. Each event only queues work (reading a thread, a calendar or a list of files);
 * the work itself runs in jobs.
 */
import type { Hono } from 'hono';
import { config } from '../config';
import { sysPool } from '../db/pool';
import { enqueueSoon } from '../jobs/jobs';
import { log } from '../lib/log';
import { composio, composioReady, fakeComposio } from '../providers/composio';
import { calendarFor } from '../sync/calendars';
import { TOOLKITS, disconnect, finishConnect, startConnect } from '../sync/connect';
import { fileEvent } from '../sync/file-sources';
import { mailboxFor } from '../sync/mailbox';
import { ctxOf, requireWorkspace, type Env } from './session';

/**
 * The provider's events. Webhooks are signed by their sender; they carry no session and skip the same-origin
 * check, so this is mounted ahead of that check (see buildApp).
 */
export function connectionEventRoutes(app: Hono<Env>): void {
  app.post('/api/hooks/composio', async (c) => {
    const raw = await c.req.text();
    const secret = config.composio.webhookSecret || fakeComposio()?.secret || (await storedSecret('composio_webhook_secret'));
    let event;
    try {
      event = composio().parseWebhook(c.req.raw.headers, raw, secret);
    } catch (e) {
      log.warn('rejected webhook', { error: (e as Error).message });
      return c.json({ error: 'bad signature' }, 401);
    }
    // The connected account tells us whose event this is. An unknown account is acknowledged and dropped.
    const { rows } = await sysPool.query(`select id, workspace_id, toolkit from connection where connected_account_id = $1 and status = 'active'`, [event.connectedAccountId]);
    const conn = rows[0] as { id: string; workspace_id: string; toolkit: string } | undefined;
    const fresh = await sysPool.query(
      `insert into webhook_event (id, source, connected_account_id, workspace_id, payload) values ($1, 'composio', $2, $3, $4::jsonb) on conflict (id) do nothing returning id`,
      [event.id, event.connectedAccountId, conn?.workspace_id ?? null, raw.replace(/\\u0000/g, '')],
    );
    if (!fresh.rows[0] || !conn) return c.json({ ok: true, duplicate: !fresh.rows[0] });
    const box = mailboxFor(conn.toolkit);
    const threadKey = box?.threadKeyOf(event.data) ?? '';
    if (box && threadKey) enqueueSoon('mail.ingest', { workspaceId: conn.workspace_id, connectionId: conn.id, threadKey, seed: event.data });
    // Any calendar event means the window may have changed; one sync per connection covers a burst of them.
    // An Outlook account announces mail and calendar events alike, so its calendar is asked which this one is.
    if (calendarFor(conn.toolkit)?.announces(event.triggerSlug)) enqueueSoon('calendar.sync', { workspaceId: conn.workspace_id, connectionId: conn.id }, { singletonKey: `cal:${conn.id}` });
    // Drive and OneDrive: a file thrown away leaves the list at once. Anything else means "the list changed": one pass per connection covers a burst.
    const fileJob = fileEvent(conn.toolkit, event.triggerSlug, event.data);
    if (fileJob && 'remove' in fileJob) enqueueSoon('files.remove', { workspaceId: conn.workspace_id, connectionId: conn.id, fileId: fileJob.remove });
    else if (fileJob) enqueueSoon('files.sync', { workspaceId: conn.workspace_id, connectionId: conn.id }, { singletonKey: `files:${conn.id}` });
    await sysPool.query('update webhook_event set processed_at = now() where id = $1', [event.id]);
    return c.json({ ok: true });
  });
}

export function connectionRoutes(app: Hono<Env>): void {
  app.post('/api/v1/connections/:app/connect', requireWorkspace, async (c) => {
    if (!composioReady()) return c.json({ error: 'App connections aren’t configured on this server yet.' }, 503);
    return c.json(await startConnect(ctxOf(c), c.req.param('app')));
  });

  app.get('/api/v1/connections/callback', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    const conn = await finishConnect(ctx, String(c.req.query('c') ?? ''));
    if (!conn || conn.status !== 'active') return c.redirect(`/?connect=failed${conn ? `&app=${conn.app_id}` : ''}`);
    // The first sync is queued once, when the connection has just become active; opening the link again queues nothing.
    if (!conn.justConnected) return c.redirect(`/?connect=ok&app=${conn.app_id}`);
    if (TOOLKITS[conn.app_id]?.kind === 'mail') enqueueSoon('mail.backfill', { workspaceId: ctx.workspaceId, connectionId: conn.id, days: config.backfillFastDays }, { singletonKey: `bf:${conn.id}` });
    // An Outlook account is a mailbox and a calendar at once: both are read.
    if (calendarFor(conn.toolkit)) enqueueSoon('calendar.sync', { workspaceId: ctx.workspaceId, connectionId: conn.id }, { singletonKey: `cal:${conn.id}` });
    if (TOOLKITS[conn.app_id]?.kind === 'files') enqueueSoon('files.sync', { workspaceId: ctx.workspaceId, connectionId: conn.id }, { singletonKey: `files:${conn.id}` });
    return c.redirect(`/?connect=ok&app=${conn.app_id}`);
  });

  app.post('/api/v1/connections/:app/disconnect', requireWorkspace, async (c) => {
    await disconnect(ctxOf(c), c.req.param('app'));
    return c.json({ ok: true });
  });
}

async function storedSecret(name: string): Promise<string> {
  const { rows } = await sysPool.query('select value from app_secret where name = $1', [name]);
  return (rows[0]?.value as string | undefined) ?? '';
}
