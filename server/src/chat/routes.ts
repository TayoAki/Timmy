/**
 * The website chat's routes.
 *
 * Three groups:
 *   - what a business's website loads: the loader script and the chat's frame (`/chat.js`, `/chat/frame…`);
 *   - what the frame calls, with no sign-in: the public settings, sending a message, and the visitor's stream
 *     (`/api/public/chat/:siteKey/…`);
 *   - what a signed-in teammate calls: a conversation's full transcript (`/api/v1/chat/…`).
 *
 * The public routes never read a session cookie. The workspace comes from the site key and nothing else.
 */
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import type { ChatMsg } from '../../../src/data/ws-types';
import { toWire } from '../../../src/live/patches';
import { config } from '../config';
import { withWorkspace } from '../db/pool';
import { ctxOf, requireRead, requireWorkspace, type Env } from '../http/session';
import { readState } from '../state/mutate';
import { watch, type VisitorMessage } from './hub';
import { addressOf, allow, hold } from './limits';
import { allowedParents, publicChat, siteOf } from './site';
import { FRAME_PAGE, NO_FRAME_PAGE, embedFile } from './static';
import { conversationOf } from './token';
import { CLOSED, ENDED, NOT_A_MESSAGE, TOO_FAST, TOO_LONG, cleanText, visitorSays, type Said } from './visitor';

/** An id a visitor's browser made up: its visitor id, or its id for one message. */
const BROWSER_ID = /^[A-Za-z0-9_-]{16,64}$/;
const CONVERSATION_ID = /^[A-Za-z0-9_]{8,60}$/;

/* ───────────── What a website loads ───────────── */

/**
 * Registered before the app's own security headers, because these responses need different ones. The app
 * forbids every other site from framing it; the chat's frame exists to be framed, by one site. So each response
 * here sets its own headers, and the frame names the only pages allowed to show it.
 */
export function chatFrameRoutes(app: Hono<Env>): void {
  const headers = (type: string, cache: string, more: Record<string, string> = {}): Record<string, string> => ({
    'content-type': type,
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(config.publicUrl.startsWith('https://') ? { 'strict-transport-security': 'max-age=15552000; includeSubDomains' } : {}),
    ...more,
  });

  // The loader runs on the business's own pages, so other sites must be allowed to load it as a script.
  app.get('/chat.js', () => new Response(embedFile('loader.js'), { headers: headers('text/javascript; charset=utf-8', 'public, max-age=300', { 'cross-origin-resource-policy': 'cross-origin' }) }));
  app.get('/chat/frame.js', () => new Response(embedFile('frame.js'), { headers: headers('text/javascript; charset=utf-8', 'public, max-age=300', { 'cross-origin-resource-policy': 'same-origin' }) }));
  app.get('/chat/frame.css', () => new Response(embedFile('frame.css'), { headers: headers('text/css; charset=utf-8', 'public, max-age=300', { 'cross-origin-resource-policy': 'same-origin' }) }));

  app.get('/chat/frame', async (c) => {
    const site = await siteOf(c.req.query('site'));
    const parents = site ? allowedParents(site.domain) : [];
    const ok = parents.length > 0;
    // The frame may load its own script and stylesheet, show an inline picture and call its own server. Nothing
    // else: no inline script, no other origin, no forms. And only the business's website may put it on a page.
    const policy = ["default-src 'none'", "script-src 'self'", "style-src 'self'", 'img-src data:', "connect-src 'self'", "base-uri 'none'", "form-action 'none'", `frame-ancestors ${ok ? parents.join(' ') : "'none'"}`].join('; ');
    return new Response(ok ? FRAME_PAGE : NO_FRAME_PAGE, {
      status: ok ? 200 : 404,
      headers: headers('text/html; charset=utf-8', 'no-store', {
        'content-security-policy': policy,
        // A page that isolates itself (COEP) only shows frames that say they may be embedded.
        'cross-origin-resource-policy': 'cross-origin',
        'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
        'x-robots-tag': 'noindex',
      }),
    });
  });
}

/* ───────────── What the frame and teammates call ───────────── */

const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A refusal is always a plain sentence in JSON. A visitor never gets an error page. */
const refuse = (c: Context, said: Said) => {
  const no = said as Extract<Said, { ok: false }>;
  return c.json({ ok: false, notice: no.notice, ...(no.reset ? { reset: true } : {}) }, no.status as 400, { 'cache-control': 'no-store' });
};

