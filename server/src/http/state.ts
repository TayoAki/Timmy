/**
 * The workspace's state and the commands that change it: the screens load the state once, send each action as a
 * command, and keep a stream open for what changes. Deciding a waiting action by its id is a command too.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { withWorkspace } from '../db/pool';
import { sha256 } from '../lib/ids';
import { runCommand } from '../state/engine';
import { MAX_STREAMS_PER_PERSON, stillAllowed, streamsOf, subscribe, type Subscriber } from '../state/hub';
import { rulesFor } from '../auth/roles';
import { membership } from '../auth/members';
import { loadState } from '../state/docs';
import { appLoaded, checkWhileOpen } from '../sync/mailbox-check';
import { fromWire, pickSlices, toWire } from '../../../src/live/patches';
import type { Action } from '../../../src/state/store';
import { ctxOf, requireRead, requireWorkspace, sessionOf, type Env } from './session';

const wire = (body: unknown, status = 200) => new Response(toWire(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export function stateRoutes(app: Hono<Env>): void {
  app.get('/api/v1/state', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const loaded = await withWorkspace({ workspaceId: ctx.workspaceId, lock: true }, (tx) => loadState(tx, ctx.workspaceId));
    // A page that opens loads its state here, once. The stream it opens next uses that to tell a real opening from a reconnect.
    appLoaded(ctx.workspaceId);
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
      // What the person changes in the mailbox itself is picked up when the app opens, and every few minutes while Timmy is in use.
      checkWhileOpen(ctx.workspaceId);
      while (open) {
        await stream.sleep(15_000);
        sub.checkedAt = 0;
        if (!(await stillAllowed(sub))) break;
        checkWhileOpen(ctx.workspaceId);
        send('ping', {});
      }
      off();
    });
  });
}

/** Actions waiting for a decision. */
export function actionRoutes(app: Hono<Env>): void {
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
}
