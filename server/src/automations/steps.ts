/**
 * What each block does when a run reaches it.
 *
 * A step is written in two parts. The first may take its time (drafting asks the model) and changes
 * nothing the run depends on. It returns the second: the work that is done inside one workspace
 * transaction, together with the record that the step happened. So a step's change and its "done" are
 * saved together or not at all, and a step carried out twice by mistake finds its own first result.
 *
 * Nothing here reaches anyone outside the workspace. “Send the email” and “Ask me first” put a record
 * forward at the Action gateway and wait for a person; tasks, notices, doc lines and drafts stay inside Timmy.
 */
import type { State } from '../../../src/state/store';
import type { Thread } from '../../../src/data/types';
import type { Block, Task } from '../../../src/data/ws-types';
import { KIND, evaluate } from '../../../src/areas/automations/catalog';
import { draftFor } from '../agent/draft';
import type { Tx } from '../db/pool';
import { propose, type EffectRow, type Proposal } from '../gateway/gateway';
import { prepareMailSend } from '../gateway/mail';
import type { Loaded } from '../state/docs';
import { readState } from '../state/mutate';
import { MAX_BLOCKS } from '../state/ws-check';
import { before, nextOf, nodeOf, type RunNode } from './graph';
import { render, sentence } from './render';
import { logged, nameOf, type RunRow, type StepRow, type VersionRow } from './rows';
import { dueDate, sendFrom, stampLabel, waitUntil } from './when';

/** A step that could not be done. `retry` is false when trying again later cannot help. */
export class StepError extends Error {
  constructor(
    message: string,
    public retry = true,
  ) {
    super(message);
  }
}

export type StepResult =
  /** Done: carry on with the next step (on that branch, after an If / else). */
  | { then: 'next'; output: Record<string, unknown>; branch?: 'yes' | 'no' }
  /** Pause until a time, then come back to this step. */
  | { then: 'sleep'; until: Date; output: Record<string, unknown> }
  /** Wait for a person's decision on an effect record. */
  | { then: 'effect'; effect: EffectRow; output: Record<string, unknown> };

/** The part of a step that runs inside the workspace's transaction. It may return a changed state. */
export type Work = (tx: Tx, loaded: Loaded) => Promise<{ state?: State; result: StepResult }>;

export interface StepEnv {
  workspaceId: string;
  run: RunRow;
  node: RunNode;
  /** The step's own record: how many tries so far, and whether it is coming back from a pause. */
  step: StepRow;
  version: VersionRow;
  timeZone: string;
  now: Date;
}

const done = (text: string, more: Record<string, unknown> = {}): { result: StepResult } => ({ result: { then: 'next', output: { text, ...more } } });
const label = (kind: string) => KIND[kind]?.label ?? kind;

/** The thread the run's email belongs to, as the screens hold it. */
function threadOf(state: State, run: RunRow): Thread | undefined {
  const t = run.context.trigger;
  return t.kind === 'email' ? state.threads.find((x) => x.ext?.threadKey === t.threadKey && x.ext?.connectionId === t.connectionId) : undefined;
}

/** The key that makes a step's effect record the same record however often the step is tried. */
export const effectKey = (runId: string, nodeId: string) => `run:${runId}:node:${nodeId}`;

/**
 * Puts a record forward at the gateway for a person to decide. An automation has no say of its own:
 * the record must come back waiting, or be the same record a person has since decided by hand.
 * Anything else (a rule, Auto mode) is refused here, so no change elsewhere can let an automation approve itself.
 */
async function putForward(tx: Tx, loaded: Loaded, env: StepEnv, p: Omit<Proposal, 'idempotencyKey' | 'source'>): Promise<{ state: State; effect: EffectRow }> {
  const out = await propose(tx, loaded, loaded.state, null, { ...p, idempotencyKey: effectKey(env.run.id, env.node.id), source: 'routine' });
  if (out.outcome === 'blocked' || !out.effect) throw new StepError(out.reason ?? 'The step could not be put forward for approval.', false);
  if (out.effect.approved_via && out.effect.approved_via !== 'click') throw new StepError('This step needs a person’s approval, and it was approved some other way. It was stopped.', false);
  return { state: out.state, effect: out.effect };
}

