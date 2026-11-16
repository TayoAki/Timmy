/*
 * Shared building blocks for every workspace screen. Use these instead of
 * one-off markup so dialogs, fields and menus look and behave the same.
 */
import { MoreHorizontal, X, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { portalRoot } from '../lib/portal';
import { useStore } from '../state/store';
import { EMAIL, personName, registerMail } from '../state/ws';
import { Avatar } from './common';

/* ───────────── Modal ───────────── */

/** Open modals, innermost last, so Escape only closes the top one. */
const modalStack: symbol[] = [];

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 520,
  description,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  description?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Keep the latest onClose without re-running the open effect (which moves focus).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const token = Symbol('modal');
    modalStack.push(token);
    const prev = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>('input, textarea, select, [data-autofocus]');
    (first ?? box.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && modalStack[modalStack.length - 1] === token) {
        e.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const i = modalStack.indexOf(token);
      if (i >= 0) modalStack.splice(i, 1);
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="overlay modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} style={{ width: `min(${width}px, 100%)` }} tabIndex={-1}>
        <header className="modal-head">
          <div>
            <h2 id={titleId} className="modal-title">
              {title}
            </h2>
            {description && <p className="modal-desc">{description}</p>}
          </div>
          <button className="icon-btn sm" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    portalRoot(),
  );
}

/* ───────────── Form fields ───────────── */

export function Field({ label, hint, children, inline }: { label: string; hint?: ReactNode; children: ReactNode; inline?: boolean }) {
  return (
    <label className={`field${inline ? ' inline' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** Textarea that grows with its content. */
export function AutoTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number }) {
  const { minRows = 3, className, ...rest } = props;
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [props.value]);
  return <textarea ref={ref} rows={minRows} className={`input textarea ${className ?? ''}`} {...rest} />;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size,
}: {
  options: { id: T; label: string; icon?: LucideIcon }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  size?: 'lg';
}) {
  return (
    <div className={`seg-control${size === 'lg' ? ' seg-control-lg' : ''}`} role="radiogroup" aria-label={label} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} onClick={() => onChange(o.id)}>
          {o.icon && <o.icon size={14} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ───────────── People picker ───────────── */

/** Pick one or more people from your contacts. */
export function PeoplePicker({ value, onChange, placeholder = 'Add a person', single }: { value: string[]; onChange: (ids: string[]) => void; placeholder?: string; single?: boolean }) {
  const { state } = useStore();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const contacts = Object.values(state.ws.contacts).filter((c) => !c.bot);
  const term = q.trim().toLowerCase();
  // Names that start with what you typed come first, so "Lena" never picks Elena.
  const rank = (c: (typeof contacts)[number]) => {
    const n = c.name.toLowerCase();
    return n === term || c.email.toLowerCase() === term ? 0 : n.startsWith(term) || n.split(' ').some((w) => w.startsWith(term)) ? 1 : c.email.toLowerCase().startsWith(term) ? 2 : 3;
  };
  const matches = contacts
    .filter((c) => !value.includes(c.id))
    .filter((c) => !term || `${c.name} ${c.email} ${c.company ?? ''}`.toLowerCase().includes(term))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 6);
  const isEmail = EMAIL.test(q.trim());
  const known = isEmail ? contacts.find((c) => c.email.toLowerCase() === term) : undefined;
  const add = (id: string) => {
    onChange(single ? [id] : [...value.filter((v) => v !== id), id]);
    setQ('');
    setOpen(false);
  };
  // A full address that isn't in People becomes a recipient as it is.
  const addTyped = () => {
    if (!isEmail) return false;
    add(known ? known.id : registerMail(q.trim()));
    return true;
  };
  const stray = !!term && !isEmail && !matches.some((c) => rank(c) < 3);
  return (
    <div className="people-picker">
      <div className="people-picker-box">
        {value.map((id) => (
          <span key={id} className="recip">
            <Avatar id={id} size={18} />
            {state.ws.contacts[id]?.name ?? personName(id)}
            <button type="button" className="recip-x" aria-label={`Remove ${state.ws.contacts[id]?.name ?? personName(id)}`} onClick={() => onChange(value.filter((v) => v !== id))}>
              <X size={12} />
            </button>
          </span>
        ))}
        {(!single || value.length === 0) && (
          <input
            className="people-picker-input"
            value={q}
            placeholder={value.length ? '' : placeholder}
            onChange={(e) => (setQ(e.target.value), setOpen(true))}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => (addTyped(), setOpen(false)), 120)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',' || e.key === ';' || (e.key === 'Tab' && isEmail)) {
                // Enter takes the top match only when it starts with what you typed, so "Lena" never becomes Elena.
                if (addTyped() || (e.key === 'Enter' && matches[0] && rank(matches[0]) < 3 && (add(matches[0].id), true))) e.preventDefault();
              }
              if (e.key === 'Backspace' && !q && value.length) onChange(value.slice(0, -1));
            }}
            aria-label={placeholder}
          />
        )}
      </div>
      {stray && <p className="people-picker-hint">No one in People matches “{q.trim()}”. Type a full email address to write to someone new.</p>}
      {open && (matches.length > 0 || (isEmail && !known)) && (
        <ul className="people-picker-list" role="listbox">
          {isEmail && !known && (
            <li>
              <button type="button" role="option" aria-selected={false} onMouseDown={(e) => e.preventDefault()} onClick={addTyped}>
                <span className="people-picker-new" aria-hidden>
                  @
                </span>
                <span>
                  <strong>{q.trim()}</strong>
                  <span className="muted">New address · not in People</span>
                </span>
              </button>
            </li>
          )}
          {matches.map((c) => (
            <li key={c.id}>
              <button type="button" role="option" aria-selected={false} onMouseDown={(e) => e.preventDefault()} onClick={() => add(c.id)}>
                <Avatar id={c.id} size={22} />
                <span>
                  <strong>{c.name}</strong>
                  <span className="muted">{[c.title, c.company].filter(Boolean).join(' · ') || c.email}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ───────────── Menu ───────────── */

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}

/** A "more" button that opens a short list of actions. */
export function Menu({ items, label = 'More actions', trigger }: { items: MenuItem[]; label?: string; trigger?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu" ref={wrap}>
      <button
        type="button"
        className={trigger ? 'btn btn-sm' : 'icon-btn sm'}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {trigger ?? <MoreHorizontal size={16} />}
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={`menu-item${it.danger ? ' danger' : ''}`}
              disabled={it.disabled}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.icon && <it.icon size={15} />}
              <span>{it.label}</span>
              {it.hint && <span className="menu-hint">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────── Empty state ───────────── */

export function EmptyState({ icon: Icon, title, body, action }: { icon: LucideIcon; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon neutral">
        <Icon size={20} />
      </span>
      <strong>{title}</strong>
      {body && <span>{body}</span>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

/* ───────────── Sidebar header ───────────── */

/** The block at the top of each section's sidebar. */
export function SideHead({ icon, title, sub, action }: { icon: ReactNode; title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="side-head">
      <div className="switcher">
        {icon}
        <span className="switcher-text">
          <span className="switcher-title">{title}</span>
          {sub && <span className="switcher-sub">{sub}</span>}
        </span>
      </div>
      {action && <div className="side-head-action">{action}</div>}
    </div>
  );
}

/** Temporary placeholder while a screen is being built. */
export function Placeholder({ title }: { title: string }) {
  return (
    <main className="main">
      <div className="main-scroll">
        <div className="main-inner">
          <h1 className="page-title">{title}</h1>
          <p className="page-sub">This screen is being built.</p>
        </div>
      </div>
    </main>
  );
}
