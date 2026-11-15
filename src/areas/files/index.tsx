import { Archive, ChevronRight, FolderPlus, FolderSymlink, HardDrive, Inbox, Layers, ListOrdered, MapPin, Star } from 'lucide-react';
import { useState } from 'react';
import { Folder as FolderGlyph, tint } from '../../components/common';
import { DocPath } from '../../components/DocBits';
import { Frame } from '../../components/Frame';
import { SideHead } from '../../components/kit';
import { useStore, type Route } from '../../state/store';
import { MAX_DEPTH, MAX_STARRED, childFolders, depthOf, pathOf } from '../../state/ws';
import { Browse } from './Browse';
import { Shared, Starred, ToFile } from './Decide';
import { NewFolderDialog } from './NewFolderDialog';
import { FILING_FOLDER, GRAINS, KEYWORDS, ROOT, SHARED_FOLDER, ancestors, filesIn, filesUnder, itemCount, projectFor } from './drive';
import { RpSection } from './pickers';

export { FileActionsMenu } from './FileActions';

type Tab = 'browse' | 'filing' | 'shared' | 'starred';
const TABS: Tab[] = ['browse', 'filing', 'shared', 'starred'];

/** The current Drive route, with a folder that still exists. */
const useDriveRoute = () => {
  const { state } = useStore();
  const r = state.route as Extract<Route, { view: 'files' }>;
  const tab: Tab = TABS.includes(r.tab as Tab) ? (r.tab as Tab) : 'browse';
  const folder = r.view === 'files' && r.folder && state.ws.folders[r.folder] ? r.folder : ROOT;
  return { tab, folder, isFiles: r.view === 'files' };
};

const useCounts = () => {
  const { state } = useStore();
  const files = Object.values(state.ws.files);
  return {
    filing: files.filter((f) => f.folder === FILING_FOLDER && f.filing).length,
    shared: files.filter((f) => f.share === 'pending').length,
    starred: files.filter((f) => f.starred).length,
  };
};

export function FilesView() {
  const { dispatch } = useStore();
  const { tab, folder } = useDriveRoute();
  const counts = useCounts();
  return (
    <Frame
      tabs={[
        { id: 'browse', label: 'Browse' },
        { id: 'filing', label: 'To file', count: counts.filing },
        { id: 'shared', label: 'Shared with me', count: counts.shared },
        { id: 'starred', label: `Starred ${counts.starred}/${MAX_STARRED}` },
      ]}
      active={tab}
      onTab={(id) => dispatch({ type: 'navigate', route: { view: 'files', tab: id, folder } })}
      wide
      scrollKey={`${tab}:${folder}`}
    >
      {tab === 'browse' && <Browse key={folder} folder={folder} />}
      {tab === 'filing' && <ToFile />}
      {tab === 'shared' && <Shared />}
      {tab === 'starred' && <Starred />}
    </Frame>
  );
}

/* ───────────── Sidebar ───────────── */

