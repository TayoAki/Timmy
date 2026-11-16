/**
 * The Action gateway: the only way anything leaves a workspace.
 *
 * A write is proposed as an effect record. The gateway decides whether it is
 * allowed at all, who has to approve it, and when it runs. Executors are called
 * from one place (`executeEffect`), and only for a record that is `approved`.
 * The effect table's trigger enforces the same order in the database.
 */
import type { State } from '../../../src/state/store';
import type { PendingEffect } from '../../../src/live/types';
import { config } from '../config';
import { withWorkspace, type Tx } from '../db/pool';
import { hashOf, newId } from '../lib/ids';
import { log } from '../lib/log';
import { commitState, loadState, remember, type Loaded } from '../state/docs';
import { EXECUTORS, reconcile } from './executors';
import { KINDS, approverFor, mayDecide, neverAllowed, reachesSomeoneElse, ruleCovers, type Actor, type EffectKind, type PolicyRow, type Route } from './policy';

export interface EffectRow {
  id: string;
  workspace_id: string;
  kind: EffectKind;
  payload: Record<string, unknown>;
  payload_hash: string;
  preview: PendingEffect['preview'] & { title?: string; why?: string; thread?: string; conversation?: string; replay?: unknown };
  target: string | null;
  idempotency_key: string;
  status: 'intended' | 'approved' | 'executing' | 'completed' | 'uncertain' | 'failed' | 'declined' | 'cancelled';
  source: 'user' | 'agent' | 'rule' | 'routine';
  run_id: string | null;
  command_id: string | null;
  requested_by: string;
  on_behalf_of: string | null;
  approver_route: Route;
  approved_by: string | null;
  approved_via: 'click' | 'rule' | 'auto' | null;
  policy_id: string | null;
  hold_until: Date | null;
  executing_at: Date | null;
  result: Record<string, unknown> | null;
  error: string | null;
  external_id: string | null;
  created_at: Date;
}

export interface Proposal {
  kind: string;
  /** Exactly what the executor will be given. It cannot change after this. */
  payload: Record<string, unknown>;
  /** What the approver is shown. */
  preview: PendingEffect['preview'];
  title: string;
  why: string;
  target?: string;
  /** The same key always returns the same record, so a retry never makes a second one. */
  idempotencyKey: string;
  source: EffectRow['source'];
  runId?: string;
  commandId?: string;
  thread?: string;
  conversation?: string;
  /** The person's own action, kept so it can be applied to the screen once someone else has approved the send. */
  replay?: unknown;
  onBehalfOf?: string;
  /** Fields a rule's scope is matched against. */
  meta?: Record<string, unknown>;
  /** Auto mode's verdict, when the judge was asked. Only honoured where Auto mode is allowed to decide. */
  auto?: { verdict: 'approve' | 'ask'; reason: string };
}

export interface Proposed {
  effect: EffectRow | null;
  outcome: 'approved' | 'waiting' | 'blocked';
  reason?: string;
  state: State;
}

export interface AuditEntry {
  actor: string;
  onBehalfOf?: string | null;
  action: string;
  effectId?: string | null;
  runId?: string | null;
  detail?: Record<string, unknown>;
}

export async function audit(tx: Tx, workspaceId: string, e: AuditEntry) {
  await tx.query('insert into audit_log (workspace_id, actor, on_behalf_of, action, effect_id, run_id, detail) values ($1, $2, $3, $4, $5, $6, $7::jsonb)', [
    workspaceId,
    e.actor,
    e.onBehalfOf ?? null,
    e.action,
    e.effectId ?? null,
    e.runId ?? null,
    JSON.stringify(e.detail ?? {}),
  ]);
}

/** Called after an effect reaches a final state, so a run waiting on it can continue. */
let settled: (effect: EffectRow) => void = () => {};
export const onEffectSettled = (fn: (effect: EffectRow) => void) => {
  settled = fn;
};
/** Applies a reducer action to a state. Set by the command engine, which owns the reducer. */
let replay: (loaded: Loaded, state: State, action: unknown) => State | undefined = () => undefined;
export const onReplay = (fn: typeof replay) => {
  replay = fn;
};

/** Called when an effect is approved, so it can be scheduled for the end of its hold. */
let approvedHook: (effect: EffectRow) => void = () => {};
export const onEffectApproved = (fn: (effect: EffectRow) => void) => {
  approvedHook = fn;
};

