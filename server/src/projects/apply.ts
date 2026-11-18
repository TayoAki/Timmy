/**
 * Keeping what a project scan found (detect.ts). The person says, for each proposal, keep (perhaps renamed), merge
 * into another, or drop. What is kept becomes a project like one made by hand: a numbered folder under Work, a
 * running-notes page, a colour. Its threads are put in it (a thread already in a project stays where it is), its files
 * and meetings are linked to it, and the people or company it is about are remembered so their new mail is filed
 * into it (see sortIntoProjects). Everything here stays inside Timmy: nothing is written to a mailbox or a Drive.
 */
import type { Thread } from '../../../src/data/types';
import type { Project } from '../../../src/data/ws-types';
import type { State } from '../../../src/state/store';
import { applyOps, put, uid, type WsOp } from '../../../src/state/ws';
import { PROJECT_COLORS, WORK_FOLDER, colorVar, numTakenUnderWork, runningNotesOps, slugify, todayLabel } from '../../../src/areas/projects/lib';
import type { Tx } from '../db/pool';
import { audit } from '../gateway/gateway';
import { newId } from '../lib/ids';
import { mutate } from '../state/mutate';
import type { Proposal } from './detect';

export interface Choice {
  id: string;
  keep: boolean;
  name?: string;
  /** Merge this proposal into another kept one. */
  into?: string;
}

export class ApplyError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const KIND_WORDS: Record<string, string> = { client: 'Client work', deal: 'A deal', hiring: 'Hiring', vendor: 'A supplier', internal: 'With colleagues', personal: 'Personal', other: '' };

/** The next free two-digit number under Work, from 10 up. */
function nextNum(state: State, taken: Set<string>): string | null {
  for (let n = 10; n <= 98; n++) {
    const num = String(n);
    if (!taken.has(num) && !numTakenUnderWork(state.ws, num)) return num;
  }
  return null;
}

export async function applyScan(workspaceId: string, userId: string, scanId: string, choices: Choice[]): Promise<{ created: { id: string; name: string; threads: number; files: number; meetings: number }[] }> {
  if (!Array.isArray(choices) || choices.length > 200) throw new ApplyError('Say what to do with each project found.');
  return mutate(workspaceId, 'projects', async (tx, loaded) => {
    const row = (await tx.query(`select status, proposals from project_scan where id = $1 and workspace_id = $2 for update`, [scanId, workspaceId])).rows[0] as { status: string; proposals: Proposal[] } | undefined;
    if (!row) throw new ApplyError('That scan doesn’t exist.', 404);
    if (row.status !== 'ready') throw new ApplyError(row.status === 'applied' ? 'These projects were already created.' : 'The scan hasn’t finished.', 409);
    const byId = new Map(row.proposals.map((p) => [p.id, p]));
    const chosen = new Map<string, Choice>();
    for (const c of choices) {
      if (!c || typeof c.id !== 'string' || !byId.has(c.id)) throw new ApplyError('One of the choices is about a project the scan didn’t find.');
      chosen.set(c.id, c);
    }
    // What is kept, with what is merged into it.
    const kept = row.proposals.filter((p) => chosen.get(p.id)?.keep && !chosen.get(p.id)?.into);
    const keptIds = new Set(kept.map((p) => p.id));
    const merged = new Map<string, Proposal[]>(kept.map((p) => [p.id, [p]]));
    for (const p of row.proposals) {
      const c = chosen.get(p.id);
      if (!c?.into) continue;
      if (!keptIds.has(c.into)) throw new ApplyError('A project can only be merged into one that is kept.');
      merged.get(c.into)!.push(p);
    }

    let state: State = loaded.state;
    const taken = new Set<string>();
    const created: { id: string; name: string; threads: number; files: number; meetings: number }[] = [];
    const claimed = new Set(state.threads.filter((t) => t.project).map((t) => t.id));
    const threadProject = new Map<string, string>();
    for (const [i, p] of kept.entries()) {
      const parts = merged.get(p.id)!;
      const name = (chosen.get(p.id)?.name ?? p.name).replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!name) throw new ApplyError('A kept project needs a name.');
      const num = nextNum(state, taken);
      if (!num) throw new ApplyError('There are no free project numbers left under Work.');
      taken.add(num);
      const color = PROJECT_COLORS[i % PROJECT_COLORS.length]!.id;
      const folderId = state.ws.folders[`f02-${num}`] ? uid('folder') : `f02-${num}`;
      const base = slugify(name) || 'project';
      const id = state.ws.projects[base] || created.some((c) => c.id === base) ? uid(base) : base;
      const docId = uid('doc');
      const org = parts.find((x) => x.organization)?.organization;
      const project: Project = { id, num, name, color: colorVar(color), status: 'active', ...(org ? { client: org.name } : {}), ...(p.summary ? { goal: p.summary } : {}), folder: folderId, notesDoc: docId, sources: [docId] };
      const people = [...new Map(parts.flatMap((x) => x.people).map((x) => [x.email, x])).values()];
      const firstRow = [todayLabel(), `Project found by Timmy from your mail${KIND_WORDS[p.kind] ? ` (${KIND_WORDS[p.kind]!.toLowerCase()})` : ''}. ${people.length ? `People: ${people.slice(0, 5).map((x) => x.name).join(', ')}.` : ''}`.trim(), 'Project page'];
      // Made the way the New project dialog makes one: a folder under Work, a running-notes page, the project.
      const ops: WsOp[] = [put('folders', { id: folderId, num, name, parent: WORK_FOLDER, color: colorVar(color) }), ...runningNotesOps(project, docId, [firstRow]), put('projects', project)];
      state = { ...state, ws: applyOps(state.ws, ops) };
      let threads = 0;
      for (const t of parts.flatMap((x) => x.threads)) {
        if (claimed.has(t) || threadProject.has(t)) continue;
        threadProject.set(t, id);
        threads++;
      }
      const items = [...new Set(parts.flatMap((x) => [...x.files.map((f) => f.itemId), ...x.meetings.map((m) => m.itemId)]))];
      for (const itemId of items) await tx.query(`insert into project_link (workspace_id, project_id, item_id) select $1, $2, id from item where id = $3 and workspace_id = $1 on conflict do nothing`, [workspaceId, id, itemId]);
      for (const key of new Set(parts.flatMap((x) => x.keys))) await tx.query(`insert into project_key (workspace_id, project_id, key) values ($1, $2, $3) on conflict do nothing`, [workspaceId, id, key]);
      created.push({ id, name, threads, files: parts.reduce((n, x) => n + x.files.length, 0), meetings: parts.reduce((n, x) => n + x.meetings.length, 0) });
    }
    const next: State = {
      ...loaded.state,
      ws: withTaskProjects(state.ws, threadProject),
      threads: loaded.state.threads.map((t) => (threadProject.has(t.id) ? ({ ...t, project: threadProject.get(t.id) } as Thread) : t)),
      activity: created.length
        ? [{ id: newId('act'), at: new Date(), kind: 'triage' as const, text: `Timmy created ${created.length === 1 ? `the project ${created[0]!.name}` : `${created.length} projects`} from what it found in your mail and put ${[...threadProject.keys()].length} threads in ${created.length === 1 ? 'it' : 'them'}.` }, ...loaded.state.activity]
        : loaded.state.activity,
    };
    // Once kept, what the scan found (subjects, names, addresses from the mail) is no longer needed, so it isn't kept.
    await tx.query(`update project_scan set status = 'applied', proposals = '[]'::jsonb, finished_at = coalesce(finished_at, now()) where id = $1`, [scanId]);
    await audit(tx, workspaceId, { actor: userId, action: 'projects.created_from_scan', detail: { scan: scanId, created: created.map((c) => c.id), dropped: row.proposals.filter((p) => !chosen.get(p.id)?.keep).length } });
    return { state: next, result: { created } };
  });
}

