import { ArrowUp, ChevronDown, ChevronRight, CornerUpRight, FolderOpen, FolderPlus, Search, Star, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Avatar, Folder as FolderGlyph } from '../../components/common';
import { DocIcon, kindMeta } from '../../components/DocBits';
import { EmptyState, Segmented } from '../../components/kit';
import { PEOPLE } from '../../data/mock';
import type { Folder, WFile } from '../../data/ws-types';
import { fmtListDate, plural } from '../../lib/format';
import { useStore } from '../../state/store';
import { childFolders, folderLabel } from '../../state/ws';
import { FileActionsMenu, openFile } from './FileActions';
import { NewFolderDialog } from './NewFolderDialog';
import { ROOT, SHARED_FOLDER, ancestors, daysAgo, descWords, filesIn, filesUnder, itemCount, personLabel, shortPath, targetOf } from './drive';

const KINDS = [
  { id: 'doc', label: 'Docs' },
  { id: 'sheet', label: 'Sheets' },
  { id: 'slides', label: 'Slides' },
  { id: 'pdf', label: 'PDFs' },
  { id: 'image', label: 'Images' },
];

const WITHIN = [
  { id: 1, label: 'Today' },
  { id: 7, label: 'Last 7 days' },
  { id: 30, label: 'Last 30 days' },
  { id: 90, label: 'Last 90 days' },
];

