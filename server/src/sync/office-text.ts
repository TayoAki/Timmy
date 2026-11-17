/**
 * The words in a Word, Excel or PowerPoint file (.docx, .xlsx, .pptx), read from the file's bytes.
 *
 * These files are zip archives of XML. The bytes come from a file someone else may have written, so every one is
 * treated as hostile:
 *   - the archive is read through its own directory, and a size, an offset or a name that doesn't add up ends the read;
 *   - only the few parts that hold text are opened, each inflated in memory with a hard ceiling, and the whole file has
 *     a ceiling too, so a small archive that unpacks to gigabytes stops at the ceiling;
 *   - nothing is written to disk and nothing named inside the file is fetched;
 *   - the XML is walked as plain tags and text: no entity is expanded, a document type declaration is refused, and
 *     only the five standard escapes and numeric characters are turned back into characters.
 * Anything unexpected throws OfficeError, which the caller turns into a plain "couldn't read it", never a partial guess.
 */
import { crc32, inflateRawSync } from 'node:zlib';

export type OfficeKind = 'docx' | 'xlsx' | 'pptx';

export class OfficeError extends Error {}

export const OFFICE_LIMITS = {
  /** The most bytes one part may unpack to. A text part larger than this is not something a person wrote. */
  partBytes: 16 * 1024 * 1024,
  /** The most bytes all the parts read from one file may unpack to, together. */
  totalBytes: 40 * 1024 * 1024,
  /** Entries in the archive's directory. A real file has tens to a few thousand. */
  entries: 20_000,
  /** How much of a file is read: slides from a deck, and rows and columns from a sheet (as for a Google Sheet). */
  slides: 300,
  rows: 200,
  columns: 26,
};

/** The kind of Office file a name or type says it is, or null for anything Timmy can't read this way. */
export function officeKind(mimeType: string, name = ''): OfficeKind | null {
  const byType: Record<string, OfficeKind> = {
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  };
  if (Object.hasOwn(byType, mimeType)) return byType[mimeType]!;
  const ext = /\.(docx|xlsx|pptx)$/i.exec(name)?.[1]?.toLowerCase();
  return (ext as OfficeKind | undefined) ?? null;
}

/* ───────────── The archive ───────────── */

interface Entry {
  method: number;
  flags: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

class Zip {
  private entries = new Map<string, Entry>();
  private budget = OFFICE_LIMITS.totalBytes;

