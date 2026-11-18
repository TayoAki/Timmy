/**
 * How effect records show on the screens. The gateway decides what happens to an effect; this module only works
 * out what the person sees because of it: the Approvals list while an effect waits or is held, and the thread or
 * the calendar once it has gone out, failed, or is unconfirmed. Nothing here writes outside the workspace.
 */
import type { State } from '../../../src/state/store';
import type { PendingEffect } from '../../../src/live/types';
import { automationCard } from '../automations/cards';
import type { Loaded } from '../state/docs';
import { afterEventChange, isEventChange } from '../sync/calendar-change';
import type { EffectRow, Outcome } from './gateway';
import { replayAction } from './hooks';
import { KINDS } from './policy';

/* ───────────── The queue the screens show ───────────── */

function pendingOf(e: EffectRow): PendingEffect {
  const domain = KINDS[e.kind].domain;
  return {
    id: e.id,
    // A rule waiting to be saved is a yes-or-no that reaches nobody, like an automation's question.
    kind: e.kind === 'mail.modify' ? 'filing' : domain === 'mail' || domain === 'chat' ? 'email' : domain === 'rules' || domain === 'files' ? 'decision' : domain,
    title: e.preview.title ?? KINDS[e.kind].label,
    why: e.preview.why ?? '',
    preview: { from: e.preview.from, to: e.preview.to, cc: e.preview.cc, subject: e.preview.subject, body: e.preview.body, lines: e.preview.lines, ...(e.preview.attachments?.length ? { attachments: e.preview.attachments } : {}) },
    waitingOn: e.approver_route === 'user' ? 'you' : e.approver_route,
    status: e.status === 'approved' ? 'holding' : 'waiting',
    sendsAt: e.status === 'approved' && e.hold_until ? new Date(e.hold_until) : undefined,
    thread: e.preview.thread,
    conversation: e.preview.conversation,
    at: new Date(e.created_at),
    // [automations] Who may decide what an automation put forward, and the draft card its reply stands in for.
    ...automationCard(e),
  };
}

/** The Approvals list with this effect as it now stands: shown while it waits or is held, gone once it is neither. */
export function withPending(state: State, e: EffectRow): State {
  // A chat reply is never queued for a decision: it is approved as it is proposed, or not proposed at all.
  const show = KINDS[e.kind].domain !== 'chat' && (e.status === 'intended' || (e.status === 'approved' && !!e.hold_until));
  const rest = state.pending.filter((p) => p.id !== e.id);
  return { ...state, pending: show ? [pendingOf(e), ...rest] : rest };
}

/* ───────────── After an effect has run ───────────── */

