import {
  CalendarClock,
  CalendarPlus,
  ChevronDown,
  CircleCheck,
  Columns3,
  Inbox,
  Layers,
  Lightbulb,
  Link2,
  List,
  ListChecks,
  Mail,
  Pencil,
  Plus,
  Target,
  Trash2,
  Zap,
} from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import { Avatar, DueChip, Folder, Kbd } from '../../components/common';
import { Frame } from '../../components/Frame';
import { Menu, SideHead } from '../../components/kit';
import { NOW, PEOPLE } from '../../data/mock';
import type { Thread } from '../../data/types';
import type { Priority, Task, TaskStatus } from '../../data/ws-types';
import { dueInfo, fmtDay, plural } from '../../lib/format';
import { useStore, ws, type Route } from '../../state/store';
import { patch, remove, type WsOp } from '../../state/ws';
import { BlockTimeDialog } from '../calendar/BlockTimeDialog';
import { fmtRange, showEvent } from '../calendar/shared';
import { activeProjects, byDue, byPriority, isDueNow, openTasks, PRIORITIES, PriorityChip, reviewQueue, statusMeta, StatusIcon, STATUSES } from './bits';
import { Review } from './Review';
import { TaskDialog } from './TaskDialog';

type TasksRoute = Extract<Route, { view: 'tasks' }>;
type Tab = TasksRoute['tab'];

const useTasksRoute = (): TasksRoute => {
  const { state } = useStore();
  return state.route.view === 'tasks' ? state.route : { view: 'tasks', tab: 'board' };
};

const clip = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** People linked to a task: its contact, then whoever else is on the email. */
const linkedPeople = (t: Task, thread?: Thread) => {
  const ids = [t.contact, ...(thread?.participants ?? [])].filter((p): p is string => !!p && p !== 'me' && !PEOPLE[p]?.bot);
  return [...new Set(ids)].slice(0, 3);
};

/** Shared task actions: move, delete, highlight. */
function useTaskActions() {
  const { dispatch } = useStore();
  return {
    move: (t: Task, status: TaskStatus) => {
      if (t.status === status) return;
      dispatch(ws([patch('tasks', t.id, { status })], { toast: `“${clip(t.title)}” moved to ${statusMeta(status).label}`, undo: true }));
    },
    del: (t: Task, linkedFocus?: string) => {
      const ops: WsOp[] = [remove('tasks', t.id)];
      if (linkedFocus) ops.push(remove('events', linkedFocus));
      dispatch(ws(ops, { toast: 'Task deleted', undo: true }));
    },
    highlight: (t: Task) => {
      dispatch({ type: 'setHighlight', text: t.title });
      dispatch({ type: 'toast', text: `Today’s highlight: ${clip(t.title, 60)}` });
    },
  };
}

/* ───────────── Main view ───────────── */

