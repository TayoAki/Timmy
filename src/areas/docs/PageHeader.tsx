/*
 * A doc's page header, Notion-style: breadcrumbs through the pages above it,
 * who's here, the "Saving… / Saved" badge, a cover, a big emoji icon and the
 * title. A page in the trash gets a red banner with Restore and Delete.
 */
import { ArrowLeft, Check, ChevronRight, ImagePlus, Image as ImageIcon, Move, Smile, Sparkles, Star, Trash2, Undo2, X } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Avatar, TimmyMark } from '../../components/common';
import { DocPath } from '../../components/DocBits';
import { Modal } from '../../components/kit';
import { NOW } from '../../data/mock';
import type { DocBody, DocCover, WFile } from '../../data/ws-types';
import { fmtStamp } from '../../lib/format';
import { useStore, ws } from '../../state/store';
import { MAX_STARRED, patch, pathOf, personName } from '../../state/ws';
import { FileActionsMenu } from '../files/FileActions';
import { BlockText } from './BlockText';
import { COVERS, coverStyle, randomCover } from './covers';
import { EmojiPicker, Popover, anchorOf, type Anchor } from './editor/Popover';
import { shrinkImage } from './editor/nodeviews';
import { usePeers } from './editor/presence';
import { useSaveState } from './editor/status';
import { ancestors, purgeOps, restoreOps } from './pages';
import { openFile, shortPath } from './shared';
import { toggleStarOps, showInFolder } from './FileView';

