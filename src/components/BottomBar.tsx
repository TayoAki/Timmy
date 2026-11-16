import { Check, Flame, Focus, Inbox, Monitor, Moon, Search, Stamp, Sun, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fmtTime } from '../lib/format';
import { scopedApprovals, scopedThreads } from '../state/scope';
import { LAST_RUN, nextRun, whenLabel } from '../state/schedule';
import { inBox, useStore } from '../state/store';
import { openThreads, useUrgency } from '../state/urgency';
import { MODES, PALETTES, Swatch, useTheme, type Mode } from '../state/theme';
import { AssistantLauncher } from '../agent/Assistant';

const MODE_ICON: Record<Mode, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };
const FOCUS_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘.' : 'Ctrl+.';

export function BottomBar() {
  const { state, dispatch } = useStore();
  const inbox = inBox(state.threads, 'inbox').length;
  const approvals = scopedApprovals(state).length;
  const next = nextRun(state.schedule);
  const { rank } = useUrgency();
  const urgent = rank(scopedThreads(state, openThreads(state.threads))).filter((x) => x.u.level === 'urgent').length;
  const project = state.scope ? state.ws.projects[state.scope] : undefined;
  const focus = state.focus;

  return (
    <footer className="bar">
      <div className="bar-group bar-left">
        <span className={`bar-status${focus ? ' focus' : ''}`} aria-hidden />
        {focus ? (
          <span className="bar-status-text">
            <strong>Focus mode{project ? ` · ${project.name}` : ''}</strong>
            <span className="bar-sub">Only what needs you is showing</span>
          </span>
        ) : (
          <span className="bar-status-text">
            <strong>{project ? `Showing ${project.name}` : 'Timmy is up to date'}</strong>
            <button className="bar-link" onClick={() => dispatch({ type: 'navigate', route: { view: 'rules', tab: 'schedule' } })} title="Change the morning run in Settings › Schedule">
              Last run {fmtTime(LAST_RUN)} · {next ? `next ${whenLabel(next)}` : 'morning run paused'}
            </button>
          </span>
        )}
      </div>

      <div className="bar-ask">
        <AssistantLauncher />
      </div>

      <nav className="bar-group bar-right" aria-label="Shortcuts">
        <BarStat icon={Flame} label="Urgent" count={urgent} tone="urgent" onClick={() => dispatch({ type: 'navigate', route: { view: 'today', tab: 'brief' } })} />
        <BarStat icon={Stamp} label="To approve" count={approvals} onClick={() => dispatch({ type: 'navigate', route: { view: 'approvals', tab: 'open' } })} />
        {!focus && <BarStat icon={Inbox} label="Unsorted" count={inbox} onClick={() => dispatch({ type: 'navigate', route: { view: 'today', tab: 'triage' } })} />}
        <span className="bar-sep" aria-hidden />
        <button
          className={`bar-stat bar-focus${focus ? ' on' : ''}`}
          aria-pressed={focus}
          onClick={() => dispatch({ type: 'setFocus' })}
          title={`${focus ? 'Leave focus mode' : 'Focus mode: hide everything that can wait'} (${FOCUS_KEY})`}
        >
          <span className="bar-stat-icon">
            <Focus size={19} />
          </span>
          <span className="bar-stat-label">{focus ? 'Focus on' : 'Focus'}</span>
        </button>
        {!focus && (
          <>
            <button className="bar-stat" onClick={() => dispatch({ type: 'search', open: true })} title="Search (⌘K)">
              <span className="bar-stat-icon">
                <Search size={19} />
              </span>
              <span className="bar-stat-label">Search</span>
            </button>
            <ThemeMenu />
          </>
        )}
      </nav>
    </footer>
  );
}

/** An icon with a count badge and a label under it, like a shop's cart button. */
function BarStat({ icon: Icon, label, count, tone, onClick }: { icon: LucideIcon; label: string; count: number; tone?: 'urgent'; onClick: () => void }) {
  return (
    <button className="bar-stat" onClick={onClick} aria-label={`${label}: ${count}`}>
      <span className="bar-stat-icon">
        <Icon size={19} />
        {count > 0 && <span className={`bar-badge${tone ? ` ${tone}` : ''}`}>{count > 99 ? '99+' : count}</span>}
      </span>
      <span className="bar-stat-label">{label}</span>
    </button>
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
        className="bar-stat"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Appearance: ${current}${mode === 'system' ? ', following system' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="bar-stat-icon">
          <Icon size={19} />
        </span>
        <span className="bar-stat-label">{current}</span>
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