export function TasksView() {
  const { state, dispatch } = useStore();
  const r = useTasksRoute();
  const tab = r.tab;
  // With a project picked in the sidebar, the board shows it unless a project is chosen here.
  const project = r.project ?? state.scope ?? undefined;
  const [priority, setPriority] = useState<Priority | ''>('');
  const [showDone, setShowDone] = useState(false);
  const [editing, setEditing] = useState<Partial<Task> | null>(null);
  const [blockFor, setBlockFor] = useState<Task | null>(null);
  const closeEdit = useCallback(() => setEditing(null), []);
  const closeBlock = useCallback(() => setBlockFor(null), []);

  const queue = reviewQueue(state.ws);
  const all = Object.values(state.ws.tasks);
  const projects = activeProjects(state.ws);
  const proj = project && project !== 'none' ? state.ws.projects[project] : undefined;

  const filtered = all
    .filter((t) => !project || (project === 'none' ? !t.project : t.project === project))
    .filter((t) => !priority || t.priority === priority);
  const open = filtered.filter((t) => t.status !== 'done');
  const dueNow = open.filter(isDueNow).length;

  const go = (change: Partial<TasksRoute>) => dispatch({ type: 'navigate', route: { view: 'tasks', tab, project, ...change } });

  const title = tab === 'review' ? 'Review queue' : proj ? `${proj.name} tasks` : project === 'none' ? 'Tasks without a project' : 'Tasks';
  const sub =
    tab === 'review'
      ? 'Everything you captured, oldest first. Give each item a home: a task, a permanent note, the calendar or the archive.'
      : `${plural(open.length, 'open task')}${dueNow ? `, ${dueNow} due today or overdue` : ''}. ${
          tab === 'board' ? 'Drag a card to change its status, or use its menu.' : 'Sorted by due date.'
        }`;

  return (
    <Frame
      tabs={[
        { id: 'board', label: 'Board' },
        { id: 'list', label: 'List' },
        { id: 'review', label: 'Review', count: queue.length },
      ]}
      active={tab}
      onTab={(id) => go({ tab: id as Tab })}
      wide
      scrollKey={tab}
    >
      <div className="tk-head">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-sub">{sub}</p>
        </div>
      </div>

      {tab !== 'review' && (
        <div className="filters tk-filters">
          <label className="filter">
            <select value={project ?? ''} onChange={(e) => go({ project: e.target.value || undefined })} aria-label="Filter by project">
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="none">No project</option>
            </select>
            <ChevronDown size={14} />
          </label>
          <label className="filter">
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority | '')} aria-label="Filter by priority">
              <option value="">Any priority</option>
              {PRIORITIES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <ChevronDown size={14} />
          </label>
          <button className="filter" aria-pressed={showDone} onClick={() => setShowDone((v) => !v)}>
            <CircleCheck size={14} />
            Show done
          </button>
          {(project || priority) && (
            <button className="btn btn-xs btn-ghost" onClick={() => (setPriority(''), go({ project: undefined }))}>
              Clear
            </button>
          )}
          <button className="btn btn-primary btn-sm tk-new" onClick={() => setEditing({ project: proj?.id })}>
            <Plus size={15} />
            New task
          </button>
        </div>
      )}

      {tab === 'board' && (
        <Board tasks={filtered} showDone={showDone} onShowDone={() => setShowDone(true)} onOpen={(t) => setEditing(t)} onBlock={setBlockFor} onNew={() => setEditing({ project: proj?.id })} />
      )}
      {tab === 'list' && <TaskList tasks={showDone ? filtered : open} onOpen={(t) => setEditing(t)} onNew={() => setEditing({ project: proj?.id })} />}
      {tab === 'review' && <Review />}

      <TaskDialog open={!!editing} onClose={closeEdit} initial={editing ?? undefined} />
      <BlockTimeDialog open={!!blockFor} onClose={closeBlock} title={blockFor?.title ?? ''} task={blockFor?.id} thread={blockFor?.thread} minutes={60} />
    </Frame>
  );
}

/* ───────────── Board ───────────── */

