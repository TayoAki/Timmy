/**
 * An automation's steps as the engine runs them: what each step is and how they connect, without where
 * they sit on the canvas. A frozen copy of this is a version, and a run only ever reads its version.
 */
import type { Automation } from '../../../src/data/ws-types';
import { KIND } from '../../../src/areas/automations/catalog';
import { hashOf } from '../lib/ids';

export interface RunNode {
  id: string;
  kind: string;
  config: Record<string, string>;
}

export interface RunEdge {
  from: string;
  to: string;
  branch?: 'yes' | 'no';
}

export interface RunGraph {
  nodes: RunNode[];
  edges: RunEdge[];
}

/** What an automation does, leaving out what only matters to the drawing (positions, edge ids). */
export function graphOf(a: Pick<Automation, 'nodes' | 'edges'>): RunGraph {
  return {
    nodes: a.nodes.map((n) => ({ id: n.id, kind: n.kind, config: { ...n.config } })),
    edges: a.edges.map((e) => ({ from: e.from, to: e.to, ...(e.branch ? { branch: e.branch } : {}) })),
  };
}

/** The same steps and connections always hash the same, in whatever order they were drawn. */
export function graphHash(g: RunGraph): string {
  const nodes = [...g.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...g.edges].sort((a, b) => `${a.from}>${a.to}>${a.branch ?? ''}`.localeCompare(`${b.from}>${b.to}>${b.branch ?? ''}`));
  return hashOf({ nodes, edges });
}

export const triggerOf = (g: RunGraph): RunNode | undefined => g.nodes.find((n) => KIND[n.kind]?.role === 'trigger');
export const nodeOf = (g: RunGraph, id: string | null | undefined): RunNode | undefined => (id ? g.nodes.find((n) => n.id === id) : undefined);

/**
 * The step that follows `from`. After an If / else it is the step on the branch that was taken, and nothing
 * when that branch leads nowhere. A step with no arrow out of it ends the run.
 */
export function nextOf(g: RunGraph, from: string, branch?: 'yes' | 'no'): string | null {
  const out = g.edges.filter((e) => e.from === from);
  const edge = branch ? out.find((e) => e.branch === branch) : out.find((e) => !e.branch) ?? out[0];
  return edge?.to ?? null;
}

/** Every step that can come before `id` on some path from the trigger. */
export function before(g: RunGraph, id: string): RunNode[] {
  const seen = new Set<string>();
  const walk = (to: string) => {
    for (const e of g.edges) {
      if (e.to !== to || seen.has(e.from)) continue;
      seen.add(e.from);
      walk(e.from);
    }
  };
  walk(id);
  return g.nodes.filter((n) => seen.has(n.id));
}
