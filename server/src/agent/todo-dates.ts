/**
 * A date for every to-do Timmy makes from an email, so none drifts without one.
 *   - The to-do's own date, when the email gives one for it.
 *   - Otherwise the date the email asks for in general (the thread's due date).
 *   - Otherwise a date Timmy suggests, marked as suggested so the screens say so: today for an urgent email (the next
 *     working day once today's working day is over, or on a weekend), two working days out for anything else.
 * Plain code on what Timmy already knows about the email, on the wall clock of the workspace's time zone. No model.
 */
import type { Thread } from '../../../src/data/types';
import type { Task } from '../../../src/data/ws-types';
import { zoned } from '../automations/when';
import { localTime } from '../lib/local-time';

/** Suggested to-dos are due at the end of the working day. */
const END_OF_DAY = 17 * 60;

/** The calendar day `n` working days (Monday to Friday) after `date`, both as YYYY-MM-DD. */
export function addWorkingDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d));
  for (let left = n; left > 0; ) {
    day.setUTCDate(day.getUTCDate() + 1);
    const wd = day.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return day.toISOString().slice(0, 10);
}

/** The day Timmy suggests for a to-do whose email names none. */
export function suggestedDay(urgent: boolean, timeZone: string, now = new Date()): string {
  const local = localTime(now, timeZone);
  const workday = local.weekday >= 1 && local.weekday <= 5;
  if (urgent && workday && local.minutes < END_OF_DAY) return local.date;
  return addWorkingDays(local.date, urgent ? 1 : 2);
}

/** Each to-do with a date: its own, the email's, or Timmy's suggestion (marked). */
export function withDates(todos: Task[], thread: Pick<Thread, 'due'>, urgent: boolean, timeZone: string, now = new Date()): Task[] {
  return todos.map((t) => {
    if (t.due) return t;
    if (thread.due && !Number.isNaN(new Date(thread.due).getTime())) return { ...t, due: new Date(thread.due) };
    return { ...t, due: zoned(suggestedDay(urgent, timeZone, now), END_OF_DAY, timeZone), dueSuggested: true };
  });
}
