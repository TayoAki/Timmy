export type Role = 'owner' | 'admin' | 'member' | 'assistant' | 'revops' | 'client';

export interface RoleRules {
  /** May read the workspace's mail, calendar and work items. */
  read: boolean;
  /** May change the workspace's state (triage, tasks, drafts…). */
  work: boolean;
  /** May approve a send. A delegate's sends go to the exec unless the exec's policy says otherwise. */
  approveSends: boolean;
  /** May approve a CRM write. Everyone else's CRM writes are routed to RevOps. */
  approveCrm: boolean;
  /** May change rules, the model and limits. */
  policy: boolean;
  /** May connect and disconnect apps. */
  connect: boolean;
}

export const ROLE_RULES: Record<Role, RoleRules> = {
  owner: { read: true, work: true, approveSends: true, approveCrm: true, policy: true, connect: true },
  admin: { read: true, work: true, approveSends: true, approveCrm: true, policy: true, connect: true },
  member: { read: true, work: true, approveSends: true, approveCrm: false, policy: false, connect: true },
  assistant: { read: true, work: true, approveSends: false, approveCrm: false, policy: false, connect: false },
  revops: { read: true, work: false, approveSends: false, approveCrm: true, policy: false, connect: false },
  client: { read: false, work: false, approveSends: false, approveCrm: false, policy: false, connect: false },
};

export const isRole = (r: string): r is Role => r in ROLE_RULES;

/** A member can hold several roles ("admin,revops"); they get the union. */
export function rulesFor(roleField: string | null | undefined): RoleRules {
  const out: RoleRules = { read: false, work: false, approveSends: false, approveCrm: false, policy: false, connect: false };
  for (const r of (roleField ?? '').split(',').map((s) => s.trim())) {
    if (!isRole(r)) continue;
    const rules = ROLE_RULES[r];
    for (const k of Object.keys(out) as (keyof RoleRules)[]) out[k] = out[k] || rules[k];
  }
  return out;
}
