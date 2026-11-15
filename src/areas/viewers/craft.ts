/*
 * The Craft apps (storytold/wordcraft, gridcraft, deckcraft, pdfcraft; MIT or
 * Apache-2.0): open-source document, spreadsheet, presentation and PDF editors
 * written in Rust and compiled to WebAssembly. Their web builds are served from
 * this site under /craft/<app>/ and framed with ?host=parent, so they run on
 * our origin and exchange files with the page through the craft-web-host
 * messages (ready → open; save, dirty, failed, handoff).
 */
import type { FileKind, WFile, WS } from '../../data/ws-types';
import { getBlob } from '../../lib/blobs';
import { exportNative, officeExt, withExt } from '../../lib/office';

export type CraftApp = 'wordcraft' | 'gridcraft' | 'deckcraft' | 'pdfcraft';

export const CRAFT: Record<CraftApp, { title: string; noun: string; kind: FileKind; exts: string[] }> = {
  wordcraft: { title: 'WordCraft', noun: 'document', kind: 'doc', exts: ['docx', 'doc', 'dotx', 'odt', 'ott', 'rtf', 'txt', 'md', 'markdown', 'html', 'htm'] },
  gridcraft: { title: 'GridCraft', noun: 'spreadsheet', kind: 'sheet', exts: ['xlsx', 'xlsm', 'xls', 'ods', 'csv', 'tsv', 'numbers'] },
  deckcraft: { title: 'DeckCraft', noun: 'presentation', kind: 'slides', exts: ['pptx', 'potx', 'key'] },
  pdfcraft: { title: 'PdfCraft', noun: 'PDF', kind: 'pdf', exts: ['pdf'] },
};

export const CRAFT_APPS = Object.keys(CRAFT) as CraftApp[];

export const extOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();

export const appForExt = (ext: string): CraftApp | undefined => CRAFT_APPS.find((a) => CRAFT[a].exts.includes(ext.toLowerCase()));

export const appForKind = (kind: FileKind): CraftApp | undefined => CRAFT_APPS.find((a) => CRAFT[a].kind === kind);

/** The kind a file of this extension is listed as in Drive. */
export const kindForExt = (ext: string): FileKind | undefined => {
  const app = appForExt(ext);
  if (app) return CRAFT[app].kind;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  return undefined;
};

/** Every extension the viewers open, for a file picker's accept list. */
export const ACCEPT = CRAFT_APPS.flatMap((a) => CRAFT[a].exts.map((e) => `.${e}`)).join(',');

/** Whether the file has an office or PDF version of its own (not exported from a Timmy body). */
export const hasOwnBytes = (f: WFile) => !!(f.stored || f.sample);

/** The Craft app that opens this file, if any. */
export function appForFile(f: WFile): CraftApp | undefined {
  if (f.format) return appForExt(f.format);
  return appForKind(f.kind);
}

/** Whether Timmy has its own editor body for the file (a Timmy doc, sheet or deck). */
export const hasNativeBody = (f: WFile, ws: WS) =>
  (f.kind === 'doc' && !!ws.docs[f.id]) || (f.kind === 'sheet' && !!ws.sheets[f.id]) || (f.kind === 'slides' && !!ws.decks[f.id]);

/**
 * The bytes a viewer opens: what this browser stored, the demo's sample, or an
 * export of the Timmy doc, sheet or deck. Undefined when there's nothing to open.
 */
export async function fileBytes(f: WFile, ws: WS): Promise<{ name: string; bytes: Uint8Array } | undefined> {
  const ext = f.format ?? officeExt(f.kind);
  if (f.stored) {
    const blob = await getBlob(f.id);
    if (blob) return { name: withExt(f.name, extOf(blob.name) || ext), bytes: new Uint8Array(blob.bytes) };
  }
  if (f.sample) {
    try {
      const res = await fetch(f.sample);
      if (res.ok) return { name: withExt(f.name, extOf(f.sample) || ext), bytes: new Uint8Array(await res.arrayBuffer()) };
    } catch {
      /* fall through to an export */
    }
  }
  const out = exportNative(f, ws);
  return out ? { name: withExt(f.name, ext), bytes: out } : undefined;
}

/** Saves the bytes as a download in the browser. */
export function download(name: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer]));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
