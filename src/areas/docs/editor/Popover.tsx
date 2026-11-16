/*
 * A floating panel pinned to a point or a rectangle on screen: the slash menu,
 * the block menu, the emoji picker and the colour menu all use it.
 */
import { Search, Shuffle, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { portalRoot, toRoot } from '../../../lib/portal';
import { EMOJI, randomEmoji, searchEmoji } from './emoji';

export interface Anchor {
  left: number;
  top: number;
  bottom: number;
  right?: number;
}

export const anchorOf = (r: DOMRect | { left: number; top: number; bottom: number; right?: number }): Anchor => ({ left: r.left, top: r.top, bottom: r.bottom, right: r.right });

export function Popover({
  anchor,
  onClose,
  children,
  className = '',
  label,
  align = 'start',
  gap = 6,
  keepFocus = false,
}: {
  anchor: Anchor;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  label?: string;
  align?: 'start' | 'end';
  gap?: number;
  /** Clicks inside don't take focus from the editor (menus over a selection). */
  keepFocus?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = align === 'end' && anchor.right != null ? anchor.right - w : anchor.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    const below = anchor.bottom + gap;
    const top = below + h > vh - 8 && anchor.top - gap - h > 8 ? anchor.top - gap - h : Math.max(8, Math.min(below, vh - h - 8));
    const p = toRoot(left, top);
    setPos({ left: p.x, top: p.y });
  }, [anchor.left, anchor.top, anchor.bottom, anchor.right, align, gap]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const t = window.setTimeout(() => document.addEventListener('mousedown', down), 0);
    document.addEventListener('keydown', key, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className={`nb-pop ${className}`}
      role="dialog"
      aria-label={label}
      style={{ left: pos?.left ?? anchor.left, top: pos?.top ?? anchor.bottom + gap, visibility: pos ? 'visible' : 'hidden' }}
      onMouseDown={keepFocus ? (e) => e.target instanceof HTMLInputElement || e.preventDefault() : undefined}
    >
      {children}
    </div>,
    portalRoot(),
  );
}

/** Pick an emoji: search by word, browse by group, or remove. */
export function EmojiPicker({ anchor, onPick, onRemove, onClose }: { anchor: Anchor; onPick: (e: string) => void; onRemove?: () => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const found = searchEmoji(q);
  const cell = ([e, w]: [string, string]) => (
    <button key={e} className="nb-emoji" title={w.split(' ')[0]} aria-label={w.split(' ')[0]} onClick={() => onPick(e)}>
      {e}
    </button>
  );
  return (
    <Popover anchor={anchor} onClose={onClose} className="nb-emoji-pop" label="Choose an icon">
      <div className="nb-emoji-head">
        <label className="nb-emoji-search">
          <Search size={14} aria-hidden />
          <input autoFocus placeholder="Search icons" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search icons" />
        </label>
        <button className="icon-btn sm" title="Random" aria-label="Random icon" onClick={() => onPick(randomEmoji())}>
          <Shuffle size={14} />
        </button>
        {onRemove && (
          <button className="btn btn-xs btn-ghost" onClick={onRemove}>
            <Trash2 size={13} aria-hidden />
            Remove
          </button>
        )}
      </div>
      <div className="nb-emoji-body">
        {found ? (
          found.length ? (
            <div className="nb-emoji-grid">{found.map(cell)}</div>
          ) : (
            <p className="nb-pop-empty">No icons match “{q}”.</p>
          )
        ) : (
          EMOJI.map((g) => (
            <section key={g.name}>
              <h4 className="nb-pop-title">{g.name}</h4>
              <div className="nb-emoji-grid">{g.items.map(cell)}</div>
            </section>
          ))
        )}
      </div>
    </Popover>
  );
}
