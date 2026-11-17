/**
 * Small, real pictures for tests, built byte by byte: a PNG, a JPEG and a WebP that any viewer can draw, and the
 * kinds of metadata a camera or an editor writes into them (where a photo was taken, comments, text, XMP).
 * Each builder varies its bytes with `fill`, so two samples are two different files, without adding metadata.
 */
import { crc32, deflateSync } from 'node:zlib';

const enc = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;
const cat = (...parts: (Uint8Array | number[])[]): Bytes => {
  const list = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(list.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of list) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u16be = (n: number) => [(n >>> 8) & 0xff, n & 0xff];

/* ───────────── PNG ───────────── */

export function pngChunk(type: string, data: Uint8Array | number[]): Bytes {
  const body = cat(enc.encode(type), data);
  return cat(u32be(body.length - 4), body, u32be(crc32(body) >>> 0));
}

/** A one-row grey PNG whose pixels are the characters of `fill`. `extra` chunks go between the header and the data. Its size depends only on the length of `fill`. */
export function png(fill = 'timmy', extra: Uint8Array[] = []): Bytes {
  const px = enc.encode(fill || ' ');
  const header = pngChunk('IHDR', [...u32be(px.length), ...u32be(1), 8, 0, 0, 0, 0]);
  // Stored without compression, so two fills of the same length make files of the same size.
  const data = pngChunk('IDAT', deflateSync(cat([0], px), { level: 0 }));
  return cat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], header, ...extra, data, pngChunk('IEND', []));
}

/** A text chunk, the way an editor or a phone writes one. */
export const pngText = (key: string, value: string) => pngChunk('tEXt', cat(enc.encode(key), [0], enc.encode(value)));

/* ───────────── JPEG ───────────── */

const segment = (marker: number, body: Uint8Array | number[]) => cat([0xff, marker], u16be((body instanceof Uint8Array ? body.length : body.length) + 2), body);

/**
 * An 8×8 grey JPEG: one block whose only coefficient is zero, so it draws as plain mid-grey whatever its
 * quantisation table holds. The table holds the characters of `fill` (the first 64), which makes each sample its own file.
 * `extra` segments go straight after the start, where cameras put theirs; `after` goes after the end of the picture.
 */
export function jpeg(fill = 'timmy', extra: Uint8Array[] = [], after?: Uint8Array): Bytes {
  const q = new Uint8Array(64).fill(1);
  enc.encode(fill).slice(0, 64).forEach((c, i) => (q[i] = Math.max(1, c)));
  const table = segment(0xdb, cat([0x00], q));
  const frame = segment(0xc0, [8, 0, 8, 0, 8, 1, 1, 0x11, 0]);
  // One Huffman code each, of one bit: "0" means "no change" for the DC table and "end of block" for the AC table.
  const dc = segment(0xc4, [0x00, 1, ...new Array(15).fill(0), 0x00]);
  const ac = segment(0xc4, [0x10, 1, ...new Array(15).fill(0), 0x00]);
  const scan = segment(0xda, [1, 1, 0x00, 0, 63, 0]);
  return cat([0xff, 0xd8], ...extra, table, frame, dc, ac, scan, [0x3f], [0xff, 0xd9], after ?? []);
}

/**
 * An Exif block such as a phone writes: the camera's make, which way up the photo is, and where it was taken
 * (a GPS directory with latitude "N" and longitude "W"), plus a few marker words a test can look for.
 */
export function exif(opts: { orientation?: number } = {}): Bytes {
  // Big-endian TIFF. Directory 0 at 8: make (ASCII, stored after the directories), orientation, GPS pointer.
  const make = enc.encode('Secret Camera GPS\0');
  const entries: number[][] = [];
  const ifd0At = 8;
  const count0 = opts.orientation ? 3 : 2;
  const ifd0Size = 2 + count0 * 12 + 4;
  const gpsAt = ifd0At + ifd0Size;
  const gpsSize = 2 + 2 * 12 + 4;
  const makeAt = gpsAt + gpsSize;
  entries.push([...u16be(0x010f), ...u16be(2), ...u32be(make.length), ...u32be(makeAt)]);
  if (opts.orientation) entries.push([...u16be(0x0112), ...u16be(3), ...u32be(1), ...u16be(opts.orientation), 0, 0]);
  entries.push([...u16be(0x8825), ...u16be(4), ...u32be(1), ...u32be(gpsAt)]);
  const ifd0 = [...u16be(count0), ...entries.flat(), ...u32be(0)];
  // GPS: latitude ref "N" and longitude ref "W", each held in the entry.
  const gps = [...u16be(2), ...u16be(1), ...u16be(2), ...u32be(2), 0x4e, 0, 0, 0, ...u16be(3), ...u16be(2), ...u32be(2), 0x57, 0, 0, 0, ...u32be(0)];
  const tiff = cat([0x4d, 0x4d, 0x00, 0x2a], u32be(ifd0At), ifd0, gps, make);
  return segment(0xe1, cat(enc.encode('Exif\0\0'), tiff));
}

/** An XMP block, as photo editors write one. */
export const xmp = () => segment(0xe1, cat(enc.encode('http://ns.adobe.com/xap/1.0/\0'), enc.encode('<x:xmpmeta><exif:GPSLatitude>51,30.2N</exif:GPSLatitude></x:xmpmeta>')));
/** A comment block. */
export const jpegComment = (text: string) => segment(0xfe, enc.encode(text));
/** JFIF's header, with a 1×1 preview picture in it. */
export const jfifWithPreview = () => segment(0xe0, cat(enc.encode('JFIF\0'), [1, 1, 0, 0, 1, 0, 1, 1, 1], [9, 9, 9]));

/* ───────────── WebP ───────────── */

/** A 2×2 lossless WebP, as an encoder writes it. */
const WEBP_IMAGE = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvAUAAAAdQjyJXq/+BiOh/AAA=', 'base64');

const riffChunk = (type: string, data: Uint8Array) => cat(enc.encode(type), u32le(data.length), data, data.length & 1 ? [0] : []);

/**
 * A WebP with the extended header, and with Exif and XMP when asked for, the way a camera app saves one.
 * Without either it is the plain 2×2 picture.
 */
export function webp(opts: { exif?: boolean; xmp?: boolean } = {}): Bytes {
  if (!opts.exif && !opts.xmp) return new Uint8Array(WEBP_IMAGE);
  const image = WEBP_IMAGE.subarray(12);
  const flags = (opts.exif ? 0x08 : 0) | (opts.xmp ? 0x04 : 0);
  const header = riffChunk('VP8X', new Uint8Array([flags, 0, 0, 0, 1, 0, 0, 1, 0, 0]));
  const body = cat(header, image, opts.exif ? riffChunk('EXIF', exif({ orientation: 3 }).subarray(10)) : [], opts.xmp ? riffChunk('XMP ', enc.encode('<x:xmpmeta>GPS 51.5N</x:xmpmeta>')) : []);
  return cat(enc.encode('RIFF'), u32le(body.length + 4), enc.encode('WEBP'), body);
}

/** Whether the bytes contain this text anywhere. */
export const holds = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(Buffer.from(text, 'latin1'));

export const samples = { png, jpeg, webp };
