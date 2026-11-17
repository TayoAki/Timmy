/**
 * Version history for pages.
 *
 * A page's current contents live in the workspace's state. Whenever a save replaces them, what the page
 * held just before is kept here as a version, so a person can look back and put an older copy back:
 *   - ordinary editing keeps at most one copy of a page every few minutes, so a burst of typing is one version;
 *   - a change Timmy makes (a summary it types in, a job writing into the page) always keeps one first;
 *   - putting an old version back always keeps what it replaces (see restore.ts).
 * A job removes copies past their keeping time. A page's copies go when the page is deleted for good.
 *
 * Every read and write here runs in a transaction scoped to one workspace, so row-level security is what
 * stands between one workspace's versions and another's.
 */
import type pg from 'pg';
import type { Block, DocCover } from '../../../src/data/ws-types';
import type { Patch } from '../../../src/live/patches';
import type { State } from '../../../src/state/store';
import { config } from '../config';
import { authPool, withWorkspace, type Tx } from '../db/pool';

export type VersionReason = 'edit' | 'before-timmy' | 'before-restore';

/** The parts of a page a version holds. Its name and its place in the tree are not versioned. */
export interface PageContents {
  blocks: Block[];
  icon?: string;
  cover?: DocCover;
}

export interface VersionSummary {
  number: number;
  at: Date;
  /** The person whose change these contents were kept ahead of, by name; "Timmy" when nobody was at the keyboard. */
  by: string;
  why: VersionReason;
  /** The first words on the page as it was. */
  preview: string;
  blockCount: number;
}

export interface Version extends VersionSummary, PageContents {}

/**
 * A change saved under an origin that starts like this comes from the page modules themselves (putting a version
 * back, emptying the trash). They keep their own copies, or mean to keep none, so the save hook below leaves them be.
 */
export const OWN_ORIGIN = 'page.';

export const contentsOf = (doc: { blocks: Block[]; icon?: string | null; cover?: DocCover | null }): PageContents => ({
  blocks: doc.blocks,
  ...(doc.icon ? { icon: doc.icon } : {}),
  ...(doc.cover ? { cover: doc.cover } : {}),
});

/** A value as text with every object's keys in one order. The database returns stored blocks with their keys reordered, so plain text can't be compared. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));

export const sameContents = (a: Parameters<typeof contentsOf>[0], b: Parameters<typeof contentsOf>[0]): boolean => canonical(contentsOf(a)) === canonical(contentsOf(b));

/** The first words of a page, on one line, for the list of versions. */
function firstWords(blocks: Block[]): string {
  for (const b of blocks) {
    const text = b.type === 'table' ? [...b.columns, ...(b.rows[0] ?? [])].join(' ') : 'text' in b && typeof b.text === 'string' ? b.text : '';
    const line = text.replace(/\s+/g, ' ').trim();
    if (line) return line.length > 140 ? `${line.slice(0, 139)}…` : line;
  }
  return '';
}

/** Postgres refuses the NUL character inside jsonb strings. */
const json = (value: unknown) => JSON.stringify(value).replace(/\\u0000/g, '');

/** Keeps `contents` as the page's next version and returns its number. Call with the workspace's lock held. */
export async function keepVersion(tx: Tx, workspaceId: string, pageId: string, contents: PageContents, author: string | null, reason: VersionReason): Promise<number> {
  const { rows } = await tx.query(
    `insert into doc_revision (workspace_id, file_id, version, blocks, icon, cover, author, reason, preview, block_count)
     select $1, $2, coalesce(max(version), 0) + 1, $3::jsonb, $4::text, $5::jsonb, $6::text, $7::text, $8::text, $9::int
       from doc_revision where workspace_id = $1 and file_id = $2
     returning version`,
    [workspaceId, pageId, json(contents.blocks), contents.icon ?? null, contents.cover ? json(contents.cover) : null, author, reason, firstWords(contents.blocks).replace(/\u0000/g, ''), contents.blocks.length],
  );
  // The number kept holds at every moment, not only after the hourly job: the oldest beyond it go now.
  await tx.query(
    `delete from doc_revision where workspace_id = $1 and file_id = $2 and version <= (
       select version from doc_revision where workspace_id = $1 and file_id = $2 order by version desc offset $3 limit 1)`,
    [workspaceId, pageId, config.pageVersionsKept],
  );
  return rows[0].version as number;
}

/** Whether a copy of this page was kept within the last few minutes, whatever the reason: the same burst of work. */
async function keptLately(tx: Tx, workspaceId: string, pageId: string): Promise<boolean> {
  const { rows } = await tx.query(`select 1 from doc_revision where workspace_id = $1 and file_id = $2 and created_at > now() - ($3::float8 * interval '1 minute') limit 1`, [workspaceId, pageId, config.pageVersionMinutes]);
  return rows.length > 0;
}

/**
 * Called by every save of a workspace's state, inside the saving transaction, with the state as it was and the
 * changes about to be stored. A page whose contents are being replaced has its earlier contents kept; a page
 * that is being deleted for good loses its versions with it.
 *
 * Who made the change is the person the transaction is scoped to: a command runs as the person who sent it,
 * and server code (sync, jobs, the agent) runs as nobody, which is recorded as Timmy's change.
 */
