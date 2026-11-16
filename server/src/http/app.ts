import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { streamSSE } from 'hono/streaming';
import { isTimeZone } from '../agent/morning';
import { auth } from '../auth/auth';
import { MODEL_ALLOWLIST, config, isLocal, modelFor } from '../config';
import { sysPool, withWorkspace } from '../db/pool';
import { audit } from '../gateway/gateway';
import { enqueueSoon } from '../jobs/jobs';
import { sha256 } from '../lib/ids';
import { log } from '../lib/log';
import { composio, composioReady, fakeComposio } from '../providers/composio';
import { modelReady } from '../providers/model';
import { runCommand } from '../state/engine';
import { MAX_STREAMS_PER_PERSON, stillAllowed, streamsOf, subscribe, type Subscriber } from '../state/hub';
import { rulesFor } from '../auth/roles';
import { loadState } from '../state/docs';
import { ConnectError, TOOLKITS, closeConnections, disconnect, finishConnect, startConnect } from '../sync/connect';
import { mailboxFor } from '../sync/mailbox';
import { summarizePage } from '../agent/pages';
import { BudgetError } from '../providers/model';
import { fromWire, pickSlices, toWire } from '../../../src/live/patches';
import type { Action } from '../../../src/state/store';
import { chatFrameRoutes, chatRoutes } from '../chat/routes';
import { agentRoutes } from './agent';
import { automationRoutes } from './automations';
import { membership, workspacesOf } from '../auth/members';
import { ctxOf, requireRead, requireSession, requireWorkspace, sameOrigin, sessionOf, type Env } from './session';
import { testRoutes } from './test-hooks';
import { pageRoutes } from '../pages/routes';