/* ───────────── The steps ───────────── */

type Exec = (env: StepEnv) => Promise<Work>;

const trigger: Exec = async ({ run, node }) => {
  const f = run.context.fields;
  const text = node.kind === 'email' ? `Email from ${f.name} <${f.email}>: “${f.subject}”` : `${node.config.every}: ran for ${f.date}`;
  return async () => done(text);
};

const condition: Exec = async ({ run, node }) => {
  const yes = evaluate(node.config, run.context.fields);
  const result: StepResult = { then: 'next', branch: yes ? 'yes' : 'no', output: { text: `${node.config.field} is “${run.context.fields[node.config.field ?? ''] ?? ''}”: ${yes ? 'yes' : 'no'}`, branch: yes ? 'yes' : 'no' } };
  return async () => ({ result });
};

/** Whether the step has already had its pause: the run was picked up again when the time came, and the step was told so. */
const resumed = (step: StepRow): boolean => step.output.resumed === true;

const wait: Exec = async ({ node, step, timeZone, now }) => {
  if (resumed(step)) return async () => done(`Waited ${node.config.for === 'Until business hours' ? 'until business hours' : node.config.for}`);
  const until = waitUntil(node.config.for, timeZone, now);
  if (!until) throw new StepError('“Wait” is set to a length Timmy doesn’t know.', false);
  if (until.getTime() <= now.getTime()) return async () => done('It is business hours now, so there was nothing to wait for');
  return async () => ({ result: { then: 'sleep', until, output: { text: `Waiting until ${stampLabel(until, timeZone)}`, until: until.toISOString() } } });
};

const task: Exec = async ({ run, node, version, timeZone, now }) => {
  const title = render(node.config.title || 'Follow up with {{name}}', run.context.fields) || 'Follow up';
  const due = dueDate(node.config.due, timeZone, now);
  return async (_tx, loaded) => {
    const state = loaded.state;
    const id = `auto-${run.id}-${node.id}`;
    const thread = threadOf(state, run);
    const name = nameOf(state, run.automation_id, version.name);
    const made: Task = { id, title, status: 'todo', priority: 'normal', created: now, ...(due ? { due } : {}), ...(thread ? { thread: thread.id } : {}), notes: `Added by the automation “${name}”.` };
    const next = { ...state, ws: { ...state.ws, tasks: { ...state.ws.tasks, [id]: made } } };
    return { state: logged(next, 'task', `The automation “${name}” added the task “${title}”`, thread?.id), ...done(`Added the task “${title}”${node.config.due ? `, due ${node.config.due.toLowerCase()}` : ''}`, { task: id }) };
  };
};

const notify: Exec = async ({ run, node, version }) => {
  const message = render(node.config.message || 'New: {{name}}', run.context.fields) || 'An automation ran';
  return async (_tx, loaded) => {
    const name = nameOf(loaded.state, run.automation_id, version.name);
    return { state: logged(loaded.state, 'automation', `${name}: ${message}`, threadOf(loaded.state, run)?.id), ...done(`Told you in Timmy: “${message}”`) };
  };
};

