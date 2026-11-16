/**
 * The morning run. Once a day, at the time the workspace chose, Timmy gets the
 * brief ready: it checks the mailbox for anything the triggers missed, reads
 * the threads people wrote, drafts replies to the ones that need an answer, and
 * drafts a nudge where the person is still waiting for something past its date.
 *
 * It only prepares. Reading proposes where a thread belongs and the person
 * accepts it; a draft waits in Approvals until the person presses Send. The run
 * never moves a thread and never sends anything.
 */
import type { Thread } from '../../../src/data/types';
import type { MorningRun } from '../../../src/live/types';
import { DEFAULT_SCHEDULE, type Schedule } from '../../../src/state/schedule';
import { config } from '../config';
import { withWorkspace } from '../db/pool';
import { newId } from '../lib/ids';
import { log } from '../lib/log';
import { BudgetError, checkBudget, modelReady } from '../providers/model';
import { mutate, readState } from '../state/mutate';
import { reconcileMail } from '../sync/ingest';
import { MAIL_TOOLKITS } from '../sync/mailbox';
import { draftNudge, draftReply, wantsNudge } from './draft';
import { needsReading, readThread } from './read';

/* ───────────── When a run is due ───────────── */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** A run that could not start on time (the server was down) still happens if it is no later than this. */
const LATE_MINUTES = 6 * 60;

/** The calendar date, minutes past midnight and weekday on the wall clock of a time zone. */
export function localTime(at: Date, timeZone: string): { date: string; minutes: number; weekday: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(at);
  } catch {
    // A time zone the runtime doesn't know is treated as UTC rather than stopping every workspace's run.
    return localTime(at, 'UTC');
  }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: WEEKDAYS.indexOf(p.weekday ?? '') };
}

export const isTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Whether the scheduled run should start now: it is a chosen day, the time has come, and today's run hasn't happened. */
export function runDue(schedule: Pick<Schedule, 'time' | 'days'>, timeZone: string, lastRun: Date | null, now = new Date()): boolean {
  const local = localTime(now, timeZone);
  if (!schedule.days.includes(local.weekday)) return false;
  const [h, m] = schedule.time.split(':').map(Number);
  const at = (h ?? 0) * 60 + (m ?? 0);
  if (local.minutes < at || local.minutes - at > LATE_MINUTES) return false;
  return !lastRun || localTime(lastRun, timeZone).date !== local.date;
}

/**
 * Workspaces whose run is due. A workspace needs a connected mailbox whose first sync has finished: a run
 * on a mailbox that is still being read for the first time would prepare the brief from a fraction of it.
 */
export async function dueWorkspaces(sys: { query: (text: string) => Promise<{ rows: Record<string, unknown>[] }> }, now = new Date()): Promise<string[]> {
  const { rows } = await sys.query(
    `select w.id, w.timezone, w.morning_run_at, d.data -> 'v' as schedule
     from workspace w left join state_doc d on d.workspace_id = w.id and d.slice = 'schedule' and d.id = '_'
     where w.deleted_at is null and exists (
       select 1 from connection c join sync_cursor s on s.connection_id = c.id
       where c.workspace_id = w.id and c.status = 'active' and c.toolkit in ('gmail', 'outlook') and s.kind like 'backfill-%' and s.state = 'done')`,
  );
  return rows
    .filter((r) => {
      const s = (r.schedule ?? DEFAULT_SCHEDULE) as Partial<Schedule>;
      if (typeof s.time !== 'string' || !Array.isArray(s.days)) return false;
      return runDue({ time: s.time, days: s.days }, r.timezone as string, (r.morning_run_at as Date | null) ?? null, now);
    })
    .map((r) => r.id as string);
}

/* ───────────── The run ───────────── */

const lastInbound = (t: Thread) => [...t.messages].reverse().find((m) => m.from !== 'me');
const lastAt = (t: Thread) => new Date(t.messages[t.messages.length - 1]?.at ?? 0).getTime();

/** A thread worth drafting for: it needs a reply from the person, the other side wrote last, and nobody has drafted one. */
function wantsDraft(t: Thread, since: number): boolean {
  if (t.draft || lastAt(t) < since) return false;
  const last = t.messages[t.messages.length - 1];
  if (!last || last.from === 'me') return false;
  if (t.box === 'follow-up') return true;
  // Still in the inbox, but Timmy has read it and is fairly sure it needs an answer.
  return t.box === 'inbox' && t.suggestion?.box === 'follow-up' && !t.suggestion.provisional && t.suggestion.confidence !== 'low';
}

