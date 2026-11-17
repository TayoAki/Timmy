/**
 * Uploaded files after they arrive: pictures lose their metadata on the server, uploads are scanned for viruses
 * when a scanner is set up, and files nothing uses any more are deleted after a grace period.
 *
 * Safety properties this file holds:
 *   - no cross-workspace reads: one workspace mentioning another's file neither keeps it nor reaches it, and a
 *     workspace's clean-up never touches another's files;
 *   - what is approved is what is sent: an attachment is approved, hashed and sent as the cleaned copy;
 *   - nothing on any real network: the virus scanner is a stand-in on this machine.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withoutMetadata } from '../src/files/pictures';
import { ClamAV, setScannerForTests } from '../src/files/scan';
import { MemoryStore, fileStore, setFileStoreForTests } from '../src/files/store';
import { EICAR, startStandInClamd, type StandInClamd } from '../src/files/testing/clamd';
import { addMember, connectGmail, fake, jobs, newWorkspace, releaseHolds, rows, sendBytes, sysPool, uploadFile, boot, type Client } from './helpers';
import { exif, holds, jfifWithPreview, jpeg, jpegComment, png, pngChunk, pngText, webp, xmp } from './pictures';

let w: Client;
const enc = new TextEncoder();
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const memory = () => fileStore() as MemoryStore;
const stored = async (assetId: string, workspaceId = w.workspaceId) => memory().files.get(`${workspaceId}/${assetId}`);
const asset = async (id: string) => (await rows<{ id: string; size_bytes: number; sha256: string | null; uploaded_at: Date | null; scan: string | null; unused_since: Date | null }>('select id, size_bytes, sha256, uploaded_at, scan, unused_since from asset where id = $1', [id]))[0];
const download = async (c: Client, id: string) => {
  const res = await c.get(`/api/v1/assets/${id}`);
  return { status: res.status, bytes: res.status === 200 ? new Uint8Array(await res.arrayBuffer()) : null };
};
const runJob = async (name: string) => {
  await jobs().enqueue(name, {});
  await jobs().drain();
};

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  setFileStoreForTests(null);
  setScannerForTests(undefined);
  w = await newWorkspace('Files');
});
afterEach(() => {
  setScannerForTests(undefined);
});

/* ───────────── Metadata ───────────── */

