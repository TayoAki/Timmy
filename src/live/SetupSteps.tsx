/**
 * Two steps of setting up a real workspace (Setup.tsx), on the person's own mail and files:
 *
 *   Find your projects: as soon as some mail is in, Timmy scans it with the meetings and Drive files
 *   (server/src/projects/detect.ts) and lists the projects it found, each ticked. One click creates the ticked ones:
 *   their emails go in them, their files are linked, and new mail and files from then on are put in them on their own.
 *
 *   See Timmy at work: three small things to try on what was just brought in. Put an email in a project; get a to-do
 *   from an email and put it in a project; open a Drive document in Timmy's own editor, where Save goes back to Drive.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, FileText, FolderInput, ListChecks, PencilLine, Radar, Sparkles } from 'lucide-react';
import type { Thread } from '../data/types';
import { activeProjects } from '../areas/projects/lib';
import { ProjectPicker } from '../components/ProjectPicker';
import { counterpart, useStore, ws } from '../state/store';
import { patch } from '../state/ws';
import { api, type ProjectScan } from './api';
import { DriveEditor } from './DriveEditor';

/** A scan needs a little mail to go on. */
const MIN_THREADS = 3;

const senderOf = (t: Thread) => {
  const id = counterpart(t);
  const people = (t as { ext?: { people?: Record<string, { name?: string }> } }).ext?.people ?? {};
  return id === 'me' ? 'you' : (people[id]?.name ?? id.replace(/^mail:/, ''));
};

/* ───────────── Find your projects ───────────── */

