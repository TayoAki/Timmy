/**
 * One interface over the calendar providers, the way mailbox.ts is one over the
 * mail providers. Google Calendar and Outlook each list a span of time, show one
 * event, and take the same three writes, so sync and the writes are written once
 * and never ask which provider they are talking to.
 *
 * Every call goes through Composio on the workspace's own connection. A write
 * here is only ever reached from the Action gateway's executors.
 */
import type { EffectRow, Outcome } from '../gateway/gateway';
import type { EventChange, EventRemoval } from './calendar-change';
import type { EventPayload } from './calendar-write';
import { googleCalendar } from './google-calendar';
import { outlookCalendar } from './outlook-calendar';
import type { ConnectionRow, Phase } from './tools';

export interface Attendee {
  email: string;
  name?: string;
  /** The provider's word for their answer (accepted, declined and so on). */
  response?: string;
  /** The connected account itself. */
  self?: boolean;
  optional?: boolean;
}

/** An event as the calendar holds it, in the one shape Timmy stores. */
export interface CalendarEvent {
  /** The provider's own id for the event. */
  id: string;
  title: string;
  start: Date;
  end: Date;
  /** An all-day entry has no clock time. It is stored, but not placed on Timmy's calendar. */
  allDay: boolean;
  /** Everyone on the event, the connected account included, as the provider lists them. */
  attendees: Attendee[];
  /** The other people on it: everyone but the connected account. They are who the provider tells about a change. */
  guests: string[];
  /** The organizer's address, when the provider gives one. */
  organizer: string;
  /** Whether the connected account organizes the event. Only then may Timmy change or delete it. */
  mine: boolean;
  location?: string;
  /** The description, as plain text. */
  note?: string;
  /** False when the calendar holds more than `note` shows (longer, or with formatting), so writing the note back would lose some of it. */
  noteWhole: boolean;
  /** One time of a repeating event. */
  recurring: boolean;
}

export interface Calendar {
  /** What people call it, for the words on screen. */
  name: 'Google Calendar' | 'Outlook';
  /** The same, as the person's own: "your Google Calendar". */
  yours: string;
  /** What starts the id of each of its events on Timmy's calendar. Events made in Timmy have other ids until the calendar has them. */
  prefix: string;
  /** The part of an event's id on Timmy's calendar that stands for the provider's own id. */
  key(eventId: string): string;
  /** Whether an event the provider announces is news about the calendar. An Outlook account also announces mail. */
  announces(triggerSlug: string): boolean;
  /**
   * Every event that overlaps a span of time, repeating ones as their single times, cancelled ones left out.
   * `complete` is false when the calendar held more than was read. Throws when the provider can't be asked.
   */
  list(workspaceId: string, conn: ConnectionRow, from: Date, to: Date, phase: Phase): Promise<{ events: CalendarEvent[]; pages: number; complete: boolean }>;
  /** One event as the calendar holds it now, or null when it has been cancelled. Throws when the provider won't show it. */
  get(workspaceId: string, conn: ConnectionRow, eventId: string, phase: Phase): Promise<CalendarEvent | null>;
  /** Makes an approved event exactly as approved. Throwing means the outcome is unknown. */
  create(e: EffectRow, conn: ConnectionRow, p: EventPayload): Promise<Outcome>;
  /** Writes the approved fields of an event. `current` is the event as the calendar holds it right now. */
  update(e: EffectRow, conn: ConnectionRow, p: EventChange, current: CalendarEvent): Promise<Outcome>;
  /** Takes an event off the calendar. With guests on it, the provider tells them it is cancelled. */
  remove(e: EffectRow, conn: ConnectionRow, p: EventRemoval, current: CalendarEvent): Promise<Outcome>;
}

const CALENDARS: Record<string, Calendar> = { googlecalendar: googleCalendar, outlook: outlookCalendar };

/** The calendar behind a connection's toolkit, or undefined for a toolkit that has none. */
export const calendarFor = (toolkit: string): Calendar | undefined => (Object.hasOwn(CALENDARS, toolkit) ? CALENDARS[toolkit] : undefined);
export const CALENDAR_TOOLKITS = Object.keys(CALENDARS);

/** The id an event has on Timmy's calendar: which provider it came from, which connection, and which event. */
export const shownId = (cal: Calendar, connectionId: string, eventId: string) => `${cal.prefix}${connectionId.slice(-6)}-${cal.key(eventId)}`;

/** Whether an id on Timmy's calendar belongs to an event a calendar sync put there. */
export const isSynced = (id: string) => Object.values(CALENDARS).some((cal) => id.startsWith(cal.prefix));

/** The end of the connection's id that an id on Timmy's calendar carries, or null for an id no calendar sync gave out. */
export const connectionMark = (shown: string): string | null => {
  const cal = Object.values(CALENDARS).find((c) => shown.startsWith(c.prefix));
  return cal ? shown.slice(cal.prefix.length, cal.prefix.length + 6) : null;
};

/** What starts the id of every event a connection put on Timmy's calendar, whichever provider it is. */
export const shownPrefixes = (connectionId: string) => Object.values(CALENDARS).map((cal) => `${cal.prefix}${connectionId.slice(-6)}-`);

const DAY = 86400_000;
/** The span of the calendar Timmy keeps: two weeks back, two months ahead. */
export const syncWindow = (now = Date.now()) => ({ from: new Date(now - 14 * DAY), to: new Date(now + 60 * DAY) });