const doc: Exec = async ({ run, node, version, now }) => {
  const line = render(node.config.line || '{{subject}}', run.context.fields);
  if (!line) throw new StepError('“Add to a doc” has no line to add.', false);
  return async (_tx, loaded) => {
    const state = loaded.state;
    // The doc was pinned when the automation was switched on. If it has since gone to the trash, nothing is written.
    const id = node.config.docId ?? '';
    const file = state.ws.files[id];
    const body = state.ws.docs[id];
    if (!file || !body || file.trashed) throw new StepError(`The doc “${node.config.doc}” isn’t there any more. Pick another doc for “Add to a doc”.`, false);
    if (body.blocks.length >= MAX_BLOCKS) throw new StepError(`The doc “${file.name}” is full.`, false);
    const blockId = `auto-${run.id}-${node.id}`;
    if (body.blocks.some((b) => b.id === blockId)) return done(`Added “${line}” to ${file.name}`);
    const block: Block = { id: blockId, type: 'p', text: line };
    const next = { ...state, ws: { ...state.ws, docs: { ...state.ws.docs, [id]: { ...body, blocks: [...body.blocks, block] } }, files: { ...state.ws.files, [id]: { ...file, updated: now } } } };
    return { state: logged(next, 'file', `The automation “${nameOf(state, run.automation_id, version.name)}” added a line to “${file.name}”`), ...done(`Added “${line}” to ${file.name}`, { doc: id }) };
  };
};

const TONES: Record<string, string> = { Brief: 'Keep it brief.', Warm: 'Keep the tone warm.', Formal: 'Keep the tone formal.' };

/**
 * What the model is told to write. It is made only from the step's own settings, which a member wrote and an
 * owner or admin switched on. The email's words are never put into it: they reach the model as the thread,
 * marked as someone else's content. A {{name}} in the starting point is left as it stands for the model to fill
 * from the thread.
 */
function draftNote(config: Record<string, string>): string | undefined {
  const start = config.message?.trim();
  const tone = TONES[config.tone ?? ''];
  const lines = [start ? `Start from this: “${start.slice(0, 1500)}”. Where it has a word in double curly brackets, such as {{name}} or {{company}}, put in that detail about the person who wrote, taken from the thread; leave it out if the thread doesn’t say.` : '', tone ?? ''].filter(Boolean);
  return lines.length ? lines.join(' ') : undefined;
}

const draft: Exec = async ({ workspaceId, run, node }) => {
  const { state } = await readState(workspaceId);
  const thread = threadOf(state, run);
  if (!thread) throw new StepError('The email this run started from isn’t in Timmy any more.', false);
  if (thread.draft) return async () => done('The thread already has a draft, so Timmy left it as it is', { drafted: false });
  if (thread.messages[thread.messages.length - 1]?.from === 'me') return async () => done('You had already answered on this thread, so Timmy didn’t draft another reply', { drafted: false });

  // The one model call an automation makes. It is counted as work nobody asked for, like the morning run's drafts.
  const out = await draftFor(workspaceId, thread, { unattended: true, note: draftNote(node.config) });
  if (!out.ok) {
    if (out.why === 'has-draft') return async () => done('The thread already has a draft, so Timmy left it as it is', { drafted: false });
    throw new StepError(out.reason ?? 'Timmy couldn’t write that draft.', out.why === 'model' || out.why === undefined);
  }
  return async () => done(`Drafted a reply to ${run.context.fields.email}. It waits in Approvals, and nothing is sent`, { drafted: true });
};

const approve: Exec = async (env) => {
  const { run, node, version } = env;
  const note = render(node.config.note, run.context.fields);
  return async (tx, loaded) => {
    const state = loaded.state;
    const name = nameOf(state, run.automation_id, version.name);
    const f = run.context.fields;
    const after = nodeOf(version.graph, nextOf(version.graph, node.id));
    const started = run.context.trigger.kind === 'email' ? `It started from an email from ${f.name} <${f.email}>: “${f.subject}”.` : `It started on its schedule (${f.date}).`;
    const then = after ? `If you approve, it carries on with “${label(after.kind)}”.` : 'If you approve, the run finishes.';
    const put = await putForward(tx, loaded, env, {
      kind: 'automation.ask',
      // Nothing here is carried out; it records what was asked, for the audit log.
      payload: { automationId: run.automation_id, runId: run.id, nodeId: node.id, note },
      preview: {},
      title: `“${name}” is asking before it carries on`,
      why: [note && sentence(note), started, then, 'If you decline, the run stops here.'].filter(Boolean).join(' '),
      thread: threadOf(state, run)?.id,
      // Whoever switched the automation on may answer, as may any owner or admin.
      onBehalfOf: version.created_by,
    });
    return { state: put.state, result: { then: 'effect', effect: put.effect, output: { text: 'Waiting in Approvals for a yes or no' } } };
  };
};