/* ───────────── The queue the screens show ───────────── */

function pendingOf(e: EffectRow): PendingEffect {
  const domain = KINDS[e.kind].domain;
  return {
    id: e.id,
    kind: domain === 'mail' ? (e.kind === 'cold_email.send' ? 'campaign' : 'email') : domain,
    title: e.preview.title ?? KINDS[e.kind].label,
    why: e.preview.why ?? '',
    preview: { from: e.preview.from, to: e.preview.to, cc: e.preview.cc, subject: e.preview.subject, body: e.preview.body, lines: e.preview.lines },
    waitingOn: e.approver_route === 'user' ? 'you' : e.approver_route,
    status: e.status === 'approved' ? 'holding' : 'waiting',
    sendsAt: e.status === 'approved' && e.hold_until ? new Date(e.hold_until) : undefined,
    thread: e.preview.thread,
    conversation: e.preview.conversation,
    at: new Date(e.created_at),
  };
}

function withPending(state: State, e: EffectRow): State {
  const show = e.status === 'intended' || (e.status === 'approved' && !!e.hold_until);
  const rest = state.pending.filter((p) => p.id !== e.id);
  return { ...state, pending: show ? [pendingOf(e), ...rest] : rest };
}

/* ───────────── Propose ───────────── */

/**
 * Records an intended write and decides what happens to it. Runs inside the
 * caller's workspace transaction; the caller commits the returned state.
 * `actor` is the signed-in person, or null when nobody is at the keyboard.
 */
export async function propose(tx: Tx, loaded: Loaded, state: State, actor: Actor | null, p: Proposal): Promise<Proposed> {
  const workspaceId = loaded.workspace.id;
  const who = actor?.userId ?? (p.source === 'agent' ? 'agent' : 'system');

  const existing = await tx.query('select * from effect where workspace_id = $1 and idempotency_key = $2', [workspaceId, p.idempotencyKey]);
  if (existing.rows[0]) {
    const e = existing.rows[0] as EffectRow;
    return { effect: e, outcome: e.status === 'intended' ? 'waiting' : 'approved', state: withPending(state, e) };
  }

  const refuse = async (reason: string): Promise<Proposed> => {
    await audit(tx, workspaceId, { actor: who, action: 'effect.blocked', runId: p.runId, detail: { kind: p.kind, target: p.target, reason } });
    return { effect: null, outcome: 'blocked', reason, state };
  };
  const never = neverAllowed(p.kind, p.payload);
  if (never) return refuse(never);
  if (loaded.workspace.kill_switch) return refuse('Sending is switched off for this workspace.');
  if (actor && !actor.rules.work) return refuse('Your role can’t make changes in this workspace.');
  const kind = p.kind as EffectKind;
  const k = KINDS[kind];

  // Who has to say yes?
  let route: Route = 'user';
  let approval: { by: string; via: 'click' | 'rule' | 'auto'; policyId?: string } | null = null;
  const rule = await matchingRule(tx, workspaceId, kind, p.meta);

  if (p.source === 'user') {
    // A person pressed the button on the exact preview. That is the approval, if it is theirs to give.
    if (!actor) return refuse('A person has to press Send.');
    const a = approverFor(kind, actor, { approver: state.conn.crm.approver });
    route = a.route;
    if (a.self) approval = { by: actor.userId, via: 'click' };
  } else if (rule) {
    // A rule a person wrote covers this. It is the only way an unattended run sends.
    approval = { by: `rule:${rule.id}`, via: 'rule', policyId: rule.id };
  } else if (p.source === 'agent' && actor) {
    const a = approverFor(kind, actor, { approver: state.conn.crm.approver });
    route = a.route;
    const autoAllowed = loaded.workspace.approval_mode === 'auto' && k.autoEligible && !reachesSomeoneElse(kind, p.payload) && a.self;
    if (autoAllowed && p.auto?.verdict === 'approve') approval = { by: 'auto', via: 'auto' };
  }
  // Everything else (an unattended run with no rule, a delegate's send, a member's CRM write) waits for a person.

  const id = newId('eff');
  const holdUntil = approval && k.hold ? new Date(Date.now() + config.sendHoldSeconds * 1000) : null;
  const preview = { ...p.preview, title: p.title, why: p.why, thread: p.thread, conversation: p.conversation, ...(p.replay ? { replay: p.replay } : {}) };
  const { rows } = await tx.query(
    `insert into effect (id, workspace_id, kind, payload, payload_hash, preview, target, idempotency_key, status, source, run_id, command_id,
                         requested_by, on_behalf_of, approver_route, approved_by, approved_via, policy_id, approved_at, hold_until)
     values ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     returning *`,
    [
      id,
      workspaceId,
      kind,
      JSON.stringify(p.payload),
      hashOf(p.payload),
      JSON.stringify(preview),
      p.target ?? null,
      p.idempotencyKey,
      approval ? 'approved' : 'intended',
      p.source,
      p.runId ?? null,
      p.commandId ?? null,
      who,
      p.onBehalfOf ?? null,
      route,
      approval?.by ?? null,
      approval?.via ?? null,
      approval?.policyId ?? null,
      approval ? new Date() : null,
      holdUntil,
    ],
  );
  const effect = rows[0] as EffectRow;
  await audit(tx, workspaceId, { actor: who, onBehalfOf: p.onBehalfOf, action: 'effect.proposed', effectId: id, runId: p.runId, detail: { kind, target: p.target, source: p.source, route } });
  if (approval) {
    await tx.query('insert into approval (workspace_id, effect_id, decision, decided_by, via, note) values ($1, $2, $3, $4, $5, $6)', [workspaceId, id, 'approve', approval.by, approval.via, p.auto?.reason ?? null]);
    await audit(tx, workspaceId, { actor: approval.by, onBehalfOf: p.onBehalfOf, action: 'effect.approved', effectId: id, runId: p.runId, detail: { via: approval.via, holdUntil } });
    approvedHook(effect);
  }
  return { effect, outcome: approval ? 'approved' : 'waiting', state: withPending(state, effect) };
}

