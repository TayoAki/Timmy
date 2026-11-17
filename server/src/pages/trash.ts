/**
 * Emptying the page trash.
 *
 * A page in the trash can be brought back for a set number of days (30 unless configured otherwise). After
 * that a job deletes it for good, the same way "Delete forever" does in the app: the page, the sub-pages
 * that went to the trash with it, their contents, and the links to them on other pages. Their versions go
 * with their contents (see versions.ts).
 *
 * How long a page has been in the trash is read from the server's own record of when it arrived there, not
 * from the date the browser wrote on it: a computer with a wrong clock must not get a page deleted early.
 */
import type pg from 'pg';
import { patch, remove, type WsOp } from '../../../src/state/ws';
import { config } from '../config';
import { audit } from '../gateway/gateway';
import { reduce } from '../state/engine';
import { mutate } from '../state/mutate';
import { OWN_ORIGIN } from './versions';

/** Workspaces that hold at least one page past its time in the trash. Asked by the job, as the system role. */
export async function workspacesWithOldTrash(pool: pg.Pool, days = config.trashRetentionDays): Promise<string[]> {
  const { rows } = await pool.query(
    `select distinct d.workspace_id from state_doc d join workspace w on w.id = d.workspace_id
      where d.slice = 'ws.trash' and d.updated_at < now() - make_interval(days => $1::int) and w.deleted_at is null`,
    [days],
  );
  return rows.map((r) => r.workspace_id as string);
}

/** Deletes for good every page of one workspace that has been in the trash longer than `days`. Returns how many pages went, sub-pages included. */
export async function emptyOldTrash(workspaceId: string, days = config.trashRetentionDays): Promise<number> {
  return mutate(workspaceId, `${OWN_ORIGIN}trash-emptied`, async (tx, loaded) => {
    const state = loaded.state;
    const trash = state.ws.trash;
    const { rows } = await tx.query(`select id from state_doc where workspace_id = $1 and slice = 'ws.trash' and updated_at < now() - make_interval(days => $2::int)`, [workspaceId, days]);
    const old = new Set(rows.map((r) => r.id as string));
    // A sub-page goes when the page it was trashed with goes. One left behind with nothing above it stands for itself.
    const roots = Object.values(trash).filter((t) => old.has(t.id) && (!t.trashRoot || !trash[t.trashRoot]));
    if (!roots.length) return { result: 0 };

    const gone = new Set<string>();
    for (const root of roots) {
      // Each page is checked on its own: a sub-page goes with its root only if it has itself been in the trash as long
      // (a screen can write any record into the trash, tied to any root), and never while it is still listed as a page.
      const ids = [root.id, ...Object.values(trash).filter((t) => t.trashRoot === root.id && old.has(t.id)).map((t) => t.id)].filter((id) => !Object.hasOwn(state.ws.files, id));
      if (!ids.length) continue;
      for (const id of ids) gone.add(id);
      await audit(tx, workspaceId, { actor: 'system', action: 'page.deleted', detail: { page: root.id, name: root.name, pages: ids.length, why: `in the trash for more than ${days} days` } });
    }
    if (!gone.size) return { result: 0 };
    const ops: WsOp[] = [...gone].flatMap((id) => [remove('trash', id), remove('docs', id)]);
    // A link to a page that no longer exists is taken off every page that still does.
    for (const [id, doc] of Object.entries(state.ws.docs)) {
      if (gone.has(id) || !Array.isArray(doc.blocks)) continue;
      const left = doc.blocks.filter((b) => !(b.type === 'page' && gone.has(b.file)));
      if (left.length !== doc.blocks.length) ops.push(patch('docs', id, { blocks: left }));
    }
    const log = roots.length === 1 ? `Deleted the page “${roots[0]!.name}” for good: it had been in the trash for ${days} days` : `Deleted ${roots.length} pages for good: they had been in the trash for ${days} days`;
    return { state: reduce(loaded, state, { type: 'ws', ops, log }), result: gone.size };
  });
}