describe('pictures lose their metadata on the server', () => {
  /** Everything a camera writes that says where, when, with what or by whom. */
  const LOCATION_WORDS = ['GPS', 'Secret Camera', 'xmpmeta', 'secret comment', 'trailing video'];

  it('a JPEG keeps its picture and which way up it is, and loses where it was taken, its comments, its preview and what follows its end', () => {
    const plain = jpeg('a picture');
    const photo = jpeg('a picture', [jfifWithPreview(), exif({ orientation: 6 }), xmp(), jpegComment('secret comment')], enc.encode('trailing video'));
    for (const word of LOCATION_WORDS) expect([word, holds(photo, word)]).toEqual([word, true]);
    const out = withoutMetadata('image/jpeg', photo);
    if (!out.ok) throw new Error(out.reason);
    expect(out.removed).toBe(true);
    for (const word of LOCATION_WORDS) expect([word, holds(out.bytes, word)]).toEqual([word, false]);
    // The picture itself, from its tables to its end, is byte for byte what it was.
    const picture = plain.subarray(2);
    expect(Buffer.from(out.bytes.subarray(out.bytes.length - picture.length)).equals(Buffer.from(picture))).toBe(true);
    // JFIF's header stays, without its preview; Exif comes back holding only the orientation (6: turned right).
    expect(holds(out.bytes, 'JFIF')).toBe(true);
    const exifAt = Buffer.from(out.bytes).indexOf('Exif\0\0', 0, 'latin1');
    const orientation = Buffer.from(out.bytes.subarray(exifAt + 6, exifAt + 6 + 26));
    expect(orientation.subarray(0, 4).toString('latin1')).toBe('MM\0*');
    expect([orientation.readUInt16BE(10), orientation.readUInt16BE(18)]).toEqual([0x0112, 6]);
    // Cleaning it again changes nothing; a photo that is already the right way up gets no Exif at all.
    const again = withoutMetadata('image/jpeg', out.bytes);
    expect(again.ok && Buffer.from(again.bytes).equals(Buffer.from(out.bytes))).toBe(true);
    const upright = withoutMetadata('image/jpeg', jpeg('a picture', [exif({ orientation: 1 })]));
    expect(upright.ok && Buffer.from(upright.bytes).equals(Buffer.from(plain))).toBe(true);
    // A JPEG with nothing to take out comes back as the very same bytes.
    const untouched = withoutMetadata('image/jpeg', plain);
    expect(untouched).toEqual({ ok: true, bytes: plain, removed: false });
  });

  it('a PNG loses its text, Exif and time chunks; what is left is the plain picture, every checksum intact', () => {
    const tiff = exif().subarray(10);
    const photo = png('a picture', [pngText('Location', 'GPS 51.5N 0.12W'), pngChunk('eXIf', tiff), pngChunk('tIME', [7, 234, 11, 17, 9, 30, 0]), pngChunk('zTXt', enc.encode('Comment\0\0secret comment'))]);
    const out = withoutMetadata('image/png', photo);
    if (!out.ok) throw new Error(out.reason);
    expect(out.removed).toBe(true);
    expect(Buffer.from(out.bytes).equals(Buffer.from(png('a picture')))).toBe(true);
    for (const word of ['GPS', 'Secret Camera', 'tIME', 'secret comment']) expect([word, holds(out.bytes, word)]).toEqual([word, false]);
    expect(withoutMetadata('image/png', out.bytes)).toEqual({ ok: true, bytes: out.bytes, removed: false });
  });

  it('a WebP loses Exif and XMP, and its header stops announcing them', () => {
    const photo = webp({ exif: true, xmp: true });
    const out = withoutMetadata('image/webp', photo);
    if (!out.ok) throw new Error(out.reason);
    expect(out.removed).toBe(true);
    for (const word of ['EXIF', 'XMP ', 'GPS', 'Secret Camera']) expect([word, holds(out.bytes, word)]).toEqual([word, false]);
    const b = Buffer.from(out.bytes);
    // The container's size is right, the extended header comes first with its Exif and XMP flags off, and the image is the original's.
    expect(b.readUInt32LE(4)).toBe(b.length - 8);
    expect(b.subarray(12, 16).toString('latin1')).toBe('VP8X');
    expect(b[20]! & 0x0c).toBe(0);
    expect(b.subarray(30).equals(Buffer.from(webp().subarray(12)))).toBe(true);
    expect(withoutMetadata('image/webp', webp())).toEqual({ ok: true, bytes: webp(), removed: false });
  });

  it('a GIF, and any file that isn’t a picture, is kept exactly as it is', () => {
    const gif = enc.encode('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000!þ\u0007comment\u0000;');
    expect(withoutMetadata('image/gif', gif)).toEqual({ ok: true, bytes: gif, removed: false });
    const pdf = enc.encode('%PDF-1.4\n/Author (someone)\n%%EOF\n');
    expect(withoutMetadata('application/pdf', pdf)).toEqual({ ok: true, bytes: pdf, removed: false });
  });

  it('a picture the parser can’t follow from start to end is refused, not passed on half-read', () => {
    const good = jpeg('x');
    const badCrc = png('x');
    badCrc[badCrc.length - 20] ^= 0xff;
    const longWebp = webp();
    new DataView(longWebp.buffer).setUint32(16, 9999, true);
    const cases: [string, string, Uint8Array][] = [
      ['a JPEG that only begins like one', 'image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...enc.encode('timmy')])],
      ['a JPEG cut off before its end', 'image/jpeg', good.subarray(0, good.length - 3)],
      ['a JPEG with a block longer than the file', 'image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff, 1, 2, 3])],
      ['a JPEG with no picture in it', 'image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xfe, 0, 4, 1, 2, 0xff, 0xd9])],
      ['a JPEG with a marker nobody uses', 'image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xf3, 0, 2, ...good.subarray(2)])],
      ['a PNG with a wrong checksum', 'image/png', badCrc],
      ['a PNG with no picture data', 'image/png', new Uint8Array([...png('x').subarray(0, 33), ...pngChunk('IEND', [])])],
      ['a PNG with an unknown chunk a viewer may not skip', 'image/png', png('x', [pngChunk('ZZZZ', [1, 2, 3])])],
      ['a PNG that doesn’t start with its header', 'image/png', new Uint8Array([...png('x').subarray(0, 8), ...pngText('a', 'b'), ...png('x').subarray(8)])],
      ['a WebP whose chunk runs past its end', 'image/webp', longWebp],
      ['a WebP with no image in it', 'image/webp', new Uint8Array([...enc.encode('RIFF'), 12, 0, 0, 0, ...enc.encode('WEBPXMP '), 0, 0, 0, 0])],
    ];
    for (const [what, type, bytes] of cases) {
      const out = withoutMetadata(type, bytes);
      expect([what, out.ok]).toEqual([what, false]);
      if (!out.ok) expect(out.reason).toMatch(/couldn’t be read safely/);
    }
  });

  it('an uploaded photo is kept without its metadata, as a page picture and as an attachment; the answer gives what was kept', async () => {
    const photo = jpeg('a photo', [exif({ orientation: 3 }), xmp()]);
    for (const [purpose, name] of [['page-image', undefined], ['page-cover', undefined], ['chat-icon', undefined], ['attachment', 'site photo.jpg']] as const) {
      const announced = await w.post('/api/v1/uploads', { purpose, type: 'image/jpeg', size: photo.length, ...(name ? { name } : {}) });
      const told = (await announced.json()) as { assetId: string; upload: { url: string } };
      const put = await sendBytes(w, 'PUT', told.upload.url, photo, { 'content-type': 'image/jpeg' });
      expect(put.status).toBe(200);
      const answer = (await put.json()) as { size: number; type: string };
      const kept = (await stored(told.assetId))!;
      expect([purpose, holds(kept, 'GPS'), holds(kept, 'xmpmeta')]).toEqual([purpose, false, false]);
      // What is recorded is what is kept: its size and its hash. The answer says the size kept, smaller than what was sent.
      expect(answer.size).toBe(kept.length);
      expect(kept.length).toBeLessThan(photo.length);
      expect(await asset(told.assetId)).toMatchObject({ size_bytes: kept.length, sha256: sha256(kept) });
      const back = await download(w, told.assetId);
      expect(Buffer.from(back.bytes!).equals(Buffer.from(kept))).toBe(true);
    }
    // A PNG and a WebP the same way.
    const pngUp = await uploadFile(w, { purpose: 'page-image', type: 'image/png', bytes: png('x', [pngText('Location', 'GPS 51.5N')]) });
    expect(pngUp.status).toBe(200);
    expect(holds((await stored(pngUp.assetId))!, 'GPS')).toBe(false);
    const webpUp = await uploadFile(w, { purpose: 'page-image', type: 'image/webp', bytes: webp({ exif: true }) });
    expect(webpUp.status).toBe(200);
    expect(holds((await stored(webpUp.assetId))!, 'EXIF')).toBe(false);
  });

  it('an attachment is approved and sent as the cleaned copy', async () => {
    const mailbox = await connectGmail(w, 'files@example.test');
    const photo = jpeg('to send', [exif({ orientation: 1 })]);
    const up = await uploadFile(w, { purpose: 'attachment', type: 'image/jpeg', bytes: photo, name: 'photo.jpg' });
    expect(up.status).toBe(200);
    const kept = (await stored(up.assetId))!;
    expect(kept.length).toBeLessThan(photo.length);
    // The screen holds the size the upload's answer gave, which is the kept size.
    const file = { id: up.assetId, name: 'photo.jpg', type: 'image/jpeg', size: kept.length };
    expect((await w.cmd({ type: 'sendNew', draft: { to: ['mail:dana@client.test'], subject: 'The photo', body: 'Attached.', files: [file] } })).ok).toBe(true);
    const [e] = await rows<{ payload: { attachments: { sha256: string; size: number }[] } }>(`select payload from effect where workspace_id = $1`, [w.workspaceId]);
    expect(e!.payload.attachments[0]).toMatchObject({ sha256: sha256(kept), size: kept.length });
    await releaseHolds(w);
    const sent = fake().sent(mailbox.account);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.attachments).toEqual([{ name: 'photo.jpg', mimetype: 'image/jpeg', size: kept.length, sha256: sha256(kept) }]);
  });

  it('an upload the parser can’t follow is refused, and nothing is kept', async () => {
    const pretend = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...enc.encode('not really a photo')]);
    const out = await uploadFile(w, { purpose: 'page-image', type: 'image/jpeg', bytes: pretend });
    expect(out.status).toBe(400);
    expect(out.error).toMatch(/couldn’t be read safely/);
    expect((await asset(out.assetId))!.uploaded_at).toBeNull();
    expect(await stored(out.assetId)).toBeUndefined();
  });
});

/* ───────────── Virus scanning ───────────── */

describe('virus scanning', () => {
  let clamd: StandInClamd;
  beforeAll(async () => {
    clamd = await startStandInClamd();
  });
  afterAll(async () => {
    await clamd.close();
  });
  const useStandIn = () => setScannerForTests(new ClamAV('127.0.0.1', clamd.port, 5000));
  const announceAndSend = async (c: Client, f: { purpose: string; type: string; bytes: Uint8Array; name?: string }) => {
    const announced = await c.post('/api/v1/uploads', { purpose: f.purpose, type: f.type, size: f.bytes.length, ...(f.name ? { name: f.name } : {}) });
    const told = (await announced.json()) as { assetId: string; upload: { url: string } };
    const send = () => sendBytes(c, 'PUT', told.upload.url, f.bytes, { 'content-type': f.type });
    return { assetId: told.assetId, send };
  };
  const virusText = () => enc.encode(`${EICAR}\n`);
  /** A port on this machine that nothing listens on. */
  const deadPort = async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as { port: number }).port;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
  };

  it('with no scanner set up, an upload works as before, and its answer says it was not scanned', async () => {
    const up = await announceAndSend(w, { purpose: 'page-image', type: 'image/png', bytes: png('unscanned') });
    const res = await up.send();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ scanned: false, note: 'This file was not checked for viruses: no virus scanner is set up on this server yet.' });
    expect(await asset(up.assetId)).toMatchObject({ scan: 'not-scanned' });
    expect((await download(w, up.assetId)).status).toBe(200);
  });

  it('with a scanner, a file is scanned before it is kept, and a clean one can be used', async () => {
    useStandIn();
    const before = clamd.scans;
    const up = await announceAndSend(w, { purpose: 'page-image', type: 'image/png', bytes: png('clean') });
    const res = await up.send();
    expect(res.status).toBe(200);
    const answer = (await res.json()) as Record<string, unknown>;
    expect(answer).toMatchObject({ scanned: true });
    expect(answer).not.toHaveProperty('note');
    expect(clamd.scans).toBe(before + 1);
    expect(await asset(up.assetId)).toMatchObject({ scan: 'clean' });
    expect((await download(w, up.assetId)).status).toBe(200);
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'docs', item: { id: 'p', blocks: [{ id: 'b', type: 'image', src: `asset:${up.assetId}` }] } }] })).ok).toBe(true);
    // A file larger than one chunk of the stream is sent in pieces and still read whole.
    const big = enc.encode(`%PDF-1.4\n${'x'.repeat(300_000)}\n%%EOF\n`);
    const bigUp = await announceAndSend(w, { purpose: 'attachment', type: 'application/pdf', bytes: big, name: 'big.pdf' });
    expect((await bigUp.send()).status).toBe(200);
    const hidden = enc.encode(`%PDF-1.4\n${'x'.repeat(200_000)}${EICAR}${'y'.repeat(100_000)}\n%%EOF\n`);
    expect((await (await announceAndSend(w, { purpose: 'attachment', type: 'application/pdf', bytes: hidden, name: 'hidden.pdf' })).send()).status).toBe(422);
  });

  it('a file carrying the EICAR test virus is refused and deleted: nothing is stored, nothing can use it, and it is on the record', async () => {
    useStandIn();
    const up = await announceAndSend(w, { purpose: 'attachment', type: 'text/plain', bytes: virusText(), name: 'notes.txt' });
    const res = await up.send();
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('The virus scanner found Eicar-Test-Signature in this file, so Timmy didn’t keep it.');
    expect(await asset(up.assetId)).toBeUndefined();
    expect(await stored(up.assetId)).toBeUndefined();
    expect((await download(w, up.assetId)).status).toBe(404);
    // Sending the bytes again finds no upload to finish.
    expect((await up.send()).status).toBe(404);
    expect(await rows(`select actor, detail from audit_log where workspace_id = $1 and action = 'file.refused'`, [w.workspaceId])).toEqual([{ actor: w.userId, detail: { why: 'virus', virus: 'Eicar-Test-Signature', name: 'notes.txt', purpose: 'attachment' } }]);
  });

  it('when the scanner can’t be reached, the file can’t be used and the person is told why; once it answers, the same upload goes through', async () => {
    setScannerForTests(new ClamAV('127.0.0.1', await deadPort(), 2000));
    const up = await announceAndSend(w, { purpose: 'page-image', type: 'image/png', bytes: png('waiting') });
    const res = await up.send();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('Timmy couldn’t check this file for viruses just now, so it can’t be used yet. Try uploading it again in a few minutes.');
    expect(await asset(up.assetId)).toMatchObject({ uploaded_at: null, scan: null });
    expect(await stored(up.assetId)).toBeUndefined();
    expect((await download(w, up.assetId)).status).toBe(404);
    const placed = await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'docs', item: { id: 'p', blocks: [{ id: 'b', type: 'image', src: `asset:${up.assetId}` }] } }] });
    expect(placed.ok).toBe(false);
    // A scanner that answers with something other than a verdict (a stream too large for it) is no better.
    const strict = await startStandInClamd({ maxBytes: 10 });
    try {
      setScannerForTests(new ClamAV('127.0.0.1', strict.port, 2000));
      expect((await up.send()).status).toBe(503);
    } finally {
      await strict.close();
    }
    useStandIn();
    expect((await up.send()).status).toBe(200);
    expect((await download(w, up.assetId)).status).toBe(200);
  });

  it('files kept before the scanner was set up can’t be used until it has scanned them; an infected one is then deleted', async () => {
    const clean = await uploadFile(w, { purpose: 'page-image', type: 'image/png', bytes: png('older') });
    const bad = await uploadFile(w, { purpose: 'attachment', type: 'text/plain', bytes: virusText(), name: 'old notes.txt' });
    expect([clean.status, bad.status]).toEqual([200, 200]);
    // Another workspace's older file waits for the same pass, and is not mixed up with this one's.
    const other = await newWorkspace('Neighbour');
    const theirs = await uploadFile(other, { purpose: 'page-image', type: 'image/png', bytes: png('theirs') });

    useStandIn();
    expect((await download(w, clean.assetId)).status).toBe(404);
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'docs', item: { id: 'p', blocks: [{ id: 'b', type: 'image', src: `asset:${clean.assetId}` }] } }] })).ok).toBe(false);
    await connectGmail(w, 'scan@example.test');
    const attached = await w.cmd({ type: 'sendNew', draft: { to: ['mail:dana@client.test'], subject: 'Old notes', body: 'Attached.', files: [{ id: bad.assetId, name: 'old notes.txt', type: 'text/plain', size: virusText().length }] } });
    expect(attached.ok).toBe(false);
    expect(attached.error).toMatch(/isn’t in Timmy any more/);

    await runJob('files.scan.backlog');
    expect(await asset(clean.assetId)).toMatchObject({ scan: 'clean' });
    expect((await download(w, clean.assetId)).status).toBe(200);
    expect((await download(other, theirs.assetId)).status).toBe(200);
    expect(await asset(bad.assetId)).toBeUndefined();
    expect(await stored(bad.assetId)).toBeUndefined();
    expect(await rows(`select actor, detail from audit_log where workspace_id = $1 and action = 'file.deleted'`, [w.workspaceId])).toEqual([{ actor: 'system', detail: { why: 'virus', virus: 'Eicar-Test-Signature', name: 'old notes.txt' } }]);
    // Without a scanner the pass does nothing at all.
    setScannerForTests(undefined);
    const later = await uploadFile(w, { purpose: 'page-image', type: 'image/png', bytes: png('later') });
    await runJob('files.scan.backlog');
    expect(await asset(later.assetId)).toMatchObject({ scan: 'not-scanned' });
  });
});

