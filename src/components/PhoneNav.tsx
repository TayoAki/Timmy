/*
 * On a phone the left rail and the desktop bottom bar give way to one tab
 * bar: Today, Approvals, Ask Timmy in the middle, Calendar, and More (every
 * other section, search, focus and theme in a sheet). Nothing overlaps, and
 * every tap target is at least 44 px.
 */
import { CalendarDays, Focus, House, LayoutGrid, Moon, Search, Settings, Stamp, Sun, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { assistant } from '../agent/conversations';
import { scopedApprovals, scopedThreads } from '../state/scope';
import { sectionOf, useStore } from '../state/store';
import { useTheme } from '../state/theme';
import { openThreads, useUrgency } from '../state/urgency';
import { TimmyMark } from './common';
import { leadAlerts } from '../state/leads';
import { useSections } from './LeftRail';

export function PhoneTabs() {
  const { state, dispatch } = useStore();
  const { rank } = useUrgency();
  const [more, setMore] = useState(false);
  const section = state.searchOpen ? 'search' : sectionOf(state.route);
  const urgent = rank(scopedThreads(state, openThreads(state.threads))).filter((x) => x.u.level === 'urgent').length + (state.scope ? 0 : leadAlerts(state).length);
  const approvals = scopedApprovals(state).length;
  const sections = useSections();
  const elsewhere = sections.filter((x) => !['mail', 'approvals', 'calendar', 'search'].includes(x.section)).reduce((n, x) => n + (x.badge ?? 0), 0);
  const inMore = !['mail', 'approvals', 'calendar'].includes(section);

  return (
    <nav className="bar-phone" aria-label="Sections">
      <button className="ptab" aria-current={section === 'mail' ? 'page' : undefined} onClick={() => dispatch({ type: 'navigate', route: { view: 'today', tab: 'brief' } })}>
        <span className="ptab-icon">
          <House size={21} />
          {urgent > 0 && <span className="bar-badge urgent">{urgent}</span>}
        </span>
        <span className="ptab-label">Today</span>
      </button>
      <button className="ptab" aria-current={section === 'approvals' ? 'page' : undefined} onClick={() => dispatch({ type: 'navigate', route: { view: 'approvals', tab: 'open' } })}>
        <span className="ptab-icon">
          <Stamp size={21} />
          {approvals > 0 && <span className="bar-badge">{approvals}</span>}
        </span>
        <span className="ptab-label">Approve</span>
      </button>
      <button className="ptab ptab-ask" onClick={assistant.open} aria-haspopup="dialog" aria-label="Ask Timmy">
        <span className="ptab-ask-mark">
          <TimmyMark size={30} />
        </span>
        <span className="ptab-label">Ask</span>
      </button>
      <button className="ptab" aria-current={section === 'calendar' ? 'page' : undefined} onClick={() => dispatch({ type: 'navigate', route: { view: 'calendar', tab: 'day' } })}>
        <span className="ptab-icon">
          <CalendarDays size={21} />
        </span>
        <span className="ptab-label">Calendar</span>
      </button>
      <button className="ptab" aria-current={inMore ? 'page' : undefined} aria-haspopup="dialog" aria-expanded={more} onClick={() => setMore(true)}>
        <span className="ptab-icon">
          <LayoutGrid size={21} />
          {elsewhere > 0 && <span className="bar-badge">{elsewhere}</span>}
        </span>
        <span className="ptab-label">More</span>
      </button>
      {more && <MoreSheet onClose={() => setMore(false)} />}
    </nav>
  );
}

function MoreSheet({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const { resolved, setMode } = useTheme();
  const sections = useSections().filter((x) => !['mail', 'approvals', 'calendar', 'search'].includes(x.section));
  const box = useRef<HTMLDivElement>(null);
  const current = sectionOf(state.route);

  useEffect(() => {
    box.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const go = (fn: () => void) => {
    fn();
    onClose();
  };

  return createPortal(
    <div className="sheet-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="More" ref={box}>
        <header className="sheet-head">
          <strong>More</strong>
          <button className="icon-btn sm" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="more-grid">
          {sections.map((x) => (
            <button key={x.section} className="sheet-item" aria-current={current === x.section ? 'page' : undefined} onClick={() => go(() => x.route && dispatch({ type: 'navigate', route: x.route }))}>
              <span className="sheet-icon">
                {x.icon}
                {x.badge ? <span className="bar-badge">{x.badge}</span> : null}
              </span>
              <span>{x.label.replace(' (coming soon)', '')}</span>
            </button>
          ))}
        </div>
        <div className="sheet-row">
          <button className="sheet-chip" onClick={() => go(() => dispatch({ type: 'search', open: true }))}>
            <Search size={17} /> Search
          </button>
          <button className="sheet-chip" aria-pressed={state.focus} onClick={() => go(() => dispatch({ type: 'setFocus' }))}>
            <Focus size={17} /> {state.focus ? 'Focus on' : 'Focus'}
          </button>
          <button className="sheet-chip" onClick={() => setMode(resolved === 'dark' ? 'light' : 'dark')}>
            {resolved === 'dark' ? <Sun size={17} /> : <Moon size={17} />} {resolved === 'dark' ? 'Light' : 'Dark'}
          </button>
          <button className="sheet-chip" onClick={() => go(() => dispatch({ type: 'navigate', route: { view: 'rules', tab: 'triage' } }))}>
            <Settings size={17} /> Settings
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
