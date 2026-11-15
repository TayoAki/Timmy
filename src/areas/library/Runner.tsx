/*
 * A started routine: Timmy opens the first link and keeps the rest in a small
 * checklist that stays on screen while you move between sections.
 *
 * The panel has to outlive the AI library screen, so it renders into its own
 * root on document.body and talks to the app through the store's dispatch.
 */
import { Check, ChevronDown, ChevronUp, ListChecks, X } from 'lucide-react';
import { useState, type Dispatch } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Routine, WS } from '../../data/ws-types';
import type { Action } from '../../state/store';
import { routeFromHref } from '../../state/ws';
import { linkInfo } from './lib';

interface Step {
  label: string;
  where: string;
  href: string;
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

export function startRoutine(routine: Routine, ws: WS, dispatch: Dispatch<Action>) {
  if (!routine.links.length) return;
  const steps = routine.links.map((l) => ({ label: l.label, where: linkInfo(ws, l.href).where, href: l.href }));
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  root!.render(<RoutineRunner key={`${routine.id}:${Date.now()}`} name={routine.name} steps={steps} dispatch={dispatch} />);
  dispatch({ type: 'navigate', route: routeFromHref(steps[0]!.href) });
}

export function stopRoutine() {
  root?.render(null);
}

function RoutineRunner({ name, steps, dispatch }: { name: string; steps: Step[]; dispatch: Dispatch<Action> }) {
  const [current, setCurrent] = useState(0);
  const [done, setDone] = useState<Set<number>>(() => new Set());
  const [min, setMin] = useState(false);
  const left = steps.length - done.size;

  const open = (i: number) => {
    setCurrent(i);
    dispatch({ type: 'navigate', route: routeFromHref(steps[i]!.href) });
  };
  const toggle = (i: number) =>
    setDone((d) => {
      const n = new Set(d);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  const next = () => {
    setDone((d) => new Set(d).add(current));
    const after = steps.findIndex((_, i) => i > current && !done.has(i));
    if (after >= 0) open(after);
  };
  const finish = () => {
    stopRoutine();
    dispatch({ type: 'toast', text: `${name} done: ${steps.length} places checked` });
  };
  const following = steps.findIndex((_, i) => i > current && !done.has(i));
  const last = following < 0;

  return (
    <section className={`lib-runner${min ? ' min' : ''}`} role="dialog" aria-label={`Routine: ${name}`}>
      <header className="lib-runner-head">
        <ListChecks size={16} aria-hidden />
        <strong>{name}</strong>
        <span className="lib-runner-count mono">
          {done.size}/{steps.length}
        </span>
        <button className="icon-btn sm" aria-label={min ? 'Expand routine' : 'Minimise routine'} onClick={() => setMin((m) => !m)}>
          {min ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
        <button className="icon-btn sm" aria-label="Close routine" onClick={stopRoutine}>
          <X size={15} />
        </button>
      </header>
      {!min && (
        <>
          <ol className="lib-runner-steps">
            {steps.map((s, i) => (
              <li key={i} className={`lib-runner-step${i === current ? ' current' : ''}${done.has(i) ? ' done' : ''}`}>
                <button className="lib-check" role="checkbox" aria-checked={done.has(i)} aria-label={`Mark ${s.label} done`} onClick={() => toggle(i)}>
                  {done.has(i) && <Check size={12} strokeWidth={3} />}
                </button>
                <button className="lib-runner-link" onClick={() => open(i)} aria-current={i === current ? 'step' : undefined}>
                  <span className="lib-runner-label">{s.label}</span>
                  <span className="lib-runner-where">{s.where}</span>
                </button>
              </li>
            ))}
          </ol>
          <footer className="lib-runner-foot">
            {left === 0 || (last && done.has(current)) ? (
              <button className="btn btn-primary btn-sm" onClick={finish}>
                <Check size={14} />
                Finish routine
              </button>
            ) : last ? (
              <button className="btn btn-primary btn-sm" onClick={() => setDone((d) => new Set(d).add(current))}>
                <Check size={14} />
                Mark this one done
              </button>
            ) : (
              <button className="btn btn-primary btn-sm lib-next" onClick={next}>
                <span>Next: {steps[following]!.label}</span>
              </button>
            )}
          </footer>
        </>
      )}
    </section>
  );
}