/* ───────────── Clean-up ───────────── */

describe('files nothing uses are deleted after a grace period', () => {
  /** Makes an upload look this many days old, and, when it has been marked unused, marked that long ago. */
  const age = (ids: string[], days: number) =>
    sysPool.query(`update asset set uploaded_at = now() - make_interval(days => $2), created_at = now() - make_interval(days => $2), unused_since = case when unused_since is null then null else now() - make_interval(days => $2) end where id = any($1::text[])`, [ids, days]);
  const sweep = () => runJob('files.unused.sweep');
  const picture = async (c: Client, fill: string) => {
    const up = await uploadFile(c, { purpose: 'page-image', type: 'image/png', bytes: png(fill) });
    expect(up.status).toBe(200);
    return up.assetId;
  };
  const attachment = async (c: Client, name: string) => {
    const bytes = enc.encode(`%PDF-1.4\n${name}\n%%EOF\n`);
    const up = await uploadFile(c, { purpose: 'attachment', type: 'application/pdf', bytes, name });
    expect(up.status).toBe(200);
    return { id: up.assetId, name, type: 'application/pdf', size: bytes.length };
  };
  const page = (id: string, blocks: unknown[], extra: Record<string, unknown> = {}, c: Client = w) =>
    c.cmd({ type: 'ws', ops: [{ op: 'put', col: 'files', item: { id, name: id, kind: 'doc', folder: '', updated: new Date(), owner: 'me' } }, { op: 'put', col: 'docs', item: { id, blocks, ...extra } }] });
  const image = (assetId: string) => ({ id: `i-${assetId}`, type: 'image', src: `asset:${assetId}` });
  const exists = async (id: string) => !!(await asset(id));

  it('a file nothing uses is marked on one pass and deleted only after it has gone unused for the whole grace period', async () => {
    const id = await picture(w, 'nobody uses this');
    await age([id], 30);
    await sweep();
    expect((await asset(id))!.unused_since).not.toBeNull();
    // Six days unused: still kept.
    await age([id], 6);
    await sweep();
    expect(await exists(id)).toBe(true);
    expect(await stored(id)).toBeDefined();
    // Eight days: deleted, its record and its bytes, and it is on the record.
    await age([id], 8);
    await sweep();
    expect(await exists(id)).toBe(false);
    expect(await stored(id)).toBeUndefined();
    expect((await download(w, id)).status).toBe(404);
    expect(await rows(`select actor, detail from audit_log where workspace_id = $1 and action = 'file.deleted'`, [w.workspaceId])).toEqual([{ actor: 'system', detail: { files: 1, why: 'unused for 7 days' } }]);
  });

  it('a file uploaded within the grace period is never deleted, however long ago it was marked unused', async () => {
    const id = await picture(w, 'just uploaded');
    await sweep();
    await sysPool.query(`update asset set unused_since = now() - interval '30 days' where id = $1`, [id]);
    await sweep();
    expect(await exists(id)).toBe(true);
  });

  it('never deletes a file still in use, by each kind of use, even when all of them look long unused', async () => {
    const mailbox = await connectGmail(w, 'keeper@example.test');
    const ids: Record<string, string> = {};

    // On a page; as a page's cover; on a page in the trash.
    ids.onPage = await picture(w, 'on a page');
    ids.cover = await picture(w, 'a cover');
    ids.inTrash = await picture(w, 'in the trash');
    expect((await page('pg', [image(ids.onPage)], { cover: { kind: 'image', value: `asset:${ids.cover}` } })).ok).toBe(true);
    expect((await page('binned', [image(ids.inTrash)])).ok).toBe(true);
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'remove', col: 'files', id: 'binned' }, { op: 'put', col: 'trash', item: { id: 'binned', name: 'binned', kind: 'doc', folder: '', updated: new Date(), owner: 'me', trashed: new Date() } }] })).ok).toBe(true);
    // Only in a kept version: the page no longer shows it.
    ids.inVersion = await picture(w, 'in a version');
    expect((await page('history', [image(ids.inVersion)])).ok).toBe(true);
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'docs', id: 'history', patch: { blocks: [{ id: 'p', type: 'p', text: 'no picture now' }] } }] })).ok).toBe(true);
    // Only in the hidden versions of a page deleted for good, which Undo can still bring back.
    ids.inGonePage = await picture(w, 'in a deleted page');
    expect((await page('gone', [image(ids.inGonePage)])).ok).toBe(true);
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'docs', id: 'gone', patch: { blocks: [] } }] })).ok).toBe(true);
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'remove', col: 'files', id: 'gone' }, { op: 'remove', col: 'docs', id: 'gone' }] })).ok).toBe(true);
    // The website chat's picture. The settings screen keeps it inline today, so it is written into the stored settings
    // directly: an uploaded chat picture that the settings refer to must keep its file as soon as one does.
    ids.chatPicture = await picture(w, 'the chat');
    await w.state();
    const chat = await sysPool.query(`update state_doc set data = jsonb_set(data, '{icon}', to_jsonb($2::text)) where workspace_id = $1 and slice = 'ws.chat' and id = 'site'`, [w.workspaceId, `asset:${ids.chatPicture}`]);
    expect(chat.rowCount).toBe(1);
    // A file on a draft Timmy wrote.
    await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Dana <dana@client.test>', subject: 'Contract?', body: 'Could you send the contract?' } });
    const thread = (await w.state()).threads.find((t) => t.subject === 'Contract?')!;
    expect((await w.cmd({ type: 'makeDraft', id: thread.id })).ok).toBe(true);
    await jobs().drain();
    const draft = (await w.state()).threads.find((t) => t.id === thread.id)!.draft!;
    const onDraft = await attachment(w, 'On the draft.pdf');
    ids.onDraft = onDraft.id;
    expect((await w.cmd({ type: 'updateDraft', id: thread.id, body: draft.body, files: [onDraft] })).ok).toBe(true);
    // An email held in its undo window.
    const held = await attachment(w, 'Held.pdf');
    ids.held = held.id;
    expect((await w.cmd({ type: 'sendNew', draft: { to: ['mail:dana@client.test'], subject: 'Held', body: 'Attached.', files: [held] } })).ok).toBe(true);
    // An email waiting for the owner's approval: a member sending from the owner's mailbox.
    const mia = await addMember(w.workspaceId, 'member', 'Mia Member');
    const waiting = await attachment(mia, 'Waiting.pdf');
    ids.waiting = waiting.id;
    const asked = await mia.cmd({ type: 'sendNew', draft: { to: ['mail:dana@client.test'], subject: 'Waiting', body: 'Attached.', files: [waiting] } });
    expect(asked.ok).toBe(true);
    const statuses = await rows<{ status: string; subject: string }>(`select status, preview->>'subject' as subject from effect where workspace_id = $1 and kind = 'email.send' order by created_at`, [w.workspaceId]);
    expect(statuses).toEqual([{ status: 'approved', subject: 'Held' }, { status: 'intended', subject: 'Waiting' }]);
    // An email whose outcome is unknown, and one that is going out right now.
    for (const [key, status] of [['uncertain', 'uncertain'], ['executing', 'executing']] as const) {
      const f = await attachment(w, `${key}.pdf`);
      ids[key] = f.id;
      const effectId = `eff_${key}_${w.workspaceId.slice(-8)}`;
      await sysPool.query(`insert into effect (id, workspace_id, kind, payload, payload_hash, idempotency_key, status, source, requested_by) values ($1, $2, 'email.send', $3::jsonb, 'x', $1, 'intended', 'user', $4)`, [effectId, w.workspaceId, JSON.stringify({ attachments: [{ assetId: f.id }] }), w.userId]);
      await sysPool.query(`update effect set status = 'approved', approved_by = $2, approved_via = 'click', approved_at = now() where id = $1`, [effectId, w.userId]);
      await sysPool.query(`update effect set status = 'executing', executing_at = now() where id = $1`, [effectId]);
      if (status === 'uncertain') await sysPool.query(`update effect set status = 'uncertain' where id = $1`, [effectId]);
    }

    // What nothing uses: a picture taken off its page, and a file whose email has gone out.
    const unused = await picture(w, 'taken off');
    const sentFile = await attachment(w, 'Sent.pdf');
    expect((await w.cmd({ type: 'sendNew', draft: { to: ['mail:sam@client.test'], subject: 'Gone out', body: 'Attached.', files: [sentFile] } })).ok).toBe(true);
    const goneOut = (await rows<{ id: string }>(`select id from effect where workspace_id = $1 and preview->>'subject' = 'Gone out'`, [w.workspaceId]))[0]!.id;
    await sysPool.query(`update effect set hold_until = now() - interval '1 second' where id = $1`, [goneOut]);
    await jobs().drain();
    const { executeEffect } = await import('../src/gateway/gateway');
    await executeEffect(w.workspaceId, goneOut);
    expect((await rows<{ status: string }>(`select status from effect where id = $1`, [goneOut]))[0]!.status).toBe('completed');
    expect(fake().sent(mailbox.account).map((m) => m.subject)).toEqual(['Gone out']);

    // Everything looks a month old and a month unused.
    const all = [...Object.values(ids), unused, sentFile.id];
    await sweep();
    await sysPool.query(`update asset set uploaded_at = now() - interval '30 days', unused_since = now() - interval '30 days' where id = any($1::text[])`, [all]);
    await sweep();
    for (const [use, id] of Object.entries(ids)) expect([use, await exists(id), !!(await stored(id))]).toEqual([use, true, true]);
    // Their marks are cleared again: they are in use.
    expect(await rows(`select id from asset where id = any($1::text[]) and unused_since is not null`, [Object.values(ids)])).toEqual([]);
    expect([await exists(unused), await exists(sentFile.id)]).toEqual([false, false]);
  });

  it('a picture taken off a page and brought back by Undo is in use again, and its unused time starts afresh', async () => {
    const id = await picture(w, 'undo me');
    expect((await page('pg', [image(id)])).ok).toBe(true);
    const off = await w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'docs', id: 'pg', patch: { blocks: [] } }] });
    // The version kept before the change holds it, so remove the versions to see the page alone decide.
    await sysPool.query(`delete from doc_revision where workspace_id = $1`, [w.workspaceId]);
    await age([id], 30);
    await sweep();
    expect((await asset(id))!.unused_since).not.toBeNull();
    expect((await w.cmd({ type: 'undo', command: off.id })).ok).toBe(true);
    await sweep();
    expect((await asset(id))!.unused_since).toBeNull();
    expect((await download(w, id)).status).toBe(200);
  });

  it('one workspace’s pass never touches another’s files, and another workspace mentioning a file’s id doesn’t keep it', async () => {
    const mine = await picture(w, 'mine');
    const other = await newWorkspace('Neighbour');
    const theirs = await picture(other, 'theirs');
    const theirsUnused = await picture(other, 'theirs unused');
    // The neighbour uses its own picture, and writes this workspace's file id into one of its pages.
    expect((await page('np', [image(theirs), { id: 't', type: 'p', text: `asset:${mine} ${mine}` }], {}, other)).ok).toBe(true);
    await age([mine, theirs, theirsUnused], 30);
    await sweep();
    await age([mine, theirs, theirsUnused], 30);
    await sweep();
    expect(await exists(mine)).toBe(false);
    expect(await exists(theirs)).toBe(true);
    expect(await exists(theirsUnused)).toBe(false);
    expect(await stored(theirs, other.workspaceId)).toBeDefined();
  });
});
