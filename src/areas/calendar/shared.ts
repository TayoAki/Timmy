/*
 * Calendar helpers shared by the Calendar and Tasks areas: event kinds, a tiny
 * UI store (hidden kinds, selected event) that the sidebar, main column and
 * context panel all read, free-slot search and running-notes topics.
 */
import { useSyncExternalStore, type Dispatch } from 'react';
import { NOW } from '../../data/mock';
import type { Block, DocBody, EventKind, WEvent, WS } from '../../data/ws-types';
import type { Action } from '../../state/store';
import { eventsOn, isoDay, uid } from '../../state/ws';
import { fmtDate } from '../../lib/format';

export const KINDS: { id: EventKind; label: string; plural: string; color: string }[] = [
  { id: 'meeting', label: 'Meeting', plural: 'Meetings', color: 'var(--c-sky)' },
  { id: 'focus', label: 'Focus', plural: 'Focus blocks', color: 'var(--accent)' },
  { id: 'review', label: 'Review', plural: 'Reviews', color: 'var(--c-amber)' },
  { id: 'personal', label: 'Personal', plural: 'Personal', color: 'var(--c-green)' },
];

export const kindMeta = (k: EventKind) => KINDS.find((x) => x.id === k)!;

/* ───────────── UI state shared across the shell ───────────── */

interface CalUi {
  /** Kinds hidden from the grid. */
  hidden: EventKind[];
  /** Show Saturday and Sunday in the week grid. */
  weekend: boolean;
  /** Event the context panel preps for. */
  selected?: string;
  /** Event whose details should open when the calendar shows. */
  open?: string;
}

let ui: CalUi = { hidden: [], weekend: false };
const subs = new Set<() => void>();

export const setCalUi = (change: Partial<CalUi>) => {
  ui = { ...ui, ...change };
  subs.forEach((f) => f());
};

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};

export const useCalUi = () => useSyncExternalStore(subscribe, () => ui);

/** Shows an event in the week grid and opens its details. */
export const showEvent = (dispatch: Dispatch<Action>, ev: WEvent) => {
  setCalUi({ selected: ev.id, open: ev.id, hidden: ui.hidden.filter((k) => k !== ev.kind) });
  dispatch({ type: 'navigate', route: { view: 'calendar', tab: 'week', date: isoDay(ev.start) } });
};

/* ───────────── Time ───────────── */

export const MIN = 60_000;

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

export const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes();

export const fmtClock = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** "1:00 – 2:30 PM", dropping the first AM/PM when both match. */
export const fmtRange = (a: Date, b: Date) => {
  const s = fmtClock(a);
  const e = fmtClock(b);
  const same = (a.getHours() < 12) === (b.getHours() < 12);
  return `${same ? s.replace(/\s?[AP]M$/, '') : s} – ${e}`;
};

export const fmtDuration = (min: number) => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
};

export const timeValue = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export const overlaps = (ws: WS, start: Date, end: Date, ignore?: string) =>
  eventsOn(ws, start).filter((e) => e.id !== ignore && e.start < end && e.end > start);

/* ───────────── Free slots ───────────── */

export interface Slot {
  start: Date;
  end: Date;
}

const roundUp = (d: Date, step: number) => {
  const ms = step * MIN;
  return new Date(Math.ceil(d.getTime() / ms) * ms);
};

/**
 * The next free slots of `minutes` length between 9:00 and 18:00, starting now.
 * At most `perDay` per day so tomorrow shows up too; weekends are skipped.
 */
export function freeSlots(ws: WS, minutes: number, count = 4, perDay = 3): Slot[] {
  const out: Slot[] = [];
  const today = startOfDay(NOW);
  for (let i = 0; i < 10 && out.length < count; i++) {
    const day = addDays(today, i);
    if (day.getDay() === 0 || day.getDay() === 6) continue;
    const events = eventsOn(ws, day);
    let t = new Date(day);
    t.setHours(9, 0, 0, 0);
    if (i === 0) {
      const now = roundUp(NOW, 15);
      if (now > t) t = now;
    }
    const close = new Date(day);
    close.setHours(18, 0, 0, 0);
    let found = 0;
    while (t.getTime() + minutes * MIN <= close.getTime() && found < perDay && out.length < count) {
      const end = new Date(t.getTime() + minutes * MIN);
      const clash = events.find((e) => e.start < end && e.end > t);
      if (clash) {
        t = new Date(Math.max(clash.end.getTime(), t.getTime() + 15 * MIN));
        continue;
      }
      out.push({ start: t, end });
      found++;
      t = end;
    }
  }
  return out;
}

