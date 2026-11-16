/**
 * Calendar sync. Reads a window of the connected calendar (Google Calendar or
 * Outlook) through Composio, stores each event as an item, and shows the timed
 * ones on Timmy's calendar. Timmy only reads here: creating, changing or
 * deleting an event is an outside write and goes through the Action gateway
 * like any other.
 */
import type { WEvent } from '../../../src/data/ws-types';
import type { Tx } from '../db/pool';
import { enqueueSoon } from '../jobs/jobs';
import { newId } from '../lib/ids';
import { log } from '../lib/log';
import { mutate } from '../state/mutate';
import { calendarFor, shownId, syncWindow } from './calendars';
import { connectionById, type Phase } from './tools';

export interface CalendarSync {
  events: number;
  shown: number;
  removed: number;
  pages: number;
  /** Stored events that were deleted because the calendar no longer has them. */
  dropped: number;
}

/**
 * Has a connection's calendar read again shortly. Asked for after every write Timmy makes to it, so Timmy's
 * calendar and its store show what the calendar holds without waiting for the provider to announce the change.
 */
export function readAgainSoon(workspaceId: string, connectionId: string) {
  // The same key the provider's own announcements use: one read covers a burst of reasons.
  enqueueSoon('calendar.sync', { workspaceId, connectionId }, { singletonKey: `cal:${connectionId}`, startAfter: 3 });
}

/**
 * Events on Timmy's calendar with a change of the person's own that is approved and has not finished going out.
 * Until it has, the screen shows what they did; a read of the calendar that arrives in between leaves those events alone.
 */
async function eventsBeingWritten(tx: Tx, workspaceId: string, connectionId: string): Promise<Set<string>> {
  const { rows } = await tx.query(`select payload->>'eventId' as id from effect where workspace_id = $1 and kind in ('calendar.update', 'calendar.delete') and status in ('approved', 'executing') and payload->>'connectionId' = $2`, [workspaceId, connectionId]);
  return new Set(rows.map((r) => r.id as string));
}

/**
 * Brings the calendar window up to date: two weeks back, two months ahead.
 * Safe to run as often as needed; it replaces what it wrote last time.
 */
export async function syncCalendar(workspaceId: string, connectionId: string, phase: Phase = 'sync'): Promise<CalendarSync> {
  const conn = await connectionById(workspaceId, connectionId);
  const cal = conn && calendarFor(conn.toolkit);
  if (!conn || !cal || conn.status !== 'active') return { events: 0, shown: 0, removed: 0, pages: 0, dropped: 0 };
  const { from, to } = syncWindow();
  const listed = await cal.list(workspaceId, conn, from, to, phase).catch((err: Error) => {
    log.warn('calendar page failed', { workspaceId, connectionId, error: err.message });
    throw err;
  });
  const live = listed.events;

  return mutate(workspaceId, 'calendar', async (tx, loaded) => {
    for (const e of live) {
      const shown = shownId(cal, connectionId, e.id);
      // What Timmy shows as the event's note: its description, or where it is when it has none.
      const note = e.note ?? e.location?.slice(0, 200);
      await tx.query(
        `insert into item (id, workspace_id, connection_id, kind, external_id, occurred_at, sender, recipients, subject, snippet, meta)
         values ($1, $2, $3, 'event', $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb)
         on conflict (workspace_id, connection_id, kind, external_id)
         do update set occurred_at = excluded.occurred_at, sender = excluded.sender, recipients = excluded.recipients, subject = excluded.subject, snippet = excluded.snippet, meta = excluded.meta, updated_at = now()`,
        [
          newId('itm'),
          workspaceId,
          connectionId,
          e.id,
          e.start,
          e.organizer,
          JSON.stringify({ to: e.attendees.map((a) => a.email), cc: [] }),
          e.title,
          (note ?? '').replace(/\s+/g, ' ').slice(0, 300),
          // Beside what Ask and the map of people read, the store keeps what a later change in Timmy starts from:
          // the event's id on Timmy's calendar, its guests, its note, and whether the account organizes it.
          JSON.stringify({ end: e.end.toISOString(), allDay: e.allDay, location: e.location, attendees: e.attendees.map((a) => ({ email: a.email, name: a.name, response: a.response })), shown, guests: e.guests, note, noteWhole: e.noteWhole, mine: e.mine, recurring: e.recurring }).replace(/\\u0000/g, ''),
        ],
      );
    }
    // An event the calendar no longer has leaves the store too. Only a listing that was read whole says what is gone.
    const dropped = listed.complete
      ? ((await tx.query(`delete from item where workspace_id = $1 and connection_id = $2 and kind = 'event' and occurred_at >= $3 and occurred_at < $4 and not (external_id = any($5::text[]))`, [workspaceId, connectionId, from, to, live.map((e) => e.id)])).rowCount ?? 0)
      : 0;

    // What the calendar screen shows: timed events only (an all-day entry has no clock time to place).
    const prefix = `${cal.prefix}${connectionId.slice(-6)}-`;
    // An event with a change of the person's own on its way out stays as their screen has it until that change has landed.
    const held = await eventsBeingWritten(tx, workspaceId, connectionId);
    const before = loaded.state.ws.events;
    const next: Record<string, WEvent> = {};
    for (const [id, ev] of Object.entries(before)) if (!id.startsWith(prefix) || held.has(id)) next[id] = ev;
    let shown = 0;
    for (const e of live) {
      if (e.allDay) continue;
      shown++;
      const id = shownId(cal, connectionId, e.id);
      if (held.has(id)) continue;
      const note = e.note ?? e.location?.slice(0, 200);
      const was = before[id];
      next[id] = {
        id,
        title: e.title,
        start: e.start,
        end: e.end,
        kind: e.guests.length ? 'meeting' : /\b(focus|deep work|heads down|block)\b/i.test(e.title) ? 'focus' : 'personal',
        with: e.guests.map((email) => `mail:${email}`),
        ...(note ? { note } : {}),
        // What only Timmy knows about the event (the task, files and thread linked to it) is kept across a read of the calendar.
        ...(was?.task ? { task: was.task } : {}),
        ...(was?.docs ? { docs: was.docs } : {}),
        ...(was?.thread ? { thread: was.thread } : {}),
        ...(was?.notesDoc ? { notesDoc: was.notesDoc } : {}),
      };
    }
    const removed = Object.keys(before).filter((id) => id.startsWith(prefix) && !next[id]).length;
    return { state: { ...loaded.state, ws: { ...loaded.state.ws, events: next } }, result: { events: live.length, shown, removed, pages: listed.pages, dropped } };
  });
}
