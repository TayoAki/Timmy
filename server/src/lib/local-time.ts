/** Wall-clock time in a workspace's own time zone. */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The calendar date, minutes past midnight and weekday on the wall clock of a time zone. */
export function localTime(at: Date, timeZone: string): { date: string; minutes: number; weekday: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(at);
  } catch {
    // A time zone the runtime doesn't know is treated as UTC rather than stopping every workspace's run.
    return localTime(at, 'UTC');
  }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: WEEKDAYS.indexOf(p.weekday ?? '') };
}

export const isTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
