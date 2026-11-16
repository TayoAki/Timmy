import { Bell, CalendarDays, FileText, FolderKanban, HardDrive, House, Library, ListChecks, Megaphone, Plug, Rocket, Search, Settings, Stamp, Users } from 'lucide-react';
import { useOutboundCounts } from '../areas/outbound';
import { scopedApprovals } from '../state/scope';
import type { ReactNode } from 'react';
import { sectionOf, useStore, type Route, type Section } from '../state/store';
import { Avatar, TimmyMark } from './common';

export interface Item {
  section: Section | 'search';
  label: string;
  icon: ReactNode;
  route?: Route;
  badge?: number;
}

/** Every section, with its route and badge: the rail on wide screens, the More sheet on phones. */
export function useSections(): Item[] {
  const { state } = useStore();
  const inbox = state.threads.filter((t) => t.box === 'inbox').length;
  const captured = Object.values(state.ws.notes).filter((n) => !n.processed).length;
  const approvals = scopedApprovals(state).length;
  const out = useOutboundCounts();
  // Calm home: only Approvals keeps a badge.
  const b = (n: number) => (state.calm ? undefined : n || undefined);
  return [
    { section: 'mail', label: 'Today & mail', icon: <House size={20} />, route: { view: 'today', tab: 'brief' } },
    { section: 'approvals', label: 'Approvals', icon: <Stamp size={20} />, route: { view: 'approvals', tab: 'open' }, badge: approvals || undefined },
    { section: 'search', label: 'Search  ⌘K', icon: <Search size={20} /> },
    { section: 'tasks', label: 'Tasks', icon: <ListChecks size={20} />, route: { view: 'tasks', tab: 'board' }, badge: b(captured) },
    { section: 'calendar', label: 'Calendar', icon: <CalendarDays size={20} />, route: { view: 'calendar', tab: 'week' } },
    { section: 'docs', label: 'Docs', icon: <FileText size={20} />, route: { view: 'docs', tab: 'recent' } },
    { section: 'projects', label: 'Projects', icon: <FolderKanban size={20} />, route: { view: 'projects', tab: 'active' } },
    { section: 'people', label: 'People', icon: <Users size={20} />, route: { view: 'people', tab: 'priority' } },
    { section: 'outbound', label: 'Outbound', icon: <Rocket size={20} />, route: { view: 'outbound', tab: 'leads' }, badge: b(out.unread + out.waiting) },
    { section: 'social', label: 'Social (coming soon)', icon: <Megaphone size={20} />, route: { view: 'social', tab: 'overview' } },
    { section: 'files', label: 'Drive', icon: <HardDrive size={20} />, route: { view: 'files', tab: 'browse', folder: 'f02' } },
    { section: 'library', label: 'AI library', icon: <Library size={20} />, route: { view: 'library', tab: 'prompts' } },
    { section: 'activity', label: 'Timmy’s activity', icon: <Bell size={20} />, route: { view: 'activity', tab: 'all' }, badge: b(inbox) },
    { section: 'connections', label: 'Connections', icon: <Plug size={20} />, route: { view: 'connections' } },
  ];
}

export function LeftRail() {
  const { state, dispatch } = useStore();
  const current = state.searchOpen ? 'search' : sectionOf(state.route);
  const items = useSections();

  const go = (item: Item) => {
    if (item.section === 'search') dispatch({ type: 'search', open: true });
    else if (item.route) dispatch({ type: 'navigate', route: item.route });
  };

  return (
    <nav className="rail" aria-label="Sections">
      <div className="rail-logo" title="Timmy">
        <TimmyMark size={32} />
      </div>
      {items.map((item) => (
        <button
          key={item.section}
          className="rail-btn"
          aria-label={item.label}
          aria-current={current === item.section ? 'page' : undefined}
          onClick={() => go(item)}
        >
          {item.icon}
          {item.badge ? <span className="rail-badge">{item.badge}</span> : null}
          <span className="rail-tip">{item.label}</span>
        </button>
      ))}
      <div className="rail-spacer" />
      <button
        className="rail-btn"
        aria-label="Rules & settings"
        aria-current={current === 'rules' ? 'page' : undefined}
        onClick={() => dispatch({ type: 'navigate', route: { view: 'rules', tab: 'triage' } })}
      >
        <Settings size={20} />
        <span className="rail-tip">Rules & settings</span>
      </button>
      <div className="rail-me" title="Signed in as Taylor Morgan">
        <Avatar id="me" size={30} />
      </div>
    </nav>
  );
}
