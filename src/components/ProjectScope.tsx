/*
 * The project picker at the top of the sidebar: narrow Timmy to one project,
 * or show everything. ScopeNote tells a screen's reader what it's limited to.
 */
import { Check, ChevronsUpDown, FolderKanban, Layers } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { scopedThreads } from '../state/scope';
import { openThreads } from '../state/urgency';
import { useStore } from '../state/store';
import { Folder } from './common';

export function ProjectScope() {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const projects = Object.values(state.ws.projects)
    .filter((p) => p.status === 'active')
    .sort((a, b) => a.num.localeCompare(b.num));
  const current = state.scope ? state.ws.projects[state.scope] : undefined;
  const openCount = (id: string) => state.threads.filter((t) => t.project === id && t.box !== 'archived' && t.box !== 'read-through').length;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    wrap.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const pick = (id: string | null) => {
    dispatch({ type: 'setScope', project: id });
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div className="scope" ref={wrap}>
      <button
        ref={trigger}
        className={`scope-btn${current ? ' on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Project: ${current ? current.name : 'All projects'}. Change`}
        onClick={() => setOpen((v) => !v)}
      >
        {current ? <Folder color={current.color} size={20} /> : <Layers size={18} className="scope-all-icon" aria-hidden />}
        <span className="scope-text">
          <span className="scope-label">Project</span>
          <span className="scope-name">{current ? current.name : 'All projects'}</span>
        </span>
        <ChevronsUpDown size={15} className="scope-chev" aria-hidden />
      </button>
      {open && (
        <div className="scope-pop" role="menu" aria-label="Show one project">
          <button role="menuitemradio" aria-checked={!current} className="scope-item" onClick={() => pick(null)}>
            <Layers size={16} aria-hidden />
            <span className="scope-item-text">
              <span>All projects</span>
              <span className="scope-item-sub">Everything in your inbox and workspace</span>
            </span>
            {!current && <Check size={15} className="scope-check" />}
          </button>
          <div className="scope-sep" role="separator" />
          {projects.map((p) => (
            <button key={p.id} role="menuitemradio" aria-checked={current?.id === p.id} className="scope-item" onClick={() => pick(p.id)}>
              <Folder color={p.color} size={17} />
              <span className="scope-item-text">
                <span>
                  <span className="num">{p.num}</span> {p.name}
                </span>
                <span className="scope-item-sub">
                  {p.client ?? 'Internal'} · {openCount(p.id) ? `${openCount(p.id)} open` : 'nothing open'}
                </span>
              </span>
              {current?.id === p.id && <Check size={15} className="scope-check" />}
            </button>
          ))}
          <div className="scope-sep" role="separator" />
          <button role="menuitem" className="scope-item muted-item" onClick={() => (setOpen(false), dispatch({ type: 'navigate', route: { view: 'projects', tab: 'active' } }))}>
            <FolderKanban size={16} aria-hidden />
            <span className="scope-item-text">
              <span>Manage projects</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

/** "Showing Acme Renewal only · Show all projects", on screens the picker narrows. */
export function ScopeNote({ hidden, noun = ['open email', 'open emails'] }: { hidden?: number; noun?: [string, string] }) {
  const { state, dispatch } = useStore();
  const p = state.scope ? state.ws.projects[state.scope] : undefined;
  if (!p) return null;
  const open = openThreads(state.threads);
  const others = hidden ?? open.length - scopedThreads(state, open).length;
  return (
    <p className="scope-note">
      <Folder color={p.color} size={16} />
      <span>
        Showing <strong>{p.name}</strong> only{others > 0 ? `; ${others} other ${others === 1 ? `${noun[0]} is` : `${noun[1]} are`} hidden` : ''}.
      </span>
      <button className="link-btn" onClick={() => dispatch({ type: 'setScope', project: null })}>
        Show all projects
      </button>
    </p>
  );
}
