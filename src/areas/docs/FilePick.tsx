/* A searchable list of files to pick from: used for linked tables, file links and "insert into a doc". */
import { Search } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { DocIcon } from '../../components/DocBits';
import { Modal } from '../../components/kit';
import type { WFile } from '../../data/ws-types';
import { fmtListDate } from '../../lib/format';
import { useStore } from '../../state/store';
import { byUpdated, shortPath } from './shared';

export function FilePick({
  open,
  onClose,
  title,
  description,
  filter,
  onPick,
  empty = 'No files match.',
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  filter: (f: WFile) => boolean;
  onPick: (f: WFile) => void;
  empty?: string;
  footer?: ReactNode;
}) {
  const { state } = useStore();
  const [q, setQ] = useState('');
  if (!open) return null;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const files = Object.values(state.ws.files)
    .filter(filter)
    .filter((f) => words.every((w) => `${f.name} ${f.description ?? ''}`.toLowerCase().includes(w)))
    .sort(byUpdated)
    .slice(0, 40);
  return (
    <Modal open onClose={onClose} title={title} description={description} width={560} footer={footer}>
      <label className="doc-pick-search">
        <Search size={15} aria-hidden />
        <input className="input" placeholder="Search by name or keyword" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search files" />
      </label>
      {files.length === 0 ? (
        <p className="muted doc-pick-empty">{empty}</p>
      ) : (
        <ul className="doc-pick-list">
          {files.map((f) => (
            <li key={f.id}>
              <button type="button" className="doc-pick-item" onClick={() => onPick(f)}>
                <DocIcon kind={f.kind} size={17} />
                <span className="doc-pick-text">
                  <span className="doc-pick-name">{f.name}</span>
                  <span className="doc-pick-sub">
                    {shortPath(state.ws, f.folder)} · {fmtListDate(f.updated)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