/* ───────────── Running notes ───────────── */

type TableBlock = Extract<Block, { type: 'table' }>;

/** The agenda table of a 1:1-style doc, with the index of its Agenda column. */
export const agendaTable = (doc: DocBody | undefined) => {
  if (!doc) return null;
  const index = doc.blocks.findIndex((b) => b.type === 'table');
  const table = doc.blocks[index] as TableBlock | undefined;
  const col = table ? table.columns.findIndex((c) => /agenda/i.test(c)) : -1;
  return table && col >= 0 ? { index, table, col } : null;
};

const topicsHead = (dateLabel: string) => `Topics for ${dateLabel}`;

/**
 * Adds a discussion topic to a running notes doc. Docs with an Agenda column get
 * it appended to that date's row ("…; topic") or a new row; other docs get a
 * "Topics for <date>" list near the top.
 */
export function withTopic(doc: DocBody, dateLabel: string, topic: string): Block[] {
  const blocks = doc.blocks.slice();
  const agenda = agendaTable(doc);
  if (agenda) {
    const { index, table, col } = agenda;
    const ri = table.rows.findIndex((r) => r[0] === dateLabel);
    const rows =
      ri >= 0
        ? table.rows.map((r, i) => (i === ri ? r.map((c, j) => (j === col ? (c.trim() ? `${c}; ${topic}` : topic) : c)) : r))
        : [table.columns.map((_, j) => (j === 0 ? dateLabel : j === col ? topic : '')), ...table.rows];
    blocks[index] = { ...table, rows };
    return blocks;
  }
  const head = topicsHead(dateLabel);
  const hi = blocks.findIndex((b) => b.type === 'h2' && b.text === head);
  if (hi >= 0) {
    let at = hi + 1;
    while (blocks[at]?.type === 'bullet') at++;
    blocks.splice(at, 0, { id: uid('b'), type: 'bullet', text: topic });
    return blocks;
  }
  const at = blocks[0]?.type === 'p' ? 1 : 0;
  blocks.splice(at, 0, { id: uid('b'), type: 'h2', text: head }, { id: uid('b'), type: 'bullet', text: topic });
  return blocks;
}

/** Topics already on the doc for that date. */
export function topicsFor(doc: DocBody | undefined, dateLabel: string): string[] {
  if (!doc) return [];
  const agenda = agendaTable(doc);
  if (agenda) {
    const row = agenda.table.rows.find((r) => r[0] === dateLabel);
    return row?.[agenda.col] ? row[agenda.col]!.split(/;\s*/).filter(Boolean) : [];
  }
  const hi = doc.blocks.findIndex((b) => b.type === 'h2' && b.text === topicsHead(dateLabel));
  const out: string[] = [];
  for (let i = hi + 1; hi >= 0 && doc.blocks[i]?.type === 'bullet'; i++) out.push((doc.blocks[i] as { text: string }).text);
  return out;
}

/** Date label used for the doc row of an event, e.g. "Nov 16". */
export const rowLabel = (ev: WEvent) => fmtDate(ev.start);

/** The next 1:1 that keeps a running agenda doc (Priya's, in the seed data). */
export const nextOneOnOne = (ws: WS): { ev: WEvent; doc: DocBody } | null => {
  const candidates = Object.values(ws.events)
    .filter((e) => e.notesDoc && ws.docs[e.notesDoc]?.template === 'one-on-one' && e.end >= startOfDay(NOW))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const ev = candidates[0];
  return ev ? { ev, doc: ws.docs[ev.notesDoc!]! } : null;
};

/** The next meeting worth preparing for: it has files, notes, an email or a note. */
export const nextPrepEvent = (ws: WS) => {
  const upcoming = Object.values(ws.events)
    .filter((e) => e.end > NOW && e.kind !== 'personal' && (e.docs?.length || e.notesDoc || e.thread || e.note))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  return upcoming.find((e) => e.kind === 'meeting' && e.with.length > 0) ?? upcoming[0];
};
