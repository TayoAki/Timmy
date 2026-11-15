/*
 * Upload files from the computer into a Drive folder. The bytes stay in this
 * browser; documents, spreadsheets, decks and PDFs open in the Craft apps.
 */
import { Upload } from 'lucide-react';
import { useRef } from 'react';
import { NOW } from '../../data/mock';
import { putBlob } from '../../lib/blobs';
import { useStore, ws } from '../../state/store';
import { folderLabel, put, uid } from '../../state/ws';
import { ACCEPT, extOf, kindForExt } from './craft';
import '../../styles/viewers.css';

/** Largest file kept in the browser. */
const MAX_BYTES = 200 * 1024 * 1024;

export function UploadButton({ folder, project, className = 'btn', label = 'Upload' }: { folder: string; project?: string; className?: string; label?: string }) {
  const { state, dispatch } = useStore();
  const input = useRef<HTMLInputElement>(null);

  const take = async (list: FileList | null) => {
    if (!list?.length) return;
    const added: { id: string; name: string }[] = [];
    const skipped: string[] = [];
    for (const f of Array.from(list)) {
      const ext = extOf(f.name);
      const kind = kindForExt(ext);
      if (!kind || f.size > MAX_BYTES) {
        skipped.push(f.name);
        continue;
      }
      const id = uid('up');
      const ok = await putBlob(id, f.name, await f.arrayBuffer());
      if (!ok) {
        skipped.push(f.name);
        continue;
      }
      dispatch(
        ws([
          put('files', {
            id,
            name: f.name.replace(/\.[a-z0-9]+$/i, ''),
            kind,
            folder,
            project,
            owner: 'me',
            updated: NOW,
            stored: true,
            format: ext,
          }),
        ]),
      );
      added.push({ id, name: f.name });
    }
    const where = state.ws.folders[folder] ? folderLabel(state.ws.folders[folder]!) : 'Drive';
    if (added.length) {
      dispatch({ type: 'toast', text: added.length === 1 ? `Uploaded “${added[0]!.name}” to ${where}` : `Uploaded ${added.length} files to ${where}` });
      if (added.length === 1) dispatch({ type: 'navigate', route: { view: 'file', id: added[0]!.id } });
    }
    if (skipped.length) {
      dispatch({
        type: 'toast',
        tone: 'warn',
        text: `Couldn’t upload ${skipped.join(', ')}. Timmy opens documents, spreadsheets, presentations, PDFs and images up to 200 MB.`,
      });
    }
    if (input.current) input.current.value = '';
  };

  return (
    <>
      <input ref={input} className="upload-input" type="file" multiple accept={`${ACCEPT},image/*`} tabIndex={-1} aria-hidden onChange={(e) => take(e.target.files)} />
      <button type="button" className={className} onClick={() => input.current?.click()}>
        <Upload size={15} />
        {label}
      </button>
    </>
  );
}
