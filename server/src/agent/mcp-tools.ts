/**
 * Tools Timmy offers only to apps connected over MCP (http/mcp.ts), next to Ask's own (agent/tools.ts). Ask lives
 * inside Timmy, where the person can see their inbox, projects and to-dos; a connected app can't, so it gets a way to
 * see what is waiting, list projects and to-dos, and keep them.
 *
 * What they change is changed through the same command the app sends (state/engine.ts), so every check the app's
 * own buttons pass through applies here too: the role, the project being open, the shape of a to-do. None of them
 * writes to a mailbox, a calendar or anyone else.
 */
import type { Thread } from '../../../src/data/types';
import type { Task } from '../../../src/data/ws-types';
import { readState } from '../state/mutate';
import { runCommand } from '../state/engine';
import { untrusted } from './prompts';
import type { AgentTool } from './tools';

const str = (v: unknown, max = 400) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const day = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 10) : undefined);

/** Who a thread's newest message is from, by name when Timmy knows it. */
function fromOf(t: Thread): string {
  const m = [...t.messages].reverse().find((x) => x.from !== 'me');
  if (!m) return 'you';
  const known = t.ext?.people?.[m.from]?.name;
  const address = m.from.startsWith('mail:') ? m.from.slice(5) : m.from;
  return known ? `${known} <${address}>` : address;
}

/** A project by its id, its name or "[12] Name", among the open ones. */
function projectNamed(projects: Record<string, { id: string; num: string; name: string; status: string }>, named: string) {
  const n = named.trim().toLowerCase();
  return Object.values(projects).find((p) => p.status === 'active' && (p.id === n || p.name.toLowerCase() === n || `[${p.num}] ${p.name}`.toLowerCase() === n));
}

/** A command as the person, from a connected app. The same command id is never reused: each call is its own. */
const command = (t: Parameters<AgentTool['run']>[1], action: Parameters<typeof runCommand>[1]['action']) => runCommand(t.ctx, { id: `mcp:${t.runId}:${t.callId}`.slice(0, 80), action });

const whatsWaiting: AgentTool = {
  kind: 'read',
  step: 'Looking at what is waiting',
  def: {
    name: 'whats_waiting',
    description:
      'What needs the user now, in one look: mail waiting in Triage with Timmy’s suggestion for each, threads in Follow Up (what each asks, and when it is due), threads in Waiting, drafts ready to send, what is waiting for their OK in Approvals, to-dos due within three days, and today’s meetings. Start here when the user asks what is on their plate.',
    parameters: { type: 'object', properties: {} },
  },
  async run(_args, t) {
    const { state } = await readState(t.ctx.workspaceId);
    const newest = (a: Thread, b: Thread) => +new Date(b.messages.at(-1)?.at ?? 0) - +new Date(a.messages.at(-1)?.at ?? 0);
    const soon = Date.now() + 3 * 86_400_000;
    const today = new Date().toISOString().slice(0, 10);
    const triage = state.threads.filter((x) => x.box === 'inbox').sort(newest);
    const brief = {
      triage: { count: triage.length, newest: triage.slice(0, 10).map((x) => ({ id: x.id, from: fromOf(x), subject: x.subject, suggestion: x.suggestion ? `${x.suggestion.box} (${x.suggestion.confidence})` : null })) },
      follow_up: state.threads.filter((x) => x.box === 'follow-up').sort(newest).slice(0, 12).map((x) => ({ id: x.id, from: fromOf(x), subject: x.subject, asks: x.ask, due: day(x.due) })),
      waiting: state.threads.filter((x) => x.box === 'waiting').sort(newest).slice(0, 12).map((x) => ({ id: x.id, subject: x.subject, on: x.waiting?.item, promised: day(x.waiting?.due) })),
      drafts_ready: state.threads.filter((x) => x.draft).slice(0, 12).map((x) => ({ id: x.id, subject: x.draft!.subject })),
      waiting_for_your_ok: state.pending.slice(0, 12).map((p) => p.title),
      to_dos_due: Object.values(state.ws.tasks)
        .filter((x) => x.status !== 'done' && x.due && +new Date(x.due) <= soon)
        .sort((a, b) => +new Date(a.due!) - +new Date(b.due!))
        .slice(0, 12)
        .map((x) => ({ id: x.id, title: x.title, due: day(x.due), project: x.project ? state.ws.projects[x.project]?.name : undefined })),
      meetings_today: Object.values(state.ws.events)
        .filter((e) => new Date(e.start).toISOString().slice(0, 10) === today)
        .sort((a, b) => +new Date(a.start) - +new Date(b.start))
        .map((e) => ({ title: e.title, start: new Date(e.start).toISOString() })),
    };
    // Subjects, names and what a thread asks come from other people's mail.
    return { result: untrusted('brief', brief), outside: true };
  },
};

const listProjects: AgentTool = {
  kind: 'read',
  step: 'Listing projects',
  def: {
    name: 'list_projects',
    description: 'The user’s open projects: number, name, client, goal, and how many open threads and to-dos each has. Use a project’s name with put_in_project, add_task or save_rule.',
    parameters: { type: 'object', properties: {} },
  },
  async run(_args, t) {
    const { state } = await readState(t.ctx.workspaceId);
    const rows = Object.values(state.ws.projects)
      .filter((p) => p.status === 'active')
      .sort((a, b) => a.num.localeCompare(b.num))
      .map((p) => ({
        id: p.id,
        number: p.num,
        name: p.name,
        client: p.client,
        goal: p.goal,
        open_threads: state.threads.filter((x) => x.project === p.id && x.box !== 'archived').length,
        open_to_dos: Object.values(state.ws.tasks).filter((x) => x.project === p.id && x.status !== 'done').length,
      }));
    return { result: rows.length ? untrusted('projects', rows) : 'The user has no open projects.' };
  },
};