async function matchingRule(tx: Tx, workspaceId: string, kind: string, meta: Record<string, unknown> | undefined): Promise<PolicyRow | null> {
  const { rows } = await tx.query('select id, kind, scope, enabled from policy where workspace_id = $1 and kind = $2 and enabled', [workspaceId, kind]);
  return (rows as PolicyRow[]).find((r) => ruleCovers(r, kind, meta)) ?? null;
}

/* ───────────── Decide ───────────── */

export class GatewayError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** A person approves or turns down a waiting effect. */
export async function decide(tx: Tx, loaded: Loaded, state: State, actor: Actor, effectId: string, approve: boolean): Promise<{ effect: EffectRow; state: State }> {
  const workspaceId = loaded.workspace.id;
  const { rows } = await tx.query('select * from effect where id = $1 and workspace_id = $2 for update', [effectId, workspaceId]);
  const e = rows[0] as EffectRow | undefined;
  if (!e) throw new GatewayError('That request no longer exists.', 404);
  if (e.status !== 'intended') throw new GatewayError(alreadyDecided(e), 409);
  if (!mayDecide(e.approver_route, e.kind, actor, e)) throw new GatewayError('This one isn’t yours to approve.', 403);
  if (approve && loaded.workspace.kill_switch) throw new GatewayError('Sending is switched off for this workspace.', 409);

  const holdUntil = approve && KINDS[e.kind].hold ? new Date(Date.now() + config.sendHoldSeconds * 1000) : null;
  const next = await tx.query(
    approve
      ? `update effect set status = 'approved', approved_by = $2, approved_via = 'click', approved_at = now(), hold_until = $3 where id = $1 and status = 'intended' returning *`
      : `update effect set status = 'declined', error = $2 where id = $1 and status = 'intended' returning *`,
    approve ? [effectId, actor.userId, holdUntil] : [effectId, `Declined by ${actor.name}`],
  );
  const effect = next.rows[0] as EffectRow;
  await tx.query('insert into approval (workspace_id, effect_id, decision, decided_by, via) values ($1, $2, $3, $4, $5)', [workspaceId, effectId, approve ? 'approve' : 'decline', actor.userId, 'click']);
  await audit(tx, workspaceId, { actor: actor.userId, onBehalfOf: e.on_behalf_of, action: approve ? 'effect.approved' : 'effect.declined', effectId, runId: e.run_id, detail: { via: 'click', requestedBy: e.requested_by, holdUntil } });
  if (approve) approvedHook(effect);
  else settled(effect);
  return { effect, state: withPending(state, effect) };
}

