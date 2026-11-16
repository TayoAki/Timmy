/**
 * The agent loop. One loop serves every kind of run.
 *
 * A run is a row with a lease and a fence. Whoever holds the lease drives the
 * run; the fence goes up on every claim, and every write the run makes checks
 * it, so a worker that was presumed dead cannot write after another took over.
 *
 * The transcript is checkpointed after each model answer and after each round
 * of tool results. When a tool proposes a write that needs approval, the run
 * stops with status `waiting_approval`. On resume the pending tool call is
 * answered from the effect record's stored outcome: the model is not asked
 * again, so exactly what was approved is what ran.
 */
import { MODEL_ALLOWLIST, modelFor } from '../config';
import { withWorkspace } from '../db/pool';
import type { EffectRow } from '../gateway/gateway';
import { KINDS, isKind } from '../gateway/policy';
import { newId } from '../lib/ids';
import { log } from '../lib/log';
import { BudgetError, complete, type ChatMessage, type Effort, type ToolCall, type ToolDef } from '../providers/model';
import type { Ctx } from '../state/engine';
import { judge } from './judge';
import { TOOLS, TOOL_BY_NAME, type ToolRun } from './tools';

const MAX_STEPS = 8;
const LEASE_SECONDS = 120;
const WORKER = `w_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

export interface RunEvents {
  step?(name: string, done: boolean): void;
  text?(turn: number, delta: string): void;
  /** A model turn ended. `display` are tool calls for the browser to draw. */
  turn?(turn: number, text: string, display: ToolCall[]): void;
  /** A write is waiting for the person's decision. */
  waiting?(effect: EffectRow): void;
}

export interface StartRun {
  kind: 'ask' | 'routine';
  attended: boolean;
  /** The chat conversation, when there is one. */
  threadId?: string;
  system: string;
  messages: ChatMessage[];
  /** Tools the browser draws itself (widgets). Their calls are passed to the browser, not run here. */
  displayTools?: ToolDef[];
  effort?: Effort;
}

export interface RunResult {
  runId: string;
  status: 'completed' | 'waiting_approval' | 'failed';
  text: string;
  error?: string;
}

class LostLease extends Error {}

interface Checkpoint {
  system: string;
  messages: ChatMessage[];
  displayTools: ToolDef[];
  /** Tool calls from the last assistant message that are waiting on an effect: call id → effect id. */
  pending: Record<string, string>;
  effort: Effort;
  userWords: string[];
}

async function saveCheckpoint(workspaceId: string, runId: string, fence: number, seq: number, cp: Checkpoint) {
  const ok = await withWorkspace({ workspaceId }, async (tx) => {
    const r = await tx.query(
      `insert into run_checkpoint (run_id, workspace_id, seq, fence, messages, pending)
       select $1, $2, $3, $4, $5::jsonb, $6::jsonb where exists (select 1 from run where id = $1 and workspace_id = $2 and fence = $4)
       on conflict (run_id, seq) do update set messages = excluded.messages, pending = excluded.pending, fence = excluded.fence`,
      [runId, workspaceId, seq, fence, JSON.stringify({ system: cp.system, messages: cp.messages, displayTools: cp.displayTools, effort: cp.effort, userWords: cp.userWords }).replace(/\\u0000/g, ''), JSON.stringify(cp.pending)],
    );
    return (r.rowCount ?? 0) > 0;
  });
  if (!ok) throw new LostLease();
}

/** Extends the lease. Fails when another worker has claimed the run since. */
async function renew(workspaceId: string, runId: string, fence: number, step: number, readOutside: boolean) {
  const ok = await withWorkspace({ workspaceId }, async (tx) => {
    const r = await tx.query(`update run set lease_until = now() + make_interval(secs => $4), step = $5, read_outside = read_outside or $6, updated_at = now() where id = $1 and workspace_id = $2 and fence = $3 and status = 'running'`, [runId, workspaceId, fence, LEASE_SECONDS, step, readOutside]);
    return (r.rowCount ?? 0) > 0;
  });
  if (!ok) throw new LostLease();
}

async function finish(workspaceId: string, runId: string, fence: number, status: 'completed' | 'failed' | 'waiting_approval', fields: { text?: string; error?: string; waiting?: string }) {
  await withWorkspace({ workspaceId }, (tx) =>
    tx.query(
      `update run set status = $4, lease_owner = null, lease_until = null, result = $5::jsonb, error = $6, waiting_effect_id = $7,
                      finished_at = case when $4 = 'waiting_approval' then null else now() end, updated_at = now()
       where id = $1 and workspace_id = $2 and fence = $3`,
      [runId, workspaceId, fence, status, JSON.stringify({ text: fields.text ?? '' }), fields.error ?? null, fields.waiting ?? null],
    ),
  );
}

/** Starts a run right away, in this process. The queue is only the crash backup. */
export async function startRun(ctx: Ctx, input: StartRun, events: RunEvents = {}): Promise<RunResult> {
  const runId = newId('run');
  const { model, busy, cap } = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => {
    const ws = (await tx.query('select model_id, max_concurrent_runs from workspace where id = $1', [ctx.workspaceId])).rows[0];
    const running = (await tx.query(`select count(*)::int as n from run where workspace_id = $1 and status = 'running' and lease_until > now()`, [ctx.workspaceId])).rows[0].n as number;
    const chosen = modelFor(ws?.model_id);
    if (running < (ws?.max_concurrent_runs ?? 2)) {
      await tx.query(
        `insert into run (id, workspace_id, user_id, kind, attended, status, thread_id, input, model, effort, lease_owner, lease_until, fence, started_at)
         values ($1, $2, $3, $4, $5, 'running', $6, $7::jsonb, $8, $9, $10, now() + make_interval(secs => $11), 1, now())`,
        [runId, ctx.workspaceId, ctx.user.id, input.kind, input.attended, input.threadId ?? null, JSON.stringify({ messages: input.messages.length }), chosen, input.effort ?? 'low', WORKER, LEASE_SECONDS],
      );
    }
    return { model: chosen, busy: running, cap: (ws?.max_concurrent_runs ?? 2) as number };
  });
  if (busy >= cap) return { runId, status: 'failed', text: '', error: `Timmy is already working on ${busy} thing${busy === 1 ? '' : 's'} for this workspace. Try again when one finishes.` };
  if (!MODEL_ALLOWLIST.some((m) => m.id === model) && model !== modelFor(null)) return { runId, status: 'failed', text: '', error: 'This workspace’s model isn’t available.' };

  const cp: Checkpoint = {
    system: input.system,
    messages: input.messages,
    displayTools: input.displayTools ?? [],
    pending: {},
    effort: input.effort ?? 'low',
    userWords: input.messages.filter((m) => m.role === 'user').map((m) => m.content),
  };
  return drive(ctx, { runId, fence: 1, model, attended: input.attended, threadId: input.threadId, kind: input.kind }, cp, 0, events);
}

interface Driving {
  runId: string;
  fence: number;
  model: string;
  attended: boolean;
  threadId?: string;
  kind: string;
}

async function drive(ctx: Ctx, run: Driving, cp: Checkpoint, fromStep: number, events: RunEvents): Promise<RunResult> {
  const workspaceId = ctx.workspaceId;
  let readOutside = false;
  let lastText = '';
  try {
    for (let step = fromStep; step < MAX_STEPS; step++) {
      await renew(workspaceId, run.runId, run.fence, step, readOutside);
      const tools = [...TOOLS.map((t) => t.def), ...cp.displayTools.filter((d) => !TOOL_BY_NAME[d.name])];
      const res = await complete({ workspaceId, runId: run.runId, route: run.kind, model: run.model, effort: cp.effort, messages: [{ role: 'system', content: cp.system }, ...cp.messages], tools }, (delta) => events.text?.(step, delta));
      lastText = res.content || lastText;
      const assistant: ChatMessage = { role: 'assistant', content: res.content, toolCalls: res.toolCalls, reasoningDetails: res.reasoningDetails };
      cp.messages = [...cp.messages, assistant];
      await saveCheckpoint(workspaceId, run.runId, run.fence, step * 2, cp);

      const display = res.toolCalls.filter((c) => !TOOL_BY_NAME[c.name]);
      events.turn?.(step, res.content, display);
      if (!res.toolCalls.length) {
        await finish(workspaceId, run.runId, run.fence, 'completed', { text: res.content });
        return { runId: run.runId, status: 'completed', text: res.content };
      }

      const waiting = await runTools(ctx, run, cp, res.toolCalls, events, (outside) => (readOutside = readOutside || outside));
      await saveCheckpoint(workspaceId, run.runId, run.fence, step * 2 + 1, cp);
      if (waiting) {
        await renew(workspaceId, run.runId, run.fence, step, readOutside);
        await finish(workspaceId, run.runId, run.fence, 'waiting_approval', { text: lastText, waiting: waiting.id });
        return { runId: run.runId, status: 'waiting_approval', text: lastText };
      }
      // A turn made only of widgets is the end of the answer: the browser has what it needs.
      if (display.length === res.toolCalls.length) {
        await finish(workspaceId, run.runId, run.fence, 'completed', { text: res.content });
        return { runId: run.runId, status: 'completed', text: res.content };
      }
    }
    await finish(workspaceId, run.runId, run.fence, 'completed', { text: lastText });
    return { runId: run.runId, status: 'completed', text: lastText };
  } catch (e) {
    if (e instanceof LostLease) {
      log.warn('run lost its lease', { runId: run.runId });
      return { runId: run.runId, status: 'failed', text: lastText, error: 'Another worker took over this job.' };
    }
    const message = e instanceof BudgetError ? e.message : 'Timmy hit a problem and stopped. Nothing was sent.';
    log.error('run failed', { runId: run.runId, error: (e as Error).message });
    await finish(workspaceId, run.runId, run.fence, 'failed', { text: lastText, error: (e as Error).message.slice(0, 500) }).catch(() => {});
    return { runId: run.runId, status: 'failed', text: lastText, error: message };
  }
}

/** Runs one assistant turn's tool calls. Returns an effect when the run must wait for it. */
async function runTools(ctx: Ctx, run: Driving, cp: Checkpoint, calls: ToolCall[], events: RunEvents, sawOutside: (outside: boolean) => void): Promise<EffectRow | null> {
  let waiting: EffectRow | null = null;
  const answered = new Set(cp.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId));
  for (const call of calls) {
    if (answered.has(call.id) || cp.pending[call.id]) continue;
    const tool = TOOL_BY_NAME[call.name];
    if (!tool) {
      // A widget: the browser draws it. The model is told it was shown.
      cp.messages = [...cp.messages, { role: 'tool', toolCallId: call.id, content: 'Shown to the user.' }];
      continue;
    }
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
    } catch {
      cp.messages = [...cp.messages, { role: 'tool', toolCallId: call.id, content: 'The arguments were not valid JSON.' }];
      continue;
    }
    events.step?.(tool.step, false);
    const t: ToolRun = { ctx, runId: run.runId, fence: run.fence, callId: call.id, conversation: run.threadId, attended: run.attended };
    if (tool.kind === 'write' && run.attended && tool.effectKind && isKind(tool.effectKind) && KINDS[tool.effectKind].autoEligible) {
      // Auto mode: the judge sees the user's own words and a description built from the action's kind, nothing fetched.
      const ws = await withWorkspace({ workspaceId: ctx.workspaceId }, async (tx) => (await tx.query('select approval_mode, (select read_outside from run where id = $2) as read_outside from workspace where id = $1', [ctx.workspaceId, run.runId])).rows[0]);
      if (ws?.approval_mode === 'auto') t.auto = await judge({ workspaceId: ctx.workspaceId, runId: run.runId, kind: tool.effectKind, payload: {}, action: KINDS[tool.effectKind].label, userWords: cp.userWords, readOutside: !!ws.read_outside });
    }
    let out;
    try {
      out = await tool.run(args, t);
    } catch (e) {
      if ((e as Error).message.includes('taken over')) throw new LostLease();
      log.warn('tool failed', { tool: call.name, error: (e as Error).message });
      out = { result: 'That tool failed. Tell the user it didn’t work; do not guess the answer.' };
    }
    events.step?.(tool.step, true);
    if ('outside' in out && out.outside) sawOutside(true);
    if ('blocked' in out) {
      cp.messages = [...cp.messages, { role: 'tool', toolCallId: call.id, content: `Refused: ${out.blocked} Do not try another way.` }];
    } else if ('effect' in out) {
      cp.pending = { ...cp.pending, [call.id]: out.effect.id };
      waiting = waiting ?? out.effect;
      events.waiting?.(out.effect);
    } else {
      cp.messages = [...cp.messages, { role: 'tool', toolCallId: call.id, content: out.result }];
    }
  }
  return waiting;
}

/** What the model is told about a write once it has been decided. */
function effectAnswer(e: EffectRow): string | null {
  switch (e.status) {
    case 'completed':
      return 'It was approved and has been sent.';
    case 'declined':
      return 'The user turned this down. It was not sent. Do not send it again unless they ask.';
    case 'cancelled':
      return 'The user undid this before it went out. It was not sent.';
    case 'failed':
      return `It was approved but could not be sent: ${e.error ?? 'unknown error'}. It was not sent.`;
    case 'uncertain':
      return 'It was approved, but Timmy could not confirm it was sent. Tell the user to check their Sent folder.';
    default:
      return null;
  }
}

/**
 * Continues a run that was waiting on an approval, or that a dead worker left
 * behind. Claims the lease first; if someone else holds it, does nothing.
 */
export async function resumeRun(workspaceId: string, runId: string, events: RunEvents = {}): Promise<RunResult | null> {
  const claimed = await withWorkspace({ workspaceId }, async (tx) => {
    const { rows } = await tx.query(
      `update run set status = 'running', lease_owner = $3, lease_until = now() + make_interval(secs => $4), fence = fence + 1, updated_at = now()
       where id = $1 and workspace_id = $2 and (status in ('queued', 'waiting_approval') or (status = 'running' and lease_until < now()))
       returning id, fence, model, attended, thread_id, kind, user_id, step`,
      [runId, workspaceId, WORKER, LEASE_SECONDS],
    );
    if (!rows[0]) return null;
    const cp = (await tx.query('select seq, messages, pending from run_checkpoint where run_id = $1 and workspace_id = $2 order by seq desc limit 1', [runId, workspaceId])).rows[0];
    const pending = cp ? ((cp.pending ?? {}) as Record<string, string>) : {};
    const effects = Object.values(pending).length ? ((await tx.query('select * from effect where workspace_id = $1 and id = any($2::text[])', [workspaceId, Object.values(pending)])).rows as EffectRow[]) : [];
    return { run: rows[0], cp, pending, effects };
  });
  if (!claimed) return null;
  const { run, cp } = claimed;
  const fence = run.fence as number;
  if (!cp) {
    await finish(workspaceId, runId, fence, 'failed', { error: 'No checkpoint to resume from.' });
    return { runId, status: 'failed', text: '', error: 'This job could not be resumed.' };
  }
  const saved = cp.messages as Omit<Checkpoint, 'pending'>;
  const state: Checkpoint = { ...saved, pending: { ...claimed.pending } };

  // Answer each pending tool call from its effect record. Any still undecided keeps the run waiting.
  let undecided: EffectRow | null = null;
  for (const [callId, effectId] of Object.entries(claimed.pending)) {
    const e = claimed.effects.find((x) => x.id === effectId);
    const answer = e ? effectAnswer(e) : 'That request no longer exists.';
    if (answer === null) {
      undecided = undecided ?? e ?? null;
      continue;
    }
    state.messages = [...state.messages, { role: 'tool', toolCallId: callId, content: answer }];
    delete state.pending[callId];
  }
  const ctx = await ctxForRun(workspaceId, run.user_id as string | null);
  if (undecided || !ctx) {
    await withWorkspace({ workspaceId }, (tx) => tx.query(`update run set status = 'waiting_approval', lease_owner = null, lease_until = null where id = $1 and workspace_id = $2 and fence = $3`, [runId, workspaceId, fence]));
    return { runId, status: 'waiting_approval', text: '' };
  }
  // Tool calls from the last answer that never got a result (the worker died mid-turn) are run again; writes are idempotent by call id.
  const last = [...state.messages].reverse().find((m) => m.role === 'assistant');
  const driving: Driving = { runId, fence, model: run.model as string, attended: !!run.attended, threadId: (run.thread_id as string | null) ?? undefined, kind: run.kind as string };
  if (last?.toolCalls?.length) {
    const waiting = await runTools(ctx, driving, state, last.toolCalls, events, () => {});
    await saveCheckpoint(workspaceId, runId, fence, (cp.seq as number) + 1, state);
    if (waiting) {
      await finish(workspaceId, runId, fence, 'waiting_approval', { waiting: waiting.id });
      return { runId, status: 'waiting_approval', text: '' };
    }
  }
  return drive(ctx, driving, state, Math.floor(((cp.seq as number) + 2) / 2), events);
}

/** The person a run acts for, with their current role. Null when they have left the workspace. */
async function ctxForRun(workspaceId: string, userId: string | null): Promise<Ctx | null> {
  if (!userId) return null;
  const { membership } = await import('../http/session');
  const { rulesFor } = await import('../auth/roles');
  const { authPool } = await import('../db/pool');
  const role = await membership(userId, workspaceId);
  if (!role) return null;
  const u = (await authPool.query('select id, name, email from "user" where id = $1', [userId])).rows[0];
  if (!u) return null;
  return { user: { id: u.id, name: u.name, email: u.email }, workspaceId, role, rules: rulesFor(role) };
}

/** Runs whose lease ran out while they were working. The sweep resumes them. */
export async function abandonedRuns(sys: { query: (text: string) => Promise<{ rows: { id: string; workspace_id: string }[] }> }) {
  return (await sys.query(`select id, workspace_id from run where status = 'running' and lease_until < now() order by lease_until limit 20`)).rows;
}
