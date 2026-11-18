import { Check, Plus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Folder } from '../../components/common';
import { DocIcon } from '../../components/DocBits';
import { AutoTextarea, Field, Modal } from '../../components/kit';
import { NOW } from '../../data/mock';
import type { Project, Prompt } from '../../data/ws-types';
import { fmtDate } from '../../lib/format';
import { useStore, ws } from '../../state/store';
import { decisionOps, patch, pathOf, put, uid } from '../../state/ws';
import {
  PROJECT_COLORS,
  WORK_FOLDER,
  colorVar,
  createNotesWithRow,
  nextProjectNum,
  numTakenUnderWork,
  projectDocs,
  projectFiles,
  runningNotesOps,
  slugify,
  todayLabel,
} from './lib';
import { Group } from './ui';

/* ───────────── New project ───────────── */

/** Creates [02] Work › [nn] Name, the project and its running-notes doc in one step. */
/**
 * Makes a project. With `onCreated`, the caller is told the new project's id and the screen stays where it is (an
 * email being put in a new project); without it, the new project opens.
 */
export function NewProjectDialog({ open, onClose, initialName, onCreated }: { open: boolean; onClose: () => void; initialName?: string; onCreated?: (id: string) => void }) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState('');
  const [num, setNum] = useState('');
  const [client, setClient] = useState('');
  const [goal, setGoal] = useState('');
  const [color, setColor] = useState<string>('sky');
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initialName ?? '');
    setNum(nextProjectNum(state.ws));
    setClient('');
    setGoal('');
    setColor(PROJECT_COLORS[(Object.keys(state.ws.projects).length + 1) % PROJECT_COLORS.length]!.id);
    setTried(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const numError = !/^\d{2}$/.test(num)
    ? 'Use two digits, like 15.'
    : num === '99'
      ? '[99] is kept for the archive.'
      : numTakenUnderWork(state.ws, num)
        ? `[${num}] is already used under [02] Work.`
        : '';
  const nameError = name.trim() ? '' : 'Give the project a name.';
  const valid = !numError && !nameError;

  const create = () => {
    setTried(true);
    if (!valid) return;
    const title = name.trim();
    const folderId = state.ws.folders[`f02-${num}`] ? uid('folder') : `f02-${num}`;
    const base = slugify(title) || 'project';
    const id = state.ws.projects[base] ? uid(base) : base;
    const docId = uid('doc');
    const project: Project = {
      id,
      num,
      name: title,
      color: colorVar(color),
      status: 'active',
      client: client.trim() || undefined,
      goal: goal.trim() || undefined,
      folder: folderId,
      notesDoc: docId,
      sources: [docId],
    };
    const firstRow = [todayLabel(), goal.trim() ? `Project started. Goal: ${goal.trim()}` : 'Project started', 'Project page'];
    dispatch(
      ws(
        [
          put('folders', { id: folderId, num, name: title, parent: WORK_FOLDER, color: colorVar(color) }),
          ...runningNotesOps(project, docId, [firstRow]),
          put('projects', project),
        ],
        { toast: `Created [${num}] ${title} with a running notes doc`, undo: true, log: `Created project [${num}] ${title} under [02] Work` },
      ),
    );
    onClose();
    if (onCreated) onCreated(id);
    else dispatch({ type: 'navigate', route: { view: 'project', id, tab: 'overview' } });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New project"
      description="Timmy creates the folder under [02] Work and a running notes doc for decisions."
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={create}>
            Create project
          </button>
        </>
      }
    >
      <form
        className="pj-form"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <div className="pj-form-row">
          <Field label="Number" hint={tried && numError ? <span className="pj-error">{numError}</span> : undefined}>
            <input
              className="input mono pj-num-input"
              value={num}
              inputMode="numeric"
              maxLength={2}
              onChange={(e) => setNum(e.target.value.replace(/\D/g, '').slice(0, 2))}
              aria-invalid={tried && !!numError}
            />
          </Field>
          <Field label="Name" hint={tried && nameError ? <span className="pj-error">{nameError}</span> : undefined}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Brightwave onboarding" aria-invalid={tried && !!nameError} />
          </Field>
        </div>
        <Field label="Client">
          <input className="input" value={client} onChange={(e) => setClient(e.target.value)} placeholder="Company, or Internal" />
        </Field>
        <Field label="Goal" hint="One sentence with a finish line, so you know when to archive it.">
          <input className="input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Live on 40 seats by January 15." />
        </Field>
        <Group label="Colour">
          <div className="pj-swatches" role="radiogroup" aria-label="Project colour">
            {PROJECT_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={color === c.id}
                aria-label={c.label}
                title={c.label}
                className="pj-swatch"
                style={{ ['--tint' as string]: colorVar(c.id) }}
                onClick={() => setColor(c.id)}
              >
                {color === c.id && <Check size={13} strokeWidth={3} />}
              </button>
            ))}
          </div>
        </Group>
        <div className="pj-preview">
          <Folder color={colorVar(color)} size={20} />
          <span>
            My Drive › [02] Work › <strong>
              [{num || '··'}] {name.trim() || 'New project'}
            </strong>
          </span>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/* ───────────── Record a decision ───────────── */

const SOURCES = ['Email', 'Call notes', 'Meeting', '1:1', 'Slack'];

