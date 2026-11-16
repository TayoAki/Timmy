/*
 * Helpers for the workspace collections (Drive, Docs, Sheets, Slides, Tasks,
 * Calendar, CRM, Projects, AI library). Components change data only through the
 * three builders below, dispatched with `ws(...)`:
 *
 *   dispatch(ws([put('tasks', task)], { toast: 'Task added', undo: true }))
 *   dispatch(ws([patch('files', id, { starred: true })]))
 *   dispatch(ws([remove('notes', id)]))
 */
import { NOW, PEOPLE } from '../data/mock';
import type { Person } from '../data/types';
import type { Col, Folder, ItemOf, Sheet, SheetColumn, WEvent, WS } from '../data/ws-types';
import { FILING_FOLDER, SHARED_FOLDER } from '../data/ws-mock';
import type { Route } from './store';

export type WsOp =
  | { op: 'put'; col: Col; item: { id: string } }
  | { op: 'patch'; col: Col; id: string; patch: object }
  | { op: 'remove'; col: Col; id: string };

export const put = <C extends Col>(col: C, item: ItemOf<C>): WsOp => ({ op: 'put', col, item });
export const patch = <C extends Col>(col: C, id: string, change: Partial<ItemOf<C>>): WsOp => ({ op: 'patch', col, id, patch: change });
export const remove = (col: Col, id: string): WsOp => ({ op: 'remove', col, id });

export interface WsOptions {
  /** Toast shown after the change. */
  toast?: string;
  /** Offer Undo on the toast. */
  undo?: boolean;
  /** Add a line to Timmy's activity log. */
  log?: string;
  /** Show the toast as a warning. */
  tone?: 'warn';
}

export const applyOps = (ws: WS, ops: WsOp[]): WS => {
  const next = { ...ws } as Record<Col, Record<string, { id: string }>>;
  for (const o of ops) {
    const col = { ...next[o.col] };
    if (o.op === 'put') col[o.item.id] = o.item;
    else if (o.op === 'patch' && col[o.id]) col[o.id] = { ...col[o.id]!, ...o.patch };
    else if (o.op === 'remove') delete col[o.id];
    next[o.col] = col;
  }
  return next as unknown as WS;
};

