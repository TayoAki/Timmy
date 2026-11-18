import { NOW } from '../data/mock';

const DAY = 24 * 60 * 60 * 1000;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Whole calendar days from NOW's date to `d`'s date (negative = past). */
export const dayDiff = (d: Date) => Math.round((startOfDay(d).getTime() - startOfDay(NOW).getTime()) / DAY);

export const fmtTime = (d: Date) =>
  d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export const fmtShortTime = (d: Date) => {
  const h = d.getHours() % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export const fmtDay = (d: Date) =>
  d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

export const fmtDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** When something arrived, short: "3:12 PM" today, "Yesterday 3:12 PM", then "Nov 3", and "Nov 3, 2025" in another year. */
export const fmtShortWhen = (d: Date) => {
  const diff = dayDiff(d);
  if (diff === 0) return fmtTime(d);
  if (diff === -1) return `Yesterday ${fmtTime(d)}`;
  return d.getFullYear() === NOW.getFullYear() ? fmtDate(d) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export const fmtLongDate = (d: Date) =>
  d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

/** Inbox-style timestamp: time today, "Yesterday", weekday this week, else date. */
export const fmtListDate = (d: Date) => {
  const diff = dayDiff(d);
  if (diff === 0) return fmtTime(d);
  if (diff === -1) return 'Yesterday';
  if (diff > -6 && diff < 0) return d.toLocaleDateString('en-US', { weekday: 'short' });
  return fmtDate(d);
};

export const fmtStamp = (d: Date) => {
  const diff = dayDiff(d);
  if (diff === 0) return `Today, ${fmtTime(d)}`;
  if (diff === -1) return `Yesterday, ${fmtTime(d)}`;
  return `${fmtDay(d)}, ${fmtTime(d)}`;
};

export type Tone = 'overdue' | 'today' | 'soon' | 'later';

export const dueInfo = (due: Date): { label: string; tone: Tone } => {
  const diff = dayDiff(due);
  if (due.getTime() < NOW.getTime() && diff < 0) {
    return { label: `Overdue ${-diff}d`, tone: 'overdue' };
  }
  if (diff === 0) return { label: `Today ${fmtTime(due)}`, tone: 'today' };
  if (diff === 1) return { label: 'Tomorrow', tone: 'soon' };
  if (diff < 7) return { label: due.toLocaleDateString('en-US', { weekday: 'short' }), tone: 'soon' };
  return { label: fmtDate(due), tone: 'later' };
};

export const daysSince = (d: Date) => -dayDiff(d);

export const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