/** Adds a dated row to the top of the project's running notes table. */
export function DecisionDialog({ open, onClose, project }: { open: boolean; onClose: () => void; project: Project }) {
  const { state, dispatch } = useStore();
  const [text, setText] = useState('');
  const [source, setSource] = useState('Email');
  const [tried, setTried] = useState(false);
  const docs = projectDocs(state.ws, project).filter((d) => d.id !== project.notesDoc);
  const listId = `pj-sources-${project.id}`;

  useEffect(() => {
    if (!open) return;
    setText('');
    setSource('Email');
    setTried(false);
  }, [open]);

  const save = () => {
    setTried(true);
    const decision = text.trim();
    if (!decision) return;
    const src = source.trim() || 'Project page';
    const existing = decisionOps(state.ws, project.id, decision, src);
    const ops = existing.length ? existing : createNotesWithRow(project, [todayLabel(), decision, src]);
    dispatch(ws(ops, { toast: `Recorded in ${project.name} running notes`, undo: true, log: `Recorded a decision in ${project.name} running notes` }));
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a decision"
      description={`Adds a row dated ${fmtDate(NOW)} to the top of the running notes, so the project page and its updates stay current.`}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save}>
            Record decision
          </button>
        </>
      }
    >
      <Field label="Decision or update" hint={tried && !text.trim() ? <span className="pj-error">Write the decision in one line.</span> : 'Write it so someone new to the project understands it.'}>
        <AutoTextarea
          minRows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="CFO approved 120 seats at $58; order form goes out Monday"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
          }}
        />
      </Field>
      <Field label="Source" hint="Where it was decided: an email, call notes or a meeting.">
        <input className="input" list={listId} value={source} onChange={(e) => setSource(e.target.value)} />
        <datalist id={listId}>
          {[...SOURCES, ...docs.map((d) => d.name)].map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </Field>
    </Modal>
  );
}

/* ───────────── Pick a source file ───────────── */

/** Choose a file Timmy should read when drafting for this project. */
export function SourcePickerDialog({ open, onClose, project }: { open: boolean; onClose: () => void; project: Project }) {
  const { state, dispatch } = useStore();
  const [q, setQ] = useState('');
  useEffect(() => {
    if (open) setQ('');
  }, [open]);

  const own = new Set(projectFiles(state.ws, project).map((f) => f.id));
  const candidates = useMemo(
    () =>
      Object.values(state.ws.files)
        .filter((f) => !project.sources.includes(f.id) && !f.shortcutOf && f.share !== 'pending' && !f.filing)
        .filter((f) => !q || f.name.toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => Number(own.has(b.id)) - Number(own.has(a.id)) || b.updated.getTime() - a.updated.getTime())
        .slice(0, 30),
    [state.ws.files, project.sources, q], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const add = (id: string) => {
    dispatch(ws([patch('projects', project.id, { sources: [...project.sources, id] })], { toast: `Timmy will read “${state.ws.files[id]!.name}” for ${project.name}`, undo: true }));
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Add a file Timmy reads" description="Drafts for this project quote these files. Files from the project folder are listed first." width={560}>
      <label className="pj-search">
        <Search size={15} aria-hidden />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search files by name" aria-label="Search files by name" />
      </label>
      <ul className="pj-pick">
        {candidates.map((f) => (
          <li key={f.id}>
            <button type="button" className="pj-pick-item" onClick={() => add(f.id)}>
              <DocIcon kind={f.kind} size={16} />
              <span className="pj-pick-text">
                <span className="pj-pick-name">{f.name}</span>
                <span className="pj-pick-path">{pathOf(state.ws, f.folder).slice(1).join(' › ')}</span>
              </span>
              <span className="pj-pick-add">
                <Plus size={14} />
                Add
              </span>
            </button>
          </li>
        ))}
      </ul>
      {candidates.length === 0 && <p className="muted pj-pick-empty">No files match “{q}”.</p>}
    </Modal>
  );
}

/* ───────────── Save a prompt ───────────── */

/** Save a prompt to the AI library, filed under a project when one is given. */
export function PromptDialog({ open, onClose, project }: { open: boolean; onClose: () => void; project?: Project }) {
  const { state, dispatch } = useStore();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [projectId, setProjectId] = useState(project?.id ?? '');
  const [tried, setTried] = useState(false);
  const projects = Object.values(state.ws.projects).filter((p) => p.status === 'active');

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setText('');
    setProjectId(project?.id ?? '');
    setTried(false);
  }, [open, project?.id]);

  const save = () => {
    setTried(true);
    if (!text.trim()) return;
    const prompt: Prompt = {
      id: uid('prompt'),
      title: title.trim() || text.trim().split(/[.\n]/)[0]!.slice(0, 60),
      text: text.trim(),
      status: projectId ? 'filed' : 'captured',
      project: projectId || undefined,
      created: NOW,
    };
    dispatch(ws([put('prompts', prompt)], { toast: projectId ? `Prompt filed under ${state.ws.projects[projectId]!.name}` : 'Prompt saved to the AI library', undo: true }));
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save a prompt"
      description="Keep prompts that worked, so you can reuse them instead of rewriting them."
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save}>
            Save prompt
          </button>
        </>
      }
    >
      <Field label="Prompt" hint={tried && !text.trim() ? <span className="pj-error">Paste or write the prompt.</span> : undefined}>
        <AutoTextarea minRows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="From the running notes, list every open decision with its owner and date." />
      </Field>
      <Field label="Title">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Open decisions list" />
      </Field>
      <Field label="Project">
        <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">None (captured for later)</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              [{p.num}] {p.name}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

/** Small "×" button used in removable lists. */
export function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="icon-btn sm" aria-label={label} onClick={onClick}>
      <X size={14} />
    </button>
  );
}
