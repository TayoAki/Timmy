/* One file, any kind: a shared header, then the editor or preview for its kind. */
import { ArrowLeft, ChevronRight, Download, FileX, FolderOpen, Mail, Maximize2, Minimize2, Sparkles, Star } from 'lucide-react';
import { FULLSCREEN_KEY, useFullscreen } from '../../lib/fullscreen';
import { useEffect, useState } from 'react';
import { Avatar, Kbd } from '../../components/common';
import { DocIcon, DocPath, DocThumb, kindMeta } from '../../components/DocBits';
import { Frame } from '../../components/Frame';
import { EmptyState, Segmented } from '../../components/kit';
import { officeExt } from '../../lib/office';
import { CraftViewer } from '../viewers/CraftViewer';
import { appForFile, CRAFT, download, fileBytes, hasNativeBody, hasOwnBytes, type CraftApp } from '../viewers/craft';
import { NOW } from '../../data/mock';
import type { WFile, WS } from '../../data/ws-types';
import { fmtStamp } from '../../lib/format';
import { useStore, ws, type Action } from '../../state/store';
import { MAX_STARRED, patch, pathOf, personName, put, signOff } from '../../state/ws';
import { FileActionsMenu } from '../files/FileActions';
import { BlockText, DocEditor } from './DocEditor';
import { DeckView } from './DeckView';
import { PageHeader } from './PageHeader';
import { SheetEditor } from './SheetEditor';
import { shortPath } from './shared';
import { bid } from './templates';

export const emailLink = (W: WS, file: WFile): Action => ({
  type: 'compose',
  draft: {
    to: [],
    subject: file.name,
    body: `Hi,\n\nHere’s the link to “${file.name}”. It’s in ${pathOf(W, file.folder).join(' › ')}.\n\n${signOff('Thanks')}`,
    project: file.project,
  },
});

export const showInFolder = (file: WFile): Action => ({ type: 'navigate', route: { view: 'files', tab: 'browse', folder: file.folder } });

export function toggleStarOps(W: WS, file: WFile, dispatch: (a: Action) => void) {
  const starred = Object.values(W.files).filter((f) => f.starred).length;
  if (!file.starred && starred >= MAX_STARRED) {
    dispatch({ type: 'toast', text: `${MAX_STARRED} files are already starred. Unstar one first: if everything is starred, nothing is.`, tone: 'warn' });
    return;
  }
  dispatch(ws([patch('files', file.id, { starred: !file.starred })], { toast: file.starred ? 'Removed the star' : `Starred · ${starred + 1} of ${MAX_STARRED}` }));
}

export function FileView() {
  const { state, dispatch } = useStore();
  const W = state.ws;
  const id = state.route.view === 'file' ? state.route.id : '';
  const entry = W.files[id] ?? W.trash[id];
  const file = entry?.shortcutOf ? W.files[entry.shortcutOf] : entry;
  const [mode, setMode] = useState<'timmy' | 'craft'>('timmy');
  // Full screen for Timmy's own editors (the full editors have their own, same shortcut).
  const nativeView = !!file && mode === 'timmy' && hasNativeBody(file, W);
  const fs = useFullscreen<HTMLDivElement>(nativeView);

  if (!entry || !file) {
    return (
      <Frame tabs={[{ id: 'file', label: 'File' }]} active="file" onTab={() => undefined}>
        <EmptyState
          icon={FileX}
          title="This file isn’t here any more"
          body="It may have been deleted. Search for it, or go back."
          action={
            <button className="btn" onClick={() => dispatch({ type: 'back' })}>
              <ArrowLeft size={14} aria-hidden />
              Go back
            </button>
          }
        />
      </Frame>
    );
  }

  const meta = kindMeta(file.kind);
  const doc = file.kind === 'doc' ? W.docs[file.id] : undefined;
  const sheet = file.kind === 'sheet' ? W.sheets[file.id] : undefined;
  const deck = file.kind === 'slides' ? W.decks[file.id] : undefined;
  const count = doc ? undefined : sheet ? sheet.rows.length : deck ? deck.slides.length : undefined;

  const start = () => {
    const op =
      file.kind === 'doc'
        ? put('docs', { id: file.id, template: 'blank', blocks: [{ id: bid(), type: 'p', text: '' }] })
        : file.kind === 'sheet'
          ? put('sheets', { id: file.id, table: 'Table', columns: [{ key: 'name', name: 'Name', type: 'text' }, { key: 'value', name: 'Value', type: 'number' }], rows: [{ name: '', value: '' }] })
          : put('decks', { id: file.id, slides: [{ id: 's1', title: file.name, layout: 'title' }] });
    dispatch(ws([op, patch('files', file.id, { updated: NOW })]));
  };

  const app = appForFile(file);
  const native = hasNativeBody(file, W);
  const viewer = mode === 'craft' || (!native && !!app && (hasOwnBytes(file) || file.kind === 'pdf'));

  let body;
  if (viewer && app) body = <CraftViewer file={file} app={app} note={native ? craftNote(file, app) : undefined} />;
  else if (file.kind === 'doc') body = doc ? <DocEditor file={file} body={doc} /> : <Blank kind="doc" onStart={start} />;
  else if (file.kind === 'sheet') body = sheet ? <SheetEditor file={file} sheet={sheet} /> : <Blank kind="sheet" onStart={start} />;
  else if (file.kind === 'slides') body = deck ? <DeckView file={file} deck={deck} /> : <Blank kind="slides" onStart={start} />;
  else body = <Preview file={file} />;

  return (
    <Frame
      tabs={[{ id: 'file', label: meta.label, count }]}
      active="file"
      onTab={() => undefined}
      wide={file.kind === 'sheet' || file.kind === 'slides' || (viewer && !!app)}
      scrollKey={file.id}
    >
      <div ref={fs.ref} className={`file-stage${fs.full ? ' full' : ''}`}>
        {doc && !viewer ? <PageHeader file={file} body={doc} shortcut={entry.shortcutOf ? entry : undefined} /> : <FileHeader file={file} shortcut={entry.shortcutOf ? entry : undefined} />}
        {native && app && !file.trashed && <ModeSwitch file={file} app={app} mode={mode} onMode={setMode} onFull={nativeView ? fs.toggle : undefined} full={fs.full} />}
        {body}
      </div>
    </Frame>
  );
}