/** What the screens show once a send has gone out, failed, or is unconfirmed. */
export function afterEffect(loaded: Loaded, state0: State, e: EffectRow, outcome: Outcome): State {
  // An automation's question changes nothing on the screens by being answered; its run carries on by itself.
  if (e.kind === 'automation.ask') return state0;
  // A sorting rule is saved by its executor, in the same transaction as the policy row behind it (sync/mail-rules.ts).
  if (e.kind === 'rule.save') return state0;
  // A file saved back to Drive shows in Timmy when the file list next hears from Drive.
  if (e.kind === 'file.update') return state0;
  // Filing that Timmy proposed (from the chat) moves the thread on the screens once the mailbox has it.
  // A move the person made themselves is already on the screens; it is what proposed the filing.
  if (e.kind === 'mail.modify') {
    const p = e.payload as { threadId?: string; box?: string };
    if (outcome.status !== 'completed' || e.source === 'user' || !p.threadId || !state0.threads.some((t) => t.id === p.threadId && t.box !== p.box)) return state0;
    const moved = replayAction(loaded, state0, { type: 'move', id: p.threadId, box: p.box, quiet: true, by: 'timmy' });
    return moved ? { ...moved, toasts: state0.toasts, route: state0.route } : state0;
  }
  // An event made in Timmy now exists on the calendar: the calendar's copy takes its place, under the id the
  // calendar sync uses, so the next sync updates it instead of adding a second one.
  if (e.kind === 'calendar.create') {
    const p = e.payload as { eventId?: string; connectionId?: string };
    const local = p.eventId ? state0.ws.events[p.eventId] : undefined;
    const id = outcome.status === 'completed' ? outcome.result.shown : undefined;
    if (!local || !p.eventId || typeof id !== 'string' || !id) return state0;
    const events = Object.fromEntries(Object.entries(state0.ws.events).filter(([k]) => k !== p.eventId));
    const tasks = Object.fromEntries(Object.entries(state0.ws.tasks).map(([k, t]) => [k, t.event === p.eventId ? { ...t, event: id } : t]));
    return { ...state0, ws: { ...state0.ws, events: { ...events, [id]: { ...local, id } }, tasks } };
  }
  // A change or a deletion the calendar has taken shows on Timmy's calendar. One it refused changes nothing here:
  // the calendar is read again after every such write, and that puts the screen right.
  if (isEventChange(e.kind)) return outcome.status === 'completed' ? afterEventChange(state0, e) : state0;
  const threadId = e.preview.thread;
  if (!threadId) return state0;
  let state = state0;
  let local = e.payload.localMessageId as string | undefined;
  // A send that waited for someone else's OK was never applied to the screen. Now that it has gone out,
  // the person's original action is applied, so the thread shows it as sent and the draft is gone.
  if (outcome.status === 'completed' && e.preview.replay && !state.threads.find((t) => t.id === threadId)?.messages.some((m) => m.id === local)) {
    const before = new Set(state.threads.flatMap((t) => t.messages.map((m) => m.id)));
    const next = replayAction(loaded, state, e.preview.replay);
    if (next) {
      state = { ...next, toasts: state.toasts, route: state.route };
      local = state.threads.find((t) => t.id === threadId)?.messages.find((m) => m.from === 'me' && !before.has(m.id))?.id ?? local;
    }
  }
  // A send Timmy prepared (from chat) has no message on the thread yet: add it, and drop a draft that would send the same thing again.
  if (outcome.status === 'completed' && !state.threads.find((t) => t.id === threadId)?.messages.some((m) => m.id === local || m.id === outcome.externalId)) {
    const p = e.payload as { to?: string[]; cc?: string[]; body?: string };
    const message = { id: outcome.externalId ?? `sent-${e.id}`, from: 'me', to: (p.to ?? []).map((x) => `mail:${x}`), ...(p.cc?.length ? { cc: p.cc.map((x) => `mail:${x}`) } : {}), at: new Date(), body: String(p.body ?? '').split(/\n\n+/) };
    local = message.id;
    state = { ...state, threads: state.threads.map((t) => (t.id === threadId ? { ...t, draft: undefined, unread: false, messages: [...t.messages, message], history: [...(t.history ?? []), { at: new Date(), text: 'Sent after approval' }] } : t)) };
  }
  return {
    ...state,
    threads: state.threads.map((t) => {
      if (t.id !== threadId) return t;
      const ext = { ...((t as { ext?: Record<string, unknown> }).ext ?? {}) };
      if (outcome.status === 'completed') {
        const threadKey = (outcome.result.threadId as string | undefined) ?? (ext.threadKey as string | undefined);
        return {
          ...t,
          // The message takes the provider's id, so the copy that arrives through sync is recognised as the same one.
          messages: t.messages.map((m) => (m.id === local && outcome.externalId ? { ...m, id: outcome.externalId } : m)),
          ext: { ...ext, threadKey, connectionId: e.payload.connectionId },
        } as typeof t;
      }
      const note = outcome.status === 'failed' ? `Not sent: ${outcome.error}` : 'Timmy couldn’t confirm this was sent. Check your Sent folder before sending it again.';
      return { ...t, history: [...(t.history ?? []), { at: new Date(), text: note }] };
    }),
  };
}
