/*
 * Selectors for the Projects area. A project links a numbered Drive folder,
 * its tasks, its mail label, a running-notes doc and (optionally) a deal.
 */
import { NOW } from '../../data/mock';
import type { Deal, Thread } from '../../data/types';
import type { Block, DocBody, Project, Task, WFile, WS } from '../../data/ws-types';
import { fmtDay, money } from '../../lib/format';
import { firstName, patch, put, uid, type WsOp } from '../../state/ws';

export const WORK_FOLDER = 'f02';
export const ARCHIVE_FOLDER = 'f99';

/** The label colours a project can take, in the order the picker shows them. */
export const PROJECT_COLORS = [
  { id: 'green', label: 'Green' },
  { id: 'sky', label: 'Blue' },
  { id: 'violet', label: 'Violet' },
  { id: 'pink', label: 'Pink' },
  { id: 'teal', label: 'Teal' },
  { id: 'amber', label: 'Amber' },
  { id: 'red', label: 'Red' },
  { id: 'indigo', label: 'Indigo' },
  { id: 'brown', label: 'Brown' },
  { id: 'slate', label: 'Slate' },
] as const;

export const colorVar = (id: string) => `var(--c-${id})`;

const byNum = (a: Project, b: Project) => a.num.localeCompare(b.num);

export const activeProjects = (ws: WS) => Object.values(ws.projects).filter((p) => p.status === 'active').sort(byNum);
export const archivedProjects = (ws: WS) => Object.values(ws.projects).filter((p) => p.status === 'archived').sort(byNum);

/** The folder and every folder below it. */
export const folderTree = (ws: WS, root: string): Set<string> => {
  const ids = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of Object.values(ws.folders)) {
      if (f.parent && ids.has(f.parent) && !ids.has(f.id)) {
        ids.add(f.id);
        grew = true;
      }
    }
  }
  return ids;
};

const newestFirst = (a: WFile, b: WFile) => b.updated.getTime() - a.updated.getTime();

export const folderFiles = (ws: WS, folder: string): WFile[] => {
  const tree = folderTree(ws, folder);
  return Object.values(ws.files)
    .filter((f) => tree.has(f.folder))
    .sort(newestFirst);
};

export const projectFiles = (ws: WS, p: Project) => folderFiles(ws, p.folder);

/** Docs in the project folder, running notes first. */
export const projectDocs = (ws: WS, p: Project) => {
  const docs = projectFiles(ws, p).filter((f) => f.kind === 'doc');
  return [...docs.filter((f) => f.id === p.notesDoc), ...docs.filter((f) => f.id !== p.notesDoc)];
};

export const projectTasks = (ws: WS, id: string) => Object.values(ws.tasks).filter((t) => t.project === id);

const dueOrder = (a: Task, b: Task) => (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity);

export const openTasks = (ws: WS, id: string) =>
  projectTasks(ws, id)
    .filter((t) => t.status !== 'done')
    .sort(dueOrder);

export const sortTasks = (tasks: Task[]) => [...tasks].sort(dueOrder);

export const projectThreads = (threads: Thread[], id: string) => threads.filter((t) => t.project === id);

export const waitingThreads = (threads: Thread[], id: string) => threads.filter((t) => t.project === id && t.box === 'waiting');

