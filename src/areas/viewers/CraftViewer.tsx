/*
 * A file open in one of the Craft apps, framed on our own origin. The page is
 * the app's host: it sends the file once the app says it's ready, keeps what
 * the app saves (in this browser, next to the file in Drive), shows unsaved
 * changes, and routes a file the app hands off to the app that edits it.
 */
import { Download, Maximize2, Minimize2, RotateCcw, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NOW } from '../../data/mock';
import type { WFile } from '../../data/ws-types';
import { putBlob } from '../../lib/blobs';
import { FULLSCREEN_KEY, useFullscreen } from '../../lib/fullscreen';
import { Kbd } from '../../components/common';
import { officeExt } from '../../lib/office';
import { useStore, ws } from '../../state/store';
import { folderLabel, patch, put, uid } from '../../state/ws';
import { appForExt, CRAFT, download, extOf, fileBytes, kindForExt, type CraftApp } from './craft';
import '../../styles/viewers.css';

type Status = 'checking' | 'missing' | 'loading' | 'opening' | 'ready' | 'failed' | 'empty';

const AUTHOR = 'Taylor Morgan';
/** How long a first load may take (the app downloads once, then the browser caches it). */
const START_TIMEOUT = 60_000;

const stripExt = (name: string) => name.replace(/\.[a-z0-9]+$/i, '');

