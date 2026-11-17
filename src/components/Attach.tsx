/*
 * Files on an email, for a real workspace: the button that picks files from the person's computer and uploads
 * each one, and the chips that show what an email carries. The demo has no uploads, so the button is not drawn there.
 */
import { Paperclip, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { MailFile } from '../data/types';
import { ATTACHMENT_ENDINGS, MAX_ATTACHMENTS, MAX_ATTACHMENTS_BYTES, fileSize } from '../lib/files';
import { LIVE } from '../live/config';
import { uploadAttachment } from '../live/upload';
import { useStore } from '../state/store';

/** Lets the person add files to the email being written. `onBusy` says when an upload is under way, so Send can wait for it. */
export function AttachButton({ files, onChange, onBusy }: { files: MailFile[]; onChange: (files: MailFile[]) => void; onBusy?: (busy: boolean) => void }) {
  const { dispatch } = useStore();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  // An upload takes a moment, and the person may keep typing meanwhile. When it finishes, the files are added
  // to the email as it is then, not as it was when the file was picked.
  const latest = useRef({ files, onChange });
  latest.current = { files, onChange };
  // If the email was sent or thrown away meanwhile, there is nothing left to add them to.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  if (!LIVE) return null;
  const warn = (text: string) => dispatch({ type: 'toast', text, tone: 'warn' });

  const add = async (picked: File[]) => {
    if (!picked.length) return;
    if (files.length + picked.length > MAX_ATTACHMENTS) return warn(`An email can carry up to ${MAX_ATTACHMENTS} files.`);
    const total = [...files, ...picked].reduce((n, f) => n + f.size, 0);
    if (total > MAX_ATTACHMENTS_BYTES) return warn(`Those files are ${fileSize(total)} together. An email can carry up to ${fileSize(MAX_ATTACHMENTS_BYTES)}.`);
    setBusy(true);
    onBusy?.(true);
    const added: MailFile[] = [];
    try {
      // One at a time, so a file that is refused is named, and the ones before it are kept.
      for (const f of picked) added.push(await uploadAttachment(f));
    } catch (e) {
      warn((e as Error).message);
    } finally {
      if (open.current) {
        if (added.length) latest.current.onChange([...latest.current.files, ...added]);
        setBusy(false);
        onBusy?.(false);
      }
    }
  };

  return (
    <>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => input.current?.click()} disabled={busy} aria-label="Attach a file">
        <Paperclip size={14} />
        {busy ? 'Attaching…' : 'Attach'}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={ATTACHMENT_ENDINGS}
        aria-label="Files to attach"
        onChange={(e) => {
          const picked = [...(e.target.files ?? [])];
          // Cleared so the same file can be picked again after it was removed.
          e.target.value = '';
          void add(picked);
        }}
      />
    </>
  );
}

/** The files an email carries. With `onRemove`, each can be taken off again before sending. */
export function FileChips({ files, onRemove, className = 'chips' }: { files?: { id?: string; name: string; size: number }[]; onRemove?: (index: number) => void; className?: string }) {
  if (!files?.length) return null;
  return (
    <div className={className} aria-label="Attached files">
      {files.map((f, i) => (
        <span key={f.id ?? `${f.name}-${i}`} className="chip" title={f.name}>
          <Paperclip size={12} />
          {f.name}
          <span className="muted">{fileSize(f.size)}</span>
          {onRemove && (
            <button type="button" className="icon-btn sm" aria-label={`Remove ${f.name}`} onClick={() => onRemove(i)}>
              <X size={12} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