export async function keepPageVersions(tx: Tx, workspaceId: string, before: State, patches: Patch[], origin: string): Promise<void> {
  for (const p of patches) {
    if (p.s !== 'ws.docs' || !('id' in p)) continue;
    if ('rm' in p) {
      await tx.query('delete from doc_revision where workspace_id = $1 and file_id = $2', [workspaceId, p.id]);
      continue;
    }
    const was = before.ws.docs[p.id];
    // A new page has no earlier contents to keep.
    if (!was || !Array.isArray(was.blocks) || origin.startsWith(OWN_ORIGIN)) continue;
    const now = p.v as PageContents;
    if (!Array.isArray(now?.blocks) || sameContents(was, now)) continue;
    const typed = origin.startsWith('cmd:');
    if (typed && (await keptLately(tx, workspaceId, p.id))) continue;
    const person = typed ? ((await tx.query(`select nullif(current_setting('app.user_id', true), '') as id`)).rows[0].id as string | null) : null;
    await keepVersion(tx, workspaceId, p.id, contentsOf(was), person, typed ? 'edit' : 'before-timmy');
  }
}

/**
 * Keeps a page's contents because Timmy is about to write into it for this person (a summary the editor types in).
 * Takes the workspace's lock, so the version number can't collide with a save happening at the same moment.
 */
export async function keepBeforeTimmy(workspaceId: string, userId: string, pageId: string, contents: PageContents): Promise<number> {
  return withWorkspace({ workspaceId, userId, lock: true }, (tx) => keepVersion(tx, workspaceId, pageId, contents, userId, 'before-timmy'));
}

/* ───────────── Reading ───────────── */

const NOBODY = 'Timmy';
const GONE = 'Someone who has left';

/** Names for the people who made the changes. The sign-in tables are outside the app role's reach, so they are asked separately. */
async function namesOf(ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (!wanted.length) return new Map();
  const { rows } = await authPool.query('select id, name from "user" where id = any($1::text[])', [wanted]);
  return new Map(rows.map((r) => [r.id as string, r.name as string]));
}

interface Row {
  version: number;
  created_at: Date;
  author: string | null;
  reason: VersionReason;
  preview: string;
  block_count: number;
}

const summary = (r: Row, names: Map<string, string>): VersionSummary => ({
  number: r.version,
  at: r.created_at,
  by: r.author ? (names.get(r.author) ?? GONE) : NOBODY,
  why: r.reason,
  preview: r.preview,
  blockCount: r.block_count,
});

/** Only copies still inside their keeping time are shown or put back, whether or not the clean-up job has run yet. */
const KEPT = `created_at > now() - make_interval(days => $3::int)`;

/** A page's versions, newest first, without their blocks. */
export async function listVersions(tx: Tx, workspaceId: string, pageId: string): Promise<VersionSummary[]> {
  const { rows } = await tx.query(
    `select version, created_at, author, reason, preview, block_count from doc_revision where workspace_id = $1 and file_id = $2 and ${KEPT} order by version desc limit $4`,
    [workspaceId, pageId, config.pageVersionDays, config.pageVersionsKept],
  );
  const names = await namesOf(rows.map((r) => r.author as string | null));
  return (rows as Row[]).map((r) => summary(r, names));
}

/** One version with its contents, or null when there is none by that number. */
export async function readVersion(tx: Tx, workspaceId: string, pageId: string, number: number): Promise<Version | null> {
  const { rows } = await tx.query(
    `select version, created_at, author, reason, preview, block_count, blocks, icon, cover from doc_revision where workspace_id = $1 and file_id = $2 and ${KEPT} and version = $4`,
    [workspaceId, pageId, config.pageVersionDays, number],
  );
  const r = rows[0] as (Row & { blocks: Block[]; icon: string | null; cover: DocCover | null }) | undefined;
  if (!r) return null;
  return { ...summary(r, await namesOf([r.author])), ...contentsOf(r) };
}

/* ───────────── Clean-up ───────────── */

/**
 * Removes copies past their keeping time, across every workspace: anything older than the keeping days, and
 * anything beyond the newest copies of one page. Run by a job as the system role.
 */
export async function pruneVersions(pool: pg.Pool, keep = config.pageVersionsKept, days = config.pageVersionDays): Promise<number> {
  const old = await pool.query(`delete from doc_revision where created_at < now() - make_interval(days => $1::int)`, [days]);
  // Only pages that hold too many are looked at, and only by their keys: no blocks are read to decide what goes.
  const extra = await pool.query(
    `delete from doc_revision d using (
       select workspace_id, file_id, version, row_number() over (partition by workspace_id, file_id order by version desc) as place
         from doc_revision
        where (workspace_id, file_id) in (select workspace_id, file_id from doc_revision group by workspace_id, file_id having count(*) > $1::int)
     ) r
     where r.place > $1::int and d.workspace_id = r.workspace_id and d.file_id = r.file_id and d.version = r.version`,
    [keep],
  );
  return (old.rowCount ?? 0) + (extra.rowCount ?? 0);
}
