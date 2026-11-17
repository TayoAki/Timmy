/**
 * The chat's own address (CHAT_PUBLIC_URL), such as https://chat.example.com: a second domain on this same service.
 *
 * Strangers' websites load the chat, and strangers type into it, so it is kept apart from the app. When the chat
 * has its own address:
 *   - a request for that address is answered by a small app that holds only the chat's public parts (the loader,
 *     the frame and its files, the public chat routes) and answers 404 to everything else. It never reads or
 *     sets a cookie, has no sign-in, and runs none of the app's own routes;
 *   - the app's own address no longer serves the loader, the frame or the public chat routes.
 * Which address a request is for is read from its Host header and compared with the configured addresses only.
 * Without the setting nothing changes: the chat is served from the app's own address, as before.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { config } from '../config';
import { log } from '../lib/log';
import type { Env } from '../http/session';
import { chatFrameRoutes, chatPublicRoutes } from './routes';
import { NOT_A_MESSAGE } from './visitor';

/** The host part of an address (name and port, the scheme's own port left out), lower case. Empty when it isn't one. */
function hostOf(origin: string, raw: string): string {
  try {
    return new URL(`${new URL(origin).protocol}//${raw.trim().replace(/\.$/, '')}`).host.toLowerCase();
  } catch {
    return '';
  }
}

/** Whether a request is for the chat's own address. Always false when the chat has none. */
export function onChatHost(c: Context): boolean {
  const chat = config.chat.publicUrl;
  if (!chat) return false;
  const asked = c.req.header('host');
  return !!asked && hostOf(chat, asked) === new URL(chat).host.toLowerCase();
}

/** The paths that belong to the chat's public side: the loader, the frame and its files, and the public routes. */
export const isPublicChatPath = (path: string) => path === '/chat.js' || path.startsWith('/chat/') || path.startsWith('/api/public/chat/');

/** Writes to the public routes come from the chat's own frame, on the chat's own address. */
const chatOriginOnly: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin');
    const site = c.req.header('sec-fetch-site');
    if ((origin && origin !== config.chat.publicUrl) || (site && site !== 'same-origin' && site !== 'none')) return c.json({ ok: false, notice: (NOT_A_MESSAGE as { notice: string }).notice }, 403, { 'cache-control': 'no-store' });
  }
  await next();
};

/** The whole of what the chat's own address answers. */
function buildChatHostApp(): Hono<Env> {
  const app = new Hono<Env>();
  app.onError((err, c) => {
    log.error('a chat request failed', { path: c.req.path, error: err.message });
    return c.json({ ok: false, notice: 'This chat isn’t available right now.' }, 500);
  });
  // The frame and its files set their own headers (it exists to be framed, by one website), so they come first.
  chatFrameRoutes(app);
  // Everything else here may not be framed by anyone, the same as the app.
  app.use(
    '*',
    secureHeaders({
      xFrameOptions: 'SAMEORIGIN',
      contentSecurityPolicy: { frameAncestors: ["'self'"] },
      referrerPolicy: 'no-referrer',
      strictTransportSecurity: config.chat.publicUrl.startsWith('https://') ? 'max-age=15552000; includeSubDomains' : false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use('/api/public/chat/*', chatOriginOnly);
  chatPublicRoutes(app);
  app.all('*', (c) => c.json({ error: 'Not found' }, 404, { 'cache-control': 'no-store' }));
  return app;
}

let hostApp: Hono<Env> | null = null;

const notHere = () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

/**
 * Registered first on the app, before anything else can read the request: a request for the chat's own address
 * goes to the chat's small app and nowhere else, and the chat's public paths are not served on any other address.
 */
export function chatHostGate(app: Hono<Env>): void {
  app.use('*', async (c, next) => {
    if (!config.chat.publicUrl) return next();
    if (onChatHost(c)) return (hostApp ??= buildChatHostApp()).fetch(c.req.raw, c.env);
    if (isPublicChatPath(c.req.path)) return notHere();
    return next();
  });
}
