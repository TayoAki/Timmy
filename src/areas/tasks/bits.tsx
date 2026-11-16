/*
 * Small pieces the Tasks screens, dialogs and quick capture share.
 */
import { Circle, CircleCheck, CircleDot, Flag, type LucideIcon } from 'lucide-react';
import { NOW } from '../../data/mock';
import type { Priority, QuickNote, Task, TaskStatus, WS } from '../../data/ws-types';
import { parseIsoDay } from '../../state/ws';

export const STATUSES: { id: TaskStatus; label: string; icon: LucideIcon; color: string }[] = [
  { id: 'todo', label: 'To do', icon: Circle, color: 'var(--text-3)' },
  { id: 'doing', label: 'In progress', icon: CircleDot, color: 'var(--c-amber)' },
  { id: 'done', label: 'Done', icon: CircleCheck, color: 'var(--ok)' },
];

export const statusMeta = (s: TaskStatus) => STATUSES.find((x) => x.id === s)!;

export const PRIORITIES: { id: Priority; label: string }[] = [
  { id: 'high', label: 'Urgent' },
  { id: 'normal', label: 'Normal' },
  { id: 'low', label: 'Low' },
];

/** A task saved without a priority (an older or hand-made record) reads as Normal instead of breaking the screen. */
export const priorityLabel = (p: Priority) => PRIORITIES.find((x) => x.id === p)?.label ?? 'Normal';

const RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

const dueMs = (t: Task) => t.due?.getTime() ?? Number.POSITIVE_INFINITY;

/** Soonest due first; undated last; ties broken by priority. */
export const byDue = (a: Task, b: Task) => dueMs(a) - dueMs(b) || (RANK[a.priority] ?? 1) - (RANK[b.priority] ?? 1);

/** Most urgent first, then soonest due. */
export const byPriority = (a: Task, b: Task) => RANK[a.priority] - RANK[b.priority] || dueMs(a) - dueMs(b);

export const END_OF_TODAY = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 23, 59);

/** Open and due today or earlier. */
export const isDueNow = (t: Task) => t.status !== 'done' && !!t.due && t.due <= END_OF_TODAY;

export const openTasks = (ws: WS) => Object.values(ws.tasks).filter((t) => t.status !== 'done');

/** The review queue: captured notes not yet processed, oldest first. */
export const reviewQueue = (ws: WS): QuickNote[] =>
  Object.values(ws.notes)
    .filter((n) => !n.processed)
    .sort((a, b) => a.created.getTime() - b.created.getTime());

export const activeProjects = (ws: WS) =>
  Object.values(ws.projects)
    .filter((p) => p.status === 'active')
    .sort((a, b) => a.num.localeCompare(b.num));

/** yyyy-mm-dd → a due date, keeping the time of day of the previous due (default 5 PM). */
export const dueFromIso = (iso: string, prev?: Date) =>
  iso ? parseIsoDay(iso, prev?.getHours() ?? 17, prev?.getMinutes() ?? 0) : undefined;

export function StatusIcon({ status, size = 15 }: { status: TaskStatus; size?: number }) {
  const m = statusMeta(status);
  return <m.icon size={size} className="tk-status-icon" style={{ color: m.color }} aria-hidden />;
}

export function PriorityChip({ priority }: { priority: Priority }) {
  return (
    <span className={`chip tk-prio tk-prio-${priority}`}>
      <Flag size={12} aria-hidden />
      {priorityLabel(priority)}
    </span>
  );
}