export function CraftViewer({ file, app, note }: { file: WFile; app: CraftApp; note?: ReactNode }) {
  const { state, dispatch } = useStore();
  const meta = CRAFT[app];
  const frame = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<Status>('checking');
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const fs = useFullscreen<HTMLElement>();
  const wsRef = useRef(state.ws);
  wsRef.current = state.ws;
  const fileRef = useRef(file);
  fileRef.current = file;
  /** Where a plain Save goes: this file, or the copy a Save As made. */
  const target = useRef<{ id: string; name: string }>({ id: file.id, name: '' });
  const src = `/craft/${app}/index.html?host=parent&author=${encodeURIComponent(AUTHOR)}`;

  // Is the app installed on this server? (A dev server answers unknown paths with the SPA page.)
  useEffect(() => {
    hideCommunityLinks(app);
    let alive = true;
    setStatus('checking');
    fetch(`/craft/${app}/index.html`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((html) => alive && setStatus(html.includes(`name="craft-app" content="${app}"`) ? 'loading' : 'missing'))
      .catch(() => alive && setStatus('missing'));
    return () => {
      alive = false;
    };
  }, [app, attempt]);

  // The frame and its listener live from loading through ready; a retry starts them again.
  const live = status === 'loading' || status === 'opening' || status === 'ready';
  useEffect(() => {
    if (!live) return;
    let alive = true;
    target.current = { id: fileRef.current.id, name: '' };
    setDirty(false);
    const timer = window.setTimeout(() => {
      if (!alive) return;
      setStatus((s) => (s === 'loading' ? 'failed' : s));
      setError(`The ${meta.label.toLowerCase()} didn’t start in time.`);
    }, START_TIMEOUT);
    const post = (msg: object, transfer?: Transferable[]) => frame.current?.contentWindow?.postMessage(msg, window.location.origin, transfer ?? []);

    const keep = async (name: string, bytes: ArrayBuffer, asCopy: boolean) => {
      const f = fileRef.current;
      const ext = extOf(name) || f.format || officeExt(f.kind);
      if (!asCopy) {
        const ok = await putBlob(target.current.id, name, bytes);
        const t = wsRef.current.files[target.current.id];
        dispatch(
          ws([patch('files', target.current.id, { stored: true, format: ext, updated: NOW })], {
            toast: ok ? `Saved “${t?.name ?? f.name}”` : 'Saved for this session only: this browser isn’t keeping files',
            tone: ok ? undefined : 'warn',
            log: `Saved “${t?.name ?? f.name}” in the ${meta.label.toLowerCase()}`,
          }),
        );
        return ok;
      }
      const id = uid('file');
      const ok = await putBlob(id, name, bytes);
      const folder = wsRef.current.folders[f.folder];
      dispatch(
        ws(
          [
            put('files', {
              id,
              name: stripExt(name),
              kind: kindForExt(ext) ?? f.kind,
              folder: f.folder,
              project: f.project,
              owner: 'me',
              updated: NOW,
              stored: true,
              format: ext,
            }),
          ],
          {
            toast: ok ? `Saved “${name}”${folder ? ` in ${folderLabel(folder)}` : ''}` : `Saved “${name}” for this session only: this browser isn’t keeping files`,
            tone: ok ? undefined : 'warn',
            undo: true,
            log: `Saved “${name}” in the ${meta.label.toLowerCase()}`,
          },
        ),
      );
      return id;
    };

    const onMessage = async (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== frame.current?.contentWindow) return;
      const m = e.data as Record<string, unknown> | null;
      if (!m || typeof m.type !== 'string' || !m.type.startsWith(`${app}:`)) return;
      const kind = m.type.slice(app.length + 1);

      if (kind === 'ready') {
        window.clearTimeout(timer);
        post({ type: `${app}:host`, version: '1', handoff: true });
        setStatus('opening');
        const data = await fileBytes(fileRef.current, wsRef.current);
        if (!alive) return;
        if (!data) return setStatus('empty');
        target.current.name = data.name;
        const buf = data.bytes.slice().buffer;
        post({ type: `${app}:open`, name: data.name, bytes: buf }, [buf]);
        setStatus('ready');
      } else if (kind === 'save' && m.bytes instanceof ArrayBuffer) {
        const name = String(m.name ?? target.current.name);
        const sameFile = !m.saveAs && name.toLowerCase() === target.current.name.toLowerCase();
        const result = await keep(name, m.bytes, !sameFile);
        if (m.saveAs && typeof result === 'string' && appForExt(extOf(name)) === app) target.current = { id: result, name };
        if (typeof m.id === 'string') post({ type: `${app}:saved`, id: m.id });
      } else if (kind === 'dirty') {
        setDirty(!!m.dirty);
      } else if (kind === 'failed') {
        if (m.id) dispatch({ type: 'toast', text: `The ${meta.label.toLowerCase()} couldn’t save: ${String(m.error ?? 'unknown error')}`, tone: 'warn' });
        else {
          setError(String(m.error ?? ''));
          setStatus('failed');
        }
      } else if (kind === 'handoff') {
        const name = String(m.name ?? 'file');
        const bytes = m.bytes instanceof ArrayBuffer ? m.bytes : m.file instanceof Blob ? await m.file.arrayBuffer() : undefined;
        const to = appForExt(extOf(name));
        if (!bytes || !to) return;
        const id = await keep(name, bytes, true);
        post({ type: `${app}:handoff-done`, name, app: to });
        if (typeof id === 'string') dispatch({ type: 'navigate', route: { view: 'file', id } });
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    };
  }, [live, app, file.id, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Unsaved changes: ask before the page closes.
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

  // ⌘\ also works while the editor in the frame has the keyboard.
  const unlisten = useRef<() => void>(() => undefined);
  useEffect(() => () => unlisten.current(), []);
  const onFrameLoad = () => {
    unlisten.current();
    unlisten.current = fs.listenIn(frame.current?.contentWindow);
  };

  const save = async () => {
    const data = await fileBytes(fileRef.current, wsRef.current);
    if (data) download(data.name, data.bytes);
  };
  const retry = () => {
    setError('');
    setAttempt((n) => n + 1);
  };

  const showFrame = live;

  return (
    <section ref={fs.ref} className={`craft${fs.full ? ' full' : ''}`} aria-label={`${file.name} in the ${meta.label.toLowerCase()}`}>
      <div className="craft-bar">
        <span className={`craft-app craft-${app}`}>
          <span className="craft-dot" aria-hidden />
          {meta.label}
        </span>
        <span className="craft-state" role="status">
          {status === 'ready' && (dirty ? 'Unsaved changes. Use File › Save to keep them.' : 'Saves go to this file in Drive.')}
          {(status === 'loading' || status === 'opening' || status === 'checking') && `Opening the ${meta.noun}…`}
        </span>
        <div className="craft-actions">
          <button className="btn btn-xs btn-ghost" onClick={save} title="Download the file as it was last saved">
            <Download size={13} />
            Download
          </button>
          {showFrame && (
            <button className="btn btn-xs btn-ghost" onClick={retry} title={`Reload the ${meta.label.toLowerCase()}`}>
              <RotateCcw size={13} />
              Reload
            </button>
          )}
          <button className="btn btn-xs btn-ghost" onClick={fs.toggle} aria-pressed={fs.full} title={`${fs.full ? 'Exit full screen' : 'Full screen'} (${FULLSCREEN_KEY})`}>
            {fs.full ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            {fs.full ? 'Exit full screen' : 'Full screen'}
            <Kbd>{FULLSCREEN_KEY}</Kbd>
          </button>
        </div>
      </div>

      <div className="craft-stage">
        {showFrame && <iframe key={attempt} ref={frame} src={src} title={`${meta.label}: ${file.name}`} allow="clipboard-read; clipboard-write; fullscreen" onLoad={onFrameLoad} />}
        {status !== 'ready' && (
          <div className={`craft-overlay${showFrame ? ' over' : ''}`}>
            {status === 'missing' ? (
              <Problem title={`The ${meta.label.toLowerCase()} isn’t installed on this server`} body="Run npm run craft to build the editors into public/craft, then reload." onRetry={retry} onDownload={save} />
            ) : status === 'failed' ? (
              <Problem
                title={`The ${meta.label.toLowerCase()} couldn’t open the ${meta.noun}`}
                body={error || `It needs a browser with WebGPU or WebGL2. You can still download the file.`}
                onRetry={retry}
                onDownload={save}
              />
            ) : status === 'empty' ? (
              <Problem title="There’s nothing to open yet" body="This file has no content in Drive." onRetry={retry} />
            ) : (
              <div className="craft-loading">
                <span className="craft-spinner" aria-hidden />
                <strong>Opening the {meta.noun}…</strong>
                <span>The first time takes a few seconds while the editor downloads. After that it opens straight away.</span>
              </div>
            )}
          </div>
        )}
      </div>
      {note && <p className="craft-note">{note}</p>}
    </section>
  );
}

/**
 * The editors run on our origin, so their stored preferences are ours to set:
 * WordCraft's title-bar community button is a preference, switched off here.
 * (PdfCraft's is removed at build time: scripts/patches/pdfcraft-hosted.patch.)
 */
function hideCommunityLinks(app: CraftApp) {
  if (app !== 'wordcraft') return;
  try {
    const key = 'wordcraft.ui';
    const prefs = JSON.parse(localStorage.getItem(key) || '{}') as Record<string, unknown>;
    if (prefs.showDiscord !== false) localStorage.setItem(key, JSON.stringify({ ...prefs, showDiscord: false }));
  } catch {
    /* storage unavailable: the button stays */
  }
}

function Problem({ title, body, onRetry, onDownload }: { title: string; body: string; onRetry: () => void; onDownload?: () => void }) {
  return (
    <div className="craft-problem">
      <span className="empty-icon">
        <TriangleAlert size={20} />
      </span>
      <strong>{title}</strong>
      <span>{body}</span>
      <div className="craft-problem-actions">
        <button className="btn btn-sm" onClick={onRetry}>
          <RotateCcw size={14} />
          Try again
        </button>
        {onDownload && (
          <button className="btn btn-sm btn-ghost" onClick={onDownload}>
            <Download size={14} />
            Download
          </button>
        )}
      </div>
    </div>
  );
}
