import {
  Archive,
  BookOpen,
  CalendarDays,
  FolderTree,
  Hourglass,
  Inbox,
  Palette,
  PenLine,
  Reply,
  RotateCcw,
  SquarePen,
  Star,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { ARCHIVED_BASE, BOXES } from '../data/mock';
import { todaysEvents } from '../state/ws';
import { CalendarSide } from '../areas/calendar';
import { DocsSide } from '../areas/docs';
import { FilesSide } from '../areas/files';
import { LibrarySide } from '../areas/library';
import { PeopleSide } from '../areas/people';
import { ProjectsSide } from '../areas/projects';
import { TasksSide } from '../areas/tasks';
import type { Box, RuleGroup } from '../data/types';
import { inBox, sectionOf, useStore } from '../state/store';
import { useState } from 'react';
import { Avatar, Folder, Kbd, TimmyMark, tint } from './common';
import { Modal } from './kit';

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
      {section === 'people' ? (
        <PeopleSide />
      ) : section === 'files' ? (
        <FilesSide />
      ) : section === 'rules' ? (
        <RulesSide />
      ) : section === 'tasks' ? (
        <TasksSide />
      ) : section === 'calendar' ? (
        <CalendarSide />
      ) : section === 'docs' ? (
        <DocsSide />
      ) : section === 'projects' ? (
        <ProjectsSide />
      ) : section === 'library' ? (
        <LibrarySide />
      ) : (
        <MailSide />
      )}
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
  const meetings = todaysEvents(state.ws).filter((e) => e.kind === 'meeting').length;
  const projects = Object.values(state.ws.projects).filter((p) => p.status === 'active');

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
        <button className="btn btn-primary compose-btn" onClick={() => dispatch({ type: 'compose', draft: { to: [], subject: '', body: '' } })}>
          <SquarePen size={15} />
          Compose
          <Kbd>C</Kbd>
        </button>
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
                {owe} to do · {meetings} meetings
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
          {projects.map((p) => (
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

const RULE_GROUPS: { id: RuleGroup; name: string; hint: string; icon: LucideIcon; color: string }[] = [
  { id: 'triage', name: 'Triage', hint: 'How mail gets sorted', icon: Inbox, color: 'var(--c-red)' },
  { id: 'writing', name: 'Writing style', hint: 'How drafts sound', icon: PenLine, color: 'var(--c-violet)' },
  { id: 'files', name: 'Files & naming', hint: 'Where attachments go', icon: FolderTree, color: 'var(--c-sky)' },
  { id: 'schedule', name: 'Schedule', hint: 'When Timmy runs', icon: CalendarDays, color: 'var(--c-green)' },
];

function RulesSide() {
  const { state, dispatch } = useStore();
  const tab = state.route.view === 'rules' ? state.route.tab : null;
  const [resetting, setResetting] = useState(false);
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
          <div className="side-title">App</div>
          <button
            className="nav-item"
            style={tint('var(--accent)')}
            aria-current={state.route.view === 'appearance' ? 'page' : undefined}
            onClick={() => dispatch({ type: 'navigate', route: { view: 'appearance' } })}
          >
            <span className="nav-icon">
              <Palette size={16} />
            </span>
            <span className="nav-text">
              <span className="nav-name">Appearance</span>
              <span className="nav-hint">Light, dark and palettes</span>
            </span>
          </button>
          <button className="nav-item" style={tint('var(--c-slate)')} onClick={() => setResetting(true)}>
            <span className="nav-icon">
              <RotateCcw size={16} />
            </span>
            <span className="nav-text">
              <span className="nav-name">Reset demo data</span>
              <span className="nav-hint">Start again from the sample workspace</span>
            </span>
          </button>
          <Modal
            open={resetting}
            onClose={() => setResetting(false)}
            title="Reset demo data?"
            description="Everything you created or changed in this browser (mail, tasks, docs, files, contacts) goes back to the sample workspace. This can't be undone."
            footer={
              <>
                <button className="btn btn-sm btn-ghost" onClick={() => setResetting(false)}>
                  Cancel
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => {
                    setResetting(false);
                    dispatch({ type: 'reset' });
                  }}
                >
                  Reset
                </button>
              </>
            }
          >
            <p className="muted" style={{ fontSize: 13 }}>
              Your theme choice is kept.
            </p>
          </Modal>
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
