/*
 * The naming convention for new files: the date at the detail the work needs,
 * then the project or subject, then a keyword.
 *   2026            Pricing tiers — Working sheet
 *   2026-Q4         Acme — Quote tracker
 *   2026-11         Contacts — Backup
 *   2026-11-16      Acme — Meeting notes
 */
import { CalendarDays, Tag } from 'lucide-react';
import { useId } from 'react';
import { NOW } from '../../data/mock';

export type Gran = 'none' | 'year' | 'quarter' | 'month' | 'day';

export const GRANS: { id: Gran; label: string; example?: string; when?: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'year', label: 'Year', example: '2026 Pricing tiers — Working sheet', when: 'Reference you update all year' },
  { id: 'quarter', label: 'Quarter', example: '2026-Q4 Acme — Quote tracker', when: 'Work planned by the quarter' },
  { id: 'month', label: 'Month', example: '2026-11 Contacts — Backup', when: 'Monthly snapshots and reports' },
  { id: 'day', label: 'Day', example: '2026-11-16 Acme — Meeting notes', when: 'One meeting or one day' },
];

export const DOC_KEYWORDS = ['Doc', 'Meeting notes', '1:1 notes', 'Running notes', 'Tracker', 'Project recap', 'Form'];
export const SHEET_KEYWORDS = ['Working sheet', 'Tracker', 'Form'];
export const DECK_KEYWORDS = ['Briefing slides', 'Proposal', 'Slides'];

const pad = (n: number) => String(n).padStart(2, '0');

export const stampFor = (g: Gran, d: Date = NOW) => {
  const y = d.getFullYear();
  switch (g) {
    case 'year':
      return `${y}`;
    case 'quarter':
      return `${y}-Q${Math.floor(d.getMonth() / 3) + 1}`;
    case 'month':
      return `${y}-${pad(d.getMonth() + 1)}`;
    case 'day':
      return `${y}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    default:
      return '';
  }
};

const DATE_HEAD = /^(\d{4})(?:-(Q[1-4])|-(\d{2})(?:-(\d{2}))?)?\s+/;

export interface NameParts {
  gran: Gran;
  subject: string;
  keyword: string;
}

export const composeName = (p: NameParts, d: Date = NOW) => {
  const subject = p.subject.trim();
  if (!subject) return '';
  const stamp = stampFor(p.gran, d);
  return `${stamp ? `${stamp} ` : ''}${subject}${p.keyword ? ` — ${p.keyword}` : ''}`;
};

/** Splits a full name back into its parts, e.g. when another screen suggests a title. */
export const parseName = (name: string, keywords: string[]): NameParts => {
  let rest = name.trim();
  let gran: Gran = 'none';
  const m = rest.match(DATE_HEAD);
  if (m) {
    gran = m[4] ? 'day' : m[3] ? 'month' : m[2] ? 'quarter' : 'year';
    rest = rest.slice(m[0].length);
  }
  let keyword = '';
  for (const k of keywords) {
    const tail = new RegExp(`\\s+[—–-]\\s+${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    if (tail.test(rest)) {
      keyword = k;
      rest = rest.replace(tail, '');
      break;
    }
  }
  return { gran, subject: rest, keyword };
};

/** Name field with date-detail and keyword chips, and a preview of the full name. */
export function NameField({
  value,
  onChange,
  keywords,
  date = NOW,
  placeholder = 'Project or subject, e.g. Acme',
  autoFocus,
}: {
  value: NameParts;
  onChange: (v: NameParts) => void;
  keywords: string[];
  date?: Date;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  const full = composeName(value, date);
  return (
    <div className="doc-namer">
      <div className="field">
        <label className="field-label" htmlFor={id}>
          Name
        </label>
        <input
          id={id}
          className="input"
          value={value.subject}
          placeholder={placeholder}
          autoFocus={autoFocus}
          spellCheck={false}
          onChange={(e) => onChange({ ...value, subject: e.target.value })}
          onBlur={(e) => {
            // A pasted full name is split back into date, subject and keyword.
            const parsed = parseName(e.target.value, keywords);
            if (parsed.gran !== 'none' || parsed.keyword) {
              onChange({
                gran: parsed.gran !== 'none' ? parsed.gran : value.gran,
                subject: parsed.subject,
                keyword: parsed.keyword || value.keyword,
              });
            }
          }}
        />
      </div>
      <div className="doc-namer-row" role="group" aria-label="Date detail">
        <span className="doc-namer-cap">
          <CalendarDays size={13} aria-hidden />
          Date
        </span>
        {GRANS.map((g) => (
          <button key={g.id} type="button" className="doc-opt" aria-pressed={value.gran === g.id} title={g.when} onClick={() => onChange({ ...value, gran: g.id })}>
            {g.label}
          </button>
        ))}
      </div>
      <div className="doc-namer-row" role="group" aria-label="Keyword">
        <span className="doc-namer-cap">
          <Tag size={13} aria-hidden />
          Keyword
        </span>
        {keywords.map((k) => (
          <button
            key={k}
            type="button"
            className="doc-opt"
            aria-pressed={value.keyword === k}
            onClick={() => onChange({ ...value, keyword: value.keyword === k ? '' : k })}
          >
            {k}
          </button>
        ))}
      </div>
      <p className="doc-namer-preview">
        <span>Saves as</span>
        {full ? <code className="code">{full}</code> : <span className="muted">Type a subject to name the file</span>}
      </p>
    </div>
  );
}
