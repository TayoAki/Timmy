/**
 * The review screen's routes: what Timmy offers to track, what it tracks, and the things it knows of each kind.
 * Anyone who may read the workspace can look. Accepting, dismissing, renaming, removing a field and stopping
 * decide what Timmy reads out of everyone's mail from now on, so they need the role that sets policy. So do
 * bringing back a kind that was turned down, and merging two things or saying they are not the same.
 */
import type { Context, Hono } from 'hono';
import { acceptKind, bringBackKind, changeKind, dismissKind, keepApart, mergeThings, stopTracking, thingsOf, trackedOverview, type Decided } from '../ontology/types';
import { ctxOf, requireRead, requireWorkspace, type Env } from './session';

const ID = /^[\w-]{1,60}$/;
/** A kind's fixed spelling: plain words, as `kindKey` makes them. */
const KEY = /^[\p{L}\p{N}][\p{L}\p{N} ]{0,39}$/u;

export function trackedRoutes(app: Hono<Env>): void {
  const answer = (c: Context<Env>, out: Decided<object>) => (out.ok ? c.json(out) : c.json({ error: out.error }, out.status));
  /** The person deciding, or null when their role may only look. */
  const decider = (c: Context<Env>) => {
    const ctx = ctxOf(c);
    return ctx.rules.policy ? { workspaceId: ctx.workspaceId, userId: ctx.user.id } : null;
  };
  const refused = (c: Context<Env>) => c.json({ error: 'Only an owner or admin can change what Timmy tracks.' }, 403);

  app.get('/api/v1/tracked', requireWorkspace, requireRead, async (c) => c.json(await trackedOverview(ctxOf(c).workspaceId)));

  app.get('/api/v1/tracked/:id/things', requireWorkspace, requireRead, async (c) => {
    const id = c.req.param('id');
    const things = ID.test(id) ? await thingsOf(ctxOf(c).workspaceId, id) : null;
    return things ? c.json({ things }) : c.json({ error: 'Not found' }, 404);
  });

  app.post('/api/v1/tracked/proposals/:key/accept', requireWorkspace, async (c) => {
    const by = decider(c);
    if (!by) return refused(c);
    const key = c.req.param('key');
    if (!KEY.test(key)) return c.json({ error: 'Not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    return answer(c, await acceptKind(by, key, body?.name));
  });

  app.post('/api/v1/tracked/proposals/:key/dismiss', requireWorkspace, async (c) => {
    const by = decider(c);
    if (!by) return refused(c);
    const key = c.req.param('key');
    if (!KEY.test(key)) return c.json({ error: 'Not found' }, 404);
    return answer(c, await dismissKind(by, key));
  });

  app.patch('/api/v1/tracked/:id', requireWorkspace, async (c) => {
    const by = decider(c);
    if (!by) return refused(c);
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: 'Not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; removeField?: unknown };
    if (body?.name === undefined && body?.removeField === undefined) return c.json({ error: 'Say what to change: a new name, or a field to remove.' }, 400);
    return answer(c, await changeKind(by, id, { name: body.name, removeField: body.removeField }));
  });

  // A kind that was turned down or stopped is offered again.
  app.post('/api/v1/tracked/proposals/:key/bring-back', requireWorkspace, async (c) => {
    const by = decider(c);
    if (!by) return refused(c);
    const key = c.req.param('key');
    if (!KEY.test(key)) return c.json({ error: 'Not found' }, 404);
    return answer(c, await bringBackKind(by, key));
  });

  // "Same thing?": merge one into the other, or say they differ.
  app.post('/api/v1/tracked/:id/merge', requireWorkspace, async (c) => {
    const by = decider(c);
    if (!by) return refused(c);
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: 'Not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { keep?: unknown; merge?: unknown };
    return answer(c, await mergeThings(by, id, body?.keep, body?.merge));
  });

  app.post('/api/v1/tracked/:id/apart', requireWorkspace, async (c) => {
    const by = decider(c);
    if (!by) return refused(c);
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: 'Not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { a?: unknown; b?: unknown };
    return answer(c, await keepApart(by, id, body?.a, body?.b));
  });

  app.delete('/api/v1/tracked/:id', requireWorkspace, async (c) => {
    const by = decider(c);
    if (!by) return refused(c);
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: 'Not found' }, 404);
    return answer(c, await stopTracking(by, id));
  });
}
