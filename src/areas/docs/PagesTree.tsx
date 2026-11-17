/*
 * The Docs sidebar's page tree: your docs, with the pages inside them. Hover
 * a row to add a page inside it or move it to the trash; double-click to
 * rename. The trash sits at the bottom.
 */
import { ChevronRight, Plus, Search, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../../components/kit';
import { NOW } from '../../data/mock';
import type { WFile } from '../../data/ws-types';
import { fmtStamp } from '../../lib/format';
import { useStore, ws } from '../../state/store';
import { patch, put, uid } from '../../state/ws';
import { ancestors, childPages, purgeOps, restoreOps, rootPages, trashOps, trashedRoots } from './pages';
import { isLive } from '../../live/clock';
import { openFile } from './shared';
import { bid } from './templates';
import { useTrashDays } from './trashPolicy';

const SHOW = 8;

export function PagesTree({ onNew }: { onNew: () => void }) {
  const { state, dispatch } = useStore();
  const W = state.ws;
  const current = state.route.view === 'file' ? state.route.id : null;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [trash, setTrash] = useState(false);
  // Asked for here so the trash dialog already knows the number when it opens.
  useTrashDays();

  // Open the way down to the page you're on.
  useEffect(() => {
    const f = current ? W.files[current] : undefined;
    if (!f) return;
    const up = ancestors(W, f).map((a) => a.id);
    if (up.some((id) => !open.has(id))) setOpen((s) => new Set([...s, ...up]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const roots = rootPages(W);
  const pinned = current && W.files[current] && roots.findIndex((r) => r.id === current || ancestors(W, W.files[current]!).some((a) => a.id === r.id));
  const shown = all ? roots : roots.slice(0, Math.max(SHOW, typeof pinned === 'number' ? pinned + 1 : 0));
  const trashCount = trashedRoots(W).length;

  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const addInside = (parent: WFile) => {
    const id = uid('doc');
    const body = W.docs[parent.id];
    const child: WFile = { id, name: 'Untitled', kind: 'doc', folder: parent.folder, updated: NOW, owner: 'me', project: parent.project, parent: parent.id };
    dispatch(
      ws(
        [
          put('files', child),
          put('docs', { id, template: 'blank', blocks: [{ id: bid(), type: 'p', text: '' }] }),
          ...(body ? [patch('docs', parent.id, { blocks: [...body.blocks, { id: bid(), type: 'page' as const, file: id }] })] : []),
        ],
        { log: `Created a page inside “${parent.name}”` },
      ),
    );
    setOpen((s) => new Set([...s, parent.id]));
    openFile(dispatch, id);
  };

  const commitRename = () => {
    if (!renaming) return;
    const n = renaming.name.replace(/\s+/g, ' ').trim();
    const f = W.files[renaming.id];
    if (f && n && n !== f.name) dispatch(ws([patch('files', f.id, { name: n })], { toast: `Renamed to “${n}”`, undo: true }));
    setRenaming(null);
  };

  const row = (f: WFile, depth: number) => {
    const kids = childPages(W, f.id);
    const isOpen = open.has(f.id);
    const icon = W.docs[f.id]?.icon ?? '📄';
    return (
      <div key={f.id} role="treeitem" aria-expanded={kids.length ? isOpen : undefined} aria-selected={current === f.id}>
        <div className="pt-row" style={{ paddingLeft: 6 + depth * 14 }} aria-current={current === f.id ? 'page' : undefined}>
          <button className={`pt-chev${kids.length ? '' : ' none'}`} aria-label={isOpen ? `Close ${f.name}` : `Open ${f.name}`} tabIndex={kids.length ? 0 : -1} onClick={() => kids.length && toggle(f.id)}>
            <ChevronRight size={13} aria-hidden />
          </button>
          {renaming?.id === f.id ? (
            <input
              className="pt-rename"
              autoFocus
              value={renaming.name}
              aria-label="Page name"
              onChange={(e) => setRenaming({ id: f.id, name: e.target.value })}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setRenaming(null);
              }}
            />
          ) : (
            <button className="pt-main" onClick={() => openFile(dispatch, f.id)} onDoubleClick={() => setRenaming({ id: f.id, name: f.name })} title={`${f.name}\nDouble-click to rename`}>
              <span className="pt-icon" aria-hidden>
                {icon}
              </span>
              <span className="pt-name">{f.name || 'Untitled'}</span>
            </button>
          )}
          <span className="pt-tools">
            <button className="pt-tool" aria-label={`Add a page inside ${f.name}`} title="Add a page inside" onClick={() => addInside(f)}>
              <Plus size={14} />
            </button>
            <button
              className="pt-tool"
              aria-label={`Move ${f.name} to the trash`}
              title="Move to trash"
              onClick={() => dispatch(ws(trashOps(W, f.id), { toast: `Moved “${f.name}” to the trash`, undo: true, log: `Moved the page “${f.name}” to the trash` }))}
            >
              <Trash2 size={13} />
            </button>
          </span>
        </div>
        {isOpen && kids.length > 0 && <div role="group">{kids.map((k) => row(k, depth + 1))}</div>}
      </div>
    );
  };

  return (
    <div className="side-group pt">
      <div className="side-title pt-head">
        <span>Pages</span>
        <button className="pt-tool" aria-label="New page" title="New page" onClick={onNew}>
          <Plus size={14} />
        </button>
      </div>
      <div role="tree" aria-label="Pages">
        {shown.map((f) => row(f, 0))}
      </div>
      {roots.length > shown.length && (
        <button className="pt-more" onClick={() => setAll(true)}>
          Show all {roots.length}
        </button>
      )}
      <button className="nav-item compact pt-trash" onClick={() => setTrash(true)}>
        <Trash2 size={15} aria-hidden />
        <span className="nav-name">Trash</span>
        <span className="nav-count">{trashCount || ''}</span>
      </button>
      {trash && <TrashDialog onClose={() => setTrash(false)} />}
    </div>
  );
}

export function TrashDialog({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const W = state.ws;
  const [q, setQ] = useState('');
  const [sure, setSure] = useState<string | null>(null);
  // On a real workspace the server empties the trash; the demo keeps pages until you delete them.
  const days = useTrashDays();
  const list = useMemo(() => trashedRoots(W).filter((f) => f.name.toLowerCase().includes(q.trim().toLowerCase())), [W, q]);
  return (
    <Modal open onClose={onClose} title="Trash" description={days ? `Pages stay here for ${days} days, then they are deleted for good. Until then you can restore them.` : 'Pages stay here until you restore them or delete them for good.'} width={540}>
      <label className="pt-search">
        <Search size={14} aria-hidden />
        <input autoFocus placeholder="Search pages in the trash" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the trash" />
      </label>
      {list.length === 0 ? (
        <p className="pt-trash-empty">{q ? `No pages in the trash match “${q}”.` : 'No pages in the trash.'}</p>
      ) : (
        <ul className="pt-trash-list">
          {list.map((f) => {
            const inside = Object.values(W.trash).filter((t) => t.trashRoot === f.id).length;
            const parent = f.parent ? (W.files[f.parent] ?? W.trash[f.parent]) : undefined;
            return (
              <li key={f.id} className="pt-trash-row">
                <button
                  className="pt-trash-open"
                  onClick={() => {
                    onClose();
                    openFile(dispatch, f.id);
                  }}
                >
                  <span className="pt-icon" aria-hidden>
                    {W.docs[f.id]?.icon ?? '📄'}
                  </span>
                  <span className="pt-trash-text">
                    <span className="pt-name">{f.name || 'Untitled'}</span>
                    <span className="pt-trash-sub">
                      {parent ? `In ${parent.name} · ` : ''}
                      {inside ? `${inside} page${inside === 1 ? '' : 's'} inside · ` : ''}
                      Moved {fmtStamp(f.trashed ?? NOW)}
                    </span>
                  </span>
                </button>
                {sure === f.id ? (
                  <span className="pt-trash-confirm">
                    <span>Delete for good?</span>
                    <button className="btn btn-xs btn-danger" onClick={() => (dispatch(ws(purgeOps(W, f.id), { toast: `Deleted “${f.name}” for good`, undo: isLive() })), setSure(null))}>
                      Delete
                    </button>
                    <button className="btn btn-xs" onClick={() => setSure(null)}>
                      Keep
                    </button>
                  </span>
                ) : (
                  <span className="pt-trash-actions">
                    <button className="icon-btn sm" aria-label={`Restore ${f.name}`} title="Restore" onClick={() => dispatch(ws(restoreOps(W, f.id), { toast: `Restored “${f.name}”` }))}>
                      <Undo2 size={15} />
                    </button>
                    <button className="icon-btn sm" aria-label={`Delete ${f.name} for good`} title="Delete for good" onClick={() => setSure(f.id)}>
                      <Trash2 size={15} />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
