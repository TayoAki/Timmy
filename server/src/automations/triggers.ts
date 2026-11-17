/**
 * What starts a run. Plain code decides: a new email is matched against "from contains" and "subject
 * contains", and a schedule comes due on the workspace's own clock. No model is asked whether an
 * automation should fire.
 *
 * A run is recorded in the same transaction that noticed its event, as one row per automation and event,
 * so an event delivered twice starts one run. The run itself is carried out afterwards by a job.
 */
import type { State } from '../../../src/state/store';
import { config } from '../config';
import type { Tx } from '../db/pool';
import { audit } from '../gateway/gateway';
import { enqueueSoon } from '../jobs/jobs';
import { newId } from '../lib/ids';
import { log } from '../lib/log';
import { mutate } from '../state/mutate';
import { parseSender, type MailMessage } from '../sync/message';
import type { ConnectionRow } from '../sync/tools';
import { triggerOf } from './graph';
import { plain, safe, type Fields } from './render';
import { MAX_DEPTH, switchOff, type LiveRow, type RunContext, type TriggerInfo, type VersionRow } from './rows';
import { dayLabel, nextFire } from './when';

type Live = LiveRow & Pick<VersionRow, 'graph' | 'name'>;

const HOUR = 3600_000;
/** Mail older than this never starts a run, however it reaches Timmy (the nightly check looks back two days). */
const NEW_MAIL_HOURS = 48;
/** A message stamped a little before the automation was switched on still counts: clocks differ by seconds. */
const CLOCK_SLACK_MS = 5 * 60_000;

/* ───────────── Queueing a run ───────────── */

export interface RunEvent {
  /** The same event always has the same id, so it can only ever start one run of an automation. */
  id: string;
  trigger: TriggerInfo;
  fields: Fields;
  /** The run whose own output this event is, when it is one. */
  origin?: { runId: string; depth: number; chain: string[] };
}

/**
 * Records a run for one automation and one event, unless that run already exists, the chain of automations
 * setting each other off is too long, or the automation has run too often. Past the hourly limit the
 * automation is switched off, with a note saying why. Returns the state, changed only in that last case.
 */
export async function queueRun(tx: Tx, state: State, workspace: { id: string; timezone: string }, live: Live, event: RunEvent): Promise<{ state: State; runId: string | null; switchedOff?: boolean }> {
  const depth = event.origin ? event.origin.depth + 1 : 0;
  if (depth > MAX_DEPTH) {
    log.warn('an automation was not started: the chain of automations is too long', { workspaceId: workspace.id, automation: live.automation_id, depth });
    return { state, runId: null };
  }

  // An event that already has its run starts nothing, and doesn't count towards the limit either.
  if ((await tx.query(`select 1 from automation_run where workspace_id = $1 and automation_id = $2 and trigger_event_id = $3`, [workspace.id, live.automation_id, event.id])).rows[0]) return { state, runId: null };

  // Counted from when it was last switched on, so switching it back on after a look is a fresh start.
  const limit = config.automations.runsPerHour;
  const recent = (await tx.query(`select count(*)::int as n from automation_run where workspace_id = $1 and automation_id = $2 and created_at > greatest(now() - interval '1 hour', $3::timestamptz)`, [workspace.id, live.automation_id, live.enabled_at])).rows[0].n as number;
  if (recent >= limit) {
    const why = `It had started ${limit} runs within an hour, which is the most an automation may. Check what sets it off, then switch it back on.`;
    return { state: await switchOff(tx, state, workspace, live.automation_id, why), runId: null, switchedOff: true };
  }

  // The fields are words a sender wrote. They are kept as plain single lines, with anything shaped like a key masked.
  // What identifies the event (which stored email, which thread) is kept exactly: a reply has to find its thread.
  const context: RunContext = { trigger: event.trigger, fields: safe(Object.fromEntries(Object.entries(event.fields).map(([k, v]) => [k, plain(v)]))), steps: {} };
  const runId = newId('arun');
  const made = await tx.query(
    `insert into automation_run (id, workspace_id, automation_id, version_id, trigger_event_id, status, context, cursor, depth, origin)
     values ($1, $2, $3, $4, $5, 'queued', $6::jsonb, $7, $8, $9::jsonb)
     on conflict (workspace_id, automation_id, trigger_event_id) do nothing returning id`,
    [runId, workspace.id, live.automation_id, live.version_id, event.id, JSON.stringify(context).replace(/\\u0000/g, ''), triggerOf(live.graph)?.id ?? null, depth, JSON.stringify(event.origin ? [...event.origin.chain, event.origin.runId] : [])],
  );
  if (!made.rows[0]) return { state, runId: null };
  await audit(tx, workspace.id, { actor: 'system', action: 'automation.run', runId, detail: { automation: live.automation_id, version: live.version_id, event: event.id } });
  enqueueSoon('automation.run', { workspaceId: workspace.id, runId });
  return { state, runId };
}