const craftNote = (file: WFile, app: CraftApp) =>
  file.stored
    ? `This is the .${file.format ?? officeExt(file.kind)} copy you saved in the full editor. The Timmy editor keeps its own version, which Timmy reads for drafts.`
    : `The full editor opens a .${officeExt(file.kind)} copy of this ${CRAFT[app].noun}. Saving there keeps that copy with the file; the Timmy editor keeps its own version, which Timmy reads for drafts.`;

/** Timmy's editor or the full Craft app, for a Timmy doc, sheet or deck. */
function ModeSwitch({
  file,
  app,
  mode,
  onMode,
  onFull,
  full,
}: {
  file: WFile;
  app: CraftApp;
  mode: 'timmy' | 'craft';
  onMode: (m: 'timmy' | 'craft') => void;
  onFull?: () => void;
  full?: boolean;
}) {
  const { state } = useStore();
  const save = async () => {
    const data = await fileBytes(file, state.ws);
    if (data) download(data.name, data.bytes);
  };
  return (
    <div className="file-mode">
      <Segmented
        label="Open with"
        value={mode}
        onChange={onMode}
        options={[
          { id: 'timmy', label: 'Timmy editor' },
          { id: 'craft', label: 'Full editor' },
        ]}
      />
      <span className="file-mode-hint">
        {mode === 'timmy' ? `The full editor adds ${CRAFT[app].does}.` : `The .${file.format ?? officeExt(file.kind)} file, in the ${CRAFT[app].label.toLowerCase()}.`}
      </span>
      {mode === 'timmy' && (
        <div className="file-mode-actions">
          <button className="btn btn-xs btn-ghost" onClick={save}>
            <Download size={13} aria-hidden />
            Download .{file.format ?? officeExt(file.kind)}
          </button>
          {onFull && (
            <button className="btn btn-xs btn-ghost" onClick={onFull} aria-pressed={!!full} title={`${full ? 'Exit full screen' : 'Full screen'} (${FULLSCREEN_KEY})`}>
              {full ? <Minimize2 size={13} aria-hidden /> : <Maximize2 size={13} aria-hidden />}
              {full ? 'Exit full screen' : 'Full screen'}
              <Kbd>{FULLSCREEN_KEY}</Kbd>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Blank({ kind, onStart }: { kind: 'doc' | 'sheet' | 'slides'; onStart: () => void }) {
  const label = kind === 'doc' ? 'doc' : kind === 'sheet' ? 'sheet' : 'deck';
  return (
    <EmptyState
      icon={kindMeta(kind).icon}
      title={`This ${label} is empty`}
      body="Nothing has been written in it yet."
      action={
        <button className="btn btn-primary" onClick={onStart}>
          Start the {label}
        </button>
      }
    />
  );
}

function FileHeader({ file, shortcut }: { file: WFile; shortcut?: WFile }) {
  const { state, dispatch } = useStore();
  const W = state.ws;
  const [name, setName] = useState(file.name);
  useEffect(() => setName(file.name), [file.name]);
  const meta = kindMeta(file.kind);

  const commit = () => {
    const n = name.replace(/\s+/g, ' ').trim();
    if (!n) return setName(file.name);
    if (n !== file.name) dispatch(ws([patch('files', file.id, { name: n })], { toast: `Renamed to “${n}”`, undo: true }));
  };

  return (
    <header className="doc-head">
      <nav className="crumbs" aria-label="Breadcrumb">
        <button className="btn btn-xs btn-ghost" onClick={() => dispatch({ type: 'back' })} style={{ marginLeft: -8 }}>
          <ArrowLeft size={14} aria-hidden />
          Back
        </button>
        <button onClick={() => dispatch({ type: 'navigate', route: { view: 'docs', tab: 'recent' } })}>Docs</button>
        <ChevronRight size={14} aria-hidden />
        <span className="crumb-current" aria-current="page">
          {meta.label}
        </span>
      </nav>

      <div className="doc-title-row">
        <span className="doc-title-icon">
          <DocIcon kind={file.kind} size={24} />
        </span>
        <BlockText
          className="doc-title-input"
          value={name}
          aria-label="File name"
          spellCheck={false}
          onChange={(e) => setName(e.target.value.replace(/\n/g, ''))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              setName(file.name);
              e.currentTarget.blur();
            }
          }}
        />
        <div className="doc-title-actions">
          <button
            className={`icon-btn${file.starred ? ' on' : ''}`}
            aria-label={file.starred ? 'Remove star' : 'Star'}
            aria-pressed={!!file.starred}
            title={file.starred ? 'Remove star' : `Star (up to ${MAX_STARRED})`}
            onClick={() => toggleStarOps(W, file, dispatch)}
          >
            <Star size={18} fill={file.starred ? 'currentColor' : 'none'} />
          </button>
          <FileActionsMenu fileId={file.id} />
        </div>
      </div>

      <div className="doc-meta">
        <button className="doc-path-btn" onClick={() => dispatch(showInFolder(file))} title="Show in folder">
          <DocPath path={pathOf(W, file.folder)} />
        </button>
        <span className="doc-meta-item">
          <Avatar id={file.owner} size={18} />
          {file.owner === 'me' ? 'You' : personName(file.owner)}
        </span>
        <span className="doc-meta-item">Edited {fmtStamp(file.updated)}</span>
        {file.createdByTimmy && (
          <span className="chip accent">
            <Sparkles size={12} aria-hidden />
            Created by Timmy
          </span>
        )}
        {shortcut && <span className="chip">Opened from a shortcut in {shortPath(W, shortcut.folder)}</span>}
        {file.sharedBy && file.share === 'pending' && <span className="chip">Shared by {personName(file.sharedBy)}</span>}
      </div>
    </header>
  );
}

function Preview({ file }: { file: WFile }) {
  const { state, dispatch } = useStore();
  const W = state.ws;
  const from = file.filing?.fromThread ? state.threads.find((t) => t.id === file.filing!.fromThread) : undefined;
  return (
    <div className="doc-preview">
      <div className={`doc-preview-frame doc-preview-${file.kind}`}>
        <DocThumb doc={file} />
      </div>
      <dl className="kv doc-preview-kv">
        <dt>Type</dt>
        <dd>{kindMeta(file.kind).label}</dd>
        <dt>Location</dt>
        <dd>
          <DocPath path={pathOf(W, file.folder)} />
        </dd>
        <dt>Owner</dt>
        <dd>{file.owner === 'me' ? 'You' : personName(file.owner)}</dd>
        <dt>Modified</dt>
        <dd>{fmtStamp(file.updated)}</dd>
        <dt>Keywords</dt>
        <dd>{file.description ?? <span className="muted">None. Add keywords from the file menu so search finds it.</span>}</dd>
        {file.filing && (
          <>
            <dt>Suggested</dt>
            <dd>
              <code className="code">{file.filing.name}</code>
            </dd>
          </>
        )}
      </dl>
      <div className="doc-preview-actions">
        <button className="btn btn-sm" onClick={() => dispatch(showInFolder(file))}>
          <FolderOpen size={14} aria-hidden />
          Show in folder
        </button>
        <button className="btn btn-sm" onClick={() => dispatch(emailLink(W, file))}>
          <Mail size={14} aria-hidden />
          Email a link
        </button>
        {from && (
          <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'openThread', id: from.id })}>
            <Mail size={14} aria-hidden />
            Open the email it came with
          </button>
        )}
      </div>
    </div>
  );
}
