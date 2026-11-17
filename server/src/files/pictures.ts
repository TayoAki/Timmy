/**
 * Taking what a picture says about itself out of it, on the server: where a photo was taken, when, with which
 * camera, by whom, its editing history and any small preview of the uncropped original. Browsers already redraw
 * a picture before uploading it, but the server must not rely on a browser for that, and attachments are sent as
 * they are.
 *
 * Each format is read by a small parser that copies only the parts a viewer needs to draw the picture and drops
 * everything else. Nothing is decoded or re-encoded, so the picture itself is untouched. A file the parser can't
 * follow from start to end is refused rather than passed on half-read. GIF is kept as it is.
 *
 *   JPEG: kept are the tables, the frame, the scans and their data, the colour profile (APP2 "ICC_PROFILE") and
 *         Adobe's colour marker (APP14), which change how colours show. JFIF's header is kept without its preview.
 *         Exif, XMP, IPTC, comments and every other APPn go, and so does anything after the end of the picture
 *         (some phones put a second picture or a short video there). The one thing kept from Exif is which way up
 *         the photo is, written back as a minimal Exif block of its own, or a photo taken sideways would show sideways.
 *   PNG:  kept are the chunks that draw the picture (header, palette, data, transparency, colour and gamma,
 *         animation). Text chunks, Exif, the time stamp and anything unknown that may be skipped go. An unknown
 *         chunk that may not be skipped, or a chunk whose checksum is wrong, refuses the file.
 *   WebP: kept are the image, alpha, animation and colour profile chunks. Exif and XMP go, and the header's flags
 *         that announced them are cleared.
 */
import { crc32 } from 'node:zlib';

export type Stripped = { ok: true; bytes: Uint8Array; removed: boolean } | { ok: false; reason: string };

const UNREADABLE = 'That picture couldn’t be read safely, so it wasn’t kept. Save it again as a PNG or JPEG and try again.';
const refuse = (): Stripped => ({ ok: false, reason: UNREADABLE });

/** The picture with its metadata taken out. Anything that isn't a JPEG, PNG or WebP picture comes back as it is. */
export function withoutMetadata(type: string, bytes: Uint8Array): Stripped {
  switch (type) {
    case 'image/jpeg':
      return jpeg(bytes);
    case 'image/png':
      return png(bytes);
    case 'image/webp':
      return webp(bytes);
    default:
      return { ok: true, bytes, removed: false };
  }
}

