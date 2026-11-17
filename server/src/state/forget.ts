/**
 * Taking records out of the workspace's history, not only out of its state.
 *
 * A change to the workspace is kept in three places besides the state itself: the record of changes that open
 * tabs catch up from (`state_change`), and, for each command, what it changed (`command.pre`, which is what Undo
 * puts back) and what it answered (`command.result`). When content has to go for good (a disconnected mailbox,
 * a deleted chat), it goes from all three, or a tab opened from an old position, or an Undo, brings it back.
 */
import type { Tx } from '../db/pool';

/** Records to forget, by slice: for example `{ s: 'threads', ids: [...] }`. */
export interface Forget {
  s: string;
  ids: string[];
}

/** Removes every mention of these records from the workspace's history. Returns how many rows were rewritten. */
export async function forgetFromHistory(tx: Tx, workspaceId: string, what: Forget[]): Promise<number> {
  const list = what.filter((w) => w.ids.length);
  if (!list.length) return 0;
  // One pair of arrays, (slice, id), so each table is rewritten once whatever the number of records.
  const slices = list.flatMap((w) => w.ids.map(() => w.s));
  const ids = list.flatMap((w) => w.ids);
  const pairs = `select * from unnest($2::text[], $3::text[]) as f(s, id)`;
  const mentions = (col: string) => `exists (select 1 from jsonb_array_elements(${col}) p join (${pairs}) f on p->>'s' = f.s and p->>'id' = f.id)`;
  const without = (col: string) => `(select coalesce(jsonb_agg(p), '[]'::jsonb) from jsonb_array_elements(${col}) p where not exists (select 1 from (${pairs}) f where p->>'s' = f.s and p->>'id' = f.id))`;
  let n = 0;
  n += (await tx.query(`update state_change set patches = ${without('patches')} where workspace_id = $1 and ${mentions('patches')}`, [workspaceId, slices, ids])).rowCount ?? 0;
  n += (await tx.query(`update command set pre = ${without('pre')} where workspace_id = $1 and jsonb_typeof(pre) = 'array' and ${mentions('pre')}`, [workspaceId, slices, ids])).rowCount ?? 0;
  n += (
    await tx.query(
      `update command set result = jsonb_set(result, '{patches}', ${without("result->'patches'")})
       where workspace_id = $1 and jsonb_typeof(result->'patches') = 'array' and ${mentions("result->'patches'")}`,
      [workspaceId, slices, ids],
    )
  ).rowCount ?? 0;
  return n;
}