/* ───────────── New email ───────────── */

/** Addresses at these domains say nothing about a company. */
const PERSONAL_MAIL = /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|aol|proton|protonmail|pm|gmx|mail|fastmail|hey)\./i;

/** The fields a new email gives later steps. Every one of them was written by the sender. */
export function mailFields(m: { from: string; subject: string; text: string }): Fields {
  const sender = parseSender(m.from);
  const [local = '', domain = ''] = sender.email.split('@');
  const company = PERSONAL_MAIL.test(domain) ? '' : (domain.split('.')[0] ?? '').replace(/^./, (c) => c.toUpperCase());
  return { name: sender.name || local || sender.email, email: sender.email, company, subject: m.subject, snippet: m.text.replace(/\s+/g, ' ').trim().slice(0, 300) };
}

/**
 * "From contains" and "subject contains", without regard to capitals. An empty setting matches everything.
 * "From" is matched against the address the email came from, never the display name: anyone can call themselves
 * "ceo@bigclient.com" in the name part, and a filter on who wrote is often what stands between a stranger and a run.
 */
export function mailMatches(config: Record<string, string>, m: { from: string; subject: string }): boolean {
  const has = (text: string, want: string | undefined) => !want?.trim() || text.toLowerCase().includes(want.trim().toLowerCase());
  return has(parseSender(m.from).email, config.from) && has(m.subject, config.subject);
}

/**
 * Called where every new email is stored. Starts a run of each automation that is on, starts from
 * “New email”, and matches the message. Only mail that was received counts: never mail the owner sent,
 * never a draft, never mail Timmy sent for an automation, and never old mail that is only now being read in.
 */
export async function onMailStored(tx: Tx, state: State, workspaceId: string, conn: ConnectionRow, fresh: MailMessage[]): Promise<State> {
  const own = (conn.account_label ?? '').toLowerCase();
  const received = fresh.filter((m) => m.labels.includes('INBOX') && !m.labels.some((l) => l === 'SENT' || l === 'DRAFT' || l === 'SPAM' || l === 'TRASH') && parseSender(m.from).email !== own && !!parseSender(m.from).email);
  if (!received.length) return state;
  // The mail has to be stored whatever happens here. If starting runs fails, what this did is undone and the mail
  // is kept; the failure is logged, and no run starts for these messages.
  await tx.query('savepoint automations');
  try {
    const next = await startRuns(tx, state, workspaceId, conn, received);
    await tx.query('release savepoint automations');
    return next;
  } catch (e) {
    await tx.query('rollback to savepoint automations');
    log.error('new mail could not start automations', { workspaceId, error: (e as Error).message });
    return state;
  }
}

