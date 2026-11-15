/*
 * Drive helpers: the naming convention, the folder tree, and the operations
 * behind the file menu (copy, shortcut, delete). Components dispatch the ops
 * these return with ws(...).
 */
import { NOW, PEOPLE } from '../../data/mock';
import { FILING_FOLDER, SHARED_FOLDER } from '../../data/ws-mock';
import type { Block, Folder, WFile, WS } from '../../data/ws-types';
import { MAX_DEPTH, childFolders, depthOf, put, remove, uid, type WsOp } from '../../state/ws';

export const ROOT = 'root';
export const ARCHIVE = 'f99';
export const TEMP = 'f06';
export const QUICK_SHARE = 'f04';
export const REFERENCE = 'f03';

export const isVirtual = (id: string) => id === SHARED_FOLDER || id === FILING_FOLDER;

/* ───────────── Naming convention ───────────── */

export type Grain = 'none' | 'year' | 'quarter' | 'month' | 'day';

export const GRAINS: { id: Exclude<Grain, 'none'>; label: string; example: string; when: string }[] = [
  { id: 'year', label: 'Year', example: '2026 Pricing tiers — Working sheet', when: 'Reviewed once a year' },
  { id: 'quarter', label: 'Quarter', example: '2026-Q4 Acme — Quote tracker', when: 'Planned by quarter' },
  { id: 'month', label: 'Month', example: '2026-11 Contacts — Backup', when: 'Monthly snapshots' },
  { id: 'day', label: 'Day', example: '2026-11-16 Acme — Revised quote summary', when: 'Tied to one day' },
];

/** Keywords for undated files, so you can search "project + type". */
export const KEYWORDS = ['Meeting notes', 'Briefing slides', 'Working sheet', 'Doc', 'Form'];

const pad = (n: number) => String(n).padStart(2, '0');

