import {
  Archive,
  BookOpen,
  CalendarDays,
  FolderTree,
  Hourglass,
  Inbox,
  ListFilter,
  PenLine,
  Reply,
  Star,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { ARCHIVED_BASE, BOXES, DOCS, EVENTS, FOLDERS, PEOPLE, PROJECTS, RELATIONSHIPS } from '../data/mock';
import type { Box, RuleGroup } from '../data/types';
import { inBox, sectionOf, useStore } from '../state/store';
import { Avatar, Folder, TimmyMark, tint } from './common';

const BOX_ICONS: Record<Box, LucideIcon> = {
  inbox: Inbox,
  'follow-up': Reply,
  waiting: Hourglass,
  'read-through': BookOpen,
  archived: Archive,
};

export function Sidebar() {
  const { state } = useStore();
  const section = sectionOf(state.route);
  return (
    <aside className="side" aria-label="Sidebar">
      {section === 'people' ? <PeopleSide /> : section === 'files' ? <FilesSide /> : section === 'rules' ? <RulesSide /> : <MailSide />}
    </aside>
  );
}

function MailSide() {
  const { state, dispatch } = useStore();
  const r = state.route;
  const activeBox = r.view === 'box' ? r.box : null;
  const starred = state.threads.filter((t) => t.starred);
  const archived = ARCHIVED_BASE + inBox(state.threads, 'archived').length;
  const owe = inBox(state.threads, 'follow-up').length;

  return (
    <>
      <div className="side-head">
        <div className="switcher">
          <Avatar id="me" size={28} />
          <span className="switcher-text">
            <span className="switcher-title">Work inbox</span>
            <span className="switcher-sub">taylor@northpeak.io</span>
          </span>
        </div>
      </div>

      <div className="side-scroll">
        <div className="side-group">
          <button
            className="nav-item"
            aria-current={r.view === 'today' ? 'page' : undefined}
            onClick={() => dispatch({ type: 'navigate', route: { view: 'today', tab: 'brief' } })}
          >
            <span className="nav-icon" style={tint('var(--accent)')}>
              <Sun size={16} />
            </span>
            <span className="nav-text">
              <span className="nav-name">Today</span>
              <span className="nav-hint">
                {owe} to do · {EVENTS.length} meetings
              </span>
            </span>
          </button>
        </div>

        <div className="side-group">
          <div className="side-title">Mail</div>
          {BOXES.filter((b) => b.id !== 'archived').map((b) => {
            const Icon = BOX_ICONS[b.id as Box];
            const count = inBox(state.threads, b.id).length;
            return (
              <button
                key={b.id}
                className="nav-item"
                style={tint(b.color)}
                aria-current={activeBox === b.id ? 'page' : undefined}
                onClick={() => dispatch({ type: 'navigate', route: { view: 'box', box: b.id, tab: 'all' } })}
              >
                <span className="nav-icon">
                  <Icon size={16} />
                </span>
                <span className="nav-text">
                  <span className="nav-name">
                    <span className="num">{b.num}</span>
                    {b.name}
                  </span>
                  <span className="nav-hint">{b.hint}</span>
                </span>
                <span className={`nav-count${b.id === 'follow-up' || b.id === 'inbox' ? ' strong' : ''}`}>{count || ''}</span>
              </button>
            );
          })}
        </div>

        <div className="side-group">
          <div className="side-title">Projects</div>
          {PROJECTS.map((p) => (
            <button
              key={p.id}
              className="nav-item compact"
              aria-current={activeBox === p.id ? 'page' : undefined}
              onClick={() => dispatch({ type: 'navigate', route: { view: 'box', box: p.id, tab: 'all' } })}
            >
              <Folder color={p.color} size={17} />
              <span className="nav-name">
                <span className="num">{p.num}</span>
                {p.name}
              </span>
              <span className="nav-count">{inBox(state.threads, p.id).length || ''}</span>
            </button>
          ))}
        </div>

        <div className="side-group">
          <div className="side-title">
            Starred
            <span className="mono" title="Keep starred threads to five or fewer">
              {starred.length}/5
            </span>
          </div>
          {starred.map((t) => (
            <button
              key={t.id}
              className="nav-item compact"
              aria-current={r.view === 'thread' && r.id === t.id ? 'page' : undefined}
              onClick={() => dispatch({ type: 'openThread', id: t.id })}
            >
              <Star size={14} className="star-on" fill="currentColor" style={{ justifySelf: 'center' }} />
              <span className="nav-name" style={{ fontWeight: 450 }}>
                {t.subject}
              </span>
            </button>
          ))}
          {starred.length === 0 && <p className="nav-hint" style={{ padding: '4px 8px' }}>Star up to five threads you need daily.</p>}
        </div>
      </div>

      <div className="side-foot">
        <button
          className="nav-item compact"
          aria-current={activeBox === 'archived' ? 'page' : undefined}
          onClick={() => dispatch({ type: 'navigate', route: { view: 'box', box: 'archived', tab: 'all' } })}
        >
          <Folder color="var(--c-brown)" size={17} />
          <span className="nav-name">
            <span className="num">99</span>Archived
          </span>
          <span className="nav-count">{archived.toLocaleString()}</span>
        </button>
      </div>
    </>
  );
}

function PeopleSide() {
  const { state, dispatch } = useStore();
  const current = state.route.view === 'people' ? state.route.person : undefined;
  const groups = [
    { title: 'Priority', items: RELATIONSHIPS.filter((r) => r.priority) },
    { title: 'Staying in touch', items: RELATIONSHIPS.filter((r) => !r.priority) },
  ];
  return (
    <>
      <div className="side-head">
        <div className="switcher">
          <span className="nav-icon" style={tint('var(--c-green)')}>
            <ListFilter size={16} />
          </span>
          <span className="switcher-text">
            <span className="switcher-title">Relationships</span>
            <span className="switcher-sub">{RELATIONSHIPS.length} tracked · reviewed weekly</span>
          </span>
        </div>
      </div>
      <div className="side-scroll">
        {groups.map((g) => (
          <div className="side-group" key={g.title}>
            <div className="side-title">
              {g.title}
              <span className="mono">{g.items.length}</span>
            </div>
            {g.items.map((rel) => {
              const p = PEOPLE[rel.person]!;
              return (
                <button
                  key={rel.person}
                  className="nav-item"
                  aria-current={current === rel.person ? 'page' : undefined}
                  onClick={() => dispatch({ type: 'navigate', route: { view: 'people', tab: state.route.view === 'people' ? state.route.tab : 'priority', person: rel.person } })}
                >
                  <Avatar id={rel.person} size={30} />
                  <span className="nav-text">
                    <span className="nav-name">{p.name}</span>
                    <span className="nav-hint">{rel.next}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}

function FilesSide() {
  const { state, dispatch } = useStore();
  const folder = state.route.view === 'files' ? state.route.folder : '';
  const open = (name: string) =>
    dispatch({ type: 'navigate', route: { view: 'files', tab: state.route.view === 'files' ? state.route.tab : 'linked', folder: name } });
  const countIn = (name: string) => Object.values(DOCS).filter((d) => d.path.includes(name)).length;

  return (
    <>
      <div className="side-head">
        <div className="switcher">
          <span className="nav-icon" style={tint('var(--c-sky)')}>
            <FolderTree size={16} />
          </span>
          <span className="switcher-text">
            <span className="switcher-title">My Drive</span>
            <span className="switcher-sub">5 levels deep · 99 wide</span>
          </span>
        </div>
      </div>
      <div className="side-scroll">
        <div className="side-group">
          <div className="side-title">Folders</div>
          {FOLDERS.map((f) => {
            const name = `[${f.num}] ${f.name}`;
            return (
              <div key={name}>
                <button className="nav-item compact" aria-current={folder === name ? 'page' : undefined} onClick={() => open(name)}>
                  <Folder color={f.color} size={17} />
                  <span className="nav-name">
                    <span className="num">{f.num}</span>
                    {f.name}
                  </span>
                  <span className="nav-count">{countIn(name) || ''}</span>
                </button>
                {f.children && (
                  <div style={{ paddingLeft: 18 }}>
                    {f.children.map((c) => {
                      const child = `[${c.num}] ${c.name}`;
                      return (
                        <button key={child} className="nav-item compact" aria-current={folder === child ? 'page' : undefined} onClick={() => open(child)}>
                          <Folder color={c.color} size={15} />
                          <span className="nav-name">
                            <span className="num">{c.num}</span>
                            {c.name}
                          </span>
                          <span className="nav-count">{countIn(child) || ''}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

const RULE_GROUPS: { id: RuleGroup; name: string; hint: string; icon: LucideIcon; color: string }[] = [
  { id: 'triage', name: 'Triage', hint: 'How mail gets sorted', icon: Inbox, color: 'var(--c-red)' },
  { id: 'writing', name: 'Writing style', hint: 'How drafts sound', icon: PenLine, color: 'var(--c-violet)' },
  { id: 'files', name: 'Files & naming', hint: 'Where attachments go', icon: FolderTree, color: 'var(--c-sky)' },
  { id: 'schedule', name: 'Schedule', hint: 'When Timmy runs', icon: CalendarDays, color: 'var(--c-green)' },
];

function RulesSide() {
  const { state, dispatch } = useStore();
  const tab = state.route.view === 'rules' ? state.route.tab : 'triage';
  return (
    <>
      <div className="side-head">
        <div className="switcher">
          <TimmyMark size={28} />
          <span className="switcher-text">
            <span className="switcher-title">Timmy’s rules</span>
            <span className="switcher-sub">{state.rules.filter((r) => r.enabled).length} active · learns from your edits</span>
          </span>
        </div>
      </div>
      <div className="side-scroll">
        <div className="side-group">
          <div className="side-title">Rules</div>
          {RULE_GROUPS.map((g) => (
            <button
              key={g.id}
              className="nav-item"
              style={tint(g.color)}
              aria-current={tab === g.id ? 'page' : undefined}
              onClick={() => dispatch({ type: 'navigate', route: { view: 'rules', tab: g.id } })}
            >
              <span className="nav-icon">
                <g.icon size={16} />
              </span>
              <span className="nav-text">
                <span className="nav-name">{g.name}</span>
                <span className="nav-hint">{g.hint}</span>
              </span>
              <span className="nav-count">{state.rules.filter((r) => r.group === g.id).length}</span>
            </button>
          ))}
        </div>
        <div className="side-group">
          <div className="side-title">Connected</div>
          {['Gmail', 'Google Calendar', 'Google Drive', 'CRM'].map((name) => (
            <div key={name} className="nav-item compact" style={{ cursor: 'default' }}>
              <span className="dot" style={tint('var(--ok)')} />
              <span className="nav-name" style={{ fontWeight: 450 }}>
                {name}
              </span>
              <span className="nav-count">synced</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

export { RULE_GROUPS };