/** Waits, unless woken first. */
function pause(ms: number, onWake: (wake: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    onWake(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

export function chatRoutes(app: Hono<Env>): void {
  // A chat message is small. Anything bigger is refused before it is read.
  app.use('/api/public/chat/*', bodyLimit({ maxSize: config.chat.maxBodyBytes, onError: (c) => refuse(c, TOO_LONG) }));

  app.get('/api/public/chat/:siteKey/config', async (c) => {
    if (!allow(`read:${addressOf(c)}`, config.chat.addressReadsPerMinute, 60_000)) return refuse(c, TOO_FAST);
    const site = await siteOf(c.req.param('siteKey'));
    if (!site) return refuse(c, CLOSED);
    const w = (await readState(site.workspaceId)).state.ws.chat.site;
    if (!w) return refuse(c, CLOSED);
    return c.json(publicChat(w), 200, { 'cache-control': 'public, max-age=30' });
  });

  app.post('/api/public/chat/:siteKey/messages', async (c) => {
    const address = addressOf(c);
    if (!allow(`message:address:${address}`, config.chat.addressMessagesPerMinute, 60_000)) return refuse(c, TOO_FAST);
    const body = (await c.req.json().catch(() => null)) as unknown;
    const site = await siteOf(c.req.param('siteKey'));
    if (!site) return refuse(c, CLOSED);
    if (!plain(body) || typeof body.visitor !== 'string' || !BROWSER_ID.test(body.visitor) || typeof body.id !== 'string' || !BROWSER_ID.test(body.id) || typeof body.text !== 'string') return refuse(c, NOT_A_MESSAGE);
    if (!allow(`message:visitor:${site.workspaceId}:${body.visitor}`, config.chat.visitorMessagesPerMinute, 60_000)) return refuse(c, TOO_FAST);
    const text = cleanText(body.text);
    if (!text) return refuse(c, NOT_A_MESSAGE);
    if (text.length > config.chat.maxMessageChars) return refuse(c, TOO_LONG);
    const continues = body.conversation !== undefined || body.token !== undefined;
    if (continues && (typeof body.conversation !== 'string' || typeof body.token !== 'string')) return refuse(c, ENDED);
    if (!continues && !allow(`new:address:${address}`, config.chat.addressConversationsPerHour, 3_600_000)) return refuse(c, TOO_FAST);
    const after = typeof body.after === 'number' && Number.isSafeInteger(body.after) && body.after > 0 ? body.after : 0;

    const said = await visitorSays(site, {
      visitor: body.visitor,
      clientId: body.id,
      text,
      ...(continues ? { conversation: body.conversation as string, token: body.token as string } : {}),
      ...(typeof body.page === 'string' ? { page: body.page } : {}),
      after,
    });
    if (!said.ok) return refuse(c, said);
    return c.json(said, 200, { 'cache-control': 'no-store' });
  });

  app.get('/api/public/chat/:siteKey/stream', async (c) => {
    const address = addressOf(c);
    if (!allow(`read:${address}`, config.chat.addressReadsPerMinute, 60_000)) return refuse(c, TOO_FAST);
    const siteKey = c.req.param('siteKey');
    const site = await siteOf(siteKey);
    if (!site) return refuse(c, CLOSED);
    const workspaceId = site.workspaceId;
    // The token travels in a header, never in the address, so it stays out of access logs and browser history.
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const conversationId = await conversationOf(token, workspaceId);
    const exists = async () => !!conversationId && !!(await withWorkspace({ workspaceId }, (tx) => tx.query('select 1 from chat_conversation where id = $1 and workspace_id = $2', [conversationId, workspaceId]))).rowCount;
    if (!conversationId || conversationId !== c.req.query('conversation') || !(await exists())) return refuse(c, ENDED);

    // Open streams are counted three ways: for this server as a whole, per address and per conversation.
    const places = [hold('stream:all', config.chat.streamsOpen), hold(`stream:address:${address}`, config.chat.streamsPerAddress), hold(`stream:conversation:${conversationId}`, config.chat.streamsPerConversation)];
    const free = () => places.forEach((give) => give?.());
    if (places.some((p) => !p)) {
      free();
      return refuse(c, TOO_FAST);
    }
    const asked = Number(c.req.query('after') ?? 0);
    const after = Number.isSafeInteger(asked) && asked > 0 ? asked : 0;

    return streamSSE(c, async (stream) => {
      let open = true;
      let wake = () => {};
      const write = (event: string, data: unknown) => {
        if (open) void stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => (open = false));
      };
      const off = watch({ workspaceId, conversationId, after, send: (m: VisitorMessage) => write('message', m), ready: () => write('ready', {}) });
      stream.onAbort(() => {
        open = false;
        wake();
      });
      try {
        // A stream is closed after a while whatever happens; the chat window opens a new one from where it stopped.
        const until = Date.now() + config.chat.streamSeconds * 1000;
        let checked = Date.now();
        while (open && Date.now() < until) {
          await pause(Math.min(25_000, Math.max(0, until - Date.now())), (w) => (wake = w));
          if (!open) break;
          // The chat may have been switched off, or the conversation deleted, while the stream was open.
          // Looked up once a minute: many streams may be open, and each look is a read of the database.
          if (Date.now() - checked >= 60_000) {
            if (!(await siteOf(siteKey)) || !(await exists())) break;
            checked = Date.now();
          }
          write('ping', {});
        }
      } finally {
        open = false;
        off();
        free();
      }
    });
  });

  /**
   * A conversation's whole transcript, for a teammate. The Chats screen holds only the newest messages of each
   * conversation; this reads the rest from the stored copy, inside the caller's own workspace.
   */
  app.get('/api/v1/chat/conversations/:id/messages', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const id = c.req.param('id');
    if (!CONVERSATION_ID.test(id)) return c.json({ error: 'Not found' }, 404);
    const rows = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => {
      const found = await tx.query('select 1 from chat_conversation where id = $1 and workspace_id = $2', [id, ctx.workspaceId]);
      if (!found.rowCount) return null;
      return (await tx.query(`select id, sender, member_name, client_id, body, seq, failed, coalesce(sent_at, created_at) as at from chat_message where conversation_id = $1 and workspace_id = $2 order by seq nulls last, created_at limit 2000`, [id, ctx.workspaceId])).rows;
    });
    if (!rows) return c.json({ error: 'Not found' }, 404);
    const messages: ChatMsg[] = rows.map((r) => ({
      // A teammate's reply is listed under the id their screen gave it, so it matches what the screen already shows.
      id: r.sender === 'member' && r.client_id ? (r.client_id as string) : (r.id as string),
      from: r.sender === 'visitor' ? 'visitor' : r.sender === 'timmy' ? 'timmy' : 'you',
      text: r.body as string,
      at: new Date(r.at as Date),
      ...(r.sender === 'member' && r.member_name ? { by: r.member_name as string } : {}),
      ...(r.failed ? { undelivered: true } : {}),
    }));
    return new Response(toWire({ messages }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  });
}
