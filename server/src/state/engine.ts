/**
 * The command engine. A command is one action from the frontend's reducer.
 * The server runs the same reducer on the workspace's stored state, saves the
 * difference, and tells every open tab what changed.
 *
 * The reducer was written for a demo where "send" only edits the screen. Here
 * an action that would put a message on the wire is first turned into an
 * effect record at the Action gateway. That check is made on the reducer's
 * result, not on the action's name, so a send can't slip through under a name
 * this file has never heard of.
 */
import { reducer, type Action, type State } from '../../../src/state/store';
import { PEOPLE, NOW, setUnknownPerson } from '../../../src/data/mock';
import { personFromMail } from '../../../src/state/ws';
import { enterLive } from '../../../src/live/clock';
import type { Patch } from '../../../src/live/patches';
import { applyPatches, fromWire } from '../../../src/live/patches';
import type { CommandResult } from '../../../src/live/types';
import type { Thread } from '../../../src/data/types';
import type { RoleRules } from '../auth/roles';
import { withWorkspace, type Tx } from '../db/pool';
import { cancelHeld, decide, GatewayError, onReplay, propose, type EffectRow } from '../gateway/gateway';
import { prepareMailSend } from '../gateway/mail';
import { draftHash } from '../../../src/live/hash';
import type { Actor } from '../gateway/policy';
import { config } from '../config';
import { enqueueSoon } from '../jobs/jobs';
import { modelReady } from '../providers/model';
import { commitState, loadState, remember, type Commit, type Loaded, type PreImage } from './docs';

enterLive();
// Someone the workspace only knows by address still has a name when the reducer asks.
setUnknownPerson((id) => personFromMail(id) ?? { id, name: id, email: '' });
// The reducer's name directory is shared module state. On the server it is filled
// for one workspace at a time, for the length of one reducer call.
for (const k of Object.keys(PEOPLE)) delete PEOPLE[k];

export interface Ctx {
  user: { id: string; name: string; email: string };
  workspaceId: string;
  role: string;
  rules: RoleRules;
}

export type { CommandResult };

interface Handled {
  state: State;
  reject?: string;
  toast?: CommandResult['toast'];
  redirect?: string;
  effects?: EffectRow[];
}

export const actorOf = (ctx: Ctx): Actor => ({ userId: ctx.user.id, name: ctx.user.name, role: ctx.role, rules: ctx.rules });

/* ───────────── Running the shared reducer ───────────── */

/** Fills the reducer's name directory for this workspace, runs `fn`, and empties it again. */
export function withGlobals<T>(loaded: Loaded, state: State, fn: () => T): T {
  const me = { id: 'me', name: loaded.workspace.owner_name ?? 'You', email: loaded.workspace.owner_email ?? '', company: loaded.workspace.name, internal: true };
  PEOPLE.me = me;
  for (const c of Object.values(state.ws.contacts)) PEOPLE[c.id] = { id: c.id, name: c.name, email: c.email, title: c.title, company: c.company };
  for (const l of Object.values(state.out.leads)) if (!PEOPLE[l.id]) PEOPLE[l.id] = { id: l.id, name: `${l.first} ${l.last}`, email: l.email, title: l.title, company: l.company };
  NOW.setTime(Date.now());
  try {
    return fn();
  } finally {
    for (const k of Object.keys(PEOPLE)) delete PEOPLE[k];
  }
}

export const reduce = (loaded: Loaded, state: State, action: Action): State => withGlobals(loaded, state, () => reducer(state, action));
// The gateway applies a held action to the screen once it has gone out; the reducer lives here.
onReplay((loaded, state, action) => reduce(loaded, state, action as Action));

/** The address behind a person id, or null when Timmy doesn't know one. */
export function emailOf(loaded: Loaded, state: State, id: string): string | null {
  if (id === 'me') return loaded.workspace.owner_email;
  if (id.startsWith('mail:')) return id.slice(5);
  return state.ws.contacts[id]?.email ?? state.out.leads[id]?.email ?? null;
}

/* ───────────── What the server refuses in live mode ───────────── */

const NOT_LIVE = 'That isn’t available on a real workspace yet.';

