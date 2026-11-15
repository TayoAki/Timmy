/* New sheet and new deck: named with the convention, filed in a folder, started from a structure. */
import { useId, useState } from 'react';
import { Modal } from '../../components/kit';
import { NOW } from '../../data/mock';
import type { Sheet, SheetColumn, WFile } from '../../data/ws-types';
import { useStore, ws } from '../../state/store';
import { put, uid } from '../../state/ws';
import { SlideThumb } from './SlideThumb';
import { composeName, DECK_KEYWORDS, NameField, SHEET_KEYWORDS, type NameParts } from './naming';
import { FolderSelect } from './shared';
import { LAYOUT_SETS, type LayoutSet } from './templates';

interface NewInitial {
  project?: string;
  folder?: string;
}

function ProjectFolder({
  project,
  folder,
  onProject,
  onFolder,
}: {
  project: string;
  folder: string;
  onProject: (id: string) => void;
  onFolder: (id: string) => void;
}) {
  const { state } = useStore();
  const ids = { p: useId(), f: useId() };
  return (
    <div className="field-row">
      <div className="field">
        <label className="field-label" htmlFor={ids.p}>
          Project
        </label>
        <select id={ids.p} className="input" value={project} onChange={(e) => onProject(e.target.value)}>
          <option value="">No project</option>
          {Object.values(state.ws.projects)
            .filter((p) => p.status === 'active')
            .map((p) => (
              <option key={p.id} value={p.id}>
                [{p.num}] {p.name}
              </option>
            ))}
        </select>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={ids.f}>
          Folder
        </label>
        <FolderSelect id={ids.f} ws={state.ws} value={folder} onChange={onFolder} />
      </div>
    </div>
  );
}

/** Shared state for the project, folder and name of a new file. */
function useNewFile(initial: NewInitial | undefined, parts: Omit<NameParts, 'subject'>) {
  const { state } = useStore();
  const [project, setProject] = useState(initial?.project ?? '');
  const [folder, setFolder] = useState(initial?.folder ?? (initial?.project ? state.ws.projects[initial.project]?.folder : undefined) ?? 'f02');
  const [folderTouched, setFolderTouched] = useState(!!initial?.folder);
  const [name, setName] = useState<NameParts>({ ...parts, subject: initial?.project ? state.ws.projects[initial.project]?.name ?? '' : '' });
  const [nameTouched, setNameTouched] = useState(false);
  return {
    project,
    folder,
    name,
    setName: (v: NameParts) => {
      setName(v);
      setNameTouched(true);
    },
    onProject: (id: string) => {
      setProject(id);
      const p = id ? state.ws.projects[id] : undefined;
      if (!folderTouched) setFolder(p?.folder ?? 'f02');
      if (!nameTouched) setName((n) => ({ ...n, subject: p?.name ?? '' }));
    },
    onFolder: (id: string) => {
      setFolder(id);
      setFolderTouched(true);
    },
  };
}

/* ───────────── New sheet ───────────── */

type Starter = 'tracker' | 'budget' | 'blank';

const STARTERS: Record<Starter, { label: string; table: string; columns: SheetColumn[]; blurb: string }> = {
  tracker: {
    label: 'Tracker',
    table: 'Tracker',
    blurb: 'One row per item, with an owner, a status and a date.',
    columns: [
      { key: 'item', name: 'Item', type: 'text' },
      { key: 'owner', name: 'Owner', type: 'text' },
      { key: 'status', name: 'Status', type: 'text' },
      { key: 'due', name: 'Due', type: 'date' },
    ],
  },
  budget: {
    label: 'Budget',
    table: 'Budget',
    blurb: 'Quantity times unit cost, worked out for every row with a named-column formula.',
    columns: [
      { key: 'item', name: 'Item', type: 'text' },
      { key: 'qty', name: 'Quantity', type: 'number' },
      { key: 'unit', name: 'Unit cost', type: 'currency' },
      { key: 'total', name: 'Total', type: 'currency', formula: '[Quantity] * [Unit cost]' },
    ],
  },
  blank: {
    label: 'Blank',
    table: 'Table',
    blurb: 'Two columns to start. Add columns as you go.',
    columns: [
      { key: 'name', name: 'Name', type: 'text' },
      { key: 'value', name: 'Value', type: 'number' },
    ],
  },
};

export function NewSheetDialog(props: { open: boolean; onClose: () => void; initial?: NewInitial }) {
  if (!props.open) return null;
  return <NewSheetForm {...props} />;
}