/** Direct search: name, description keywords, owner and who shared it. */
const matches = (f: WFile, q: string) => {
  const hay = [f.name, f.description ?? '', personLabel(f.owner), f.sharedBy ? PEOPLE[f.sharedBy]?.name ?? '' : '', kindMeta(f.kind).label].join(' ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
};

export function Browse({ folder }: { folder: string }) {
  const { state, dispatch } = useStore();
  const [kind, setKind] = useState('');
  const [owner, setOwner] = useState('');
  const [within, setWithin] = useState(0);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'here' | 'all'>(folder === ROOT ? 'all' : 'here');
  const [newFolder, setNewFolder] = useState(false);

  const chain = folder === ROOT ? [] : ancestors(state.ws, folder);
  const here = chain[chain.length - 1];
  const go = (id: string) => dispatch({ type: 'navigate', route: { view: 'files', tab: 'browse', folder: id } });

  const searching = q.trim().length > 0;
  const pool = useMemo(() => {
    if (!searching) return filesIn(state.ws, folder);
    const base = scope === 'all' ? Object.values(state.ws.files).filter((f) => f.folder !== 'filing') : filesUnder(state.ws, folder);
    return base.filter((f) => matches(f, q.trim()));
  }, [state.ws, folder, searching, scope, q]);

  const owners = [...new Set(pool.map((f) => f.owner))].sort((a, b) => (a === 'me' ? -1 : b === 'me' ? 1 : personLabel(a).localeCompare(personLabel(b))));
  const filtered = !!(kind || owner || within);
  const files = pool
    .filter((f) => !kind || f.kind === kind)
    .filter((f) => !owner || f.owner === owner)
    .filter((f) => !within || daysAgo(targetOf(state.ws, f).updated) < within)
    .sort((a, b) => a.name.localeCompare(b.name));
  const folders = searching || filtered ? [] : childFolders(state.ws, folder === ROOT ? null : folder);
  const clear = () => (setKind(''), setOwner(''), setWithin(0));

  return (
    <>
      <div className="dr-head">
        <nav className="drive-crumbs dr-crumbs" aria-label="Breadcrumb">
          {chain.length === 0 ? (
            <span className="drive-current" aria-current="page">
              My Drive
            </span>
          ) : (
            <button onClick={() => go(ROOT)}>My Drive</button>
          )}
          {chain.map((f, i) => (
            <span key={f.id} className="dr-crumb">
              <ChevronRight size={20} className="sep" aria-hidden />
              {i === chain.length - 1 ? (
                <span className="drive-current" aria-current="page">
                  <span className="dr-num">[{f.num}]</span> {f.name}
                </span>
              ) : (
                <button onClick={() => go(f.id)}>
                  <span className="dr-num">[{f.num}]</span> {f.name}
                </button>
              )}
            </span>
          ))}
        </nav>
        <button className="btn" onClick={() => setNewFolder(true)}>
          <FolderPlus size={15} />
          New folder
        </button>
      </div>

      <div className="dr-searchbar">
        <label className="dr-search">
          <Search size={15} aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${scope === 'here' && here ? folderLabel(here) : 'My Drive'} by name, keyword or person`}
            aria-label="Search files"
          />
          {q && (
            <button className="icon-btn sm" aria-label="Clear search" onClick={() => setQ('')}>
              <X size={14} />
            </button>
          )}
        </label>
        {folder !== ROOT && (
          <Segmented
            label="Search in"
            value={scope}
            onChange={setScope}
            options={[
              { id: 'here', label: 'This folder' },
              { id: 'all', label: 'All of Drive' },
            ]}
          />
        )}
      </div>

      <div className="filters dr-filters">
        <label className="filter" aria-pressed={!!kind}>
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="File type">
            <option value="">File type</option>
            {KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </label>
        <label className="filter" aria-pressed={!!owner}>
          <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="People">
            <option value="">People</option>
            {owners.map((id) => (
              <option key={id} value={id}>
                {personLabel(id)}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </label>
        <label className="filter" aria-pressed={!!within}>
          <select value={within} onChange={(e) => setWithin(Number(e.target.value))} aria-label="Last modified">
            <option value={0}>Last modified</option>
            {WITHIN.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </label>
        {filtered && (
          <button className="btn btn-ghost btn-sm" onClick={clear}>
            Clear filters
          </button>
        )}
        {(searching || filtered) && (
          <span className="dr-result-count" aria-live="polite">
            {plural(files.length, searching ? 'result' : 'file')}
            {searching && ` in ${scope === 'all' || !here ? 'all of Drive' : folderLabel(here)}`}
          </span>
        )}
      </div>

      {folders.length === 0 && files.length === 0 ? (
        searching || filtered ? (
          <EmptyState icon={Search} title="No files match" body="Try another word, or search all of Drive. Shared files are found by who shared them." />
        ) : (
          <EmptyState
            icon={FolderOpen}
            title="This folder is empty"
            body="File notes, trackers and decks here when this is where you’ll use them."
            action={
              <button className="btn" onClick={() => setNewFolder(true)}>
                <FolderPlus size={15} />
                New folder
              </button>
            }
          />
        )
      ) : (
        <FileTable folders={folders} files={files} showPath={searching} label={here ? `Contents of ${folderLabel(here)}` : 'My Drive'} />
      )}

      {newFolder && <NewFolderDialog parent={folder} onClose={() => setNewFolder(false)} />}
    </>
  );
}

/** Folders first, then files, Drive style. */
export function FileTable({
  folders = [],
  files,
  showPath,
  label,
  extra,
}: {
  folders?: Folder[];
  files: WFile[];
  showPath?: boolean;
  label: string;
  extra?: (f: WFile) => ReactNode;
}) {
  const { state, dispatch } = useStore();
  const go = (id: string) => dispatch({ type: 'navigate', route: { view: 'files', tab: 'browse', folder: id } });
  const activate = (e: React.KeyboardEvent, fn: () => void) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };

  return (
    <div className="table dr-table" role="table" aria-label={label}>
      <div className="table-row table-head" role="row">
        <span role="columnheader" className="sorted">
          Name
          <ArrowUp size={13} aria-label="sorted A to Z" />
        </span>
        <span role="columnheader">Owner</span>
        <span role="columnheader">Modified</span>
        <span role="columnheader" className="dr-sr">
          Actions
        </span>
      </div>
      {folders.map((f) => {
        const n = itemCount(state.ws, f.id);
        return (
          <div key={f.id} role="row" tabIndex={0} className="table-row" onClick={() => go(f.id)} onKeyDown={(e) => activate(e, () => go(f.id))}>
            <span role="cell" className="cell-person">
              <FolderGlyph color={f.color} size={22} />
              <span>
                <strong className="dr-row-name">
                  <span className="dr-num">[{f.num}]</span> {f.name}
                </strong>
                <span className="muted">{n ? plural(n, 'item') : 'Empty'}</span>
              </span>
            </span>
            <span role="cell" className="cell-muted">
              Me
            </span>
            <span role="cell" className="cell-muted" />
            <span role="cell" />
          </div>
        );
      })}
      {files.map((f) => {
        const target = targetOf(state.ws, f);
        const words = descWords(f.description);
        const sub = showPath
          ? shortPath(state.ws, f.folder)
          : f.shortcutOf
            ? `Shortcut to ${shortPath(state.ws, target.folder)}`
            : f.sharedBy && f.folder === SHARED_FOLDER
              ? `Shared by ${personLabel(f.sharedBy)}`
              : f.createdByTimmy
                ? 'Named and filed by Timmy'
                : null;
        return (
          <div
            key={f.id}
            role="row"
            tabIndex={0}
            className="table-row"
            onClick={() => dispatch(openFile(state.ws, f))}
            onKeyDown={(e) => activate(e, () => dispatch(openFile(state.ws, f)))}
          >
            <span role="cell" className="cell-person">
              <span className="dr-file-icon">
                <DocIcon kind={f.kind} size={20} />
                {f.shortcutOf && (
                  <span className="dr-sc-badge" title="Shortcut">
                    <CornerUpRight size={9} strokeWidth={3} aria-label="Shortcut" />
                  </span>
                )}
              </span>
              <span>
                <strong className="dr-row-name">
                  {f.name}
                  {f.starred && <Star size={13} className="star-on" fill="currentColor" aria-label="Starred" />}
                </strong>
                {sub && <span className="muted">{sub}</span>}
                <span className="muted dr-narrow-meta">
                  {personLabel(f.owner)} · {fmtListDate(target.updated)}
                </span>
                {words.length > 0 && (
                  <span className="dr-kws" aria-label="Description keywords">
                    {words.map((w) => (
                      <span key={w} className="dr-kw">
                        {w}
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </span>
            <span role="cell" className="cell-muted dr-owner">
              <Avatar id={f.owner} size={20} />
              <span>{personLabel(f.owner)}</span>
            </span>
            <span role="cell" className="cell-muted">
              {fmtListDate(target.updated)}
            </span>
            <span role="cell" className="dr-row-actions">
              {extra?.(f)}
              <FileActionsMenu fileId={f.id} />
            </span>
          </div>
        );
      })}
    </div>
  );
}
