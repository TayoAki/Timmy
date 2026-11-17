/**
 * An event added in Timmy is created on the calendar when its undo window ends, or once whoever has to approve it
 * has. What is created is the approved payload, and that cannot change. So a change made to the event while its
 * create is still waiting would never reach the calendar, and the next read of the calendar would undo it on screen.
 *
 * The design: the change replaces the waiting create. In the same transaction as the person's command, the waiting
 * create is cancelled and a new create, with the event as it is now, is proposed in its place. The new one goes
 * through the gateway like the first (the same approval rules, a fresh undo window, invitations only once it runs),
 * and it names the create it replaces. This was chosen over queueing an update behind the create: an update needs
 * the calendar's own id, which does not exist until the create has run, and would be a second write and a second
 * message to every guest. Replacing the create keeps it one write, and the guests hear of the event once.
 *
 * The rules, and why:
 *   - A create that is already running cannot be replaced, so the change is refused, with a word to try again in a
 *     moment. The cancel and the claim that starts a create both need the record to be waiting; only one of them wins.
 *   - Deleting the event while its create waits cancels the create: nothing is written.
 *   - Undo of the change brings back the event as it was, and with it a create of that event (the one the change
 *     replaced can't be revived, so a new one is proposed, under the same rules).
 *   - Someone else's waiting create is only replaced by an owner or admin, as only they may undo someone else's send.
 *   - A change to what only Timmy keeps (the linked task, the kind) leaves the create as it is.
 */
import type { CommandResult } from '../../../src/live/types';
import type { Action, State } from '../../../src/state/store';
import { config } from '../config';
import type { Tx } from '../db/pool';
import { cancelHeld, propose, type EffectRow } from '../gateway/gateway';
import type { Actor } from '../gateway/policy';
import { eventProposal, type EventPayload } from '../sync/calendar-write';
import { isSynced } from '../sync/calendars';
import type { Loaded } from './docs';

/** The part of a command's outcome this step reads and adds to. */
interface Step {
  state: State;
  reject?: string;
  toast?: CommandResult['toast'];
  effects?: EffectRow[];
}

/** What a create writes to the calendar. Two payloads that agree on these create the same event. */
const written = (p: EventPayload) => JSON.stringify([p.title, new Date(p.start).getTime(), new Date(p.end).getTime(), [...p.attendees].sort(), p.note ?? '']);

/** What the cancelled create's record says, for whoever reads the history. */
const REPLACED = 'Replaced by a change made to the event before it was added';
const DELETED = 'The event was deleted in Timmy before it was added';

/**
 * The command an action takes back, if it is an Undo: the Undo on a notice names it, and Undo on a waiting row in
 * Approvals names the effect, which carries the command that made it (the engine undoes that command).
 */
async function undoneBy(tx: Tx, workspaceId: string, a: Action): Promise<string | null> {
  if (a.type === 'undo') return a.command;
  const effectId = a.type === 'effect' && !a.approve ? a.id : a.type === 'resolve' && a.key.startsWith('eff:') && a.option !== 'approve' && a.option !== 'send' ? a.key.slice(4) : null;
  if (!effectId) return null;
  return ((await tx.query(`select command_id from effect where id = $1 and workspace_id = $2 and source = 'user'`, [effectId, workspaceId])).rows[0]?.command_id as string | null | undefined) ?? null;
}