function NewSheetForm({ onClose, initial }: { onClose: () => void; initial?: NewInitial }) {
  const { dispatch } = useStore();
  const f = useNewFile(initial, { gran: 'quarter', keyword: 'Working sheet' });
  const [starter, setStarter] = useState<Starter>('tracker');
  const full = composeName(f.name);

  const create = () => {
    if (!full) return;
    const id = uid('sheet');
    const st = STARTERS[starter];
    const empty = () => Object.fromEntries(st.columns.filter((c) => !c.formula).map((c) => [c.key, ''])) as Sheet['rows'][number];
    const file: WFile = { id, name: full, kind: 'sheet', folder: f.folder, updated: NOW, owner: 'me', project: f.project || undefined };
    dispatch(ws([put('files', file), put('sheets', { id, table: st.table, columns: st.columns, rows: [empty(), empty(), empty()] })], { toast: `Created “${full}”`, undo: true, log: `Created the sheet “${full}”` }));
    onClose();
    dispatch({ type: 'navigate', route: { view: 'file', id } });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New sheet"
      description="Recurring data works best as one table with named columns."
      width={580}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!full} onClick={create}>
            Create sheet
          </button>
        </>
      }
    >
      <form
        className="doc-form-contents"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <NameField value={f.name} onChange={f.setName} keywords={SHEET_KEYWORDS} />
      </form>
      <div className="field" role="radiogroup" aria-label="Start with">
        <span className="field-label">Start with</span>
        <div className="doc-tpl-pick three">
          {(Object.keys(STARTERS) as Starter[]).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={starter === k} className="doc-tpl-opt" onClick={() => setStarter(k)}>
              <span>{STARTERS[k].label}</span>
            </button>
          ))}
        </div>
        <span className="field-hint">
          {STARTERS[starter].blurb} Columns:{' '}
          {STARTERS[starter].columns.map((c, i) => (
            <span key={c.key}>
              {i > 0 && ', '}
              {c.formula ? (
                <>
                  {c.name} <code className="code">= {c.formula}</code>
                </>
              ) : (
                c.name
              )}
            </span>
          ))}
        </span>
      </div>
      <ProjectFolder project={f.project} folder={f.folder} onProject={f.onProject} onFolder={f.onFolder} />
    </Modal>
  );
}

/* ───────────── New deck from a layout set ───────────── */

export function NewDeckDialog(props: { open: boolean; onClose: () => void; initial?: NewInitial & { layout?: LayoutSet['id'] } }) {
  if (!props.open) return null;
  return <NewDeckForm {...props} />;
}

function NewDeckForm({ onClose, initial }: { onClose: () => void; initial?: NewInitial & { layout?: LayoutSet['id'] } }) {
  const { state, dispatch } = useStore();
  const f = useNewFile(initial, { gran: 'quarter', keyword: 'Briefing slides' });
  const [layout, setLayout] = useState<LayoutSet['id']>(initial?.layout ?? 'briefing');
  const full = composeName(f.name);
  const set = LAYOUT_SETS.find((l) => l.id === layout)!;

  const create = () => {
    if (!full) return;
    const id = uid('slides');
    const project = f.project ? state.ws.projects[f.project] : undefined;
    const slides = set.slides.map((s, i) => ({
      ...s,
      id: `s${i + 1}`,
      title: s.layout === 'title' && i === 0 ? f.name.subject.trim() || s.title : s.title,
      bullets: s.bullets ? [...s.bullets] : undefined,
    }));
    const file: WFile = { id, name: full, kind: 'slides', folder: f.folder, updated: NOW, owner: 'me', project: project?.id };
    dispatch(ws([put('files', file), put('decks', { id, slides })], { toast: `Created “${full}” from the ${set.name} layout`, undo: true, log: `Created the deck “${full}”` }));
    onClose();
    dispatch({ type: 'navigate', route: { view: 'file', id } });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New deck from layout"
      description="Start from a reusable layout. Keep the detail in a working sheet or doc and link it."
      width={640}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!full} onClick={create}>
            Create deck
          </button>
        </>
      }
    >
      <form
        className="doc-form-contents"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <NameField value={f.name} onChange={f.setName} keywords={DECK_KEYWORDS} />
      </form>
      <div className="field" role="radiogroup" aria-label="Layout set">
        <span className="field-label">Layout set</span>
        <div className="deck-sets">
          {LAYOUT_SETS.map((l) => (
            <button key={l.id} type="button" role="radio" aria-checked={layout === l.id} className="deck-set" onClick={() => setLayout(l.id)}>
              <span className="deck-set-strip" aria-hidden>
                {l.slides.slice(0, 3).map((s, i) => (
                  <SlideThumb key={i} bare slide={{ ...s, id: `${l.id}-${i}` }} />
                ))}
              </span>
              <span className="deck-set-name">{l.name}</span>
              <span className="deck-set-blurb">{l.blurb}</span>
            </button>
          ))}
        </div>
      </div>
      <ProjectFolder project={f.project} folder={f.folder} onProject={f.onProject} onFolder={f.onFolder} />
    </Modal>
  );
}
