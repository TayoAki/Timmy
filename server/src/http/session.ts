import type { Context, MiddlewareHandler } from 'hono';
import { auth } from '../auth/auth';
import { rulesFor } from '../auth/roles';
import { config } from '../config';
import { authPool } from '../db/pool';
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

/** The person's role in a workspace, straight from the membership table. Null when they aren't a member. */
export async function membership(userId: string, workspaceId: string): Promise<string | null> {
  const { rows } = await authPool.query('select role from member where "userId" = $1 and "organizationId" = $2', [userId, workspaceId]);
  return (rows[0]?.role as string | undefined) ?? null;
}

export async function workspacesOf(userId: string): Promise<{ id: string; name: string; role: string }[]> {
  const { rows } = await authPool.query('select o.id, o.name, m.role from member m join organization o on o.id = m."organizationId" where m."userId" = $1 order by m."createdAt"', [userId]);
  return rows as { id: string; name: string; role: string }[];
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

export const ctxOf = (c: Context<Env>): Ctx => c.get('ctx');
