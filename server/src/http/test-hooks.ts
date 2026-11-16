/**
 * Routes that exist only so tests can drive the stand-in providers and read the mail outbox.
 * They are mounted only when test hooks are on, which the config refuses in production.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import { morningRun } from '../agent/morning';
import { config, isLocal } from '../config';
import { withWorkspace } from '../db/pool';
import { executeEffect } from '../gateway/gateway';
import { inlineJobs } from '../jobs/jobs';
import { fakeComposio, signWebhook } from '../providers/composio';
import { MAIL_TOOLKITS } from '../sync/mailbox';
import { lastMailTo } from '../providers/email';
import { ctxOf, requireWorkspace, type Env } from './session';
import { pageTestRoutes } from '../pages/routes';

export function testRoutes(app: Hono<Env>): void {
  // On a deployed server (staging) the hooks need the test token. The one exception is the page that stands in
  // for the provider's consent screen, which a browser opens by navigation and which only returns to our own callback.
  app.use('/api/test/*', async (c, next) => {
    if (!isLocal() && !c.req.path.endsWith('/fake-connect')) {
      const given = Buffer.from(c.req.header('x-test-token') ?? '');
      const want = Buffer.from(config.testToken);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return c.json({ error: 'Not found' }, 404);
    }
    await next();
  });

  pageTestRoutes(app);

  app.get('/api/test/outbox', async (c) => c.json({ mail: await lastMailTo(String(c.req.query('to') ?? '')) }));

  // Stands in for the provider's consent screen when the fake provider is on.
  app.get('/api/test/fake-connect', (c) => {
    const fake = fakeComposio();
    if (!fake) return c.json({ error: 'the fake provider is off' }, 404);
    const to = String(c.req.query('to') ?? '');
    if (!to.startsWith(`${config.publicUrl}/api/v1/connections/callback?`)) return c.json({ error: 'Not found' }, 404);
    fake.completeConnect(String(c.req.query('account')));
    return c.redirect(to);
  });

  app.post('/api/test/fake', requireWorkspace, async (c) => {
    const fake = fakeComposio();
    if (!fake) return c.json({ error: 'the fake provider is off' }, 404);
    const ctx = ctxOf(c);
    const body = (await c.req.json()) as { op: string; [k: string]: unknown };
    const conn = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query(`select id, connected_account_id, toolkit from connection where workspace_id = $1 and status = 'active' and toolkit = any($2::text[]) order by created_at limit 1`, [ctx.workspaceId, MAIL_TOOLKITS])).rows[0]);
    if (body.op === 'address') {
      fake.nextAddress = String(body.address);
      return c.json({ ok: true });
    }
    // What the stand-in Google Calendar holds for this workspace, so a test can see what was created and who was invited.
    if (body.op === 'calendar') {
      const cal = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query(`select connected_account_id from connection where workspace_id = $1 and status = 'active' and app_id = 'gcal' order by created_at limit 1`, [ctx.workspaceId])).rows[0]);
      return c.json({ events: cal ? (fake.accounts.get(cal.connected_account_id)?.events ?? []) : [] });
    }
    // The stand-in Drive: a file is made, changed or thrown away there, and the provider announces it.
    if (body.op === 'file' || body.op === 'file-trash') {
      const drive = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query(`select connected_account_id from connection where workspace_id = $1 and status = 'active' and app_id = 'gdrive' order by created_at limit 1`, [ctx.workspaceId])).rows[0]);
      if (!drive) return c.json({ error: 'no connected Drive' }, 409);
      const account = fake.accounts.get(drive.connected_account_id)!;
      let event;
      if (body.op === 'file') {
        const file = fake.addFile(drive.connected_account_id, body.file as { name: string });
        event = fake.event(drive.connected_account_id, 'GOOGLEDRIVE_FILE_CREATED_TRIGGER', { event_type: 'created', file: { id: file.id, name: file.name } });
      } else {
        const file = account.files.find((f) => f.name === String(body.name));
        if (!file) return c.json({ error: 'no such file' }, 404);
        file.trashed = true;
        event = fake.event(drive.connected_account_id, 'GOOGLEDRIVE_FILE_DELETED_OR_TRASHED_TRIGGER', { event_type: 'trashed', file_id: file.id, name: file.name });
      }
      const res = await app.request('/api/hooks/composio', { method: 'POST', headers: event.webhook.headers, body: event.webhook.body });
      await inlineJobs()?.drain();
      // The list is brought up to date by a job. The hook answers once the file is on it (or off it), so a test can go straight on.
      const wanted = body.op === 'file';
      const name = String(body.op === 'file' ? (body.file as { name: string }).name : body.name);
      let listed = !wanted;
      for (let i = 0; i < 40 && listed !== wanted; i++) {
        listed = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query(`select 1 from item where workspace_id = $1 and kind = 'file' and subject = $2 limit 1`, [ctx.workspaceId, name])).rows.length > 0);
        if (listed !== wanted) await new Promise((r) => setTimeout(r, 150));
      }
      return c.json({ ok: res.ok && listed === wanted });
    }
    if (!conn) return c.json({ error: 'no connected mailbox' }, 409);
    if (body.op === 'deliver') {
      const d = fake.deliver(conn.connected_account_id, body.message as { from: string; subject: string; body: string });
      const res = await app.request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
      await inlineJobs()?.drain('mail.ingest');
      return c.json({ ok: res.ok, message: d.message });
    }
    if (body.op === 'sent') return c.json({ sent: fake.sent(conn.connected_account_id) });
    // The labels each thread carries in the stand-in mailbox, by name, so a test can see what was filed.
    if (body.op === 'labels') {
      const box = fake.accounts.get(conn.connected_account_id)!;
      const names = new Map([...box.labels].map(([name, id]) => [id, name]));
      const threads: Record<string, string[]> = {};
      // An Outlook message's categories are listed with its folder, the way a Gmail message's labels are.
      for (const m of box.messages) threads[m.subject] = [...new Set([...(threads[m.subject] ?? []), ...m.labels.map((l) => names.get(l) ?? l), ...(m.categories ?? [])])].sort();
      return c.json({ threads });
    }
    // The person sent an email themselves, from their mail app: it appears in Sent and the provider announces it.
    if (body.op === 'sent-by-hand') {
      const m = body.message as { to: string; subject: string; body: string };
      const box = fake.accounts.get(conn.connected_account_id)!;
      const id = `hand-${Date.now().toString(36)}`;
      box.messages.push({ id, threadId: `th-${id}`, from: box.address, to: [m.to], subject: m.subject, body: m.body, at: new Date(), labels: ['SENT'] });
      const sent = conn.toolkit === 'outlook' ? fake.event(conn.connected_account_id, 'OUTLOOK_SENT_MESSAGE_TRIGGER', { event_type: 'created', id: `mutable-${id}`, message: { id: `mutable-${id}`, conversation_id: `th-${id}` } }) : fake.event(conn.connected_account_id, 'GMAIL_EMAIL_SENT_TRIGGER', { thread_id: `th-${id}`, message_id: id });
      const res = await app.request('/api/hooks/composio', { method: 'POST', headers: sent.webhook.headers, body: sent.webhook.body });
      await inlineJobs()?.drain('mail.ingest');
      return c.json({ ok: res.ok });
    }
    if (body.op === 'fail') {
      fake.failNext.set(String(body.slug), body.mode as 'error');
      return c.json({ ok: true });
    }
    return c.json({ error: 'unknown op' }, 400);
  });

  // Lets a test start the workspace's morning run now instead of waiting for its scheduled time.
  app.post('/api/test/morning-run', requireWorkspace, async (c) => {
    const run = await morningRun(ctxOf(c).workspaceId);
    await inlineJobs()?.drain();
    return c.json({ run });
  });

  // Lets a test end the undo window now instead of waiting it out.
  app.post('/api/test/release-holds', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    const ids = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query(`update effect set hold_until = now() where workspace_id = $1 and status = 'approved' returning id`, [ctx.workspaceId])).rows as { id: string }[]);
    for (const { id } of ids) await executeEffect(ctx.workspaceId, id);
    return c.json({ ran: ids.length });
  });
}
