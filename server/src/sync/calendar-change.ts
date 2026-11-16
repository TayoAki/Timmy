/**
 * Changing or deleting an event that is already on the connected calendar,
 * Google's or Outlook's, because the person changed or removed it in Timmy.
 *
 * The rules, and where each one is kept:
 *   - It is an effect record like every write (`calendar.update`, `calendar.delete`). With guests on the event,
 *     before or after, the calendar tells them, so the record says who is told and what changes, and it waits for
 *     the same approval and the same undo window as an email.
 *   - Only an event the connected account organizes can be changed or deleted. Someone else's is refused, with the
 *     reason, when the change is asked for and again against the calendar itself right before writing.
 *   - What is written is the stored record: the fields that were approved, and nothing else on the event.
 *   - Nobody is told who was not shown to the approver. If the calendar has gained a guest since, nothing is written.
 *   - An outcome that is unknown is settled by looking at the calendar, never by writing again.
 */
import type { State } from '../../../src/state/store';
import type { Tx } from '../db/pool';
import type { EffectRow, Outcome, Proposal } from '../gateway/gateway';
import { readAgainSoon } from './calendar';
import { sameNote } from './calendar-note';
import { asBody, when } from './calendar-write';
import { calendarFor, syncWindow, type Calendar, type CalendarEvent } from './calendars';
import { connectionById } from './tools';

/** The fields of an event that live on the calendar and that Timmy may write. Times are ISO instants; attendees are the guests' addresses. */
export interface EventFields {
  title: string;
  start: string;
  end: string;
  attendees: string[];
  note?: string;
}

export type ChangedField = 'title' | 'time' | 'guests' | 'note';

export interface EventRemoval {
  connectionId: string;
  /** The event's id on the calendar. */
  externalId: string;
  /** Its id on Timmy's calendar. */
  eventId: string;
  /** What the calendar held when this was asked for: what the approver was shown, and who they were told would hear of it. */
  before: EventFields;
  /** One time of a repeating event: only this one is touched. */
  recurring?: boolean;
}

export interface EventChange extends EventRemoval {
  /** What the event becomes. */
  after: EventFields;
  /** The fields this change writes. Nothing else on the event is touched. */
  changed: ChangedField[];
}

export const isEventChange = (kind: string): kind is 'calendar.update' | 'calendar.delete' => kind === 'calendar.update' || kind === 'calendar.delete';

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Which calendar fields differ between two versions of an event. */
export function changedFields(a: EventFields, b: EventFields): ChangedField[] {
  const out: ChangedField[] = [];
  if (a.title !== b.title) out.push('title');
  if (new Date(a.start).getTime() !== new Date(b.start).getTime() || new Date(a.end).getTime() !== new Date(b.end).getTime()) out.push('time');
  if (!sameSet(a.attendees, b.attendees)) out.push('guests');
  if ((a.note ?? '') !== (b.note ?? '')) out.push('note');
  return out;
}

/* ───────────── What the store knows about an event ───────────── */

export interface StoredEvent {
  connectionId: string;
  toolkit: string;
  /** The address of the connected account, when the provider gave one. */
  account: string | null;
  externalId: string;
  organizer: string;
  /** Whether the connected account organizes it. Undefined for an event stored before this was kept. */
  mine?: boolean;
  /** The event as the last sync saw it. Null for an event stored before its guests were kept: it has to be read again first. */
  fields: EventFields | null;
  noteWhole: boolean;
  recurring: boolean;
}

/**
 * The stored copy of an event on Timmy's calendar, by its id there. The search runs inside the workspace's own
 * scope and only over connections that are still in use, so an id from another workspace finds nothing.
 */
