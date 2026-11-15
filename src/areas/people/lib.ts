/*
 * Selectors for the personal CRM: who you track, who is due a check-in and
 * where each relationship's next step came from.
 */
import { NOW } from '../../data/mock';
import type { Thread } from '../../data/types';
import type { Cadence, Contact, Interaction, InteractionKind, WEvent, WFile, WS } from '../../data/ws-types';
import { fmtDate } from '../../lib/format';

const DAY = 24 * 60 * 60 * 1000;

export const CADENCE_DAYS: Record<Cadence, number> = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 90 };
export const CADENCES: Cadence[] = ['weekly', 'biweekly', 'monthly', 'quarterly'];
export const cadenceLabel = (c?: Cadence) => (c ? c.charAt(0).toUpperCase() + c.slice(1) : 'Not set');

/** Start with 10–20 people; the list aims for the top of that range. */
export const TRACK_TARGET = 20;
/** One or two priority contacts for the current goal. */
export const PRIORITY_LIMIT = 2;

export const people = (ws: WS) => Object.values(ws.contacts).filter((c) => !c.bot && c.id !== 'me');

const byName = (a: Contact, b: Contact) => a.name.localeCompare(b.name);

export const tracked = (ws: WS) =>
  people(ws)
    .filter((c) => c.tracked)
    .sort((a, b) => Number(!!b.priority) - Number(!!a.priority) || byName(a, b));

export const priorityContacts = (ws: WS) => tracked(ws).filter((c) => c.priority);

export const interactionsOf = (ws: WS, id: string) =>
  Object.values(ws.interactions)
    .filter((i) => i.contact === id)
    .sort((a, b) => b.at.getTime() - a.at.getTime());

/** Everything but reminders counts: a reminder is a plan, not contact. */
const TOUCH: InteractionKind[] = ['email', 'meeting', 'call', 'file', 'note'];

/**
 * The last time you were in touch: the stored date, the latest logged
 * interaction, or the latest email with them on a thread.
 */
export const lastTouch = (ws: WS, c: Contact, threads: Thread[] = []): Date | undefined => {
  const now = NOW.getTime();
  const times = Object.values(ws.interactions)
    .filter((i) => i.contact === c.id && TOUCH.includes(i.kind) && i.at.getTime() <= now)
    .map((i) => i.at.getTime());
  for (const t of threads) {
    if (!t.participants.includes(c.id)) continue;
    for (const m of t.messages) if (m.at.getTime() <= now && (m.from === c.id || m.to.includes(c.id) || m.cc?.includes(c.id))) times.push(m.at.getTime());
  }
  if (c.last) times.push(c.last.getTime());
  return times.length ? new Date(Math.max(...times)) : undefined;
};

/** When the next check-in is due, from the cadence. */
export const nextReview = (ws: WS, c: Contact, threads: Thread[] = []): Date | undefined => {
  const last = lastTouch(ws, c, threads);
  if (!last) return undefined;
  return new Date(last.getTime() + CADENCE_DAYS[c.cadence ?? 'monthly'] * DAY);
};

/** Tracked and not in touch for longer than the cadence allows. */
export const isDueForReview = (ws: WS, c: Contact, threads: Thread[] = []) => {
  if (!c.tracked || c.bot) return false;
  const last = lastTouch(ws, c, threads);
  if (!last) return true;
  return (NOW.getTime() - last.getTime()) / DAY > CADENCE_DAYS[c.cadence ?? 'monthly'];
};

export const dueForReview = (ws: WS, threads: Thread[] = []) =>
  tracked(ws)
    .filter((c) => isDueForReview(ws, c, threads))
    .sort((a, b) => (lastTouch(ws, a, threads)?.getTime() ?? 0) - (lastTouch(ws, b, threads)?.getTime() ?? 0));

/** People you email but don't track yet, most emailed first. */
export const suggestions = (ws: WS) =>
  people(ws)
    .filter((c) => !c.tracked)
    .sort((a, b) => (b.emails ?? 0) - (a.emails ?? 0) || byName(a, b));

/** "Today", "Yesterday", "5 days ago", "3 weeks ago", "Aug 14". */
export const fmtAgo = (d?: Date) => {
  if (!d) return 'Not logged';
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(NOW) - start(d)) / DAY);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const w = Math.round(days / 7);
    return w === 1 ? '1 week ago' : `${w} weeks ago`;
  }
  if (days < 365) {
    const m = Math.round(days / 30);
    return m <= 1 ? '1 month ago' : `${m} months ago`;
  }
  return fmtDate(d);
};

export const ownerName = (owner: string | undefined, c: Contact) =>
  !owner || owner === 'me' ? 'You' : owner === c.id ? c.name.split(' ')[0]! : owner;

/* ───────────── Linked records ───────────── */

/** Threads with this person that still need something. */
export const openThreadsWith = (threads: Thread[], id: string) =>
  threads.filter((t) => t.participants.includes(id) && t.box !== 'archived');

export const upcomingWith = (ws: WS, id: string): WEvent[] =>
  Object.values(ws.events)
    .filter((e) => e.with.includes(id) && e.end.getTime() >= NOW.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());

/** Files they own or shared with you, plus files linked from their history. */
export const filesFrom = (ws: WS, id: string): WFile[] => {
  const ids = new Set<string>();
  for (const f of Object.values(ws.files)) if ((f.owner === id || f.sharedBy === id) && !f.filing) ids.add(f.id);
  for (const i of interactionsOf(ws, id)) if (i.kind === 'file' && i.file) ids.add(i.file);
  return [...ids]
    .map((x) => ws.files[x])
    .filter((f): f is WFile => !!f)
    .sort((a, b) => b.updated.getTime() - a.updated.getTime());
};

/**
 * Where the current next step came from: the latest email thread with them
 * and the latest meeting or call note.
 */
export const sourcesFor = (ws: WS, threads: Thread[], c: Contact): { thread?: Thread; note?: WFile; noteFrom?: Interaction | WEvent } => {
  const history = interactionsOf(ws, c.id);
  const emailed = history.find((i) => i.kind === 'email' && i.thread && threads.some((t) => t.id === i.thread));
  const thread =
    (emailed && threads.find((t) => t.id === emailed.thread)) ??
    [...threads]
      .filter((t) => t.participants.includes(c.id))
      .sort((a, b) => b.messages[b.messages.length - 1]!.at.getTime() - a.messages[a.messages.length - 1]!.at.getTime())[0];
  const noted = history.find((i) => (i.kind === 'meeting' || i.kind === 'call' || i.kind === 'note') && i.file && ws.files[i.file]);
  if (noted) return { thread, note: ws.files[noted.file!], noteFrom: noted };
  const ev = Object.values(ws.events)
    .filter((e) => e.with.includes(c.id) && e.notesDoc && ws.files[e.notesDoc])
    .sort((a, b) => b.start.getTime() - a.start.getTime())[0];
  return { thread, note: ev ? ws.files[ev.notesDoc!] : undefined, noteFrom: ev };
};
