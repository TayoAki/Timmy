/*
 * When Timmy's morning run happens. The run sorts new mail, ranks what's
 * urgent, drafts replies and prepares decisions, so the brief is ready when
 * you sit down. Nothing it prepares is sent without your approval.
 */
import { NOW } from '../data/mock';
import { dayDiff, fmtTime } from '../lib/format';

export interface Schedule {
  /** 24-hour "HH:MM". */
  time: string;
  /** Days the run happens: 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** What the brief leads with: only urgent mail, or everything open. */
  brief: 'urgent' | 'all';
}

export const DEFAULT_SCHEDULE: Schedule = { time: '08:00', days: [1, 2, 3, 4, 5], brief: 'urgent' };

/** This morning's run in the sample data. */
export const LAST_RUN = new Date(2026, 10, 16, 8, 2);
/** Emails that run sorted. */
export const LAST_RUN_COUNT = 33;

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Monday first, the way the week reads at work. */
export const WEEK = [1, 2, 3, 4, 5, 6, 0];

export const hm = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return { h: h ?? 0, m: m ?? 0 };
};

/** "08:30" → "8:30 AM". */
export const fmtClock = (time: string) => {
  const { h, m } = hm(time);
  return fmtTime(new Date(2000, 0, 1, h, m));
};

/** The next run after `from`, or null when no days are selected. */
export const nextRun = (s: Schedule, from = NOW): Date | null => {
  const { h, m } = hm(s.time);
  for (let i = 0; i <= 7; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, h, m);
    if (d > from && s.days.includes(d.getDay())) return d;
  }
  return null;
};

/** "today at 9:00 AM", "tomorrow at 8:00 AM", "Monday at 8:00 AM". */
export const whenLabel = (d: Date) => {
  const diff = dayDiff(d);
  const day = diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : DAY_NAMES[d.getDay()]!;
  return `${day} at ${fmtTime(d)}`;
};

export const daysLabel = (days: number[]) => {
  const set = new Set(days);
  if (set.size === 0) return 'Paused';
  if (set.size === 7) return 'Every day';
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return 'Weekdays';
  if (set.size === 2 && set.has(0) && set.has(6)) return 'Weekends';
  return WEEK.filter((d) => set.has(d))
    .map((d) => DAY_NAMES[d]!.slice(0, 3))
    .join(', ');
};

/** The sentence shown for the schedule rule in Settings. */
export const scheduleRule = (s: Schedule) =>
  s.days.length === 0
    ? 'The morning brief is paused.'
    : `Run the morning brief ${daysLabel(s.days) === 'Every day' ? 'every day' : `on ${daysLabel(s.days).toLowerCase().replace(/\b(mon|tue|wed|thu|fri|sat|sun)\b/g, (x) => x[0]!.toUpperCase() + x.slice(1))}`} at ${fmtClock(s.time)}.`;
