import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fmtTime } from '../lib/format';
import { openApprovals } from '../state/approvals';
import { LAST_RUN, nextRun, whenLabel } from '../state/schedule';
import { inBox, useStore } from '../state/store';
import { openThreads, useUrgency } from '../state/urgency';
import { MODES, PALETTES, Swatch, useTheme, type Mode } from '../state/theme';
import { Kbd } from './common';
import { AssistantLauncher } from '../agent/Assistant';

const MODE_ICON: Record<Mode, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };

export function BottomBar() {
  const { state, dispatch } = useStore();
  const inbox = inBox(state.threads, 'inbox').length;
  const approvals = openApprovals(state).length;
  const next = nextRun(state.schedule);
  const { rank } = useUrgency();
  const urgent = rank(openThreads(state.threads)).filter((x) => x.u.level === 'urgent').length;

  return (
    <footer className="bar">
      <div className="bar-group">
        <span className="bar-item">
          <span className="bar-status" />
          Timmy is up to date
        </span>
        <button className="bar-item bar-link hide-sm" onClick={() => dispatch({ type: 'navigate', route: { view: 'rules', tab: 'schedule' } })} title="Change the morning run in Settings › Schedule">
          Last run {fmtTime(LAST_RUN)} · {next ? `next ${whenLabel(next)}` : 'morning run paused'}
        </button>
      </div>
      <div className="bar-ask">
        <AssistantLauncher />
      </div>
      <div className="bar-group">
        <span className="bar-item hide-sm mono">
          {urgent} urgent · {approvals} to approve · {inbox} unsorted
        </span>
        <span className="bar-item hide-sm">
          <Kbd>⌘K</Kbd> search
        </span>
        <ThemeMenu />
      </div>
    </footer>
  );
}

function ThemeMenu() {
  const { mode, palette, resolved, setMode, setPalette } = useTheme();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const Icon = MODE_ICON[mode];
  const current = resolved === 'light' ? 'Light' : PALETTES.find((p) => p.id === palette)!.name;

  return (
    <div className="theme-menu" ref={wrap}>
      <button
        ref={trigger}
        className="bar-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Appearance: ${current}${mode === 'system' ? ', following system' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon size={13} />
        <span className="hide-sm">{current}</span>
      </button>

      {open && (
        <div className="theme-pop" role="dialog" aria-label="Appearance">
          <div className="seg-control" role="radiogroup" aria-label="Mode">
            {MODES.map((m) => {
              const MIcon = MODE_ICON[m.id];
              return (
                <button key={m.id} role="radio" aria-checked={mode === m.id} onClick={() => setMode(m.id)}>
                  <MIcon size={14} />
                  {m.name}
                </button>
              );
            })}
          </div>

          <p className="theme-pop-label" id="dark-palette-label">
            Dark palette
          </p>
          <div role="radiogroup" aria-labelledby="dark-palette-label" className="theme-options">
            {PALETTES.map((p) => (
              <button key={p.id} role="radio" aria-checked={palette === p.id} className="theme-option" onClick={() => setPalette(p.id)}>
                <Swatch palette={p.id} />
                <span className="theme-option-text">
                  <span className="theme-option-name">{p.name}</span>
                  <span className="theme-option-hint">{p.hint}</span>
                </span>
                {palette === p.id && <Check size={15} className="theme-option-check" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
