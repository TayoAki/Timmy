/**
 * The API and the app on one origin. `buildApp` puts the protections in front of every route, in an order that
 * matters (headers, body limits, the webhook that needs neither session nor same-origin check, the same-origin
 * check, sign-in), then mounts each area's routes, then serves the built app for everything else.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { auth } from '../auth/auth';
import { MODEL_ALLOWLIST, config, isLocal, modelFor } from '../config';
import { withWorkspace } from '../db/pool';
import { log } from '../lib/log';
import { composioReady } from '../providers/composio';
import { modelReady } from '../providers/model';
import { rulesFor } from '../auth/roles';
import { ConnectError, closeConnections } from '../sync/connect';
import { summarizePage } from '../agent/pages';
import { BudgetError } from '../providers/model';
import { MAX_FILE_BYTES, fileSize } from '../../../src/lib/files';
import { chatFrameRoutes, chatRoutes } from '../chat/routes';
import { chatHostGate } from '../chat/host';
import { chatEnablerChanged } from '../chat/enabler';
import { agentRoutes } from './agent';
import { auditRoutes } from './audit';
import { automationRoutes } from './automations';
import { switchOffWithoutOwner } from '../automations/roles';
import { connectionEventRoutes, connectionRoutes } from './connections';
import { assetHeaders, fileRoutes, isFileUpload } from './files';
import { connectedFileRoutes } from './connected-files';
import { mailRoutes } from './mail';
import { projectRoutes } from './projects';
import { mapRoutes } from './map';
import { workspacesOf } from '../auth/members';
import { ctxOf, requireSession, requireWorkspace, sameOrigin, sessionOf, type Env } from './session';
import { settingsRoutes } from './settings';
import { actionRoutes, stateRoutes } from './state';
import { testRoutes } from './test-hooks';
import { pageRoutes } from '../pages/routes';
import { trackedRoutes } from './tracked';

export function buildApp(): Hono<Env> {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof ConnectError) return c.json({ error: err.message }, err.status as 400);
    log.error('request failed', { path: c.req.path, error: err.message, stack: err.stack });
    return c.json({ error: 'Something went wrong on our side.' }, 500);
  });

  // When the website chat has its own address, requests for it are answered by the chat alone (chat/host.ts).
  chatHostGate(app);
  // The website chat's loader and frame are loaded by other people's websites, so they set their own headers.
  // They are registered first, which keeps the app's own headers below from being applied to them.
  chatFrameRoutes(app);

  // Uploaded files get stricter headers than the rest of the app. Registered first, so they are set last and stand.
  app.use('/api/v1/assets/*', assetHeaders);

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
  // The one exception is the route that takes a file's bytes, which may be as large as a file may be.
  const smallBody = bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge });
  const fileBody = bodyLimit({ maxSize: MAX_FILE_BYTES, onError: (c) => c.json({ error: `Timmy keeps files up to ${fileSize(MAX_FILE_BYTES)}.` }, 413) });
  app.use('/api/*', (c, next) => (isFileUpload(c.req.method, c.req.path) ? fileBody(c, next) : smallBody(c, next)));

  // What is configured is only told on a developer's own machine; a deployed server just says it is up.
  app.get('/api/health', (c) => c.json(isLocal() ? { ok: true, stage: config.stage, composio: composioReady(), model: modelReady(), fake: config.fakeProviders } : { ok: true }));

  // Webhooks are signed by their sender; they carry no session and skip the same-origin check (http/connections.ts).
  connectionEventRoutes(app);

  app.use('/api/*', sameOrigin);
  app.all('/api/auth/*', async (c) => {
    // Leaving a workspace has no hook of its own in the auth library, so it is noticed here: whoever leaves
    // takes their connected accounts with them, the same as when they are removed.
    const leaving = c.req.method === 'POST' && c.req.path === '/api/auth/organization/leave' ? await leaver(c.req.raw.clone()) : null;
    const res = await auth().handler(c.req.raw);
    if (leaving && res.ok) await closeConnections(leaving.workspaceId, { userId: leaving.userId }, leaving.userId).catch((e) => log.error('could not close a leaving member’s connections', { error: (e as Error).message }));
    if (leaving && res.ok) await chatEnablerChanged(leaving.workspaceId, leaving.userId);
    // [automations] So does any automation they switched on (automations/roles.ts).
    if (leaving && res.ok) await switchOffWithoutOwner(leaving.workspaceId).catch((e) => log.error('could not switch off a leaving member’s automations', { error: (e as Error).message }));
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

  // The workspace's state, the commands that change it and the stream of what changed (http/state.ts).
  stateRoutes(app);
  // Settings: the model, approvals, limits (http/settings.ts).
  settingsRoutes(app);
  // Connecting and disconnecting apps (http/connections.ts).
  connectionRoutes(app);
  // Deciding a waiting action by its id, the same decision the Approvals screen makes with a command (http/state.ts).
  actionRoutes(app);

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

  // The audit log, effect records and usage (http/audit.ts).
  auditRoutes(app);

  agentRoutes(app);
  fileRoutes(app);
  connectedFileRoutes(app);
  mailRoutes(app);
  projectRoutes(app);
  mapRoutes(app);
  chatRoutes(app);
  // [automations] The test run and the list of runs (http/automations.ts).
  automationRoutes(app);
  // A page's version history, and how long the trash keeps a page.
  pageRoutes(app);
  trackedRoutes(app);

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
