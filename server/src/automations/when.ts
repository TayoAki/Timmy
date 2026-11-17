/**
 * The times an automation works with, all on the wall clock of the workspace's own time zone:
 * when a schedule is next due, how long a Wait lasts, when a send may be put forward, when a task is due.
 * The choices are the fixed ones the canvas offers; a choice this file doesn't know gives null.
 */
import { localTime } from '../agent/morning';

const MINUTE = 60_000;
const DAY = 86400_000;

const parts = (date: string) => date.split('-').map(Number) as [number, number, number];
const addDays = (date: string, days: number) => {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const weekdayOf = (date: string) => {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/** The moment a wall-clock time happens in a time zone: zoned('2026-11-16', 8 * 60, 'America/New_York') is 13:00 UTC. */
export function zoned(date: string, minutes: number, timeZone: string): Date {
  const [y, m, d] = parts(date);
  const want = Date.UTC(y, m - 1, d, 0, minutes);
  let guess = want;
  // The zone's offset is found by asking what the clock there shows at the guess, and correcting.
  // Twice is enough, including across a daylight-saving change.
  for (let i = 0; i < 3; i++) {
    const shown = localTime(new Date(guess), timeZone);
    const [sy, sm, sd] = parts(shown.date);
    const diff = want - Date.UTC(sy, sm - 1, sd, 0, shown.minutes);
    if (!diff) break;
    guess += diff;
  }
  return new Date(guess);
}

/* ───────────── On a schedule ───────────── */

const SCHEDULES: Record<string, { minutes: number; on: (weekday: number, dayOfMonth: number) => boolean }> = {
  'Weekdays at 8:00 AM': { minutes: 8 * 60, on: (wd) => wd >= 1 && wd <= 5 },
  'Mondays at 9:00 AM': { minutes: 9 * 60, on: (wd) => wd === 1 },
  'Fridays at 4:00 PM': { minutes: 16 * 60, on: (wd) => wd === 5 },
  // The canvas names no time for this one; it runs with the working day, like the weekday choice.
  'The 1st of each month': { minutes: 8 * 60, on: (_wd, day) => day === 1 },
};

/** The first time after `after` that a schedule is due, or null for a schedule this file doesn't know. */
export function nextFire(every: string | undefined, timeZone: string, after: Date): Date | null {
  const rule = every ? SCHEDULES[every] : undefined;
  if (!rule) return null;
  const start = localTime(after, timeZone).date;
  for (let i = 0; i <= 62; i++) {
    const date = addDays(start, i);
    if (!rule.on(weekdayOf(date), parts(date)[2])) continue;
    const at = zoned(date, rule.minutes, timeZone);
    if (at.getTime() > after.getTime()) return at;
  }
  return null;
}

/* ───────────── Business hours ───────────── */

const OPEN = 9 * 60;
const CLOSE = 17 * 60;

/** `from` itself when it falls on a weekday between 9 and 5 there; otherwise the next weekday at 9:00. */
export function businessHours(timeZone: string, from: Date): Date {
  const now = localTime(from, timeZone);
  const working = (date: string) => weekdayOf(date) >= 1 && weekdayOf(date) <= 5;
  if (working(now.date) && now.minutes >= OPEN && now.minutes < CLOSE) return from;
  for (let i = now.minutes < OPEN ? 0 : 1; i <= 8; i++) {
    const date = addDays(now.date, i);
    if (working(date)) return zoned(date, OPEN, timeZone);
  }
  return from;
}

/* ───────────── Wait ───────────── */

const WAITS: Record<string, number> = { '5 minutes': 5 * MINUTE, '1 hour': 60 * MINUTE, '1 day': DAY, '3 days': 3 * DAY };

/** When a Wait step ends. */
export function waitUntil(choice: string | undefined, timeZone: string, from: Date): Date | null {
  if (choice === 'Until business hours') return businessHours(timeZone, from);
  const ms = choice ? WAITS[choice] : undefined;
  return ms ? new Date(from.getTime() + ms) : null;
}

/* ───────────── Send the email ───────────── */

/** The earliest a Send step puts its email forward for approval. `from` itself means right away. */
export function sendFrom(choice: string | undefined, timeZone: string, from: Date): Date | null {
  if (choice === 'Right away') return from;
  if (choice === 'Within business hours') return businessHours(timeZone, from);
  if (choice === 'Tomorrow at 9:00 AM') return zoned(addDays(localTime(from, timeZone).date, 1), OPEN, timeZone);
  return null;
}

/* ───────────── Create a task ───────────── */

const DUE_IN: Record<string, number> = { Today: 0, Tomorrow: 1, 'In 3 days': 3, 'Next week': 7 };

/** When a new task is due: the end of the working day, that many days on. */
export function dueDate(choice: string | undefined, timeZone: string, from: Date): Date | null {
  const days = choice ? DUE_IN[choice] : undefined;
  return days === undefined ? null : zoned(addDays(localTime(from, timeZone).date, days), CLOSE, timeZone);
}

/** A date as the schedule trigger's {{date}}: "Mon, Nov 16". */
export function dayLabel(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(at);
  }
}

/** A moment as people read it in the workspace: "Nov 16 at 10:42 AM". */
export function stampLabel(at: Date, timeZone: string): string {
  const format = (tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at).replace(', ', ' at ');
  try {
    return format(timeZone);
  } catch {
    return format('UTC');
  }
}