export function FilesSide() {
  const { state, dispatch } = useStore();
  const { tab, folder, isFiles } = useDriveRoute();
  const counts = useCounts();
  const [newFolder, setNewFolder] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const onPath = new Set(isFiles && folder !== ROOT ? ancestors(state.ws, folder).map((f) => f.id) : []);
  const isOpen = (id: string) => open[id] ?? (id === 'f02' || onPath.has(id));
  const go = (route: Route) => dispatch({ type: 'navigate', route });

  const renderLevel = (parent: string | null, depth: number) =>
    childFolders(state.ws, parent).map((f) => {
      const kids = childFolders(state.ws, f.id);
      const expanded = kids.length > 0 && isOpen(f.id);
      const current = isFiles && tab === 'browse' && folder === f.id;
      return (
        <li key={f.id} role="treeitem" aria-expanded={kids.length ? expanded : undefined} aria-selected={current} aria-level={depth}>
          <div className="dr-tree-row" style={{ paddingLeft: (depth - 1) * 14 }}>
            {kids.length > 0 ? (
              <button
                className="dr-tree-toggle"
                aria-label={`${expanded ? 'Collapse' : 'Expand'} [${f.num}] ${f.name}`}
                aria-expanded={expanded}
                onClick={() => setOpen((o) => ({ ...o, [f.id]: !expanded }))}
              >
                <ChevronRight size={14} className={expanded ? 'dr-turned' : undefined} />
              </button>
            ) : (
              <span className="dr-tree-toggle" aria-hidden />
            )}
            <button
              className="nav-item compact dr-tree-item"
              aria-current={current ? 'page' : undefined}
              onClick={() => go({ view: 'files', tab: 'browse', folder: f.id })}
            >
              <FolderGlyph color={f.color} size={17} />
              <span className="nav-name">
                <span className="num">{f.num}</span>
                {f.name}
              </span>
              <span className="nav-count">{itemCount(state.ws, f.id) || ''}</span>
            </button>
          </div>
          {expanded && (
            <ul role="group" className="dr-tree">
              {renderLevel(f.id, depth + 1)}
            </ul>
          )}
        </li>
      );
    });

  const decide = [
    { id: 'filing' as const, name: 'To file', hint: 'Attachments from email', icon: Inbox, color: 'var(--c-amber)', count: counts.filing },
    { id: 'shared' as const, name: 'Shared with me', hint: 'Leave, shortcut or copy', icon: FolderSymlink, color: 'var(--c-sky)', count: counts.shared },
    { id: 'starred' as const, name: 'Starred', hint: 'Five at most', icon: Star, color: 'var(--c-amber)', count: `${counts.starred}/${MAX_STARRED}` },
  ];

  return (
    <>
      <SideHead
        icon={<HardDrive size={18} />}
        title="My Drive"
        sub={`${MAX_DEPTH} levels deep · 99 wide`}
        action={
          <button className="btn btn-primary" onClick={() => setNewFolder(true)}>
            <FolderPlus size={15} />
            New folder
          </button>
        }
      />
      <div className="side-scroll">
        <div className="side-group">
          <div className="side-title">Folders</div>
          <button
            className="nav-item compact dr-tree-root"
            aria-current={isFiles && tab === 'browse' && folder === ROOT ? 'page' : undefined}
            onClick={() => go({ view: 'files', tab: 'browse', folder: ROOT })}
          >
            <HardDrive size={15} className="dr-root-icon" />
            <span className="nav-name">My Drive</span>
          </button>
          <ul className="dr-tree" role="tree" aria-label="Folders">
            {renderLevel(null, 1)}
          </ul>
        </div>
        <div className="side-group">
          <div className="side-title">Decide</div>
          {decide.map((d) => (
            <button
              key={d.id}
              className="nav-item"
              style={tint(d.color)}
              aria-current={isFiles && tab === d.id ? 'page' : undefined}
              onClick={() => go({ view: 'files', tab: d.id, folder })}
            >
              <span className="nav-icon">
                <d.icon size={16} />
              </span>
              <span className="nav-text">
                <span className="nav-name">{d.name}</span>
                <span className="nav-hint">{d.hint}</span>
              </span>
              <span className={`nav-count${d.id !== 'starred' && d.count ? ' strong' : ''}`}>{d.count || ''}</span>
            </button>
          ))}
        </div>
      </div>
      {newFolder && <NewFolderDialog parent={isFiles && tab === 'browse' ? folder : ROOT} onClose={() => setNewFolder(false)} />}
    </>
  );
}

/* ───────────── Context panel ───────────── */

