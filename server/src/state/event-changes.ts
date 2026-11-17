/**
 * When a command changes or removes an event that came from a connected
 * calendar, the same change is written to that calendar, through the gateway.
 *
 * Like sends and filing, this is decided from the reducer's result, not from the
 * action's name: whatever a command did to a synced event's time, title, guests
 * or note is found by comparing the calendar before and after it.
 *
 *   - The person's own change is on their screen at once and is written when the undo window ends.
 *     Undo inside the window takes it back and nothing is written.
 *   - A change that someone else has to approve leaves the event as the calendar has it until they have.
 *   - A change that can't be written (the event is someone else's, sending is switched off) is refused whole,
 *     with the reason: Timmy's calendar never shows something the real one won't have.
 */
import type { WEvent } from '../../../src/data/ws-types';
import type { CommandResult } from '../../../src/live/types';
import type { Action, State } from '../../../src/state/store';
import { config } from '../config';
import type { Tx } from '../db/pool';
import { propose, type EffectRow } from '../gateway/gateway';
import type { Actor } from '../gateway/policy';
import { readAgainSoon } from '../sync/calendar';
import { NOTE_MAX } from '../sync/calendar-note';
import { READING_AGAIN, changeProposal, changedFields, removalProposal, storedEvent, type ChangedField, type EventFields } from '../sync/calendar-change';
import { guestAddresses } from '../sync/calendar-write';
import { CALENDAR_TOOLKITS, connectionMark, isSynced } from '../sync/calendars';
import type { Loaded } from './docs';

/** The part of a command's outcome this step reads and adds to. */
interface Step {
  state: State;
  reject?: string;
  toast?: CommandResult['toast'];
  effects?: EffectRow[];
}

/** Undo, and turning down a waiting action, put the calendar back as it was. Nothing was written, so there is nothing to write back. */
const takesBack = (a: Action) => a.type === 'undo' || a.type === 'effect' || (a.type === 'resolve' && a.key.startsWith('eff:'));

const usable = (ev: WEvent) => !Number.isNaN(new Date(ev.start).getTime()) && !Number.isNaN(new Date(ev.end).getTime());

/** The calendar's fields of an event on Timmy's screen, with its guests as addresses. */
const fieldsOf = (ev: WEvent, attendees: string[]): EventFields => {
  const note = ev.note?.trim().slice(0, NOTE_MAX);
  return { title: String(ev.title ?? '').trim().slice(0, 500), start: new Date(ev.start).toISOString(), end: new Date(ev.end).toISOString(), attendees, ...(note ? { note } : {}) };
};

/** The calendar connection, still in use in this workspace, that an event on Timmy's calendar came from. Null when there is none. */
async function connectedCalendar(tx: Tx, workspaceId: string, shown: string): Promise<string | null> {
  const mark = connectionMark(shown);
  if (!mark) return null;
  const { rows } = await tx.query(`select id from connection where workspace_id = $1 and status = 'active' and toolkit = any($2::text[]) and right(id, 6) = $3 limit 1`, [workspaceId, CALENDAR_TOOLKITS, mark]);
  return (rows[0]?.id as string | undefined) ?? null;
}

