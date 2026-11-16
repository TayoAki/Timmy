/*
 * Dates in plain words, relative to the app's "now": "tomorrow", "by Thursday",
 * "next week". Shared by Ask Timmy and the drafts Timmy writes.
 */
import { NOW } from '../data/mock';

/** That day at 5 PM (or the hour given). */
export const atHour = (d: Date, h = 17, m = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** "tomorrow", "friday", "by wed", "today", "next week" → a due date at 5 PM. */
export function parseDue(text: string): Date | undefined {
  const t = text.toLowerCase();
  if (/\btoday\b|\btonight\b|end of (the )?day/.test(t)) return atHour(NOW);
  if (/\btomorrow\b/.test(t)) return atHour(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 1));
  if (/\bnext week\b/.test(t)) {
    const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + ((8 - NOW.getDay()) % 7 || 7));
    return atHour(d);
  }
  const m = t.match(/\b(sun|mon|tues?|wed|thu|thurs|fri|sat)(day|nesday|rsday|urday)?\b/);
  if (m) {
    const target = WEEKDAYS.findIndex((w) => w.startsWith(m[1]!.slice(0, 3)));
    const ahead = (target - NOW.getDay() + 7) % 7 || 7;
    return atHour(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + ahead));
  }
  return undefined;
}

/** `n` working days from now, at 5 PM. */
export function workdaysAhead(n: number): Date {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
  let left = n;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) left--;
  }
  return atHour(d);
}

/** "Wednesday", or "tomorrow" / "today" when that's clearer. */
export function weekdayWord(d: Date): string {
  const days = Math.round((atHour(d, 0).getTime() - atHour(NOW, 0).getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  const name = d.toLocaleDateString('en-US', { weekday: 'long' });
  return days > 6 ? `${name}, ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : name;
}

/** "Wed" */
export const weekdayShort = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short' });