export function FilesContext() {
  const { state, dispatch } = useStore();
  const { tab, folder } = useDriveRoute();
  const depth = folder === ROOT ? 0 : depthOf(state.ws, folder);
  const here = filesIn(state.ws, folder === ROOT ? '' : folder);
  const below = folder === ROOT ? [] : filesUnder(state.ws, folder);
  const project = folder === ROOT ? undefined : projectFor(state.ws, folder);
  const p = project ? state.ws.projects[project] : undefined;
  const subfolders = childFolders(state.ws, folder === ROOT ? null : folder).length;

  return (
    <>
      {tab === 'browse' && (
        <RpSection title="This folder">
          <div className="rp-card">
            <DocPath path={folder === ROOT ? ['My Drive'] : pathOf(state.ws, folder)} />
            <dl className="kv">
              <dt>Level</dt>
              <dd>{folder === ROOT ? 'Top of My Drive' : `${depth} of ${MAX_DEPTH}`}</dd>
              <dt>Folders</dt>
              <dd className="mono">{subfolders}</dd>
              <dt>Files</dt>
              <dd className="mono">
                {folder === ROOT ? Object.values(state.ws.files).filter((f) => f.folder !== SHARED_FOLDER && f.folder !== FILING_FOLDER).length : here.length}
                {below.length > here.length && <span className="muted"> · {below.length} including subfolders</span>}
              </dd>
              <dt>Shortcuts</dt>
              <dd className="mono">{here.filter((f) => f.shortcutOf).length}</dd>
            </dl>
            {depth >= MAX_DEPTH && <p className="rp-note">This folder is {MAX_DEPTH} levels deep: file things here rather than adding another level.</p>}
            {p && (
              <p className="rp-note">
                <span>
                  Part of{' '}
                  <button className="rp-link" onClick={() => dispatch({ type: 'navigate', route: { view: 'project', id: p.id, tab: 'files' } })}>
                    {p.name}
                  </button>
                  . Notes, trackers and decks for it belong here.
                </span>
              </p>
            )}
          </div>
        </RpSection>
      )}

      {tab === 'filing' && (
        <RpSection title="Filing attachments">
          <p className="rp-text">Ask “Where will I use this?” and file it there, in the project folder, not by where it came from. Timmy suggests a folder from the email’s project and a dated name; change either before you file.</p>
        </RpSection>
      )}
      {tab === 'shared' && (
        <RpSection title="Three ways to keep a shared file">
          <ul className="dr-rules">
            <li>
              <MapPin size={14} aria-hidden />
              <span>
                <strong>One-off:</strong> leave it where it is. Search by the person who shared it.
              </span>
            </li>
            <li>
              <FolderSymlink size={14} aria-hidden />
              <span>
                <strong>Live reference:</strong> add a shortcut in the folder where you’ll use it.
              </span>
            </li>
            <li>
              <Layers size={14} aria-hidden />
              <span>
                <strong>Template or a version to change:</strong> make a copy.
              </span>
            </li>
          </ul>
        </RpSection>
      )}
      {tab === 'starred' && (
        <RpSection title="Starred" aside={<span className="rp-aside mono">{Object.values(state.ws.files).filter((f) => f.starred).length}/{MAX_STARRED}</span>}>
          <p className="rp-text">Keep Starred to a handful of files you open daily. For a file whose title you can’t change, add a description keyword instead of starring it.</p>
        </RpSection>
      )}

      <RpSection title="Naming convention">
        <p className="rp-text">Dated files start with the date detail the work needs.</p>
        <ul className="naming">
          {GRAINS.map((g) => (
            <li key={g.id}>
              <code>{g.example}</code>
              <span>
                {g.label}: {g.when.toLowerCase()}
              </span>
            </li>
          ))}
        </ul>
        <p className="rp-text dr-gap">Undated files end with a keyword, so “Acme briefing slides” finds them.</p>
        <div className="chips dr-gap-sm">
          {KEYWORDS.map((k) => (
            <span key={k} className="chip">
              {k}
            </span>
          ))}
        </div>
      </RpSection>

      <RpSection title="Folder rules">
        <ul className="dr-rules">
          <li>
            <MapPin size={14} aria-hidden />
            <span>File where you’ll use it, not where it came from.</span>
          </li>
          <li>
            <Layers size={14} aria-hidden />
            <span>{MAX_DEPTH} levels deep at most.</span>
          </li>
          <li>
            <ListOrdered size={14} aria-hidden />
            <span>Number folders when order matters, 01 to 99. Low numbers for the ones you use most; rarely above 09.</span>
          </li>
          <li>
            <Archive size={14} aria-hidden />
            <span>
              <span className="code">[99]</span> is the archive. Finished work moves there and stays searchable.
            </span>
          </li>
        </ul>
      </RpSection>
    </>
  );
}

