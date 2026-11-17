/**
 * Outlook's calendar (Microsoft 365 and Outlook.com), through Composio's `outlook` toolkit.
 * It is the same connection as Outlook mail: one account, read for both.
 *
 * How Outlook differs from Google Calendar, and what is done about it here:
 *   - A span of time is read as a "calendar view", which lists a repeating event as its single times.
 *   - Times come as a wall-clock time and a zone. Timmy asks for UTC and sends UTC, so no zone arithmetic happens here.
 *   - Its ids are long and carry characters Timmy's own ids don't, so an event's id on Timmy's calendar is made from
 *     a fingerprint of the Outlook id.
 *   - Outlook decides for itself who is told: creating or changing an event with attendees sends them an invitation
 *     or an update. A meeting is taken off the calendar by cancelling it, which is what tells its attendees; an
 *     event with nobody on it is simply deleted.
 *   - Only a short preview of an event's body is read. A body longer than the preview can't be rewritten from it.
 */
import { createHash } from 'node:crypto';
import { noteOf } from './calendar-note';
import type { Calendar, CalendarEvent } from './calendars';
import { callTool } from './tools';

interface GraphPerson {
  emailAddress?: { name?: string; address?: string };
}
interface GraphEvent {
  id?: string;
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
  isOrganizer?: boolean;
  organizer?: GraphPerson;
  attendees?: (GraphPerson & { type?: string; status?: { response?: string } })[];
  location?: { displayName?: string };
  bodyPreview?: string;
  type?: string;
  seriesMasterId?: string | null;
}

/** What Timmy needs of each event. Outlook returns only what is asked for, and `isOrganizer` is not among its defaults. */
const SELECT = ['id', 'subject', 'start', 'end', 'isAllDay', 'isCancelled', 'isOrganizer', 'organizer', 'attendees', 'location', 'bodyPreview', 'type', 'seriesMasterId'];
const MAX_PAGES = 20;
/** Outlook's preview of a body is its first 255 characters. */
const PREVIEW_MAX = 255;
const payload = (data: Record<string, unknown>) => (data.response_data ?? data) as Record<string, unknown>;
const addressOf = (p?: GraphPerson) => (p?.emailAddress?.address ?? '').trim().toLowerCase();
/** An instant with its zone, to the second: the form the calendar view's examples use for the span to read. */
const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
/** An instant as the wall-clock time Outlook's tools take, to be read in UTC. */
const wallClock = (iso: string) => new Date(iso).toISOString().slice(0, 19);

