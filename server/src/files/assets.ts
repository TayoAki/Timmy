/**
 * Assets: the record of every uploaded file, and the only code that reads or writes one.
 *
 * An upload happens in two steps. The browser first says what it is about to send; that is checked and
 * recorded. Then the bytes arrive, are compared with what was announced, and go to the store. Only an asset
 * whose bytes arrived and matched can be shown, referenced by a page, or sent.
 *
 * Every query here runs inside the workspace's own scope, so an id from another workspace finds nothing.
 */
import { createHash } from 'node:crypto';
import { MAX_FILE_BYTES, PICTURE_TYPES, assetIdOf, fileSize, type UploadPurpose } from '../../../src/lib/files';
import { config } from '../config';
import { sysPool, withWorkspace, type Tx } from '../db/pool';
import { newId } from '../lib/ids';
import { log } from '../lib/log';
import { bytesProblem, readDeclared } from './rules';
import { fileStore, filesReady, storageKey } from './store';

export interface AssetRow {
  id: string;
  workspace_id: string;
  purpose: UploadPurpose;
  content_type: string;
  size_bytes: number;
  storage_key: string;
  name: string | null;
  sha256: string | null;
  created_by: string;
  created_at: Date;
  uploaded_at: Date | null;
}

export type Refused = { ok: false; status: number; reason: string };
const refuse = (status: number, reason: string): Refused => ({ ok: false, status, reason });

export const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Who is asking: the signed-in person, in the workspace their session is in, and whether their role may change it. */
export interface Uploader {
  workspaceId: string;
  userId: string;
  mayWork: boolean;
}

/** Step one: records what the browser says it will upload, if it is something Timmy keeps. */
export async function announceUpload(who: Uploader, body: unknown): Promise<{ ok: true; asset: AssetRow } | Refused> {
  if (!who.mayWork) return refuse(403, 'Your role can’t add files to this workspace.');
  const read = readDeclared(body);
  if (!read.ok) return refuse(read.status, read.reason);
  const d = read.declared;
  return withWorkspace({ workspaceId: who.workspaceId, userId: who.userId, lock: true }, async (tx) => {
    const used = (await tx.query(`select coalesce(sum(size_bytes), 0)::float8 as bytes, count(*) filter (where uploaded_at is null)::int as pending from asset where workspace_id = $1`, [who.workspaceId])).rows[0] as { bytes: number; pending: number };
    if (used.pending >= config.files.maxPendingUploads) return refuse(429, 'Too many uploads are still on their way. Wait for them to finish, then try again.');
    if (used.bytes + d.size > config.files.quotaBytes) return refuse(413, `This workspace has used its ${fileSize(config.files.quotaBytes)} of file space.`);
    const id = newId('ast');
    const { rows } = await tx.query(`insert into asset (id, workspace_id, purpose, content_type, size_bytes, storage_key, name, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`, [id, who.workspaceId, d.purpose, d.type, d.size, storageKey(who.workspaceId, id), d.name, who.userId]);
    return { ok: true as const, asset: rows[0] as AssetRow };
  });
}

const SIZE_MISMATCH = 'The file that arrived isn’t the size that was announced, so it wasn’t kept.';

/**
 * Asked before a request's body is read: is this an upload the person announced and has not finished, and is
 * the body the announced size? An answer of no costs the server nothing but this lookup.
 */
export async function expectUpload(who: Uploader, assetId: string, announcedLength: number | null): Promise<{ ok: true } | Refused> {
  if (!who.mayWork) return refuse(403, 'Your role can’t add files to this workspace.');
  const row = await withWorkspace({ workspaceId: who.workspaceId }, async (tx) => (await tx.query('select size_bytes, uploaded_at from asset where id = $1 and workspace_id = $2 and created_by = $3', [assetId, who.workspaceId, who.userId])).rows[0] as Pick<AssetRow, 'size_bytes' | 'uploaded_at'> | undefined);
  if (!row) return refuse(404, 'That upload isn’t known. Start it again.');
  if (row.uploaded_at) return refuse(409, 'That file was already uploaded.');
  if (announcedLength !== null && announcedLength !== row.size_bytes) return refuse(400, SIZE_MISMATCH);
  return { ok: true };
}

/**
 * Step two: the bytes. They must be exactly what was announced, by size and by kind, and an asset takes
 * its bytes once. Only the person who announced the upload can finish it.
 */
