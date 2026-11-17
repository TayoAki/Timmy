/**
 * Google Calendar, through Composio's `googlecalendar` toolkit. Timmy reads and
 * writes the account's primary calendar.
 *
 * What is particular to Google, and what is done about it here:
 *   - A repeating event is listed as its single times, each with an id of its own, so one time can be changed alone.
 *   - Who is told about a write is said on each call (`send_updates`): guests are told when the event has any,
 *     and nobody is written to when it has none.
 *   - A change sends only the fields that changed. The guest list is replaced whole when it changes, with the
 *     account's own entry kept on it.
 */
import { noteOf } from './calendar-note';
import type { Calendar, CalendarEvent } from './calendars';
import { htmlToText } from './message';
import { callTool } from './tools';

interface GoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string; self?: boolean; responseStatus?: string; optional?: boolean }[];
  organizer?: { email?: string; self?: boolean };
  recurringEventId?: string;
}

const MAX_PAGES = 20;
const payload = (data: Record<string, unknown>) => (data.response_data ?? data) as Record<string, unknown>;
/** An instant the way Google's tools take it: with its zone, to the second. */
const rfc3339 = (iso: string) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Google's event as the one shape Timmy stores. Null for an event that is cancelled or has no time. */
export function fromGoogle(e: GoogleEvent, account: string | null): CalendarEvent | null {
  const startsAt = e.start?.dateTime ?? e.start?.date;
  if (!e.id || e.status === 'cancelled' || !startsAt) return null;
  const start = new Date(startsAt);
  const end = new Date(e.end?.dateTime ?? e.end?.date ?? startsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const me = (account ?? '').toLowerCase();
  const attendees = (e.attendees ?? [])
    .filter((a) => a.email)
    .map((a) => {
      const email = a.email!.toLowerCase();
      return { email, ...(a.displayName ? { name: a.displayName } : {}), ...(a.responseStatus ? { response: a.responseStatus } : {}), ...(a.self || email === me ? { self: true } : {}), ...(a.optional ? { optional: true } : {}) };
    });
  const organizer = (e.organizer?.email ?? '').toLowerCase();
  // A description may carry markup. Timmy shows its words; written back from that copy, the markup would be lost.
  const marked = /<[a-z!/][^>]*>/i.test(e.description ?? '');
  return {
    id: e.id,
    title: (e.summary ?? '').trim().slice(0, 500) || '(no title)',
    start,
    end,
    allDay: !e.start?.dateTime,
    attendees,
    guests: [...new Set(attendees.filter((a) => !a.self).map((a) => a.email))],
    organizer,
    // Google marks the organizer as "self" on the organizer's own calendar.
    mine: e.organizer?.self === true || (!!me && organizer === me),
    ...(e.location ? { location: e.location } : {}),
    ...noteOf(marked ? htmlToText(e.description!) : e.description, !marked),
    recurring: !!e.recurringEventId,
  };
}

export const googleCalendar: Calendar = {
  name: 'Google Calendar',
  yours: 'your Google Calendar',
  prefix: 'gcal-',
  key: (eventId) => eventId,
  // A Google Calendar connection announces nothing but calendar changes.
  announces: () => true,

  async list(workspaceId, conn, from, to, phase) {
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const res = await callTool(workspaceId, conn.id, 'GOOGLECALENDAR_EVENTS_LIST', { calendarId: 'primary', timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 250, ...(pageToken ? { pageToken } : {}) }, phase);
      if (!res.successful) throw new Error(res.error ?? 'the calendar could not be listed');
      for (const raw of (res.data.items ?? []) as GoogleEvent[]) {
        const event = fromGoogle(raw, conn.account_label);
        if (event) events.push(event);
      }
      pageToken = (res.data.nextPageToken as string | null | undefined) || undefined;
      pages++;
    } while (pageToken && pages < MAX_PAGES);
    return { events, pages, complete: !pageToken };
  },

  async get(workspaceId, conn, eventId, phase) {
    const res = await callTool(workspaceId, conn.id, 'GOOGLECALENDAR_EVENTS_GET', { calendar_id: 'primary', event_id: eventId }, phase);
    if (!res.successful) throw new Error(res.error ?? 'the event could not be read');
    // Google keeps a deleted event for a while and shows it as cancelled.
    return fromGoogle(payload(res.data) as GoogleEvent, conn.account_label);
  },

  async gone(workspaceId, conn, eventId, phase) {
    const res = await callTool(workspaceId, conn.id, 'GOOGLECALENDAR_EVENTS_GET', { calendar_id: 'primary', event_id: eventId }, phase);
    // Google keeps a deleted event for a while and shows it as cancelled; after that it answers 404 or 410.
    if (res.successful) return (payload(res.data) as GoogleEvent).status === 'cancelled';
    // Only Google's own words for a missing event count; any other refusal (no connection, a busy server) proves nothing.
    return /\b(404|410)\b|^\s*Not Found\s*$|has been deleted/i.test(res.error ?? '') ? true : null;
  },

  async create(e, conn, p) {
    const start = new Date(p.start);
    const minutes = Math.round((new Date(p.end).getTime() - start.getTime()) / 60_000);
    if (!(minutes > 0) || minutes > 24 * 60) return { status: 'failed', error: 'The event’s length isn’t one Google Calendar accepts.' };
    const res = await callTool(
      e.workspace_id,
      conn.id,
      'GOOGLECALENDAR_CREATE_EVENT',
      {
        calendar_id: 'primary',
        summary: p.title,
        // The tool takes a wall-clock time and a zone; the instant is given as UTC so no zone arithmetic happens here.
        start_datetime: start.toISOString().slice(0, 19),
        timezone: 'UTC',
        event_duration_hour: Math.floor(minutes / 60),
        event_duration_minutes: minutes % 60,
        attendees: p.attendees,
        ...(p.note ? { description: p.note } : {}),
        // With guests the event was approved like an email, and Google sends them invitations. With none, nobody is written to.
        send_updates: p.attendees.length > 0 ? 'all' : 'none',
        create_meeting_room: false,
      },
      'send',
    );
    if (!res.successful) return { status: 'failed', error: res.error ?? 'Google Calendar refused the event.' };
    const made = payload(res.data) as { id?: string };
    return { status: 'completed', result: { via: 'googlecalendar', id: made.id }, externalId: made.id };
  },

  async update(e, conn, p, current) {
    const args: Record<string, unknown> = { calendar_id: 'primary', event_id: p.externalId };
    if (p.changed.includes('title')) args.summary = p.after.title;
    if (p.changed.includes('time')) {
      args.start_time = rfc3339(p.after.start);
      args.end_time = rfc3339(p.after.end);
    }
    if (p.changed.includes('note')) args.description = p.after.note ?? '';
    // Google replaces the whole guest list. The account's own entry stays on it.
    if (p.changed.includes('guests')) args.attendees = [...new Set([...current.attendees.filter((a) => a.self).map((a) => a.email), ...p.after.attendees])];
    // Everyone on the event, before or after, was shown to whoever approved this, and is told. With nobody on it, nobody is written to.
    args.send_updates = current.guests.length > 0 || p.after.attendees.length > 0 ? 'all' : 'none';
    const res = await callTool(e.workspace_id, conn.id, 'GOOGLECALENDAR_PATCH_EVENT', args, 'send');
    if (!res.successful) return { status: 'failed', error: res.error ?? 'Google Calendar refused the change.' };
    return { status: 'completed', result: { via: 'googlecalendar', id: p.externalId }, externalId: p.externalId };
  },

  async remove(e, conn, p, current) {
    const res = await callTool(e.workspace_id, conn.id, 'GOOGLECALENDAR_DELETE_EVENT', { calendar_id: 'primary', event_id: p.externalId, send_updates: current.guests.length > 0 ? 'all' : 'none' }, 'send');
    if (!res.successful) return { status: 'failed', error: res.error ?? 'Google Calendar refused to delete the event.' };
    return { status: 'completed', result: { via: 'googlecalendar', id: p.externalId }, externalId: p.externalId };
  },
};