/** Actions that exist only to drive the demo. */
const DEMO_ONLY = new Set(['reset', 'simulateReply', 'client', 'release', 'restore', 'server']);

/** Outbound operations that would contact someone or pretend an account is connected. Each becomes real in the sales phase. */
const OUT_NOT_LIVE: Record<string, string> = {
  send: 'Texts and calls aren’t connected for real workspaces yet.',
  launch: 'A campaign can’t send by itself: Google doesn’t allow cold email through its API. Open each email in Gmail from the lead instead.',
  submit: NOT_LIVE,
  book: 'Booking a meeting from a lead isn’t switched on for real workspaces yet.',
  mailbox: 'Sending mailboxes are added by connecting them in Connections.',
  channel: 'Channels are connected in Connections.',
};

const CONN_POLICY_OPS = new Set(['crm', 'delegate', 'enrichPolicy']);

/** Actions that change how Timmy behaves for the whole workspace. */
const POLICY_ONLY = new Set(['addRule', 'toggleRule', 'setSchedule']);

/* ───────────── Commands ───────────── */

export async function runCommand(ctx: Ctx, cmd: { id: string; action: Action }): Promise<CommandResult> {
  if (!cmd.id || typeof cmd.id !== 'string' || cmd.id.length > 80) return { ok: false, rev: 0, patches: [], error: 'A command needs an id.' };
  let commit: Commit | null = null;
  const result = await withWorkspace({ workspaceId: ctx.workspaceId, userId: ctx.user.id, lock: true }, async (tx) => {
    // The same command id always gets the same answer: a retry never applies twice.
    const dup = (await tx.query('select result, user_id from command where workspace_id = $1 and id = $2', [ctx.workspaceId, cmd.id])).rows[0];
    // Only the person who sent it gets the recorded answer: one member can't collect another's by repeating their id.
    if (dup && dup.user_id !== ctx.user.id) return { ok: false, rev: 0, patches: [], error: 'That command id is already in use.' };
    if (dup) return dup.result as CommandResult;

    const loaded = await loadState(tx, ctx.workspaceId);
    let handled: Handled;
    // A refused command leaves nothing behind, including an effect proposed before the refusal.
    await tx.query('savepoint command');
    try {
      handled = await handle(tx, loaded, ctx, cmd);
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      handled = { state: loaded.state, reject: err.message };
    }
    if (handled.reject) await tx.query('rollback to savepoint command');
    commit = handled.reject ? null : await commitState(tx, loaded, handled.state, `cmd:${cmd.id}`);
    const out: CommandResult = {
      ok: !handled.reject,
      rev: commit?.rev ?? loaded.rev,
      patches: commit?.patches ?? [],
      ...(handled.reject ? { error: handled.reject, toast: { text: handled.reject, tone: 'warn' as const } } : {}),
      ...(handled.toast && !handled.reject ? { toast: handled.toast } : {}),
      ...(handled.redirect ? { redirect: handled.redirect } : {}),
      ...(handled.effects?.some((e) => e.status === 'approved' && e.hold_until) ? { holding: { effects: handled.effects.map((e) => e.id), seconds: config.sendHoldSeconds } } : {}),
    };
    await tx.query('insert into command (workspace_id, id, user_id, action, result, pre, rev) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)', [
      ctx.workspaceId,
      cmd.id,
      ctx.user.id,
      JSON.stringify(cmd.action).replace(/\\u0000/g, ''),
      JSON.stringify(out).replace(/\\u0000/g, ''),
      JSON.stringify(commit?.pre ?? []).replace(/\\u0000/g, ''),
      commit?.rev ?? null,
    ]);
    return out;
  });
  if (commit) remember((commit as Commit).next);
  return result;
}

