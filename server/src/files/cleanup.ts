/**
 * Deleting uploaded files that nothing uses any more, and scanning files kept before a virus scanner was set up.
 *
 * A file counts as used while any of these mentions it:
 *   - a page, in the workspace or in its trash (a picture, a cover, anything in its contents);
 *   - a kept version of a page, including the hidden versions of a page deleted for good, which Undo may bring back;
 *   - a draft on a thread (a file attached to it);
 *   - an email effect that is waiting for approval, held in its undo window, going out, or whose outcome is not
 *     yet known (its approved attachments are read again when it goes out);
 *   - the website chat's settings (its picture).
 * The test is deliberately broad: an asset's id appearing anywhere in those places keeps the file, so a mention
 * this file doesn't understand errs on the side of keeping, never of deleting.
 *
 * A file has to be found unused on every pass for the whole grace period (7 days) before it goes, and it is never
 * deleted within the grace period of its upload. That covers a picture that is only on a screen that hasn't saved
 * yet, and Undo of the change that took a picture off a page. The check and the deletion happen in one transaction
 * holding the workspace's lock, the lock every change to the workspace's state takes, so nothing can start using
 * a file between the two. The bytes are removed from the store after the record is gone; if that fails, the bytes
 * stay until the workspace is deleted, but nothing can refer to them.
 *
 * Deleting a workspace already removes all of its files (assets.ts).
 */
import { config } from '../config';
import { sysPool, withWorkspace, type Tx } from '../db/pool';
import { audit } from '../gateway/gateway';
import { log } from '../lib/log';
import { scanning, virusScanner } from './scan';
import { fileStore, filesReady } from './store';

/** The asset ids among `ids` that something in the workspace still uses. */
export async function filesInUse(tx: Tx, workspaceId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { rows } = await tx.query(
    `select a.id from unnest($2::text[]) as a(id)
      where exists (select 1 from state_doc d where d.workspace_id = $1 and d.slice in ('ws.docs', 'ws.chat') and strpos(d.data::text, a.id) > 0)
         or exists (select 1 from state_doc d where d.workspace_id = $1 and d.slice = 'threads' and strpos(coalesce((d.data->'draft')::text, ''), a.id) > 0)
         or exists (select 1 from doc_revision r where r.workspace_id = $1 and strpos(r.blocks::text || coalesce(r.cover::text, '') || coalesce(r.icon, ''), a.id) > 0)
         or exists (select 1 from effect e where e.workspace_id = $1 and e.kind in ('email.send', 'email.reply') and e.status in ('intended', 'approved', 'executing', 'uncertain') and strpos(e.payload::text, a.id) > 0)`,
    [workspaceId, ids],
  );
  return new Set(rows.map((r) => r.id as string));
}

/** One workspace's pass. Returns how many files went. */
export async function cleanUpWorkspaceFiles(workspaceId: string, graceDays = config.files.unusedGraceDays): Promise<number> {
  const gone = await withWorkspace({ workspaceId, lock: true }, async (tx) => {
    const all = (await tx.query(`select id from asset where workspace_id = $1 and uploaded_at is not null`, [workspaceId])).rows.map((r) => r.id as string);
    if (!all.length) return [];
    const used = await filesInUse(tx, workspaceId, all);
    const unused = all.filter((id) => !used.has(id));
    // Used again (Undo, a version put back): the clock starts afresh the next time it is unused.
    await tx.query(`update asset set unused_since = null where workspace_id = $1 and id = any($2::text[]) and unused_since is not null`, [workspaceId, [...used]]);
    await tx.query(`update asset set unused_since = now() where workspace_id = $1 and id = any($2::text[]) and unused_since is null`, [workspaceId, unused]);
    const { rows } = await tx.query(
      `delete from asset where workspace_id = $1 and id = any($2::text[])
          and unused_since < now() - make_interval(days => $3::int) and uploaded_at < now() - make_interval(days => $3::int)
        returning id, storage_key, name, purpose`,
      [workspaceId, unused, graceDays],
    );
    if (rows.length) await audit(tx, workspaceId, { actor: 'system', action: 'file.deleted', detail: { files: rows.length, why: `unused for ${graceDays} days` } });
    return rows as { id: string; storage_key: string }[];
  });
  for (const f of gone) {
    try {
      await fileStore().remove(f.storage_key);
    } catch (e) {
      log.warn('an unused file’s bytes could not be removed from the store', { workspaceId, assetId: f.id, error: (e as Error).message });
    }
  }
  return gone.length;
}

/** The whole pass: every workspace that has uploaded files. Run by a job as the system role, one workspace at a time. */
export async function cleanUpUnusedFiles(graceDays = config.files.unusedGraceDays): Promise<number> {
  if (!filesReady()) return 0;
  const { rows } = await sysPool.query(`select distinct a.workspace_id from asset a join workspace w on w.id = a.workspace_id where a.uploaded_at is not null and w.deleted_at is null`);
  let removed = 0;
  for (const r of rows) {
    try {
      removed += await cleanUpWorkspaceFiles(r.workspace_id as string, graceDays);
    } catch (e) {
      log.warn('the unused-file pass failed for a workspace', { workspaceId: r.workspace_id, error: (e as Error).message });
    }
  }
  return removed;
}

/**
 * Scans files kept before a virus scanner was set up. Until a file is scanned clean, a server that scans won't let
 * anything use it (see `USABLE`); this pass catches them up, a batch at a time. An infected one is deleted, record
 * and bytes. When the scanner can't be asked, the pass stops and the next one tries again.
 */
export async function scanBacklog(limit = 50): Promise<{ scanned: number; infected: number }> {
  const scanner = virusScanner();
  const out = { scanned: 0, infected: 0 };
  if (!scanner || !filesReady() || !scanning()) return out;
  const { rows } = await sysPool.query(`select id, workspace_id, storage_key, name from asset where uploaded_at is not null and scan is distinct from 'clean' order by uploaded_at limit $1`, [limit]);
  for (const r of rows as { id: string; workspace_id: string; storage_key: string; name: string | null }[]) {
    const bytes = await fileStore().get(r.storage_key);
    if (!bytes) continue;
    let verdict;
    try {
      verdict = await scanner.scan(bytes);
    } catch (e) {
      log.warn('the virus scanner could not be asked; the backlog waits for the next pass', { error: (e as Error).message });
      break;
    }
    out.scanned++;
    if (verdict.clean) {
      await sysPool.query(`update asset set scan = 'clean' where id = $1`, [r.id]);
      continue;
    }
    out.infected++;
    await withWorkspace({ workspaceId: r.workspace_id }, async (tx) => {
      await tx.query('delete from asset where id = $1 and workspace_id = $2', [r.id, r.workspace_id]);
      await audit(tx, r.workspace_id, { actor: 'system', action: 'file.deleted', detail: { why: 'virus', virus: verdict.virus, name: r.name } });
    });
    await fileStore()
      .remove(r.storage_key)
      .catch((e: Error) => log.warn('an infected file’s bytes could not be removed from the store', { assetId: r.id, error: e.message }));
  }
  return out;
}