/** The instant behind one of Outlook's times. A time given in a zone Timmy did not ask for is not guessed at. */
function instant(t?: { dateTime?: string; timeZone?: string }): Date | null {
  if (!t?.dateTime) return null;
  const zoned = /(z|[+-]\d{2}:?\d{2})$/i.test(t.dateTime);
  if (!zoned && !/^(utc|etc\/utc|tzone:\/\/microsoft\/utc)$/i.test(t.timeZone ?? 'UTC')) return null;
  // Outlook writes seven digits of a second; a date is read to the millisecond.
  const at = new Date(zoned ? t.dateTime : `${t.dateTime.replace(/(\.\d{3})\d+$/, '$1')}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Outlook's event as the one shape Timmy stores. Null for an event that is cancelled or whose time can't be read. */
export function fromOutlookEvent(e: GraphEvent, account: string | null): CalendarEvent | null {
  const start = instant(e.start);
  const end = instant(e.end);
  if (!e.id || e.isCancelled || !start || !end) return null;
  const me = (account ?? '').toLowerCase();
  const mine = e.isOrganizer === true;
  const attendees = (e.attendees ?? [])
    .map((a) => {
      const email = addressOf(a);
      return { email, ...(a.emailAddress?.name ? { name: a.emailAddress.name } : {}), ...(a.status?.response ? { response: a.status.response } : {}), ...(email === me ? { self: true } : {}), ...(a.type === 'optional' ? { optional: true } : {}) };
    })
    .filter((a) => a.email);
  const organizer = addressOf(e.organizer);
  // Outlook lists the people who were invited. On someone else's meeting the organizer is named apart from them.
  if (!mine && organizer && organizer !== me && !attendees.some((a) => a.email === organizer)) attendees.unshift({ email: organizer, ...(e.organizer?.emailAddress?.name ? { name: e.organizer.emailAddress.name } : {}) });
  const preview = e.bodyPreview ?? '';
  return {
    id: e.id,
    title: (e.subject ?? '').trim().slice(0, 500) || '(no title)',
    start,
    end,
    allDay: e.isAllDay === true,
    attendees,
    guests: [...new Set(attendees.filter((a) => !a.self).map((a) => a.email))],
    organizer,
    mine,
    ...(e.location?.displayName ? { location: e.location.displayName } : {}),
    ...noteOf(preview, preview.length < PREVIEW_MAX),
    recurring: e.type === 'occurrence' || e.type === 'exception' || !!e.seriesMasterId,
  };
}

export const outlookCalendar: Calendar = {
  name: 'Outlook',
  yours: 'your Outlook calendar',
  prefix: 'ocal-',
  key: (eventId) => createHash('sha256').update(eventId).digest('hex').slice(0, 24),
  // The same account announces new mail; only this event is about the calendar.
  announces: (triggerSlug) => triggerSlug === 'OUTLOOK_EVENT_CHANGE_TRIGGER',

  async list(workspaceId, conn, from, to, phase) {
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const res = await callTool(workspaceId, conn.id, 'OUTLOOK_GET_CALENDAR_VIEW', { start_datetime: stamp(from), end_datetime: stamp(to), timezone: 'UTC', select: SELECT, orderby: 'start/dateTime asc', top: 100, ...(pageToken ? { page_token: pageToken } : {}) }, phase);
      if (!res.successful) throw new Error(res.error ?? 'the calendar could not be listed');
      const data = payload(res.data);
      for (const raw of (data.value ?? []) as GraphEvent[]) {
        const event = fromOutlookEvent(raw, conn.account_label);
        if (event) events.push(event);
      }
      pageToken = (data.next_page_token as string | null | undefined) || undefined;
      pages++;
    } while (pageToken && pages < MAX_PAGES);
    return { events, pages, complete: !pageToken };
  },

  async get(workspaceId, conn, eventId, phase) {
    const res = await callTool(workspaceId, conn.id, 'OUTLOOK_GET_EVENT', { event_id: eventId }, phase);
    if (!res.successful) throw new Error(res.error ?? 'the event could not be read');
    const raw = payload(res.data) as GraphEvent;
    if (raw.isCancelled) return null;
    const event = fromOutlookEvent(raw, conn.account_label);
    if (!event) throw new Error('Outlook did not give the event in a form Timmy can read');
    return event;
  },

  async create(e, conn, p) {
    if (!(new Date(p.end) > new Date(p.start))) return { status: 'failed', error: 'The event’s length isn’t one Outlook accepts.' };
    const res = await callTool(
      e.workspace_id,
      conn.id,
      'OUTLOOK_CALENDAR_CREATE_EVENT',
      {
        subject: p.title,
        start_datetime: wallClock(p.start),
        end_datetime: wallClock(p.end),
        time_zone: 'UTC',
        ...(p.note ? { body: p.note, is_html: false } : {}),
        // Outlook sends an invitation to everyone listed here. With guests the event was approved like an email; with none, nobody is written to.
        attendees_info: p.attendees.map((email) => ({ email, type: 'required' })),
      },
      'send',
    );
    if (!res.successful) return { status: 'failed', error: res.error ?? 'Outlook refused the event.' };
    const made = payload(res.data) as GraphEvent;
    // Accepted, but without the new event's id: whether it exists is settled by looking at the calendar.
    if (!made.id) throw new Error('Outlook did not say which event it made');
    return { status: 'completed', result: { via: 'outlook', id: made.id }, externalId: made.id };
  },

  async update(e, conn, p, current) {
    const args: Record<string, unknown> = { event_id: p.externalId };
    if (p.changed.includes('title')) args.subject = p.after.title;
    if (p.changed.includes('time')) {
      args.start_datetime = wallClock(p.after.start);
      args.end_datetime = wallClock(p.after.end);
      args.time_zone = 'UTC';
    }
    if (p.changed.includes('note')) args.body = { contentType: 'Text', content: p.after.note ?? '' };
    // Outlook replaces the whole list. People who stay keep their name and whether they were optional; the account's own entry stays.
    if (p.changed.includes('guests')) {
      const kept = new Map(current.attendees.map((a) => [a.email, a]));
      const list = [...new Set([...current.attendees.filter((a) => a.self).map((a) => a.email), ...p.after.attendees])];
      args.attendees = list.map((address) => ({ emailAddress: { address, ...(kept.get(address)?.name ? { name: kept.get(address)!.name } : {}) }, type: kept.get(address)?.optional ? 'optional' : 'required' }));
    }
    const res = await callTool(e.workspace_id, conn.id, 'OUTLOOK_UPDATE_CALENDAR_EVENT', args, 'send');
    if (!res.successful) return { status: 'failed', error: res.error ?? 'Outlook refused the change.' };
    return { status: 'completed', result: { via: 'outlook', id: p.externalId }, externalId: p.externalId };
  },

  async remove(e, conn, p, current) {
    // With attendees it is a meeting: cancelling it takes it off the calendar and tells them. With none, it is deleted.
    const res =
      current.guests.length > 0
        ? await callTool(e.workspace_id, conn.id, 'OUTLOOK_CANCEL_EVENT', { user_id: 'me', event_id: p.externalId }, 'send')
        : await callTool(e.workspace_id, conn.id, 'OUTLOOK_DELETE_CALENDAR_EVENT', { event_id: p.externalId }, 'send');
    if (!res.successful) return { status: 'failed', error: res.error ?? 'Outlook refused to delete the event.' };
    return { status: 'completed', result: { via: 'outlook', id: p.externalId }, externalId: p.externalId };
  },
};
