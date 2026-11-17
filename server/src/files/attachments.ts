/**
 * Files that go out with an email.
 *
 * A file is uploaded first, like any other asset. When the email is prepared for approval, each attached file
 * is written into the email's effect record by asset id, name, type, size and the SHA-256 of its bytes. That
 * record cannot change afterwards, and it is what the approver is shown. At send time the bytes are read again
 * and must still hash to the same value: if a file changed or is gone, the email fails cleanly and nothing
 * goes out. So the file that is sent is the file that was approved.
 *
 * A file that a virus scanner has not found clean, on a server that scans, can't be attached or sent (see assets.ts).
 */
import { MAX_ATTACHMENTS, MAX_ATTACHMENTS_BYTES, fileSize } from '../../../src/lib/files';
import type { Tx } from '../db/pool';
import { log } from '../lib/log';
import { composio, type StagedFile } from '../providers/composio';
import { meter, type ConnectionRow } from '../sync/tools';
import { USABLE, readAsset, sha256Of, type AssetRow } from './assets';

/** One attached file, as approved. Stored in the effect's payload. */
export interface ApprovedFile {
  assetId: string;
  name: string;
  type: string;
  size: number;
  sha256: string;
}

/** An approved file with its bytes, read back and checked, ready to hand to the mail provider. */
export interface FileToSend extends ApprovedFile {
  bytes: Uint8Array;
}

/**
 * Reads the files a message says it carries and returns them as they will be approved. Each must be an
 * uploaded attachment of this workspace, and what the screen says about it (name, type, size) must be what
 * was uploaded, so the thread never shows one file while another is sent.
 */
export async function attachmentsFor(tx: Tx, workspaceId: string, files: unknown, mailbox?: { name: string; maxFileBytes: number }): Promise<{ ok: true; files: ApprovedFile[] } | { ok: false; reason: string }> {
  if (files === undefined || files === null) return { ok: true, files: [] };
  const refuse = (reason: string) => ({ ok: false as const, reason });
  if (!Array.isArray(files)) return refuse('That attachment isn’t in a form Timmy can send.');
  if (files.length > MAX_ATTACHMENTS) return refuse(`An email can carry up to ${MAX_ATTACHMENTS} files.`);
  const out: ApprovedFile[] = [];
  for (const f of files as { id?: unknown; name?: unknown; type?: unknown; size?: unknown }[]) {
    if (typeof f !== 'object' || f === null || typeof f.id !== 'string' || !/^[\w-]{1,80}$/.test(f.id)) return refuse('That attachment isn’t in a form Timmy can send.');
    if (out.some((x) => x.assetId === f.id)) return refuse('The same file is attached twice. Remove one.');
    // Looked up inside this workspace's scope: another workspace's file is simply not found.
    const row = (await tx.query(`select * from asset where id = $1 and workspace_id = $2 and ${USABLE()} and purpose = 'attachment'`, [f.id, workspaceId])).rows[0] as AssetRow | undefined;
    if (!row || !row.sha256 || !row.name) return refuse('An attached file isn’t in Timmy any more. Attach it again.');
    if (f.name !== row.name || f.type !== row.content_type || f.size !== row.size_bytes) return refuse('An attachment isn’t the file that was uploaded. Attach it again.');
    out.push({ assetId: row.id, name: row.name, type: row.content_type, size: row.size_bytes, sha256: row.sha256 });
  }
  const total = out.reduce((n, f) => n + f.size, 0);
  if (total > MAX_ATTACHMENTS_BYTES) return refuse(`These attachments are ${fileSize(total)} together. An email can carry up to ${fileSize(MAX_ATTACHMENTS_BYTES)}.`);
  // Some mailboxes take smaller files than Timmy keeps. Said now, rather than after the email has waited to go out.
  const tooBig = mailbox && out.find((f) => f.size > mailbox.maxFileBytes);
  if (tooBig && mailbox) return refuse(`“${tooBig.name}” is ${fileSize(tooBig.size)}. From ${mailbox.name}, Timmy can send files up to ${fileSize(mailbox.maxFileBytes)} each. Send it from ${mailbox.name} itself, or share a link to it.`);
  return { ok: true, files: out };
}

/** What the approver is shown for each file. */
export const previewOf = (files: ApprovedFile[]) => files.map((f) => ({ name: f.name, type: f.type, size: f.size }));

/**
 * Reads the approved files back at send time. Every one must still be there, and its bytes must still be the
 * bytes that were approved. A failure here means nothing has been sent.
 */
export async function filesToSend(workspaceId: string, approved: unknown): Promise<{ ok: true; files: FileToSend[] } | { ok: false; error: string }> {
  if (approved === undefined || approved === null) return { ok: true, files: [] };
  const fail = (error: string) => ({ ok: false as const, error });
  if (!Array.isArray(approved) || approved.length > MAX_ATTACHMENTS) return fail('The email’s attachments could not be read, so it was not sent.');
  const out: FileToSend[] = [];
  for (const a of approved as ApprovedFile[]) {
    if (!a || typeof a.assetId !== 'string' || typeof a.sha256 !== 'string' || typeof a.name !== 'string' || typeof a.type !== 'string') return fail('The email’s attachments could not be read, so it was not sent.');
    let found: Awaited<ReturnType<typeof readAsset>>;
    try {
      found = await readAsset(workspaceId, a.assetId);
    } catch (e) {
      // Nothing has been asked of the mail provider yet, so not being able to read the file is a clean failure.
      log.warn('an attachment could not be read back', { assetId: a.assetId, error: (e as Error).message });
      return fail(`The attached file “${a.name}” could not be read, so the email was not sent.`);
    }
    if (!found) return fail(`The attached file “${a.name}” is no longer in Timmy, so the email was not sent.`);
    const { asset, bytes } = found;
    if (asset.sha256 !== a.sha256 || asset.name !== a.name || asset.content_type !== a.type || bytes.length !== a.size || sha256Of(bytes) !== a.sha256) return fail(`The attached file “${a.name}” changed after the email was approved, so the email was not sent.`);
    out.push({ ...a, bytes });
  }
  return { ok: true, files: out };
}

/**
 * Hands the files to Composio for one tool call, the way its client does: each file goes to Composio's own
 * store and the tool is given a reference to it (name, type and a key). The reference is made for the tool
 * that will use it. If a file can't be handed over, nothing has been sent, and the caller reports a clean failure.
 */
export async function stageFiles(workspaceId: string, conn: ConnectionRow, toolSlug: string, files: FileToSend[]): Promise<{ ok: true; staged: StagedFile[] } | { ok: false; error: string }> {
  const staged: StagedFile[] = [];
  for (const f of files) {
    const started = Date.now();
    try {
      const ref = await composio().stageFile({ toolSlug, toolkit: conn.toolkit, name: f.name, type: f.type, bytes: f.bytes });
      await meter(workspaceId, 'FILES_UPLOAD', 'send', true, Date.now() - started);
      // The name and type the provider is given are the approved ones, whatever the hand-over echoed back.
      staged.push({ name: f.name, mimetype: f.type, s3key: ref.s3key });
    } catch (e) {
      await meter(workspaceId, 'FILES_UPLOAD', 'send', false, Date.now() - started);
      log.warn('an attachment could not be handed to the mail provider', { toolSlug, error: (e as Error).message });
      return { ok: false, error: `The attached file “${f.name}” could not be handed to the mail provider, so the email was not sent.` };
    }
  }
  return { ok: true, staged };
}
