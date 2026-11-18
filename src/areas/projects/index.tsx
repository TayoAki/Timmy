import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  FilePlus2,
  Files,
  FolderKanban,
  FolderOpen,
  Gavel,
  Hourglass,
  Kanban,
  LayoutList,
  ListChecks,
  ListPlus,
  Plus,
  Sparkles,
  SquarePen,
  Target,
  UserPlus,
  WandSparkles,
  Radar,
  FileText,
  CalendarDays,
} from 'lucide-react';
import { UploadButton } from '../viewers/Upload';
import { Suspense, lazy, useEffect, useState } from 'react';
import { isLive } from '../../live/clock';
import { api } from '../../live/api';
import { useProfile } from '../../live/LiveApp';
import { FileViewer } from '../../live/FileViewer';

// Detect projects carries the map, which needs the graph library: it loads when it is opened.
const DetectProjects = lazy(() => import('../../live/DetectProjects'));

/** The files and meetings Timmy linked to a project on a real workspace. Null in the demo and until they arrive. */
function useProjectLinks(projectId: string) {
  const [links, setLinks] = useState<Awaited<ReturnType<typeof api.projectLinks>> | null>(null);
  useEffect(() => {
    if (!isLive()) return;
    let gone = false;
    void api
      .projectLinks(projectId)
      .then((r) => !gone && setLinks(r))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [projectId]);
  return links;
}
import { NewDocDialog } from '../docs/NewDocDialog';
import { TaskDialog } from '../tasks/TaskDialog';
import { ContactDialog } from '../people/ContactDialog';
import { Avatar, DueChip, Folder } from '../../components/common';
import { DocIcon, kindMeta } from '../../components/DocBits';
import { Frame } from '../../components/Frame';
import { EmptyState, Menu, SideHead } from '../../components/kit';
import { NOW, PEOPLE, PROJECTS } from '../../data/mock';
import type { Project, Task, WFile } from '../../data/ws-types';
import { fmtDate, fmtListDate, fmtStamp, money, plural } from '../../lib/format';
import { byNewest, useStore, ws, type Route } from '../../state/store';
import { folderLabel, patch, pathOf, personName, type WsOp } from '../../state/ws';
import { ThreadRow } from '../../views/MailboxView';
import { DecisionDialog, NewProjectDialog, PromptDialog, RemoveButton, SourcePickerDialog } from './dialogs';
import {
  ARCHIVE_FOLDER,
  WORK_FOLDER,
  activeProjects,
  archivedProjects,
  deadlines,
  folderFiles,
  nextProjectNum,
  notesTable,
  numTakenUnderWork,
  openTasks,
  projectDeal,
  projectDocs,
  projectFiles,
  projectPeople,
  projectTasks,
  projectThreads,
  projectUpdate,
  sortTasks,
  waitingThreads,
} from './lib';
import { RpSection, SectionHead, TaskLine } from './ui';

type ProjectTab = Extract<Route, { view: 'project' }>['tab'];

/* ───────────── Archive / restore ───────────── */

function useArchive() {
  const { state, dispatch } = useStore();
  return {
    archive: (p: Project) =>
      dispatch(
        ws([patch('projects', p.id, { status: 'archived' }), patch('folders', p.folder, { parent: ARCHIVE_FOLDER })], {
          toast: `Archived [${p.num}] ${p.name} · folder moved to [99] Archived`,
          undo: true,
          log: `Archived project [${p.num}] ${p.name}`,
        }),
      ),
    restore: (p: Project) => {
      const num = numTakenUnderWork(state.ws, p.num, p.folder) ? nextProjectNum(state.ws) : p.num;
      const ops: WsOp[] = [patch('projects', p.id, { status: 'active', num }), patch('folders', p.folder, { parent: WORK_FOLDER, num })];
      dispatch(
        ws(ops, {
          toast: num === p.num ? `Restored [${num}] ${p.name} to [02] Work` : `Restored ${p.name} as [${num}]: [${p.num}] was taken`,
          undo: true,
          log: `Restored project ${p.name} to [02] Work`,
        }),
      );
    },
  };
}

/* ───────────── Ongoing responsibilities ───────────── */

/** Folders that hold ongoing work with no finish line: everything under [02] Work that isn't a project, plus reference material. */
function useResponsibilities() {
  const { state } = useStore();
  const projectFolders = new Set(Object.values(state.ws.projects).map((p) => p.folder));
  const work = Object.values(state.ws.folders)
    .filter((f) => f.parent === WORK_FOLDER && !projectFolders.has(f.id))
    .sort((a, b) => a.num.localeCompare(b.num));
  const reference = ['f03'].map((id) => state.ws.folders[id]).filter((f): f is NonNullable<typeof f> => !!f);
  return [...work, ...reference];
}

/* ───────────── Projects list ───────────── */

export function ProjectsView() {
  const { state, dispatch } = useStore();
  const tab = state.route.view === 'projects' ? state.route.tab : 'active';
  const active = activeProjects(state.ws);
  const archived = archivedProjects(state.ws);
  const rows = tab === 'active' ? active : archived;
  const [newOpen, setNewOpen] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const live = useProfile();

  return (
    <Frame
      tabs={[
        { id: 'active', label: 'Active', count: active.length },
        { id: 'archived', label: 'Archived', count: archived.length },
      ]}
      active={tab}
      onTab={(id) => dispatch({ type: 'navigate', route: { view: 'projects', tab: id as 'active' | 'archived' } })}
      scrollKey={tab}
      wide
    >
      <div className="pj-title-row">
        <div>
          <h1 className="page-title">{tab === 'active' ? 'Projects' : 'Archived projects'}</h1>
          <p className="page-sub">
            {tab === 'active'
              ? 'Each project keeps its tasks, running notes, mail and files together. Archive it when the goal is met.'
              : 'Finished projects stay searchable in [99] Archived. Restore one to move its folder back to [02] Work.'}
          </p>
        </div>
        <div className="pj-title-actions">
          {/* On a real workspace, Timmy can find the projects in the mail, meetings and files already connected. */}
          {isLive() && live?.profile.can.work && (
            <button className="btn" onClick={() => setDetecting(true)}>
              <Radar size={15} />
              Detect projects
            </button>
          )}
          <button className="btn btn-primary" onClick={() => setNewOpen(true)}>
            <Plus size={15} />
            New project
          </button>
        </div>
      </div>
      {detecting && (
        <Suspense fallback={null}>
          <DetectProjects onClose={() => setDetecting(false)} />
        </Suspense>
      )}

      {tab === 'active' && <HomeActions />}

      {rows.length > 0 ? (
        <ul className="pj-list" aria-label={tab === 'active' ? 'Active projects' : 'Archived projects'}>
          {rows.map((p) => (
            <ProjectRow key={p.id} p={p} />
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={tab === 'active' ? FolderKanban : Archive}
          title={tab === 'active' ? 'No active projects' : 'Nothing archived yet'}
          body={tab === 'active' ? 'Start one for anything with a goal and a finish line.' : 'When a project’s goal is met, archive it from its page or the menu on its row.'}
          action={
            tab === 'active' ? (
              <button className="btn btn-sm" onClick={() => setNewOpen(true)}>
                <Plus size={14} />
                New project
              </button>
            ) : undefined
          }
        />
      )}

      {tab === 'active' && <Responsibilities />}
      <NewProjectDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </Frame>
  );
}

/** Start anything from the projects home. */
function HomeActions() {
  const [dialog, setDialog] = useState<'task' | 'note' | 'contact' | 'prompt' | null>(null);
  const close = () => setDialog(null);
  return (
    <div className="quick-actions pj-home-actions" role="group" aria-label="Quick actions">
      <button className="btn btn-sm" onClick={() => setDialog('task')}>
        <ListPlus size={14} />
        New task
      </button>
      <button className="btn btn-sm" onClick={() => setDialog('note')}>
        <FilePlus2 size={14} />
        New note
      </button>
      <button className="btn btn-sm" onClick={() => setDialog('contact')}>
        <UserPlus size={14} />
        Add contact
      </button>
      <button className="btn btn-sm" onClick={() => setDialog('prompt')}>
        <WandSparkles size={14} />
        Save a prompt
      </button>
      <TaskDialog open={dialog === 'task'} onClose={close} />
      <NewDocDialog open={dialog === 'note'} onClose={close} />
      <ContactDialog open={dialog === 'contact'} onClose={close} />
      <PromptDialog open={dialog === 'prompt'} onClose={close} />
    </div>
  );
}

function ProjectRow({ p }: { p: Project }) {
  const { state, dispatch } = useStore();
  const { archive, restore } = useArchive();
  const open = openTasks(state.ws, p.id).length;
  const waiting = waitingThreads(state.threads, p.id).length;
  const files = projectFiles(state.ws, p).length;
  const deal = projectDeal(state.deals, p);
  const next = p.status === 'active' ? deadlines(state.ws, state.threads, p.id)[0] : undefined;
  const go = () => dispatch({ type: 'navigate', route: { view: 'project', id: p.id, tab: 'overview' } });

  return (
    <li className="pj-row">
      <button type="button" className="pj-row-main" onClick={go}>
        <Folder color={p.color} size={30} />
        <span className="pj-row-text">
          <span className="pj-row-name">
            <span className="code pj-num">[{p.num}]</span>{' '}
            {p.name}
          </span>
          <span className="pj-row-sub">
            {[p.client, p.goal].filter(Boolean).join(' · ') || 'No goal set'}
          </span>
          <span className="pj-row-meta">
            <span>
              <ListChecks size={13} aria-hidden />
              {plural(open, 'open task')}
            </span>
            <span>
              <Hourglass size={13} aria-hidden />
              {waiting} waiting
            </span>
            <span>
              <Files size={13} aria-hidden />
              {plural(files, 'file')}
            </span>
          </span>
        </span>
        <span className="pj-row-side">
          {deal && (
            <span className="pj-deal">
              <span className={`stage${deal.stage === 'Closed won' ? ' won' : ''}`}>{deal.stage}</span>
              <span className="mono pj-deal-value">{money(deal.value)}</span>
            </span>
          )}
          {next ? (
            <span title={`Next: ${next.label}`}>
              <DueChip due={next.due} prefix={next.due < NOW ? undefined : 'Due'} />
            </span>
          ) : p.status === 'active' ? (
            <span className="pj-quiet">No dates set</span>
          ) : null}
        </span>
      </button>
      {p.status === 'active' ? (
        <Menu
          label={`More actions for ${p.name}`}
          items={[
            { label: 'Open project', icon: ArrowUpRight, onSelect: go },
            { label: 'Open folder in Drive', icon: FolderOpen, onSelect: () => dispatch({ type: 'navigate', route: { view: 'files', tab: 'browse', folder: p.folder } }) },
            { label: 'Archive project', icon: Archive, onSelect: () => archive(p) },
          ]}
        />
      ) : (
        <button className="btn btn-sm pj-row-restore" onClick={() => restore(p)}>
          <ArchiveRestore size={14} />
          Restore
        </button>
      )}
    </li>
  );
}

function Responsibilities() {
  const { state, dispatch } = useStore();
  const folders = useResponsibilities();
  if (!folders.length) return null;
  return (
    <section className="section">
      <SectionHead title="Ongoing responsibilities" sub="Areas with no finish line. Their reference material lives in Drive, where you’d look for it." />
      <ul className="pj-areas">
        {folders.map((f) => {
          const count = folderFiles(state.ws, f.id).length;
          const path = pathOf(state.ws, f.id).slice(1);
          return (
            <li key={f.id}>
              <button type="button" className="pj-area" onClick={() => dispatch({ type: 'navigate', route: { view: 'files', tab: 'browse', folder: f.id } })}>
                <Folder color={f.color} size={22} />
                <span className="pj-area-text">
                  <span className="pj-area-name">{folderLabel(f)}</span>
                  <span className="pj-area-sub">
                    {path.length > 1 ? `${path.slice(0, -1).join(' › ')} · ` : ''}
                    {plural(count, 'file')}
                  </span>
                </span>
                <ChevronRight size={15} className="pj-area-chev" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ───────────── Project page ───────────── */

export function ProjectView() {
  const { state, dispatch } = useStore();
  const r = state.route.view === 'project' ? state.route : null;
  const p = r ? state.ws.projects[r.id] : undefined;
  const { archive, restore } = useArchive();
  const [dialog, setDialog] = useState<'task' | 'note' | 'decision' | 'source' | 'prompt' | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);
  const close = () => setDialog(null);

  if (!r || !p) {
    return (
      <Frame tabs={[{ id: 'overview', label: 'Overview' }]} active="overview" onTab={() => undefined}>
        <EmptyState
          icon={FolderKanban}
          title="Project not found"
          body="It may have been removed. Your other projects are on the Projects page."
          action={
            <button className="btn btn-sm" onClick={() => dispatch({ type: 'navigate', route: { view: 'projects', tab: 'active' } })}>
              Go to Projects
            </button>
          }
        />
      </Frame>
    );
  }

  const tab = r.tab;
  const tasks = projectTasks(state.ws, p.id);
  const openCount = tasks.filter((t) => t.status !== 'done').length;
  const docs = projectDocs(state.ws, p);
  const threads = projectThreads(state.threads, p.id);
  const files = projectFiles(state.ws, p);
  const go = (t: ProjectTab) => dispatch({ type: 'navigate', route: { view: 'project', id: p.id, tab: t } });
  const compose = () => dispatch({ type: 'compose', draft: { to: [], subject: '', body: '', project: p.id } });
  const openFolder = () => dispatch({ type: 'navigate', route: { view: 'files', tab: 'browse', folder: p.folder } });
  const draftUpdate = () => dispatch({ type: 'compose', draft: { to: [], ...projectUpdate(state.ws, state.threads, state.deals, p), project: p.id } });
  const archived = p.status === 'archived';

  const ctx: TabCtx = {
    p,
    newTask: () => setDialog('task'),
    newNote: () => setDialog('note'),
    recordDecision: () => setDialog('decision'),
    addSource: () => setDialog('source'),
    savePrompt: () => setDialog('prompt'),
    editTask: setEditing,
    compose,
    openFolder,
    draftUpdate,
  };

  return (
    <Frame
      tabs={[
        { id: 'overview', label: 'Overview' },
        { id: 'tasks', label: 'Tasks', count: openCount },
        { id: 'notes', label: 'Notes', count: docs.length },
        { id: 'mail', label: 'Mail', count: threads.filter((t) => t.box !== 'archived').length },
        { id: 'files', label: 'Files', count: files.length },
        { id: 'ai', label: 'AI' },
      ]}
      active={tab}
      onTab={(id) => go(id as ProjectTab)}
      scrollKey={`${p.id}-${tab}`}
      wide
    >
      <nav className="crumbs" aria-label="Breadcrumb">
        <button onClick={() => dispatch({ type: 'navigate', route: { view: 'projects', tab: archived ? 'archived' : 'active' } })}>
          {archived ? 'Archived projects' : 'Projects'}
        </button>
        <ChevronRight size={14} aria-hidden />
        <span className="crumb-current" aria-current="page">
          [{p.num}] {p.name}
        </span>
      </nav>

      <header className="pj-head">
        <Folder color={p.color} size={40} />
        <div className="pj-head-text">
          <h1 className="page-title">
            <span className="code pj-num">[{p.num}]</span>{' '}
            {p.name}
          </h1>
          <p className="pj-head-sub">
            {p.client && <span>{p.client}</span>}
            <span className={`chip plain pj-status${archived ? '' : ' on'}`}>
              <span className="dot" />
              {archived ? 'Archived' : 'Active'}
            </span>
          </p>
        </div>
      </header>
      {p.goal && (
        <p className="pj-goal">
          <Target size={15} aria-hidden />
          {p.goal}
        </p>
      )}

      <div className="quick-actions pj-actions" role="group" aria-label="Project actions">
        <button className="btn btn-sm btn-primary" onClick={() => setDialog('task')}>
          <ListPlus size={14} />
          New task
        </button>
        <button className="btn btn-sm" onClick={() => setDialog('note')}>
          <FilePlus2 size={14} />
          New note
        </button>
        <button className="btn btn-sm" onClick={compose}>
          <SquarePen size={14} />
          Compose
        </button>
        <button className="btn btn-sm" onClick={() => setDialog('decision')}>
          <Gavel size={14} />
          Record a decision
        </button>
        <button className="btn btn-sm" onClick={openFolder}>
          <FolderOpen size={14} />
          Open folder
        </button>
        <Menu
          label="More project actions"
          items={[
            { label: 'Draft a project update', icon: Sparkles, onSelect: draftUpdate },
            { label: 'Open in Tasks board', icon: Kanban, onSelect: () => dispatch({ type: 'navigate', route: { view: 'tasks', tab: 'board', project: p.id } }) },
            archived
              ? { label: 'Restore project', icon: ArchiveRestore, onSelect: () => restore(p) }
              : { label: 'Archive project', icon: Archive, onSelect: () => archive(p) },
          ]}
        />
      </div>

      {tab === 'overview' && <Overview ctx={ctx} />}
      {tab === 'tasks' && <TasksTab ctx={ctx} />}
      {tab === 'notes' && <NotesTab ctx={ctx} />}
      {tab === 'mail' && <MailTab ctx={ctx} />}
      {tab === 'files' && <FilesTab ctx={ctx} />}
      {tab === 'ai' && <AiTab ctx={ctx} />}

      <TaskDialog open={dialog === 'task'} onClose={close} initial={{ project: p.id }} />
      <TaskDialog open={!!editing} onClose={() => setEditing(null)} initial={editing ?? undefined} />
      <NewDocDialog open={dialog === 'note'} onClose={close} initial={{ project: p.id, folder: p.folder }} />
      <DecisionDialog open={dialog === 'decision'} onClose={close} project={p} />
      <SourcePickerDialog open={dialog === 'source'} onClose={close} project={p} />
      <PromptDialog open={dialog === 'prompt'} onClose={close} project={p} />
    </Frame>
  );
}

interface TabCtx {
  p: Project;
  newTask: () => void;
  newNote: () => void;
  recordDecision: () => void;
  addSource: () => void;
  savePrompt: () => void;
  editTask: (t: Task) => void;
  compose: () => void;
  openFolder: () => void;
  draftUpdate: () => void;
}

/* ───────────── Overview ───────────── */

function Overview({ ctx }: { ctx: TabCtx }) {
  const { state, dispatch } = useStore();
  const { p } = ctx;
  const due = openTasks(state.ws, p.id).slice(0, 5);
  const waiting = waitingThreads(state.threads, p.id).sort((a, b) => (a.waiting?.due?.getTime() ?? Infinity) - (b.waiting?.due?.getTime() ?? Infinity));
  const table = notesTable(state.ws, p);
  const decisions = table?.rows.slice(0, 3) ?? [];
  const people = projectPeople(state.threads, p.id);
  const deal = projectDeal(state.deals, p);
  const sourceSet = new Set(p.sources);
  const files = projectFiles(state.ws, p);
  const keyFiles = [...files.filter((f) => sourceSet.has(f.id) || f.starred), ...files.filter((f) => !sourceSet.has(f.id) && !f.starred)].slice(0, 5);

  return (
    <div className="pj-overview">
      <div className="pj-col">
        <section className="pj-block">
          <SectionHead title="Due soon">
            <button className="btn btn-xs btn-ghost" onClick={() => dispatch({ type: 'navigate', route: { view: 'project', id: p.id, tab: 'tasks' } })}>
              All tasks
            </button>
          </SectionHead>
          {due.length ? (
            <ul className="pj-box">
              {due.map((t) => (
                <TaskLine key={t.id} task={t} onEdit={ctx.editTask} />
              ))}
            </ul>
          ) : (
            <p className="pj-none">
              No open tasks.{' '}
              <button className="pj-inline-link" onClick={ctx.newTask}>
                Add one
              </button>
            </p>
          )}
        </section>

        <section className="pj-block">
          <SectionHead title="Waiting on others" sub={waiting.length ? undefined : 'Nothing owed to you on this project.'} />
          {waiting.length > 0 && (
            <ul className="pj-box">
              {waiting.map((t) => (
                <li key={t.id}>
                  <button type="button" className="pj-line" onClick={() => dispatch({ type: 'openThread', id: t.id })}>
                    <Avatar id={t.waiting!.on} size={28} />
                    <span className="pj-line-text">
                      <span className="pj-line-title">{t.waiting!.item}</span>
                      <span className="pj-line-sub">
                        {personName(t.waiting!.on)} · asked {fmtDate(t.waiting!.since)}
                      </span>
                    </span>
                    {t.waiting!.due ? (
                      <DueChip due={t.waiting!.due} prefix="Promised" />
                    ) : (
                      <span className="chip">
                        <Hourglass size={12} />
                        No date
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="pj-block">
          <SectionHead title="Latest decisions">
            {p.notesDoc && (
              <button className="btn btn-xs btn-ghost" onClick={() => dispatch({ type: 'navigate', route: { view: 'file', id: p.notesDoc! } })}>
                Open running notes
              </button>
            )}
            <button className="btn btn-xs" onClick={ctx.recordDecision}>
              <Gavel size={13} />
              Record
            </button>
          </SectionHead>
          {decisions.length ? (
            <DecisionList rows={decisions} />
          ) : (
            <p className="pj-none">No decisions recorded yet. Record each one as it’s made, with where it came from.</p>
          )}
        </section>
      </div>

      <div className="pj-col">
        {deal && (
          <section className="pj-block">
            <SectionHead title="Deal" />
            <div className="card pj-card">
              <div className="deal-head">
                <span className="deal-logo pj-deal-logo" style={{ ['--tint' as string]: p.color }}>
                  {deal.company[0]}
                </span>
                <div>
                  <strong>{deal.company}</strong>
                  <div className="pj-quiet">{deal.name}</div>
                </div>
                <span className={`stage${deal.stage === 'Closed won' ? ' won' : ''}`}>{deal.stage}</span>
              </div>
              <dl className="kv">
                <dt>Value</dt>
                <dd className="mono">{money(deal.value)}</dd>
                <dt>Next step</dt>
                <dd>
                  {deal.next}
                  <span className="owner">{deal.owner === 'me' ? 'You' : personName(deal.owner).split(' ')[0]}</span>
                </dd>
                {deal.due && (
                  <>
                    <dt>Due</dt>
                    <dd>
                      <DueChip due={deal.due} />
                    </dd>
                  </>
                )}
              </dl>
            </div>
          </section>
        )}

        <section className="pj-block">
          <SectionHead title="People involved" sub={people.length ? undefined : 'Nobody yet. People on the project’s mail show up here.'} />
          {people.length > 0 && (
            <ul className="pj-people">
              {people.map((id) => {
                const person = PEOPLE[id];
                return (
                  <li key={id}>
                    <button
                      type="button"
                      className="pj-person"
                      disabled={person?.bot}
                      onClick={() => dispatch({ type: 'navigate', route: { view: 'contact', id, tab: 'overview' } })}
                    >
                      <Avatar id={id} size={30} />
                      <span className="pj-line-text">
                        <span className="pj-line-title">{person?.name ?? id}</span>
                        <span className="pj-line-sub">{[person?.title, person?.company].filter(Boolean).join(' · ') || person?.email}</span>
                      </span>
                      {state.ws.contacts[id]?.priority && <span className="chip accent">Priority</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="pj-block">
          <SectionHead title="Key files">
            <button className="btn btn-xs btn-ghost" onClick={() => dispatch({ type: 'navigate', route: { view: 'project', id: p.id, tab: 'files' } })}>
              All files
            </button>
          </SectionHead>
          {keyFiles.length ? (
            <ul className="pj-files">
              {keyFiles.map((f) => (
                <FileLine key={f.id} f={f} />
              ))}
            </ul>
          ) : (
            <p className="pj-none">The project folder is empty.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function DecisionList({ rows }: { rows: string[][] }) {
  return (
    <ol className="pj-decisions">
      {rows.map((r, i) => (
        <li key={`${i}-${r[0]}-${r[1]}`}>
          <span className="pj-dec-date mono">{r[0]}</span>
          <span className="pj-dec-text">{r[1]}</span>
          {r[2] && <span className="pj-dec-src">{r[2]}</span>}
        </li>
      ))}
    </ol>
  );
}

function FileLine({ f }: { f: WFile }) {
  const { dispatch } = useStore();
  return (
    <li>
      <button type="button" className="pj-file" onClick={() => dispatch({ type: 'navigate', route: { view: 'file', id: f.id } })}>
        <DocIcon kind={f.kind} size={16} />
        <span className="pj-file-name">{f.name}</span>
        <span className="pj-file-date">{fmtListDate(f.updated)}</span>
      </button>
    </li>
  );
}

/* ───────────── Tasks ───────────── */

function TasksTab({ ctx }: { ctx: TabCtx }) {
  const { state, dispatch } = useStore();
  const { p } = ctx;
  const tasks = projectTasks(state.ws, p.id);
  const groups: { id: Task['status']; label: string }[] = [
    { id: 'doing', label: 'In progress' },
    { id: 'todo', label: 'To do' },
    { id: 'done', label: 'Done' },
  ];
  return (
    <section className="pj-tab">
      <SectionHead title="Tasks" sub="New tasks from this page are linked to the project.">
        <button className="btn btn-sm" onClick={() => dispatch({ type: 'navigate', route: { view: 'tasks', tab: 'board', project: p.id } })}>
          <Kanban size={14} />
          Open in Tasks board
        </button>
        <button className="btn btn-sm btn-primary" onClick={ctx.newTask}>
          <ListPlus size={14} />
          New task
        </button>
      </SectionHead>
      {tasks.length === 0 && <EmptyState icon={ListChecks} title="No tasks yet" body="Add the next action for this project, or create one from an email." />}
      {groups.map((g) => {
        const items = sortTasks(tasks.filter((t) => t.status === g.id));
        if (!items.length) return null;
        return (
          <div key={g.id} className="pj-group">
            <h3 className="pj-group-title">
              {g.label}
              <span className="pj-group-count mono">{items.length}</span>
            </h3>
            <ul className="pj-box">
              {items.map((t) => (
                <TaskLine key={t.id} task={t} onEdit={ctx.editTask} />
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

/* ───────────── Notes ───────────── */

function NotesTab({ ctx }: { ctx: TabCtx }) {
  const { state, dispatch } = useStore();
  const { p } = ctx;
  const table = notesTable(state.ws, p);
  const docs = projectDocs(state.ws, p);
  return (
    <>
      <section className="pj-tab">
        <SectionHead title="Decision log" sub="From the running notes, newest first.">
          {p.notesDoc && (
            <button className="btn btn-sm" onClick={() => dispatch({ type: 'navigate', route: { view: 'file', id: p.notesDoc! } })}>
              <ArrowUpRight size={14} />
              Open running notes
            </button>
          )}
          <button className="btn btn-sm btn-primary" onClick={ctx.recordDecision}>
            <Gavel size={14} />
            Record a decision
          </button>
        </SectionHead>
        {table && table.rows.length ? (
          <DecisionList rows={table.rows} />
        ) : (
          <p className="pj-none">{p.notesDoc ? 'No decisions recorded yet.' : 'No running notes doc yet. Recording a decision creates one in the project folder.'}</p>
        )}
      </section>

      <section className="section">
        <SectionHead title="Notes and docs" sub="Docs in the project folder.">
          <button className="btn btn-sm" onClick={ctx.newNote}>
            <FilePlus2 size={14} />
            New note
          </button>
        </SectionHead>
        {docs.length ? (
          <ul className="pj-box">
            {docs.map((f) => (
              <li key={f.id}>
                <button type="button" className="pj-line" onClick={() => dispatch({ type: 'navigate', route: { view: 'file', id: f.id } })}>
                  <DocIcon kind={f.kind} size={18} />
                  <span className="pj-line-text">
                    <span className="pj-line-title">{f.name}</span>
                    <span className="pj-line-sub">
                      Edited {fmtStamp(f.updated)} · {f.owner === 'me' ? 'You' : personName(f.owner)}
                    </span>
                  </span>
                  {f.id === p.notesDoc && <span className="chip accent">Running notes</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={BookOpen} title="No notes yet" body="New notes from this page are saved in the project folder." />
        )}
      </section>
    </>
  );
}

/* ───────────── Mail ───────────── */

function MailTab({ ctx }: { ctx: TabCtx }) {
  const { state, dispatch } = useStore();
  const { p } = ctx;
  const threads = projectThreads(state.threads, p.id).sort(byNewest);
  const open = threads.filter((t) => t.box !== 'archived');
  const done = threads.filter((t) => t.box === 'archived');
  return (
    <section className="pj-tab">
      <SectionHead title="Mail" sub={`Threads labelled [${p.num}] ${p.name}.`}>
        {PROJECTS.some((x) => x.id === p.id) && (
          <button className="btn btn-sm" onClick={() => dispatch({ type: 'navigate', route: { view: 'box', box: p.id, tab: 'all' } })}>
            <LayoutList size={14} />
            Open label
          </button>
        )}
        <button className="btn btn-sm btn-primary" onClick={ctx.compose}>
          <SquarePen size={14} />
          Compose
        </button>
      </SectionHead>
      {open.length > 0 ? (
        <div role="list" className="pj-threads">
          {open.map((t) => (
            <ThreadRow key={t.id} t={t} showProject={false} />
          ))}
        </div>
      ) : (
        <p className="pj-none">No open threads for this project.</p>
      )}
      {done.length > 0 && (
        <div className="section">
          <h3 className="pj-group-title">
            Archived
            <span className="pj-group-count mono">{done.length}</span>
          </h3>
          <div role="list" className="pj-threads">
            {done.map((t) => (
              <ThreadRow key={t.id} t={t} showProject={false} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/* ───────────── Files ───────────── */

function FilesTab({ ctx }: { ctx: TabCtx }) {
  const { state, dispatch } = useStore();
  const { p } = ctx;
  const linked = useProjectLinks(p.id);
  const [viewing, setViewing] = useState<{ id: string; name: string } | null>(null);
  const files = projectFiles(state.ws, p);
  const folder = state.ws.folders[p.folder];
  return (
    <section className="pj-tab">
      <SectionHead title="Files" sub={folder ? pathOf(state.ws, folder.id).join(' › ') : undefined}>
        <button className="btn btn-sm" onClick={ctx.openFolder}>
          <FolderOpen size={14} />
          Open folder
        </button>
        <UploadButton folder={p.folder} project={p.id} className="btn btn-sm" />
        <button className="btn btn-sm" onClick={ctx.newNote}>
          <FilePlus2 size={14} />
          New note
        </button>
      </SectionHead>
      {files.length ? (
        <ul className="pj-box">
          {files.map((f) => (
            <li key={f.id}>
              <button type="button" className="pj-line pj-file-row" onClick={() => dispatch({ type: 'navigate', route: { view: 'file', id: f.id } })}>
                <DocIcon kind={f.kind} size={18} />
                <span className="pj-line-text">
                  <span className="pj-line-title">{f.name}</span>
                  <span className="pj-line-sub">
                    {kindMeta(f.kind).label} · {f.owner === 'me' ? 'You' : personName(f.owner)}
                    {f.createdByTimmy ? ' · Created by Timmy' : ''}
                  </span>
                </span>
                {p.sources.includes(f.id) && <span className="chip accent">Timmy reads this</span>}
                <span className="pj-file-date">{fmtListDate(f.updated)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={FolderOpen} title="The folder is empty" body="Files you save to the project folder show up here." />
      )}
      {linked && (linked.files.length > 0 || linked.meetings.length > 0) && (
        <>
          <SectionHead title="From your connected apps" sub="Files and meetings Timmy linked to this project when it found it" />
          <ul className="pj-box">
            {linked.files.map((f) => (
              <li key={f.id}>
                <button type="button" className="pj-line pj-file-row" onClick={() => setViewing({ id: f.id, name: f.name })}>
                  <FileText size={18} aria-hidden />
                  <span className="pj-line-text">
                    <span className="pj-line-title">{f.name}</span>
                    <span className="pj-line-sub">{f.kind}</span>
                  </span>
                  <span className="pj-file-date">{fmtListDate(new Date(f.changed))}</span>
                </button>
              </li>
            ))}
            {linked.meetings.map((m) => (
              <li key={m.id}>
                <div className="pj-line pj-file-row">
                  <CalendarDays size={18} aria-hidden />
                  <span className="pj-line-text">
                    <span className="pj-line-title">{m.title}</span>
                    <span className="pj-line-sub">Meeting</span>
                  </span>
                  <span className="pj-file-date">{fmtListDate(new Date(m.at))}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {viewing && <FileViewer itemId={viewing.id} name={viewing.name} onClose={() => setViewing(null)} />}
    </section>
  );
}

/* ───────────── AI ───────────── */

function AiTab({ ctx }: { ctx: TabCtx }) {
  const { state, dispatch } = useStore();
  const { p } = ctx;
  const prompts = Object.values(state.ws.prompts)
    .filter((x) => x.project === p.id && x.status !== 'discarded')
    .sort((a, b) => b.created.getTime() - a.created.getTime());
  const sources = p.sources.map((id) => state.ws.files[id]).filter((f): f is WFile => !!f);
  const removeSource = (f: WFile) =>
    dispatch(ws([patch('projects', p.id, { sources: p.sources.filter((s) => s !== f.id) })], { toast: `Timmy will stop reading “${f.name}” for ${p.name}`, undo: true }));

  return (
    <>
      <section className="pj-tab">
        <SectionHead title="Project update" />
        <div className="pj-update">
          <p>
            Five lines (progress, numbers, risks, asks, next week) drafted from the running notes, tasks, what you’re waiting on and the deal. You edit it
            before it goes out.
          </p>
          <button className="btn btn-primary" onClick={ctx.draftUpdate}>
            <Sparkles size={15} />
            Draft a project update
          </button>
        </div>
      </section>

      <section className="section">
        <SectionHead title="Files Timmy reads when drafting for this project" sub="Keep this to the few files that hold the current numbers and decisions.">
          <button className="btn btn-sm" onClick={ctx.addSource}>
            <Plus size={14} />
            Add a file
          </button>
        </SectionHead>
        {sources.length ? (
          <ul className="pj-box">
            {sources.map((f) => (
              <li key={f.id} className="pj-source">
                <button type="button" className="pj-line" onClick={() => dispatch({ type: 'navigate', route: { view: 'file', id: f.id } })}>
                  <DocIcon kind={f.kind} size={18} />
                  <span className="pj-line-text">
                    <span className="pj-line-title">{f.name}</span>
                    <span className="pj-line-sub">{pathOf(state.ws, f.folder).slice(1).join(' › ')}</span>
                  </span>
                </button>
                <RemoveButton label={`Stop reading ${f.name}`} onClick={() => removeSource(f)} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="pj-none">No files yet. Timmy drafts from the thread alone until you add some.</p>
        )}
      </section>

      <section className="section">
        <SectionHead title="Prompts for this project">
          <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'navigate', route: { view: 'library', tab: 'prompts' } })}>
            Open AI library
          </button>
          <button className="btn btn-sm" onClick={ctx.savePrompt}>
            <WandSparkles size={14} />
            Save a prompt
          </button>
        </SectionHead>
        {prompts.length ? (
          <ul className="pj-box">
            {prompts.map((x) => (
              <li key={x.id} className="pj-prompt">
                <span className="pj-prompt-title">{x.title}</span>
                <span className="pj-prompt-text">{x.text}</span>
                <span className="chips">
                  {x.useCase && <span className="chip">{x.useCase}</span>}
                  {x.output && <span className="chip plain">Output: {x.output}</span>}
                  {x.status === 'captured' && <span className="chip accent">Captured</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="pj-none">No prompts filed here. Save the ones that worked so you can reuse them.</p>
        )}
      </section>
    </>
  );
}

/* ───────────── Sidebar ───────────── */

export function ProjectsSide() {
  const { state, dispatch } = useStore();
  const r = state.route;
  const active = activeProjects(state.ws);
  const archived = archivedProjects(state.ws);
  const areas = useResponsibilities();
  const [newOpen, setNewOpen] = useState(false);
  const current = r.view === 'project' ? r.id : null;

  return (
    <>
      <SideHead
        icon={<FolderKanban size={18} />}
        title="Projects"
        sub={`${active.length} active · ${archived.length} archived`}
        action={
          <button className="btn btn-primary" onClick={() => setNewOpen(true)}>
            <Plus size={15} />
            New project
          </button>
        }
      />
      <div className="side-scroll">
        <div className="side-group">
          <button
            className="nav-item compact"
            aria-current={r.view === 'projects' && r.tab === 'active' ? 'page' : undefined}
            onClick={() => dispatch({ type: 'navigate', route: { view: 'projects', tab: 'active' } })}
          >
            <LayoutList size={16} className="pj-side-icon" />
            <span className="nav-name">All projects</span>
          </button>
        </div>
        <div className="side-group">
          <div className="side-title">Active</div>
          {active.map((p) => {
            const open = openTasks(state.ws, p.id).length;
            return (
              <button
                key={p.id}
                className="nav-item compact"
                aria-current={current === p.id ? 'page' : undefined}
                onClick={() => dispatch({ type: 'navigate', route: { view: 'project', id: p.id, tab: 'overview' } })}
                title={`${plural(open, 'open task')}`}
              >
                <Folder color={p.color} size={17} />
                <span className="nav-name">
                  <span className="num">{p.num}</span>
                  {p.name}
                </span>
                <span className="nav-count">{open || ''}</span>
              </button>
            );
          })}
          {active.length === 0 && <p className="nav-hint pj-side-empty">No active projects.</p>}
        </div>
        {areas.length > 0 && (
          <div className="side-group">
            <div className="side-title">Responsibilities</div>
            {areas.map((f) => (
              <button
                key={f.id}
                className="nav-item compact"
                aria-current={r.view === 'files' && r.folder === f.id ? 'page' : undefined}
                onClick={() => dispatch({ type: 'navigate', route: { view: 'files', tab: 'browse', folder: f.id } })}
              >
                <Folder color={f.color} size={17} />
                <span className="nav-name">
                  <span className="num">{f.num}</span>
                  {f.name}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="side-foot">
        <button
          className="nav-item compact"
          aria-current={r.view === 'projects' && r.tab === 'archived' ? 'page' : current && state.ws.projects[current]?.status === 'archived' ? 'page' : undefined}
          onClick={() => dispatch({ type: 'navigate', route: { view: 'projects', tab: 'archived' } })}
        >
          <Folder color="var(--c-brown)" size={17} />
          <span className="nav-name">Archived ({archived.length})</span>
        </button>
      </div>
      <NewProjectDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </>
  );
}

/* ───────────── Context panel ───────────── */

export function ProjectsContext() {
  const { state, dispatch } = useStore();
  const r = state.route;
  const p = r.view === 'project' ? state.ws.projects[r.id] : undefined;

  if (!p) {
    const active = activeProjects(state.ws);
    const open = active.reduce((n, x) => n + openTasks(state.ws, x.id).length, 0);
    const waiting = active.reduce((n, x) => n + waitingThreads(state.threads, x.id).length, 0);
    return (
      <>
        <RpSection title="How projects work">
          <ul className="rp-bullets">
            <li>Each project has a numbered folder under [02] Work, a mail label with the same number and a running notes doc.</li>
            <li>Tasks, notes and emails you start from a project page are linked to it automatically.</li>
            <li>Record decisions as they happen. Project updates are drafted from them.</li>
            <li>When the goal is met, archive the project. Its folder moves to [99] Archived and stays searchable.</li>
          </ul>
        </RpSection>
        <RpSection title="Across active projects">
          <div className="rp-card">
            <dl className="kv flush">
              <dt>Projects</dt>
              <dd className="mono">{active.length}</dd>
              <dt>Open tasks</dt>
              <dd className="mono">{open}</dd>
              <dt>Waiting</dt>
              <dd className="mono">{waiting}</dd>
            </dl>
          </div>
        </RpSection>
      </>
    );
  }

  const deal = projectDeal(state.deals, p);
  const dates = deadlines(state.ws, state.threads, p.id).slice(0, 5);
  const people = projectPeople(state.threads, p.id).filter((id) => !PEOPLE[id]?.bot);

  return (
    <>
      <div className="rp-hero">
        <Folder color={p.color} size={36} />
        <div>
          <h2 className="rp-hero-title">
            <span className="rp-hero-num code">{p.num}</span>
            {p.name}
          </h2>
          {p.client && <p className="pj-quiet">{p.client}</p>}
        </div>
      </div>

      {deal && (
        <RpSection title="Deal">
          <div className="rp-card">
            <div className="deal-head">
              <span className="deal-logo pj-deal-logo" style={{ ['--tint' as string]: p.color }}>
                {deal.company[0]}
              </span>
              <div>
                <strong className="mono">{money(deal.value)}</strong>
                <div className="pj-quiet">{deal.name}</div>
              </div>
              <span className={`stage${deal.stage === 'Closed won' ? ' won' : ''}`}>{deal.stage}</span>
            </div>
            <dl className="kv">
              <dt>Next step</dt>
              <dd>
                {deal.next}
                <span className="owner">{deal.owner === 'me' ? 'You' : personName(deal.owner).split(' ')[0]}</span>
              </dd>
              {deal.due && (
                <>
                  <dt>Due</dt>
                  <dd>
                    <DueChip due={deal.due} />
                  </dd>
                </>
              )}
            </dl>
          </div>
        </RpSection>
      )}

      <RpSection title="Next deadlines">
        {dates.length ? (
          <ul className="rp-list">
            {dates.map((d) => (
              <li key={d.key}>
                <button
                  className="rp-person"
                  onClick={() =>
                    d.thread
                      ? dispatch({ type: 'openThread', id: d.thread })
                      : dispatch({ type: 'navigate', route: { view: 'project', id: p.id, tab: 'tasks' } })
                  }
                >
                  {d.who ? (
                    <Avatar id={d.who} size={26} />
                  ) : (
                    <span className="pj-ctx-icon">{d.kind === 'task' ? <ListChecks size={14} /> : <SquarePen size={14} />}</span>
                  )}
                  <span className="rp-person-text">
                    <span className="rp-person-name">{d.label}</span>
                    <span className="rp-person-sub">{d.kind === 'waiting' ? `Promised by ${personName(d.who!).split(' ')[0]}` : d.kind === 'task' ? 'Task' : 'Reply due'}</span>
                  </span>
                  <DueChip due={d.due} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rp-text">No dates set. Give the next task a due date so it shows here.</p>
        )}
      </RpSection>

      <RpSection title="People">
        {people.length ? (
          <ul className="rp-list">
            {people.map((id) => (
              <li key={id}>
                <button className="rp-person" onClick={() => dispatch({ type: 'navigate', route: { view: 'contact', id, tab: 'overview' } })}>
                  <Avatar id={id} size={28} />
                  <span className="rp-person-text">
                    <span className="rp-person-name">{PEOPLE[id]?.name ?? id}</span>
                    <span className="rp-person-sub">{state.ws.contacts[id]?.next ?? PEOPLE[id]?.title ?? ''}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rp-text">Nobody on this project’s mail yet.</p>
        )}
      </RpSection>

      {p.status === 'archived' && (
        <RpSection title="Archived">
          <p className="rp-text">The folder is in [99] Archived. Restore the project to move it back to [02] Work.</p>
        </RpSection>
      )}
    </>
  );
}