const wire = (body: unknown, status = 200) => new Response(toWire(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export function buildApp(): Hono<Env> {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof ConnectError) return c.json({ error: err.message }, err.status as 400);
    log.error('request failed', { path: c.req.path, error: err.message, stack: err.stack });
    return c.json({ error: 'Something went wrong on our side.' }, 500);
  });

  // The website chat's loader and frame are loaded by other people's websites, so they set their own headers.
  // They are registered first, which keeps the app's own headers below from being applied to them.
  chatFrameRoutes(app);

  // Browser protections on every response. The app opens its own document viewers in frames, so framing is allowed
  // from this origin only. A full content-security policy for scripts is still to come (see STATUS.md).
  app.use(
    '*',
    secureHeaders({
      xFrameOptions: 'SAMEORIGIN',
      contentSecurityPolicy: { frameAncestors: ["'self'"] },
      referrerPolicy: 'strict-origin-when-cross-origin',
      strictTransportSecurity: config.publicUrl.startsWith('https://') ? 'max-age=15552000; includeSubDomains' : false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  // No request needs a large body. The check comes before anything reads it, including the webhook's signature check.
  const tooLarge = (c: Context) => c.json({ error: 'That request is too large.' }, 413);
  app.use('/api/hooks/*', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: tooLarge }));
  app.use('/api/*', bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge }));

  // What is configured is only told on a developer's own machine; a deployed server just says it is up.
  app.get('/api/health', (c) => c.json(isLocal() ? { ok: true, stage: config.stage, composio: composioReady(), model: modelReady(), fake: config.fakeProviders } : { ok: true }));

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
    const box = mailboxFor(conn.toolkit);
    const threadKey = box?.threadKeyOf(event.data) ?? '';
    if (box && threadKey) enqueueSoon('mail.ingest', { workspaceId: conn.workspace_id, connectionId: conn.id, threadKey, seed: event.data });
    // Any calendar event means the window may have changed; one sync per connection covers a burst of them.
    if (conn.toolkit === 'googlecalendar') enqueueSoon('calendar.sync', { workspaceId: conn.workspace_id, connectionId: conn.id }, { singletonKey: `cal:${conn.id}` });
    if (conn.toolkit === 'googledrive') {
      // A file thrown away leaves the list at once. Anything else means "the list changed": one pass per connection covers a burst.
      const gone = event.triggerSlug === 'GOOGLEDRIVE_FILE_DELETED_OR_TRASHED_TRIGGER' ? String(event.data.file_id ?? '') : '';
      if (gone) enqueueSoon('files.remove', { workspaceId: conn.workspace_id, connectionId: conn.id, fileId: gone });
      else enqueueSoon('files.sync', { workspaceId: conn.workspace_id, connectionId: conn.id }, { singletonKey: `files:${conn.id}` });
    }
    await sysPool.query('update webhook_event set processed_at = now() where id = $1', [event.id]);
    return c.json({ ok: true });
  });

  app.use('/api/*', sameOrigin);
  app.all('/api/auth/*', async (c) => {
    // Leaving a workspace has no hook of its own in the auth library, so it is noticed here: whoever leaves
    // takes their connected accounts with them, the same as when they are removed.
    const leaving = c.req.method === 'POST' && c.req.path === '/api/auth/organization/leave' ? await leaver(c.req.raw.clone()) : null;
    const res = await auth().handler(c.req.raw);
    if (leaving && res.ok) await closeConnections(leaving.workspaceId, { userId: leaving.userId }, leaving.userId).catch((e) => log.error('could not close a leaving member’s connections', { error: (e as Error).message }));
    return res;
  });

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

  app.get('/api/v1/state', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const loaded = await withWorkspace({ workspaceId: ctx.workspaceId, lock: true }, (tx) => loadState(tx, ctx.workspaceId));
    return wire({ rev: loaded.rev, slices: pickSlices(loaded.state), me: { name: loaded.workspace.owner_name, email: loaded.workspace.owner_email, company: loaded.workspace.name } });
  });

  app.post('/api/v1/commands', requireWorkspace, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { id?: string; action?: Action } | null;
    if (!body?.id || !body.action) return c.json({ error: 'A command needs an id and an action.' }, 400);
    // Dates in an action arrive as ISO strings; the reducer expects Dates.
    const action = fromWire<Action>(JSON.stringify(body.action));
    return wire(await runCommand(ctxOf(c), { id: body.id, action }));
  });

  app.get('/api/v1/stream', requireWorkspace, requireRead, (c) => {
    const ctx = ctxOf(c);
    const rev = Number(c.req.query('rev') ?? 0);
    if (streamsOf(ctx.workspaceId, ctx.user.id) >= MAX_STREAMS_PER_PERSON) return c.json({ error: 'Timmy is open in too many tabs. Close some and reload.' }, 429);
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
      const sub: Subscriber = { workspaceId: ctx.workspaceId, userId: ctx.user.id, rev, send, allowed, checkedAt: Date.now(), close: () => (open = false) };
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

  app.get('/api/v1/settings', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const ws = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query('select model_id, approval_mode, max_concurrent_runs, monthly_spend_cap_usd, kill_switch, timezone from workspace where id = $1', [ctx.workspaceId])).rows[0]);
    return c.json({
      model: modelFor(ws.model_id),
      models: MODEL_ALLOWLIST,
      approvalMode: ws.approval_mode,
      maxConcurrentRuns: ws.max_concurrent_runs,
      monthlySpendCapUsd: Number(ws.monthly_spend_cap_usd),
      limits: { monthlySpendCapUsd: config.spendCapCeilingUsd, maxConcurrentRuns: config.concurrentRunsCeiling },
      killSwitch: ws.kill_switch,
      timezone: ws.timezone,
    });
  });

  app.patch('/api/v1/settings', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.policy) return c.json({ error: 'Only an owner or admin can change this.' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { model?: string; approvalMode?: string; killSwitch?: boolean; timezone?: string; monthlySpendCapUsd?: number; maxConcurrentRuns?: number };
    if (body.model !== undefined && !MODEL_ALLOWLIST.some((m) => m.id === body.model)) return c.json({ error: 'That model isn’t on the list.' }, 400);
    if (body.approvalMode !== undefined && body.approvalMode !== 'ask' && body.approvalMode !== 'auto') return c.json({ error: 'Approval mode is ask or auto.' }, 400);
    const cap = body.monthlySpendCapUsd;
    if (cap !== undefined && !(typeof cap === 'number' && cap >= 0 && cap <= config.spendCapCeilingUsd)) return c.json({ error: `The monthly limit can be anything from $0 to $${config.spendCapCeilingUsd}.` }, 400);
    if (body.timezone !== undefined && !(typeof body.timezone === 'string' && body.timezone.length <= 64 && isTimeZone(body.timezone))) return c.json({ error: 'That isn’t a time zone Timmy knows.' }, 400);
    const runs = body.maxConcurrentRuns;
    if (runs !== undefined && !(Number.isInteger(runs) && runs >= 1 && runs <= config.concurrentRunsCeiling)) return c.json({ error: `Timmy can work on 1 to ${config.concurrentRunsCeiling} things at once.` }, 400);
    // Only the settings named here are stored and logged; anything else in the request is ignored.
    const change = { model: body.model, approvalMode: body.approvalMode, killSwitch: typeof body.killSwitch === 'boolean' ? body.killSwitch : undefined, timezone: body.timezone, monthlySpendCapUsd: cap, maxConcurrentRuns: runs };
    await withWorkspace({ workspaceId: ctx.workspaceId, userId: ctx.user.id }, async (tx) => {
      await tx.query(
        `update workspace set model_id = coalesce($2, model_id), approval_mode = coalesce($3, approval_mode), kill_switch = coalesce($4, kill_switch), timezone = coalesce($5, timezone),
           monthly_spend_cap_usd = coalesce($6, monthly_spend_cap_usd), max_concurrent_runs = coalesce($7, max_concurrent_runs) where id = $1`,
        [ctx.workspaceId, change.model ?? null, change.approvalMode ?? null, change.killSwitch ?? null, change.timezone ?? null, change.monthlySpendCapUsd ?? null, change.maxConcurrentRuns ?? null],
      );
      await audit(tx, ctx.workspaceId, { actor: ctx.user.id, action: 'settings.changed', detail: change });
    });
    return c.json({ ok: true });
  });

  /* ───────────── Connections ───────────── */

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
    if (TOOLKITS[conn.app_id]?.kind === 'calendar') enqueueSoon('calendar.sync', { workspaceId: ctx.workspaceId, connectionId: conn.id }, { singletonKey: `cal:${conn.id}` });
    if (TOOLKITS[conn.app_id]?.kind === 'files') enqueueSoon('files.sync', { workspaceId: ctx.workspaceId, connectionId: conn.id }, { singletonKey: `files:${conn.id}` });
    return c.redirect(`/?connect=ok&app=${conn.app_id}`);
  });

  app.post('/api/v1/connections/:app/disconnect', requireWorkspace, async (c) => {
    await disconnect(ctxOf(c), c.req.param('app'));
    return c.json({ ok: true });
  });

  /* ───────────── Actions waiting for a decision ───────────── */

  // The same decision the Approvals screen makes with a command, for callers that hold only the action's id.
  // Deciding the same action the same way twice gives the same answer; who may decide is checked at the gateway.
  for (const verb of ['approve', 'decline'] as const) {
    app.post(`/api/v1/actions/:id/${verb}`, requireWorkspace, async (c) => {
      const id = c.req.param('id');
      if (!/^[\w-]{1,60}$/.test(id)) return c.json({ error: 'Not found' }, 404);
      const ctx = ctxOf(c);
      // One command per person, action and decision: the same person repeating it is a retry, anyone else is a new request.
      const out = await runCommand(ctx, { id: `decide:${sha256(`${ctx.user.id}:${id}:${verb}`).slice(0, 40)}`, action: { type: 'effect', id, approve: verb === 'approve' } });
      return wire(out, out.ok ? 200 : 409);
    });
  }

  /* ───────────── Pages ───────────── */

  // "Summarize with Timmy": the model writes a few lines from the page; only lines the page backs come back.
  // The person's editor types them in, so the page itself changes through the normal save.
  app.post('/api/v1/pages/:id/summarize', requireWorkspace, async (c) => {
    const id = c.req.param('id');
    if (!/^[\w.:@+-]{1,200}$/.test(id)) return c.json({ error: 'Not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { blocks?: unknown };
    try {
      const out = await summarizePage(ctxOf(c), id, body.blocks);
      return out.ok ? c.json({ lines: out.lines }) : c.json({ error: out.reason }, out.status as 400);
    } catch (e) {
      if (e instanceof BudgetError) return c.json({ error: e.message }, 429);
      log.warn('a page could not be summarised', { error: (e as Error).message });
      return c.json({ error: 'Timmy couldn’t write a summary just now.' }, 503);
    }
  });

  /* ───────────── The audit log, effects and usage ───────────── */

  app.get('/api/v1/audit', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);
    const rows = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query('select id, at, actor, on_behalf_of, action, effect_id, run_id, detail from audit_log where workspace_id = $1 order by id desc limit $2', [ctx.workspaceId, limit])).rows);
    return c.json({ entries: rows });
  });

  app.get('/api/v1/effects/:id', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const row = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query('select id, kind, status, target, source, requested_by, approved_by, approved_via, approver_route, hold_until, error, external_id, created_at, completed_at from effect where id = $1 and workspace_id = $2', [c.req.param('id'), ctx.workspaceId])).rows[0]);
    return row ? c.json(row) : c.json({ error: 'Not found' }, 404);
  });

  app.get('/api/v1/usage', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const out = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => {
      const models = (await tx.query(`select route, model, count(*)::int as calls, sum(tokens_in)::int as tokens_in, sum(tokens_out)::int as tokens_out, sum(tokens_reasoning)::int as tokens_reasoning, sum(tokens_cached)::int as tokens_cached, sum(cost_usd)::float8 as cost_usd from usage_event where workspace_id = $1 and at >= date_trunc('month', now()) group by route, model order by route`, [ctx.workspaceId])).rows;
      const calls = (await tx.query(`select phase, count(*)::int as calls from provider_call where workspace_id = $1 and at >= date_trunc('month', now()) group by phase order by phase`, [ctx.workspaceId])).rows;
      return { models, composio: calls };
    });
    return c.json(out);
  });

  agentRoutes(app);
  chatRoutes(app);
  // [automations] The test run and the list of runs (http/automations.ts).
  automationRoutes(app);
  // A page's version history, and how long the trash keeps a page.
  pageRoutes(app);

  if (config.testHooks) testRoutes(app);

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  /* ───────────── The app itself ───────────── */

  const dist = config.webDist ? resolve(config.webDist) : '';
  const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.wasmz': 'application/octet-stream', '.pdf': 'application/pdf', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json' };
  app.get('*', (c) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text('Bad request', 400);
    }
    if (!dist || !existsSync(dist)) return c.text('Timmy API', 200);
    const path = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
    let file = join(dist, path);
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    const immutable = file.includes(`${dist}/assets/`);
    return new Response(readFileSync(file), { headers: { 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' } });
  });

  return app;
}

/** Who is leaving which workspace, read from a copy of the request before the auth library consumes it. */
async function leaver(req: Request): Promise<{ userId: string; workspaceId: string } | null> {
  const s = await sessionOf(req.headers).catch(() => null);
  const body = (await req.json().catch(() => null)) as { organizationId?: unknown } | null;
  return s && typeof body?.organizationId === 'string' ? { userId: s.user.id, workspaceId: body.organizationId } : null;
}

async function storedSecret(name: string): Promise<string> {
  const { rows } = await sysPool.query('select value from app_secret where name = $1', [name]);
  return (rows[0]?.value as string | undefined) ?? '';
}
