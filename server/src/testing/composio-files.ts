/**
 * The stand-in OneDrive, and the parts of the stand-in Google Drive that the nightly check uses. Like the rest of
 * the stand-in provider (composio.ts), it answers the same tool slugs with the shapes the real toolkits return, so the
 * sync, search and reading code runs unchanged in tests.
 *
 * It also builds real .docx, .xlsx and .pptx files from a file's `text` or `rows`, so what is downloaded is an
 * actual zip archive that the reader in sync/office-text.ts has to open the hard way.
 */
import { crc32, deflateRawSync } from 'node:zlib';
import type { ToolResult } from '../providers/composio';
import type { FakeComposio, FakeFile, FakeMailbox } from './composio';

const ok = (data: Record<string, unknown>): ToolResult => ({ successful: true, data, error: null });
const refuse = (error: string): ToolResult => ({ successful: false, data: {}, error });

/* ───────────── Office files ───────────── */

/** A zip archive of the given parts, as Office writes one. `store` leaves the parts unpacked. */
export function zipOf(parts: [string, string | Uint8Array][], opts: { store?: boolean } = {}): Uint8Array {
  const local: Buffer[] = [];
  const dir: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of parts) {
    const raw = Buffer.from(typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
    const packed = opts.store ? raw : deflateRawSync(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(opts.store ? 0 : 8, 8);
    head.writeUInt32LE(crc32(raw), 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(opts.store ? 0 : 8, 10);
    entry.writeUInt32LE(crc32(raw), 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    local.push(head, nameBytes, packed);
    dir.push(entry, nameBytes);
    offset += head.length + nameBytes.length + packed.length;
  }
  const dirBytes = Buffer.concat(dir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(dirBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, dirBytes, end]));
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const types = (main: string) => `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="${main}" ContentType="application/xml"/></Types>`;

/** A Word document: each line of `text` is a paragraph. */
export function docxOf(text: string): Uint8Array {
  const body = text
    .split('\n')
    .map((line) => `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`)
    .join('');
  return zipOf([
    ['[Content_Types].xml', types('/word/document.xml')],
    ['word/document.xml', `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`],
  ]);
}

/** A workbook with one sheet of `rows`. Words go in the shared list of strings, numbers in the cells, as Excel does. */
export function xlsxOf(rows: (string | number)[][]): Uint8Array {
  const strings: string[] = [];
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((v, c) => {
          if (typeof v === 'number') return `<c r="${col(c)}${r + 1}"><v>${v}</v></c>`;
          strings.push(v);
          return `<c r="${col(c)}${r + 1}" t="s"><v>${strings.length - 1}</v></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  return zipOf([
    ['[Content_Types].xml', types('/xl/workbook.xml')],
    ['xl/workbook.xml', `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="sharedStrings" Target="sharedStrings.xml"/></Relationships>`],
    ['xl/sharedStrings.xml', `${XML}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`],
    ['xl/worksheets/sheet1.xml', `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`],
  ]);
}

/** A deck: slides are split by a blank line, and each line of a slide is a paragraph. */
export function pptxOf(text: string): Uint8Array {
  const slides = text.split('\n\n');
  const parts: [string, string][] = [
    ['[Content_Types].xml', types('/ppt/presentation.xml')],
    [
      'ppt/presentation.xml',
      `${XML}<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst></p:presentation>`,
    ],
    ['ppt/_rels/presentation.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 2}" Type="slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`],
  ];
  slides.forEach((s, i) => {
    const paras = s
      .split('\n')
      .map((line) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${esc(line)}</a:t></a:r></a:p>`)
      .join('');
    parts.push([`ppt/slides/slide${i + 1}.xml`, `${XML}<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/>${paras}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`]);
  });
  return zipOf(parts);
}

export const OFFICE_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** The bytes a stand-in file downloads as: its own, or an Office file built from its text or rows. */
export function bytesOf(f: FakeFile): Uint8Array {
  if (f.bytes) return f.bytes;
  if (f.mimeType === OFFICE_TYPES.docx) return docxOf(f.text ?? '');
  if (f.mimeType === OFFICE_TYPES.xlsx) return xlsxOf(f.rows ?? []);
  if (f.mimeType === OFFICE_TYPES.pptx) return pptxOf(f.text ?? '');
  return new TextEncoder().encode(f.text ?? '');
}

/**
 * A file made in, or thrown out of, a stand-in Drive or OneDrive the way a person would, with the signed event the
 * provider sends for it. A OneDrive file's type follows its name (.docx, .xlsx, .pptx; a Word document otherwise).
 * Null when the file to throw away isn't there.
 */
export function fakeFileEvent(fake: FakeComposio, account: string, app: 'gdrive' | 'onedrive', change: { add: Partial<FakeFile> & { name: string } } | { trash: string }) {
  const box = fake.accounts.get(account)!;
  if ('add' in change) {
    if (app === 'onedrive') {
      const ext = /\.(docx|xlsx|pptx)$/i.exec(change.add.name)?.[1]?.toLowerCase() as keyof typeof OFFICE_TYPES | undefined;
      const file = fake.addFile(account, { mimeType: OFFICE_TYPES[ext ?? 'docx'], ...change.add });
      return fake.event(account, 'ONE_DRIVE_FILE_CREATED_TRIGGER', { event_type: 'created', item: { item_id: file.id, name: file.name, type: 'file', deleted: false } }).webhook;
    }
    const file = fake.addFile(account, change.add);
    return fake.event(account, 'GOOGLEDRIVE_FILE_CREATED_TRIGGER', { event_type: 'created', file: { id: file.id, name: file.name } }).webhook;
  }
  const file = box.files.find((f) => f.name === change.trash && !f.deleted && !f.trashed);
  if (!file) return null;
  if (app === 'onedrive') {
    fake.changeFile(account, file.id, { deleted: true });
    return fake.event(account, 'ONE_DRIVE_ITEM_DELETED_TRIGGER', { event_type: 'deleted', item: { item_id: file.id, name: file.name, deleted: true } }).webhook;
  }
  file.trashed = true;
  return fake.event(account, 'GOOGLEDRIVE_FILE_DELETED_OR_TRASHED_TRIGGER', { event_type: 'trashed', file_id: file.id, name: file.name }).webhook;
}

/* ───────────── The stand-in OneDrive ───────────── */

const FOLDER = 'application/vnd.google-apps.folder';
const driveIdOf = (box: FakeMailbox) => `drive-${box.userId.replace(/[^a-z0-9]/gi, '').slice(0, 12)}`;

/** A file as Microsoft Graph returns it in a list of changes. */
function graphItem(box: FakeMailbox, f: FakeFile) {
  const parentReference = { driveId: driveIdOf(box), driveType: 'personal', id: 'root-id', path: '/drive/root:' };
  if (f.deleted) return { id: f.id, name: f.name, deleted: { state: 'deleted' }, parentReference };
  const owner = { user: { displayName: f.owner.split('@')[0], email: f.owner } };
  return {
    id: f.id,
    name: f.name,
    size: f.size ?? bytesOf(f).length,
    webUrl: f.link ?? `https://onedrive.live.com/edit.aspx?resid=${encodeURIComponent(f.id)}`,
    createdDateTime: f.modifiedTime,
    lastModifiedDateTime: f.modifiedTime,
    createdBy: owner,
    lastModifiedBy: owner,
    parentReference,
    ...(f.mimeType === FOLDER ? { folder: { childCount: 0 } } : { file: { mimeType: f.mimeType, hashes: { quickXorHash: 'x' } } }),
    ...(f.owner !== box.address ? { shared: { owner } } : {}),
  };
}

export interface FakeFilesHost {
  /** The number of the last change made in any stand-in drive. */
  fileSeq: number;
  /** Puts bytes in the stand-in file store and returns the address a download tool would hand back. */
  stash(connectedAccountId: string, bytes: Uint8Array): string;
}

const GRAPH = 'https://graph.microsoft.com/v1.0/me/drive/root/delta';

/**
 * Answers a OneDrive tool, or the Drive tools only the nightly check uses. Returns null for any other slug, so the
 * caller can say it has no such tool.
 */
export function fakeFileTool(host: FakeFilesHost, connectedAccountId: string, box: FakeMailbox, slug: string, args: Record<string, unknown>): ToolResult | null {
  switch (slug) {
    case 'ONE_DRIVE_LIST_DRIVES':
      return ok({ value: [{ id: driveIdOf(box), name: 'OneDrive', driveType: 'personal', owner: { user: { id: 'user-1', email: box.address, display_name: 'Stand-in person' } } }] });
    case 'ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES': {
      if (args.token !== undefined && typeof args.token !== 'string') return refuse('Invalid request data provided - token: Input should be a valid string');
      if (args.top !== undefined && !Number.isInteger(args.top)) return refuse('Invalid request data provided - top: Input should be a valid integer');
      if (args.select !== undefined && typeof args.select !== 'string') return refuse('Invalid request data provided - select: Input should be a valid string');
      if (box.resyncRequired) {
        box.resyncRequired = false;
        return refuse('Microsoft Graph returned 410 Gone: resyncRequired. The delta token has expired; start over.');
      }
      const top = Number(args.top ?? 200);
      const token = String(args.token ?? '');
      if (token === 'latest') return ok({ value: [], '@odata.deltaLink': `${GRAPH}?token=fake-seq-${host.fileSeq}` });
      // A walk of the whole drive as it stood when the walk began, or the changes since a link handed out earlier.
      const walk = /skiptoken=fake-(\d+)-(\d+)/.exec(token);
      const since = /token=fake-seq-(\d+)/.exec(token);
      let list: FakeFile[];
      let start = 0;
      let at: number;
      if (since) {
        at = host.fileSeq;
        list = box.files.filter((f) => (f.seq ?? 0) > Number(since[1]));
      } else {
        at = walk ? Number(walk[2]) : host.fileSeq;
        start = walk ? Number(walk[1]) : 0;
        list = box.files.filter((f) => !f.deleted && (f.seq ?? 0) <= at);
      }
      list = [...list].sort((a, b) => (since ? (a.seq ?? 0) - (b.seq ?? 0) : a.id.localeCompare(b.id)));
      if (since) {
        // A change list moves on from where it was: each page continues after the last change it carried.
        const page = list.slice(0, top);
        const more = list.length > top;
        const last = page.length ? (page[page.length - 1]!.seq ?? 0) : Number(since[1]);
        return ok({ value: page.map((f) => graphItem(box, f)), ...(more ? { '@odata.nextLink': `${GRAPH}?token=fake-seq-${last}` } : { '@odata.deltaLink': `${GRAPH}?token=fake-seq-${at}` }) });
      }
      // The walk starts with the drive's own top folder, as Graph's does.
      const root = start === 0 ? [{ id: 'root-id', name: 'root', root: {}, folder: { childCount: list.length }, parentReference: { driveId: driveIdOf(box) } }] : [];
      const page = list.slice(start, start + top);
      const more = start + top < list.length;
      return ok({ value: [...root, ...page.map((f) => graphItem(box, f))], ...(more ? { '@odata.nextLink': `${GRAPH}?$skiptoken=fake-${start + top}-${at}` } : { '@odata.deltaLink': `${GRAPH}?token=fake-seq-${at}` }) });
    }
    case 'ONE_DRIVE_DOWNLOAD_FILE': {
      if (typeof args.item_id !== 'string' || typeof args.file_name !== 'string') return refuse('Invalid request data provided - item_id and file_name are required strings');
      if (args.drive_id !== undefined && args.drive_id !== driveIdOf(box)) return refuse('itemNotFound: The resource could not be found.');
      const f = box.files.find((x) => x.id === args.item_id && !x.deleted);
      if (!f) return refuse('itemNotFound: The resource could not be found.');
      if (f.mimeType === FOLDER) return refuse('The item is a folder, not a file.');
      return ok({ content: { name: args.file_name, mimetype: f.mimeType, s3url: host.stash(connectedAccountId, bytesOf(f)) } });
    }
    case 'GOOGLEDRIVE_GET_FILE_METADATA': {
      if (typeof args.fileId !== 'string') return refuse('Invalid request data provided - fileId: Field required');
      const f = box.files.find((x) => x.id === args.fileId);
      // Drive's own answer for a file deleted for good, or one the person can no longer see.
      if (!f) return refuse(`404 Client Error: Not Found. File not found: ${args.fileId}.`);
      return ok({ id: f.id, name: f.name, mimeType: f.mimeType, trashed: !!f.trashed });
    }
    default:
      return null;
  }
}