/** What to tell someone who acts on a request that is no longer waiting. */
function alreadyDecided(e: EffectRow): string {
  switch (e.status) {
    case 'approved':
      return 'That was already approved. It goes out when its undo window ends.';
    case 'executing':
    case 'completed':
      return 'That was already sent.';
    case 'uncertain':
      return 'That was approved, but Timmy could not confirm it was sent. Check your Sent folder.';
    case 'declined':
      return 'That was already turned down. Nothing was sent.';
    case 'cancelled':
      return 'That was already undone. Nothing was sent.';
    default:
      return 'That could not be sent, and was not.';
  }
}

/** Undo during the hold: an approved effect that hasn't started is cancelled. Returns false when it already left. */
export async function cancelHeld(tx: Tx, loaded: Loaded, state: State, actor: Actor, effectId: string): Promise<{ cancelled: boolean; effect: EffectRow | null; state: State }> {
  const workspaceId = loaded.workspace.id;
  const { rows } = await tx.query(`update effect set status = 'cancelled', error = 'Undone before it was sent' where id = $1 and workspace_id = $2 and status in ('approved', 'intended') returning *`, [effectId, workspaceId]);
  const effect = rows[0] as EffectRow | undefined;
  if (!effect) {
    const cur = await tx.query('select * from effect where id = $1 and workspace_id = $2', [effectId, workspaceId]);
    return { cancelled: false, effect: (cur.rows[0] as EffectRow) ?? null, state };
  }
  await tx.query('insert into approval (workspace_id, effect_id, decision, decided_by, via) values ($1, $2, $3, $4, $5)', [workspaceId, effectId, 'undo', actor.userId, 'click']);
  await audit(tx, workspaceId, { actor: actor.userId, action: 'effect.cancelled', effectId, runId: effect.run_id, detail: { reason: 'undo' } });
  settled(effect);
  return { cancelled: true, effect, state: withPending(state, effect) };
}

/* ───────────── Execute ───────────── */

export type Outcome =
  | { status: 'completed'; result: Record<string, unknown>; externalId?: string }
  /** The provider refused before doing anything. Nothing left the workspace. */
  | { status: 'failed'; error: string }
  /** We don't know whether it happened (a timeout, a dropped connection). Never retried blindly. */
  | { status: 'uncertain'; error: string };

/**
 * Runs one approved effect whose hold has passed. The claim is a single
 * UPDATE that only one caller can win, so the same effect never runs twice.
 */
export async function executeEffect(workspaceId: string, effectId: string): Promise<EffectRow | null> {
  const claimed = await withWorkspace({ workspaceId }, async (tx) => {
    const ws = await tx.query('select kill_switch from workspace where id = $1', [workspaceId]);
    if (!ws.rows[0] || ws.rows[0].kill_switch) return null;
    const { rows } = await tx.query(
      `update effect set status = 'executing', executing_at = now(), attempt = attempt + 1
       where id = $1 and workspace_id = $2 and status = 'approved' and (hold_until is null or hold_until <= now())
       returning *`,
      [effectId, workspaceId],
    );
    const e = rows[0] as EffectRow | undefined;
    if (!e) return null;
    await audit(tx, workspaceId, { actor: 'system', action: 'effect.executing', effectId, runId: e.run_id, detail: { kind: e.kind, approvedBy: e.approved_by, via: e.approved_via } });
    return e;
  });
  if (!claimed) return null;

  // The provider call happens outside any transaction: the 'executing' mark is already durable.
  let outcome: Outcome;
  try {
    const run = EXECUTORS[claimed.kind];
    outcome = run ? await run(claimed) : { status: 'failed', error: `No executor for ${claimed.kind}` };
  } catch (err) {
    outcome = { status: 'uncertain', error: (err as Error).message };
  }
  return settle(workspaceId, claimed, outcome);
}