const send: Exec = async (env) => {
  const { workspaceId, run, node, step, version, timeZone, now } = env;
  const t = run.context.trigger;
  if (t.kind !== 'email') throw new StepError('“Send the email” needs an email to reply to.', false);

  // "When" decides how soon the email is put forward. It still waits for a person after that.
  if (!resumed(step)) {
    const from = sendFrom(node.config.when, timeZone, now);
    if (!from) throw new StepError('“Send the email” is set to a time Timmy doesn’t know.', false);
    if (from.getTime() > now.getTime()) return async () => ({ result: { then: 'sleep', until: from, output: { text: `Holding the email until ${stampLabel(from, timeZone)}`, until: from.toISOString() } } });
  }

  return async (tx, loaded) => {
    const state = loaded.state;
    const thread = threadOf(state, run);
    if (!thread) throw new StepError('The email this run started from isn’t in Timmy any more.', false);
    // Only the reply this run drafted is put forward. A draft the person wrote themselves is theirs to send.
    const drafted = before(version.graph, node.id).some((b) => b.kind === 'draft' && run.context.steps[b.id]?.drafted === true);
    if (!drafted) return done('Nothing was put forward: this run didn’t draft a reply on the thread (it already had a draft, or you had answered)', { proposed: false });
    const reply = thread.draft;
    if (!reply) return done('Nothing was put forward: the draft is no longer on this thread (it was sent or discarded)', { proposed: false });
    // One email per thread waits at a time. If one is already waiting or on its way, this run has nothing to add.
    const waiting = await tx.query(`select 1 from effect where workspace_id = $1 and kind in ('email.send', 'email.reply') and preview->>'thread' = $2 and status in ('intended', 'approved', 'executing', 'uncertain') limit 1`, [workspaceId, thread.id]);
    if (waiting.rows[0]) return done('Nothing was put forward: this thread already has an email waiting to go out', { proposed: false });

    // The reply goes to whoever sent the email that started the run, and to nobody else. That address was read
    // from the mailbox when the email arrived; nothing a step renders, and nothing in the draft, can change it.
    const mail = await prepareMailSend(tx, workspaceId, { to: [t.sender], cc: [], subject: reply.subject, body: reply.body, threadId: thread.id, existing: { threadKey: t.threadKey, connectionId: t.connectionId } });
    if (!mail.ok) throw new StepError(mail.reason);
    const mailboxOwner = (await tx.query('select user_id from connection where id = $1 and workspace_id = $2', [mail.proposal.payload.connectionId, workspaceId])).rows[0]?.user_id as string | undefined;
    const name = nameOf(state, run.automation_id, version.name);
    const put = await putForward(tx, loaded, env, {
      ...mail.proposal,
      why: `The automation “${name}” wants to send the reply Timmy drafted. Nothing goes out unless you approve it here; decline it and the draft stays on the thread for you.`,
      // The person whose mailbox it leaves from may approve it, as may any owner or admin.
      onBehalfOf: mailboxOwner ?? version.created_by,
    });
    return { state: put.state, result: { then: 'effect', effect: put.effect, output: { text: `Waiting in Approvals: a reply to ${t.sender}. Nothing is sent until someone approves it`, to: [t.sender] } } };
  };
};

export const STEPS: Record<string, Exec> = { email: trigger, schedule: trigger, condition, wait, task, notify, doc, draft, approve, send };
