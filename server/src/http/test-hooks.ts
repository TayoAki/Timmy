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
import { fakeComposio, signWebhook, type FakeEvent } from '../providers/composio';
import { fakeFileEvent } from '../providers/fake-files';
import { CALENDAR_TOOLKITS } from '../sync/calendars';
import { MAIL_TOOLKITS } from '../sync/mailbox';
import { checkMailbox } from '../sync/mailbox-check';
import { lastMailTo } from '../providers/email';
import { ctxOf, requireWorkspace, type Env } from './session';
import { pageTestRoutes } from '../pages/routes';
import { chatTestRoutes } from '../chat/test-hooks';

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
  chatTestRoutes(app);

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
    // What the stand-in calendar (Google's or Outlook's) holds for this workspace, so a test can see what was created,
    // changed or deleted there, and who was told. `calendar-event` puts an event on it, as if made in the calendar itself,
    // and has the provider announce it.
    if (body.op === 'calendar' || body.op === 'calendar-event') {
      const cal = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query(`select connected_account_id, toolkit from connection where workspace_id = $1 and status = 'active' and toolkit = any($2::text[]) order by created_at limit 1`, [ctx.workspaceId, CALENDAR_TOOLKITS])).rows[0]);
      const account = cal ? fake.accounts.get(cal.connected_account_id) : undefined;
      if (body.op === 'calendar') return c.json({ events: account?.events ?? [], notices: account?.notices ?? [] });
      if (!cal || !account) return c.json({ error: 'no connected calendar' }, 409);
      const event = body.event as FakeEvent;
      account.events = [...account.events.filter((e) => e.id !== event.id), event];
      const said = fake.event(cal.connected_account_id, cal.toolkit === 'outlook' ? 'OUTLOOK_EVENT_CHANGE_TRIGGER' : 'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER', cal.toolkit === 'outlook' ? { event_type: 'created', id: event.id } : { event_type: 'created', event_id: event.id });
      const res = await app.request('/api/hooks/composio', { method: 'POST', headers: said.webhook.headers, body: said.webhook.body });
      await inlineJobs()?.drain('calendar.sync');
      return c.json({ ok: res.ok });
    }
    // The stand-in Drive (or OneDrive, with `app: 'onedrive'`): a file is made, changed or thrown away there, and the provider announces it.
    if (body.op === 'file' || body.op === 'file-trash') {
      const appId = body.app === 'onedrive' ? 'onedrive' : 'gdrive';
      const drive = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query(`select connected_account_id from connection where workspace_id = $1 and status = 'active' and app_id = $2 order by created_at limit 1`, [ctx.workspaceId, appId])).rows[0]);
      if (!drive) return c.json({ error: appId === 'onedrive' ? 'no connected OneDrive' : 'no connected Drive' }, 409);
      const event = fakeFileEvent(fake, drive.connected_account_id, appId, body.op === 'file' ? { add: body.file as { name: string } } : { trash: String(body.name) });
      if (!event) return c.json({ error: 'no such file' }, 404);
      const res = await app.request('/api/hooks/composio', { method: 'POST', headers: event.headers, body: event.body });
      await inlineJobs()?.drain();
      // The list is brought up to date by a job. The hook answers once the file is on it (or off it), so a test can go straight on.
      // A new file with words in it is also waited for until those words can be searched.
      const wanted = body.op === 'file';
      const name = String(body.op === 'file' ? (body.file as { name: string }).name : body.name);
      const words = wanted && !!((body.file as { text?: string; rows?: unknown[] }).text || (body.file as { rows?: unknown[] }).rows);
      let listed = !wanted;
      for (let i = 0; i < 100 && listed !== wanted; i++) {
        listed = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query(`select 1 from item i ${words ? 'join item_body b on b.item_id = i.id' : ''} where i.workspace_id = $1 and i.kind = 'file' and i.subject = $2 limit 1`, [ctx.workspaceId, name])).rows.length > 0);
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
    // The person does something to a thread in their own mail app: takes it out of the inbox, puts a label on it,
    // reads it, deletes it. `add` and `remove` are label words (INBOX, UNREAD, TRASH, …) or the names of labels;
    // `categories`, for Outlook, replaces the categories on the thread's messages.
    if (body.op === 'in-mailbox') {
      const box = fake.accounts.get(conn.connected_account_id)!;
      const idOf = (name: string) => {
        if (/^[A-Z_]+$/.test(name)) return name;
        // A label the person made by hand gets an id the way Gmail gives one.
        if (!box.labels.has(name)) box.labels.set(name, `Label_${box.labels.size + 1}`);
        return box.labels.get(name)!;
      };
      const add = ((body.add as string[] | undefined) ?? []).map(idOf);
      const remove = ((body.remove as string[] | undefined) ?? []).map(idOf);
      const touched = box.messages.filter((m) => m.subject.replace(/^Re: /, '') === String(body.subject));
      for (const m of touched) {
        m.labels = [...new Set([...m.labels.filter((l) => !remove.includes(l)), ...add])];
        if (Array.isArray(body.categories)) m.categories = (body.categories as string[]).map(String);
      }
      return c.json({ ok: touched.length > 0 });
    }
    // Looks at the mailbox for what the person changed there, now, instead of waiting for the next scheduled look.
    if (body.op === 'check-mailbox') return c.json({ checked: await checkMailbox(ctx.workspaceId, conn.id) });
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
