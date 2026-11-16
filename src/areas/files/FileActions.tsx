/**
 * The actions menu for a file: open, rename (with the naming convention),
 * move, star (max 5), add a description keyword, make a copy, add a shortcut,
 * move to [99] Archived, delete (shortcuts and [06] Temporary only).
 * Owned by the Files area; used by the file editors and the Drive table.
 */
import { Archive, Copy, ExternalLink, FolderInput, FolderSymlink, Pencil, Star, StarOff, Tag, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Menu, Modal, type MenuItem } from '../../components/kit';
import { FILING_FOLDER } from '../../data/ws-mock';
import type { WFile, WS } from '../../data/ws-types';
import { ws, useStore, type Action } from '../../state/store';
import { MAX_STARRED, firstName, patch, type WsOp } from '../../state/ws';
import {
  ARCHIVE,
  canDelete,
  canRename,
  copyOps,
  deleteOps,
  descWords,
  isInside,
  isVirtual,
  parseName,
  projectFor,
  shortPath,
  shortcutOps,
  stamp,
  targetOf,
} from './drive';
import { FolderTreePicker, NameHelper } from './pickers';
import { descendants, isPage, trashOps } from '../docs/pages';

type Dialog = 'rename' | 'move' | 'describe' | 'shortcut' | 'copy' | null;

/* ───────────── Operations shared by the menu and the Drive tabs ───────────── */

export const openFile = (state: WS, f: WFile): Action => ({ type: 'navigate', route: { view: 'file', id: targetOf(state, f).id } });

/** Star or unstar, keeping Starred to five files. */
export const starAction = (state: WS, f: WFile): Action => {
  const starred = Object.values(state.files).filter((x) => x.starred).length;
  if (f.starred) return ws([patch('files', f.id, { starred: false })], { toast: `Unstarred · ${starred - 1} of ${MAX_STARRED}`, undo: true });
  if (starred >= MAX_STARRED)
    return { type: 'toast', tone: 'warn', text: `Five files are already starred. Unstar one first: if everything is starred, nothing is.` };
  return ws([patch('files', f.id, { starred: true })], { toast: `Starred · ${starred + 1} of ${MAX_STARRED}`, undo: true });
};

export const moveOps = (state: WS, f: WFile, folder: string): WsOp[] => {
  const project = projectFor(state, folder);
  return [patch('files', f.id, { folder, ...(project ? { project } : {}), ...(f.folder === FILING_FOLDER ? { filing: undefined } : {}) })];
};

/** A one-line description of the file's place, e.g. for menus. */
const where = (state: WS, folder: string) => shortPath(state, folder);

/* ───────────── The menu ───────────── */