async function handle(tx: Tx, loaded: Loaded, ctx: Ctx, cmd: { id: string; action: Action }): Promise<Handled> {
  const a = cmd.action;
  const state = loaded.state;
  if (!a || typeof a.type !== 'string') return { state, reject: 'That isn’t a command.' };
  if (DEMO_ONLY.has(a.type)) return { state, reject: NOT_LIVE };

  // Approving or declining is the one thing a read-only role (RevOps) may still do.
  const decision = decisionIn(a);
  if (decision) {
    if (!decision.approve) {
      // Turning down something already approved and still inside its undo window cancels it.
      const held = await cancelIfHolding(tx, loaded, ctx, decision.effectId);
      if (held) return held;
    }
    const d = await decide(tx, loaded, state, actorOf(ctx), decision.effectId, decision.approve);
    const approved = d.effect.hold_until ? `Approved. It goes out in ${config.sendHoldSeconds} seconds unless you undo it.` : 'Approved.';
    return { state: d.state, effects: [d.effect], toast: { text: decision.approve ? approved : 'Turned down. Nothing was sent.' } };
  }
  if (!ctx.rules.work) return { state, reject: 'Your role can’t make changes in this workspace.' };
  if (a.type === 'undo') return undo(tx, loaded, ctx, a.command);
  // Rules are instructions Timmy follows for everyone (writing rules go into every drafting prompt), and the schedule
  // decides when it works. Only an owner or admin changes them.
  if (POLICY_ONLY.has(a.type) && !ctx.rules.policy) return { state, reject: 'Only an owner or admin can change this.' };

  // A send names the draft the person was looking at. If someone, or Timmy, changed it since, they read it again first.
  if ((a.type === 'sendDraft' || a.type === 'runStep' || (a.type === 'resolve' && a.key.startsWith('draft:') && a.option === 'send')) && a.seen !== undefined) {
    const threadId = a.type === 'resolve' ? a.key.slice(6) : a.id;
    const draft = state.threads.find((t) => t.id === threadId)?.draft;
    if (draft && draftHash(draft) !== a.seen) return { state, reject: 'This draft changed after you opened it. Read it again, then send.' };
  }

  if (a.type === 'makeDraft') {
    // Drafting is a model call, so it runs as a job; the draft arrives on the stream when it is written.
    if (!modelReady()) return { state, reject: 'Timmy’s model isn’t configured on this server yet.' };
    if (!state.threads.some((t) => t.id === a.id)) return { state, reject: 'That thread is no longer here.' };
    enqueueSoon('draft.make', { workspaceId: ctx.workspaceId, threadId: a.id, note: a.note, userName: ctx.user.name }, { singletonKey: `draft:${ctx.workspaceId}:${a.id}` });
    return { state, toast: { text: 'Timmy is writing a draft. Nothing is sent until you press Send.' } };
  }
  if (a.type === 'conn') {
    if (CONN_POLICY_OPS.has(a.op.op)) {
      if (!ctx.rules.policy) return { state, reject: 'Only an owner or admin can change this.' };
      // On a real workspace, delegate mode is a role: the exec invites their assistant, and the server holds that person's sends.
      if (a.op.op === 'delegate' && a.op.patch.on) return { state, reject: 'To work with an assistant, invite them with the assistant role. Their sends then wait for your OK.' };
    } else if (a.op.op === 'enrich' || a.op.op === 'find') {
      return { state, reject: 'No enrichment provider is connected yet.' };
    } else {
      // connect, adminConsent, disconnect go through the Connections API, which talks to Composio.
      return { state, reject: 'Use the Connect button to change app connections.' };
    }
  }
  if (a.type === 'out' && a.op.op === 'send' && a.op.channel === 'email') {
    // Cold email is never sent through the provider's API. The browser opens the mail app's own compose
    // window and the person sends it there; all that happens here is a line in the activity log.
    // The lead is marked contacted later, when sync sees the email in the Sent folder.
    const lead = state.out.leads[a.op.lead];
    if (!lead) return { state, reject: 'That lead is no longer in the list.' };
    const logged = reduce(loaded, state, { type: 'ws', ops: [], log: `Opened an email to ${lead.first} ${lead.last} in Gmail to send by hand` });
    return { state: logged, toast: { text: 'Opened in Gmail. Send it from there; Timmy marks the lead as contacted when it sees the email in your Sent folder.' } };
  }
  if (a.type === 'out' && OUT_NOT_LIVE[a.op.op]) return { state, reject: OUT_NOT_LIVE[a.op.op] };
  if (a.type === 'resolve' && a.key.startsWith('camp:') && a.option === 'launch') return { state, reject: OUT_NOT_LIVE.launch };

  const next = reduce(loaded, state, a);
  // The reducer has no default case: an action it doesn't know returns nothing.
  if (!next) return { state, reject: 'That isn’t a command.' };
  return gateSends(tx, loaded, ctx, cmd, state, next);
}