export async function storedEvent(tx: Tx, workspaceId: string, shown: string): Promise<StoredEvent | null> {
  const { rows } = await tx.query(
    // An event stored before its id on Timmy's calendar was kept beside it can only be Google's, whose id is spelled out here.
    `select i.external_id, i.subject, i.occurred_at, i.sender, i.meta, c.id as connection_id, c.toolkit, c.account_label
     from item i join connection c on c.id = i.connection_id
     where i.workspace_id = $1 and c.workspace_id = $1 and i.kind = 'event' and c.status = 'active'
       and coalesce(i.meta->>'shown', 'gcal-' || right(i.connection_id, 6) || '-' || i.external_id) = $2
     limit 1`,
    [workspaceId, shown],
  );
  const r = rows[0] as { external_id: string; subject: string | null; occurred_at: Date; sender: string | null; meta: Record<string, unknown>; connection_id: string; toolkit: string; account_label: string | null } | undefined;
  if (!r) return null;
  const m = r.meta as { end?: string; guests?: string[]; note?: string; mine?: boolean; noteWhole?: boolean; recurring?: boolean };
  const end = new Date(m.end ?? '');
  const known = Array.isArray(m.guests) && !Number.isNaN(end.getTime());
  return {
    connectionId: r.connection_id,
    toolkit: r.toolkit,
    account: r.account_label,
    externalId: r.external_id,
    organizer: r.sender ?? '',
    mine: m.mine,
    fields: known ? { title: r.subject ?? '', start: new Date(r.occurred_at).toISOString(), end: end.toISOString(), attendees: m.guests!, ...(m.note ? { note: m.note } : {}) } : null,
    noteWhole: m.noteWhole !== false,
    recurring: m.recurring === true,
  };
}

/* ───────────── Asking the gateway ───────────── */

type Asked = { ok: false; reason: string } | { ok: true; proposal: Pick<Proposal, 'kind' | 'payload' | 'preview' | 'title' | 'target'> };

const list = (people: string[]) => people.join(', ');

/** What the person is told when the store's copy of an event isn't enough to write from yet. A read of the calendar is asked for at the same time. */
export const READING_AGAIN = 'Timmy is reading this calendar again. Try that once more in a minute.';

/** Why an event that someone else organizes can't be written to, in words for the person. */
const notYours = (stored: Pick<StoredEvent, 'organizer'>, title: string, verb: 'changed' | 'deleted', cal: Calendar) =>
  `“${title}” is organized by ${stored.organizer || 'someone else'}, so it can’t be ${verb} from Timmy. ${verb === 'changed' ? 'Ask them to change it' : `To take it off your calendar, decline it in ${cal.name}`}.`;

/**
 * What the gateway is asked when a synced event is changed in Timmy. `shown` is the event's id on Timmy's calendar,
 * `after` the event as the person left it and `changed` the fields their change touched. The record shows the
 * approver what the calendar holds now, what it becomes, and everyone who will be told.
 */
export function changeProposal(shown: string, stored: StoredEvent, after: EventFields, changed: ChangedField[], zone: string): Asked {
  const cal = calendarFor(stored.toolkit);
  const before = stored.fields;
  if (!cal || !before) return { ok: false, reason: READING_AGAIN };
  if (stored.mine === false) return { ok: false, reason: notYours(stored, before.title, 'changed', cal) };
  if (changed.includes('time') && !(new Date(after.end) > new Date(after.start))) return { ok: false, reason: 'That event has no usable start and end.' };
  if (changed.includes('title') && !after.title) return { ok: false, reason: 'An event needs a title.' };
  // Timmy holds the words of a description up to a length. Writing that copy back over a longer or formatted one would lose part of it.
  if (changed.includes('note') && !stored.noteWhole) return { ok: false, reason: `The description of “${before.title}” is longer than the note Timmy shows, or has formatting, so changing it here would lose part of it. Change the description in ${cal.name}; the time, title and guests can be changed here.` };

  const added = after.attendees.filter((a) => !before.attendees.includes(a));
  const dropped = before.attendees.filter((a) => !after.attendees.includes(a));
  // Everyone on the event before or after hears of it: those who stay get an update, new people an invitation, and people taken off are told it is cancelled for them.
  const told = [...new Set([...before.attendees, ...after.attendees])];
  const lines: string[] = [];
  // The old time and the new, each on a line of its own, so neither can be taken for the other.
  if (changed.includes('time')) lines.push(`Now: ${when(new Date(before.start), new Date(before.end), zone)}`, `Moves to: ${when(new Date(after.start), new Date(after.end), zone)}`);
  else lines.push(when(new Date(before.start), new Date(before.end), zone));
  if (changed.includes('title')) lines.push(`Renamed from “${before.title}” to “${after.title}”`);
  if (added.length) lines.push(`Adds ${list(added)}`);
  if (dropped.length) lines.push(`Takes ${list(dropped)} off the event`);
  if (changed.includes('note')) lines.push(after.note ? `The description becomes: ${after.note.length > 300 ? `${after.note.slice(0, 300)}…` : after.note}` : 'The description is cleared');
  if (stored.recurring) lines.push('This is one time of a repeating event; only this one changes');
  lines.push(told.length ? `${cal.name} tells ${list(told)} about the change` : 'On your calendar only; nobody is told');

  const what = changed.includes('time') ? `Move “${before.title}” to ${when(new Date(after.start), new Date(after.end), zone)}` : `Change “${before.title}”`;
  const payload: EventChange = { connectionId: stored.connectionId, externalId: stored.externalId, eventId: shown, before, after, changed, ...(stored.recurring ? { recurring: true } : {}) };
  return {
    ok: true,
    proposal: {
      kind: 'calendar.update',
      payload: payload as unknown as Record<string, unknown>,
      preview: { to: told, subject: after.title, lines, body: asBody(lines) },
      title: told.length ? `${what}, and tell ${list(told)}` : `${what} on ${cal.yours}`,
      target: list(told) || 'your calendar',
    },
  };
}

