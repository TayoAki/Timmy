/*
 * A page's version history, on a real workspace. The server keeps the page as it was before each round of
 * changes; this dialog lists those copies, shows the chosen one read-only, and puts it back when asked.
 * Putting one back is the server's doing: it keeps what is replaced as a version too, and the page on
 * screen follows through the same stream that carries every other change.
 */
import { History, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { EmptyState, Modal } from '../../components/kit';
import type { Block, DocCover, WFile } from '../../data/ws-types';
import { fmtStamp, plural } from '../../lib/format';
import { api, type PageVersion } from '../../live/api';
import { useStore } from '../../state/store';
import { coverStyle } from './covers';
import type { EditorActions } from './editor/catalog';
import { NotionEditor, type EditorHandle } from './editor/NotionEditor';
import './versions.css';

type Listing = Awaited<ReturnType<typeof api.pageVersions>>;
type Shown = PageVersion & { blocks: Block[]; icon?: string; cover?: DocCover };

/** Why a copy was kept, and ahead of whose change, in a sentence. */
export const whyKept = (v: Pick<PageVersion, 'why' | 'by'>) =>
  v.why === 'before-restore'
    ? `Kept before ${v.by} restored an older version`
    : v.why === 'before-timmy'
      ? v.by === 'Timmy'
        ? 'Kept before Timmy changed the page'
        : `Kept before Timmy wrote a summary for ${v.by}`
      : `Kept before ${v.by} edited the page`;

const nothing = () => undefined;
const NO_ACTIONS: EditorActions = { pickSheet: nothing, pickFile: nothing, newPage: nothing, timmySummary: nothing };

/** The chosen version's blocks, drawn by the page editor itself with editing switched off, so it looks as the page did. */
function Preview({ id, blocks }: { id: string; blocks: Block[] }) {
  const handle = useRef<EditorHandle>({ editor: null, flush: nothing });
  return <NotionEditor docId={id} blocks={blocks} readOnly onSave={nothing} actions={NO_ACTIONS} onOpenBlock={nothing} handle={handle} toast={nothing} onRemoteBlocks={nothing} />;
}

export function VersionHistory({ file, onClose }: { file: WFile; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [list, setList] = useState<Listing | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let open = true;
    api.pageVersions(file.id).then(
      (out) => {
        if (!open) return;
        setList(out);
        setPicked(out.versions[0]?.number ?? null);
      },
      (e: Error) => open && setProblem(e.message),
    );
    return () => {
      open = false;
    };
  }, [file.id]);

  useEffect(() => {
    if (picked === null) return;
    let open = true;
    setShown(null);
    setSure(false);
    setProblem(null);
    api.pageVersion(file.id, picked).then(
      (v) => open && setShown(v),
      (e: Error) => open && setProblem(e.message),
    );
    return () => {
      open = false;
    };
  }, [file.id, picked]);

  // A link in the preview may have been followed to another page: the history of this one closes.
  const openedOn = useRef(state.route);
  useEffect(() => {
    if (state.route !== openedOn.current) onClose();
  }, [state.route, onClose]);

  const restore = () => {
    if (!shown) return;
    setBusy(true);
    api.restorePageVersion(file.id, shown.number).then(
      (out) => {
        // Links to pages deleted since the version was kept are left out, and the server says so.
        const note = out.note ? ` ${out.note}` : '';
        dispatch({ type: 'toast', text: out.changed ? `Restored the version from ${fmtStamp(shown.at)}.${note} The page as it was is in the version history.` : `The page already matches that version.${note}` });
        onClose();
      },
      (e: Error) => {
        setBusy(false);
        setSure(false);
        setProblem(e.message);
      },
    );
  };

  const versions = list?.versions ?? [];
  const name = file.name || 'Untitled';
  return (
    <Modal
      open
      onClose={onClose}
      title="Version history"
      width={960}
      description={`“${name}” as it was before each round of changes.${list ? ` Timmy keeps up to ${list.keeps.versions} versions of a page, for ${list.keeps.days} days.` : ''}`}
      footer={
        sure ? (
          <>
            <span className="modal-foot-note">Replace what’s on the page with this version? The page as it is now is kept as a version too.</span>
            <button className="btn" disabled={busy} onClick={() => setSure(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={restore}>
              {busy ? 'Restoring…' : 'Restore'}
            </button>
          </>
        ) : (
          <>
            {list && !list.canRestore && versions.length > 0 && <span className="modal-foot-note">You can look at versions here, but not restore them.</span>}
            <button className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
            <button className="btn btn-primary" disabled={!shown || !list?.canRestore} onClick={() => setSure(true)}>
              <RotateCcw size={14} aria-hidden />
              Restore this version
            </button>
          </>
        )
      }
    >
      {!list ? (
        <p className="vh-note" role="status">
          {problem ?? 'Loading versions…'}
        </p>
      ) : versions.length === 0 ? (
        <EmptyState
          icon={History}
          title="No earlier versions yet"
          body={`Timmy keeps the page as it was when it changes: one copy for each stretch of editing (${list.keeps.minutes} minutes or more apart), and one before anything Timmy writes into it.`}
        />
      ) : (
        <div className="vh">
          <div className="vh-list" role="radiogroup" aria-label="Versions, newest first">
            {versions.map((v) => (
              <button key={v.number} type="button" role="radio" aria-checked={picked === v.number} className="vh-row" onClick={() => setPicked(v.number)}>
                <span className="vh-when">{fmtStamp(v.at)}</span>
                <span className="vh-why">{whyKept(v)}</span>
                <span className="vh-words">
                  {v.preview ? `“${v.preview}”` : 'No text'} · {plural(v.blockCount, 'block')}
                </span>
              </button>
            ))}
          </div>
          <div className="vh-preview" aria-label="The page as it was in this version">
            {problem ? (
              <p className="vh-note" role="alert">
                {problem}
              </p>
            ) : !shown ? (
              <p className="vh-note" role="status">
                Loading this version…
              </p>
            ) : (
              <>
                <p className="vh-caption">
                  The page as it was · {fmtStamp(shown.at)} · {plural(shown.blockCount, 'block')}
                </p>
                {shown.cover && <div className="vh-cover" style={coverStyle(shown.cover)} aria-hidden />}
                {shown.icon && (
                  <div className="vh-icon" aria-hidden>
                    {shown.icon}
                  </div>
                )}
                {shown.blocks.length ? <Preview key={shown.number} id={`version:${file.id}:${shown.number}`} blocks={shown.blocks} /> : <p className="vh-note">The page was empty.</p>}
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