/**
 * Runs the morning run for one workspace, once per local day. Returns null when
 * today's run has already been claimed (two workers, or a retried job).
 */
export async function morningRun(workspaceId: string, now = new Date()): Promise<MorningRun | null> {
  // Claim the day first, so a second worker or a retry does not read and draft everything again.
  const claimed = await withWorkspace({ workspaceId, lock: true }, async (tx) => {
    const ws = (await tx.query('select timezone, morning_run_at from workspace where id = $1', [workspaceId])).rows[0] as { timezone: string; morning_run_at: Date | null } | undefined;
    if (!ws) return null;
    if (ws.morning_run_at && localTime(ws.morning_run_at, ws.timezone).date === localTime(now, ws.timezone).date) return null;
    await tx.query('update workspace set morning_run_at = $2 where id = $1', [workspaceId, now]);
    return { previous: ws.morning_run_at };
  });
  if (!claimed) return null;
  const since = claimed.previous ? new Date(claimed.previous).getTime() : now.getTime() - 86400_000;

  // 1. Mail the triggers missed.
  const boxes = await withWorkspace({ workspaceId }, async (tx) => (await tx.query(`select id from connection where workspace_id = $1 and status = 'active' and toolkit = any($2::text[])`, [workspaceId, MAIL_TOOLKITS])).rows as { id: string }[]);
  for (const b of boxes) await reconcileMail(workspaceId, b.id).catch((e) => log.warn('the morning mail check failed', { workspaceId, error: (e as Error).message }));

  const run: MorningRun = { at: now, sorted: 0, drafted: 0 };
  let { state } = await readState(workspaceId);
  run.sorted = state.threads.filter((t) => {
    const m = lastInbound(t);
    return !!m && new Date(m.at).getTime() >= since;
  }).length;

  // 2 and 3 cost money, so they stop at the workspace's monthly limit.
  let canThink = modelReady();
  if (canThink) {
    try {
      await checkBudget(workspaceId, true);
    } catch (e) {
      if (!(e instanceof BudgetError)) throw e;
      canThink = false;
      run.note = 'The monthly limit for Timmy’s model is reached, so nothing was read or drafted.';
    }
  }
  if (canThink) {
    // 2. Read what people wrote and Timmy hasn't read yet, newest first.
    const unread = state.threads.filter((t) => needsReading(t) && lastAt(t) >= since - 86400_000).sort((a, b) => lastAt(b) - lastAt(a)).slice(0, config.morningReadLimit);
    for (const t of unread) await readThread(workspaceId, t.id);

    // 3. Draft replies for what needs an answer.
    ({ state } = await readState(workspaceId));
    const horizon = now.getTime() - config.morningDraftDays * 86400_000;
    const todo = state.threads.filter((t) => wantsDraft(t, horizon)).sort((a, b) => lastAt(b) - lastAt(a)).slice(0, config.morningDraftLimit);
    for (const t of todo) if ((await draftReply(workspaceId, t.id, { unattended: true })).ok) run.drafted++;

    // 4. Nudges for what the person asked for and still hasn't received.
    ({ state } = await readState(workspaceId));
    const overdue = state.threads.filter((t) => wantsNudge(t, now)).slice(0, config.morningNudgeLimit);
    for (const t of overdue) if ((await draftNudge(workspaceId, t.id, { unattended: true })).ok) run.nudged = (run.nudged ?? 0) + 1;
  }

  // 5. Say what happened, on the brief and in the activity log.
  const threads = run.sorted === 1 ? '1 thread' : `${run.sorted} threads`;
  const replies = run.drafted === 1 ? '1 reply' : `${run.drafted} replies`;
  const nudges = !run.nudged ? '' : run.nudged === 1 ? ', 1 nudge drafted' : `, ${run.nudged} nudges drafted`;
  const text = `Morning run: ${threads} with new mail, ${replies} drafted${nudges}.${run.note ? ` ${run.note}` : ''}`;
  await mutate(workspaceId, 'morning', async (_tx, loaded) => ({
    state: { ...loaded.state, run, activity: [{ id: newId('act'), at: now, kind: 'triage' as const, text }, ...loaded.state.activity] },
    result: null,
  }));
  log.info('morning run', { workspaceId, sorted: run.sorted, drafted: run.drafted, note: run.note });
  return run;
}