/**
 * New mail into projects: a thread with no project, whose outside people all belong to the one project that claims
 * them (their company, or the person themselves), is put in that project. Called where mail is stored.
 */
export async function sortIntoProjects(tx: Tx, workspaceId: string, state: State, ids: Set<string>, mine: Set<string>): Promise<State> {
  const open = state.threads.filter((t) => ids.has(t.id) && !t.project);
  if (!open.length) return state;
  const { rows } = await tx.query(`select key, project_id from project_key where workspace_id = $1`, [workspaceId]);
  if (!rows.length) return state;
  const live = new Set(Object.values(state.ws.projects).filter((p) => p.status === 'active').map((p) => p.id));
  const claims = new Map<string, Set<string>>();
  for (const r of rows) if (live.has(r.project_id as string)) (claims.get(r.key as string) ?? claims.set(r.key as string, new Set()).get(r.key as string)!).add(r.project_id as string);
  if (!claims.size) return state;
  const { companyDomain, isAutomatedSender } = await import('../ontology/ontology');
  const placed = new Map<string, string>();
  for (const t of open) {
    const outside = t.participants
      .filter((p) => p.startsWith('mail:'))
      .map((p) => p.slice(5).toLowerCase())
      .filter((e) => !mine.has(e) && !isAutomatedSender(e));
    const projects = new Set<string>();
    for (const e of outside) {
      const domain = companyDomain(e);
      for (const pid of claims.get(domain ? `org:${domain}` : `person:${e}`) ?? []) projects.add(pid);
    }
    if (projects.size === 1) placed.set(t.id, [...projects][0]!);
  }
  if (!placed.size) return state;
  return { ...state, ws: withTaskProjects(state.ws, placed), threads: state.threads.map((t) => (placed.has(t.id) ? ({ ...t, project: placed.get(t.id) } as Thread) : t)) };
}

/** A thread's to-dos go into the project the thread goes into, unless the person already put them somewhere. */
function withTaskProjects(ws: State['ws'], threadProject: Map<string, string>): State['ws'] {
  const moved = Object.values(ws.tasks).filter((t) => t.thread && !t.project && threadProject.has(t.thread));
  if (!moved.length) return ws;
  return { ...ws, tasks: { ...ws.tasks, ...Object.fromEntries(moved.map((t) => [t.id, { ...t, project: threadProject.get(t.thread!)! }])) } };
}
