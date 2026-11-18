/**
 * The map of a workspace's world, for People › Map: who the person works with, the companies they are at, the projects
 * Timmy found and the person kept, the files and meetings that belong to those projects, and the promises still open.
 * Everything comes from what Timmy already keeps (the ontology's entities and relations, the projects and their
 * links); nothing new is read or stored.
 *
 * It is bounded so it stays readable: the people most in touch, then what connects to them. The totals say how much
 * more there is.
 */
import type { State } from '../../../src/state/store';
import { withWorkspace } from '../db/pool';

export type MapNodeType = 'person' | 'company' | 'project' | 'file' | 'meeting' | 'promise';

export interface MapNode {
  id: string;
  type: MapNodeType;
  label: string;
  /** A second line: an address, a domain, a kind of file, a date, who owes it. */
  sub?: string;
  /** How much is going on: emails, people, threads. Sizes the node. */
  weight: number;
  /** For opening it: a person's address, a project's id, a file's item id, a promise's thread. */
  ref?: string;
  /** People: the company they are at, by node id. */
  company?: string;
  /** Promises: whether it is owed to the person ("them") or by them ("me"), and when. */
  who?: 'them' | 'me';
  due?: string;
}

export interface MapEdge {
  source: string;
  target: string;
  kind: 'works_at' | 'in_project' | 'linked' | 'attended' | 'owns' | 'promised';
}

export interface WorkspaceMap {
  nodes: MapNode[];
  edges: MapEdge[];
  /** How many there are of each, shown or not. */
  totals: { people: number; companies: number; projects: number; files: number; meetings: number; promises: number };
}

const PEOPLE = 120;
const FILES = 60;
const MEETINGS = 40;
const PROMISES = 40;