/** Everyone on the project's threads except you, most active first. */
export const projectPeople = (threads: Thread[], id: string) => {
  const counts = new Map<string, number>();
  for (const t of projectThreads(threads, id)) {
    for (const p of t.participants) if (p !== 'me') counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
};

export interface Deadline {
  key: string;
  label: string;
  due: Date;
  kind: 'task' | 'waiting' | 'reply';
  task?: string;
  thread?: string;
  who?: string;
}

/** Open task dates, promised dates in Waiting and reply deadlines, soonest first. */
export const deadlines = (ws: WS, threads: Thread[], id: string): Deadline[] => {
  const tasks = openTasks(ws, id);
  const taskThreads = new Set(tasks.map((t) => t.thread).filter(Boolean));
  const out: Deadline[] = [
    ...tasks.filter((t) => t.due).map((t) => ({ key: `t-${t.id}`, label: t.title, due: t.due!, kind: 'task' as const, task: t.id, thread: t.thread })),
    ...projectThreads(threads, id)
      .filter((t) => t.box === 'waiting' && t.waiting?.due)
      .map((t) => ({ key: `w-${t.id}`, label: t.waiting!.item, due: t.waiting!.due!, kind: 'waiting' as const, thread: t.id, who: t.waiting!.on })),
    ...projectThreads(threads, id)
      .filter((t) => t.box === 'follow-up' && t.due && !taskThreads.has(t.id))
      .map((t) => ({ key: `r-${t.id}`, label: t.ask, due: t.due!, kind: 'reply' as const, thread: t.id })),
  ];
  return out.sort((a, b) => a.due.getTime() - b.due.getTime());
};

export const projectDeal = (deals: Record<string, Deal>, p: Project) => (p.deal ? deals[p.deal] : undefined);

/* ───────────── Running notes ───────────── */

export type TableBlock = Extract<Block, { type: 'table' }>;

export const notesTable = (ws: WS, p: Project): TableBlock | undefined => {
  const doc = p.notesDoc ? ws.docs[p.notesDoc] : undefined;
  const block = doc?.blocks.find((b) => b.type === 'table');
  return block?.type === 'table' ? block : undefined;
};

export const NOTES_COLUMNS = ['Date', 'Decision or update', 'Source'];

export const todayLabel = () => NOW.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** A running-notes doc for a project: a WFile in its folder and the doc body. */
export const runningNotesOps = (p: Pick<Project, 'id' | 'name' | 'folder'>, docId: string, rows: string[][]): WsOp[] => {
  const file: WFile = { id: docId, name: `${p.name} — Running notes`, kind: 'doc', folder: p.folder, updated: NOW, owner: 'me', project: p.id };
  const body: DocBody = {
    id: docId,
    template: 'running-notes',
    blocks: [
      { id: uid('b'), type: 'p', text: `Decisions and status for ${p.name}, newest first. Linked from the project page.` },
      { id: uid('b'), type: 'table', columns: NOTES_COLUMNS, rows },
    ],
  };
  return [put('files', file), put('docs', body)];
};

/** For projects without running notes yet: create the doc with this first row. */
export const createNotesWithRow = (p: Project, row: string[]): WsOp[] => {
  const docId = uid('doc');
  return [...runningNotesOps(p, docId, [row]), patch('projects', p.id, { notesDoc: docId })];
};

/* ───────────── Numbering ───────────── */

/** The next free two-digit number under [02] Work, after every project number in use. */
export const nextProjectNum = (ws: WS) => {
  const used = new Set([
    ...Object.values(ws.folders)
      .filter((f) => f.parent === WORK_FOLDER)
      .map((f) => f.num),
    ...Object.values(ws.projects).map((p) => p.num),
  ]);
  const top = Math.max(9, ...[...used].map(Number).filter((n) => n < 99));
  for (let n = top + 1; n < 99; n++) {
    const s = String(n).padStart(2, '0');
    if (!used.has(s)) return s;
  }
  for (let n = 10; n < 99; n++) {
    const s = String(n).padStart(2, '0');
    if (!used.has(s)) return s;
  }
  return '98';
};

export const numTakenUnderWork = (ws: WS, num: string, exceptFolder?: string) =>
  Object.values(ws.folders).some((f) => f.parent === WORK_FOLDER && f.num === num && f.id !== exceptFolder);

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

/* ───────────── Project update ───────────── */

const lowerFirst = (s: string) => (/^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

/** A five-line update (progress, numbers, risks, asks, next week) from the running notes and tasks. */
export const projectUpdate = (ws: WS, threads: Thread[], deals: Record<string, Deal>, p: Project) => {
  const rows = notesTable(ws, p)?.rows ?? [];
  const tasks = projectTasks(ws, p.id);
  const done = tasks.filter((t) => t.status === 'done').length;
  const open = sortTasks(tasks.filter((t) => t.status !== 'done'));
  const deal = projectDeal(deals, p);
  const waiting = waitingThreads(threads, p.id);
  const late = [
    ...open.filter((t) => t.due && t.due < NOW).map((t) => t.title),
    ...waiting.filter((t) => t.waiting?.due && t.waiting.due < NOW).map((t) => `${lowerFirst(t.waiting!.item)} from ${firstName(t.waiting!.on)}`),
  ];
  const progress = rows.slice(0, 2).map((r) => `${r[1]} (${r[0]})`);
  const asks = waiting.map((t) => `${firstName(t.waiting!.on)}: ${lowerFirst(t.waiting!.item)}${t.waiting!.due ? ` by ${fmtDay(t.waiting!.due)}` : ''}`);
  const next = open.slice(0, 3).map((t) => (t.due ? `${t.title} (${fmtDay(t.due)})` : t.title));

  const lines = [
    `Progress: ${progress.length ? progress.join('; ') : 'No decisions recorded yet.'}`,
    `Numbers: ${done} of ${tasks.length} tasks done${deal ? `; deal at ${money(deal.value)}, ${deal.stage}` : ''}.`,
    `Risks: ${late.length ? `late on ${late.join('; ')}` : 'nothing late.'}`,
    `Asks: ${asks.length ? asks.join('; ') : 'none this week.'}`,
    `Next week: ${next.length ? next.join('; ') : 'plan the next steps.'}`,
  ];
  return {
    subject: `${p.name}: weekly update`,
    body: `Hi all,\n\nHere is where ${p.name} stands this week.\n\n${lines.join('\n')}\n\nBest,\nTaylor`,
  };
};