const listTasks: AgentTool = {
  kind: 'read',
  step: 'Listing to-dos',
  def: {
    name: 'list_tasks',
    description: 'The user’s to-dos, soonest due first: open ones, or finished ones too. Optionally only one project’s (by name).',
    parameters: { type: 'object', properties: { project: { type: 'string', description: 'A project’s name' }, include_done: { type: 'boolean' } } },
  },
  async run(args, t) {
    const { state } = await readState(t.ctx.workspaceId);
    const project = typeof args.project === 'string' && args.project.trim() ? projectNamed(state.ws.projects, args.project) : undefined;
    if (typeof args.project === 'string' && args.project.trim() && !project) return { result: `There is no open project called “${str(args.project, 80)}”.` };
    const rows = Object.values(state.ws.tasks)
      .filter((x) => (args.include_done === true || x.status !== 'done') && (!project || x.project === project.id))
      .sort((a, b) => (a.due ? +new Date(a.due) : Infinity) - (b.due ? +new Date(b.due) : Infinity))
      .slice(0, 50)
      .map((x) => ({ id: x.id, title: x.title, status: x.status, due: day(x.due), project: x.project ? state.ws.projects[x.project]?.name : undefined, thread: x.thread, from_email: x.by === 'timmy' }));
    return { result: rows.length ? untrusted('tasks', rows) : 'No to-dos.' };
  },
};

const addTask: AgentTool = {
  kind: 'internal',
  step: 'Adding a to-do',
  def: {
    name: 'add_task',
    description: 'Add a to-do to the user’s list in Timmy, optionally with a due date, a project (by name) and the email thread it is about. Use it when the user asks you to remember or track something.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, due: { type: 'string', description: 'YYYY-MM-DD' }, project: { type: 'string', description: 'A project’s name' }, thread: { type: 'string', description: 'A thread id' } },
      required: ['title'],
    },
  },
  async run(args, t) {
    const title = str(args.title, 160);
    if (title.length < 2) return { result: 'A to-do needs a title. Nothing was added.' };
    const { state } = await readState(t.ctx.workspaceId);
    const project = typeof args.project === 'string' && args.project.trim() ? projectNamed(state.ws.projects, args.project) : undefined;
    if (typeof args.project === 'string' && args.project.trim() && !project) return { result: `There is no open project called “${str(args.project, 80)}”. Nothing was added.` };
    const thread = typeof args.thread === 'string' ? state.threads.find((x) => x.id === args.thread) : undefined;
    const due = typeof args.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.due) ? new Date(`${args.due}T17:00:00`) : undefined;
    const task: Task = { id: `tsk-mcp-${t.runId}`.slice(0, 60), title, status: 'todo', priority: 'normal', created: new Date(), ...(due ? { due } : {}), ...((project?.id ?? thread?.project) ? { project: project?.id ?? thread?.project } : {}), ...(thread ? { thread: thread.id } : {}) };
    const r = await command(t, { type: 'ws', ops: [{ op: 'put', col: 'tasks', item: task }] });
    return { result: r.ok ? `Added to the user’s to-dos: “${title}”${due ? `, due ${args.due}` : ''}${project ? `, in ${project.name}` : ''}.` : `Nothing was added: ${r.error}` };
  },
};

const completeTask: AgentTool = {
  kind: 'internal',
  step: 'Checking off a to-do',
  def: {
    name: 'complete_task',
    description: 'Mark one of the user’s to-dos done (by its id from list_tasks or whats_waiting), or open again with done: false.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, done: { type: 'boolean' } }, required: ['id'] },
  },
  async run(args, t) {
    const id = str(args.id, 120);
    const { state } = await readState(t.ctx.workspaceId);
    const task = state.ws.tasks[id];
    if (!task) return { result: 'There is no to-do with that id.' };
    const done = args.done !== false;
    const r = await command(t, { type: 'ws', ops: [{ op: 'patch', col: 'tasks', id, patch: { status: done ? 'done' : 'todo' } }] });
    return { result: r.ok ? `${done ? 'Done' : 'Open again'}: “${task.title}”.` : `Nothing changed: ${r.error}` };
  },
};

const putInProject: AgentTool = {
  kind: 'internal',
  step: 'Putting the thread in a project',
  def: {
    name: 'put_in_project',
    description: 'Put one email thread (by id) in one of the user’s projects (by name), or take it out with project: null. Its to-dos go with it. Nothing changes in the mailbox. To do this for all mail from someone from now on, use save_rule instead.',
    parameters: { type: 'object', properties: { thread: { type: 'string' }, project: { type: ['string', 'null'], description: 'A project’s name, or null to take it out' } }, required: ['thread', 'project'] },
  },
  async run(args, t) {
    const id = str(args.thread, 200);
    const { state } = await readState(t.ctx.workspaceId);
    const thread = state.threads.find((x) => x.id === id);
    if (!thread) return { result: 'There is no thread with that id.' };
    const project = typeof args.project === 'string' && args.project.trim() ? projectNamed(state.ws.projects, args.project) : null;
    if (typeof args.project === 'string' && args.project.trim() && !project) return { result: `There is no open project called “${str(args.project, 80)}”. Nothing changed.` };
    const r = await command(t, { type: 'setProject', id, project: project?.id ?? null });
    return { result: r.ok ? (project ? `The thread is in ${project.name} now.` : 'The thread is in no project now.') : `Nothing changed: ${r.error}` };
  },
};

export const MCP_TOOLS: AgentTool[] = [whatsWaiting, listProjects, listTasks, addTask, completeTask, putInProject];