/** The two ways the screen says yes or no to a waiting action: the Approvals row, and the card in the chat. */
function decisionIn(a: Action): { effectId: string; approve: boolean } | null {
  if (a.type === 'effect') return { effectId: a.id, approve: a.approve };
  if (a.type === 'resolve' && a.key.startsWith('eff:')) return { effectId: a.key.slice(4), approve: a.option === 'approve' || a.option === 'send' };
  return null;
}

/** Undo from the Approvals queue: stops an approved send that is still waiting out its hold. */
async function cancelIfHolding(tx: Tx, loaded: Loaded, ctx: Ctx, effectId: string): Promise<Handled | null> {
  const cur = (await tx.query('select status, requested_by, approved_by, command_id, source from effect where id = $1 and workspace_id = $2', [effectId, ctx.workspaceId])).rows[0];
  if (!cur || cur.status !== 'approved') return null;
  if (!ctx.rules.policy && cur.requested_by !== ctx.user.id && cur.approved_by !== ctx.user.id) throw new GatewayError('This one isn’t yours to undo.', 403);
  // A send the person started themselves is undone with the command that made it, so the thread goes back to a draft too.
  if (cur.command_id && cur.source === 'user') return undo(tx, loaded, ctx, cur.command_id as string, true);
  const r = await cancelHeld(tx, loaded, loaded.state, actorOf(ctx), effectId);
  if (!r.cancelled) return { state: loaded.state, reject: 'That was already sent, so it can’t be undone.' };
  return { state: r.state, toast: { text: 'Undone. Nothing was sent.' } };
}

/* ───────────── Sends ───────────── */

interface Outgoing {
  thread: Thread;
  before: Thread | undefined;
  message: Thread['messages'][number];
}

/** Messages from the user that exist after the reducer ran and did not before. Each one is an email to deliver. */
function newOutgoing(prev: State, next: State): Outgoing[] {
  if (prev.threads === next.threads) return [];
  const before = new Map(prev.threads.map((t) => [t.id, t]));
  const out: Outgoing[] = [];
  for (const t of next.threads) {
    const old = before.get(t.id);
    if (old === t) continue;
    const seen = new Set((old?.messages ?? []).map((m) => m.id));
    for (const m of t.messages) if (m.from === 'me' && !seen.has(m.id)) out.push({ thread: t, before: old, message: m });
  }
  return out;
}

async function gateSends(tx: Tx, loaded: Loaded, ctx: Ctx, cmd: { id: string; action: Action }, prev: State, next: State): Promise<Handled> {
  // Fail closed: nothing may appear in the outbound log from a command until the sending service owns it.
  const before = new Set(prev.out.messages.map((m) => m.id));
  if (next.out.messages.some((m) => !before.has(m.id) && m.dir === 'out' && m.channel !== 'call')) return { state: prev, reject: OUT_NOT_LIVE.send };

  const outgoing = newOutgoing(prev, next);
  if (!outgoing.length) return { state: next };
  if (!ctx.rules.work) return { state: prev, reject: 'Your role can’t send from this workspace.' };

  let state = next;
  const effects: EffectRow[] = [];
  for (const [i, o] of outgoing.entries()) {
    if (o.message.attachments?.length) return { state: prev, reject: 'Sending attachments isn’t available yet. Remove the attachment or send it from your mail app.' };
    // The screen names people by id; an id Timmy has no address for is passed on as it is, and refused as not an address.
    const address = (id: string) => emailOf(loaded, prev, id) ?? id;
    const mail = await prepareMailSend(tx, ctx.workspaceId, {
      to: o.message.to.map(address),
      cc: (o.message.cc ?? []).map(address),
      subject: o.before?.draft?.subject ?? o.thread.subject,
      body: o.message.body.join('\n\n'),
      threadId: o.thread.id,
      existing: o.before ? { threadKey: o.before.ext?.threadKey, connectionId: o.before.ext?.connectionId } : undefined,
      localMessageId: o.message.id,
    });
    if (!mail.ok) return { state: prev, reject: mail.reason };
    const p = await propose(tx, loaded, state, actorOf(ctx), {
      ...mail.proposal,
      why: 'You pressed Send.',
      idempotencyKey: `cmd:${cmd.id}:${i}`,
      source: 'user',
      commandId: cmd.id,
      // Kept so the thread can be shown as sent once someone else has approved it.
      replay: cmd.action,
    });
    if (p.outcome === 'blocked') return { state: prev, reject: p.reason };
    if (p.outcome === 'waiting') {
      // Someone else has to approve (a delegate's send goes to the exec). The screen keeps the draft and shows who it waits on.
      const waiting = { ...prev, pending: p.state.pending };
      const approver = p.effect!.approver_route !== 'exec' ? 'an approver' : ctx.role.split(',').some((r) => r.trim() === 'assistant') ? 'the exec' : 'the person whose mailbox this is';
      return { state: waiting, effects: [p.effect!], toast: { text: `Waiting for ${approver} to OK this before it goes out.` } };
    }
    state = p.state;
    effects.push(p.effect!);
  }
  return { state, effects, toast: { text: `Sending in ${config.sendHoldSeconds} seconds. Undo to stop it.` } };
}

