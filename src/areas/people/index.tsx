import {
  BellPlus,
  BellRing,
  CalendarDays,
  Check,
  ChevronRight,
  FileText,
  ListPlus,
  Mail,
  MapPin,
  MessageSquarePlus,
  Pencil,
  Phone,
  Plus,
  Send,
  Star,
  StickyNote,
  UserPlus,
  UserRoundSearch,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { TaskDialog } from '../tasks/TaskDialog';
import { Avatar, DueChip, tint } from '../../components/common';
import { DocIcon } from '../../components/DocBits';
import { Frame } from '../../components/Frame';
import { AutoTextarea, EmptyState, SideHead } from '../../components/kit';
import { NOW } from '../../data/mock';
import type { Cadence, Contact, Interaction, InteractionKind, Task } from '../../data/ws-types';
import { fmtDate, fmtDay, fmtStamp, fmtTime, money } from '../../lib/format';
import { useStore, ws } from '../../state/store';
import { isoDay, patch, personName, put, uid, type WsOp } from '../../state/ws';
import { ThreadRow } from '../../views/MailboxView';
import { RpSection, SectionHead, TaskLine } from '../projects/ui';
import { ContactDialog } from './ContactDialog';
import { LogDialog, NextStepDialog } from './dialogs';
import {
  CADENCES,
  PRIORITY_LIMIT,
  TRACK_TARGET,
  cadenceLabel,
  dueForReview,
  filesFrom,
  fmtAgo,
  interactionsOf,
  isDueForReview,
  lastTouch,
  nextReview,
  openThreadsWith,
  ownerName,
  priorityContacts,
  sourcesFor,
  suggestions,
  tracked,
  upcomingWith,
} from './lib';

type PeopleTab = 'priority' | 'due' | 'tracked' | 'suggestions';
const PEOPLE_TABS: PeopleTab[] = ['priority', 'due', 'tracked', 'suggestions'];

const firstOf = (c: Contact) => c.name.split(' ')[0]!;
const roleLine = (c: Contact) => [c.title, c.company].filter(Boolean).join(' · ') || c.email;

/* ───────────── Shared actions ───────────── */

function useCrmActions() {
  const { state, dispatch } = useStore();
  return {
    togglePriority: (c: Contact) => {
      const on = !c.priority;
      const ops = [patch('contacts', c.id, on ? { priority: true, tracked: true, cadence: c.cadence ?? 'weekly' } : { priority: false })];
      const count = priorityContacts(state.ws).filter((x) => x.id !== c.id).length + 1;
      if (on && count > PRIORITY_LIMIT) {
        dispatch(ws(ops));
        dispatch({ type: 'toast', tone: 'warn', text: `${count} priority contacts now. Pick one or two for your current goal and unstar the rest.` });
      } else {
        dispatch(ws(ops, { toast: on ? `${firstOf(c)} is a priority contact` : `${firstOf(c)} is no longer a priority`, undo: true }));
      }
    },
    track: (c: Contact) =>
      dispatch(
        ws([patch('contacts', c.id, { tracked: true, cadence: 'monthly', last: lastTouch(state.ws, c, state.threads) })], {
          toast: `Tracking ${c.name} · monthly check-ins`,
          undo: true,
        }),
      ),
    reconnect: (c: Contact) => dispatch({ type: 'compose', draft: { to: [c.id], subject: '', body: `Hi ${firstOf(c)},\n\n` } }),
    open: (c: Contact, tab: 'overview' | 'activity' = 'overview') => dispatch({ type: 'navigate', route: { view: 'contact', id: c.id, tab } }),
  };
}

/* ───────────── People list ───────────── */

const TAB_COPY: Record<PeopleTab, { title: string; sub: string }> = {
  priority: { title: 'Priority', sub: 'One or two people who matter most for your current goal. Keep their next step current.' },
  due: { title: 'Due for review', sub: 'Tracked people you haven’t been in touch with for longer than their cadence. Reconnect, then update the next step.' },
  tracked: { title: 'All tracked', sub: 'Everyone in your CRM, with the next action, who owns it and when it’s due.' },
  suggestions: {
    title: 'Suggestions',
    sub: 'Start with 10–20 people you talk to or want to keep in touch with. These are the people you email most who aren’t tracked yet.',
  },
};

export function PeopleView() {
  const { state, dispatch } = useStore();
  const raw = state.route.view === 'people' ? state.route.tab : 'priority';
  const tab: PeopleTab = PEOPLE_TABS.includes(raw as PeopleTab) ? (raw as PeopleTab) : 'priority';
  const all = tracked(state.ws);
  const prio = priorityContacts(state.ws);
  const due = dueForReview(state.ws, state.threads);
  const sugg = suggestions(state.ws);
  const [adding, setAdding] = useState(false);
  const { open } = useCrmActions();

  const rows = tab === 'priority' ? prio : tab === 'due' ? due : tab === 'tracked' ? all : sugg;

  return (
    <Frame
      tabs={[
        { id: 'priority', label: 'Priority', count: prio.length },
        { id: 'due', label: 'Due for review', count: due.length },
        { id: 'tracked', label: 'All tracked', count: all.length },
        { id: 'suggestions', label: 'Suggestions', count: sugg.length },
      ]}
      active={tab}
      onTab={(id) => dispatch({ type: 'navigate', route: { view: 'people', tab: id } })}
      scrollKey={tab}
      wide
    >
      <div className="pj-title-row">
        <div>
          <h1 className="page-title">{TAB_COPY[tab].title}</h1>
          <p className="page-sub">{TAB_COPY[tab].sub}</p>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          <UserPlus size={15} />
          Add contact
        </button>
      </div>
      <p className="crm-progress">
        <strong className="mono">
          {all.length} of {TRACK_TARGET}
        </strong>{' '}
        tracked · <span className="mono">{prio.length}</span> priority · <span className="mono">{due.length}</span> due for review
        {all.length < 10 && ` · add ${10 - all.length} more to reach 10`}
      </p>

      {rows.length === 0 ? (
        <PeopleEmpty tab={tab} onAdd={() => setAdding(true)} />
      ) : tab === 'suggestions' ? (
        <SuggestionTable rows={rows} />
      ) : (
        <ContactTable rows={rows} mode={tab} />
      )}

      <ContactDialog open={adding} onClose={() => setAdding(false)} onSaved={(id) => open({ id } as Contact)} />
    </Frame>
  );
}

function PeopleEmpty({ tab, onAdd }: { tab: PeopleTab; onAdd: () => void }) {
  const { state, dispatch } = useStore();
  if (tab === 'due') {
    const soonest = tracked(state.ws)
      .map((c) => ({ c, at: nextReview(state.ws, c, state.threads) }))
      .filter((x) => x.at)
      .sort((a, b) => a.at!.getTime() - b.at!.getTime())[0];
    return (
      <EmptyState
        icon={CalendarDays}
        title="Everyone is within their cadence"
        body={soonest ? `Next check-in: ${soonest.c.name}, ${fmtDay(soonest.at!)}.` : 'Track a few people to start your weekly review.'}
      />
    );
  }
  if (tab === 'priority') {
    return (
      <EmptyState
        icon={Star}
        title="No priority contacts"
        body="Star one or two people who matter most for your current goal."
        action={
          <button className="btn btn-sm" onClick={() => dispatch({ type: 'navigate', route: { view: 'people', tab: 'tracked' } })}>
            Choose from tracked
          </button>
        }
      />
    );
  }
  if (tab === 'suggestions') return <EmptyState icon={UserRoundSearch} title="No suggestions left" body="Everyone you email regularly is already tracked." />;
  return (
    <EmptyState
      icon={Users}
      title="Nobody tracked yet"
      body="Start with 10–20 people you talk to or want to keep in touch with."
      action={
        <button className="btn btn-sm" onClick={onAdd}>
          <UserPlus size={14} />
          Add contact
        </button>
      }
    />
  );
}

function rowKeys(go: () => void) {
  return {
    tabIndex: 0,
    onClick: go,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && e.target === e.currentTarget) go();
    },
  };
}

