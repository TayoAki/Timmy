/**
 * A file from a connected Google Drive (or OneDrive) open in Timmy's own editor, full screen. A Google Doc, Sheet or
 * Slides deck opens as the Word, Excel or PowerPoint file Google exports; a Word, Excel, PowerPoint or PDF file kept
 * in Drive opens as it is (server/src/files/drive-edit.ts).
 *
 * File › Save in the editor saves over the original in Google Drive: the edited file is uploaded to the workspace,
 * then the server checks that Drive's copy hasn't changed since it was opened and saves it there through the Action
 * gateway, where the press of Save is the approval. Drive keeps the earlier version in its version history. If
 * someone changed the file meanwhile, nothing is saved over their change until the person chooses to.
 */
import { ArrowLeft, ExternalLink, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FileKind, WFile } from '../data/ws-types';
import { CraftViewer, type CraftSource } from '../areas/viewers/CraftViewer';
import type { CraftApp } from '../areas/viewers/craft';
import { download } from '../areas/viewers/craft';
import { useStore } from '../state/store';
import { uploadAttachment } from './upload';

const KIND: Record<CraftApp, FileKind> = { wordcraft: 'doc', gridcraft: 'sheet', deckcraft: 'slides', pdfcraft: 'pdf' };

/** Someone changed the file in Drive while it was open here: what the person decides. */
interface Conflict {
  error: string;
  version: string;
  name: string;
  bytes: ArrayBuffer;
  decide: (saved: boolean) => void;
}

export function DriveEditor({ itemId, name, app, appName, link, native, onClose }: { itemId: string; name: string; app: CraftApp; appName: string; link?: string; native?: boolean; onClose: () => void }) {
  const { dispatch } = useStore();
  const version = useRef('');
  const [saves, setSaves] = useState<boolean | null>(null);
  const [reason, setReason] = useState('');
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [busy, setBusy] = useState(false);

  // The editor's idea of the file: only its name and kind matter here, it is never added to Timmy's own Drive.
  const file = useMemo<WFile>(() => ({ id: `drive-${itemId}`, name, kind: KIND[app], folder: '', updated: new Date(), owner: 'me' }), [itemId, name, app]);

  /** Uploads the edited file, then asks for it to be saved over the original at the version opened. */
  const send = async (fileName: string, bytes: ArrayBuffer, at: string): Promise<{ ok: true; version: string | null } | { ok: false; status: number; error: string; version?: string }> => {
    const type = fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : fileName.toLowerCase().endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : fileName.toLowerCase().endsWith('.pptx') ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const up = await uploadAttachment(new File([bytes], fileName, { type }));
    const res = await fetch(`/api/v1/connected-files/${encodeURIComponent(itemId)}/save`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ asset: up.id, version: at }),
    });
    const body = (await res.json().catch(() => ({}))) as { version?: string | null; error?: string };
    if (res.ok) return { ok: true, version: body.version ?? null };
    return { ok: false, status: res.status, error: body.error ?? 'That didn’t save. Try again.', ...(body.version ? { version: body.version } : {}) };
  };

  const source = useMemo<CraftSource>(
    () => ({
      where: `Saves go to this file in ${appName}.`,
      load: async () => {
        const res = await fetch(`/api/v1/connected-files/${encodeURIComponent(itemId)}/office`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${appName} didn’t hand over this file just now.`);
        version.current = res.headers.get('x-timmy-version') ?? '';
        setSaves(res.headers.get('x-timmy-saves') === '1');
        setReason(decodeURIComponent(res.headers.get('x-timmy-reason') ?? ''));
        return { name: decodeURIComponent(res.headers.get('x-timmy-name') ?? name), bytes: new Uint8Array(await res.arrayBuffer()) };
      },
      save: async (fileName, bytes) => {
        if (saves === false || !version.current) {
          dispatch({ type: 'toast', text: reason || `This file can’t be saved back to ${appName}. Use Download to keep a copy.`, tone: 'warn' });
          return false;
        }
        try {
          const r = await send(fileName, bytes, version.current);
          if (r.ok) {
            if (r.version) version.current = r.version;
            dispatch({ type: 'toast', text: `Saved to ${appName}` });
            return true;
          }
          if (r.status === 409 && r.version) {
            // Wait for the person: save over their change, or keep editing and download a copy.
            const theirs = r.version;
            return await new Promise<boolean>((resolve) => setConflict({ error: r.error, version: theirs, name: fileName, bytes, decide: resolve }));
          }
          dispatch({ type: 'toast', text: r.error, tone: 'warn' });
          return false;
        } catch (e) {
          dispatch({ type: 'toast', text: (e as Error).message, tone: 'warn' });
          return false;
        }
      },
    }),
    // `saves` and `reason` are read when a save happens; the source itself must stay the same while the editor is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [itemId, appName, saves, reason],
  );

  const overwrite = async () => {
    if (!conflict) return;
    setBusy(true);
    try {
      const r = await send(conflict.name, conflict.bytes, conflict.version);
      if (r.ok) {
        if (r.version) version.current = r.version;
        dispatch({ type: 'toast', text: `Saved to ${appName} over the other change. Its earlier version is in ${appName}’s version history.` });
        conflict.decide(true);
        setConflict(null);
      } else if (r.status === 409 && r.version) {
        setConflict({ ...conflict, error: r.error, version: r.version });
      } else {
        dispatch({ type: 'toast', text: r.error, tone: 'warn' });
      }
    } catch (e) {
      dispatch({ type: 'toast', text: (e as Error).message, tone: 'warn' });
    } finally {
      setBusy(false);
    }
  };
  const keepMine = () => {
    if (!conflict) return;
    download(conflict.name, new Uint8Array(conflict.bytes));
    conflict.decide(false);
    setConflict(null);
  };

  // Escape closes the editor, unless a decision is waiting.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !conflict) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [conflict, onClose]);

  return createPortal(
    <div className="drive-editor" role="dialog" aria-modal="true" aria-label={`${name} in Timmy’s editor`}>
      <header className="drive-editor-bar">
        <button className="btn btn-sm btn-ghost" onClick={onClose}>
          <ArrowLeft size={14} />
          Close
        </button>
        <strong className="drive-editor-name">{name}</strong>
        <span className="drive-editor-from">{appName}</span>
        {link && (
          <a className="btn btn-sm btn-ghost" href={link} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={14} />
            Open in {appName}
          </a>
        )}
      </header>
      {conflict && (
        <div className="drive-editor-conflict" role="alert">
          <TriangleAlert size={16} aria-hidden />
          <span>{conflict.error} Their change is in {appName}; yours is still here.</span>
          <button className="btn btn-sm" disabled={busy} onClick={keepMine}>
            Download mine instead
          </button>
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void overwrite()}>
            {busy ? 'Saving…' : 'Save mine over theirs'}
          </button>
        </div>
      )}
      <CraftViewer
        file={file}
        app={app}
        source={source}
        note={
          saves === false
            ? reason
            : `Saving replaces this file’s content in ${appName}. ${appName} keeps the earlier version in its version history.${native ? ' Comments, suggestions and smart chips from Google’s own editor may not carry over.' : ''}`
        }
      />
    </div>,
    document.body,
  );
}
