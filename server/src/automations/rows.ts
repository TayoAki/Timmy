/**
 * The engine's own records, as they are stored, and the few things every part of the engine does with them:
 * add a line to the activity log, and switch an automation off with a note that says why.
 */
import type { State } from '../../../src/state/store';
import type { ActivityKind } from '../../../src/data/types';
import type { Tx } from '../db/pool';
import { audit } from '../gateway/gateway';
import { newId } from '../lib/ids';
import type { RunGraph } from './graph';
import type { Fields } from './render';
import { stampLabel } from './when';

export interface VersionRow {
  id: string;
  workspace_id: string;
  automation_id: string;
  name: string;
  graph: RunGraph;
  graph_hash: string;
  created_by: string;
  created_at: Date;
}

export interface LiveRow {
  workspace_id: string;
  automation_id: string;
  version_id: string;
  enabled: boolean;
  trigger_kind: string;
  enabled_by: string;
  enabled_at: Date;
  next_fire_at: Date | null;
  failures_in_a_row: number;
  off_reason: string | null;
  /** Set while a New-email automation that is on has no mailbox to read (see mailbox.ts). */
  paused_reason: string | null;
}

/** What started a run. Kept apart from the fields a template may use: nothing in here is ever filled into text. */
export type TriggerInfo =
  | { kind: 'email'; itemId: string; threadKey: string; connectionId: string; /** The address the email came from. A reply goes here and nowhere else. */ sender: string; at: string }
  | { kind: 'schedule'; at: string };

export interface RunContext {
  trigger: TriggerInfo;
  /** The trigger's fields, offered to later steps as {{name}}, {{subject}} and so on. */
  fields: Fields;
  /** What each step that has run produced, by step id. */
  steps: Record<string, Record<string, unknown>>;
}

export type RunStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

export interface RunRow {
  id: string;
  workspace_id: string;
  automation_id: string;
  version_id: string;
  trigger_event_id: string;
  status: RunStatus;
  context: RunContext;
  cursor: string | null;
  depth: number;
  origin: string[];
  wake_at: Date | null;
  waiting_effect_id: string | null;
  lease_token: string | null;
  lease_until: Date | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface StepRow {
  run_id: string;
  workspace_id: string;
  node_id: string;
  seq: number;
  kind: string;
  status: 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  effect_id: string | null;
  attempt: number;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

/** The longest note an automation carries. The workspace check (state/ws-check.ts) accepts a little more. */
export const NOTE_MAX = 500;

/** How deep a chain of automations setting each other off may go. */
export const MAX_DEPTH = 3;

/** A line in the workspace's activity log, newest first. */
export function logged(state: State, kind: ActivityKind, text: string, threadId?: string): State {
  return { ...state, activity: [{ id: newId('act'), at: new Date(), kind, text, ...(threadId ? { threadId } : {}) }, ...state.activity] };
}

/** The automation's name as people know it now, falling back to the name it had when its version was frozen. */
export const nameOf = (state: State, automationId: string, fallback: string) => state.ws.automations[automationId]?.name ?? fallback;

/**
 * Switches an automation off because the engine decided to (it ran too often, or kept failing), and says why
 * where the person will see it: a note on the automation itself, and a line in the activity log.
 * Runs already in progress are left to finish; only new ones stop.
 */
export async function switchOff(tx: Tx, state: State, workspace: { id: string; timezone: string }, automationId: string, why: string): Promise<State> {
  await tx.query(`update automation_live set enabled = false, off_reason = $3, next_fire_at = null, paused_reason = null, updated_at = now() where workspace_id = $1 and automation_id = $2`, [workspace.id, automationId, why]);
  await audit(tx, workspace.id, { actor: 'system', action: 'automation.off', detail: { automation: automationId, reason: why } });
  const a = state.ws.automations[automationId];
  if (!a) return state;
  const note = `Timmy switched this off on ${stampLabel(new Date(), workspace.timezone)}. ${why}`.slice(0, NOTE_MAX);
  // Off, it is no longer paused either.
  const { paused: _paused, ...rest } = a;
  const next: State = { ...state, ws: { ...state.ws, automations: { ...state.ws.automations, [automationId]: { ...rest, on: false, note } } } };
  return logged(next, 'automation', `Timmy switched the automation “${a.name}” off. ${why}`);
}