const join = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const ascii = (b: Uint8Array, at: number, text: string) => {
  if (at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
};

/* ───────────── JPEG ───────────── */

const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;
const APP1 = 0xe1;

/** Markers that carry the picture itself: the frame headers (every SOFn), Huffman and arithmetic tables, quantisation, restart interval, line count and the hierarchical ones. */
const isStructure = (m: number) => (m >= 0xc0 && m <= 0xcf && m !== 0xc8) || m === 0xdb || m === 0xdd || m === 0xdc || m === 0xde || m === 0xdf;
const isFrame = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/** Which way up the photo is, from an Exif block (1 to 8), or null when it says nothing or can't be read. */
function orientationIn(body: Uint8Array): number | null {
  // "Exif\0\0", then a TIFF header: byte order, 42, and where the first directory is.
  if (!ascii(body, 0, 'Exif\u0000\u0000') || body.length < 14) return null;
  const t = body.subarray(6);
  const little = ascii(t, 0, 'II');
  if (!little && !ascii(t, 0, 'MM')) return null;
  const u16 = (at: number) => (at + 2 <= t.length ? (little ? t[at]! | (t[at + 1]! << 8) : (t[at]! << 8) | t[at + 1]!) : -1);
  const u32 = (at: number) => (at + 4 <= t.length ? (little ? (t[at]! | (t[at + 1]! << 8) | (t[at + 2]! << 16)) + t[at + 3]! * 2 ** 24 : t[at]! * 2 ** 24 + ((t[at + 1]! << 16) | (t[at + 2]! << 8) | t[at + 3]!)) : -1);
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  const count = ifd < 0 ? -1 : u16(ifd);
  for (let i = 0; i >= 0 && i < count && i < 500; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) return null;
    // Tag 0x0112 is the orientation: one SHORT, held in the entry itself.
    if (u16(e) === 0x0112 && u16(e + 2) === 3 && u32(e + 4) === 1) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** An Exif block that says only which way up the photo is. */
function orientationBlock(o: number): Uint8Array {
  const body = [...'Exif\u0000\u0000'].map((c) => c.charCodeAt(0)).concat(
    [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08], // big-endian TIFF header; the directory follows at 8
    [0x00, 0x01], // one entry
    [0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, o, 0x00, 0x00], // orientation, SHORT, 1, value
    [0x00, 0x00, 0x00, 0x00], // no further directory
  );
  const len = body.length + 2;
  return new Uint8Array([0xff, APP1, len >> 8, len & 0xff, ...body]);
}

/** JFIF's header without a preview picture in it, or null when it isn't one. */
function jfifWithoutPreview(body: Uint8Array): Uint8Array | null {
  if (!ascii(body, 0, 'JFIF\u0000') || body.length < 14) return null;
  if (body[12] === 0 && body[13] === 0 && body.length === 14) return null;
  // Version, units and densities as they were; no preview.
  const kept = new Uint8Array(14);
  kept.set(body.subarray(0, 12));
  return new Uint8Array([0xff, APP0, 0x00, 16, ...kept]);
}

function jpeg(b: Uint8Array): Stripped {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return refuse();
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  let removed = false;
  let frame = false;
  let scan = false;
  let orientation: number | null = null;
  let afterApp0 = 1;
  for (;;) {
    if (i >= b.length || b[i] !== 0xff) return refuse();
    // A marker may be preceded by any number of fill bytes.
    while (i < b.length && b[i] === 0xff) i++;
    if (i >= b.length) return refuse();
    const m = b[i]!;
    i++;
    if (m === EOI) {
      out.push(new Uint8Array([0xff, EOI]));
      break;
    }
    // A second start, a stuffed byte or a restart outside a scan: not a picture this parser can follow.
    if (m === 0xd8 || m === 0x00 || (m >= 0xd0 && m <= 0xd7)) return refuse();
    if (m === 0x01) {
      out.push(new Uint8Array([0xff, m]));
      continue;
    }
    if (i + 2 > b.length) return refuse();
    const len = (b[i]! << 8) | b[i + 1]!;
    if (len < 2 || i + len > b.length) return refuse();
    const segment = b.subarray(i - 2, i + len);
    const body = b.subarray(i + 2, i + len);
    i += len;

    if (isStructure(m)) {
      out.push(segment);
      if (isFrame(m)) frame = true;
    } else if (m === SOS) {
      if (!frame) return refuse();
      scan = true;
      out.push(segment);
      // The scan's data runs until the next marker that is neither a stuffed zero nor a restart.
      const start = i;
      for (;;) {
        if (i + 1 >= b.length) return refuse();
        if (b[i] === 0xff) {
          const n = b[i + 1]!;
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) {
            i += 2;
            continue;
          }
          if (n === 0xff) {
            i++;
            continue;
          }
          break;
        }
        i++;
      }
      out.push(b.subarray(start, i));
    } else if (m === APP0) {
      // JFIF's header comes first in many files, and the Exif block written below goes after it.
      const without = jfifWithoutPreview(body);
      if (ascii(body, 0, 'JFIF\u0000') && body.length >= 14) {
        out.push(without ?? segment);
        if (without) removed = true;
        if (out.length === 2) afterApp0 = 2;
      } else removed = true;
    } else if ((m === 0xe2 && ascii(body, 0, 'ICC_PROFILE\u0000')) || (m === 0xee && ascii(body, 0, 'Adobe'))) {
      out.push(segment);
    } else if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) {
      // Exif, XMP, IPTC, comments and every other application block.
      if (m === APP1) orientation ??= orientationIn(body);
      removed = true;
    } else {
      // A reserved or extension marker: not something this parser knows how to pass on safely.
      return refuse();
    }
  }
  if (!frame || !scan) return refuse();
  // Whatever follows the end of the picture is dropped.
  if (i < b.length) removed = true;
  if (!removed) return { ok: true, bytes: b, removed: false };
  if (orientation && orientation !== 1) out.splice(afterApp0, 0, orientationBlock(orientation));
  return { ok: true, bytes: join(out), removed: true };
}

