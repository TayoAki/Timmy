/**
 * A route that exists only so the browser suites can see the website chat's older conversations without
 * starting a hundred of them: it lists on the Chats screen only the newest `keep` of this workspace's
 * conversations, the same way the screen drops the oldest past its limit. Nothing is deleted; the rest stay
 * in the stored copy. Mounted with the other test hooks, which the config refuses in production.
 */
import type { Hono } from 'hono';
import { ctxOf, requireWorkspace, type Env } from '../http/session';
import { mutate } from '../state/mutate';
import { newestConversations } from './shown';

export function chatTestRoutes(app: Hono<Env>): void {
  app.post('/api/test/chat-list', requireWorkspace, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { keep?: unknown };
    const keep = Number(body.keep);
    if (!Number.isInteger(keep) || keep < 0) return c.json({ error: 'keep is a whole number' }, 400);
    const ctx = ctxOf(c);
    const listed = await mutate(ctx.workspaceId, 'chat', async (_tx, loaded) => {
      const chats = newestConversations(loaded.state.ws.chats, keep);
      return { state: { ...loaded.state, ws: { ...loaded.state.ws, chats } }, result: Object.keys(chats).length };
    });
    return c.json({ ok: true, listed });
  });
}
