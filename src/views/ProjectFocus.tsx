/*
 * Focus mode with a project picked: every moving piece of that project on one
 * screen, under its urgent mail and approvals. The deal and goal, tasks due,
 * what others owe you, this week's meetings, the latest decisions, key files
 * and the people involved. Each piece opens where you'd act on it.
 */
import { ArrowRight, BadgeDollarSign, CalendarDays, FileText, Hourglass, ListChecks, Scale, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { NOW } from '../data/mock';
import type { Project } from '../data/ws-types';
import { dayDiff, dueInfo, fmtTime, money } from '../lib/format';
import { eventInScope } from '../state/scope';
import { useStore } from '../state/store';
import { firstName, personName } from '../state/ws';
import { notesTable, openTasks, projectDeal, projectFiles, projectPeople, waitingThreads } from '../areas/projects/lib';
import { Avatar, Folder } from '../components/common';
import { DocIcon } from '../components/DocBits';

function Piece({ icon: Icon, title, count, action, children, empty }: { icon: typeof ListChecks; title: string; count?: number; action?: ReactNode; children: ReactNode; empty?: string }) {
  return (
    <section className="card pf-piece" aria-label={title}>
      <header className="pf-head">
        <Icon size={15} aria-hidden />
        <h3 className="pf-title">{title}</h3>
        {count !== undefined && <span className="pf-count">{count}</span>}
        {action}
      </header>
      {empty ? <p className="pf-empty">{empty}</p> : children}
    </section>
  );
}

function More({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="pf-more" onClick={onClick}>
      {label}
      <ArrowRight size={13} />
    </button>
  );
}

const dueText = (d: Date) => {
  const i = dueInfo(d);
  return <span className={`tone-${i.tone}`}>{i.tone === 'overdue' ? i.label.replace(/Overdue (\d+)d/, '$1 days late') : i.label}</span>;
};

export function ProjectFocus({ p }: { p: Project }) {
  const { state, dispatch } = useStore();
  const go = (tab: 'overview' | 'tasks' | 'notes' | 'mail' | 'files') => dispatch({ type: 'navigate', route: { view: 'project', id: p.id, tab } });

  const deal = projectDeal(state.deals, p);
  const tasks = openTasks(state.ws, p.id);
  const waiting = waitingThreads(state.threads, p.id).sort((a, b) => (a.waiting?.due?.getTime() ?? Infinity) - (b.waiting?.due?.getTime() ?? Infinity));
  const weekEnd = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 7);
  const meetings = Object.values(state.ws.events)
    .filter((e) => e.end > NOW && e.start < weekEnd && e.kind !== 'personal' && eventInScope(state, e))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const decisions = notesTable(state.ws, p)?.rows.slice(0, 3) ?? [];
  const sources = new Set(p.sources);
  const files = projectFiles(state.ws, p);
  const keyFiles = [...files.filter((f) => sources.has(f.id) || f.starred), ...files.filter((f) => !sources.has(f.id) && !f.starred)].slice(0, 5);
  const people = projectPeople(state.threads, p.id).slice(0, 6);

  return (
    <section className="section pf" aria-labelledby="pf-title">
      <div className="pf-hero">
        <Folder color={p.color} size={28} />
        <div className="pf-hero-text">
          <h2 className="section-title" id="pf-title">
            Everything moving on {p.name}
          </h2>
          {p.goal && <p className="pf-goal">{p.goal}</p>}
        </div>
        <button className="btn btn-sm" onClick={() => go('overview')}>
          Open project
          <ArrowRight size={14} />
        </button>
      </div>

      {deal && (
        <div className="pf-deal">
          <BadgeDollarSign size={16} aria-hidden />
          <span>
            <strong>{deal.company}</strong> · {deal.stage} · {money(deal.value)}
          </span>
          <span className="pf-deal-next">
            Next: {deal.next}
            {deal.due && deal.stage !== 'Closed won' ? <> · {dueText(deal.due)}</> : null}
          </span>
          <button className="link-btn" onClick={() => dispatch({ type: 'navigate', route: { view: 'contact', id: deal.contact, tab: 'overview' } })}>
            {firstName(deal.contact)}’s record
          </button>
        </div>
      )}

      <div className="pf-grid">
        <Piece icon={ListChecks} title="Tasks due" count={tasks.length} action={<More label="Board" onClick={() => dispatch({ type: 'navigate', route: { view: 'tasks', tab: 'board', project: p.id } })} />} empty={tasks.length ? undefined : 'No open tasks.'}>
          <ul className="pf-list">
            {tasks.slice(0, 5).map((t) => (
              <li key={t.id}>
                <button className="pf-line" onClick={() => (t.thread ? dispatch({ type: 'openThread', id: t.thread }) : dispatch({ type: 'navigate', route: { view: 'tasks', tab: 'list', project: p.id } }))}>
                  <span className="pf-line-main">{t.title}</span>
                  <span className="pf-line-sub">{t.due ? dueText(t.due) : 'No date'}</span>
                </button>
              </li>
            ))}
          </ul>
        </Piece>

        <Piece icon={Hourglass} title="Waiting on others" count={waiting.length} empty={waiting.length ? undefined : 'Nobody owes you anything here.'}>
          <ul className="pf-list">
            {waiting.map((t) => (
              <li key={t.id}>
                <button className="pf-line" onClick={() => dispatch({ type: 'openThread', id: t.id })}>
                  <Avatar id={t.waiting!.on} size={22} />
                  <span className="pf-line-main">{t.waiting!.item}</span>
                  <span className="pf-line-sub">
                    {firstName(t.waiting!.on)} · {t.waiting!.due ? dueText(t.waiting!.due) : 'no date'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Piece>

        <Piece icon={CalendarDays} title="This week" count={meetings.length} action={<More label="Calendar" onClick={() => dispatch({ type: 'navigate', route: { view: 'calendar', tab: 'week' } })} />} empty={meetings.length ? undefined : 'No meetings for this project this week.'}>
          <ul className="pf-list">
            {meetings.slice(0, 5).map((e) => (
              <li key={e.id}>
                <button className="pf-line" onClick={() => (e.thread ? dispatch({ type: 'openThread', id: e.thread }) : dispatch({ type: 'navigate', route: { view: 'calendar', tab: 'week', date: undefined } }))}>
                  <span className="pf-when">
                    {dayDiff(e.start) === 0 ? 'Today' : dayDiff(e.start) === 1 ? 'Tomorrow' : e.start.toLocaleDateString('en-US', { weekday: 'short' })} {fmtTime(e.start)}
                  </span>
                  <span className="pf-line-main">{e.title}</span>
                  {e.with.length > 0 && <span className="pf-line-sub">{e.with.map(firstName).join(', ')}</span>}
                </button>
              </li>
            ))}
          </ul>
        </Piece>

        <Piece icon={Scale} title="Latest decisions" action={<More label="Running notes" onClick={() => go('notes')} />} empty={decisions.length ? undefined : 'No decisions recorded yet.'}>
          <ul className="pf-list">
            {decisions.map((r, i) => (
              <li key={i} className="pf-decision">
                <span className="pf-when">{r[0]}</span>
                <span className="pf-line-main">{r[1]}</span>
              </li>
            ))}
          </ul>
        </Piece>

        <Piece icon={FileText} title="Key files" count={files.length} action={<More label="All files" onClick={() => go('files')} />} empty={keyFiles.length ? undefined : 'The project folder is empty.'}>
          <ul className="pf-list">
            {keyFiles.map((f) => (
              <li key={f.id}>
                <button className="pf-line" onClick={() => dispatch({ type: 'navigate', route: { view: 'file', id: f.id } })}>
                  <DocIcon kind={f.kind} size={16} />
                  <span className="pf-line-main">{f.name}</span>
                  {sources.has(f.id) && <span className="pf-line-sub">Timmy reads this</span>}
                </button>
              </li>
            ))}
          </ul>
        </Piece>

        <Piece icon={Users} title="People" count={people.length} empty={people.length ? undefined : 'Nobody yet.'}>
          <ul className="pf-people">
            {people.map((id) => (
              <li key={id}>
                <button className="pf-person" onClick={() => dispatch({ type: 'navigate', route: { view: 'contact', id, tab: 'overview' } })}>
                  <Avatar id={id} size={28} />
                  <span>
                    <span className="pf-line-main">{personName(id)}</span>
                    <span className="pf-line-sub">{state.ws.contacts[id]?.title ?? state.ws.contacts[id]?.company ?? ''}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Piece>
      </div>
    </section>
  );
}