/* ───────────── PNG ───────────── */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Chunks that draw the picture: header, palette, data and end; transparency, colour and gamma; and animation. */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCV', 'cLLI', 'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT']);

function png(b: Uint8Array): Stripped {
  if (b.length < 8 || PNG_SIGNATURE.some((v, k) => b[k] !== v)) return refuse();
  const out: Uint8Array[] = [b.subarray(0, 8)];
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 8;
  let removed = false;
  let data = false;
  let first = true;
  for (;;) {
    if (i + 12 > b.length) return refuse();
    const len = view.getUint32(i);
    if (len > b.length - i - 12) return refuse();
    const type = String.fromCharCode(b[i + 4]!, b[i + 5]!, b[i + 6]!, b[i + 7]!);
    if (!/^[A-Za-z]{4}$/.test(type)) return refuse();
    const chunk = b.subarray(i, i + 12 + len);
    // The checksum covers the type and the data. A wrong one means the file is damaged or not what it seems.
    if ((crc32(b.subarray(i + 4, i + 8 + len)) >>> 0) !== view.getUint32(i + 8 + len)) return refuse();
    i += 12 + len;
    if (first && (type !== 'IHDR' || len !== 13)) return refuse();
    first = false;
    if (type === 'IDAT') data = true;
    if (PNG_KEEP.has(type)) out.push(chunk);
    // An unknown chunk whose name starts with a capital may not be skipped by a viewer, so the file can't be passed on.
    else if (/^[A-Z]/.test(type)) return refuse();
    else removed = true;
    if (type === 'IEND') break;
  }
  if (!data) return refuse();
  if (i < b.length) removed = true;
  return removed ? { ok: true, bytes: join(out), removed: true } : { ok: true, bytes: b, removed: false };
}

/* ───────────── WebP ───────────── */

/** Image data, alpha, animation, the extended header and the colour profile. */
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
const WEBP_EXIF_FLAG = 0x08;
const WEBP_XMP_FLAG = 0x04;

function webp(b: Uint8Array): Stripped {
  if (b.length < 20 || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return refuse();
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const size = view.getUint32(4, true);
  const end = 8 + size;
  if (size < 4 || end > b.length) return refuse();
  const out: Uint8Array[] = [];
  let i = 12;
  let removed = end < b.length;
  let image = false;
  while (i < end) {
    if (i + 8 > end) return refuse();
    const type = String.fromCharCode(b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!);
    const len = view.getUint32(i + 4, true);
    const padded = len + (len & 1);
    if (len > end - i - 8) return refuse();
    // An odd-sized chunk is followed by one byte of padding, which may be missing only at the very end.
    const stop = Math.min(i + 8 + padded, end);
    let chunk = b.subarray(i, stop);
    if (type === 'VP8X') {
      if (i !== 12 || len < 10) return refuse();
      const flags = b[i + 8]!;
      if (flags & (WEBP_EXIF_FLAG | WEBP_XMP_FLAG)) {
        chunk = new Uint8Array(chunk);
        chunk[8] = flags & ~(WEBP_EXIF_FLAG | WEBP_XMP_FLAG);
        removed = true;
      }
    }
    if (type === 'VP8 ' || type === 'VP8L' || type === 'ANMF') image = true;
    if (WEBP_KEEP.has(type)) out.push(chunk);
    else removed = true;
    i = stop;
  }
  if (!image) return refuse();
  if (!removed) return { ok: true, bytes: b, removed: false };
  const body = join(out);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 12));
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  return { ok: true, bytes: join([header, body]), removed: true };
}
