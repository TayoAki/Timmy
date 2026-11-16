/** Who belongs to a workspace, and what they may do there. Read from the membership table every time: a removed member is out at once. */
import { authPool } from '../db/pool';
import type { Ctx } from '../state/engine';
import { rulesFor } from './roles';

/** The person's role in a workspace. Null when they aren't a member. */
export async function membership(userId: string, workspaceId: string): Promise<string | null> {
  const { rows } = await authPool.query('select role from member where "userId" = $1 and "organizationId" = $2', [userId, workspaceId]);
  return (rows[0]?.role as string | undefined) ?? null;
}

export async function workspacesOf(userId: string): Promise<{ id: string; name: string; role: string }[]> {
  const { rows } = await authPool.query('select o.id, o.name, m.role from member m join organization o on o.id = m."organizationId" where m."userId" = $1 order by m."createdAt"', [userId]);
  return rows as { id: string; name: string; role: string }[];
}

/** The person a background job or a resumed run acts for, with their current role. Null when they have left the workspace. */
export async function ctxFor(workspaceId: string, userId: string | null): Promise<Ctx | null> {
  if (!userId) return null;
  const role = await membership(userId, workspaceId);
  if (!role) return null;
  const u = (await authPool.query('select id, name, email from "user" where id = $1', [userId])).rows[0];
  if (!u) return null;
  return { user: { id: u.id, name: u.name, email: u.email }, workspaceId, role, rules: rulesFor(role) };
}
