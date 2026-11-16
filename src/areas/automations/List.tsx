/*
 * Library → Automations: every automation as a card (the apps it uses, what it
 * does, steps, an on/off switch), and a bottom sheet to start a new one.
 */
import { Plus, Workflow, X } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { EmptyState } from '../../components/kit';
import { NOW } from '../../data/mock';
import type { Automation } from '../../data/ws-types';
import { fmtStamp } from '../../lib/format';
import { useStore, ws } from '../../state/store';
import { patch, put, uid } from '../../state/ws';
import { KIND } from './catalog';

export const openAutomation = (id: string) => ({ type: 'navigate' as const, route: { view: 'automation' as const, id } });

const appsOf = (a: Automation) => {
  const seen = new Map<string, (typeof KIND)[string]>();
  for (const n of a.nodes) {
    const k = KIND[n.kind];
    if (k && k.role !== 'logic' && !seen.has(k.app)) seen.set(k.app, k);
  }
  return [...seen.values()].slice(0, 4);
};

export function Automations() {
  const { state, dispatch } = useStore();
  const [create, setCreate] = useState(false);
  const list = Object.values(state.ws.automations).sort((x, y) => Number(y.on) - Number(x.on) || y.updated.getTime() - x.updated.getTime());

  const toggle = (a: Automation) => {
    const trig = a.nodes.find((n) => KIND[n.kind]?.role === 'trigger');
    if (!a.on && (!trig || !a.edges.some((e) => e.from === trig.id))) {
      dispatch({ type: 'toast', text: 'Open it and connect a step to the trigger first.', tone: 'warn' });
      return;
    }
    dispatch(ws([patch('automations', a.id, { on: !a.on })], { toast: a.on ? `“${a.name}” is off` : `“${a.name}” is on`, undo: true }));
  };

  return (
    <div className="au">
      <div className="au-head">
        <div>
          <h2 className="au-title">Automations</h2>
          <p className="muted">Draw what happens when an email, a form or a meeting comes in. Timmy asks before anything goes out.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreate(true)}>
          <Plus size={15} aria-hidden />
          New automation
        </button>
      </div>

      {list.length === 0 ? (
        <EmptyState icon={Workflow} title="No automations yet" body="Start one, then drag in a trigger and the steps." />
      ) : (
        <ul className="au-list">
          {list.map((a) => {
            const apps = appsOf(a);
            return (
              <li key={a.id} className={`au-card${a.on ? ' on' : ''}`}>
                <button className="au-open" onClick={() => dispatch(openAutomation(a.id))}>
                  <span className="au-apps" aria-hidden>
                    {apps.map((k) => (
                      <span key={k.app} className="au-app" style={{ '--k': k.color } as CSSProperties} title={k.app}>
                        <k.icon size={15} />
                      </span>
                    ))}
                  </span>
                  <span className="au-text">
                    <span className="au-name">{a.name}</span>
                    <span className="au-desc">{a.description}</span>
                    {a.note && <span className="au-note">{a.note}</span>}
                    <span className="au-meta">
                      {a.nodes.length} step{a.nodes.length === 1 ? '' : 's'} · {apps.map((k) => k.app).join(', ')} · edited {fmtStamp(a.updated)}
                      {a.tests ? ` · tested ${a.tests} time${a.tests === 1 ? '' : 's'}` : ''}
                    </span>
                  </span>
                </button>
                <label className={`ae-switch${a.on ? ' on' : ''}`}>
                  <span>{a.on ? 'On' : 'Off'}</span>
                  <button role="switch" aria-checked={a.on} aria-label={`${a.name} on`} className="ae-switch-track" onClick={() => toggle(a)}>
                    <span className="ae-switch-thumb" />
                  </button>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {create && <CreateSheet onClose={() => setCreate(false)} />}
    </div>
  );
}

/** A bottom sheet: name and description, then straight to the canvas. */
function CreateSheet({ onClose }: { onClose: () => void }) {
  const { dispatch } = useStore();
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [leaving, setLeaving] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const close = () => {
    setLeaving(true);
    window.setTimeout(onClose, 180);
  };
  const create = () => {
    const n = name.trim();
    if (!n) return;
    const id = uid('auto');
    const a: Automation = { id, name: n, description: desc.trim(), on: false, nodes: [], edges: [], updated: NOW };
    dispatch(ws([put('automations', a)], { toast: `Created “${n}”`, log: `Created the automation “${n}”` }));
    onClose();
    dispatch(openAutomation(id));
  };
  return createPortal(
    <div className={`au-sheet-scrim${leaving ? ' leaving' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="au-sheet" role="dialog" aria-modal="true" aria-labelledby="au-sheet-title">
        <span className="au-sheet-grip" aria-hidden />
        <button className="icon-btn sm au-sheet-x" aria-label="Close" onClick={close}>
          <X size={16} />
        </button>
        <h2 id="au-sheet-title">New automation</h2>
        <p className="muted">Name it for what it does. You’ll add the trigger and steps on the canvas.</p>
        <form
          className="au-sheet-form"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <label className="field">
            <span className="field-label">Name</span>
            <input ref={first} className="input" placeholder="Reply to new leads in 5 minutes" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Description</span>
            <input className="input" placeholder="What it does, in a sentence" value={desc} onChange={(e) => setDesc(e.target.value)} />
          </label>
          <div className="au-sheet-actions">
            <button type="button" className="btn btn-ghost" onClick={close}>
              Close
            </button>
            <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
              Create and open the canvas
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
