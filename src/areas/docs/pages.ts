/*
 * Pages: docs that hold other docs (sub-pages), their place in the tree, and
 * the trash. A page in the trash leaves every list until it's restored; its
 * sub-pages go with it and come back with it.
 */
import { NOW } from '../../data/mock';
import type { Block, WFile, WS } from '../../data/ws-types';
import { put, remove, patch, type WsOp } from '../../state/ws';
import { FILING_FOLDER } from '../../data/ws-mock';

/** Docs you write in Timmy (not shortcuts or attachments waiting to be filed). */
export const isPage = (f: WFile) => f.kind === 'doc' && !f.shortcutOf && f.folder !== FILING_FOLDER;

export const childPages = (W: WS, id: string) =>
  Object.values(W.files)
    .filter((f) => f.parent === id && isPage(f))
    .sort((a, b) => a.name.localeCompare(b.name));

/** Top-level pages: docs that aren't inside another page that still exists. */
export const rootPages = (W: WS) =>
  Object.values(W.files)
    .filter((f) => isPage(f) && (!f.parent || !W.files[f.parent]))
    .sort((a, b) => b.updated.getTime() - a.updated.getTime());

export function descendants(W: WS, id: string): WFile[] {
  const out: WFile[] = [];
  const walk = (pid: string) => {
    for (const c of Object.values(W.files)) if (c.parent === pid && c.kind === 'doc') (out.push(c), walk(c.id));
  };
  walk(id);
  return out;
}

/** The chain of pages above this one, outermost first. */
export function ancestors(W: WS, file: WFile): WFile[] {
  const out: WFile[] = [];
  let p = file.parent ? (W.files[file.parent] ?? W.trash[file.parent]) : undefined;
  while (p && out.length < 12) {
    out.unshift(p);
    p = p.parent ? (W.files[p.parent] ?? W.trash[p.parent]) : undefined;
  }
  return out;
}

export const pageIcon = (W: WS, id: string) => W.docs[id]?.icon;

/** Move a page and its sub-pages to the trash. */
export function trashOps(W: WS, id: string): WsOp[] {
  const f = W.files[id];
  if (!f) return [];
  const ops: WsOp[] = [remove('files', id), put('trash', { ...f, trashed: NOW })];
  for (const d of descendants(W, id)) ops.push(remove('files', d.id), put('trash', { ...d, trashed: NOW, trashRoot: id }));
  // Unstar: starred pages in the trash would count against the limit.
  return ops;
}

/** Bring a page (and what went to the trash with it) back. */
export function restoreOps(W: WS, id: string): WsOp[] {
  const f = W.trash[id];
  if (!f) return [];
  const back = (x: WFile, detach: boolean): WFile => {
    const { trashed: _t, trashRoot: _r, ...rest } = x;
    return detach ? { ...rest, parent: undefined } : rest;
  };
  // A sub-page restored without its parent goes to the top level.
  const ops: WsOp[] = [remove('trash', id), put('files', back(f, !!f.parent && !W.files[f.parent]))];
  for (const t of Object.values(W.trash)) if (t.trashRoot === id) ops.push(remove('trash', t.id), put('files', back(t, false)));
  return ops;
}

/** Delete for good: the page, its sub-pages, and the links to them. */
export function purgeOps(W: WS, id: string): WsOp[] {
  const ids = [id, ...Object.values(W.trash).filter((t) => t.trashRoot === id).map((t) => t.id)];
  const ops: WsOp[] = ids.flatMap((x) => [remove('trash', x), remove('docs', x)]);
  const parent = W.trash[id]?.parent;
  const pdoc = parent ? W.docs[parent] : undefined;
  if (pdoc) ops.push(patch('docs', pdoc.id, { blocks: pdoc.blocks.filter((b: Block) => !(b.type === 'page' && ids.includes(b.file))) }));
  return ops;
}

export const trashedRoots = (W: WS) =>
  Object.values(W.trash)
    .filter((t) => !t.trashRoot)
    .sort((a, b) => (b.trashed?.getTime() ?? 0) - (a.trashed?.getTime() ?? 0));
