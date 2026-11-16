/**
 * Writing an event the person added in Timmy through to their calendar: Google
 * Calendar or Outlook, whichever the connection is.
 *
 * With guests it sends invitations, so it reaches other people: it waits for
 * the same approval and the same undo window as an email. Without guests it is
 * only on the person's own calendar, and still goes through the gateway as an
 * effect record, like every write.
 *
 * This file covers creating an event. Changing or deleting one that is already
 * on the calendar is in calendar-change.ts.
 */
import type { WEvent } from '../../../src/data/ws-types';
import type { EffectRow, Outcome, Proposal } from '../gateway/gateway';
import { ADDRESS } from '../gateway/mail';
import { readAgainSoon } from './calendar';
import { calendarFor, shownId } from './calendars';
import { connectionById } from './tools';

export interface EventPayload {
  connectionId: string;
  /** The event's id on Timmy's calendar, so the calendar's copy can take its place when it exists. */
  eventId: string;
  title: string;
  /** ISO instants. */
  start: string;
  end: string;
  attendees: string[];
  note?: string;
}

/** A day and a span of time in words, on the clock of a time zone: "Tue, Nov 17, 10:00 AM to 10:30 AM EST". */
export function when(start: Date, end: Date, zone = 'UTC'): string {
  const words = (timeZone: string) => {
    const day = start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone });
    const time = (d: Date, named: boolean) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone, ...(named ? { timeZoneName: 'short' as const } : {}) });
    return `${day}, ${time(start, false)} to ${time(end, true)}`;
  };
  try {
    return words(zone);
  } catch {
    // A zone the server doesn't know: the time is still right in UTC, and says so.
    return words('UTC');
  }
}

/** What a calendar write will do, line by line, as the text the Approvals screen shows whoever has to say yes. */
export const asBody = (lines: string[]) => lines.join('\n\n');

/**
 * The guests' addresses for the people on an event. Someone Timmy has no address for can't be invited, and that is
 * said rather than leaving them off silently. The person themselves ("me", or the calendar's own address) is not a guest.
 */
export function guestAddresses(people: string[], emailOf: (personId: string) => string | null, account: string | null = null): { ok: false; reason: string } | { ok: true; attendees: string[] } {
  const attendees: string[] = [];
  for (const id of people) {
    if (id === 'me') continue;
    const email = emailOf(id)?.trim().toLowerCase();
    if (!email || !ADDRESS.test(email)) return { ok: false, reason: `Timmy has no email address for ${id.replace(/^mail:/, '')}, so it can’t invite them. Add their address, or take them off the event.` };
    if (email !== (account ?? '').toLowerCase() && !attendees.includes(email)) attendees.push(email);
  }
  return { ok: true, attendees };
}

/** What the gateway is asked when an event is added. `zone` is the time zone the approver reads the time in. */
export function eventProposal(ev: WEvent, conn: { id: string; toolkit: string }, emailOf: (personId: string) => string | null, zone = 'UTC'): { ok: false; reason: string } | { ok: true; proposal: Pick<Proposal, 'kind' | 'payload' | 'preview' | 'title' | 'target'> } {
  const cal = calendarFor(conn.toolkit);
  if (!cal) return { ok: false, reason: 'Adding events to this kind of calendar isn’t available yet.' };
  const start = new Date(ev.start);
  const end = new Date(ev.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return { ok: false, reason: 'That event has no usable start and end.' };
  const guests = guestAddresses(ev.with ?? [], emailOf);
  if (!guests.ok) return guests;
  const attendees = guests.attendees;
  const payload: EventPayload = { connectionId: conn.id, eventId: ev.id, title: ev.title.slice(0, 300), start: start.toISOString(), end: end.toISOString(), attendees, ...(ev.note ? { note: ev.note.slice(0, 2000) } : {}) };
  const lines = [when(start, end, zone), attendees.length ? `${cal.name} sends an invitation to ${attendees.join(', ')}` : 'On your calendar only; nobody is invited'];
  return {
    ok: true,
    proposal: {
      kind: 'calendar.create',
      payload: payload as unknown as Record<string, unknown>,
      preview: { to: attendees, subject: ev.title, lines, body: asBody(lines) },
      title: attendees.length ? `Invite ${attendees.join(', ')} to “${ev.title}”` : `Add “${ev.title}” to ${cal.yours}`,
      target: attendees.join(', ') || 'your calendar',
    },
  };
}

/** Creates the event on the connection's calendar. */
export async function createEvent(e: EffectRow): Promise<Outcome> {
  const p = e.payload as unknown as EventPayload;
  const conn = await connectionById(e.workspace_id, p.connectionId);
  if (!conn || conn.status !== 'active') return { status: 'failed', error: 'The calendar is no longer connected.' };
  // Each calendar has its own call; one that isn't wired is refused, never written through another's.
  const cal = calendarFor(conn.toolkit);
  if (!cal) return { status: 'failed', error: 'Adding events to this kind of calendar isn’t available yet.' };
  const out = await cal.create(e, conn, p);
  if (out.status !== 'completed' || !out.externalId) return out;
  // The new event is read into the store straight away, so it can be changed or deleted from Timmy without waiting
  // for the provider to announce it.
  readAgainSoon(e.workspace_id, conn.id);
  // The id the calendar's copy will have on Timmy's calendar goes with the result, so that copy can take the place of the one made in Timmy.
  return { ...out, result: { ...out.result, shown: shownId(cal, conn.id, out.externalId) } };
}

/**
 * For an event whose creation may or may not have gone through: look for it on the calendar.
 * Found means completed; not found proves nothing and stays unconfirmed, so it is never created twice.
 */
export async function reconcileEvent(e: EffectRow): Promise<Outcome> {
  const unknown: Outcome = { status: 'uncertain', error: e.error ?? 'unknown' };
  const p = e.payload as unknown as EventPayload;
  const conn = await connectionById(e.workspace_id, p.connectionId);
  const cal = conn && calendarFor(conn.toolkit);
  if (!conn || !cal || conn.status !== 'active') return unknown;
  // The same listing the calendar sync uses, over the event's own time span.
  const listed = await cal.list(e.workspace_id, conn, new Date(new Date(p.start).getTime() - 60_000), new Date(new Date(p.end).getTime() + 60_000), 'send').catch(() => null);
  const found = listed?.events.find((x) => !x.allDay && x.title === (p.title.trim() || '(no title)') && x.start.getTime() === new Date(p.start).getTime());
  if (!found) return unknown;
  readAgainSoon(e.workspace_id, conn.id);
  return { status: 'completed', result: { via: conn.toolkit, id: found.id, reconciled: true, shown: shownId(cal, conn.id, found.id) }, externalId: found.id };
}
