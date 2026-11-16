/**
 * A test run on the server: the saved drawing is walked with sample data, or with a real email that
 * arrived recently, and each step says what it would do. Nothing is done. No task is added, no draft is
 * written, no model is asked, nothing is put forward in Approvals, and no run is recorded.
 *
 * A step that would wait for a person shows what it would put forward, so the person can see who an
 * email would go to before the automation is ever switched on.
 */
import type { Automation } from '../../../src/data/ws-types';
import { KIND, evaluate } from '../../../src/areas/automations/catalog';
import { stepNotYet } from '../../../src/areas/automations/real';
import { withWorkspace } from '../db/pool';
import { ADDRESS } from '../gateway/mail';
import { readState } from '../state/mutate';
import { automationProblems } from '../state/ws-check';
import { runProblems } from './canrun';
import { runEnv } from './gate';
import { graphOf, nextOf, nodeOf, triggerOf } from './graph';
import { plain, render, safe, type Fields } from './render';
import { mailFields } from './triggers';

export interface DryStep {
  id: string;
  kind: string;
  label: string;
  /** What the step would do, in a line. */
  text: string;
  /** Set when this block can't run on a real workspace yet. */
  notYet?: string;
  /** What the step would put forward in Approvals. It is only shown here; nothing is recorded. */
  wouldAsk?: { kind: 'email.reply' | 'automation.ask'; title: string; to?: string[]; subject?: string; body?: string };
}

export interface DryRun {
  ok: true;
  /** Always true: said in the answer itself, so nobody reads a test run as the real thing. */
  dryRun: true;
  source: 'sample' | 'email';
  fields: Fields;
  steps: DryStep[];
  /** Steps the walk never reached (the branch not taken). */
  skipped: string[];
  /** What would stop this automation being switched on today. Empty when nothing would. */
  problems: string[];
}

export type DryRunAnswer = { status: 200; body: DryRun } | { status: 400 | 404; body: { error: string } };

const refuse = (status: 400 | 404, error: string): DryRunAnswer => ({ status, body: { error } });

/** One stored email, read inside the asking workspace's own scope: an id from anywhere else finds nothing. */
async function emailFields(workspaceId: string, eventId: string): Promise<Fields | null> {
  const row = await withWorkspace({ workspaceId }, async (tx) => {
    const { rows } = await tx.query(
      `select i.subject, i.snippet, i.sender, i.meta from item i where i.workspace_id = $1 and i.id = $2 and i.kind = 'message' and i.direction = 'in'`,
      [workspaceId, eventId.replace(/^mail:/, '')],
    );
    return rows[0] as { subject: string | null; snippet: string | null; sender: string | null; meta: { fromHeader?: string } } | undefined;
  });
  if (!row?.sender) return null;
  return mailFields({ from: row.meta.fromHeader || row.sender, subject: row.subject ?? '', text: row.snippet ?? '' });
}

export async function dryRun(workspaceId: string, automationId: string, body: { sample?: unknown; eventId?: unknown }): Promise<DryRunAnswer> {
  const loaded = await readState(workspaceId);
  const a: Automation | undefined = loaded.state.ws.automations[automationId];
  if (!a) return refuse(404, 'Not found');
  const broken = automationProblems(a, false);
  if (broken.length) return refuse(400, broken.join(' '));
  const g = graphOf(a);
  const trigger = triggerOf(g);
  if (!trigger) return refuse(400, 'Add a trigger first: what should start this automation?');

  let fields: Fields;
  let source: DryRun['source'] = 'sample';
  if (typeof body.eventId === 'string' && body.eventId) {
    if (trigger.kind !== 'email') return refuse(400, 'Only an automation that starts from “New email” can be tested with a real email.');
    if (!/^[\w:.-]{1,80}$/.test(body.eventId)) return refuse(404, 'That email isn’t in this workspace.');
    const real = await emailFields(workspaceId, body.eventId);
    if (!real) return refuse(404, 'That email isn’t in this workspace.');
    fields = safe(Object.fromEntries(Object.entries(real).map(([k, v]) => [k, plain(v)])));
    source = 'email';
  } else if (body.sample === true) {
    fields = { ...(KIND[trigger.kind]?.sample ?? {}) };
  } else {
    return refuse(400, 'Say what to test with: sample data, or a recent email.');
  }

  const steps: DryStep[] = [];
  const seen = new Set<string>();
  for (let cur = nodeOf(g, trigger.id); cur && !seen.has(cur.id); ) {
    seen.add(cur.id);
    const k = KIND[cur.kind]!;
    const step: DryStep = { id: cur.id, kind: cur.kind, label: k.label, text: k.test(cur.config, fields) };
    const notYet = stepNotYet(cur);
    if (notYet) step.notYet = notYet;
    if (cur.kind === 'approve') {
      step.wouldAsk = { kind: 'automation.ask', title: `“${a.name}” is asking before it carries on`, body: render(cur.config.note, fields) };
    }
    if (cur.kind === 'send') {
      // The same rule as a real run: a reply to whoever sent the email, and only if that is an address.
      const to = (fields.email ?? '').trim().toLowerCase();
      step.wouldAsk = ADDRESS.test(to)
        ? { kind: 'email.reply', title: `Reply to ${to}`, to: [to], subject: /^re:/i.test(fields.subject ?? '') ? fields.subject : `Re: ${fields.subject ?? ''}`, body: '(The reply Timmy drafts when the automation really runs.)' }
        : undefined;
      step.text = step.wouldAsk ? `Would wait in Approvals for someone to approve a reply to ${to}. Nothing is sent in a test run` : 'Would send nothing: there is no address to reply to';
    }
    steps.push(step);
    const branch = cur.kind === 'condition' ? (evaluate(cur.config, fields) ? 'yes' : 'no') : undefined;
    cur = nodeOf(g, nextOf(g, cur.id, branch));
  }

  const env = await withWorkspace({ workspaceId }, (tx) => runEnv(tx, loaded, loaded.state));
  const unfinished = automationProblems(a, true);
  return { status: 200, body: { ok: true, dryRun: true, source, fields, steps, skipped: g.nodes.filter((n) => !seen.has(n.id)).map((n) => n.id), problems: unfinished.length ? unfinished : runProblems(a, env) } };
}