export async function receiveUpload(who: Uploader, assetId: string, bytes: Uint8Array, sentType: string | null): Promise<{ ok: true; asset: AssetRow } | Refused> {
  if (!who.mayWork) return refuse(403, 'Your role can’t add files to this workspace.');
  if (bytes.length > MAX_FILE_BYTES) return refuse(413, `Timmy keeps files up to ${fileSize(MAX_FILE_BYTES)}.`);
  // The row stays locked while the bytes go to the store, so two uploads for one asset can't both land.
  return withWorkspace({ workspaceId: who.workspaceId, userId: who.userId }, async (tx) => {
    const row = (await tx.query('select * from asset where id = $1 and workspace_id = $2 and created_by = $3 for update', [assetId, who.workspaceId, who.userId])).rows[0] as AssetRow | undefined;
    if (!row) return refuse(404, 'That upload isn’t known. Start it again.');
    if (row.uploaded_at) return refuse(409, 'That file was already uploaded.');
    if (sentType && sentType.split(';')[0]!.trim().toLowerCase() !== row.content_type) return refuse(415, 'The file that arrived isn’t the kind that was announced, so it wasn’t kept.');
    const bad = bytesProblem({ type: row.content_type, size: row.size_bytes }, bytes);
    if (bad) return refuse(400, bad);
    try {
      await fileStore().put(row.storage_key, bytes, row.content_type);
    } catch (e) {
      log.error('a file could not be stored', { assetId, error: (e as Error).message });
      return refuse(502, 'The file couldn’t be stored just now. Try again in a moment.');
    }
    const done = await tx.query('update asset set uploaded_at = now(), sha256 = $2 where id = $1 and uploaded_at is null returning *', [assetId, sha256Of(bytes)]);
    return { ok: true as const, asset: done.rows[0] as AssetRow };
  });
}

/** One uploaded asset of this workspace, or null: not this workspace's, not there, or its bytes never arrived. */
export async function uploadedAsset(workspaceId: string, assetId: string): Promise<AssetRow | null> {
  return withWorkspace({ workspaceId }, async (tx) => ((await tx.query('select * from asset where id = $1 and workspace_id = $2 and uploaded_at is not null', [assetId, workspaceId])).rows[0] as AssetRow | undefined) ?? null);
}

/** An uploaded asset with its bytes. Null when the asset or its bytes can't be found. Throws when the store can't be asked. */
export async function readAsset(workspaceId: string, assetId: string): Promise<{ asset: AssetRow; bytes: Uint8Array } | null> {
  const asset = await uploadedAsset(workspaceId, assetId);
  if (!asset) return null;
  const bytes = await fileStore().get(asset.storage_key);
  if (!bytes) {
    log.error('an asset’s bytes are missing from the store', { workspaceId, assetId });
    return null;
  }
  return { asset, bytes };
}

/* ───────────── Pictures that pages and settings refer to ───────────── */

/** Every asset id referred to anywhere inside a value (a page's blocks, a setting, an operation). */
export function assetRefsOf(value: unknown, found = new Set<string>()): Set<string> {
  const walk = (v: unknown, depth: number) => {
    if (found.size >= 2000 || depth > 12) return;
    if (typeof v === 'string') {
      const id = assetIdOf(v);
      if (id) found.add(id);
    } else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(value, 0);
  return found;
}

/**
 * Every asset id that a batch of workspace operations would leave referenced: those the operations carry, and
 * those already in a record an operation edits (the check looks at the record as it would become).
 */
export function assetRefsIn(current: (col: string, id: string) => unknown, ops: unknown): string[] {
  const found = new Set<string>();
  if (!Array.isArray(ops)) return [];
  for (const o of ops.slice(0, 400)) {
    assetRefsOf(o, found);
    const p = o as { op?: unknown; col?: unknown; id?: unknown } | null;
    if (p && p.op === 'patch' && typeof p.col === 'string' && typeof p.id === 'string') assetRefsOf(current(p.col, p.id), found);
  }
  return [...found];
}

/**
 * Which of these ids are pictures this workspace has uploaded, each with what it was uploaded for.
 * An id from anywhere else is simply not among them.
 */
export async function usablePictures(tx: Tx, workspaceId: string, ids: string[]): Promise<Map<string, UploadPurpose>> {
  if (!ids.length) return new Map();
  const { rows } = await tx.query('select id, purpose from asset where workspace_id = $1 and id = any($2::text[]) and uploaded_at is not null and content_type = any($3::text[])', [workspaceId, ids, PICTURE_TYPES]);
  return new Map(rows.map((r) => [r.id as string, r.purpose as UploadPurpose]));
}

/* ───────────── Removal ───────────── */

/**
 * Removes every file a workspace has in the store, and the records of them. Used when a workspace is deleted
 * and again when its remaining data is purged. The whole prefix is cleared, so a file whose record was lost
 * goes too. Returns how many files were removed.
 */
export async function removeWorkspaceFiles(workspaceId: string): Promise<number> {
  if (!/^[\w-]{1,120}$/.test(workspaceId)) return 0;
  // Only ever for a workspace a person deleted. Anything else asking is a mistake, and nothing is removed.
  const ws = (await sysPool.query('select deleted_at from workspace where id = $1', [workspaceId])).rows[0] as { deleted_at: Date | null } | undefined;
  if (ws && !ws.deleted_at) return 0;
  let removed = 0;
  // A server with no file store has kept no files; only the records (if any) are left to clear.
  if (filesReady()) {
    const store = fileStore();
    const keys = await store.list(`${workspaceId}/`);
    for (const key of keys) await store.remove(key);
    removed = keys.length;
  }
  await sysPool.query('delete from asset where workspace_id = $1', [workspaceId]);
  return removed;
}

/** Uploads that were announced and never arrived are forgotten after a day. Nothing can refer to them. */
export async function forgetAbandonedUploads(): Promise<number> {
  const { rowCount } = await sysPool.query(`delete from asset where uploaded_at is null and created_at < now() - interval '1 day'`);
  return rowCount ?? 0;
}