export async function workspaceMap(workspaceId: string, state: State): Promise<WorkspaceMap> {
  const nodes = new Map<string, MapNode>();
  const edges = new Map<string, MapEdge>();
  const edge = (source: string, target: string, kind: MapEdge['kind']) => {
    if (source === target || !nodes.has(source) || !nodes.has(target)) return;
    edges.set([source, target].sort().join('|') + kind, { source, target, kind });
  };

  const projects = Object.values(state.ws.projects).filter((p) => p.status === 'active');
  // Threads by project, and who is on them: how projects and people are tied together.
  const threadsOf = new Map<string, number>();
  const projectPeople = new Map<string, Map<string, number>>();
  for (const t of state.threads) {
    if (!t.project) continue;
    threadsOf.set(t.project, (threadsOf.get(t.project) ?? 0) + 1);
    const people = projectPeople.get(t.project) ?? projectPeople.set(t.project, new Map()).get(t.project)!;
    for (const p of t.participants) if (p.startsWith('mail:')) people.set(p.slice(5).toLowerCase(), (people.get(p.slice(5).toLowerCase()) ?? 0) + 1);
  }

  return withWorkspace({ workspaceId }, async (tx) => {
    const totals = (await tx.query(`select type, count(*)::int as n from entity where workspace_id = $1 and (type <> 'commitment' or coalesce((attrs->>'open')::boolean, true)) group by type`, [workspaceId])).rows.reduce(
      (o, r) => ({ ...o, [r.type as string]: r.n as number }),
      {} as Record<string, number>,
    );

    // The people most in touch, and anyone on a kept project's threads.
    const projectEmails = [...new Set([...projectPeople.values()].flatMap((m) => [...m.keys()]))];
    const people = (
      await tx.query(
        `(select id, key, name, mentions from entity where workspace_id = $1 and type = 'person' order by mentions desc, last_seen desc limit $2)
         union
         (select id, key, name, mentions from entity where workspace_id = $1 and type = 'person' and key = any($3::text[]))`,
        [workspaceId, PEOPLE, projectEmails],
      )
    ).rows as { id: string; key: string; name: string; mentions: number }[];
    // Names as the mail gave them, where the map of people has none (someone first seen as a file's owner).
    const mailNames = new Map<string, string>();
    for (const t of state.threads) for (const [pid, who] of Object.entries(t.ext?.people ?? {})) if (who?.name && !mailNames.has(pid.slice(5).toLowerCase())) mailNames.set(pid.slice(5).toLowerCase(), who.name);
    const personId = new Map<string, string>();
    for (const p of people) {
      const id = `person:${p.key}`;
      personId.set(p.id, id);
      // A name that is only the start of the address ("dana") gives way to the one the mail gave.
      const weak = !p.name || p.name.toLowerCase() === p.key.split('@')[0];
      nodes.set(id, { id, type: 'person', label: (weak ? mailNames.get(p.key) : undefined) || p.name || p.key.split('@')[0]!, sub: p.key, weight: p.mentions, ref: p.key });
    }

    // Their companies.
    const works = (
      await tx.query(
        `select r.from_id, o.key, o.name, o.mentions from relation r join entity o on o.id = r.to_id
         where r.workspace_id = $1 and r.kind = 'works_at' and r.from_id = any($2::text[])`,
        [workspaceId, people.map((p) => p.id)],
      )
    ).rows as { from_id: string; key: string; name: string; mentions: number }[];
    for (const w of works) {
      const id = `company:${w.key}`;
      const person = personId.get(w.from_id)!;
      if (!nodes.has(id)) nodes.set(id, { id, type: 'company', label: w.name || w.key, sub: w.key, weight: 0, ref: w.key });
      nodes.get(id)!.weight += nodes.get(person)!.weight;
      nodes.get(person)!.company = id;
      edge(person, id, 'works_at');
    }

    // The projects, tied to their companies and people.
    const keys = (await tx.query(`select project_id, key from project_key where workspace_id = $1`, [workspaceId])).rows as { project_id: string; key: string }[];
    for (const p of projects) {
      const id = `project:${p.id}`;
      nodes.set(id, { id, type: 'project', label: p.name, sub: p.client ? `With ${p.client}` : undefined, weight: threadsOf.get(p.id) ?? 0, ref: p.id });
      for (const k of keys.filter((k) => k.project_id === p.id)) {
        if (k.key.startsWith('org:')) {
          const company = `company:${k.key.slice(4)}`;
          if (!nodes.has(company)) nodes.set(company, { id: company, type: 'company', label: p.client ?? k.key.slice(4), sub: k.key.slice(4), weight: 0, ref: k.key.slice(4) });
          edge(id, company, 'in_project');
        } else if (k.key.startsWith('person:')) edge(id, `person:${k.key.slice(7)}`, 'in_project');
      }
      // People on its threads who aren't already tied to it through their company.
      for (const [email] of [...(projectPeople.get(p.id) ?? new Map())].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
        const person = `person:${email}`;
        const company = nodes.get(person)?.company;
        if (!company || !edges.has([id, company].sort().join('|') + 'in_project')) edge(id, person, 'in_project');
      }
    }

    // Files and meetings linked to the projects.
    const links = (
      await tx.query(
        `select l.project_id, i.id, i.kind, i.subject, i.snippet, i.occurred_at from project_link l join item i on i.id = l.item_id join connection c on c.id = i.connection_id
         where l.workspace_id = $1 and c.status = 'active' order by i.occurred_at desc`,
        [workspaceId],
      )
    ).rows as { project_id: string; id: string; kind: string; subject: string | null; snippet: string | null; occurred_at: Date }[];
    let files = 0;
    let meetings = 0;
    for (const l of links) {
      const project = `project:${l.project_id}`;
      if (!nodes.has(project)) continue;
      if (l.kind === 'file' && files < FILES) {
        const id = `file:${l.id}`;
        if (!nodes.has(id)) {
          nodes.set(id, { id, type: 'file', label: l.subject || 'File', sub: l.snippet ?? 'File', weight: 1, ref: l.id });
          files++;
        }
        edge(project, id, 'linked');
      } else if (l.kind === 'event' && meetings < MEETINGS) {
        const id = `meeting:${l.id}`;
        if (!nodes.has(id)) {
          nodes.set(id, { id, type: 'meeting', label: l.subject || 'Meeting', sub: new Date(l.occurred_at).toISOString().slice(0, 10), weight: 1, ref: l.id });
          meetings++;
        }
        edge(project, id, 'linked');
      }
    }
    // Files the people on the map own, until there are enough.
    if (files < FILES) {
      const owned = (
        await tx.query(
          `select r.from_id, i.id, i.subject, i.snippet from relation r join entity d on d.id = r.to_id
           join item i on i.workspace_id = d.workspace_id and i.kind = 'file' and (i.connection_id || ':' || i.external_id) = d.key
           join connection c on c.id = i.connection_id
           where r.workspace_id = $1 and r.kind = 'owns' and r.from_id = any($2::text[]) and c.status = 'active'
           order by i.occurred_at desc limit $3`,
          [workspaceId, people.map((p) => p.id), FILES - files],
        )
      ).rows as { from_id: string; id: string; subject: string | null; snippet: string | null }[];
      for (const o of owned) {
        const id = `file:${o.id}`;
        if (!nodes.has(id)) nodes.set(id, { id, type: 'file', label: o.subject || 'File', sub: o.snippet ?? 'File', weight: 1, ref: o.id });
        edge(personId.get(o.from_id)!, id, 'owns');
      }
    }

    // Promises still open, on the people they are with.
    const promises = (
      await tx.query(
        `select c.id, c.name, c.attrs, r.to_id from entity c join relation r on r.from_id = c.id and r.kind in ('promised_by', 'owed_to')
         where c.workspace_id = $1 and c.type = 'commitment' and coalesce((c.attrs->>'open')::boolean, true) and r.to_id = any($2::text[])
         order by c.last_seen desc limit $3`,
        [workspaceId, people.map((p) => p.id), PROMISES],
      )
    ).rows as { id: string; name: string; attrs: { who?: 'them' | 'me'; due?: string | null; threadId?: string }; to_id: string }[];
    for (const c of promises) {
      const id = `promise:${c.id}`;
      if (!nodes.has(id)) nodes.set(id, { id, type: 'promise', label: c.name, weight: 1, ...(c.attrs.who ? { who: c.attrs.who } : {}), ...(c.attrs.due ? { due: c.attrs.due } : {}), ...(c.attrs.threadId ? { ref: c.attrs.threadId } : {}) });
      edge(personId.get(c.to_id)!, id, 'promised');
    }

    return {
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      totals: { people: totals.person ?? 0, companies: totals.organization ?? 0, projects: projects.length, files: totals.document ?? 0, meetings: totals.meeting ?? 0, promises: totals.commitment ?? 0 },
    };
  });
}