/* ───────────── Undo ───────────── */

async function undo(tx: Tx, loaded: Loaded, ctx: Ctx, commandId: string, allowed = false): Promise<Handled> {
  const state = loaded.state;
  const { rows } = await tx.query('select id, user_id, pre, rev, undone_at from command where workspace_id = $1 and id = $2', [ctx.workspaceId, commandId]);
  const c = rows[0] as { id: string; user_id: string; pre: PreImage[]; rev: number | null; undone_at: Date | null } | undefined;
  if (!c || c.rev === null) return { state, reject: 'There’s nothing to undo.' };
  // People undo their own actions; an owner or admin may undo anyone's.
  if (!allowed && c.user_id !== ctx.user.id && !ctx.rules.policy) return { state, reject: 'That isn’t yours to undo.' };
  if (c.undone_at) return { state };

  // A send that already left can't be taken back; say so instead of pretending.
  const effects = (await tx.query('select * from effect where workspace_id = $1 and command_id = $2', [ctx.workspaceId, commandId])).rows as EffectRow[];
  if (effects.some((e) => ['executing', 'completed', 'uncertain'].includes(e.status))) return { state, reject: 'That was already sent, so it can’t be undone.' };
  let next = state;
  for (const e of effects) {
    const r = await cancelHeld(tx, loaded, next, actorOf(ctx), e.id);
    if (!r.cancelled && r.effect && ['executing', 'completed', 'uncertain'].includes(r.effect.status)) return { state, reject: 'That was already sent, so it can’t be undone.' };
    next = r.state;
  }

  // Put back each document the command changed, unless something newer has changed it since.
  const revs = await tx.query(`select slice, id, rev from state_doc where workspace_id = $1 and (slice, id) in (select * from unnest($2::text[], $3::text[]))`, [ctx.workspaceId, c.pre.map((p) => p.s), c.pre.map((p) => p.id)]);
  const current = new Map(revs.rows.map((r) => [`${r.slice}\u0000${r.id}`, r.rev as number]));
  const patches: Patch[] = [];
  let skipped = 0;
  for (const p of c.pre) {
    if (p.s === 'pending') continue;
    const rev = current.get(`${p.s}\u0000${p.id}`);
    if (rev !== undefined && rev > c.rev) {
      skipped++;
      continue;
    }
    if (p.id === '_') patches.push({ s: p.s, v: (fromWire(p.before ?? '{"v":null}') as { v: unknown }).v });
    else if (p.before === null) patches.push({ s: p.s, id: p.id, rm: true });
    else patches.push({ s: p.s, id: p.id, v: fromWire(p.before) });
  }
  next = applyPatches(next, patches);
  await tx.query('update command set undone_at = now() where workspace_id = $1 and id = $2', [ctx.workspaceId, commandId]);
  return { state: next, toast: { text: skipped ? 'Undone, except what has changed since.' : effects.length ? 'Undone. Nothing was sent.' : 'Undone.' } };
}
