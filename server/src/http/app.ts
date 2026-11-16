import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { auth } from '../auth/auth';
import { timingSafeEqual } from 'node:crypto';
import { MODEL_ALLOWLIST, config, isLocal, modelFor } from '../config';
import { sysPool, withWorkspace } from '../db/pool';
import { audit } from '../gateway/gateway';
import { enqueueSoon, inlineJobs } from '../jobs/jobs';
import { log } from '../lib/log';
import { composio, composioReady, fakeComposio, signWebhook } from '../providers/composio';
import { lastMailTo } from '../providers/email';
import { modelReady } from '../providers/model';
import { runCommand } from '../state/engine';
import { stillAllowed, subscribe, type Subscriber } from '../state/hub';
import { rulesFor } from '../auth/roles';
import { loadState } from '../state/docs';
import { ConnectError, TOOLKITS, disconnect, finishConnect, startConnect } from '../sync/connect';
import { pickSlices, toWire } from '../../../src/live/patches';
import type { Action } from '../../../src/state/store';
import { agentRoutes } from './agent';
import { ctxOf, membership, requireSession, requireWorkspace, sameOrigin, sessionOf, workspacesOf, type Env } from './session';

const wire = (body: unknown, status = 200) => new Response(toWire(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export function buildApp(): Hono<Env> {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof ConnectError) return c.json({ error: err.message }, err.status as 400);
    log.error('request failed', { path: c.req.path, error: err.message, stack: err.stack });
    return c.json({ error: 'Something went wrong on our side.' }, 500);
  });

  app.get('/api/health', (c) => c.json({ ok: true, stage: config.stage, composio: composioReady(), model: modelReady(), fake: config.fakeProviders }));

  // Webhooks are signed by their sender; they carry no session and skip the same-origin check.
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
    const threadKey = String(event.data.thread_id ?? event.data.threadId ?? '');
    if (conn.toolkit === 'gmail' && threadKey) enqueueSoon('mail.ingest', { workspaceId: conn.workspace_id, connectionId: conn.id, threadKey, seed: event.data });
    // Any calendar event means the window may have changed; one sync per connection covers a burst of them.
    if (conn.toolkit === 'googlecalendar') enqueueSoon('calendar.sync', { workspaceId: conn.workspace_id, connectionId: conn.id }, { singletonKey: `cal:${conn.id}` });
    await sysPool.query('update webhook_event set processed_at = now() where id = $1', [event.id]);
    return c.json({ ok: true });
  });

  app.use('/api/*', sameOrigin);
  app.all('/api/auth/*', (c) => auth().handler(c.req.raw));

  /* ───────────── Who am I ───────────── */

  app.get('/api/v1/me', requireSession, async (c) => {
    const s = c.get('session');
    const workspaces = await workspacesOf(s.user.id);
    const activeId = workspaces.some((w) => w.id === s.activeWorkspaceId) ? s.activeWorkspaceId : null;
    let active = null;
    if (activeId) {
      const role = workspaces.find((w) => w.id === activeId)!.role;
      const ws = await withWorkspace({ workspaceId: activeId }, async (tx) => (await tx.query('select id, name, trade, model_id, approval_mode from workspace where id = $1', [activeId])).rows[0]);
      if (ws) active = { id: ws.id, name: ws.name, trade: ws.trade, role, can: rulesFor(role), model: modelFor(ws.model_id), models: MODEL_ALLOWLIST, approvalMode: ws.approval_mode };
    }
    return c.json({ user: s.user, workspaces, active });
  });

  /* ───────────── State ───────────── */

  app.get('/api/v1/state', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.read) return c.json({ error: 'Your role can’t read this workspace.' }, 403);
    const loaded = await withWorkspace({ workspaceId: ctx.workspaceId, lock: true }, (tx) => loadState(tx, ctx.workspaceId));
    return wire({ rev: loaded.rev, slices: pickSlices(loaded.state), me: { name: loaded.workspace.owner_name, email: loaded.workspace.owner_email, company: loaded.workspace.name } });
  });

  app.post('/api/v1/commands', requireWorkspace, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { id?: string; action?: Action } | null;
    if (!body?.id || !body.action) return c.json({ error: 'A command needs an id and an action.' }, 400);
    // Dates in an action arrive as ISO strings; the reducer expects Dates.
    const { fromWire } = await import('../../../src/live/patches');
    const action = fromWire<Action>(JSON.stringify(body.action));
    return wire(await runCommand(ctxOf(c), { id: body.id, action }));
  });

  app.get('/api/v1/stream', requireWorkspace, (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.read) return c.json({ error: 'Your role can’t read this workspace.' }, 403);
    const rev = Number(c.req.query('rev') ?? 0);
    return streamSSE(c, async (stream) => {
      let open = true;
      const send = (event: string, data: unknown) => {
        if (open) void stream.writeSSE({ event, data: toWire(data) }).catch(() => (open = false));
      };
      // The person may sign out or be removed while the stream is open; it ends when either happens.
      const headers = c.req.raw.headers;
      const allowed = async () => {
        const s = await sessionOf(headers);
        return !!s && s.user.id === ctx.user.id && rulesFor(await membership(ctx.user.id, ctx.workspaceId)).read;
      };
      const sub: Subscriber = { workspaceId: ctx.workspaceId, rev, send, allowed, checkedAt: Date.now(), close: () => (open = false) };
      const off = subscribe(sub);
      stream.onAbort(() => {
        open = false;
        off();
      });
      send('hello', { rev });
      while (open) {
        await stream.sleep(15_000);
        sub.checkedAt = 0;
        if (!(await stillAllowed(sub))) break;
        send('ping', {});
      }
      off();
    });
  });

  /* ───────────── Settings: the model, approvals, limits ───────────── */

  app.get('/api/v1/settings', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.read) return c.json({ error: 'Your role can’t read this workspace.' }, 403);
    const ws = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query('select model_id, approval_mode, max_concurrent_runs, monthly_spend_cap_usd, kill_switch, timezone from workspace where id = $1', [ctx.workspaceId])).rows[0]);
    return c.json({ model: modelFor(ws.model_id), models: MODEL_ALLOWLIST, approvalMode: ws.approval_mode, maxConcurrentRuns: ws.max_concurrent_runs, monthlySpendCapUsd: ws.monthly_spend_cap_usd, killSwitch: ws.kill_switch, timezone: ws.timezone });
  });

  app.patch('/api/v1/settings', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.policy) return c.json({ error: 'Only an owner or admin can change this.' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { model?: string; approvalMode?: string; killSwitch?: boolean; timezone?: string };
    if (body.model !== undefined && !MODEL_ALLOWLIST.some((m) => m.id === body.model)) return c.json({ error: 'That model isn’t on the list.' }, 400);
    if (body.approvalMode !== undefined && body.approvalMode !== 'ask' && body.approvalMode !== 'auto') return c.json({ error: 'Approval mode is ask or auto.' }, 400);
    await withWorkspace({ workspaceId: ctx.workspaceId, userId: ctx.user.id }, async (tx) => {
      await tx.query(`update workspace set model_id = coalesce($2, model_id), approval_mode = coalesce($3, approval_mode), kill_switch = coalesce($4, kill_switch), timezone = coalesce($5, timezone) where id = $1`, [
        ctx.workspaceId,
        body.model ?? null,
        body.approvalMode ?? null,
        body.killSwitch ?? null,
        body.timezone ?? null,
      ]);
      await audit(tx, ctx.workspaceId, { actor: ctx.user.id, action: 'settings.changed', detail: body });
    });
    return c.json({ ok: true });
  });

  /* ───────────── Connections ───────────── */

  app.post('/api/v1/connections/:app/connect', requireWorkspace, async (c) => {
    if (!composioReady()) return c.json({ error: 'App connections aren’t configured on this server yet.' }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { purpose?: 'primary' | 'sending' };
    const out = await startConnect(ctxOf(c), c.req.param('app'), body.purpose === 'sending' ? 'sending' : 'primary');
    return c.json(out);
  });

  app.get('/api/v1/connections/callback', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    const conn = await finishConnect(ctx, String(c.req.query('c') ?? ''));
    if (!conn || conn.status !== 'active') return c.redirect(`/?connect=failed${conn ? `&app=${conn.app_id}` : ''}`);
    if (TOOLKITS[conn.app_id]?.kind === 'mail') enqueueSoon('mail.backfill', { workspaceId: ctx.workspaceId, connectionId: conn.id, days: config.backfillFastDays }, { singletonKey: `bf:${conn.id}` });
    if (TOOLKITS[conn.app_id]?.kind === 'calendar') enqueueSoon('calendar.sync', { workspaceId: ctx.workspaceId, connectionId: conn.id }, { singletonKey: `cal:${conn.id}` });
    return c.redirect(`/?connect=ok&app=${conn.app_id}`);
  });

  app.post('/api/v1/connections/:app/disconnect', requireWorkspace, async (c) => {
    await disconnect(ctxOf(c), c.req.param('app'));
    return c.json({ ok: true });
  });

  /* ───────────── The audit log, effects and usage ───────────── */

  app.get('/api/v1/audit', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.read) return c.json({ error: 'Your role can’t read this workspace.' }, 403);
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);
    const rows = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query('select id, at, actor, on_behalf_of, action, effect_id, run_id, detail from audit_log where workspace_id = $1 order by id desc limit $2', [ctx.workspaceId, limit])).rows);
    return c.json({ entries: rows });
  });

  app.get('/api/v1/effects/:id', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.read) return c.json({ error: 'Your role can’t read this workspace.' }, 403);
    const row = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query('select id, kind, status, target, source, requested_by, approved_by, approved_via, approver_route, hold_until, error, external_id, created_at, completed_at from effect where id = $1 and workspace_id = $2', [c.req.param('id'), ctx.workspaceId])).rows[0]);
    return row ? c.json(row) : c.json({ error: 'Not found' }, 404);
  });

  app.get('/api/v1/usage', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.read) return c.json({ error: 'Your role can’t read this workspace.' }, 403);
    const out = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => {
      const models = (await tx.query(`select route, model, count(*)::int as calls, sum(tokens_in)::int as tokens_in, sum(tokens_out)::int as tokens_out, sum(tokens_reasoning)::int as tokens_reasoning, sum(tokens_cached)::int as tokens_cached, sum(cost_usd)::float8 as cost_usd from usage_event where workspace_id = $1 and at >= date_trunc('month', now()) group by route, model order by route`, [ctx.workspaceId])).rows;
      const calls = (await tx.query(`select phase, count(*)::int as calls from provider_call where workspace_id = $1 and at >= date_trunc('month', now()) group by phase order by phase`, [ctx.workspaceId])).rows;
      return { models, composio: calls };
    });
    return c.json(out);
  });

  agentRoutes(app);

  /* ───────────── Test hooks ───────────── */

  if (config.testHooks) {
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
      const conn = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query(`select id, connected_account_id from connection where workspace_id = $1 and status = 'active' and app_id = 'gmail' order by created_at limit 1`, [ctx.workspaceId])).rows[0]);
      if (body.op === 'address') {
        fake.nextAddress = String(body.address);
        return c.json({ ok: true });
      }
      if (!conn) return c.json({ error: 'no connected mailbox' }, 409);
      if (body.op === 'deliver') {
        const d = fake.deliver(conn.connected_account_id, body.message as { from: string; subject: string; body: string });
        const res = await app.request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
        await inlineJobs()?.drain('mail.ingest');
        return c.json({ ok: res.ok, message: d.message });
      }
      if (body.op === 'sent') return c.json({ sent: fake.sent(conn.connected_account_id) });
      // The person sent an email themselves, from their mail app: it appears in Sent and the provider announces it.
      if (body.op === 'sent-by-hand') {
        const m = body.message as { to: string; subject: string; body: string };
        const box = fake.accounts.get(conn.connected_account_id)!;
        const id = `hand-${Date.now().toString(36)}`;
        box.messages.push({ id, threadId: `th-${id}`, from: box.address, to: [m.to], subject: m.subject, body: m.body, at: new Date(), labels: ['SENT'] });
        const payload = JSON.stringify({ id: `evt_${id}`, metadata: { trigger_slug: 'GMAIL_EMAIL_SENT_TRIGGER', connected_account_id: conn.connected_account_id, user_id: box.userId }, data: { thread_id: `th-${id}`, message_id: id } });
        const ts = String(Math.floor(Date.now() / 1000));
        const res = await app.request('/api/hooks/composio', { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': `wh_${id}`, 'webhook-timestamp': ts, 'webhook-signature': signWebhook(`wh_${id}`, ts, payload, fake.secret) }, body: payload });
        await inlineJobs()?.drain('mail.ingest');
        return c.json({ ok: res.ok });
      }
      if (body.op === 'fail') {
        fake.failNext.set(String(body.slug), body.mode as 'error');
        return c.json({ ok: true });
      }
      return c.json({ error: 'unknown op' }, 400);
    });

    // Lets a test end the undo window now instead of waiting it out.
    app.post('/api/test/release-holds', requireWorkspace, async (c) => {
      const ctx = ctxOf(c);
      const { executeEffect } = await import('../gateway/gateway');
      const ids = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query(`update effect set hold_until = now() where workspace_id = $1 and status = 'approved' returning id`, [ctx.workspaceId])).rows as { id: string }[]);
      for (const { id } of ids) await executeEffect(ctx.workspaceId, id);
      return c.json({ ran: ids.length });
    });
  }

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  /* ───────────── The app itself ───────────── */

  const dist = config.webDist ? resolve(config.webDist) : '';
  const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.wasmz': 'application/octet-stream', '.pdf': 'application/pdf', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json' };
  app.get('*', (c) => {
    if (!dist || !existsSync(dist)) return c.text('Timmy API', 200);
    const path = normalize(decodeURIComponent(new URL(c.req.url).pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(dist, path);
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    const immutable = file.includes(`${dist}/assets/`);
    return new Response(readFileSync(file), { headers: { 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' } });
  });

  return app;
}

async function storedSecret(name: string): Promise<string> {
  const { rows } = await sysPool.query('select value from app_secret where name = $1', [name]);
  return (rows[0]?.value as string | undefined) ?? '';
}