let seq = 0;
/** Unique id for new items, e.g. uid('task') → "task-lq3x9a-1". */
export const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`;

/* ───────────── People ───────────── */

/**
 * PEOPLE is the name directory the mail screens read. New contacts are added to
 * it too, so threads and avatars can show anyone you add in the CRM.
 */
export const registerPerson = (p: Person) => {
  PEOPLE[p.id] = { ...PEOPLE[p.id], ...p };
};

export const personName = (id: string) => (id === 'me' ? 'You' : PEOPLE[id]?.name ?? id);
export const firstName = (id: string) => personName(id).split(' ')[0]!;

const PROPER = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Q[1-4]|I)\b/;
/**
 * The phrase as it reads mid-sentence: "Revised quote" becomes "revised quote",
 * but names, companies, days and acronyms keep their capitals ("Priya owes you…",
 * "CFO approval", "Acme MSA").
 */
export const midSentence = (s: string) => {
  const word = s.match(/^[\p{L}\p{N}’'-]+/u)?.[0] ?? '';
  if (!word || /^[A-Z]{2}/.test(word) || PROPER.test(word)) return s;
  const proper = Object.values(PEOPLE).some((p) => p.name.split(' ').includes(word) || p.company?.split(' ')[0] === word);
  return proper ? s : s.charAt(0).toLowerCase() + s.slice(1);
};

/* ───────────── Drive ───────────── */

export const folderLabel = (f: Folder) => `[${f.num}] ${f.name}`;

/** Breadcrumb names from My Drive down to the folder. */
export const pathOf = (ws: WS, folderId: string): string[] => {
  if (folderId === SHARED_FOLDER) return ['Shared with me'];
  if (folderId === FILING_FOLDER) return ['To file'];
  const out: string[] = [];
  let f: Folder | undefined = ws.folders[folderId];
  while (f) {
    out.unshift(folderLabel(f));
    f = f.parent ? ws.folders[f.parent] : undefined;
  }
  return ['My Drive', ...out];
};

/** Folder depth: top-level folders are 1. Keep it to 5. */
export const depthOf = (ws: WS, folderId: string | null): number => {
  let n = 0;
  let f = folderId ? ws.folders[folderId] : undefined;
  while (f) {
    n++;
    f = f.parent ? ws.folders[f.parent] : undefined;
  }
  return n;
};

export const MAX_DEPTH = 5;
export const MAX_STARRED = 5;

export const childFolders = (ws: WS, parent: string | null) =>
  Object.values(ws.folders)
    .filter((f) => f.parent === parent)
    .sort((a, b) => a.num.localeCompare(b.num));

/* ───────────── Sheets ───────────── */

/**
 * Evaluates a named-column formula such as "[Seats] * [Price] * 12".
 * A formula may use other formula columns; unfinished or circular formulas give an empty cell.
 */
export const evalFormula = (formula: string, row: Record<string, string | number>, columns: SheetColumn[], depth = 0): number | '' => {
  if (depth > 8) return '';
  let ok = true;
  const expr = formula.replace(/\[([^\]]+)\]/g, (_, name: string) => {
    const col = columns.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
    if (!col) {
      ok = false;
      return '0';
    }
    const raw = col.formula ? evalFormula(col.formula, row, columns, depth + 1) : row[col.key];
    const v = Number(raw);
    if (raw === '' || raw === undefined || Number.isNaN(v)) ok = false;
    return String(v);
  });
  if (!ok || !/^[\d\s.+\-*/()]+$/.test(expr)) return '';
  try {
    // Only digits and arithmetic operators reach this point.
    const value = Function(`"use strict"; return (${expr});`)() as number;
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : '';
  } catch {
    return '';
  }
};

export const cellValue = (sheet: Sheet, row: Record<string, string | number>, col: SheetColumn) =>
  col.formula ? evalFormula(col.formula, row, sheet.columns) : row[col.key] ?? '';

export const fmtCell = (v: string | number, col: SheetColumn) => {
  if (v === '' || v === undefined) return '';
  if (col.type === 'currency') return Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  if (col.type === 'number') return Number(v).toLocaleString('en-US');
  if (col.type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number);
    return new Date(y!, m! - 1, d!).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return String(v);
};

/* ───────────── Calendar ───────────── */

export const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export const eventsOn = (ws: WS, day: Date): WEvent[] =>
  Object.values(ws.events)
    .filter((e) => sameDay(e.start, day))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

export const todaysEvents = (ws: WS) => eventsOn(ws, NOW);

/** Monday of the week containing `day`. */
export const weekStart = (day: Date) => {
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return d;
};

export const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const parseIsoDay = (s: string, h = 0, m = 0) => {
  const [y, mo, d] = s.split('-').map(Number);
  return new Date(y!, mo! - 1, d!, h, m);
};

/* ───────────── Links between screens ───────────── */

/**
 * Turns a saved link ("file:acme-quote", "box:waiting", "tasks", "people",
 * "calendar", "project:acme", "contact:dana", "thread:acme-quote") into a route.
 */
export const routeFromHref = (href: string): Route => {
  const [kind, idPart] = href.split(':') as [string, string | undefined];
  switch (kind) {
    case 'file':
      return { view: 'file', id: idPart! };
    case 'box':
      return { view: 'box', box: idPart as never, tab: 'all' };
    case 'thread':
      return { view: 'thread', id: idPart!, tab: 'conversation' };
    case 'project':
      return { view: 'project', id: idPart!, tab: 'overview' };
    case 'contact':
      return { view: 'contact', id: idPart!, tab: 'overview' };
    case 'tasks':
      return { view: 'tasks', tab: 'board' };
    case 'calendar':
      return { view: 'calendar', tab: 'week' };
    case 'people':
      return { view: 'people', tab: 'priority' };
    case 'library':
      return { view: 'library', tab: 'prompts' };
    case 'docs':
      return { view: 'docs', tab: 'recent' };
    case 'activity':
      return { view: 'activity', tab: 'all' };
    case 'campaign':
      return { view: 'campaign', id: idPart!, tab: 'analytics' };
    case 'unibox':
      return { view: 'outbound', tab: 'unibox', id: idPart };
    case 'outbound':
      return { view: 'outbound', tab: (idPart as never) || 'leads' };
    case 'social':
      return { view: 'social', tab: 'overview' };
    default:
      return { view: 'today', tab: 'brief' };
  }
};

/* ───────────── Project running notes ───────────── */

/**
 * Ops that add a dated decision to the top of a project's running-notes table
 * (the doc's first table: Date / Decision or update / Source).
 */
export const decisionOps = (ws: WS, projectId: string, text: string, source: string): WsOp[] => {
  const project = ws.projects[projectId];
  const doc = project?.notesDoc ? ws.docs[project.notesDoc] : undefined;
  if (!doc) return [];
  const row = [NOW.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), text, source];
  const idx = doc.blocks.findIndex((b) => b.type === 'table');
  const blocks =
    idx >= 0
      ? doc.blocks.map((b, i) => (i === idx && b.type === 'table' ? { ...b, rows: [row, ...b.rows] } : b))
      : [{ id: uid('b'), type: 'table' as const, columns: ['Date', 'Decision or update', 'Source'], rows: [row] }, ...doc.blocks];
  return [patch('docs', doc.id, { blocks }), patch('files', doc.id, { updated: NOW })];
};