export const stamp = (grain: Grain, d: Date) => {
  const y = d.getFullYear();
  switch (grain) {
    case 'year':
      return `${y}`;
    case 'quarter':
      return `${y}-Q${Math.floor(d.getMonth() / 3) + 1}`;
    case 'month':
      return `${y}-${pad(d.getMonth() + 1)}`;
    case 'day':
      return `${y}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    default:
      return '';
  }
};

const PREFIX = /^(\d{4}-\d{2}-\d{2}|\d{4}-Q[1-4]|\d{4}-\d{2}|\d{4})\s+/;

/** Reads the date prefix of a name: its granularity, the date it stands for, and the rest. */
export const parseName = (name: string): { grain: Grain; date: Date | null; rest: string } => {
  const m = name.match(PREFIX);
  if (!m) return { grain: 'none', date: null, rest: name };
  const p = m[1]!;
  const rest = name.slice(m[0].length);
  const y = Number(p.slice(0, 4));
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return { grain: 'day', date: new Date(y, Number(p.slice(5, 7)) - 1, Number(p.slice(8, 10))), rest };
  if (/Q/.test(p)) return { grain: 'quarter', date: new Date(y, (Number(p.slice(6)) - 1) * 3, 1), rest };
  if (/^\d{4}-\d{2}$/.test(p)) return { grain: 'month', date: new Date(y, Number(p.slice(5, 7)) - 1, 1), rest };
  return { grain: 'year', date: new Date(y, 0, 1), rest };
};

export const withGrain = (name: string, grain: Grain, base: Date) => {
  const { rest } = parseName(name);
  return grain === 'none' ? rest : `${stamp(grain, base)} ${rest}`;
};

const KEYWORD_TAIL = new RegExp(`\\s+[—–-]\\s+(${KEYWORDS.map((k) => k.replace(/ /g, '\\s')).join('|')})$`, 'i');

export const keywordOf = (name: string) => name.match(KEYWORD_TAIL)?.[1] ?? null;

/** Adds the keyword as " — Keyword", replacing another keyword; toggles it off if already there. */
export const withKeyword = (name: string, kw: string) => {
  const current = keywordOf(name);
  const base = name.replace(KEYWORD_TAIL, '').trim();
  if (current?.toLowerCase() === kw.toLowerCase()) return base;
  return `${base} — ${kw}`;
};

/** Words worth searching in a description: lower-cased, deduplicated. */
export const descWords = (d?: string) =>
  [...new Set((d ?? '').split(/[\s,]+/).map((w) => w.trim()).filter(Boolean))];

/* ───────────── Folders ───────────── */

export const ancestors = (ws: WS, folderId: string): Folder[] => {
  const out: Folder[] = [];
  let f: Folder | undefined = ws.folders[folderId];
  while (f) {
    out.unshift(f);
    f = f.parent ? ws.folders[f.parent] : undefined;
  }
  return out;
};

export const isInside = (ws: WS, folderId: string, ancestorId: string) => ancestors(ws, folderId).some((f) => f.id === ancestorId);

/** Every folder in tree order, each with its depth (top level = 1). */
export const flatTree = (ws: WS, parent: string | null = null, depth = 1): { folder: Folder; depth: number }[] =>
  childFolders(ws, parent).flatMap((f) => [{ folder: f, depth }, ...flatTree(ws, f.id, depth + 1)]);

/** Folders and files placed directly in a folder (shortcuts count as files). */
export const filesIn = (ws: WS, folderId: string) => Object.values(ws.files).filter((f) => f.folder === folderId);

export const itemCount = (ws: WS, folderId: string) => childFolders(ws, folderId).length + filesIn(ws, folderId).length;

/** Everything below a folder, at any depth. */
export const filesUnder = (ws: WS, folderId: string) => {
  if (folderId === ROOT) return Object.values(ws.files).filter((f) => !isVirtual(f.folder));
  return Object.values(ws.files).filter((f) => f.folder === folderId || (!isVirtual(f.folder) && isInside(ws, f.folder, folderId)));
};

/** The next two-digit number after the highest one in use; 99 stays the archive. */
export const nextFreeNum = (ws: WS, parent: string | null) => {
  const used = new Set(childFolders(ws, parent).map((f) => Number(f.num)));
  const top = Math.max(0, ...[...used].filter((n) => n !== 99));
  for (let n = top + 1; n < 99; n++) if (!used.has(n)) return pad(n);
  for (let n = 1; n < 99; n++) if (!used.has(n)) return pad(n);
  return '';
};

export const canHoldSubfolder = (ws: WS, parent: string | null) => depthOf(ws, parent) < MAX_DEPTH;

/** The project a folder belongs to, if any of its ancestors is a project folder. */
export const projectFor = (ws: WS, folderId: string) => {
  const chain = new Set(ancestors(ws, folderId).map((f) => f.id));
  return Object.values(ws.projects).find((p) => chain.has(p.folder))?.id;
};

export const FOLDER_COLORS = ['slate', 'red', 'amber', 'sky', 'brown', 'green', 'violet', 'pink', 'teal', 'indigo'].map((c) => ({
  id: c,
  value: `var(--c-${c})`,
  label: c.charAt(0).toUpperCase() + c.slice(1),
}));

/* ───────────── Files ───────────── */

export const personLabel = (id: string) => (id === 'me' ? 'Me' : PEOPLE[id]?.name ?? id);

/** The file a row stands for: a shortcut opens its target. */
export const targetOf = (ws: WS, f: WFile) => (f.shortcutOf ? ws.files[f.shortcutOf] ?? f : f);

export const canRename = (f: WFile) => !!f.shortcutOf || f.owner === 'me';

export const canDelete = (f: WFile) => !!f.shortcutOf || f.folder === TEMP;

const copyBlocks = (blocks: Block[], prefix: string): Block[] => blocks.map((b, i) => ({ ...b, id: `${prefix}-b${i + 1}` }));

/**
 * A copy of a file and its doc, sheet or deck content, with new ids.
 * Shortcuts copy the file they point to.
 */
export const copyOps = (ws: WS, source: WFile, folder: string, name?: string): { ops: WsOp[]; id: string } => {
  const f = targetOf(ws, source);
  const id = uid(f.kind);
  const ops: WsOp[] = [
    put('files', {
      id,
      name: name ?? `${f.name} (copy)`,
      kind: f.kind,
      folder,
      updated: NOW,
      owner: 'me',
      description: f.description,
      project: projectFor(ws, folder) ?? f.project,
    }),
  ];
  const doc = ws.docs[f.id];
  if (doc) ops.push(put('docs', { id, template: doc.template, blocks: copyBlocks(doc.blocks, id) }));
  const sheet = ws.sheets[f.id];
  if (sheet) ops.push(put('sheets', { ...sheet, id, rows: sheet.rows.map((r) => ({ ...r })) }));
  const deck = ws.decks[f.id];
  if (deck) ops.push(put('decks', { id, slides: deck.slides.map((s, i) => ({ ...s, id: `${id}-s${i + 1}`, bullets: s.bullets && [...s.bullets] })) }));
  return { ops, id };
};

export const shortcutOps = (ws: WS, source: WFile, folder: string): { ops: WsOp[]; id: string } => {
  const f = targetOf(ws, source);
  const id = uid('shortcut');
  return {
    id,
    ops: [put('files', { id, name: f.name, kind: f.kind, folder, updated: NOW, owner: f.owner, shortcutOf: f.id, project: projectFor(ws, folder) })],
  };
};

/** Deletes a file with its content and any shortcuts that point at it. */
export const deleteOps = (ws: WS, f: WFile): WsOp[] => {
  if (f.shortcutOf) return [remove('files', f.id)];
  const ops: WsOp[] = [remove('files', f.id)];
  if (ws.docs[f.id]) ops.push(remove('docs', f.id));
  if (ws.sheets[f.id]) ops.push(remove('sheets', f.id));
  if (ws.decks[f.id]) ops.push(remove('decks', f.id));
  for (const s of Object.values(ws.files)) if (s.shortcutOf === f.id) ops.push(remove('files', s.id));
  return ops;
};

/** Short path text for a folder, e.g. "[02] Work › [10] Acme". */
export const shortPath = (ws: WS, folderId: string) => {
  if (folderId === SHARED_FOLDER) return 'Shared with me';
  if (folderId === FILING_FOLDER) return 'To file';
  if (folderId === ROOT) return 'My Drive';
  return ancestors(ws, folderId)
    .map((f) => `[${f.num}] ${f.name}`)
    .join(' › ');
};

export const daysAgo = (d: Date) => Math.round((NOW.getTime() - d.getTime()) / 86400000);

/* ───────────── Shared with me ───────────── */

export type ShareChoice = 'one-off' | 'shortcut' | 'copy';

/** Timmy's guess at what a shared file is for, and where it would be used. */
export const suggestShare = (ws: WS, f: WFile): { choice: ShareChoice; folder: string; why: string } => {
  const project = Object.values(ws.projects).find((p) => p.sources.includes(f.id) && p.status === 'active');
  if (/template/i.test(f.name)) return { choice: 'copy', folder: project?.folder ?? REFERENCE, why: 'It reads like a template you’ll fill in.' };
  if (project) return { choice: 'shortcut', folder: project.folder, why: `${project.name} drafts read it, and it keeps changing.` };
  if (/guideline|tracker|pricing|policy|handbook/i.test(f.name)) return { choice: 'shortcut', folder: REFERENCE, why: 'A live reference you’ll come back to.' };
  return { choice: 'one-off', folder: SHARED_FOLDER, why: 'Looks like something you’ll answer once.' };
};

export { SHARED_FOLDER, FILING_FOLDER };
