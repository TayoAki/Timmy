/**
 * Uploading a file and reading it back.
 *
 *   POST /api/v1/uploads      says what is about to be sent; answers with an asset id and where to send the bytes
 *   PUT  /api/v1/uploads/:id  the bytes themselves, checked against what was announced
 *   GET  /api/v1/assets/:id   the file, for members of its workspace only
 *
 * The bytes travel through this server in both directions. The browser never sees the bucket or its key, the
 * server sees every byte it is asked to keep (so it can check them), and a file is only ever handed to someone
 * whose membership was checked on that very request.
 */
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { MAX_FILE_BYTES, assetRef } from '../../../src/lib/files';
import { announceUpload, expectUpload, receiveUpload, scanNote, uploadedAsset, type AssetRow, type Uploader } from '../files/assets';
import { isPictureType } from '../files/rules';
import { setScannerForTests, ClamAV } from '../files/scan';
import { fileStore, filesReady } from '../files/store';
import { startStandInClamd, type StandInClamd } from '../testing/clamd';
import { log } from '../lib/log';
import { ctxOf, requireRead, requireWorkspace, type Env } from './session';

const ID = /^[\w-]{1,80}$/;
const NOT_SET_UP = 'Files aren’t set up on this server yet.';

/** The one route whose body may be as large as a file. Every other API request keeps the small limit. */
export const isFileUpload = (method: string, path: string) => method === 'PUT' && /^\/api\/v1\/uploads\/[\w-]{1,80}$/.test(path);

const uploaderOf = (c: Context<Env>): Uploader => {
  const ctx = ctxOf(c);
  return { workspaceId: ctx.workspaceId, userId: ctx.user.id, mayWork: ctx.rules.work };
};

const described = (a: AssetRow) => ({ assetId: a.id, ref: assetRef(a.id), purpose: a.purpose, type: a.content_type, size: a.size_bytes, name: a.name });

/** A file name for the download header: plain characters for old browsers, and the real name beside it. */
function disposition(name: string | null, fallback: string): string {
  const real = (name ?? fallback).replace(/[\u0000-\u001f\u007f"\\]/g, '_');
  const plain = real.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(real).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`;
}

/**
 * Put on every answer from the assets route, whatever it is. It is registered ahead of the app-wide headers so
 * that it has the last word: if a browser ever shows an uploaded file by itself, the file gets no scripts,
 * no forms, no plugins and no access to Timmy's origin, and is never guessed to be some other kind of file.
 */
export const assetHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
};

export function fileRoutes(app: Hono<Env>): void {
  app.post('/api/v1/uploads', requireWorkspace, async (c) => {
    if (!filesReady()) return c.json({ error: NOT_SET_UP }, 503);
    const out = await announceUpload(uploaderOf(c), await c.req.json().catch(() => null));
    if (!out.ok) return c.json({ error: out.reason }, out.status as 400);
    const a = out.asset;
    return c.json({ ...described(a), upload: { method: 'PUT', url: `/api/v1/uploads/${a.id}`, headers: { 'content-type': a.content_type } }, maxBytes: MAX_FILE_BYTES });
  });

  app.put('/api/v1/uploads/:id', requireWorkspace, async (c) => {
    if (!filesReady()) return c.json({ error: NOT_SET_UP }, 503);
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: 'Not found' }, 404);
    // Whether this upload is expected at all is settled before the body is read.
    const length = c.req.header('content-length') !== undefined && !c.req.header('transfer-encoding') ? Number(c.req.header('content-length')) : null;
    const expected = await expectUpload(uploaderOf(c), id, length);
    if (!expected.ok) return c.json({ error: expected.reason }, expected.status as 400);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const out = await receiveUpload(uploaderOf(c), id, bytes, c.req.header('content-type') ?? null);
    if (!out.ok) return c.json({ error: out.reason }, out.status as 400);
    // The size and type are those of what was kept: a picture without its metadata is smaller than what was sent.
    return c.json({ ...described(out.asset), ...scanNote(out.asset) });
  });

  app.get('/api/v1/assets/:id', requireWorkspace, requireRead, async (c) => {
    const id = c.req.param('id');
    // Not this workspace's, never uploaded, or not there at all: the answer is the same, so nothing is given away.
    const notFound = () => c.json({ error: 'Not found' }, 404);
    if (!ID.test(id) || !filesReady()) return notFound();
    const asset = await uploadedAsset(ctxOf(c).workspaceId, id);
    if (!asset) return notFound();
    const etag = `"${asset.sha256}"`;
    const headers: Record<string, string> = {
      // Only ever a type from Timmy's own list. A picture is named as the picture it was checked to be;
      // anything else is handed over as plain bytes, so no browser treats it as a page.
      'content-type': isPictureType(asset.content_type) ? asset.content_type : 'application/octet-stream',
      // Always a download when opened by itself. A picture still shows where a page places it.
      'content-disposition': disposition(asset.name, asset.id),
      // Kept by this person's browser only, and asked about again each time, so access is checked on every use.
      'cache-control': 'private, no-cache',
      etag,
    };
    // A browser that already holds these exact bytes is told so, and the store is not asked at all.
    if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });
    let bytes: Uint8Array | null;
    try {
      bytes = await fileStore().get(asset.storage_key);
    } catch (e) {
      log.error('a file could not be read from the store', { assetId: id, error: (e as Error).message });
      return c.json({ error: 'That file can’t be read just now. Try again in a moment.' }, 502);
    }
    if (!bytes) {
      log.error('an asset’s bytes are missing from the store', { assetId: id });
      return notFound();
    }
    return new Response(bytes as BodyInit, { status: 200, headers: { ...headers, 'content-length': String(bytes.length) } });
  });
}

let standIn: StandInClamd | null = null;

/**
 * Only for tests (mounted with the other test hooks): puts the stand-in virus scanner in front of uploads, or takes
 * it away again, so a browser suite can show what a person sees when a file carries a virus. The stand-in listens
 * on this machine only.
 */
export function fileTestRoutes(app: Hono<Env>): void {
  app.post('/api/test/files/scanner', requireWorkspace, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { on?: unknown };
    if (body.on === true) {
      standIn ??= await startStandInClamd();
      setScannerForTests(new ClamAV('127.0.0.1', standIn.port, 5000));
    } else {
      setScannerForTests(undefined);
      await standIn?.close();
      standIn = null;
    }
    return c.json({ scanning: body.on === true });
  });
}
