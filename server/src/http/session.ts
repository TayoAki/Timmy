import type { Context, MiddlewareHandler } from 'hono';
import { auth } from '../auth/auth';
import { membership } from '../auth/members';
import { rulesFor } from '../auth/roles';
import { config } from '../config';
import type { Ctx } from '../state/engine';

export interface Session {
  user: { id: string; name: string; email: string };
  activeWorkspaceId: string | null;
}

export type Env = { Variables: { session: Session; ctx: Ctx } };

/** Who is signed in, from the session cookie. Null when nobody is. */
export async function sessionOf(headers: Headers): Promise<Session | null> {
  const s = await auth().api.getSession({ headers });
  if (!s) return null;
  return {
    user: { id: s.user.id, name: s.user.name, email: s.user.email },
    activeWorkspaceId: (s.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null,
  };
}

/**
 * Requests that change something must come from our own pages. The session
 * cookie is SameSite=Lax already; this also refuses a cross-site form or script.
 */
export const sameOrigin: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin');
    const site = c.req.header('sec-fetch-site');
    if ((origin && origin !== config.publicUrl) || (site && site !== 'same-origin' && site !== 'none')) return c.json({ error: 'Cross-site requests are not allowed.' }, 403);
  }
  await next();
};

export const requireSession: MiddlewareHandler<Env> = async (c, next) => {
  const s = await sessionOf(c.req.raw.headers);
  if (!s) return c.json({ error: 'Sign in first.' }, 401);
  c.set('session', s);
  await next();
};

/**
 * Resolves the workspace a request acts in: the session's active one, checked
 * against the membership table on every request. The workspace id never comes
 * from the request body or the URL.
 */
export const requireWorkspace: MiddlewareHandler<Env> = async (c, next) => {
  const s = await sessionOf(c.req.raw.headers);
  if (!s) return c.json({ error: 'Sign in first.' }, 401);
  if (!s.activeWorkspaceId) return c.json({ error: 'Choose a workspace first.' }, 409);
  const role = await membership(s.user.id, s.activeWorkspaceId);
  if (!role) return c.json({ error: 'You are not a member of this workspace.' }, 403);
  c.set('session', s);
  c.set('ctx', { user: s.user, workspaceId: s.activeWorkspaceId, role, rules: rulesFor(role) });
  await next();
};

/** For anything that returns the workspace's content. A client role is a member but may not read it. */
export const requireRead: MiddlewareHandler<Env> = async (c, next) => {
  if (!c.get('ctx').rules.read) return c.json({ error: 'Your role can’t read this workspace.' }, 403);
  await next();
};

export const ctxOf = (c: Context<Env>): Ctx => c.get('ctx');
