/**
 * Editing a Drive file in Timmy's own editors and saving it back over the original (src/files/drive-edit.ts and
 * drive-write.ts). A Google Doc, Sheet or deck opens as the Office file of its kind; a Word, Excel, PowerPoint or PDF
 * file kept in Drive opens as it is. A save is the person's own press of Save, recorded in the Action gateway as
 * `file.update`, and only goes through when the bytes are theirs, the right kind, and Drive's copy hasn't changed
 * since they opened it. OneDrive files open to read only.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { docxOf, OFFICE_TYPES, pptxOf, xlsxOf } from '../src/testing/composio-files';
import type { EffectRow } from '../src/gateway/gateway';
import { addMember, boot, connectApp, fake, jobs, newWorkspace, rows, uploadFile, type Client } from './helpers';

let w: Client;
let drive: { connectionId: string; account: string };

const add = async (f: Record<string, unknown> & { name: string }, conn = drive) => {
  fake().addFile(conn.account, f);
  const { syncFiles } = await import('../src/sync/files');
  const { syncOneDrive } = await import('../src/sync/onedrive');
  await (conn === drive ? syncFiles : syncOneDrive)(w.workspaceId, conn.connectionId);
  return (await rows<{ id: string }>(`select id from item where workspace_id = $1 and kind = 'file' and subject = $2`, [w.workspaceId, f.name]))[0]!.id;
};
const fileOf = (name: string, account = drive.account) => fake().accounts.get(account)!.files.find((f) => f.name === name)!;

/** Opens a file the way the editor screen does. */
const open = async (c: Client, id: string) => {
  const r = await c.request('GET', `/api/v1/connected-files/${id}/office`);
  const h = (k: string) => r.headers.get(k) ?? '';
  if (r.status !== 200) return { status: r.status, error: ((await r.json()) as { error: string }).error };
  return {
    status: r.status,
    bytes: new Uint8Array(await r.arrayBuffer()),
    type: h('content-type'),
    name: decodeURIComponent(h('x-timmy-name')),
    format: h('x-timmy-format'),
    app: h('x-timmy-app'),
    version: h('x-timmy-version'),
    saves: h('x-timmy-saves') === '1',
    reason: decodeURIComponent(h('x-timmy-reason')),
  };
};

/** Saves the way the editor screen does: upload the edited file, then ask for it to be saved over the original. */
const ENDINGS: Record<string, string> = { [OFFICE_TYPES.docx]: 'docx', [OFFICE_TYPES.xlsx]: 'xlsx', [OFFICE_TYPES.pptx]: 'pptx', 'application/pdf': 'pdf' };
const save = async (c: Client, id: string, bytes: Uint8Array, type: string, version: string, name = `edited.${ENDINGS[type]}`) => {
  const up = await uploadFile(c, { purpose: 'attachment', type, bytes, name });
  expect(up.status).toBe(200);
  const r = await c.post(`/api/v1/connected-files/${id}/save`, { asset: up.assetId, version });
  return { status: r.status, body: (await r.json()) as { ok?: boolean; version?: string; error?: string }, asset: up.assetId };
};
const saves = () => rows<EffectRow>(`select * from effect where workspace_id = $1 and kind = 'file.update' order by created_at`, [w.workspaceId]);

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  jobs().queue = [];
  w = await newWorkspace('Editors');
  drive = await connectApp(w, 'gdrive', 'owner@editors.test');
  jobs().queue = [];
});