export function PageHeader({ file, body, shortcut }: { file: WFile; body: DocBody; shortcut?: WFile }) {
  const { state, dispatch } = useStore();
  const W = state.ws;
  const trashed = !!file.trashed;
  const [name, setName] = useState(file.name);
  useEffect(() => setName(file.name), [file.name]);
  const [pick, setPick] = useState<null | { kind: 'icon' | 'cover'; anchor: Anchor }>(null);
  const [reposition, setReposition] = useState<number | null>(null);
  const status = useSaveState(file.id);
  const peers = usePeers(file.id);
  const above = ancestors(W, file);

  const setBody = (change: Partial<DocBody>, toast?: string) =>
    !trashed && dispatch(ws([patch('docs', body.id, change), patch('files', file.id, { updated: NOW })], toast ? { toast, undo: true } : undefined));

  const commit = () => {
    const n = name.replace(/\s+/g, ' ').trim();
    if (!n) return setName(file.name);
    if (n !== file.name) dispatch(ws([patch('files', file.id, { name: n })], { toast: `Renamed to “${n}”`, undo: true }));
  };

  const crumb = (f: WFile) => (
    <button key={f.id} className="pg-crumb" onClick={() => openFile(dispatch, f.id)} title={f.name}>
      <span aria-hidden>{W.docs[f.id]?.icon ?? '📄'}</span>
      <span className="pg-crumb-name">{f.name || 'Untitled'}</span>
    </button>
  );

  return (
    <header className={`pg-head${body.cover ? ' has-cover' : ''}${body.icon ? ' has-icon' : ''}`}>
      {trashed && <TrashBanner file={file} />}

      <div className="pg-top">
        <nav className="crumbs pg-crumbs" aria-label="Breadcrumb">
          <button className="btn btn-xs btn-ghost" onClick={() => dispatch({ type: 'back' })} style={{ marginLeft: -8 }}>
            <ArrowLeft size={14} aria-hidden />
            Back
          </button>
          <button onClick={() => dispatch({ type: 'navigate', route: { view: 'docs', tab: 'recent' } })}>Docs</button>
          {above.map((f) => (
            <span key={f.id} className="pg-crumb-step">
              <ChevronRight size={14} aria-hidden />
              {crumb(f)}
            </span>
          ))}
          <ChevronRight size={14} aria-hidden />
          <span className="crumb-current pg-crumb" aria-current="page">
            <span aria-hidden>{body.icon ?? '📄'}</span>
            <span className="pg-crumb-name">{file.name || 'Untitled'}</span>
          </span>
        </nav>
        <div className="pg-top-right">
          {peers.length > 0 && (
            <div className="pg-people" aria-label="Who’s on this page">
              <span className="pg-person" title="You">
                <Avatar id="me" size={26} />
              </span>
              {peers.map((p) => (
                <span key={p.id} className="pg-person" title={p.name} style={{ '--c': p.color } as CSSProperties}>
                  {p.kind === 'timmy' ? <TimmyMark size={26} /> : <Avatar id="me" size={26} />}
                </span>
              ))}
            </div>
          )}
          {!trashed && (
            <span className={`pg-save ${status}`} role="status" aria-live="polite">
              {status === 'saving' ? <span className="pg-save-dot" aria-hidden /> : <Check size={12} strokeWidth={3} aria-hidden />}
              {status === 'saving' ? 'Saving…' : 'Saved'}
            </span>
          )}
          {!trashed && (
            <>
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
            </>
          )}
        </div>
      </div>

      {body.cover && (
        <div
          className={`pg-cover${reposition !== null ? ' moving' : ''}`}
          style={coverStyle(reposition !== null && body.cover.kind === 'image' ? { ...body.cover, y: reposition } : body.cover)}
          onPointerDown={(e) => {
            if (reposition === null) return;
            e.preventDefault();
            const startY = e.clientY;
            const y0 = reposition;
            const move = (ev: PointerEvent) => setReposition(Math.max(0, Math.min(100, y0 - (ev.clientY - startY) / 2)));
            const up = () => {
              window.removeEventListener('pointermove', move);
              window.removeEventListener('pointerup', up);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
          }}
        >
          {!trashed && (
            <div className="pg-cover-tools">
              {reposition !== null ? (
                <>
                  <span className="pg-cover-hint">Drag the image to reposition</span>
                  <button
                    className="pg-cover-btn"
                    onClick={() => {
                      setBody({ cover: { ...body.cover!, y: Math.round(reposition) } });
                      setReposition(null);
                    }}
                  >
                    Save position
                  </button>
                  <button className="pg-cover-btn" onClick={() => setReposition(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button className="pg-cover-btn" onClick={(e) => setPick({ kind: 'cover', anchor: anchorOf(e.currentTarget.getBoundingClientRect()) })}>
                    <ImageIcon size={13} aria-hidden />
                    Change cover
                  </button>
                  {body.cover.kind === 'image' && (
                    <button className="pg-cover-btn" onClick={() => setReposition(body.cover!.y ?? 50)}>
                      <Move size={13} aria-hidden />
                      Reposition
                    </button>
                  )}
                  <button className="pg-cover-btn" onClick={() => setBody({ cover: undefined }, 'Cover removed')}>
                    <X size={13} aria-hidden />
                    Remove
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      <div className="pg-titlebox">
        {body.icon && (
          <button
            className="pg-icon"
            aria-label="Change the page icon"
            disabled={trashed}
            onClick={(e) => setPick({ kind: 'icon', anchor: anchorOf(e.currentTarget.getBoundingClientRect()) })}
          >
            {body.icon}
          </button>
        )}
        {!trashed && (!body.icon || !body.cover) && (
          <div className="pg-addons">
            {!body.icon && (
              <button className="pg-addon" onClick={(e) => setPick({ kind: 'icon', anchor: anchorOf(e.currentTarget.getBoundingClientRect()) })}>
                <Smile size={15} aria-hidden />
                Add icon
              </button>
            )}
            {!body.cover && (
              <button className="pg-addon" onClick={() => setBody({ cover: randomCover() })}>
                <ImagePlus size={15} aria-hidden />
                Add cover
              </button>
            )}
          </div>
        )}
        <BlockText
          className="doc-title-input pg-title"
          value={name}
          placeholder="Untitled"
          aria-label="Page title"
          spellCheck={false}
          readOnly={trashed}
          onChange={(e) => setName(e.target.value.replace(/\n/g, ''))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
              // Enter in the title goes on to the page, like Notion.
              (document.querySelector('.nb-editor') as HTMLElement | null)?.focus();
            } else if (e.key === 'Escape') {
              setName(file.name);
              e.currentTarget.blur();
            }
          }}
        />
        <div className="doc-meta">
          {!trashed && (
            <button className="doc-path-btn" onClick={() => dispatch(showInFolder(file))} title="Show in folder">
              <DocPath path={pathOf(W, file.folder)} />
            </button>
          )}
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
      </div>

      {pick?.kind === 'icon' && (
        <EmojiPicker
          anchor={pick.anchor}
          onClose={() => setPick(null)}
          onPick={(icon) => {
            setBody({ icon });
            setPick(null);
          }}
          onRemove={body.icon ? () => (setBody({ icon: undefined }), setPick(null)) : undefined}
        />
      )}
      {pick?.kind === 'cover' && (
        <CoverPicker
          anchor={pick.anchor}
          current={body.cover}
          onClose={() => setPick(null)}
          onPick={(cover) => {
            setBody({ cover });
            setPick(null);
          }}
        />
      )}
    </header>
  );
}

function CoverPicker({ anchor, current, onPick, onClose }: { anchor: Anchor; current?: DocCover; onPick: (c: DocCover) => void; onClose: () => void }) {
  const [tab, setTab] = useState<'gallery' | 'upload' | 'link'>('gallery');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <Popover anchor={anchor} onClose={onClose} className="pg-cover-pop" label="Change cover" align="end">
      <div className="pg-cover-tabs" role="tablist">
        {(['gallery', 'upload', 'link'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === 'gallery' ? 'Gallery' : t === 'upload' ? 'Upload' : 'Link'}
          </button>
        ))}
      </div>
      {tab === 'gallery' && (
        <div className="pg-cover-grid">
          {COVERS.map((c) => (
            <button
              key={c.id}
              className="pg-cover-swatch"
              style={{ backgroundImage: c.css }}
              aria-label={c.label}
              aria-pressed={current?.kind === 'gradient' && current.value === c.id}
              title={c.label}
              onClick={() => onPick({ kind: 'gradient', value: c.id })}
            />
          ))}
        </div>
      )}
      {tab === 'upload' && (
        <div className="pg-cover-pane">
          <button className="btn" disabled={busy} onClick={() => input.current?.click()}>
            <ImagePlus size={14} aria-hidden />
            {busy ? 'Adding…' : 'Upload an image'}
          </button>
          <p className="muted">Wide images work best, at least 1500 pixels across. It’s kept in this browser.</p>
          <input
            ref={input}
            type="file"
            accept="image/*"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setBusy(true);
              try {
                onPick({ kind: 'image', value: await shrinkImage(f, 2000), y: 50 });
              } finally {
                setBusy(false);
              }
            }}
          />
        </div>
      )}
      {tab === 'link' && (
        <form
          className="pg-cover-pane"
          onSubmit={(e) => {
            e.preventDefault();
            if (/^https?:\/\//i.test(link.trim())) onPick({ kind: 'image', value: link.trim(), y: 50 });
          }}
        >
          <input className="input" autoFocus placeholder="Paste an image link" value={link} onChange={(e) => setLink(e.target.value)} aria-label="Image link" />
          <button className="btn btn-primary" type="submit" disabled={!/^https?:\/\//i.test(link.trim())}>
            Use this image
          </button>
        </form>
      )}
    </Popover>
  );
}

function TrashBanner({ file }: { file: WFile }) {
  const { state, dispatch } = useStore();
  const [confirm, setConfirm] = useState(false);
  const W = state.ws;
  const inside = Object.values(W.trash).filter((t) => t.trashRoot === file.id).length;
  const root = file.trashRoot ? W.trash[file.trashRoot] : undefined;
  return (
    <div className="pg-trash" role="alert">
      <span className="pg-trash-text">
        <Trash2 size={15} aria-hidden />
        {root ? `This page went to the trash with “${root.name}”.` : 'This page is in the trash.'}
        <span className="pg-trash-when">Moved there by you, {fmtStamp(file.trashed ?? NOW)}</span>
      </span>
      <span className="pg-trash-actions">
        <button className="pg-trash-btn" onClick={() => dispatch(ws(restoreOps(W, root ? root.id : file.id), { toast: `Restored “${root?.name ?? file.name}”`, log: `Restored the page “${root?.name ?? file.name}”` }))}>
          <Undo2 size={14} aria-hidden />
          Restore{root ? ' both' : ''}
        </button>
        {!root && (
          <button className="pg-trash-btn" onClick={() => setConfirm(true)}>
            <Trash2 size={14} aria-hidden />
            Delete forever
          </button>
        )}
      </span>
      {confirm && (
        <Modal
          open
          onClose={() => setConfirm(false)}
          title="Delete this page for good?"
          description={`“${file.name}”${inside ? ` and the ${inside} page${inside === 1 ? '' : 's'} inside it` : ''} will be deleted. This can’t be undone.`}
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(false)}>
                Keep it
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  dispatch(ws(purgeOps(W, file.id), { toast: `Deleted “${file.name}” for good`, log: `Deleted the page “${file.name}” for good` }));
                  dispatch({ type: 'navigate', route: { view: 'docs', tab: 'recent' } });
                }}
              >
                Delete forever
              </button>
            </>
          }
        >
          <span />
        </Modal>
      )}
    </div>
  );
}