async function startRuns(tx: Tx, state: State, workspaceId: string, conn: ConnectionRow, received: MailMessage[]): Promise<State> {
  const lives = (
    // A paused automation (no mailbox was connected) fires nothing until it is resumed.
    await tx.query(`select l.*, v.graph, v.name from automation_live l join automation_version v on v.id = l.version_id where l.workspace_id = $1 and l.enabled and l.paused_reason is null and l.trigger_kind = 'email'`, [workspaceId])
  ).rows as Live[];
  if (!lives.length) return state;

  const ids = received.map((m) => m.id);
  const items = new Map(((await tx.query(`select id, external_id from item where workspace_id = $1 and connection_id = $2 and kind = 'message' and external_id = any($3::text[])`, [workspaceId, conn.id, ids])).rows as { id: string; external_id: string }[]).map((r) => [r.external_id, r.id]));
  // Mail that an effect of ours put in the mailbox is Timmy's own output, whatever folder it turns up in.
  const ours = new Set(((await tx.query(`select external_id from effect where workspace_id = $1 and external_id = any($2::text[])`, [workspaceId, ids])).rows as { external_id: string }[]).map((r) => r.external_id));
  const ws = (await tx.query(`select w.timezone, c.created_at as connected_at from workspace w, connection c where w.id = $1 and c.id = $2 and c.workspace_id = $1`, [workspaceId, conn.id])).rows[0] as { timezone: string; connected_at: Date } | undefined;
  if (!ws) return state;
  const workspace = { id: workspaceId, timezone: ws.timezone };
  const newSince = Math.max(Date.now() - NEW_MAIL_HOURS * HOUR, new Date(ws.connected_at).getTime());

  let next = state;
  const off = new Set<string>();
  for (const m of [...received].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const itemId = items.get(m.id);
    if (!itemId || ours.has(m.id) || m.at.getTime() < newSince) continue;
    for (const live of lives) {
      if (off.has(live.automation_id)) continue;
      // Mail that was already in the mailbox before the automation was switched on doesn't start it.
      if (m.at.getTime() < new Date(live.enabled_at).getTime() - CLOCK_SLACK_MS) continue;
      const trigger = triggerOf(live.graph);
      if (!trigger || !mailMatches(trigger.config, m)) continue;
      const fields = mailFields(m);
      const queued = await queueRun(tx, next, workspace, live, {
        id: `mail:${itemId}`,
        trigger: { kind: 'email', itemId, threadKey: m.threadKey, connectionId: conn.id, sender: fields.email!, at: m.at.toISOString() },
        fields,
      });
      next = queued.state;
      if (queued.switchedOff) off.add(live.automation_id);
    }
  }
  return next;
}

/* ───────────── On a schedule ───────────── */

/** Automations whose scheduled time has come, across workspaces. Ids only. */
export async function dueSchedules(sys: { query: Tx['query'] }): Promise<{ workspace_id: string; automation_id: string }[]> {
  const { rows } = await sys.query(`select l.workspace_id, l.automation_id from automation_live l join workspace w on w.id = l.workspace_id where l.enabled and l.next_fire_at is not null and l.next_fire_at <= now() and w.deleted_at is null limit 200`);
  return rows as { workspace_id: string; automation_id: string }[];
}

/**
 * Starts the run for one scheduled time and moves the schedule on to its next one. The time that came due
 * is the event's id, so two workers noticing it together start one run. A time missed by hours (the server
 * was down) is skipped, not run late.
 */
export async function fireSchedule(workspaceId: string, automationId: string, now = new Date()): Promise<string | null> {
  return mutate(workspaceId, 'automation', async (tx, loaded) => {
    const live = (await tx.query(`select l.*, v.graph, v.name from automation_live l join automation_version v on v.id = l.version_id where l.workspace_id = $1 and l.automation_id = $2 and l.enabled for update of l`, [workspaceId, automationId])).rows[0] as Live | undefined;
    if (!live?.next_fire_at || new Date(live.next_fire_at).getTime() > now.getTime()) return { result: null };
    const due = new Date(live.next_fire_at);
    const trigger = triggerOf(live.graph);
    const workspace = { id: workspaceId, timezone: loaded.workspace.timezone };
    const next = nextFire(trigger?.config.every, workspace.timezone, now);
    await tx.query(`update automation_live set next_fire_at = $3, updated_at = now() where workspace_id = $1 and automation_id = $2`, [workspaceId, automationId, next]);
    if (now.getTime() - due.getTime() > config.automations.lateMinutes * 60_000) return { result: null };
    const queued = await queueRun(tx, loaded.state, workspace, live, {
      id: `schedule:${due.toISOString()}`,
      trigger: { kind: 'schedule', at: due.toISOString() },
      fields: { date: dayLabel(due, workspace.timezone), name: loaded.workspace.owner_name ?? '', email: loaded.workspace.owner_email ?? '', company: loaded.workspace.name },
    });
    return { state: queued.state, result: queued.runId };
  });
}