async function settle(workspaceId: string, claimed: EffectRow, outcome: Outcome): Promise<EffectRow> {
  let commit = null as Awaited<ReturnType<typeof commitState>>;
  const effect = await withWorkspace({ workspaceId, lock: true }, async (tx) => {
    const { rows } = await tx.query(
      `update effect set status = $2, result = $3::jsonb, error = $4, external_id = $5, completed_at = case when $2 = 'completed' then now() else null end
       where id = $1 and workspace_id = $6 and status in ('executing', 'uncertain') returning *`,
      [claimed.id, outcome.status, JSON.stringify(outcome.status === 'completed' ? outcome.result : {}), outcome.status === 'completed' ? null : outcome.error, outcome.status === 'completed' ? outcome.externalId ?? null : null, workspaceId],
    );
    const e = (rows[0] as EffectRow | undefined) ?? claimed;
    await audit(tx, workspaceId, { actor: 'system', action: `effect.${outcome.status}`, effectId: claimed.id, runId: claimed.run_id, detail: outcome.status === 'completed' ? { externalId: outcome.externalId } : { error: outcome.error } });
    const loaded = await loadState(tx, workspaceId);
    let state = withPending(loaded.state, e);
    state = afterEffect(loaded, state, e, outcome);
    commit = await commitState(tx, loaded, state, 'effect');
    return e;
  });
  if (commit) remember(commit.next);
  if (outcome.status !== 'uncertain') settled(effect);
  else log.warn('effect outcome unknown', { effectId: claimed.id, kind: claimed.kind });
  return effect;
}

/** What the screens show once a send has gone out, failed, or is unconfirmed. */
function afterEffect(loaded: Loaded, state0: State, e: EffectRow, outcome: Outcome): State {
  const threadId = e.preview.thread;
  if (!threadId) return state0;
  let state = state0;
  let local = e.payload.localMessageId as string | undefined;
  // A send that waited for someone else's OK was never applied to the screen. Now that it has gone out,
  // the person's original action is applied, so the thread shows it as sent and the draft is gone.
  if (outcome.status === 'completed' && e.preview.replay && !state.threads.find((t) => t.id === threadId)?.messages.some((m) => m.id === local)) {
    const before = new Set(state.threads.flatMap((t) => t.messages.map((m) => m.id)));
    const next = replay(loaded, state, e.preview.replay);
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

/** Effects whose outcome is unknown are checked against the provider, never re-run. */
export async function reconcileEffect(workspaceId: string, effectId: string): Promise<EffectRow | null> {
  const e = await withWorkspace({ workspaceId }, async (tx) => ((await tx.query(`select * from effect where id = $1 and workspace_id = $2 and status = 'uncertain'`, [effectId, workspaceId])).rows[0] as EffectRow | undefined) ?? null);
  if (!e) return null;
  let outcome: Outcome;
  try {
    outcome = await reconcile(e);
  } catch (err) {
    log.warn('reconcile failed', { effectId, error: (err as Error).message });
    return e;
  }
  if (outcome.status === 'uncertain') return e;
  return settle(workspaceId, e, outcome);
}

/** Effects that are approved and past their hold, across workspaces. Ids only. */
export async function dueEffects(sys: { query: Tx['query'] }, limit = 25): Promise<{ id: string; workspace_id: string }[]> {
  const { rows } = await sys.query(
    `select e.id, e.workspace_id from effect e join workspace w on w.id = e.workspace_id
     where e.status = 'approved' and (e.hold_until is null or e.hold_until <= now()) and not w.kill_switch
     order by e.approved_at limit $1`,
    [limit],
  );
  return rows as { id: string; workspace_id: string }[];
}

/**
 * An approval is for now, not for whenever sending is switched back on. Anything approved
 * that has sat unsent for a day (the kill switch was on, or the mailbox was gone) is cancelled.
 */
export async function expireStaleApprovals(sys: { query: Tx['query'] }): Promise<number> {
  const { rows } = await sys.query(`update effect set status = 'cancelled', error = 'Approved more than a day ago and never sent, so it was cancelled' where status = 'approved' and approved_at < now() - interval '24 hours' returning id, workspace_id, run_id`);
  for (const r of rows) await sys.query(`insert into audit_log (workspace_id, actor, action, effect_id, run_id, detail) values ($1, 'system', 'effect.cancelled', $2, $3, '{"reason":"expired"}'::jsonb)`, [r.workspace_id, r.id, r.run_id]);
  return rows.length;
}

/** Effects stuck in 'executing' (the process died mid-call) become 'uncertain', then get reconciled. */
export async function staleExecuting(sys: { query: Tx['query'] }, olderThanSeconds = 300): Promise<{ id: string; workspace_id: string }[]> {
  const { rows } = await sys.query(`update effect set status = 'uncertain', error = 'The process stopped before the outcome was recorded' where status = 'executing' and executing_at < now() - make_interval(secs => $1) returning id, workspace_id`, [olderThanSeconds]);
  return rows as { id: string; workspace_id: string }[];
}
