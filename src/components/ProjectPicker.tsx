/**
 * Puts an email in a project, from the email itself or from its row in Triage: pick a project (or make one), and
 * optionally say that new mail from the same company or person always goes there too, which saves a sorting rule.
 */
import { Check, FolderInput, FolderMinus, Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PEOPLE } from '../data/mock';
import type { Thread } from '../data/types';
import { activeProjects } from '../areas/projects/lib';
import { NewProjectDialog } from '../areas/projects/dialogs';
import { useProfile } from '../live/LiveApp';
import { senderKey } from '../state/mail-rules';
import { useStore } from '../state/store';
import { tint } from './common';

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

/** "anyone at acme.com" or "dana@gmail.com". */
const senderWords = (key: string) => (key.startsWith('@') ? `anyone at ${key.slice(1)}` : key);

export function ProjectPicker({ t, compact, hotkey }: { t: Thread; compact?: boolean; hotkey?: boolean }) {
  const { state, dispatch } = useStore();
  const live = useProfile();
  // A rule changes how Timmy sorts everyone's mail, so only an owner or admin is offered one.
  const mayRule = !live || live.profile.can.policy;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState<string | null>(null);
  // The project just chosen, while "always for this sender?" is on offer.
  const [offer, setOffer] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const current = t.project ? state.ws.projects[t.project] : undefined;
  const projects = activeProjects(state.ws);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? projects.filter((p) => p.name.toLowerCase().includes(q) || p.num.includes(q) || (p.client ?? '').toLowerCase().includes(q)) : projects;
  }, [projects, query]);
  const key = senderKey(t, PEOPLE.me?.email ?? '');

  useEffect(() => {
    if (!open) return;
    setQuery('');
    window.setTimeout(() => input.current?.focus(), 0);
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // P opens the picker on the email that's open.
  useEffect(() => {
    if (!hotkey) return;
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== 'p') return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkey]);

  const choose = (id: string | null) => {
    setOpen(false);
    dispatch({ type: 'setProject', id: t.id, project: id });
    // Offered only when a rule could say it and none already does.
    const covered = !!key && state.rules.some((r) => r.enabled && r.mail?.then.project === id && r.mail.when.from?.includes(key) && !r.mail.when.subject && !r.mail.when.words);
    setOffer(id && key && mayRule && !covered ? id : null);
  };

  const always = () => {
    if (!offer || !key) return;
    dispatch({ type: 'addRule', group: 'triage', text: '', mail: { when: { from: [key] }, then: { project: offer } } });
    setOffer(null);
  };

  const offered = offer ? state.ws.projects[offer] : undefined;
  return (
    <div className={`pp${compact ? ' pp-compact' : ''}`} ref={wrap}>
      {current && !compact ? (
        <button type="button" className="chip plain pp-chip" style={tint(current.color)} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)} title="Change project (P)">
          <span className="dot" />
          {current.name}
        </button>
      ) : (
        <button
          type="button"
          className={compact ? 'btn btn-xs btn-ghost' : 'btn btn-sm btn-ghost pp-add'}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={hotkey ? 'Put in a project (P)' : 'Put in a project'}
        >
          <FolderInput size={14} aria-hidden />
          {compact ? (current ? current.name : 'Project') : 'Add to project'}
        </button>
      )}

      {open && (
        <div className="pp-pop" role="dialog" aria-label="Put this email in a project">
          <label className="pp-search">
            <Search size={14} aria-hidden />
            <input
              ref={input}
              className="input"
              placeholder="Find or make a project"
              aria-label="Find or make a project"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(false);
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (shown[0]) choose(shown[0].id);
                  else if (query.trim()) (setOpen(false), setCreating(query.trim()));
                }
              }}
            />
          </label>
          <ul className="pp-list" role="listbox" aria-label="Projects">
            {shown.map((p) => (
              <li key={p.id}>
                <button type="button" role="option" aria-selected={p.id === t.project} className="pp-item" style={tint(p.color)} onClick={() => choose(p.id)}>
                  <span className="dot" aria-hidden />
                  <span className="pp-num mono">[{p.num}]</span>
                  <span className="pp-name">{p.name}</span>
                  {p.id === t.project && <Check size={14} aria-label="Current project" />}
                </button>
              </li>
            ))}
            {!shown.length && <li className="pp-none">{projects.length ? 'No project by that name.' : 'No projects yet.'}</li>}
          </ul>
          <div className="pp-foot">
            <button type="button" className="pp-item" onClick={() => (setOpen(false), setCreating(query.trim()))}>
              <Plus size={14} aria-hidden />
              <span>{query.trim() ? `New project “${query.trim()}”` : 'New project'}</span>
            </button>
            {current && (
              <button type="button" className="pp-item" onClick={() => choose(null)}>
                <FolderMinus size={14} aria-hidden />
                <span>Take out of {current.name}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {offered && key && (
        <div className="pp-offer" role="group" aria-label="Always for this sender">
          <span>
            Put new mail from <strong>{senderWords(key)}</strong> in {offered.name} too?
          </span>
          <button type="button" className="btn btn-xs btn-primary" onClick={always}>
            Always
          </button>
          <button type="button" className="btn btn-xs btn-ghost" onClick={() => setOffer(null)}>
            Just this one
          </button>
        </div>
      )}

      <NewProjectDialog
        open={creating !== null}
        initialName={creating ?? ''}
        onClose={() => setCreating(null)}
        onCreated={(id) => {
          setCreating(null);
          dispatch({ type: 'setProject', id: t.id, project: id });
          setOffer(key && mayRule ? id : null);
        }}
      />
    </div>
  );
}

/**
 * Timmy's question when it thinks an email may be about a project but isn't sure: “Acme Renewal?” with Yes, which
 * puts it there, and No, which means it isn't asked about that project for this email again.
 */
export function ProjectGuess({ t }: { t: Thread }) {
  const { state, dispatch } = useStore();
  const p = t.maybeProject && !t.project ? state.ws.projects[t.maybeProject] : undefined;
  if (!p || p.status !== 'active') return null;
  return (
    <div className="project-guess" role="group" aria-label={`Is this about ${p.name}?`}>
      <FolderInput size={14} aria-hidden style={{ color: p.color }} />
      <span className="project-guess-q">
        Is this about <strong>{p.name}</strong>?
      </span>
      <button type="button" className="btn btn-xs" onClick={() => dispatch({ type: 'setProject', id: t.id, project: p.id })}>
        Yes
      </button>
      <button type="button" className="btn btn-xs btn-ghost" onClick={() => dispatch({ type: 'dismissProjectGuess', id: t.id })}>
        No
      </button>
    </div>
  );
}