export async function changeEvents<H extends Step>(tx: Tx, loaded: Loaded, actor: Actor, cmd: { id: string; action: Action }, handled: H, emailOf: (personId: string) => string | null): Promise<H> {
  const prev = loaded.state.ws.events;
  const next = handled.state.ws.events;
  if (prev === next || takesBack(cmd.action)) return handled;
  const refuse = (reject: string): H => ({ ...handled, state: loaded.state, reject });
  const workspaceId = loaded.workspace.id;

  // An id that only a calendar sync gives out can't be used to put an event of one's own on the screen.
  if (Object.keys(next).some((id) => isSynced(id) && !prev[id])) return refuse('That event isn’t on a connected calendar.');
  const touched = Object.keys(prev).filter((id) => isSynced(id) && prev[id] !== next[id]);
  if (!touched.length) return handled;

  // What each touched event asks of its calendar, worked out before anything is proposed.
  const asks: { id: string; was: WEvent; removing: boolean; proposal: Parameters<typeof propose>[4] }[] = [];
  for (const id of touched) {
    const was = prev[id]!;
    const now = next[id];
    const stored = await storedEvent(tx, workspaceId, id);
    // On the screen but not in the store. If its calendar is no longer connected there is nowhere to write to, and
    // the change stays in Timmy. If it is, this is an event the calendar has only just been given, not yet read back.
    const unread = stored ? null : await connectedCalendar(tx, workspaceId, id);
    if (!stored && !unread) continue;
    const account = stored?.account ?? null;
    let after: EventFields | undefined;
    let changed: ChangedField[] = [];
    if (now) {
      if (!usable(now)) return refuse('That event has no usable start and end.');
      const guests = guestAddresses(now.with ?? [], emailOf, account);
      if (!guests.ok) return refuse(guests.reason);
      // The event as it was on the screen. A guest named there without an address still counts as a guest who has gone.
      const before = fieldsOf(was, (was.with ?? []).filter((p) => p !== 'me').map((p) => emailOf(p)?.trim().toLowerCase() ?? p).filter((a) => a !== (account ?? '').toLowerCase()));
      after = fieldsOf(now, guests.attendees);
      changed = changedFields(before, after);
      // Only something Timmy alone keeps changed (the linked task, the kind): the calendar has nothing to hear.
      if (!changed.length) continue;
    }
    // Without the stored copy there is no knowing who organizes the event or who is on it. It is read first.
    if (!stored) {
      readAgainSoon(workspaceId, unread!);
      return refuse(READING_AGAIN);
    }
    const asked = after ? changeProposal(id, stored, after, changed, loaded.workspace.timezone) : removalProposal(id, stored, loaded.workspace.timezone);
    if (!asked.ok) {
      // An event stored before its guests were kept is read again too, so the next try has what it needs.
      if (!stored.fields) readAgainSoon(workspaceId, stored.connectionId);
      return refuse(asked.reason);
    }
    // One change to an event at a time. A second one while the first is waiting or going out could reach the calendar
    // before it, and whoever approves it would be shown a "before" that is about to change.
    const busy = (await tx.query(`select status from effect where workspace_id = $1 and kind in ('calendar.update', 'calendar.delete') and payload->>'eventId' = $2 and status in ('intended', 'approved', 'executing') limit 1`, [workspaceId, id])).rows[0] as { status: string } | undefined;
    if (busy) return refuse(busy.status === 'intended' ? `“${was.title}” already has a change waiting for approval. That one has to be decided first.` : `“${was.title}” already has a change on its way to the calendar. Undo it, or wait until it has gone through, then change it again.`);
    asks.push({ id, was, removing: !now, proposal: { ...asked.proposal, why: now ? 'You changed it in Timmy.' : 'You deleted it in Timmy.', idempotencyKey: `cmd:${cmd.id}:event-${now ? 'update' : 'delete'}:${id}`, source: 'user', commandId: cmd.id } });
  }
  if (!asks.length) return handled;
  // Each one is a write to the calendar, and with guests a message to them. One command may not ask for an unbounded number.
  if (asks.length > config.maxEventsPerCommand) return refuse(`That would change ${asks.length} events on the calendar at once. Timmy changes up to ${config.maxEventsPerCommand} at a time.`);

  let state = handled.state;
  const effects: EffectRow[] = [];
  let waitingOn = '';
  for (const ask of asks) {
    const p = await propose(tx, loaded, state, actor, ask.proposal);
    if (p.outcome === 'blocked' || !p.effect) return refuse(`${p.reason ?? 'That can’t be written to the calendar.'} The event was left as it is.`);
    state = p.state;
    effects.push(p.effect);
    if (p.outcome === 'waiting') {
      // Someone else has to say yes. Until they have, Timmy's calendar keeps showing what the real one holds.
      state = { ...state, ws: { ...state.ws, events: { ...state.ws.events, [ask.id]: ask.was } } };
      waitingOn = p.effect.approver_route !== 'exec' ? 'an approver' : actor.role.split(',').some((r) => r.trim() === 'assistant') ? 'the exec' : 'the person whose calendar this is';
    }
  }

  const seconds = config.sendHoldSeconds;
  const told = [...new Set(effects.flatMap((e) => e.preview.to ?? []))];
  const first = asks[0]!;
  const doing = asks.length > 1 ? `Changing ${asks.length} events on the calendar` : !first.removing ? `Changing “${first.was.title}” on the calendar` : told.length ? `Cancelling “${first.was.title}”` : `Deleting “${first.was.title}” from the calendar`;
  const text = waitingOn ? `Waiting for ${waitingOn} to OK this before the calendar is changed.` : `${doing} in ${seconds} seconds${told.length ? `; ${told.join(', ')} will be told` : ''}. Undo to stop it.`;
  return { ...handled, state, effects: [...(handled.effects ?? []), ...effects], toast: { text } };
}