function ContactTable({ rows, mode }: { rows: Contact[]; mode: 'priority' | 'due' | 'tracked' }) {
  const { state } = useStore();
  const { open, togglePriority, reconnect } = useCrmActions();
  return (
    <div className={`crm-table${mode === 'due' ? ' reconnect' : ''}`} role="list" aria-label={TAB_COPY[mode].title}>
      <div className="crm-row crm-th" aria-hidden>
        <span>Person</span>
        <span>Last interaction</span>
        <span>Next step</span>
        <span>Due</span>
        <span>Cadence</span>
        <span />
      </div>
      {rows.map((c) => {
        const last = lastTouch(state.ws, c, state.threads);
        return (
          <div key={c.id} role="listitem" className="crm-row" {...rowKeys(() => open(c))} aria-label={c.name}>
            <span className="cell-person">
              <Avatar id={c.id} size={32} />
              <span>
                <strong>{c.name}</strong>
                <span className="muted">{roleLine(c)}</span>
              </span>
            </span>
            <span className={`crm-cell crm-last${isDueForReview(state.ws, c, state.threads) ? ' late' : ''}`}>{fmtAgo(last)}</span>
            <span className="crm-cell crm-next">
              {c.next ? (
                <>
                  <span className="crm-next-text">{c.next}</span>
                  <span className="owner">{ownerName(c.owner, c)}</span>
                </>
              ) : (
                <span className="crm-missing">No next step</span>
              )}
            </span>
            <span className="crm-cell crm-due">{c.due ? <DueChip due={c.due} /> : <span className="muted">No date</span>}</span>
            <span className="crm-cell crm-cadence">{cadenceLabel(c.cadence)}</span>
            <span className="crm-cell crm-actions" onClick={(e) => e.stopPropagation()}>
              {mode === 'due' ? (
                <button className="btn btn-sm" onClick={() => reconnect(c)}>
                  <Send size={14} />
                  Reconnect
                </button>
              ) : (
                <button
                  className={`icon-btn sm${c.priority ? ' on' : ''}`}
                  aria-pressed={!!c.priority}
                  aria-label={c.priority ? `Remove ${c.name} from priority` : `Make ${c.name} a priority`}
                  title={c.priority ? 'Priority' : 'Make priority'}
                  onClick={() => togglePriority(c)}
                >
                  <Star size={15} fill={c.priority ? 'currentColor' : 'none'} />
                </button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SuggestionTable({ rows }: { rows: Contact[] }) {
  const { state } = useStore();
  const { open, track } = useCrmActions();
  return (
    <div className="crm-table crm-sugg" role="list" aria-label="Suggested contacts">
      <div className="crm-row crm-th" aria-hidden>
        <span>Person</span>
        <span>Emails, last 30 days</span>
        <span>Last interaction</span>
        <span />
      </div>
      {rows.map((c) => (
        <div key={c.id} role="listitem" className="crm-row" {...rowKeys(() => open(c))} aria-label={c.name}>
          <span className="cell-person">
            <Avatar id={c.id} size={32} />
            <span>
              <strong>{c.name}</strong>
              <span className="muted">{roleLine(c)}</span>
            </span>
          </span>
          <span className="crm-cell mono">{c.emails ?? 0}</span>
          <span className="crm-cell crm-last">{fmtAgo(lastTouch(state.ws, c, state.threads))}</span>
          <span className="crm-cell crm-actions" onClick={(e) => e.stopPropagation()}>
            <button className="btn btn-sm" onClick={() => track(c)}>
              <Plus size={14} />
              Track
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

/* ───────────── Contact page ───────────── */

const KINDS: Record<InteractionKind, { icon: LucideIcon; label: string; color: string }> = {
  note: { icon: StickyNote, label: 'Note', color: 'var(--c-amber)' },
  email: { icon: Mail, label: 'Email', color: 'var(--c-sky)' },
  meeting: { icon: Users, label: 'Meeting', color: 'var(--c-violet)' },
  call: { icon: Phone, label: 'Call', color: 'var(--c-green)' },
  reminder: { icon: BellRing, label: 'Reminder', color: 'var(--c-red)' },
  file: { icon: FileText, label: 'File', color: 'var(--c-slate)' },
};

const FILTERS: { id: string; label: string; kinds: InteractionKind[] | null }[] = [
  { id: 'all', label: 'All', kinds: null },
  { id: 'notes', label: 'Notes', kinds: ['note'] },
  { id: 'emails', label: 'Emails', kinds: ['email'] },
  { id: 'meetings', label: 'Meetings and calls', kinds: ['meeting', 'call'] },
  { id: 'reminders', label: 'Reminders', kinds: ['reminder'] },
  { id: 'files', label: 'Files', kinds: ['file'] },
];

export function ContactView() {
  const { state, dispatch } = useStore();
  const r = state.route.view === 'contact' ? state.route : null;
  const c = r ? state.ws.contacts[r.id] : undefined;
  const { togglePriority } = useCrmActions();
  const [dialog, setDialog] = useState<'edit' | 'log' | 'next' | 'task' | null>(null);
  const [reminderOpen, setReminderOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const before = useRef<Set<string> | null>(null);

  // A reminder is a task linked to the contact. When the task dialog saves one, add it to the history too.
  useEffect(() => {
    if (!before.current || !c) return;
    const fresh = Object.values(state.ws.tasks).filter((t) => !before.current!.has(t.id) && t.contact === c.id);
    if (fresh.length) {
      const ops: WsOp[] = fresh.map((t) =>
        put('interactions', { id: uid('int'), contact: c.id, kind: 'reminder', text: t.title, at: t.due ?? NOW, by: 'me', done: t.status === 'done' }),
      );
      const t = fresh[0]!;
      if (!c.next || (c.due && c.due < NOW)) ops.push(patch('contacts', c.id, { next: t.title, owner: 'me', due: t.due }));
      dispatch(ws(ops));
      before.current = new Set(Object.keys(state.ws.tasks));
    }
    if (!reminderOpen) before.current = null;
  }, [state.ws.tasks, reminderOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!r || !c) {
    return (
      <Frame tabs={[{ id: 'overview', label: 'Overview' }]} active="overview" onTab={() => undefined}>
        <EmptyState
          icon={Users}
          title="Contact not found"
          body="They may have been removed from People."
          action={
            <button className="btn btn-sm" onClick={() => dispatch({ type: 'navigate', route: { view: 'people', tab: 'tracked' } })}>
              Go to People
            </button>
          }
        />
      </Frame>
    );
  }

  const first = firstOf(c);
  const history = interactionsOf(state.ws, c.id);
  const go = (tab: 'overview' | 'activity', filter?: string) => dispatch({ type: 'navigate', route: { view: 'contact', id: c.id, tab, filter } });
  const compose = () => dispatch({ type: 'compose', draft: { to: [c.id], subject: '', body: '' } });
  const openReminder = () => {
    before.current = new Set(Object.keys(state.ws.tasks));
    setReminderOpen(true);
  };
  const addNote = () => {
    setNoteOpen(true);
    if (r.tab !== 'activity') go('activity', r.filter);
  };

  return (
    <Frame
      tabs={[
        { id: 'overview', label: 'Overview' },
        { id: 'activity', label: 'Activity', count: history.length },
      ]}
      active={r.tab}
      onTab={(id) => go(id as 'overview' | 'activity', r.filter)}
      scrollKey={`${c.id}-${r.tab}`}
      wide
    >
      <nav className="crumbs" aria-label="Breadcrumb">
        <button onClick={() => dispatch({ type: 'navigate', route: { view: 'people', tab: c.tracked ? (c.priority ? 'priority' : 'tracked') : 'suggestions' } })}>People</button>
        <ChevronRight size={14} aria-hidden />
        <span className="crumb-current" aria-current="page">
          {c.name}
        </span>
      </nav>

      <header className="crm-head">
        <Avatar id={c.id} size={64} />
        <div className="crm-head-text">
          <div className="crm-name-row">
            <h1 className="page-title">{c.name}</h1>
            {c.priority && (
              <span className="chip accent">
                <Star size={12} fill="currentColor" />
                Priority
              </span>
            )}
            {!c.tracked && <span className="chip">Not tracked</span>}
          </div>
          <p className="crm-head-sub">{[c.title, c.company].filter(Boolean).join(' · ') || c.email}</p>
          {c.location && (
            <p className="crm-head-loc">
              <MapPin size={13} aria-hidden />
              {c.location}
            </p>
          )}
        </div>
        <div className="crm-head-tools">
          <button
            className={`icon-btn${c.priority ? ' on' : ''}`}
            aria-pressed={!!c.priority}
            aria-label={c.priority ? 'Remove from priority' : 'Make a priority contact'}
            title={c.priority ? 'Priority contact' : 'Make priority'}
            onClick={() => togglePriority(c)}
          >
            <Star size={18} fill={c.priority ? 'currentColor' : 'none'} />
          </button>
          <button className="btn btn-sm" onClick={() => setDialog('edit')}>
            <Pencil size={14} />
            Edit
          </button>
        </div>
      </header>

      <div className="quick-actions crm-quick" role="group" aria-label="Contact actions">
        <button className="btn btn-sm btn-primary" onClick={compose}>
          <Send size={14} />
          Start a conversation
        </button>
        <button className="btn btn-sm" onClick={openReminder}>
          <BellPlus size={14} />
          Create a reminder
        </button>
        <button className="btn btn-sm" onClick={addNote}>
          <MessageSquarePlus size={14} />
          Add a note
        </button>
        <button className="btn btn-sm" onClick={() => setDialog('log')}>
          <Phone size={14} />
          Log a call or meeting
        </button>
      </div>

      <div className={`crm-cols tab-${r.tab}`}>
        <aside className="crm-left" aria-label="Details">
          <DetailsCard c={c} onEdit={() => setDialog('edit')} />
          <RelationshipCard c={c} onEditNext={() => setDialog('next')} />
          <AboutCard c={c} />
        </aside>
        <div className="crm-right">
          {r.tab === 'overview' ? (
            <ContactOverview c={c} onNewTask={() => setDialog('task')} onEditTask={setEditingTask} />
          ) : (
            <Activity c={c} filter={r.filter ?? 'all'} noteOpen={noteOpen} setNoteOpen={setNoteOpen} />
          )}
        </div>
      </div>

      <ContactDialog open={dialog === 'edit'} onClose={() => setDialog(null)} initial={c} />
      <LogDialog open={dialog === 'log'} onClose={() => setDialog(null)} contact={c} />
      <NextStepDialog open={dialog === 'next'} onClose={() => setDialog(null)} contact={c} />
      <TaskDialog open={dialog === 'task'} onClose={() => setDialog(null)} initial={{ contact: c.id }} />
      <TaskDialog open={reminderOpen} onClose={() => setReminderOpen(false)} initial={{ contact: c.id, title: `Follow up with ${first}` }} />
      <TaskDialog open={!!editingTask} onClose={() => setEditingTask(null)} initial={editingTask ?? undefined} />
    </Frame>
  );
}

function CardHead({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <header className="crm-card-head">
      <h2 className="crm-card-title">{title}</h2>
      {action}
    </header>
  );
}

function AddValue({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="crm-add" onClick={onClick}>
      <Plus size={12} />
      {label}
    </button>
  );
}

function DetailsCard({ c, onEdit }: { c: Contact; onEdit: () => void }) {
  const { dispatch } = useStore();
  const rows: { label: string; value?: string; node?: ReactNode }[] = [
    {
      label: 'Email',
      value: c.email,
      node: (
        <button type="button" className="crm-value-link" onClick={() => dispatch({ type: 'compose', draft: { to: [c.id], subject: '', body: '' } })}>
          {c.email}
        </button>
      ),
    },
    { label: 'Phone', value: c.phone, node: c.phone ? <a className="crm-value-link mono" href={`tel:${c.phone.replace(/\s/g, '')}`}>{c.phone}</a> : undefined },
    { label: 'Location', value: c.location },
    { label: 'Company', value: c.company },
    { label: 'Title', value: c.title },
  ];
  return (
    <section className="card crm-card">
      <CardHead
        title="Contact details"
        action={
          <button className="icon-btn sm" aria-label="Edit contact details" onClick={onEdit}>
            <Pencil size={14} />
          </button>
        }
      />
      <dl className="kv crm-kv">
        {rows.map((row) => (
          <Kv key={row.label} label={row.label}>
            {row.value ? row.node ?? row.value : <AddValue label={`Add ${row.label.toLowerCase()}`} onClick={onEdit} />}
          </Kv>
        ))}
      </dl>
    </section>
  );
}

function Kv({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function RelationshipCard({ c, onEditNext }: { c: Contact; onEditNext: () => void }) {
  const { state, dispatch } = useStore();
  const last = lastTouch(state.ws, c, state.threads);
  const review = nextReview(state.ws, c, state.threads);
  const due = isDueForReview(state.ws, c, state.threads);
  const deal = c.deal ? state.deals[c.deal] : undefined;
  const src = sourcesFor(state.ws, state.threads, c);
  const first = firstOf(c);

  const setTracked = (on: boolean) =>
    dispatch(
      ws([patch('contacts', c.id, on ? { tracked: true, cadence: c.cadence ?? 'monthly', last } : { tracked: false, priority: false })], {
        toast: on ? `Tracking ${first} in your weekly review` : `Stopped tracking ${first}`,
        undo: true,
      }),
    );
  const setCadence = (cadence: Cadence) => dispatch(ws([patch('contacts', c.id, { cadence })], { toast: `${first}: ${cadence} check-ins`, undo: true }));

  return (
    <section className="card crm-card">
      <CardHead
        title="Relationship"
        action={
          <button className="icon-btn sm" aria-label="Edit next step" onClick={onEditNext}>
            <Pencil size={14} />
          </button>
        }
      />
      <dl className="kv crm-kv">
        <Kv label="Tracking">
          <span className="crm-inline">
            <button type="button" className="switch" role="switch" aria-checked={!!c.tracked} aria-label="Track in your CRM" onClick={() => setTracked(!c.tracked)} />
            <span className="crm-quiet">{c.tracked ? 'In your review' : 'Not tracked'}</span>
          </span>
        </Kv>
        <Kv label="Cadence">
          <select className="input crm-select" value={c.cadence ?? 'monthly'} onChange={(e) => setCadence(e.target.value as Cadence)} aria-label="Check-in cadence">
            {CADENCES.map((x) => (
              <option key={x} value={x}>
                {cadenceLabel(x)}
              </option>
            ))}
          </select>
        </Kv>
        <Kv label="Last">
          {last ? (
            <span>
              {fmtAgo(last)}
              <span className="crm-quiet"> · {fmtDate(last)}</span>
            </span>
          ) : (
            <span className="crm-quiet">No contact logged</span>
          )}
        </Kv>
        {c.tracked && (
          <Kv label="Check in">
            {due ? <span className="chip overdue">Due now</span> : review ? <span>{fmtDay(review)}</span> : <span className="crm-quiet">Not set</span>}
          </Kv>
        )}
        <Kv label="Next step">
          {c.next ? (
            <span>
              {c.next}
              <span className="owner">{ownerName(c.owner, c)}</span>
            </span>
          ) : (
            <AddValue label="Add next step" onClick={onEditNext} />
          )}
        </Kv>
        <Kv label="Due">{c.due ? <DueChip due={c.due} /> : <span className="crm-quiet">No date</span>}</Kv>
        {(src.thread || src.note) && (
          <Kv label="Source">
            <span className="crm-sources">
              {src.thread && (
                <button type="button" className="crm-value-link" onClick={() => dispatch({ type: 'openThread', id: src.thread!.id })}>
                  <Mail size={13} aria-hidden />
                  {src.thread.subject}
                </button>
              )}
              {src.note && (
                <button type="button" className="crm-value-link" onClick={() => dispatch({ type: 'navigate', route: { view: 'file', id: src.note!.id } })}>
                  <FileText size={13} aria-hidden />
                  {src.note.name}
                </button>
              )}
            </span>
          </Kv>
        )}
        {deal && (
          <Kv label="Deal">
            <span className="crm-inline wrap">
              <span className={`stage${deal.stage === 'Closed won' ? ' won' : ''}`}>{deal.stage}</span>
              <span className="mono">{money(deal.value)}</span>
              <span className="crm-quiet">{deal.name}</span>
            </span>
          </Kv>
        )}
      </dl>
    </section>
  );
}

function AboutCard({ c }: { c: Contact }) {
  const { dispatch } = useStore();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(c.about ?? '');
  const save = () => {
    dispatch(ws([patch('contacts', c.id, { about: text.trim() || undefined })], { toast: 'About saved', undo: true }));
    setEditing(false);
  };
  return (
    <section className="card crm-card">
      <CardHead
        title="About"
        action={
          !editing && (
            <button
              className="icon-btn sm"
              aria-label="Edit about"
              onClick={() => {
                setText(c.about ?? '');
                setEditing(true);
              }}
            >
              <Pencil size={14} />
            </button>
          )
        }
      />
      {editing ? (
        <div className="crm-about-edit">
          <AutoTextarea
            autoFocus
            minRows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="How they like to work, who signs off, what you talked about last."
            aria-label={`About ${c.name}`}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setEditing(false);
              }
            }}
          />
          <div className="crm-row-btns">
            <button className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="btn btn-sm btn-primary" onClick={save}>
              Save
            </button>
          </div>
        </div>
      ) : c.about ? (
        <p className="crm-about">{c.about}</p>
      ) : (
        <p className="crm-about crm-quiet">
          Nothing yet.{' '}
          <button
            className="pj-inline-link"
            onClick={() => {
              setText('');
              setEditing(true);
            }}
          >
            Add what you’ll want to remember
          </button>
        </p>
      )}
    </section>
  );
}

/* overview tab */

function ContactOverview({ c, onNewTask, onEditTask }: { c: Contact; onNewTask: () => void; onEditTask: (t: Task) => void }) {
  const { state, dispatch } = useStore();
  const threads = openThreadsWith(state.threads, c.id);
  const tasks = Object.values(state.ws.tasks)
    .filter((t) => t.contact === c.id)
    .sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity));
  const events = upcomingWith(state.ws, c.id).slice(0, 4);
  const files = filesFrom(state.ws, c.id).slice(0, 6);
  const first = firstOf(c);

  return (
    <div className="crm-stack">
      <section>
        <SectionHead title="Open emails" sub={threads.length ? undefined : `No open threads with ${first}.`} />
        {threads.length > 0 && (
          <div role="list" className="pj-threads">
            {threads.map((t) => (
              <ThreadRow key={t.id} t={t} />
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionHead title="Tasks">
          <button className="btn btn-xs" onClick={onNewTask}>
            <ListPlus size={13} />
            New task
          </button>
        </SectionHead>
        {tasks.length ? (
          <ul className="pj-box">
            {tasks.map((t) => (
              <TaskLine key={t.id} task={t} onEdit={onEditTask} showProject showContact={false} />
            ))}
          </ul>
        ) : (
          <p className="pj-none">No tasks linked to {first}.</p>
        )}
      </section>

      <section>
        <SectionHead title="Upcoming meetings" sub={events.length ? undefined : `Nothing on the calendar with ${first}.`} />
        {events.length > 0 && (
          <ul className="pj-box">
            {events.map((e) => (
              <li key={e.id}>
                <button type="button" className="pj-line" onClick={() => dispatch({ type: 'navigate', route: { view: 'calendar', tab: 'day', date: isoDay(e.start) } })}>
                  <span className="pj-ctx-icon">
                    <CalendarDays size={14} />
                  </span>
                  <span className="pj-line-text">
                    <span className="pj-line-title">{e.title}</span>
                    <span className="pj-line-sub">
                      {fmtDay(e.start)} · {fmtTime(e.start)} – {fmtTime(e.end)}
                      {e.with.length > 1 && ` · with ${e.with.filter((p) => p !== c.id).map((p) => personName(p).split(' ')[0]).join(', ')}`}
                    </span>
                  </span>
                  {e.notesDoc && (
                    <span className="chip">
                      <FileText size={12} />
                      Notes doc
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHead title="Files they shared" sub={files.length ? undefined : `No files from ${first} yet.`} />
        {files.length > 0 && (
          <ul className="pj-box">
            {files.map((f) => (
              <li key={f.id}>
                <button type="button" className="pj-line" onClick={() => dispatch({ type: 'navigate', route: { view: 'file', id: f.id } })}>
                  <DocIcon kind={f.kind} size={18} />
                  <span className="pj-line-text">
                    <span className="pj-line-title">{f.name}</span>
                    <span className="pj-line-sub">Edited {fmtStamp(f.updated)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* activity tab */

function Activity({ c, filter, noteOpen, setNoteOpen }: { c: Contact; filter: string; noteOpen: boolean; setNoteOpen: (v: boolean) => void }) {
  const { state, dispatch } = useStore();
  const history = interactionsOf(state.ws, c.id);
  const active = FILTERS.find((f) => f.id === filter) ?? FILTERS[0]!;
  const shown = active.kinds ? history.filter((i) => active.kinds!.includes(i.kind)) : history;
  const isUpcoming = (i: Interaction) => i.kind === 'reminder' && !i.done && i.at.getTime() > NOW.getTime();
  const upcoming = shown.filter(isUpcoming).sort((a, b) => a.at.getTime() - b.at.getTime());
  const past = shown.filter((i) => !isUpcoming(i));
  const [text, setText] = useState('');
  const first = firstOf(c);

  const saveNote = () => {
    const note = text.trim();
    if (!note) return;
    dispatch(ws([put('interactions', { id: uid('int'), contact: c.id, kind: 'note', text: note, at: NOW, by: 'me' })], { toast: `Note added to ${first}’s history`, undo: true }));
    setText('');
    setNoteOpen(false);
  };

  const setFilter = (id: string) => dispatch({ type: 'navigate', route: { view: 'contact', id: c.id, tab: 'activity', filter: id } });

  return (
    <div className="crm-activity">
      {noteOpen ? (
        <div className="crm-composer">
          <AutoTextarea
            autoFocus
            minRows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`What should you remember about ${first}?`}
            aria-label={`Note about ${c.name}`}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveNote();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setNoteOpen(false);
              }
            }}
          />
          <div className="crm-composer-foot">
            <span className="field-hint">Saved to the history with today’s date.</span>
            <div className="crm-row-btns">
              <button className="btn btn-sm btn-ghost" onClick={() => setNoteOpen(false)}>
                Cancel
              </button>
              <button className="btn btn-sm btn-primary" onClick={saveNote} disabled={!text.trim()}>
                Save note
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button type="button" className="crm-composer-closed" onClick={() => setNoteOpen(true)}>
          <MessageSquarePlus size={15} />
          Add a note about {first}
        </button>
      )}

      <div className="filters crm-filters" role="group" aria-label="Filter history">
        {FILTERS.map((f) => {
          const count = f.kinds ? history.filter((i) => f.kinds!.includes(i.kind)).length : history.length;
          return (
            <button key={f.id} type="button" className="filter" aria-pressed={active.id === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
              <span className="crm-filter-count mono">{count}</span>
            </button>
          );
        })}
      </div>

      {upcoming.length > 0 && (
        <>
          <h2 className="section-title crm-history-title">Upcoming</h2>
          <ol className="timeline crm-timeline crm-upcoming">
            {upcoming.map((i) => (
              <HistoryItem key={i.id} i={i} />
            ))}
          </ol>
        </>
      )}
      <h2 className="section-title crm-history-title">History</h2>
      {past.length ? (
        <ol className="timeline crm-timeline">
          {past.map((i) => (
            <HistoryItem key={i.id} i={i} />
          ))}
        </ol>
      ) : (
        <p className="pj-none">
          {shown.length ? 'Nothing logged yet.' : history.length ? `No ${active.label.toLowerCase()} yet.` : `Nothing logged with ${first} yet. Add a note or log your next call.`}
        </p>
      )}
    </div>
  );
}

function HistoryItem({ i }: { i: Interaction }) {
  const { state, dispatch } = useStore();
  const meta = KINDS[i.kind];
  const file = i.file ? state.ws.files[i.file] : undefined;
  const thread = i.thread ? state.threads.find((t) => t.id === i.thread) : undefined;
  const openMain = thread ? () => dispatch({ type: 'openThread', id: thread.id }) : file ? () => dispatch({ type: 'navigate', route: { view: 'file', id: file.id } }) : undefined;
  const upcoming = i.kind === 'reminder' && !i.done;

  const toggleDone = () =>
    dispatch(ws([patch('interactions', i.id, { done: !i.done })], { toast: i.done ? 'Reminder reopened' : 'Reminder done', undo: true }));

  return (
    <li>
      <span className="timeline-dot crm-dot" style={tint(meta.color)} aria-hidden>
        <meta.icon size={13} />
      </span>
      <div className={`crm-event${i.done ? ' done' : ''}`}>
        <div className="crm-event-top">
          <span className="crm-event-kind">{meta.label}</span>
          <span className={`crm-event-time${upcoming && i.at < NOW ? ' tone-overdue' : ''}`}>{upcoming ? `Due ${fmtStamp(i.at)}` : fmtStamp(i.at)}</span>
        </div>
        {openMain ? (
          <button type="button" className="crm-event-text crm-event-link" onClick={openMain}>
            {i.text}
          </button>
        ) : (
          <p className="crm-event-text">{i.text}</p>
        )}
        <div className="crm-event-foot">
          <span className="crm-event-by">
            <Avatar id={i.by} size={18} />
            {i.by === 'me' ? 'You' : personName(i.by)}
          </span>
          {thread && (
            <button type="button" className="crm-value-link" onClick={() => dispatch({ type: 'openThread', id: thread.id })}>
              <Mail size={13} aria-hidden />
              {thread.subject}
            </button>
          )}
          {file && (
            <button type="button" className="crm-value-link" onClick={() => dispatch({ type: 'navigate', route: { view: 'file', id: file.id } })}>
              <FileText size={13} aria-hidden />
              {file.name}
            </button>
          )}
          {i.kind === 'reminder' && (
            <span className="crm-done">
              <button type="button" className="pj-check" role="checkbox" aria-checked={!!i.done} aria-label={`Done: ${i.text}`} onClick={toggleDone}>
                {i.done && <Check size={12} strokeWidth={3} />}
              </button>
              <span className="crm-done-label">Done</span>
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

/* ───────────── Sidebar ───────────── */

export function PeopleSide() {
  const { state, dispatch } = useStore();
  const r = state.route;
  const current = r.view === 'contact' ? r.id : null;
  const all = tracked(state.ws);
  const prio = all.filter((c) => c.priority);
  const due = dueForReview(state.ws, state.threads);
  const dueIds = new Set(due.map((c) => c.id));
  // Each person appears once: priority first, then due for review, then everyone else.
  const dueRest = due.filter((c) => !c.priority);
  const rest = all.filter((c) => !c.priority && !dueIds.has(c.id));
  const since = (c: Contact) => `Last in touch ${fmtAgo(lastTouch(state.ws, c, state.threads)).toLowerCase()}`;
  const [adding, setAdding] = useState(false);

  const item = (c: Contact, hint?: string) => (
    <button
      key={c.id}
      className="nav-item crm-nav"
      aria-current={current === c.id ? 'page' : undefined}
      onClick={() => dispatch({ type: 'navigate', route: { view: 'contact', id: c.id, tab: 'overview' } })}
    >
      <Avatar id={c.id} size={28} />
      <span className="nav-text">
        <span className="nav-name">{c.name}</span>
        <span className="nav-hint">{hint ?? c.next ?? 'No next step'}</span>
      </span>
      {c.due && c.due < NOW ? <span className="crm-nav-late" title="Next step is overdue" /> : <span />}
    </button>
  );

  return (
    <>
      <SideHead
        icon={<Users size={18} />}
        title="People"
        sub={`${all.length} tracked · ${prio.length} priority`}
        action={
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            <UserPlus size={15} />
            Add contact
          </button>
        }
      />
      <div className="side-scroll">
        <div className="side-group">
          <div className="side-title">Priority</div>
          {prio.map((c) => item(c, dueIds.has(c.id) ? `Due for review · ${since(c).toLowerCase()}` : undefined))}
          {prio.length === 0 && <p className="nav-hint pj-side-empty">Star one or two people for your current goal.</p>}
        </div>
        <div className="side-group">
          <div className="side-title">
            Due for review
            <span className="mono">{due.length}</span>
          </div>
          {dueRest.map((c) => item(c, since(c)))}
          {due.length === 0 && <p className="nav-hint pj-side-empty">Everyone is within their cadence.</p>}
          {due.length > 0 && dueRest.length === 0 && <p className="nav-hint pj-side-empty">Only priority contacts, listed above.</p>}
        </div>
        <div className="side-group">
          <div className="side-title">Tracked</div>
          {rest.map((c) => item(c))}
          {rest.length === 0 && <p className="nav-hint pj-side-empty">Track people from Suggestions.</p>}
        </div>
      </div>
      <div className="side-foot">
        <button
          className="nav-item compact"
          aria-current={r.view === 'people' && r.tab === 'suggestions' ? 'page' : undefined}
          onClick={() => dispatch({ type: 'navigate', route: { view: 'people', tab: 'suggestions' } })}
        >
          <UserRoundSearch size={16} className="pj-side-icon" />
          <span className="nav-name">Suggestions</span>
          <span className="nav-count">{suggestions(state.ws).length}</span>
        </button>
      </div>
      <ContactDialog
        open={adding}
        onClose={() => setAdding(false)}
        onSaved={(id) => dispatch({ type: 'navigate', route: { view: 'contact', id, tab: 'overview' } })}
      />
    </>
  );
}

/* ───────────── Context panel ───────────── */

export function PeopleContext() {
  const { state, dispatch } = useStore();
  const r = state.route;
  const c = r.view === 'contact' ? state.ws.contacts[r.id] : undefined;
  const [editingNext, setEditingNext] = useState(false);

  if (!c) {
    const all = tracked(state.ws);
    const due = dueForReview(state.ws, state.threads);
    return (
      <>
        <RpSection title="How your CRM works">
          <ul className="rp-bullets">
            <li>Start with 10–20 people you talk to or want to keep in touch with.</li>
            <li>Record only the details you’ll use: how they like to work and what you owe each other.</li>
            <li>Pick one or two priority contacts for your current goal.</li>
            <li>Give every relationship a next step, an owner and a due date, linked to the email or meeting note it came from.</li>
            <li>Once a week, review who is past their cadence and reconnect.</li>
          </ul>
        </RpSection>
        <RpSection title="This week’s review">
          <div className="rp-card">
            <dl className="kv flush">
              <dt>Tracked</dt>
              <dd className="mono">
                {all.length} of {TRACK_TARGET}
              </dd>
              <dt>Priority</dt>
              <dd className="mono">{priorityContacts(state.ws).length}</dd>
              <dt>Due</dt>
              <dd className="mono">{due.length}</dd>
            </dl>
          </div>
          <button className="rp-link crm-rp-link" onClick={() => dispatch({ type: 'navigate', route: { view: 'people', tab: 'due' } })}>
            Open the review
          </button>
        </RpSection>
      </>
    );
  }

  const src = sourcesFor(state.ws, state.threads, c);
  const last = lastTouch(state.ws, c, state.threads);
  const review = nextReview(state.ws, c, state.threads);

  return (
    <>
      <div className="person-hero">
        <Avatar id={c.id} size={52} />
        <strong>{c.name}</strong>
        <span className="muted">{roleLine(c)}</span>
      </div>

      <RpSection
        title="Next step"
        aside={
          <button className="rp-link" aria-label={c.next ? 'Edit next step' : 'Add a next step'} onClick={() => setEditingNext(true)}>
            {c.next ? 'Edit' : 'Add'}
          </button>
        }
      >
        {c.next ? (
          <div className="rp-card">
            <p className="crm-rp-next">{c.next}</p>
            <dl className="kv">
              <dt>Owner</dt>
              <dd>{ownerName(c.owner, c)}</dd>
              <dt>Due</dt>
              <dd>{c.due ? <DueChip due={c.due} /> : <span className="crm-quiet">No date</span>}</dd>
            </dl>
          </div>
        ) : (
          <p className="rp-text">No next step yet. Every important relationship needs one, with an owner and a date.</p>
        )}
      </RpSection>

      <RpSection title="Where it came from">
        {src.thread || src.note ? (
          <ul className="rp-list">
            {src.thread && (
              <li>
                <button className="rp-thread" onClick={() => dispatch({ type: 'openThread', id: src.thread!.id })}>
                  <Mail size={15} className="crm-rp-icon" />
                  <span className="rp-person-text">
                    <span className="rp-person-name">{src.thread.subject}</span>
                    <span className="rp-person-sub">Email · {fmtDate(src.thread.messages[src.thread.messages.length - 1]!.at)}</span>
                  </span>
                </button>
              </li>
            )}
            {src.note && (
              <li>
                <button className="rp-thread" onClick={() => dispatch({ type: 'navigate', route: { view: 'file', id: src.note!.id } })}>
                  <FileText size={15} className="crm-rp-icon" />
                  <span className="rp-person-text">
                    <span className="rp-person-name">{src.note.name}</span>
                    <span className="rp-person-sub">Meeting note · {fmtDate(src.note.updated)}</span>
                  </span>
                </button>
              </li>
            )}
          </ul>
        ) : (
          <p className="rp-text">No email or meeting note linked yet. Log a call with its note, or email {firstOf(c)} from here.</p>
        )}
      </RpSection>

      <RpSection title="Check-in">
        <div className="rp-card">
          <dl className="kv flush">
            <dt>Cadence</dt>
            <dd>{c.tracked ? cadenceLabel(c.cadence) : 'Not tracked'}</dd>
            <dt>Last</dt>
            <dd>{fmtAgo(last)}</dd>
            {c.tracked && (
              <>
                <dt>Next</dt>
                <dd>{isDueForReview(state.ws, c, state.threads) ? <span className="chip overdue">Due now</span> : review ? fmtDay(review) : 'Not set'}</dd>
              </>
            )}
          </dl>
        </div>
      </RpSection>
      <NextStepDialog open={editingNext} onClose={() => setEditingNext(false)} contact={c} />
    </>
  );
}
