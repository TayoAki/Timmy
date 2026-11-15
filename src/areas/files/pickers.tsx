import { CalendarDays, Tag } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Folder as FolderGlyph } from '../../components/common';
import { NOW } from '../../data/mock';
import { useStore } from '../../state/store';
import { MAX_DEPTH } from '../../state/ws';
import { GRAINS, KEYWORDS, ROOT, flatTree, keywordOf, parseName, shortPath, stamp, withGrain, withKeyword, type Grain } from './drive';

/** A labelled group of controls. Not a <label>, so clicks on the caption don't press the first button. */
export function Group({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <div className="field" role="group" aria-labelledby={id}>
      <span className="field-label" id={id}>
        {label}
      </span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

/** Right-panel section, same look as the rest of the context panel. */
export function RpSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rp-section">
      <header className="rp-head">
        <h2 className="rp-title">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

const INDENT = '\u00a0\u00a0\u00a0\u00a0';

/** Native select listing the folder tree, indented by depth. */
export function FolderSelect({
  value,
  onChange,
  label,
  suggested,
  exclude,
  withRoot,
}: {
  value: string;
  onChange: (id: string) => void;
  label: string;
  suggested?: string;
  exclude?: string;
  /** Offer My Drive itself, for new top-level folders. */
  withRoot?: boolean;
}) {
  const { state } = useStore();
  const tree = flatTree(state.ws).filter((n) => !exclude || n.folder.id !== exclude);
  return (
    <select className="input dr-folder-select" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {withRoot && <option value={ROOT}>My Drive</option>}
      {tree.map(({ folder, depth }) => (
        <option key={folder.id} value={folder.id}>
          {INDENT.repeat(depth - (withRoot ? 0 : 1))}[{folder.num}] {folder.name}
          {folder.id === suggested ? ' (suggested)' : ''}
        </option>
      ))}
    </select>
  );
}

/** A clickable folder tree for Move to… and Add a shortcut to… */
export function FolderTreePicker({
  value,
  onChange,
  current,
  disabled,
}: {
  value: string;
  onChange: (id: string) => void;
  /** Where the file is now, marked in the list. */
  current?: string;
  /** Folders you can't pick, with the reason. */
  disabled?: (id: string) => string | null;
}) {
  const { state } = useStore();
  const tree = flatTree(state.ws);
  return (
    <div className="dr-tree-pick" role="radiogroup" aria-label="Folders">
      {tree.map(({ folder, depth }) => {
        const why = disabled?.(folder.id) ?? null;
        return (
          <button
            key={folder.id}
            type="button"
            role="radio"
            aria-checked={value === folder.id}
            disabled={!!why}
            title={why ?? undefined}
            className="dr-tree-opt"
            style={{ paddingLeft: 8 + (depth - 1) * 18 }}
            onClick={() => onChange(folder.id)}
          >
            <FolderGlyph color={folder.color} size={17} />
            <span className="dr-tree-name">
              <span className="dr-num">{folder.num}</span>
              {folder.name}
            </span>
            {folder.id === current && <span className="dr-tree-note">Here now</span>}
            {why && folder.id !== current && <span className="dr-tree-note">{why}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Where a file will land, as one line of text. */
export function Destination({ folder }: { folder: string }) {
  const { state } = useStore();
  return <span className="dr-dest">{shortPath(state.ws, folder)}</span>;
}

/**
 * The naming helper: a name field with date granularity and keyword chips.
 * Dated files start with the date detail the work needs; undated files end
 * with a keyword so "project + type" finds them.
 */
export function NameHelper({ value, onChange, fallbackDate = NOW, label = 'Name' }: { value: string; onChange: (v: string) => void; fallbackDate?: Date; label?: string }) {
  const parsed = parseName(value);
  // The date the prefix stands for: the exact day when known, else the file's
  // own date if it falls in the same period, so switching back to Day is right.
  const [base, setBase] = useState<Date>(() => {
    if (!parsed.date || parsed.grain === 'day') return parsed.date ?? fallbackDate;
    return stamp(parsed.grain, fallbackDate) === stamp(parsed.grain, parsed.date) ? fallbackDate : parsed.date;
  });
  const kw = keywordOf(value);
  const setGrain = (g: Grain) => {
    const nextBase = parsed.date && parsed.grain === 'day' ? parsed.date : base;
    setBase(nextBase);
    onChange(withGrain(value, parsed.grain === g ? 'none' : g, nextBase));
  };
  const inputId = useId();
  return (
    <div className="dr-namer">
      <div className="field">
        <label className="field-label" htmlFor={inputId}>
          {label}
        </label>
        <input id={inputId} className="input" value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      </div>
      <div className="dr-namer-row" role="group" aria-label="Date detail">
        <span className="dr-namer-cap">
          <CalendarDays size={13} aria-hidden />
          Date
        </span>
        {GRAINS.map((g) => (
          <button key={g.id} type="button" className="dr-opt" aria-pressed={parsed.grain === g.id} title={g.when} onClick={() => setGrain(g.id)}>
            {g.label}
          </button>
        ))}
      </div>
      <div className="dr-namer-row" role="group" aria-label="Keyword">
        <span className="dr-namer-cap">
          <Tag size={13} aria-hidden />
          Keyword
        </span>
        {KEYWORDS.map((k) => (
          <button key={k} type="button" className="dr-opt" aria-pressed={kw?.toLowerCase() === k.toLowerCase()} onClick={() => onChange(withKeyword(value, k))}>
            {k}
          </button>
        ))}
      </div>
    </div>
  );
}

export const depthNote = `Folders go ${MAX_DEPTH} levels deep at most.`;