/** What the gateway is asked when a synced event is removed in Timmy. */
export function removalProposal(shown: string, stored: StoredEvent, zone: string): Asked {
  const cal = calendarFor(stored.toolkit);
  const before = stored.fields;
  if (!cal || !before) return { ok: false, reason: READING_AGAIN };
  if (stored.mine === false) return { ok: false, reason: notYours(stored, before.title, 'deleted', cal) };
  const told = before.attendees;
  const lines = [when(new Date(before.start), new Date(before.end), zone)];
  if (stored.recurring) lines.push('This is one time of a repeating event; only this one is deleted');
  lines.push(told.length ? `${cal.name} tells ${list(told)} it is cancelled` : 'On your calendar only; nobody is told');
  const payload: EventRemoval = { connectionId: stored.connectionId, externalId: stored.externalId, eventId: shown, before, ...(stored.recurring ? { recurring: true } : {}) };
  return {
    ok: true,
    proposal: {
      kind: 'calendar.delete',
      payload: payload as unknown as Record<string, unknown>,
      preview: { to: told, subject: before.title, lines, body: asBody(lines) },
      title: told.length ? `Cancel “${before.title}” and tell ${list(told)}` : `Delete “${before.title}” from ${cal.yours}`,
      target: list(told) || 'your calendar',
    },
  };
}

/* ───────────── Writing ───────────── */

const failed = (error: string): Outcome => ({ status: 'failed', error });

async function write(e: EffectRow, p: EventChange | EventRemoval): Promise<Outcome> {
  const removing = e.kind === 'calendar.delete';
  const conn = await connectionById(e.workspace_id, p.connectionId);
  if (!conn || conn.status !== 'active') return failed('The calendar is no longer connected.');
  const cal = calendarFor(conn.toolkit);
  if (!cal) return failed('Changing events on this kind of calendar isn’t available yet.');

  // The event as the calendar holds it now. Until this has been read, nothing has been written, so a failure here is a clean one.
  let current: CalendarEvent | null;
  try {
    current = await cal.get(e.workspace_id, conn, p.externalId, 'send');
  } catch (err) {
    return failed(`${cal.name} would not show the event, so nothing was changed: ${(err as Error).message}`);
  }
  // Already cancelled on the calendar: a deletion has nothing left to do, and a change has nothing to change.
  if (!current) return removing ? { status: 'completed', result: { via: conn.toolkit, id: p.externalId, alreadyGone: true }, externalId: p.externalId } : failed('The event is no longer on the calendar.');
  if (!current.mine) return failed(`${current.organizer || 'Someone else'} organizes this event, so it can’t be ${removing ? 'deleted' : 'changed'} from Timmy.`);
  // Whoever approved this was shown the guests the store knew of. Anyone the calendar has added since would be told without having been shown.
  const shown = new Set([...p.before.attendees, ...('after' in p ? p.after.attendees : [])]);
  const unseen = current.guests.filter((g) => !shown.has(g));
  if (unseen.length) return failed(`${list(unseen)} ${unseen.length === 1 ? 'was' : 'were'} added to this event on the calendar after this was approved, and would have been told without being shown to you. Nothing was changed. Make the change again.`);

  return removing ? cal.remove(e, conn, p, current) : cal.update(e, conn, p as EventChange, current);
}

