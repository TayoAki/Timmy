import { FileSpreadsheet, FileText, FileType2, Presentation } from 'lucide-react';
import type { Doc } from '../data/types';

const KIND = {
  slides: { icon: Presentation, color: 'var(--c-amber)', label: 'Slides' },
  sheet: { icon: FileSpreadsheet, color: 'var(--c-green)', label: 'Sheet' },
  doc: { icon: FileText, color: 'var(--c-sky)', label: 'Doc' },
  pdf: { icon: FileType2, color: 'var(--c-red)', label: 'PDF' },
} as const;

export const kindMeta = (k: Doc['kind']) => KIND[k];

export function DocIcon({ kind, size = 16 }: { kind: Doc['kind']; size?: number }) {
  const { icon: Icon, color } = KIND[kind];
  return <Icon size={size} style={{ color, flex: 'none' }} aria-hidden />;
}

/** A tiny stylised preview of a file, so linked files are recognisable at a glance. */
export function DocThumb({ doc }: { doc: Doc }) {
  return (
    <div className={`thumb thumb-${doc.kind}`} aria-hidden>
      {doc.kind === 'slides' && (
        <div className="thumb-slide">
          <div className="thumb-title" />
          <div className="thumb-sub" />
          <div className="thumb-bars">
            <span style={{ height: '38%' }} />
            <span style={{ height: '56%' }} />
            <span style={{ height: '48%' }} />
            <span style={{ height: '74%' }} />
            <span style={{ height: '88%' }} />
          </div>
        </div>
      )}
      {doc.kind === 'sheet' && (
        <div className="thumb-grid">
          {Array.from({ length: 24 }, (_, i) => (
            <span key={i} className={i < 4 ? 'head' : ''} />
          ))}
        </div>
      )}
      {(doc.kind === 'doc' || doc.kind === 'pdf') && (
        <div className="thumb-page">
          <div className="thumb-title" />
          {[92, 100, 84, 96, 60, 100, 88].map((w, i) => (
            <span key={i} style={{ width: `${w}%` }} />
          ))}
          {doc.kind === 'pdf' && <b className="thumb-tag">PDF</b>}
        </div>
      )}
    </div>
  );
}

export function DocPath({ path }: { path: string[] }) {
  return (
    <span className="doc-path">
      {path.map((p, i) => (
        <span key={p}>
          {i > 0 && <span className="sep">›</span>}
          {p}
        </span>
      ))}
    </span>
  );
}
