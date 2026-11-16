/**
 * "Can every block really run here?" The graph check (`automationProblems`) says whether a drawing is a
 * finished automation. This says whether this workspace can run it today: the blocks it uses are ones
 * the engine runs, what they need is connected, and each step has what it works on.
 *
 * An automation that fails this stays off, and the person is told which step and why. A switch that says
 * On while a step can never happen would be a false promise.
 */
import type { Automation, WS } from '../../../src/data/ws-types';
import { KIND } from '../../../src/areas/automations/catalog';
import { stepNotYet } from '../../../src/areas/automations/real';
import { before, graphOf, triggerOf, type RunGraph } from './graph';
import { nextFire } from './when';

export interface RunEnv {
  /** A Gmail or Outlook mailbox is connected. */
  mailbox: boolean;
  /** Timmy's model is configured on this server. */
  model: boolean;
  /** The workspace's own docs and files, to find the doc a step adds to. */
  ws: Pick<WS, 'files' | 'docs'>;
  timeZone: string;
}

/** The Timmy doc a step names, when exactly one doc has that name. */
export function docNamed(ws: Pick<WS, 'files' | 'docs'>, name: string | undefined): { id: string } | 'none' | 'several' {
  const found = Object.values(ws.files).filter((f) => f.kind === 'doc' && !f.trashed && f.name === name && !!ws.docs[f.id]);
  return found.length === 1 ? { id: found[0]!.id } : found.length ? 'several' : 'none';
}

/** Why this automation can't run on this workspace yet, in words for the person. Empty when it can. */
export function runProblems(a: Pick<Automation, 'nodes' | 'edges'>, env: RunEnv): string[] {
  const g = graphOf(a);
  const out: string[] = [];
  const trigger = triggerOf(g);
  const label = (kind: string) => `“${KIND[kind]?.label ?? kind}”`;

  for (const n of g.nodes) {
    const notYet = stepNotYet(n);
    if (notYet) out.push(notYet);
  }

  if (trigger?.kind === 'email' && !env.mailbox) out.push('“New email” needs a mailbox. Connect Gmail or Outlook in Connections first.');
  if (trigger?.kind === 'schedule' && !nextFire(trigger.config.every, env.timeZone, new Date())) out.push('“On a schedule” needs a time Timmy knows.');

  const fields = new Set(Object.keys((trigger && KIND[trigger.kind]?.sample) ?? {}));
  for (const n of g.nodes) {
    const k = KIND[n.kind];
    if (!k) continue;
    const outgoing = g.edges.filter((e) => e.from === n.id);

    // A run follows one path. A step leads to one next step, and only If / else chooses between two.
    if (k.id === 'condition') {
      if (outgoing.some((e) => !e.branch)) out.push('“If / else” has a step connected to neither Yes nor No. Connect it to one of the two.');
      if (outgoing.filter((e) => e.branch === 'yes').length > 1 || outgoing.filter((e) => e.branch === 'no').length > 1) out.push('“If / else” leads to one step for Yes and one for No. Remove the extra connections.');
      if (n.config.field && trigger && !fields.has(n.config.field)) out.push(`“If / else” checks “${n.config.field}”, which ${label(trigger.kind)} doesn’t provide.`);
    } else if (outgoing.length > 1) {
      out.push(`${label(n.kind)} leads to more than one step. A step leads to one next step; use If / else to choose between two.`);
    }

    if (k.id === 'draft' || k.id === 'send') {
      if (trigger && trigger.kind !== 'email') out.push(`${label(n.kind)} needs an email to reply to, so it only works when the automation starts from “New email”.`);
    }
    if (k.id === 'draft' && !env.model) out.push('“Draft a reply” needs Timmy’s model, which isn’t configured on this server yet.');
    // In version 1 a Send step sends the reply Timmy drafted earlier in the same run, once a person approves it.
    if (k.id === 'send' && !before(g, n.id).some((b) => b.kind === 'draft')) out.push('“Send the email” needs a “Draft a reply” step before it, so there is something to send.');

    if (k.id === 'doc' && n.config.doc) {
      const doc = docNamed(env.ws, n.config.doc);
      if (doc === 'none') out.push(`“Add to a doc” points at “${n.config.doc}”, and there is no Timmy doc with that name here. Pick one of this workspace’s docs.`);
      if (doc === 'several') out.push(`More than one doc is called “${n.config.doc}”. Rename one so Timmy knows which to add to.`);
    }
  }
  return [...new Set(out)].slice(0, 6);
}

/**
 * The graph as it is frozen into a version: the same steps, with what a step points at by name
 * (a doc) pinned to the record it meant when the automation was switched on.
 */
export function frozen(a: Pick<Automation, 'nodes' | 'edges'>, env: Pick<RunEnv, 'ws'>): RunGraph {
  const g = graphOf(a);
  for (const n of g.nodes) {
    if (n.kind !== 'doc') continue;
    const doc = docNamed(env.ws, n.config.doc);
    if (typeof doc === 'object') n.config.docId = doc.id;
  }
  return g;
}