  constructor(private bytes: Buffer) {
    const b = bytes;
    if (b.length < 22 || b.readUInt32LE(0) !== 0x04034b50) throw new OfficeError('not a zip archive');
    // The directory's end record sits in the last 22 bytes plus at most a 64 KB comment.
    let end = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
      if (b.readUInt32LE(i) === 0x06054b50 && i + 22 + b.readUInt16LE(i + 20) === b.length) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new OfficeError('no archive directory');
    const count = b.readUInt16LE(end + 10);
    const dirSize = b.readUInt32LE(end + 12);
    const dirStart = b.readUInt32LE(end + 16);
    // Split archives and the 64-bit form are not what Office writes for a document; both are refused.
    if (b.readUInt16LE(end + 4) !== 0 || b.readUInt16LE(end + 6) !== 0 || count !== b.readUInt16LE(end + 8)) throw new OfficeError('a split archive');
    if (count === 0xffff || dirSize === 0xffffffff || dirStart === 0xffffffff) throw new OfficeError('a 64-bit archive');
    if (count > OFFICE_LIMITS.entries) throw new OfficeError('too many entries');
    if (dirStart + dirSize > end) throw new OfficeError('the directory runs past its end');
    let at = dirStart;
    for (let n = 0; n < count; n++) {
      if (at + 46 > end || b.readUInt32LE(at) !== 0x02014b50) throw new OfficeError('a damaged directory entry');
      const nameLen = b.readUInt16LE(at + 28);
      const next = at + 46 + nameLen + b.readUInt16LE(at + 30) + b.readUInt16LE(at + 32);
      if (next > end) throw new OfficeError('a directory entry runs past the directory');
      const name = b.toString('utf8', at + 46, at + 46 + nameLen);
      // Two parts under one name would let the file say one thing to Office and another to Timmy.
      if (this.entries.has(name)) throw new OfficeError('a name appears twice');
      this.entries.set(name, { flags: b.readUInt16LE(at + 8), method: b.readUInt16LE(at + 10), crc: b.readUInt32LE(at + 16), compressed: b.readUInt32LE(at + 20), size: b.readUInt32LE(at + 24), offset: b.readUInt32LE(at + 42) });
      at = next;
    }
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** One part as text. Throws when it is missing, locked, packed in an unknown way, too large or not what it claims. */
  text(name: string): string {
    const e = this.entries.get(name);
    if (!e) throw new OfficeError(`no ${name}`);
    if (e.flags & 1) throw new OfficeError('a locked part');
    if (e.size > OFFICE_LIMITS.partBytes || e.size > this.budget) throw new OfficeError('a part too large to read');
    const b = this.bytes;
    if (e.offset + 30 > b.length || b.readUInt32LE(e.offset) !== 0x04034b50) throw new OfficeError('a damaged part');
    const start = e.offset + 30 + b.readUInt16LE(e.offset + 26) + b.readUInt16LE(e.offset + 28);
    if (start + e.compressed > b.length) throw new OfficeError('a part runs past the end of the file');
    const packed = b.subarray(start, start + e.compressed);
    let out: Buffer;
    if (e.method === 0) out = Buffer.from(packed);
    else if (e.method === 8) {
      try {
        // The ceiling is the size the directory claims: a part that unpacks to more than it said stops right there.
        out = inflateRawSync(packed, { maxOutputLength: Math.max(1, e.size) });
      } catch {
        throw new OfficeError('a part that does not unpack');
      }
    } else throw new OfficeError('a part packed in an unknown way');
    if (out.length !== e.size || crc32(out) !== e.crc) throw new OfficeError('a part that is not what the directory says');
    this.budget -= out.length;
    return out.toString('utf8');
  }
}

/* ───────────── The XML ───────────── */

type Token = { tag: string; close: boolean; self: boolean; attrs: string } | { text: string };

/** Walks XML as a flat run of tags and text, in one pass. Nothing is expanded and nothing is looked up. */
function* tokens(xml: string): Generator<Token> {
  const re = /<([^>]*)>|([^<]+)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[2] !== undefined) {
      yield { text: m[2] };
      continue;
    }
    const inner = m[1]!;
    if (/^!DOCTYPE/i.test(inner)) throw new OfficeError('a document type declaration');
    if (inner.startsWith('?') || inner.startsWith('!')) continue;
    const name = /^\/?\s*([A-Za-z_][\w.:-]*)/.exec(inner);
    if (!name) continue;
    yield { tag: name[1]!, close: inner.startsWith('/'), self: inner.endsWith('/'), attrs: inner.slice(name[0].length) };
  }
}

/** The five standard escapes and numeric characters; any other `&name;` is left exactly as written. */
function unescape(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g, (_whole, e: string) => {
    if (e[0] !== '#') return ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[e]!;
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    // A character XML itself doesn't allow (a NUL, a lone surrogate) is dropped.
    const allowed = code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
    return allowed ? String.fromCodePoint(code) : '';
  });
}