function Board({
  tasks,
  showDone,
  onShowDone,
  onOpen,
  onBlock,
  onNew,
}: {
  tasks: Task[];
  showDone: boolean;
  onShowDone: () => void;
  onOpen: (t: Task) => void;
  onBlock: (t: Task) => void;
  onNew: () => void;
}) {
  const { state } = useStore();
  const { move } = useTaskActions();
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);

  return (
    <div className="tk-board">
      {STATUSES.map((s) => {
        const items = tasks.filter((t) => t.status === s.id).sort(s.id === 'done' ? (a, b) => b.created.getTime() - a.created.getTime() : byPriority);
        const collapsed = s.id === 'done' && !showDone;
        return (
          <section
            key={s.id}
            className="tk-col"
            aria-labelledby={`tk-col-${s.id}`}
            data-over={(over === s.id && dragId && state.ws.tasks[dragId]?.status !== s.id) || undefined}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (over !== s.id) setOver(s.id);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === s.id ? null : o));
            }}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData('text/plain') || dragId;
              const t = id ? state.ws.tasks[id] : undefined;
              if (t) move(t, s.id);
              setOver(null);
              setDragId(null);
            }}
          >
            <header className="tk-col-head">
              <s.icon size={16} style={{ color: s.color }} aria-hidden />
              <h2 className="tk-col-title" id={`tk-col-${s.id}`}>
                {s.label}
              </h2>
              <span className="tk-count mono">{items.length}</span>
              {s.id === 'todo' && (
                <button className="icon-btn sm tk-col-add" aria-label="Add a task" onClick={onNew}>
                  <Plus size={15} />
                </button>
              )}
            </header>
            <div className="tk-col-body">
              {!collapsed &&
                items.map((t) => (
                  <TaskCard
                    key={t.id}
                    t={t}
                    dragging={dragId === t.id}
                    onDragStart={() => setDragId(t.id)}
                    onDragEnd={() => (setDragId(null), setOver(null))}
                    onOpen={onOpen}
                    onBlock={onBlock}
                  />
                ))}
              {collapsed && (
                <div className="tk-drop">
                  <span>Drop a card here to mark it done.</span>
                  {items.length > 0 && (
                    <button className="btn btn-xs" onClick={onShowDone}>
                      Show {items.length} done
                    </button>
                  )}
                </div>
              )}
              {!collapsed && items.length === 0 && <div className="tk-drop">{s.id === 'doing' ? 'Drag what you’re working on here.' : 'Nothing here.'}</div>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function TaskCard({
  t,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
  onBlock,
}: {
  t: Task;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: (t: Task) => void;
  onBlock: (t: Task) => void;
}) {
  const { state, dispatch } = useStore();
  const { move, del, highlight } = useTaskActions();
  const project = t.project ? state.ws.projects[t.project] : undefined;
  const thread = t.thread ? state.threads.find((x) => x.id === t.thread) : undefined;
  const ev = t.event ? state.ws.events[t.event] : undefined;
  const people = linkedPeople(t, thread);
  const done = t.status === 'done';

  return (
    <article
      className="tk-card"
      draggable
      data-dragging={dragging || undefined}
      data-done={done || undefined}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', t.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(t)}
    >
      <div className="tk-card-top">
        <PriorityChip priority={t.priority} />
        <span onClick={(e) => e.stopPropagation()}>
          <Menu
            label={`Actions for ${t.title}`}
            items={[
              ...STATUSES.filter((s) => s.id !== t.status).map((s) => ({ label: `Move to ${s.label}`, icon: s.icon, onSelect: () => move(t, s.id) })),
              { label: 'Edit', icon: Pencil, onSelect: () => onOpen(t) },
              { label: 'Block time', icon: CalendarPlus, onSelect: () => onBlock(t), disabled: done },
              { label: 'Make today’s highlight', icon: Target, onSelect: () => highlight(t), disabled: done || state.highlight === t.title },
              { label: 'Delete', icon: Trash2, danger: true, onSelect: () => del(t, ev?.kind === 'focus' && ev.task === t.id ? ev.id : undefined) },
            ]}
          />
        </span>
      </div>
      <button
        className="tk-card-title"
        onClick={(e) => {
          e.stopPropagation();
          onOpen(t);
        }}
      >
        {t.title}
      </button>
      <div className="tk-card-sub">
        {project ? (
          <>
            <Folder color={project.color} size={15} />
            <span>{project.name}</span>
          </>
        ) : (
          <span className="muted">No project</span>
        )}
      </div>
      {(t.due || ev || people.length > 0 || thread) && (
        <div className="tk-card-foot">
          <div className="chips">
            {t.due && !done && <DueChip due={t.due} />}
            {ev && !done && (
              <span className="chip accent" title={`${ev.title}, ${fmtDay(ev.start)} ${fmtRange(ev.start, ev.end)}`}>
                <CalendarClock size={12} />
                {fmtDay(ev.start).split(',')[0]} {fmtRange(ev.start, ev.end).split(' – ')[0]}
              </span>
            )}
          </div>
          <div className="tk-card-links">
            {people.length > 0 && (
              <span className="tk-avatars" aria-label={`Linked: ${people.map((p) => PEOPLE[p]?.name ?? p).join(', ')}`}>
                {people.map((p) => (
                  <Avatar key={p} id={p} size={22} />
                ))}
              </span>
            )}
            {thread && (
              <button
                className="icon-btn sm"
                aria-label={`Open the source email: ${thread.subject}`}
                title={thread.subject}
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: 'openThread', id: thread.id });
                }}
              >
                <Link2 size={15} />
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

/* ───────────── List ───────────── */

function TaskList({ tasks, onOpen, onNew }: { tasks: Task[]; onOpen: (t: Task) => void; onNew: () => void }) {
  const { state, dispatch } = useStore();
  const { move } = useTaskActions();
  const rows = [...tasks].sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || byDue(a, b));

  if (rows.length === 0) {
    return (
      <div className="empty">
        <span className="empty-icon">
          <CircleCheck size={20} />
        </span>
        <strong>No tasks match</strong>
        <span>Clear the filters or add a task.</span>
        <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={onNew}>
          <Plus size={14} />
          New task
        </button>
      </div>
    );
  }

  return (
    <div className="table tk-table">
      <div className="table-row table-head">
        <span>Task</span>
        <span>Project</span>
        <span>Due</span>
        <span>Priority</span>
        <span>Status</span>
        <span className="tk-src-head">Source</span>
      </div>
      {rows.map((t) => {
        const project = t.project ? state.ws.projects[t.project] : undefined;
        const thread = t.thread ? state.threads.find((x) => x.id === t.thread) : undefined;
        return (
          <div key={t.id} className="table-row" data-done={t.status === 'done' || undefined} onClick={() => onOpen(t)}>
            <span className="tk-cell-task">
              <StatusIcon status={t.status} />
              <span className="tk-cell-text">
                <button
                  className="tk-row-title"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(t);
                  }}
                >
                  {t.title}
                </button>
                <span className="tk-cell-sub">
                  <span>{project?.name ?? 'No project'}</span>
                  {t.due && <span className="tk-sub-due"> · {dueInfo(t.due).label}</span>}
                </span>
              </span>
            </span>
            <span className="tk-cell-project">
              {project ? (
                <>
                  <Folder color={project.color} size={15} />
                  <span>{project.name}</span>
                </>
              ) : (
                <span className="muted">None</span>
              )}
            </span>
            <span>{t.due ? <DueChip due={t.due} /> : <span className="muted">No date</span>}</span>
            <span>
              <PriorityChip priority={t.priority} />
            </span>
            <span onClick={(e) => e.stopPropagation()}>
              <select className="input tk-status-select" value={t.status} onChange={(e) => move(t, e.target.value as TaskStatus)} aria-label={`Status of ${t.title}`}>
                {STATUSES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </span>
            <span className="tk-src">
              {thread ? (
                <button
                  className="icon-btn sm"
                  aria-label={`Open the source email: ${thread.subject}`}
                  title={thread.subject}
                  onClick={(e) => {
                    e.stopPropagation();
                    dispatch({ type: 'openThread', id: thread.id });
                  }}
                >
                  <Mail size={15} />
                </button>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ───────────── Sidebar ───────────── */

export function TasksSide() {
  const { state, dispatch } = useStore();
  const r = state.route.view === 'tasks' ? state.route : null;
  const shown = r ? (r.project ?? state.scope ?? undefined) : undefined;
  const [creating, setCreating] = useState(false);
  const closeCreate = useCallback(() => setCreating(false), []);
  const queue = reviewQueue(state.ws).length;
  const open = openTasks(state.ws);
  const projects = activeProjects(state.ws);
  const nav = (route: TasksRoute) => dispatch({ type: 'navigate', route });
  const listTab: Tab = r && r.tab !== 'review' ? r.tab : 'board';

  const views: { id: Tab; label: string; hint: string; icon: typeof Columns3; count?: number }[] = [
    { id: 'board', label: 'Board', hint: 'To do, in progress, done', icon: Columns3 },
    { id: 'list', label: 'List', hint: 'Sorted by due date', icon: List },
    { id: 'review', label: 'Review', hint: 'Captured, not yet sorted', icon: Inbox, count: queue },
  ];

  return (
    <>
      <SideHead
        icon={<ListChecks size={18} />}
        title="Tasks"
        sub={`${open.length} open · ${queue} to review`}
        action={
          <div className="tk-side-actions">
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={15} />
              New task
            </button>
            <button className="btn tk-capture-btn" onClick={() => dispatch({ type: 'capture', open: true })}>
              <Zap size={15} />
              Quick capture
              <Kbd>⌘J</Kbd>
            </button>
          </div>
        }
      />
      <div className="side-scroll">
        <div className="side-group">
          <div className="side-title">Views</div>
          {views.map((v) => (
            <button
              key={v.id}
              className="nav-item"
              aria-current={r?.tab === v.id ? 'page' : undefined}
              onClick={() => nav({ view: 'tasks', tab: v.id, project: v.id === 'review' ? undefined : r?.project })}
            >
              <span className="nav-icon">
                <v.icon size={16} />
              </span>
              <span className="nav-text">
                <span className="nav-name">{v.label}</span>
                <span className="nav-hint">{v.hint}</span>
              </span>
              {v.count !== undefined && <span className={`nav-count${v.count ? ' strong' : ''}`}>{v.count || ''}</span>}
            </button>
          ))}
        </div>

        <div className="side-group">
          <div className="side-title">Projects</div>
          <button
            className="nav-item compact"
            aria-current={r && r.tab !== 'review' && !shown ? 'page' : undefined}
            onClick={() => (state.scope && dispatch({ type: 'setScope', project: null }), nav({ view: 'tasks', tab: listTab }))}
          >
            <Layers size={15} className="tk-nav-glyph" aria-hidden />
            <span className="nav-name">All projects</span>
            <span className="nav-count">{open.length || ''}</span>
          </button>
          {projects.map((p) => (
            <button
              key={p.id}
              className="nav-item compact"
              aria-current={r && r.tab !== 'review' && shown === p.id ? 'page' : undefined}
              onClick={() => nav({ view: 'tasks', tab: listTab, project: p.id })}
            >
              <Folder color={p.color} size={17} />
              <span className="nav-name">
                <span className="num">{p.num}</span>
                {p.name}
              </span>
              <span className="nav-count">{open.filter((t) => t.project === p.id).length || ''}</span>
            </button>
          ))}
        </div>

        <div className="side-group">
          <div className="side-title">Today’s highlight</div>
          <Highlight compact />
        </div>
      </div>
      <TaskDialog open={creating} onClose={closeCreate} initial={{ project: r?.project && r.project !== 'none' ? r.project : undefined }} />
    </>
  );
}

/** Today's one highlight, with a done toggle. */
function Highlight({ compact }: { compact?: boolean }) {
  const { state, dispatch } = useStore();
  const task = Object.values(state.ws.tasks).find((t) => t.title === state.highlight);
  const ev = task?.event ? state.ws.events[task.event] : undefined;
  return (
    <div className={`tk-hl${compact ? ' compact' : ''}`} data-done={state.highlightDone || undefined}>
      <Target size={16} className="tk-hl-icon" aria-hidden />
      <div className="tk-hl-body">
        <p className="tk-hl-text">{state.highlight}</p>
        {ev && (
          <span className="tk-hl-sub">
            Focus block {fmtRange(ev.start, ev.end)}
            {ev.start.toDateString() === NOW.toDateString() ? '' : `, ${fmtDay(ev.start)}`}
          </span>
        )}
        <button className={`btn btn-xs${state.highlightDone ? '' : ' btn-primary'}`} onClick={() => dispatch({ type: 'toggleHighlight' })}>
          <CircleCheck size={13} />
          {state.highlightDone ? 'Done' : 'Mark done'}
        </button>
      </div>
    </div>
  );
}

/* ───────────── Context panel ───────────── */

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rp-section">
      <header className="rp-head">
        <h2 className="rp-title">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function TasksContext() {
  const { state, dispatch } = useStore();
  const [editing, setEditing] = useState<Task | null>(null);
  const closeEdit = useCallback(() => setEditing(null), []);
  const due = Object.values(state.ws.tasks).filter(isDueNow).sort(byDue);
  const scheduled = openTasks(state.ws)
    .filter((t) => t.event && state.ws.events[t.event])
    .sort((a, b) => state.ws.events[a.event!]!.start.getTime() - state.ws.events[b.event!]!.start.getTime());
  const queue = reviewQueue(state.ws).length;
  const review = Object.values(state.ws.events)
    .filter((e) => e.kind === 'review' && e.end > NOW)
    .sort((a, b) => a.start.getTime() - b.start.getTime())[0];

  return (
    <>
      <Section title="Today’s highlight" aside={<span className="rp-aside">{fmtDay(NOW)}</span>}>
        <Highlight />
      </Section>

      <Section title="Due today or overdue" aside={<span className="rp-aside mono">{due.length}</span>}>
        {due.length === 0 ? (
          <p className="rp-text">Nothing due today. Pick tomorrow’s highlight from the board.</p>
        ) : (
          <ul className="rp-list">
            {due.map((t) => (
              <li key={t.id}>
                <button className="rp-person" onClick={() => setEditing(t)}>
                  <StatusIcon status={t.status} size={16} />
                  <span className="rp-person-text">
                    <span className="rp-person-name">{t.title}</span>
                    <span className="rp-person-sub">
                      <span className={`tone-${dueInfo(t.due!).tone}`}>{dueInfo(t.due!).label}</span>
                      {` · ${t.project ? state.ws.projects[t.project]?.name ?? 'No project' : 'No project'}`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Time blocked for tasks">
        {scheduled.length === 0 ? (
          <p className="rp-text">No task has a calendar block yet. Use Block time on a card.</p>
        ) : (
          <ul className="rp-list">
            {scheduled.map((t) => {
              const ev = state.ws.events[t.event!]!;
              return (
                <li key={t.id}>
                  <button className="rp-person" onClick={() => showEvent(dispatch, ev)}>
                    <CalendarClock size={16} className="tk-rp-icon" aria-hidden />
                    <span className="rp-person-text">
                      <span className="rp-person-name">{t.title}</span>
                      <span className="rp-person-sub">
                        {fmtDay(ev.start)}, {fmtRange(ev.start, ev.end)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Weekly review">
        <p className="rp-note tk-tip">
          <Lightbulb size={14} />
          <span>
            {queue > 0
              ? `${plural(queue, 'captured item')} waiting. Don’t sort them now: capture with ⌘J and process the queue${review ? ` in your review on ${fmtDay(review.start)}` : ' in your weekly review'}.`
              : 'The queue is clear. Keep capturing with ⌘J; the weekly review sorts it.'}
          </span>
        </p>
        <button className="btn btn-sm tk-tip-btn" onClick={() => dispatch({ type: 'navigate', route: { view: 'tasks', tab: 'review' } })}>
          Open the review queue
        </button>
      </Section>

      <TaskDialog open={!!editing} onClose={closeEdit} initial={editing ?? undefined} />
    </>
  );
}