export async function followWaitingCreates<H extends Step>(tx: Tx, loaded: Loaded, actor: Actor, cmd: { id: string; action: Action }, handled: H, emailOf: (personId: string) => string | null): Promise<H> {
  const prev = loaded.state.ws.events;
  const next = handled.state.ws.events;
  if (prev === next) return handled;
  // Only events made in Timmy that this command changed or removed. A new one is proposed by the engine's addEvents,
  // and one already on the calendar is written by event-changes.ts.
  const touched = Object.keys(prev).filter((id) => !isSynced(id) && prev[id] !== next[id]);
  if (!touched.length) return handled;
  const workspaceId = loaded.workspace.id;
  const refuse = (reject: string): H => ({ ...handled, state: loaded.state, reject });
  const undone = await undoneBy(tx, workspaceId, cmd.action);

  let state = handled.state;
  const effects = [...(handled.effects ?? [])];
  let proposed = 0;
  let restored: { title: string; effect: EffectRow } | null = null;
  /** Cancels a waiting create in this command's transaction. False when it has already started. */
  const cancel = async (e: EffectRow, why: string) => {
    const r = await cancelHeld(tx, loaded, state, actor, e.id);
    if (!r.cancelled) return false;
    state = r.state;
    await tx.query(`update effect set error = $3 where id = $1 and workspace_id = $2 and status = 'cancelled'`, [e.id, workspaceId, why]);
    return true;
  };

  for (const id of touched) {
    const creates = (await tx.query(`select * from effect where workspace_id = $1 and kind = 'calendar.create' and payload->>'eventId' = $2 order by created_at desc, id desc`, [workspaceId, id])).rows as EffectRow[];
    // Never on its way to a calendar (none is connected, or sending was off): the change stays in Timmy, as before.
    if (!creates.length) continue;
    const title = prev[id]!.title;
    const now = next[id];
    const running = `“${title}” is being added to the calendar right now. ${now ? 'Change' : 'Delete'} it again in a moment.`;
    if (creates.some((c) => c.status === 'executing')) return refuse(running);
    const waiting = creates.find((c) => c.status === 'intended' || c.status === 'approved');
    const newest = creates[0]!;

    const notYours = !!waiting && !actor.rules.policy && waiting.requested_by !== actor.userId && waiting.approved_by !== actor.userId;
    const othersWord = `“${title}” is waiting to be added to the calendar by someone else. ${now ? 'Change' : 'Delete'} it once it is there.`;

    let replaces: EffectRow;
    if (waiting) {
      // Deleted while it waited: the create is cancelled, nothing is written, and nothing takes its place.
      if (!now) {
        if (notYours) return refuse(othersWord);
        if (!(await cancel(waiting, DELETED))) return refuse(running);
        continue;
      }
      replaces = waiting;
    } else if (undone && now && newest.command_id === undone && newest.status === 'cancelled' && (newest.payload as unknown as EventPayload).replaces) {
      // Undo of a change that had replaced a waiting create: the Undo has just cancelled the replacement, and the event
      // is back as it was. Its create is owed again, as a new record under the same rules.
      replaces = newest;
    } else continue;

    const conn = (await tx.query(`select id, toolkit from connection where id = $1 and workspace_id = $2 and status = 'active'`, [(replaces.payload as unknown as EventPayload).connectionId, workspaceId])).rows[0] as { id: string; toolkit: string } | undefined;
    // The calendar has been disconnected: a waiting create fails on its own, and there is nowhere to send a new one.
    if (!conn) continue;
    const made = eventProposal(now, conn, emailOf, loaded.workspace.timezone);
    if (!made.ok) return refuse(made.reason);
    if (waiting) {
      // Only something Timmy alone keeps changed (the linked task, the kind): the waiting create already holds what the calendar is to get.
      if (written(made.proposal.payload as unknown as EventPayload) === written(waiting.payload as unknown as EventPayload)) continue;
      if (notYours) return refuse(othersWord);
      if (!(await cancel(waiting, REPLACED))) return refuse(running);
    }
    // Each one is a write to the calendar, and with guests an invitation. One command may not ask for an unbounded number.
    if (++proposed > config.maxEventsPerCommand) return refuse(`That would change ${touched.length} events on their way to the calendar at once. Timmy changes up to ${config.maxEventsPerCommand} at a time.`);
    const p = await propose(tx, loaded, state, actor, {
      ...made.proposal,
      payload: { ...made.proposal.payload, replaces: replaces.id },
      why: undone ? 'You undid a change to it before it was added.' : 'You changed it in Timmy before it was added.',
      idempotencyKey: `cmd:${cmd.id}:event-again:${id}`,
      source: 'user',
      commandId: cmd.id,
    });
    // Refused at the gateway (sending was switched off since): the event stays on Timmy's calendar only, as a new one would.
    if (p.outcome === 'blocked' || !p.effect) continue;
    state = p.state;
    effects.push(p.effect);
    if (undone) restored = { title: now.title, effect: p.effect };
  }

  if (state === handled.state) return handled;
  // Undo said nothing was sent, which stays true; the event is on its way to the calendar again, and the person is told.
  const toast = restored ? { text: restored.effect.status === 'approved' ? `Undone. “${restored.title}” is added to the calendar as it was, in ${config.sendHoldSeconds} seconds.` : `Undone. “${restored.title}” waits for approval again, as it was.` } : handled.toast;
  return { ...handled, state, effects, ...(toast ? { toast } : {}) };
}