const attr = (attrs: string, name: string) => {
  const m = new RegExp(`(?:^|\\s)${name.replace(/[:.]/g, '\\$&')}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? unescape(m[2] ?? m[3] ?? '') : undefined;
};

/** Collects text up to a limit; past it, the rest of the file is not read. */
class Out {
  private parts: string[] = [];
  private length = 0;
  constructor(private limit: number) {}
  get full() {
    return this.length > this.limit;
  }
  add(s: string) {
    if (!s || this.full) return;
    this.parts.push(s);
    this.length += s.length;
  }
  done() {
    return this.parts
      .join('')
      .replace(/\u0000/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

/* ───────────── Word ───────────── */

function docx(zip: Zip, limit: number): string {
  const out = new Out(limit);
  let inText = false;
  let cellDepth = 0;
  let cell: string[] = [];
  let row: string[] = [];
  for (const t of tokens(zip.text('word/document.xml'))) {
    if (out.full) break;
    if ('text' in t) {
      if (!inText) continue;
      if (cellDepth > 0) cell.push(unescape(t.text));
      else out.add(unescape(t.text));
      continue;
    }
    const put = (s: string) => (cellDepth > 0 ? cell.push(s) : out.add(s));
    switch (t.tag) {
      case 'w:t':
        inText = !t.close && !t.self;
        break;
      case 'w:tab':
        if (!t.close) put('\t');
        break;
      case 'w:br':
      case 'w:cr':
        if (!t.close) put(cellDepth > 0 ? ' ' : '\n');
        break;
      case 'w:p':
        if (t.close) put(cellDepth > 0 ? ' ' : '\n');
        break;
      case 'w:tc':
        // A table reads a row to a line, its cells apart; a table inside a cell runs into that cell.
        if (t.self) break;
        if (!t.close) {
          if (++cellDepth === 1) cell = [];
        } else if (cellDepth > 0 && --cellDepth === 0) row.push(cell.join('').replace(/\s+/g, ' ').trim());
        break;
      case 'w:tr':
        if (t.close && cellDepth === 0) {
          out.add(`${row.join(' | ')}\n`);
          row = [];
        } else if (!t.close && cellDepth === 0) row = [];
        break;
    }
  }
  return out.done();
}

/* ───────────── PowerPoint ───────────── */

/** Where each relationship of a part points, by its id. */
function relations(zip: Zip, relsPath: string, baseDir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!zip.has(relsPath)) return map;
  for (const t of tokens(zip.text(relsPath))) {
    if ('text' in t || t.tag !== 'Relationship' || t.close) continue;
    const id = attr(t.attrs, 'Id');
    const target = attr(t.attrs, 'Target');
    if (!id || !target || attr(t.attrs, 'TargetMode') === 'External') continue;
    map.set(id, normalize(target.startsWith('/') ? target.slice(1) : `${baseDir}${target}`));
  }
  return map;
}

/** Resolves "./" and "../" inside the archive. A path that climbs out of it resolves to nothing usable. */
function normalize(path: string): string {
  const parts: string[] = [];
  for (const p of path.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (!parts.length) return '';
      parts.pop();
    } else parts.push(p);
  }
  return parts.join('/');
}

function pptx(zip: Zip, limit: number): string {
  // Slides in the order the deck shows them; failing that, in the order of their numbers.
  let slides: string[] = [];
  if (zip.has('ppt/presentation.xml')) {
    const rels = relations(zip, 'ppt/_rels/presentation.xml.rels', 'ppt/');
    for (const t of tokens(zip.text('ppt/presentation.xml'))) {
      if ('text' in t || t.tag !== 'p:sldId' || t.close) continue;
      const target = rels.get(attr(t.attrs, 'r:id') ?? '');
      if (target && zip.has(target) && !slides.includes(target)) slides.push(target);
      if (slides.length >= OFFICE_LIMITS.slides) break;
    }
  }
  if (!slides.length) {
    slides = zip
      .names()
      .filter((n) => /^ppt\/slides\/slide\d{1,5}\.xml$/.test(n))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]))
      .slice(0, OFFICE_LIMITS.slides);
  }
  if (!slides.length) throw new OfficeError('a deck with no slides');
  const out = new Out(limit);
  slides.forEach((path, i) => {
    if (out.full) return;
    const words = new Out(limit);
    let inText = false;
    for (const t of tokens(zip.text(path))) {
      if (words.full) break;
      if ('text' in t) {
        if (inText) words.add(unescape(t.text));
        continue;
      }
      if (t.tag === 'a:t') inText = !t.close && !t.self;
      else if ((t.tag === 'a:br' && !t.close) || (t.tag === 'a:p' && t.close)) words.add('\n');
      else if (t.tag === 'a:tab' && !t.close) words.add('\t');
    }
    out.add(`${i ? '\n\n' : ''}Slide ${i + 1}\n${words.done()}`);
  });
  return out.done();
}

/* ───────────── Excel ───────────── */

/** "AB12" → its column, counted from 0. */
const columnOf = (ref: string) => {
  const letters = /^([A-Z]{1,3})\d*$/.exec(ref)?.[1];
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function xlsx(zip: Zip, limit: number): string {
  // The first sheet the workbook lists that isn't hidden, as a Google Sheet's first sheet is read.
  const rels = relations(zip, 'xl/_rels/workbook.xml.rels', 'xl/');
  let sheetPath = '';
  let firstAny = '';
  for (const t of tokens(zip.text('xl/workbook.xml'))) {
    if ('text' in t || t.tag !== 'sheet' || t.close) continue;
    const target = rels.get(attr(t.attrs, 'r:id') ?? '') ?? '';
    if (!target || !zip.has(target)) continue;
    firstAny ||= target;
    if (!/hidden/i.test(attr(t.attrs, 'state') ?? '')) {
      sheetPath = target;
      break;
    }
  }
  sheetPath ||= firstAny;
  if (!sheetPath) throw new OfficeError('a workbook with no sheet');

  // Text cells point into the workbook's list of strings.
  const strings: string[] = [];
  if (zip.has('xl/sharedStrings.xml')) {
    let cur: string[] | null = null;
    let inText = false;
    let phonetic = 0;
    for (const t of tokens(zip.text('xl/sharedStrings.xml'))) {
      if ('text' in t) {
        if (cur && inText && !phonetic) cur.push(unescape(t.text));
        continue;
      }
      if (t.tag === 'si') {
        if (!t.close && !t.self) cur = [];
        else if (t.close && cur) {
          strings.push(cur.join(''));
          cur = null;
        } else if (t.self) strings.push('');
      } else if (t.tag === 't') inText = !t.close && !t.self;
      else if (t.tag === 'rPh') phonetic += t.self ? 0 : t.close ? -1 : 1;
    }
  }

  const out = new Out(limit);
  let rowNo = 0;
  let cells: string[] = [];
  let cell: { col: number; type: string; value: string[]; inV: boolean; inT: boolean } | null = null;
  let nextCol = 0;
  const endRow = () => {
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    if (cells.length) out.add(`${cells.join('\t')}\n`);
    cells = [];
  };
  for (const t of tokens(zip.text(sheetPath))) {
    if (out.full) break;
    if ('text' in t) {
      if (cell && (cell.inV || cell.inT)) cell.value.push(unescape(t.text));
      continue;
    }
    if (t.tag === 'row') {
      if (t.close) {
        endRow();
        continue;
      }
      const r = Number(attr(t.attrs, 'r'));
      rowNo = Number.isInteger(r) && r > 0 ? r : rowNo + 1;
      if (rowNo > OFFICE_LIMITS.rows) break;
      cells = [];
      nextCol = 0;
      if (t.self) endRow();
    } else if (t.tag === 'c') {
      if (!t.close) {
        const ref = attr(t.attrs, 'r');
        const col = ref ? columnOf(ref) : nextCol;
        nextCol = col + 1;
        cell = { col, type: attr(t.attrs, 't') ?? 'n', value: [], inV: false, inT: false };
        if (t.self) cell = null;
      }
      if (t.close && cell) {
        const raw = cell.value.join('');
        let shown = raw;
        if (cell.type === 's') shown = strings[Number(raw)] ?? '';
        else if (cell.type === 'b') shown = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
        if (cell.col >= 0 && cell.col < OFFICE_LIMITS.columns) {
          while (cells.length < cell.col) cells.push('');
          cells[cell.col] = shown.replace(/[\t\r\n]+/g, ' ');
        }
        cell = null;
      }
    } else if (cell && t.tag === 'v') cell.inV = !t.close && !t.self;
    else if (cell && t.tag === 't' && cell.type === 'inlineStr') cell.inT = !t.close && !t.self;
  }
  return out.done();
}

/**
 * The words of an Office file, at most about `limit` characters of them. Throws OfficeError for anything that is not
 * a readable file of that kind.
 */
export function officeText(bytes: Uint8Array, kind: OfficeKind, limit: number): string {
  const zip = new Zip(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  try {
    if (kind === 'docx') return docx(zip, limit);
    if (kind === 'pptx') return pptx(zip, limit);
    return xlsx(zip, limit);
  } catch (e) {
    if (e instanceof OfficeError) throw e;
    // Anything else (a regular expression or a number that fell over on odd input) is the file's doing, not ours.
    throw new OfficeError('the file could not be read');
  }
}