describe('opening a Drive file in Timmy’s editor', () => {
  it('a Google Doc, Sheet and deck open as Word, Excel and PowerPoint files, with Drive’s version', async () => {
    const doc = await add({ name: 'Acme brief', text: 'Launch by March 3' });
    const o = await open(w, doc);
    expect(o).toMatchObject({ status: 200, type: OFFICE_TYPES.docx, name: 'Acme brief.docx', format: 'docx', app: 'wordcraft', saves: true });
    expect(o.version).toBe(fileOf('Acme brief').modifiedTime);
    expect(Buffer.from(o.bytes!).equals(Buffer.from(docxOf('Launch by March 3')))).toBe(true);

    const sheet = await add({ name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', rows: [['Item', 'Cost'], ['Design', 12000]] });
    expect(await open(w, sheet)).toMatchObject({ status: 200, name: 'Budget.xlsx', app: 'gridcraft', saves: true });
    const deck = await add({ name: 'Pitch', mimeType: 'application/vnd.google-apps.presentation', text: 'Welcome\n\nThe plan' });
    expect(await open(w, deck)).toMatchObject({ status: 200, name: 'Pitch.pptx', app: 'deckcraft', saves: true });
  });

  it('Office and PDF files kept in Drive open as they are; the viewer says which editor opens what', async () => {
    const word = await add({ name: 'Contract.docx', mimeType: OFFICE_TYPES.docx, text: 'Terms' });
    expect(await open(w, word)).toMatchObject({ status: 200, name: 'Contract.docx', app: 'wordcraft', saves: true });
    const pdf = await add({ name: 'Signed.pdf', mimeType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4\nhello\n%%EOF\n') });
    const p = await open(w, pdf);
    expect(p).toMatchObject({ status: 200, app: 'pdfcraft', type: 'application/pdf' });
    expect(new TextDecoder().decode(p.bytes)).toContain('%PDF-1.4');
    const viewed = (await (await w.request('GET', `/api/v1/connected-files/${word}/view`)).json()) as { edit?: unknown };
    expect(viewed.edit).toEqual({ app: 'wordcraft', saves: true, native: false });
    const image = await add({ name: 'Logo.png', mimeType: 'image/png' });
    expect(((await (await w.request('GET', `/api/v1/connected-files/${image}/view`)).json()) as { edit?: unknown }).edit).toBeUndefined();
    expect((await open(w, image)).status).toBe(415);
  });

  it('a file shared to view only opens, but says it can’t be saved back', async () => {
    const id = await add({ name: 'Their plan', text: 'Not yours', readOnly: true, owner: 'boss@else.test' });
    const o = await open(w, id);
    expect(o).toMatchObject({ status: 200, saves: false });
    expect(o.reason).toMatch(/view this file but not change it/);
  });

  it('only a file on this workspace’s list, and only for someone who may read the workspace', async () => {
    const other = await newWorkspace('Elsewhere');
    const id = await add({ name: 'Private notes', text: 'Mine' });
    expect((await open(other, id)).status).toBe(404);
    expect((await open(w, 'item_nope')).status).toBe(404);
  });
});

describe('saving back to Drive', () => {
  it('replaces the Drive file’s content, through the gateway, with the person’s press of Save as the approval', async () => {
    const id = await add({ name: 'Acme brief', text: 'Launch by March 3' });
    const o = await open(w, id);
    const r = await save(w, id, docxOf('Launch by March 10\nBudget agreed'), OFFICE_TYPES.docx, o.version!);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    // Drive has the new words, and a new version the editor keeps for its next save.
    const f = fileOf('Acme brief');
    expect(f.text).toBe('Launch by March 10\nBudget agreed');
    expect(f.uploads).toBe(1);
    expect(r.body.version).toBe(f.modifiedTime);
    expect(r.body.version).not.toBe(o.version);
    // The file went through Composio's store for this very tool, and the tool was only run by the gateway's executor.
    const call = fake().calls.filter((c) => c.slug === 'GOOGLEDRIVE_UPLOAD_UPDATE_FILE').at(-1)!;
    expect(call.args).toMatchObject({ fileId: f.id, uploadType: 'media', file_to_upload: { name: 'Acme brief.docx', mimetype: OFFICE_TYPES.docx } });
    const [e] = await saves();
    expect(e).toMatchObject({ status: 'completed', source: 'user', requested_by: w.userId, approved_by: w.userId, approved_via: 'click', target: `file:${id}` });
    expect(e!.payload).toMatchObject({ fileId: f.id, itemId: id, format: 'docx', asset: r.asset, version: o.version });
    const log = await rows<{ action: string }>(`select action from audit_log where effect_id = $1 order by id`, [e!.id]);
    expect(log.map((l) => l.action)).toEqual(['effect.proposed', 'effect.approved', 'effect.executing', 'effect.completed']);

    // A second save with the version the first one returned goes through too.
    const again = await save(w, id, docxOf('Launch by March 12'), OFFICE_TYPES.docx, r.body.version!);
    expect(again.status).toBe(200);
    expect(fileOf('Acme brief').text).toBe('Launch by March 12');
  });

  it('a Sheet and a deck take their own kind of file', async () => {
    const sheet = await add({ name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', rows: [['Item', 'Cost']] });
    const o = await open(w, sheet);
    expect((await save(w, sheet, xlsxOf([['Item', 'Cost'], ['Design', 15000]]), OFFICE_TYPES.xlsx, o.version!)).status).toBe(200);
    expect(fileOf('Budget').rows).toEqual([['Item', 'Cost'], ['Design', '15000']]);
    const deck = await add({ name: 'Pitch', mimeType: 'application/vnd.google-apps.presentation', text: 'Welcome' });
    const d = await open(w, deck);
    expect((await save(w, deck, pptxOf('Welcome\n\nNew slide'), OFFICE_TYPES.pptx, d.version!)).status).toBe(200);
    expect(fileOf('Pitch').text).toBe('Welcome\n\nNew slide');
  });

  it('stops when someone changed the file in Drive after it was opened, and says which version Drive has now', async () => {
    const id = await add({ name: 'Shared plan', text: 'v1' });
    const o = await open(w, id);
    // A colleague edits it in Google Docs meanwhile.
    const f = fileOf('Shared plan');
    f.text = 'v1 plus their edit';
    f.modifiedTime = new Date(Date.parse(f.modifiedTime) + 60_000).toISOString();
    const r = await save(w, id, docxOf('my edit'), OFFICE_TYPES.docx, o.version!);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Someone changed this file in Google Drive after you opened it/);
    expect(r.body.version).toBe(f.modifiedTime);
    expect(f.text).toBe('v1 plus their edit');
    expect(f.uploads).toBeUndefined();
    // Nothing was proposed: there was nothing to approve.
    expect(await saves()).toHaveLength(0);
    // Saving over theirs on purpose: the person saves again with the version Drive has now.
    const over = await save(w, id, docxOf('my edit'), OFFICE_TYPES.docx, r.body.version!);
    expect(over.status).toBe(200);
    expect(f.text).toBe('my edit');
  });

  it('refuses bytes that aren’t the file’s kind, an upload that isn’t the person’s, and a file they may only view', async () => {
    const id = await add({ name: 'Acme brief', text: 'v1' });
    const o = await open(w, id);
    expect((await save(w, id, new TextEncoder().encode('%PDF-1.4\nnot a doc\n%%EOF\n'), 'application/pdf', o.version!)).body.error).toMatch(/isn’t a \.docx file/);
    // Someone else's upload in the same workspace.
    const member = await addMember(w.workspaceId, 'member');
    const theirs = await uploadFile(member, { purpose: 'attachment', type: OFFICE_TYPES.docx, bytes: docxOf('sneaky'), name: 'x' });
    const r = await w.post(`/api/v1/connected-files/${id}/save`, { asset: theirs.assetId, version: o.version });
    expect(r.status).toBe(400);
    expect(fileOf('Acme brief').text).toBe('v1');

    const ro = await add({ name: 'Their plan', text: 'Not yours', readOnly: true, owner: 'boss@else.test' });
    const ro1 = await open(w, ro);
    const refused = await save(w, ro, docxOf('mine now'), OFFICE_TYPES.docx, ro1.version!);
    expect(refused.status).toBe(403);
    expect(fileOf('Their plan').text).toBe('Not yours');
    expect(await saves()).toHaveLength(0);
  });

  it('a viewer can open but not save; the workspace’s off switch stops saves too', async () => {
    const id = await add({ name: 'Acme brief', text: 'v1' });
    // RevOps may read the workspace but not make changes in it.
    const viewer = await addMember(w.workspaceId, 'revops');
    const o = await open(viewer, id);
    expect(o.status).toBe(200);
    const up = await uploadFile(viewer, { purpose: 'attachment', type: OFFICE_TYPES.docx, bytes: docxOf('viewer edit'), name: 'mine.docx' });
    const r = await viewer.post(`/api/v1/connected-files/${id}/save`, { asset: up.assetId || 'asset_none', version: o.version });
    expect(r.status).toBe(403);
    expect(fileOf('Acme brief').text).toBe('v1');

    await rows(`update workspace set kill_switch = true where id = $1`, [w.workspaceId]);
    const o2 = await open(w, id);
    const off = await save(w, id, docxOf('while off'), OFFICE_TYPES.docx, o2.version!);
    expect(off.status).toBe(403);
    expect(fileOf('Acme brief').text).toBe('v1');
  });

  it('when Drive refuses, the save says so and the file is unchanged; a lost answer is never called a success', async () => {
    const id = await add({ name: 'Acme brief', text: 'v1' });
    const o = await open(w, id);
    fake().failNext.set('GOOGLEDRIVE_UPLOAD_UPDATE_FILE', 'error');
    const r = await save(w, id, docxOf('v2'), OFFICE_TYPES.docx, o.version!);
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/Google Drive refused the save/);
    expect(fileOf('Acme brief').text).toBe('v1');
    expect((await saves())[0]!.status).toBe('failed');

    fake().failNext.set('GOOGLEDRIVE_UPLOAD_UPDATE_FILE', 'sent-then-timeout');
    const lost = await save(w, id, docxOf('v3'), OFFICE_TYPES.docx, o.version!);
    expect(lost.status).toBe(504);
    expect(lost.body.error).toMatch(/didn’t confirm the save/);
    expect((await saves())[1]!.status).toBe('uncertain');
  });

  it('nothing but the gateway’s executor can write to Drive: the read-only guard still refuses the tool', async () => {
    const { callTool } = await import('../src/sync/tools');
    const before = fake().calls.length;
    const res = await callTool(w.workspaceId, drive.connectionId, 'GOOGLEDRIVE_UPLOAD_UPDATE_FILE', { fileId: 'x', file_to_upload: { name: 'a', mimetype: 'a/b', s3key: 'k' } }, 'agent');
    expect(res).toMatchObject({ successful: false, error: expect.stringMatching(/only reads this app/) });
    expect(fake().calls.slice(before).some((c) => c.slug === 'GOOGLEDRIVE_UPLOAD_UPDATE_FILE')).toBe(false);
  });
});

describe('OneDrive', () => {
  it('opens to read in the editor; saving back isn’t offered', async () => {
    const one = await connectApp(w, 'onedrive', 'owner@editors.test');
    const id = await add({ name: 'Notes.docx', mimeType: OFFICE_TYPES.docx, text: 'From OneDrive' }, one);
    const o = await open(w, id);
    expect(o).toMatchObject({ status: 200, app: 'wordcraft', saves: false });
    expect(o.reason).toMatch(/Saving back to OneDrive isn’t available yet/);
    const r = await save(w, id, docxOf('changed'), OFFICE_TYPES.docx, 'x');
    expect(r.status).toBe(400);
    expect(fileOf('Notes.docx', one.account).text).toBe('From OneDrive');
  });
});
