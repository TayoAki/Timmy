/**
 * Reading one email the way its sender laid it out (see mail/original.ts).
 *
 *   GET /api/v1/mail/original?thread=<id>&message=<id>[&images=1]
 *
 * The thread is looked up in the caller's own workspace and the message must be one of its messages, from a mailbox
 * that is still connected. Nothing is stored; a short-lived copy is kept in memory so opening the same email twice
 * doesn't ask the mailbox twice. The connection is checked before that copy is used, so a disconnected mailbox's mail
 * stops showing at once.
 */
import type { Hono } from 'hono';
import { readOriginal, type Original } from '../mail/original';
import { readState } from '../state/mutate';
import { connectionById } from '../sync/tools';
import { ctxOf, requireRead, requireWorkspace, type Env } from './session';

const KEEP_MS = 10 * 60_000;
const KEEP_MAX = 300;
const recent = new Map<string, { at: number; value: Original }>();

function remembered(key: string): Original | undefined {
  const hit = recent.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > KEEP_MS) {
    recent.delete(key);
    return undefined;
  }
  return hit.value;
}

function remember(key: string, value: Original) {
  recent.set(key, { at: Date.now(), value });
  // The oldest go first once there are too many.
  while (recent.size > KEEP_MAX) recent.delete(recent.keys().next().value!);
}

export function mailRoutes(app: Hono<Env>): void {
  app.get('/api/v1/mail/original', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const threadId = String(c.req.query('thread') ?? '');
    const messageId = String(c.req.query('message') ?? '');
    const images = c.req.query('images') === '1';
    if (!threadId || !messageId || threadId.length > 200 || messageId.length > 300) return c.json({ error: 'Say which email.' }, 400);
    const { state } = await readState(ctx.workspaceId);
    const thread = state.threads.find((t) => t.id === threadId);
    const message = thread?.messages.find((m) => m.id === messageId);
    const connectionId = thread?.ext?.connectionId;
    if (!thread || !message || !connectionId) return c.json({ error: 'That email isn’t in this workspace’s mailbox.' }, 404);
    const conn = await connectionById(ctx.workspaceId, connectionId);
    if (!conn || conn.status !== 'active') return c.json({ error: 'The mailbox this email came from is no longer connected.' }, 404);
    const key = `${ctx.workspaceId}:${conn.id}:${messageId}:${images ? 1 : 0}`;
    let original = remembered(key);
    if (!original) {
      const read = await readOriginal(ctx.workspaceId, conn, messageId, images);
      if (!read) return c.json({ error: 'The mailbox didn’t give this email back. Try again in a moment.' }, 502);
      original = read;
      remember(key, original);
    }
    c.header('Cache-Control', 'private, no-store');
    return c.json(original);
  });
}