export function ProjectsStep({ mailIn, onSkip }: { mailIn: boolean; onSkip: () => void }) {
  const { state, dispatch } = useStore();
  const [scan, setScan] = useState<ProjectScan | null | undefined>(undefined);
  const [keep, setKeep] = useState<Record<string, boolean>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const started = useRef(false);
  const threads = state.threads.length;

  // The latest scan, and while one runs, its state every two seconds.
  useEffect(() => {
    let gone = false;
    let timer = 0;
    const look = () =>
      api
        .projectScan()
        .then((r) => {
          if (gone) return;
          setScan(r.scan);
          if (r.scan?.status === 'running') timer = window.setTimeout(look, 2000);
        })
        .catch((e: Error) => !gone && setError(e.message));
    void look();
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [scan?.id, scan?.status === 'running']);

  // Starts by itself once some mail is in, unless a scan is running or waiting to be reviewed.
  useEffect(() => {
    if (scan === undefined || started.current || !mailIn || threads < MIN_THREADS) return;
    if (scan && (scan.status === 'running' || scan.status === 'ready')) return;
    started.current = true;
    api
      .detectProjects()
      .then(setScan)
      .catch((e: Error) => setError(e.message));
  }, [scan, mailIn, threads]);

  // Everything found starts out ticked, under the name Timmy gave it.
  useEffect(() => {
    if (scan?.status !== 'ready') return;
    setKeep(Object.fromEntries(scan.proposals.map((p) => [p.id, true])));
    setNames(Object.fromEntries(scan.proposals.map((p) => [p.id, p.name])));
  }, [scan?.id, scan?.status]);

  const create = async () => {
    if (scan?.status !== 'ready') return;
    setBusy(true);
    setError('');
    try {
      const r = await api.keepProjects(
        scan.id,
        scan.proposals.map((p) => {
          const name = (names[p.id] ?? p.name).trim();
          return { id: p.id, keep: !!keep[p.id], ...(name && name !== p.name ? { name } : {}) };
        }),
      );
      const moved = r.created.reduce((n, c) => n + c.threads, 0);
      const files = r.created.reduce((n, c) => n + c.files, 0);
      dispatch({
        type: 'toast',
        text: r.created.length
          ? `Created ${r.created.length === 1 ? r.created[0]!.name : `${r.created.length} projects`} with ${moved} email${moved === 1 ? '' : 's'}${files ? ` and ${files} file${files === 1 ? '' : 's'}` : ''}. New mail and files go in them on their own.`
          : 'Nothing was kept.',
      });
      setScan({ ...scan, status: 'applied', proposals: [] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const again = () => {
    started.current = true;
    setError('');
    api
      .detectProjects()
      .then(setScan)
      .catch((e: Error) => setError(e.message));
  };

  const ticked = scan?.status === 'ready' ? scan.proposals.filter((p) => keep[p.id]).length : 0;
  const has = activeProjects(state.ws).length;

  return (
    <>
      <p className="setup-text">Timmy reads the last 90 days of your mail, meetings and files and finds the projects in them: the clients, deals, hires and suppliers you work with. Keep what fits; from then on new mail and files go into them on their own.</p>
      {error && (
        <p className="live-error" role="alert">
          {error}
        </p>
      )}
      {!mailIn ? (
        <p className="setup-fine">Connect your email first (step 1).</p>
      ) : scan === undefined ? (
        <p className="setup-fine" role="status">
          One moment…
        </p>
      ) : scan?.status === 'running' || (!scan && threads >= MIN_THREADS) ? (
        <div className="setup-scan" role="status">
          <Radar size={20} className="dp-spin" aria-hidden />
          <span>
            <strong>Finding your projects…</strong> Timmy groups your mail and files by who you work with and what about, then names each group. About a minute.
          </span>
        </div>
      ) : threads < MIN_THREADS && scan?.status !== 'ready' ? (
        <div className="setup-scan" role="status">
          <Radar size={20} className="dp-spin" aria-hidden />
          <span>
            <strong>Waiting for your mail to come in…</strong> The scan starts by itself as soon as there is enough to go on.
          </span>
        </div>
      ) : scan?.status === 'ready' && scan.proposals.length ? (
        <ul className="setup-found" aria-label="Projects Timmy found">
          {scan.proposals.map((p) => (
            <li key={p.id} data-kept={keep[p.id] ? 'true' : undefined}>
              <input type="checkbox" checked={!!keep[p.id]} onChange={(e) => setKeep((k) => ({ ...k, [p.id]: e.target.checked }))} aria-label={`Keep ${names[p.id] ?? p.name}`} />
              <span className="setup-found-main">
                <input className="input setup-found-name" value={names[p.id] ?? p.name} onChange={(e) => setNames((n) => ({ ...n, [p.id]: e.target.value }))} aria-label="Project name" maxLength={60} />
                <span className="setup-found-meta">
                  {p.threads.length} email{p.threads.length === 1 ? '' : 's'}
                  {p.files.length ? ` · ${p.files.length} file${p.files.length === 1 ? '' : 's'}` : ''}
                  {p.meetings.length ? ` · ${p.meetings.length} meeting${p.meetings.length === 1 ? '' : 's'}` : ''}
                  {p.people.length ? ` · ${p.people.slice(0, 3).map((x) => x.name).join(', ')}` : ''}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : scan?.status === 'ready' ? (
        <p className="setup-fine">Timmy didn’t find anything that looks like a project yet: no company or person comes up in more than one email. You can scan again once more mail is in, from Projects.</p>
      ) : scan?.status === 'failed' ? (
        <p className="setup-flash setup-flash-warn">{scan.error ?? 'The scan didn’t finish.'}</p>
      ) : has === 0 && scan?.status === 'applied' ? (
        <p className="setup-fine">No projects were kept.</p>
      ) : null}
      <div className="setup-row-end setup-row-gap">
        <button className="btn btn-sm btn-ghost" onClick={onSkip} disabled={busy}>
          Skip for now
        </button>
        {(scan?.status === 'failed' || (scan?.status === 'ready' && !scan.proposals.length) || (scan?.status === 'applied' && has === 0)) && (
          <button className="btn btn-sm" onClick={again} disabled={busy}>
            <Radar size={14} />
            Scan again
          </button>
        )}
        {scan?.status === 'ready' && scan.proposals.length > 0 && (
          <button className="btn btn-sm btn-primary" disabled={busy || !ticked} onClick={() => void create()}>
            <FolderInput size={14} />
            {busy ? 'Creating…' : `Create ${ticked === 1 ? '1 project' : `${ticked} projects`}`}
          </button>
        )}
      </div>
    </>
  );
}

/* ───────────── See Timmy at work ───────────── */

export type TourPart = 'email' | 'todo' | 'doc';

export function TourStep({ tried, onTried, onFinish, hasFiles }: { tried: TourPart[]; onTried: (part: TourPart) => void; onFinish: () => void; hasFiles: boolean }) {
  const { state } = useStore();
  const projects = activeProjects(state.ws);
  const count = (['email', 'todo', 'doc'] as TourPart[]).filter((p) => tried.includes(p)).length;
  return (
    <>
      <p className="setup-text">Three things to try on your own mail and files. Nothing here leaves Timmy except a document you edit and save, which goes back to Drive.</p>
      {!projects.length && <p className="setup-fine">You have no projects yet. Create one from the picker below, or find them in step 3.</p>}
      <ol className="setup-tour">
        <EmailInProject done={tried.includes('email')} onDone={() => onTried('email')} />
        <TodoFromEmail done={tried.includes('todo')} onDone={() => onTried('todo')} />
        <DocInTimmy done={tried.includes('doc')} onDone={() => onTried('doc')} hasFiles={hasFiles} />
      </ol>
      <div className="setup-row-end setup-row-gap">
        <span className="setup-fine setup-tour-count">{count} of 3 tried</span>
        <button className="btn btn-sm btn-primary" onClick={onFinish}>
          <Check size={14} />
          {count === 3 ? 'Done' : 'Finish the tour'}
        </button>
      </div>
    </>
  );
}

function Card({ icon, title, done, children }: { icon: ReactNode; title: string; done: boolean; children: ReactNode }) {
  return (
    <li className="setup-tour-card" data-done={done ? 'true' : undefined}>
      <span className="setup-tour-icon" aria-hidden>
        {done ? <Check size={15} strokeWidth={2.5} /> : icon}
      </span>
      <div className="setup-tour-body">
        <strong>{title}</strong>
        {children}
      </div>
    </li>
  );
}

/** The newest email worth filing that isn't in a project yet, chosen once so it stays put while the person works. */
function useCandidate(): Thread | undefined {
  const { state } = useStore();
  const [id] = useState(() => {
    const open = [...state.threads].filter((t) => t.box !== 'archived' && t.messages.length).sort((a, b) => +new Date(b.messages.at(-1)!.at) - +new Date(a.messages.at(-1)!.at));
    return (open.find((t) => !t.project && counterpart(t) !== 'me') ?? open[0])?.id;
  });
  return state.threads.find((t) => t.id === id);
}

function EmailInProject({ done, onDone }: { done: boolean; onDone: () => void }) {
  const { state } = useStore();
  const t = useCandidate();
  const [start] = useState(() => t?.project);
  const project = t?.project ? state.ws.projects[t.project] : undefined;
  // Done once the person has put this email in a project (or moved it to another).
  useEffect(() => {
    if (t?.project && t.project !== start && !done) onDone();
  }, [t?.project]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Card icon={<FolderInput size={15} />} title="Put an email in a project" done={done}>
      {t ? (
        <>
          <span className="setup-tour-what">
            “{t.subject}” from {senderOf(t)}
          </span>
          <div className="setup-tour-act">
            <ProjectPicker t={t} />
            {project && done && <span className="setup-fine">In {project.name}. Its to-dos went with it.</span>}
          </div>
          <span className="setup-fine">Anywhere in Timmy: press P on an email, or use the project button on its row in Triage. “Always” sends the sender’s new mail there too.</span>
        </>
      ) : (
        <span className="setup-fine">Your mail is still coming in.</span>
      )}
    </Card>
  );
}

function TodoFromEmail({ done, onDone }: { done: boolean; onDone: () => void }) {
  const { state, dispatch } = useStore();
  const candidate = useCandidate();
  const [made, setMade] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const projects = activeProjects(state.ws);
  // The to-do to show: one made here, or the newest Timmy took from an email by itself.
  const task = useMemo(() => {
    if (made && state.ws.tasks[made]) return state.ws.tasks[made];
    return Object.values(state.ws.tasks)
      .filter((x) => x.thread && x.by === 'timmy' && x.status !== 'done')
      .sort((a, b) => +new Date(b.created) - +new Date(a.created))[0];
  }, [made, state.ws.tasks]);
  const from = task?.thread ? state.threads.find((t) => t.id === task.thread) : undefined;
  const make = async () => {
    if (!candidate) return;
    setBusy(true);
    setNote('');
    try {
      const r = await api.todoFromEmail(candidate.id);
      setMade(r.task.id);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const setProject = (id: string) => {
    if (!task) return;
    const p = id ? state.ws.projects[id] : undefined;
    dispatch(ws([patch('tasks', task.id, { project: id || undefined })], { toast: p ? `“${task.title}” is in ${p.name}` : `“${task.title}” is in no project`, undo: true }));
  };
  const inProject = task?.project ? state.ws.projects[task.project] : undefined;
  // Done once a to-do from an email is in a project: Timmy's own (it goes with its email) or one the person placed.
  useEffect(() => {
    if (task?.project && !done) onDone();
  }, [task?.project]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Card icon={<ListChecks size={15} />} title="A to-do from an email, in a project" done={done}>
      {task ? (
        <>
          <span className="setup-tour-what">
            <Sparkles size={12} aria-hidden /> Timmy made “{task.title}”{from ? ` from “${from.subject}”` : ''}
            {task.due ? `, due ${new Date(task.due).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}.
          </span>
          <div className="setup-tour-act">
            <label className="setup-tour-select">
              <span>Project</span>
              <select className="input" value={task.project ?? ''} onChange={(e) => setProject(e.target.value)} aria-label="The to-do’s project">
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {!made && candidate && (
              <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void make()}>
                {busy ? 'Reading…' : 'Make one from another email'}
              </button>
            )}
          </div>
          {inProject && <span className="setup-fine">In {inProject.name}: a to-do goes into its email’s project, and follows the email if it moves.</span>}
          <span className="setup-fine">Timmy adds what an email asks of you to Tasks by itself. On any email, Make a to-do asks it to.</span>
        </>
      ) : candidate ? (
        <>
          <span className="setup-tour-what">
            “{candidate.subject}” from {senderOf(candidate)}
          </span>
          <div className="setup-tour-act">
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void make()}>
              <Sparkles size={14} />
              {busy ? 'Reading the email…' : 'Make a to-do from this email'}
            </button>
          </div>
          {note && <span className="setup-fine">{note}</span>}
        </>
      ) : (
        <span className="setup-fine">Your mail is still coming in.</span>
      )}
    </Card>
  );
}

type Listed = Awaited<ReturnType<typeof api.connectedFiles>>['files'][number];
const EDITABLE = /^(Google (Doc|Sheet|Slides)|Word|Excel|PowerPoint|PDF)/i;

function DocInTimmy({ done, onDone, hasFiles }: { done: boolean; onDone: () => void; hasFiles: boolean }) {
  const { state, dispatch } = useStore();
  const [file, setFile] = useState<Listed | null | undefined>(undefined);
  const [editing, setEditing] = useState<{ name: string; app: 'wordcraft' | 'gridcraft' | 'deckcraft' | 'pdfcraft'; appName: string; link?: string; native: boolean } | null>(null);
  const [opening, setOpening] = useState(false);

  // A document to open: one Timmy put in a project if there is one, else the newest it can edit. Looked for again
  // every few seconds while the files are still being listed.
  useEffect(() => {
    if (!hasFiles) return;
    let gone = false;
    let timer = 0;
    const look = () =>
      api
        .connectedFiles()
        .then((r) => {
          if (gone) return;
          const editable = r.files.filter((f) => EDITABLE.test(f.kind) || /\.(docx|xlsx|pptx|pdf)$/i.test(f.name));
          const pick = editable.find((f) => f.project) ?? editable[0] ?? null;
          setFile(pick);
          if (!pick) timer = window.setTimeout(look, 4000);
        })
        .catch(() => !gone && setFile(null));
    void look();
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [hasFiles]);

  const open = async () => {
    if (!file) return;
    setOpening(true);
    try {
      const v = await api.viewFile(file.id);
      if (!v.edit) throw new Error(`Timmy’s editors don’t open this kind of file. Open it in ${v.app}.`);
      setEditing({ name: v.name, app: v.edit.app, appName: v.app, link: v.link, native: v.edit.native });
    } catch (e) {
      dispatch({ type: 'toast', text: (e as Error).message, tone: 'warn' });
    } finally {
      setOpening(false);
    }
  };
  const project = file?.project ? state.ws.projects[file.project] : undefined;

  return (
    <Card icon={<FileText size={15} />} title="Open a Drive document in Timmy" done={done}>
      {!hasFiles ? (
        <span className="setup-fine">Connect Google Drive or OneDrive (step 2) to try this.</span>
      ) : file === undefined ? (
        <span className="setup-fine">Looking for a document…</span>
      ) : file === null ? (
        <span className="setup-fine">Your files are still being listed. This fills in within a few minutes.</span>
      ) : (
        <>
          <span className="setup-tour-what">
            “{file.name}” · {file.kind}
            {project ? ` · in ${project.name}` : ''}
          </span>
          <div className="setup-tour-act">
            <button className="btn btn-sm btn-primary" disabled={opening} onClick={() => void open()}>
              <PencilLine size={14} />
              {opening ? 'Opening…' : 'Open in Timmy’s editor'}
            </button>
          </div>
          <span className="setup-fine">Edit it here; File › Save goes back to the file in Google Drive, which keeps the earlier version.</span>
        </>
      )}
      {editing && file && (
        <DriveEditor
          itemId={file.id}
          name={editing.name}
          app={editing.app}
          appName={editing.appName}
          link={editing.link}
          native={editing.native}
          onClose={() => {
            setEditing(null);
            onDone();
          }}
        />
      )}
    </Card>
  );
}
