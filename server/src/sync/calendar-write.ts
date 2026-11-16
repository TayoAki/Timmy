/**
 * Writing an event the person added in Timmy through to their Google Calendar.
 *
 * With guests it sends invitations, so it reaches other people: it waits for
 * the same approval and the same undo window as an email. Without guests it is
 * only on the person's own calendar, and still goes through the gateway as an
 * effect record, like every write.
 *
 * This file covers creating an event. Changing or deleting one that already
 * exists in Google Calendar is not written back yet.
 */
import type { WEvent } from '../../../src/data/ws-types';
import type { EffectRow, Outcome, Proposal } from '../gateway/gateway';
import { ADDRESS } from '../gateway/mail';
import { callTool, connectionById } from './tools';

export interface EventPayload {
  connectionId: string;
  /** The event's id on Timmy's calendar, so the Google copy can take its place when it exists. */
  eventId: string;
  title: string;
  /** ISO instants. */
  start: string;
  end: string;
  attendees: string[];
  note?: string;
}

/** Ids of events the calendar sync owns on Timmy's calendar. Events made in Timmy have other ids until Google has them. */
export const SYNCED_PREFIX = 'gcal-';
export const shownId = (connectionId: string, eventId: string) => `${SYNCED_PREFIX}${connectionId.slice(-6)}-${eventId}`;

const when = (start: Date, end: Date) => {
  const day = start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const time = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  return `${day}, ${time(start)} to ${time(end)} UTC`;
};

/**
 * What the gateway is asked when an event is added. `emailOf` turns the people on the event into addresses;
 * someone Timmy has no address for can't be invited, and that is said rather than leaving them off silently.
 */
export function eventProposal(ev: WEvent, connectionId: string, emailOf: (personId: string) => string | null): { ok: false; reason: string } | { ok: true; proposal: Pick<Proposal, 'kind' | 'payload' | 'preview' | 'title' | 'target'> } {
  const start = new Date(ev.start);
  const end = new Date(ev.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return { ok: false, reason: 'That event has no usable start and end.' };
  const attendees: string[] = [];
  for (const id of ev.with ?? []) {
    if (id === 'me') continue;
    const email = emailOf(id)?.trim().toLowerCase();
    if (!email || !ADDRESS.test(email)) return { ok: false, reason: `Timmy has no email address for ${id.replace(/^mail:/, '')}, so it can’t invite them. Add their address, or take them off the event.` };
    if (!attendees.includes(email)) attendees.push(email);
  }
  const payload: EventPayload = { connectionId, eventId: ev.id, title: ev.title.slice(0, 300), start: start.toISOString(), end: end.toISOString(), attendees, ...(ev.note ? { note: ev.note.slice(0, 2000) } : {}) };
  return {
    ok: true,
    proposal: {
      kind: 'calendar.create',
      payload: payload as unknown as Record<string, unknown>,
      preview: { to: attendees, subject: ev.title, lines: [when(start, end), attendees.length ? `Google Calendar sends an invitation to ${attendees.join(', ')}` : 'On your calendar only; nobody is invited'] },
      title: attendees.length ? `Invite ${attendees.join(', ')} to “${ev.title}”` : `Add “${ev.title}” to your Google Calendar`,
      target: attendees.join(', ') || 'your calendar',
    },
  };
}

/** Creates the event in Google Calendar. */
export async function createEvent(e: EffectRow): Promise<Outcome> {
  const p = e.payload as unknown as EventPayload;
  const conn = await connectionById(e.workspace_id, p.connectionId);
  if (!conn || conn.status !== 'active') return { status: 'failed', error: 'The calendar is no longer connected.' };
  if (conn.toolkit !== 'googlecalendar') return { status: 'failed', error: 'Adding events to this kind of calendar isn’t available yet.' };
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
  const made = ((res.data.response_data ?? res.data) as { id?: string }) ?? {};
  return { status: 'completed', result: { via: 'googlecalendar', id: made.id }, externalId: made.id };
}

/**
 * For an event whose creation may or may not have gone through: look for it on the calendar.
 * Found means completed; not found proves nothing and stays unconfirmed, so it is never created twice.
 */
export async function reconcileEvent(e: EffectRow): Promise<Outcome> {
  const unknown: Outcome = { status: 'uncertain', error: e.error ?? 'unknown' };
  const p = e.payload as unknown as EventPayload;
  const conn = await connectionById(e.workspace_id, p.connectionId);
  if (!conn || conn.status !== 'active' || conn.toolkit !== 'googlecalendar') return unknown;
  // The same listing call the calendar sync uses, over the event's own time span.
  const res = await callTool(e.workspace_id, conn.id, 'GOOGLECALENDAR_EVENTS_LIST', { calendarId: 'primary', timeMin: new Date(new Date(p.start).getTime() - 60_000).toISOString(), timeMax: new Date(new Date(p.end).getTime() + 60_000).toISOString(), singleEvents: true, maxResults: 50 }, 'send');
  if (!res.successful) return unknown;
  const list = (res.data.items ?? []) as { id?: string; summary?: string; status?: string; start?: { dateTime?: string } }[];
  const found = list.find((x) => x.status !== 'cancelled' && x.summary === p.title && !!x.start?.dateTime && new Date(x.start.dateTime).getTime() === new Date(p.start).getTime());
  return found?.id ? { status: 'completed', result: { via: 'googlecalendar', id: found.id, reconciled: true }, externalId: found.id } : unknown;
}