export function FileActionsMenu({ fileId }: { fileId: string }) {
  const { state, dispatch } = useStore();
  const [dialog, setDialog] = useState<Dialog>(null);
  const f = state.ws.files[fileId];
  if (!f) return null;

  const shared = !!f.sharedBy && f.owner !== 'me' && !f.shortcutOf;
  const archived = f.folder === ARCHIVE || (!isVirtual(f.folder) && isInside(state.ws, f.folder, ARCHIVE));
  const owner = firstName(f.owner);

  const items: MenuItem[] = [
    { label: f.shortcutOf ? 'Open original' : 'Open', icon: ExternalLink, onSelect: () => dispatch(openFile(state.ws, f)) },
    {
      label: 'Rename…',
      icon: Pencil,
      onSelect: () => setDialog('rename'),
      disabled: !canRename(f),
      hint: canRename(f) ? undefined : `${owner} only`,
    },
    {
      label: 'Move to…',
      icon: FolderInput,
      onSelect: () => setDialog('move'),
      disabled: shared,
      hint: shared ? 'Add a shortcut' : undefined,
    },
    f.starred
      ? { label: 'Unstar', icon: StarOff, onSelect: () => dispatch(starAction(state.ws, f)) }
      : { label: 'Star', icon: Star, onSelect: () => dispatch(starAction(state.ws, f)), hint: `${Object.values(state.ws.files).filter((x) => x.starred).length}/${MAX_STARRED}` },
    { label: 'Add a description keyword…', icon: Tag, onSelect: () => setDialog('describe') },
    {
      label: 'Make a copy',
      icon: Copy,
      onSelect: () => {
        if (isVirtual(f.folder)) return setDialog('copy');
        const { ops } = copyOps(state.ws, f, f.folder);
        dispatch(ws(ops, { toast: `Copy saved in ${where(state.ws, f.folder)}`, undo: true }));
      },
    },
    { label: 'Add a shortcut to…', icon: FolderSymlink, onSelect: () => setDialog('shortcut') },
    {
      label: 'Move to [99] Archived',
      icon: Archive,
      disabled: archived || shared,
      hint: archived ? 'Already there' : undefined,
      onSelect: () => dispatch(ws(moveOps(state.ws, f, ARCHIVE), { toast: 'Moved to [99] Archived. Still searchable.', undo: true })),
    },
    isPage(f)
      ? {
          label: 'Move to trash',
          icon: Trash2,
          danger: true,
          hint: descendants(state.ws, f.id).length ? `With ${descendants(state.ws, f.id).length} page${descendants(state.ws, f.id).length === 1 ? '' : 's'} inside` : undefined,
          onSelect: () => dispatch(ws(trashOps(state.ws, f.id), { toast: `Moved “${f.name}” to the trash`, undo: true, log: `Moved the page “${f.name}” to the trash` })),
        }
      : {
      label: 'Delete',
      icon: Trash2,
      danger: true,
      disabled: !canDelete(f),
      hint: canDelete(f) ? undefined : 'Only in [06]',
      onSelect: () => dispatch(ws(deleteOps(state.ws, f), { toast: f.shortcutOf ? 'Shortcut removed. The original is untouched.' : `Deleted “${f.name}”`, undo: true })),
    },
  ];

  const close = () => setDialog(null);

  return (
    // Dialogs render in a portal, but their events still bubble through React:
    // stop clicks and Enter/Space here so they never open the row underneath.
    // Other keys pass, so Escape still reaches the menu's document listener.
    <span className="dr-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && e.stopPropagation()}>
      <Menu items={items} label={`Actions for ${f.name}`} />
      {dialog === 'rename' && <RenameDialog file={f} onClose={close} />}
      {dialog === 'describe' && <DescribeDialog file={f} onClose={close} />}
      {(dialog === 'move' || dialog === 'shortcut' || dialog === 'copy') && <PlaceDialog file={f} mode={dialog} onClose={close} />}
    </span>
  );
}

/* ───────────── Rename ───────────── */

const KIND_KEYWORD: Record<WFile['kind'], string | null> = { doc: 'Doc', sheet: 'Working sheet', slides: 'Briefing slides', pdf: null, image: null };

/** Timmy's suggestion for a name that doesn't follow the convention yet. */
export const suggestName = (state: WS, f: WFile) => {
  const { grain, rest } = parseName(f.name);
  if (grain !== 'none' || / — /.test(f.name)) return null;
  const project = f.project ? state.projects[f.project]?.name.split(' ')[0] : undefined;
  const subject = rest.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
  const kw = KIND_KEYWORD[f.kind];
  return kw ? `${project ? `${project} ` : ''}${subject} — ${kw}` : `${stamp('day', f.updated)} ${project ? `${project} — ` : ''}${subject}`;
};

