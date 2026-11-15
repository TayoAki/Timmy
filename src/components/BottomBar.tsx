import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { inBox, useStore } from '../state/store';
import { MODES, PALETTES, Swatch, useTheme, type Mode } from '../state/theme';
import { Kbd } from './common';

const MODE_ICON: Record<Mode, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };

export function BottomBar() {
  const { state } = useStore();
  const inbox = inBox(state.threads, 'inbox').length;
  const owe = inBox(state.threads, 'follow-up').length;
  const waiting = inBox(state.threads, 'waiting').length;

  return (
    <footer className="bar">
      <div className="bar-group">
        <span className="bar-item">
          <span className="bar-status" />
          Timmy is up to date
        </span>
        <span className="bar-item hide-sm">Last triage 7:02 AM · next tomorrow 7:00 AM</span>
      </div>
      <div className="bar-group">
        <span className="bar-item hide-sm mono">
          {inbox} unsorted · {owe} owe · {waiting} waiting
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
