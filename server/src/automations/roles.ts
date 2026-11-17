/**
 * An automation runs on the say-so of the owner or admin who switched it on (and of whoever last changed its steps
 * while it was on, which only an owner or admin can do). When that person is no longer an owner or admin here
 * (their role was lowered, they left, or they were removed), the say-so has gone, so the automation is switched off:
 * its runs in progress stop, what they had waiting in Approvals is taken back, and the automation and the activity
 * log say why, for the owners and admins. Any owner or admin can switch it on again, on their own say-so.
 *
 * The workspace's member hooks call this as soon as a role changes or someone leaves; the once-a-minute pass
 * (jobs.ts) catches any other way a role can change.
 */
import { authPool, type Tx } from '../db/pool';
import { rulesFor } from '../auth/roles';
import { mutate } from '../state/mutate';
import { switchOff } from './rows';
import { TIMMY, stopRuns } from './stop';

/** Switches off every automation in the workspace whose owner or admin no longer is one. Returns how many. */
export async function switchOffWithoutOwner(workspaceId: string): Promise<number> {
  const members = (await authPool.query(`select "userId" as id, role from member where "organizationId" = $1`, [workspaceId])).rows as { id: string; role: string }[];
  const admins = new Set(members.filter((m) => rulesFor(m.role).policy).map((m) => m.id));
  const here = new Set(members.map((m) => m.id));
  return mutate(workspaceId, 'automation', async (tx, loaded) => {
    const lives = (
      await tx.query(`select l.automation_id, l.enabled_by, v.created_by, v.name from automation_live l join automation_version v on v.id = l.version_id where l.workspace_id = $1 and l.enabled for update of l`, [workspaceId])
    ).rows as { automation_id: string; enabled_by: string; created_by: string; name: string }[];
    const without = lives.filter((l) => !admins.has(l.enabled_by) || !admins.has(l.created_by));
    if (!without.length) return { result: 0 };
    const names = await namesOf(without.flatMap((l) => [l.enabled_by, l.created_by]));
    let state = loaded.state;
    for (const l of without) {
      const switchedOn = !admins.has(l.enabled_by);
      const person = switchedOn ? l.enabled_by : l.created_by;
      const who = `${names.get(person) ?? 'The person'}, who ${switchedOn ? 'switched it on' : 'last changed its steps'},`;
      const why = `${who} ${here.has(person) ? 'is no longer an owner or admin here' : 'has left the workspace'}. An owner or admin can switch it back on.`;
      state = (await stopRuns(tx, loaded, state, TIMMY, { automationId: l.automation_id }, `The automation was switched off. ${why}`)).state;
      state = await switchOff(tx, state, { id: workspaceId, timezone: loaded.workspace.timezone }, l.automation_id, why);
    }
    return { state, result: without.length };
  });
}

/** People's names, from the sign-in records. */
async function namesOf(ids: string[]): Promise<Map<string, string>> {
  const { rows } = await authPool.query(`select id, name from "user" where id = any($1::text[])`, [[...new Set(ids)]]);
  return new Map(rows.map((r) => [r.id as string, r.name as string]));
}

/** Workspaces with an automation on whose owner or admin no longer is one, across workspaces. Ids only. */
export async function workspacesWithoutOwner(sys: { query: Tx['query'] }): Promise<string[]> {
  const { rows } = await sys.query(
    `select distinct l.workspace_id from automation_live l
       join automation_version v on v.id = l.version_id
       join workspace w on w.id = l.workspace_id
     where l.enabled and w.deleted_at is null and exists (
       select 1 from unnest(array[l.enabled_by, v.created_by]) as p(user_id)
       where not exists (
         select 1 from auth.member m
         where m."organizationId" = l.workspace_id and m."userId" = p.user_id
           and string_to_array(replace(m.role, ' ', ''), ',') && array['owner', 'admin']))
     limit 50`,
  );
  return rows.map((r) => r.workspace_id as string);
}
