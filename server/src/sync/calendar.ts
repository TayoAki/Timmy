/**
 * Calendar sync. Reads a window of the connected calendar through Composio,
 * stores each event as an item, and shows the timed ones on Timmy's calendar.
 * Timmy only reads here: creating or changing an event is an outside write and
 * goes through the Action gateway like any other.
 */
import type { WEvent } from '../../../src/data/ws-types';
import { newId } from '../lib/ids';
import { log } from '../lib/log';
import { mutate } from '../state/mutate';
import { callTool, connectionById, type Phase } from './tools';

interface GoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string; self?: boolean; responseStatus?: string }[];
  organizer?: { email?: string; self?: boolean };
}

export interface CalendarSync {
  events: number;
  shown: number;
  removed: number;
  pages: number;
}

const DAY = 86400_000;

/** Ids of events this sync owns on Timmy's calendar. Events the user made in Timmy have other ids and are left alone. */
const shownId = (connectionId: string, eventId: string) => `gcal-${connectionId.slice(-6)}-${eventId}`;

/**
 * Brings the calendar window up to date: two weeks back, two months ahead.
 * Safe to run as often as needed; it replaces what it wrote last time.
 */
export async function syncCalendar(workspaceId: string, connectionId: string, phase: Phase = 'sync'): Promise<CalendarSync> {
  const conn = await connectionById(workspaceId, connectionId);
  if (!conn || conn.status !== 'active') return { events: 0, shown: 0, removed: 0, pages: 0 };
  const from = new Date(Date.now() - 14 * DAY);
  const to = new Date(Date.now() + 60 * DAY);
  const events: GoogleEvent[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const res = await callTool(workspaceId, connectionId, 'GOOGLECALENDAR_EVENTS_LIST', { calendarId: 'primary', timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 250, ...(pageToken ? { pageToken } : {}) }, phase);
    if (!res.successful) {
      log.warn('calendar page failed', { workspaceId, connectionId, error: res.error });
      throw new Error(res.error ?? 'calendar sync failed');
    }
    events.push(...((res.data.items ?? []) as GoogleEvent[]));
    pageToken = (res.data.nextPageToken as string | null | undefined) || undefined;
    pages++;
  } while (pageToken && pages < 20);

  const mine = (conn.account_label ?? '').toLowerCase();
  const live = events.filter((e) => e.id && e.status !== 'cancelled');
  return mutate(workspaceId, 'calendar', async (tx, loaded) => {
    for (const e of live) {
      const start = e.start?.dateTime ?? e.start?.date;
      if (!start) continue;
      await tx.query(
        `insert into item (id, workspace_id, connection_id, kind, external_id, occurred_at, sender, recipients, subject, snippet, meta)
         values ($1, $2, $3, 'event', $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb)
         on conflict (workspace_id, connection_id, kind, external_id)
         do update set occurred_at = excluded.occurred_at, recipients = excluded.recipients, subject = excluded.subject, snippet = excluded.snippet, meta = excluded.meta, updated_at = now()`,
        [
          newId('itm'),
          workspaceId,
          connectionId,
          e.id,
          new Date(start),
          (e.organizer?.email ?? '').toLowerCase(),
          JSON.stringify({ to: (e.attendees ?? []).map((a) => (a.email ?? '').toLowerCase()).filter(Boolean), cc: [] }),
          (e.summary ?? '(no title)').slice(0, 500),
          (e.description ?? e.location ?? '').replace(/\s+/g, ' ').replace(/\u0000/g, '').slice(0, 300),
          JSON.stringify({ end: e.end?.dateTime ?? e.end?.date, allDay: !e.start?.dateTime, location: e.location, attendees: (e.attendees ?? []).map((a) => ({ email: a.email, name: a.displayName, response: a.responseStatus })) }).replace(/\\u0000/g, ''),
        ],
      );
    }
    // What the calendar screen shows: timed events only (an all-day entry has no clock time to place).
    const prefix = `gcal-${connectionId.slice(-6)}-`;
    const next: Record<string, WEvent> = {};
    for (const [id, ev] of Object.entries(loaded.state.ws.events)) if (!id.startsWith(prefix)) next[id] = ev;
    let shown = 0;
    for (const e of live) {
      if (!e.start?.dateTime || !e.end?.dateTime) continue;
      const others = (e.attendees ?? []).filter((a) => a.email && !a.self && a.email.toLowerCase() !== mine);
      const id = shownId(connectionId, e.id!);
      next[id] = {
        id,
        title: e.summary?.trim() || '(no title)',
        start: new Date(e.start.dateTime),
        end: new Date(e.end.dateTime),
        kind: others.length ? 'meeting' : /\b(focus|deep work|heads down|block)\b/i.test(e.summary ?? '') ? 'focus' : 'personal',
        with: others.map((a) => `mail:${a.email!.toLowerCase()}`),
        ...(e.location ? { note: e.location.slice(0, 200) } : {}),
      };
      shown++;
    }
    const removed = Object.keys(loaded.state.ws.events).filter((id) => id.startsWith(prefix) && !next[id]).length;
    return { state: { ...loaded.state, ws: { ...loaded.state.ws, events: next } }, result: { events: live.length, shown, removed, pages } };
  });
}