/** The executor for `calendar.update` and `calendar.delete`. */
export async function changeEvent(e: EffectRow): Promise<Outcome> {
  const p = e.payload as unknown as EventChange | EventRemoval;
  try {
    return await write(e, p);
  } finally {
    // Whatever the write did (took, was refused, or never answered), the calendar is read again, and Timmy's
    // calendar then shows what it really holds.
    readAgainSoon(e.workspace_id, p.connectionId);
  }
}

/** Whether the calendar's event now shows every field a change was to write. */
const shows = (now: CalendarEvent, p: EventChange) =>
  p.changed.every((field) => {
    if (field === 'title') return now.title === p.after.title;
    if (field === 'time') return now.start.getTime() === new Date(p.after.start).getTime() && now.end.getTime() === new Date(p.after.end).getTime();
    if (field === 'guests') return sameSet(now.guests, p.after.attendees);
    return sameNote(now.note, p.after.note);
  });

/**
 * For a change or a deletion whose outcome is unknown: look at the calendar. A change counts as made when the event
 * shows every field it was to write; a deletion when the calendar's own listing no longer has the event. Anything
 * else proves nothing and stays unconfirmed. It is never written again.
 */
export async function reconcileChange(e: EffectRow): Promise<Outcome> {
  const unknown: Outcome = { status: 'uncertain', error: e.error ?? 'unknown' };
  const p = e.payload as unknown as EventChange | EventRemoval;
  const conn = await connectionById(e.workspace_id, p.connectionId);
  const cal = conn && calendarFor(conn.toolkit);
  if (!conn || !cal || conn.status !== 'active') return unknown;
  const done: Outcome = { status: 'completed', result: { via: conn.toolkit, id: p.externalId, reconciled: true }, externalId: p.externalId };
  try {
    if (e.kind === 'calendar.delete') {
      // The same listing the sync reads. It is evidence only if it was read whole and the event's time lies inside it.
      const { from, to } = syncWindow();
      if (!(new Date(p.before.end) > from && new Date(p.before.start) < to)) return unknown;
      const listed = await cal.list(e.workspace_id, conn, from, to, 'send');
      if (!listed.complete || listed.events.some((x) => x.id === p.externalId)) return unknown;
    } else {
      const now = await cal.get(e.workspace_id, conn, p.externalId, 'send');
      if (!now || !shows(now, p as EventChange)) return unknown;
    }
  } catch {
    return unknown;
  }
  readAgainSoon(e.workspace_id, p.connectionId);
  return done;
}

/* ───────────── What Timmy's calendar shows afterwards ───────────── */

/**
 * Timmy's calendar once the calendar has taken a change. A change the person approved themselves is already on
 * their screen; one that waited for someone else, or that a sync put back in the meantime, is applied here.
 */
export function afterEventChange(state: State, e: EffectRow): State {
  const p = e.payload as unknown as EventChange | EventRemoval;
  const shown = state.ws.events[p.eventId];
  if (!shown) return state;
  if (e.kind === 'calendar.delete') {
    const events = Object.fromEntries(Object.entries(state.ws.events).filter(([id]) => id !== p.eventId));
    const tasks = Object.fromEntries(Object.entries(state.ws.tasks).map(([id, t]) => [id, t.event === p.eventId ? { ...t, event: undefined } : t]));
    return { ...state, ws: { ...state.ws, events, tasks } };
  }
  const { after, changed } = p as EventChange;
  const next = { ...shown };
  if (changed.includes('title')) next.title = after.title;
  if (changed.includes('time')) {
    next.start = new Date(after.start);
    next.end = new Date(after.end);
  }
  if (changed.includes('note')) next.note = after.note;
  // The calendar only knows addresses. The list on the screen is rewritten unless it already names exactly those.
  const guests = after.attendees.map((a) => `mail:${a}`);
  if (changed.includes('guests') && !(shown.with.length === guests.length && shown.with.every((id) => guests.includes(id)))) next.with = guests;
  const same = next.title === shown.title && new Date(next.start).getTime() === new Date(shown.start).getTime() && new Date(next.end).getTime() === new Date(shown.end).getTime() && next.note === shown.note && next.with === shown.with;
  return same ? state : { ...state, ws: { ...state.ws, events: { ...state.ws.events, [p.eventId]: next } } };
}