export function RenameDialog({ file, onClose }: { file: WFile; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(file.name);
  const suggestion = suggestName(state.ws, file);
  const clean = name.trim();
  const save = () => {
    if (!clean || clean === file.name) return;
    dispatch(ws([patch('files', file.id, { name: clean })], { toast: `Renamed to “${clean}”`, undo: true }));
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={file.shortcutOf ? 'Rename shortcut' : 'Rename file'}
      description="Dated files start with the date detail the work needs. Undated files end with a keyword, so you can search project and type."
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!clean || clean === file.name} onClick={save}>
            Rename
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="dr-form"
      >
        <NameHelper value={name} onChange={setName} fallbackDate={file.updated} />
        {suggestion && suggestion !== name && (
          <p className="dr-suggest">
            Timmy suggests <span className="code">{suggestion}</span>
            <button type="button" className="btn btn-xs" onClick={() => setName(suggestion)}>
              Use suggestion
            </button>
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/* ───────────── Description keywords ───────────── */

export function DescribeDialog({ file, onClose }: { file: WFile; onClose: () => void }) {
  const { dispatch } = useStore();
  const [words, setWords] = useState<string[]>(descWords(file.description));
  const [text, setText] = useState('');
  const add = () => {
    const extra = descWords(text).filter((w) => !words.some((x) => x.toLowerCase() === w.toLowerCase()));
    if (extra.length) setWords([...words, ...extra]);
    setText('');
  };
  const pending = descWords(text);
  const final = [...words, ...pending.filter((w) => !words.includes(w))];
  const save = () => {
    dispatch(ws([patch('files', file.id, { description: final.join(' ') || undefined })], { toast: final.length ? `Keywords saved: ${final.join(', ')}` : 'Keywords cleared', undo: true }));
    onClose();
  };
  const notMine = !canRename(file);
  return (
    <Modal
      open
      onClose={onClose}
      title="Add a description keyword"
      description={
        notMine
          ? `Only ${firstName(file.owner)} can rename “${file.name}”. Add words you’d search for, like the project or what it’s for.`
          : 'Add words you’d search for, like the project, the person or what it’s for.'
      }
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save}>
            Save keywords
          </button>
        </>
      }
    >
      {words.length > 0 && (
        <div className="chips" aria-label="Keywords">
          {words.map((w) => (
            <span key={w} className="chip">
              {w}
              <button type="button" className="recip-x" aria-label={`Remove ${w}`} onClick={() => setWords(words.filter((x) => x !== w))}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <form
        className="dr-inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. branding logo colours" aria-label="Keywords to add" />
        <button type="submit" className="btn" disabled={!text.trim()}>
          Add
        </button>
      </form>
      <p className="field-hint">Search finds files by these words as well as by name and by who shared them.</p>
    </Modal>
  );
}

/* ───────────── Move, shortcut, copy ───────────── */

const PLACE_COPY = {
  move: { title: 'Move', action: 'Move here', desc: 'File it where you’ll use it, not where it came from.' },
  shortcut: { title: 'Add a shortcut to', action: 'Add shortcut', desc: 'A shortcut opens the live file, so you always see the latest version.' },
  copy: { title: 'Make a copy of', action: 'Make a copy', desc: 'A copy is yours to change. Use it for templates or a version you’ll edit.' },
} as const;

export function PlaceDialog({ file, mode, onClose }: { file: WFile; mode: 'move' | 'shortcut' | 'copy'; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const start = isVirtual(file.folder) ? (projectFolder(state.ws, file) ?? 'f02') : file.folder;
  const [folder, setFolder] = useState(start);
  const copy = PLACE_COPY[mode];
  const same = mode === 'move' && folder === file.folder;
  const save = () => {
    const path = shortPath(state.ws, folder);
    if (mode === 'move') dispatch(ws(moveOps(state.ws, file, folder), { toast: `Moved to ${path}`, undo: true }));
    if (mode === 'shortcut') dispatch(ws(shortcutOps(state.ws, file, folder).ops, { toast: `Shortcut added in ${path}`, undo: true }));
    if (mode === 'copy') dispatch(ws(copyOps(state.ws, file, folder).ops, { toast: `Copy saved in ${path}`, undo: true }));
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`${copy.title} “${targetOf(state.ws, file).name}”`}
      description={copy.desc}
      footer={
        <>
          <span className="dr-foot-path">{shortPath(state.ws, folder)}</span>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={same} onClick={save}>
            {copy.action}
          </button>
        </>
      }
    >
      <FolderTreePicker
        value={folder}
        onChange={setFolder}
        current={isVirtual(file.folder) ? undefined : file.folder}
      />
    </Modal>
  );
}

const projectFolder = (state: WS, f: WFile) => {
  const p = Object.values(state.projects).find((x) => x.sources.includes(f.id) && x.status === 'active');
  return p?.folder;
};

