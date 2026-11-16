import {
  Archive,
  ArrowRight,
  BookOpen,
  CalendarDays,
  Check,
  CheckCheck,
  FilePenLine,
  Hourglass,
  Pencil,
  Reply,
  Send,
  Sparkles,
  FilePlus2,
  ListPlus,
  SquarePen,
  StickyNote,
  Target,
  UserPlus,
} from 'lucide-react';
import { ContactDialog } from '../areas/people/ContactDialog';
import { NewDocDialog } from '../areas/docs/NewDocDialog';
import { TaskDialog } from '../areas/tasks/TaskDialog';
import { useState, type ReactNode } from 'react';
import { NOW, PEOPLE } from '../data/mock';
import { todaysEvents } from '../state/ws';
import type { Box, Thread } from '../data/types';
import { dayDiff, dueInfo, fmtDate, fmtLongDate, fmtShortTime, fmtTime, plural } from '../lib/format';
import { boxTag, byOldest, counterpart, inBox, labelOf, useStore, type TodayTab } from '../state/store';
import { type Approval } from '../state/approvals';
import { eventInScope, scopedApprovals, scopedThreads } from '../state/scope';
import { ScopeNote } from '../components/ProjectScope';
import { ProjectFocus } from './ProjectFocus';
import { LAST_RUN, LAST_RUN_COUNT, daysLabel } from '../state/schedule';
import { openThreads, useUrgency, type UrgencyInfo } from '../state/urgency';
import { ApprovalRow } from '../areas/approvals/ApprovalCard';
import { Segmented } from '../components/kit';
import { TimePicker } from '../components/TimePicker';
import { UrgencyReasons, UrgencyTag } from '../components/Urgency';
import { Avatar, EffortChip, Kbd, tint } from '../components/common';
import { DocIcon } from '../components/DocBits';
import { Frame } from '../components/Frame';
import { PHONE, useMedia } from '../lib/useMedia';

export function TodayView({ tab }: { tab: TodayTab }) {
  const { state, dispatch } = useStore();
  const triage = inBox(state.threads, 'inbox');
  const drafts = state.threads.filter((t) => t.draft && t.box !== 'archived');

  return (
    <Frame
      tabs={[
        { id: 'brief', label: 'Daily brief' },
        { id: 'triage', label: 'Triage', count: triage.length },
        { id: 'drafts', label: 'Drafts', count: drafts.length },
      ]}
      active={tab}
      onTab={(id) => dispatch({ type: 'navigate', route: { view: 'today', tab: id as TodayTab } })}
      scrollKey={tab}
    >
      {tab === 'brief' && <Brief />}
      {tab === 'triage' && <Triage threads={triage} />}
      {tab === 'drafts' && <Drafts threads={drafts} />}
    </Frame>
  );
}

// ───────────── Brief ─────────────

function Brief() {
  const { state, dispatch } = useStore();
  const { rank } = useUrgency();
  const owe = scopedThreads(state, inBox(state.threads, 'follow-up'));
  const waiting = scopedThreads(state, inBox(state.threads, 'waiting'));
  const triage = inBox(state.threads, 'inbox');
  const ranked = rank(scopedThreads(state, openThreads(state.threads)));
  const urgent = ranked.filter((x) => x.u.level === 'urgent').length;
  const approvals = scopedApprovals(state);
  const focus = state.focus;
  const scopeProject = state.scope ? state.ws.projects[state.scope] : undefined;
  const phone = useMedia(PHONE);

  if (state.calm) return <CalmBrief ranked={ranked} approvals={approvals.length} />;

  return (
    <>
      <div className="brief-head">
        <h1 className="page-title">Good morning, Taylor.</h1>
        <RunControl />
        <CalmToggle />
      </div>
      <p className="page-sub">
        {fmtLongDate(NOW)}. Timmy sorted {LAST_RUN_COUNT} emails this morning.{' '}
        {urgent ? `${plural(urgent, 'thing')} ${urgent === 1 ? 'is' : 'are'} urgent` : 'Nothing is urgent'}
        {approvals.length ? `, and ${plural(approvals.length, 'item')} ${approvals.length === 1 ? 'needs' : 'need'} your approval.` : '.'}
      </p>
      <ScopeNote />

      {/* On a phone, what needs you comes first; quick actions live in Ask and More. */}
      {phone && <UrgentSection ranked={ranked} limit={4} />}

      {!focus && !phone && <QuickActions />}

      <Highlight />

      {!phone && <UrgentSection ranked={ranked} />}

      <ApprovalsSection approvals={focus ? approvals.slice(0, 3) : approvals} total={approvals.length} />

      {!focus && (
        <div className="tri-grid">
          <OweCard threads={owe} />
          <WaitingCard threads={waiting} />
          <CalendarCard />
        </div>
      )}

      {!focus && (
      <section className="section">
        <div className="section-head">
          <h2 className="section-title">This morning’s triage</h2>
          <span className="section-sub">6:00 PM – {fmtTime(LAST_RUN)}</span>
        </div>
        <div className="card card-pad triage-summary">
          <p>
            Timmy archived <strong>24 emails</strong> that matched your rules (receipts, calendar replies and newsletters), filed{' '}
            <strong>2</strong> to Follow Up and saved the Figma receipt to [99] Receipts.{' '}
            {triage.length > 0 ? (
              <>
                <strong>{plural(triage.length, 'email')}</strong> still need your call, oldest first.
              </>
            ) : (
              <>You’ve sorted the rest. Inbox zero.</>
            )}
          </p>
          <div className="triage-bar">
            <Segments
              parts={[
                { n: 24, color: 'var(--c-brown)', label: 'archived' },
                { n: 2, color: 'var(--c-red)', label: 'to Follow Up' },
                { n: 7, color: 'var(--c-slate)', label: 'left for your call' },
              ]}
            />
          </div>
          {triage.length > 0 && (
            <button className="btn btn-sm" onClick={() => dispatch({ type: 'navigate', route: { view: 'today', tab: 'triage' } })}>
              Review {triage.length} in triage
              <ArrowRight size={14} />
            </button>
          )}
        </div>
      </section>
      )}
      {focus && scopeProject && <ProjectFocus p={scopeProject} />}
      {focus && (
        <p className="focus-foot">
          {scopeProject ? 'Focus mode is hiding everything outside this project.' : 'Focus mode is hiding the rest of the day. Pick a project at the top of the sidebar to see everything moving on it.'}{' '}
          <button className="link-btn" onClick={() => dispatch({ type: 'setFocus', on: false })}>
            Leave focus mode
          </button>
        </p>
      )}
    </>
  );
}

/** When the morning run happens; change it right here. */
function RunControl() {
  const { state, dispatch } = useStore();
  const s = state.schedule;
  return (
    <div className="run-control">
      <span className="run-label">Morning run</span>
      <TimePicker value={s.time} onChange={(time) => dispatch({ type: 'setSchedule', schedule: { time } })} label="Morning run time" align="right" />
      <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'navigate', route: { view: 'rules', tab: 'schedule' } })} title="Change the days in Settings › Schedule">
        {daysLabel(s.days)}
      </button>
    </div>
  );
}

/** The urgent list: only what needs you today, or everything open ranked. */
function UrgentSection({ ranked, limit }: { ranked: { t: Thread; u: UrgencyInfo }[]; limit?: number }) {
  const { state, dispatch } = useStore();
  const [all, setAll] = useState(false);
  const mode = state.schedule.brief;
  const urgent = ranked.filter((x) => x.u.level === 'urgent');
  const soon = ranked.filter((x) => x.u.level === 'soon').length;
  const later = ranked.length - urgent.length - soon;
  const full = mode === 'urgent' ? urgent : ranked;
  const rows = limit && !all ? full.slice(0, limit) : full;
  const setMode = (brief: 'urgent' | 'all') => dispatch({ type: 'setSchedule', schedule: { brief } });

  return (
    <section className="section" aria-labelledby="brief-urgent">
      <div className="section-head urgent-head">
        <div>
          <h2 className="section-title" id="brief-urgent">
            {mode === 'urgent' ? 'Needs you today' : 'Everything open'}
          </h2>
          <span className="section-sub">{mode === 'urgent' ? 'Ranked by Timmy. Open one to see why.' : 'Most urgent first.'}</span>
        </div>
        <Segmented
          label="Show"
          value={mode}
          onChange={setMode}
          options={[
            { id: 'urgent', label: `Urgent · ${urgent.length}` },
            { id: 'all', label: `Everything · ${ranked.length}` },
          ]}
        />
      </div>
      {rows.length > 0 ? (
        <ol className="card urg-list">
          {rows.map(({ t, u }, i) => {
            const who = t.box === 'waiting' && t.waiting ? t.waiting.on : counterpart(t);
            return (
              <li key={t.id} className="urg-row">
                <span className="urg-rank" aria-hidden>
                  {i + 1}
                </span>
                <Avatar id={who} size={30} />
                <div className="urg-row-text">
                  <button className="urg-row-title" onClick={() => dispatch({ type: 'openThread', id: t.id })}>
                    {t.ask}
                  </button>
                  <span className="urg-row-sub">
                    <UrgencyReasons info={u} max={3} />
                  </span>
                </div>
                <div className="urg-row-side">
                  <UrgencyTag info={u} always={mode === 'all'} />
                  <button className="btn btn-sm" onClick={() => dispatch({ type: 'openThread', id: t.id })}>
                    {t.draft ? (t.draft.kind === 'nudge' ? 'Review nudge' : 'Review draft') : 'Open'}
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="card empty">
          <span className="empty-icon">
            <CheckCheck size={20} />
          </span>
          <strong>Nothing urgent this morning</strong>
          <span>Everything open can wait until later in the week.</span>
        </div>
      )}
      {rows.length < full.length && (
        <p className="urg-more">
          <button className="link-btn" onClick={() => setAll(true)}>
            Show {full.length - rows.length} more
          </button>
        </p>
      )}
      {mode === 'urgent' && rows.length === full.length && (soon > 0 || later > 0) && (
        <p className="urg-more">
          {soon > 0 && `${plural(soon, 'more thing')} for this week`}
          {soon > 0 && later > 0 && ' and '}
          {later > 0 && `${later} that can wait`}.{' '}
          <button className="link-btn" onClick={() => setMode('all')}>
            Show everything
          </button>
        </p>
      )}
    </section>
  );
}

function ApprovalsSection({ approvals, total }: { approvals: Approval[]; total: number }) {
  const { dispatch } = useStore();
  return (
    <section className="section" aria-labelledby="brief-approvals">
      <div className="section-head">
        <h2 className="section-title" id="brief-approvals">
          Waiting for your approval
        </h2>
        {approvals.length > 0 && (
          <button className="btn btn-xs btn-ghost" onClick={() => dispatch({ type: 'navigate', route: { view: 'approvals', tab: 'open' } })}>
            See all {total}
            <ArrowRight size={13} />
          </button>
        )}
      </div>
      {approvals.length > 0 ? (
        <ul className="card ap-rows">
          {approvals.slice(0, 4).map((a) => (
            <ApprovalRow key={a.key} a={a} />
          ))}
        </ul>
      ) : (
        <div className="card empty">
          <span className="empty-icon">
            <CheckCheck size={20} />
          </span>
          <strong>Nothing waiting on you</strong>
          <span>Drafts, invites and decisions Timmy prepares will wait here until you approve them.</span>
        </div>
      )}
    </section>
  );
}

/** Switch between the full brief and the calm one, right where you read it. */
function CalmToggle() {
  const { state, dispatch } = useStore();
  return (
    <button className="btn btn-sm btn-ghost calm-toggle" aria-pressed={state.calm} onClick={() => dispatch({ type: 'setPrefs', calm: !state.calm })} title="A shorter brief with fewer badges">
      {state.calm ? 'Show everything' : 'Calm view'}
    </button>
  );
}

/**
 * The calm brief, for people who want a system, not a cockpit: your highlight,
 * the few things that need you, one line for approvals and your next meeting.
 * In focus mode it goes quieter still: the highlight and what's next.
 */
function CalmBrief({ ranked, approvals }: { ranked: { t: Thread; u: UrgencyInfo }[]; approvals: number }) {
  const { state, dispatch } = useStore();
  const [showUrgent, setShowUrgent] = useState(false);
  const urgent = ranked.filter((x) => x.u.level === 'urgent');
  const quiet = state.focus;
  const next = todaysEvents(state.ws).find((e) => e.end > NOW && e.kind !== 'personal' && eventInScope(state, e));
  return (
    <>
      <div className="brief-head">
        <h1 className="page-title">Good morning, Taylor.</h1>
        <CalmToggle />
      </div>
      <p className="page-sub">
        {fmtLongDate(NOW)}.{' '}
        {urgent.length ? `${plural(urgent.length, 'thing')} need${urgent.length === 1 ? 's' : ''} you today.` : 'Nothing needs you today.'}
      </p>
      <ScopeNote />

      <Highlight />

      {next && (
        <section className="section calm-next" aria-label="Next on your calendar">
          <div className="card card-pad calm-line">
            <span className="calm-when">{fmtTime(next.start)}</span>
            <span className="calm-what">
              <strong>{next.title}</strong>
              {next.with.length > 0 && <span className="muted"> · {next.with.map((p) => PEOPLE[p]?.name.split(' ')[0] ?? p).join(', ')}</span>}
            </span>
            <button className="btn btn-sm btn-ghost" onClick={() => (next.thread ? dispatch({ type: 'openThread', id: next.thread }) : dispatch({ type: 'navigate', route: { view: 'calendar', tab: 'day' } }))}>
              {next.thread ? 'Prepare' : 'Calendar'}
              <ArrowRight size={14} />
            </button>
          </div>
        </section>
      )}

      {quiet && !showUrgent ? (
        <p className="calm-collapsed">
          {urgent.length ? `${plural(urgent.length, 'urgent thing')} waiting.` : 'Nothing urgent.'}{' '}
          {urgent.length > 0 && (
            <button className="link-btn" onClick={() => setShowUrgent(true)}>
              Show
            </button>
          )}
        </p>
      ) : (
        <UrgentSection ranked={ranked} limit={3} />
      )}

      {!quiet && approvals > 0 && (
        <section className="section" aria-label="Approvals">
          <button className="card calm-approvals" onClick={() => dispatch({ type: 'navigate', route: { view: 'approvals', tab: 'open' } })}>
            <span>
              <strong>{plural(approvals, 'thing')}</strong> wait{approvals === 1 ? 's' : ''} for your OK
            </span>
            <span className="calm-approvals-go">
              Review
              <ArrowRight size={14} />
            </span>
          </button>
        </section>
      )}

      {quiet && (
        <p className="focus-foot">
          Focus mode: just your highlight and what’s next.{' '}
          <button className="link-btn" onClick={() => dispatch({ type: 'setFocus', on: false })}>
            Leave focus mode
          </button>
        </p>
      )}
    </>
  );
}

/** Start anything from the home page; each item links itself where it belongs. */
function QuickActions() {
  const { dispatch } = useStore();
  const [task, setTask] = useState(false);
  const [doc, setDoc] = useState(false);
  const [contact, setContact] = useState(false);
  return (
    <div className="quick-actions" role="group" aria-label="Quick actions">
      <button className="btn btn-sm" onClick={() => setTask(true)}>
        <ListPlus size={14} />
        New task
      </button>
      <button className="btn btn-sm" onClick={() => dispatch({ type: 'capture', open: true })}>
        <StickyNote size={14} />
        Quick note
        <Kbd>⌘J</Kbd>
      </button>
      <button className="btn btn-sm" onClick={() => dispatch({ type: 'compose', draft: { to: [], subject: '', body: '' } })}>
        <SquarePen size={14} />
        New email
        <Kbd>C</Kbd>
      </button>
      <button className="btn btn-sm" onClick={() => setDoc(true)}>
        <FilePlus2 size={14} />
        New doc
      </button>
      <button className="btn btn-sm" onClick={() => setContact(true)}>
        <UserPlus size={14} />
        Add contact
      </button>
      <TaskDialog open={task} onClose={() => setTask(false)} />
      <NewDocDialog open={doc} onClose={() => setDoc(false)} />
      <ContactDialog open={contact} onClose={() => setContact(false)} />
    </div>
  );
}

function Highlight() {
  const { state, dispatch } = useStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(state.highlight);
  const focus = todaysEvents(state.ws).find((e) => e.kind === 'focus');

  return (
    <div className={`highlight${state.highlightDone ? ' done' : ''}`}>
      <span className="highlight-icon">
        <Target size={18} />
      </span>
      <div className="highlight-body">
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) dispatch({ type: 'setHighlight', text: draft.trim() });
              setEditing(false);
            }}
          >
            <input className="input" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => setEditing(false)} aria-label="Today’s highlight" />
          </form>
        ) : (
          <p className="highlight-text">{state.highlight}</p>
        )}
        {!editing && (
          <span className="highlight-meta">
            Today’s highlight{focus ? ` · focus block ${fmtTime(focus.start)}–${fmtTime(focus.end)}` : ''}
          </span>
        )}
      </div>
      <div className="highlight-actions">
        <button className="icon-btn sm" aria-label="Change highlight" onClick={() => (setDraft(state.highlight), setEditing(true))}>
          <Pencil size={14} />
        </button>
        <button className={`btn btn-sm${state.highlightDone ? '' : ' btn-primary'}`} onClick={() => dispatch({ type: 'toggleHighlight' })}>
          <Check size={14} />
          {state.highlightDone ? 'Done' : 'Mark done'}
        </button>
      </div>
    </div>
  );
}

function DueText({ due, promised }: { due: Date; promised?: boolean }) {
  const { label, tone } = dueInfo(due);
  const lower = label.startsWith('Today') || label === 'Tomorrow' ? label[0]!.toLowerCase() + label.slice(1) : label;
  const text = tone === 'overdue' ? label.replace(/Overdue (\d+)d/, '$1d late') : `${promised ? 'promised' : 'due'} ${lower}`;
  return <span className={`tone-${tone}`}>{text}</span>;
}

function CardHead({ icon, color, title, count, to }: { icon: ReactNode; color: string; title: string; count: number; to: () => void }) {
  return (
    <button className="tc-head" onClick={to} style={tint(color)}>
      <span className="nav-icon">{icon}</span>
      <span className="tc-title">{title}</span>
      <span className="tc-count mono">{count}</span>
    </button>
  );
}

function Segments({ parts }: { parts: { n: number; color: string; label: string }[] }) {
  const total = parts.reduce((s, p) => s + p.n, 0) || 1;
  return (
    <div className="seg">
      <div className="seg-bar">
        {parts.map((p) => (p.n ? <span key={p.label} style={{ flex: p.n, background: p.color }} /> : null))}
      </div>
      <div className="seg-legend">
        {parts.map((p) => (
          <span key={p.label}>
            <i style={{ background: p.color }} />
            {p.n} {p.label}
          </span>
        ))}
      </div>
      <span className="sr-only">{total} total</span>
    </div>
  );
}

function OweCard({ threads }: { threads: Thread[] }) {
  const { dispatch } = useStore();
  const { rank } = useUrgency();
  const sorted = rank(threads).map((x) => x.t);
  const today = threads.filter((t) => t.due && dayDiff(t.due) <= 0).length;
  const week = threads.filter((t) => t.due && dayDiff(t.due) > 0 && dayDiff(t.due) < 7).length;
  return (
    <article className="card tri-card">
      <CardHead
        icon={<Reply size={16} />}
        color="var(--c-red)"
        title="I owe"
        count={threads.length}
        to={() => dispatch({ type: 'navigate', route: { view: 'box', box: 'follow-up', tab: 'all' } })}
      />
      <Segments
        parts={[
          { n: today, color: 'var(--c-red)', label: 'today' },
          { n: week, color: 'color-mix(in srgb, var(--c-red) 45%, transparent)', label: 'this week' },
          { n: threads.length - today - week, color: 'var(--line-strong)', label: 'later' },
        ]}
      />
      <ul className="tc-list">
        {sorted.slice(0, 3).map((t) => (
          <li key={t.id}>
            <button onClick={() => dispatch({ type: 'openThread', id: t.id })}>
              <span className="tc-lines">
                <span className="tc-item">{t.subject}</span>
                <span className="tc-sub">
                  {t.due && <DueText due={t.due} />}
                  {t.effort === 'quick' ? ' · quick reply' : t.effort === 'focus' ? ' · needs focus' : ''}
                </span>
              </span>
            </button>
          </li>
        ))}
        {threads.length === 0 && <li className="muted tc-empty">Nothing owed. Enjoy it.</li>}
      </ul>
    </article>
  );
}

function WaitingCard({ threads }: { threads: Thread[] }) {
  const { dispatch } = useStore();
  const overdue = threads.filter((t) => t.waiting?.due && t.waiting.due < NOW).length;
  const nodate = threads.filter((t) => !t.waiting?.due).length;
  const sorted = [...threads].sort((a, b) => (a.waiting?.due?.getTime() ?? 0) - (b.waiting?.due?.getTime() ?? 0));
  return (
    <article className="card tri-card">
      <CardHead
        icon={<Hourglass size={16} />}
        color="var(--c-amber)"
        title="I’m waiting on"
        count={threads.length}
        to={() => dispatch({ type: 'navigate', route: { view: 'box', box: 'waiting', tab: 'all' } })}
      />
      <Segments
        parts={[
          { n: overdue, color: 'var(--c-amber)', label: 'late' },
          { n: threads.length - overdue - nodate, color: 'color-mix(in srgb, var(--c-amber) 45%, transparent)', label: 'on time' },
          { n: nodate, color: 'var(--line-strong)', label: 'no date' },
        ]}
      />
      <ul className="tc-list">
        {sorted.slice(0, 3).map((t) => (
          <li key={t.id}>
            <button onClick={() => dispatch({ type: 'openThread', id: t.id })}>
              <Avatar id={t.waiting!.on} size={24} />
              <span className="tc-lines">
                <span className="tc-item">{t.waiting!.item}</span>
                <span className="tc-sub">
                  {PEOPLE[t.waiting!.on]!.name.split(' ')[0]} · {t.waiting?.due ? <DueText due={t.waiting.due} promised /> : `asked ${fmtDate(t.waiting!.since)}, no date`}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </article>
  );
}

function CalendarCard() {
  const { state, dispatch } = useStore();
  const events = todaysEvents(state.ws).filter((e) => eventInScope(state, e));
  const startH = 8;
  const endH = 18;
  const pct = (d: Date) => ((d.getHours() + d.getMinutes() / 60 - startH) / (endH - startH)) * 100;
  const upcoming = events.filter((e) => e.end > NOW).slice(0, 3);

  return (
    <article className="card tri-card">
      <CardHead
        icon={<CalendarDays size={16} />}
        color="var(--c-green)"
        title="Today’s calendar"
        count={events.length}
        to={() => dispatch({ type: 'navigate', route: { view: 'calendar', tab: 'day' } })}
      />
      <div className="daystrip" role="img" aria-label={`${events.length} events between 8 AM and 6 PM`}>
        {[10, 12, 14, 16].map((h) => (
          <span key={h} className="daystrip-hour" style={{ left: `${((h - startH) / (endH - startH)) * 100}%` }} />
        ))}
        {events.map((e) => (
          <span
            key={e.id}
            className={`daystrip-ev${e.kind === 'focus' ? ' focus' : ''}`}
            style={{ left: `${pct(e.start)}%`, width: `${Math.max(pct(e.end) - pct(e.start), 1.6)}%` }}
            title={`${e.title} · ${fmtTime(e.start)}`}
          />
        ))}
        <span className="daystrip-now" style={{ left: `${pct(NOW)}%` }} />
        {[8, 10, 12, 14, 16, 18].map((h) => (
          <span key={h} className="daystrip-tick mono" style={{ left: `${((h - startH) / (endH - startH)) * 100}%` }}>
            {h % 12 || 12}
          </span>
        ))}
      </div>
      <ul className="tc-list">
        {upcoming.map((e) => (
          <li key={e.id}>
            <button onClick={() => e.thread && dispatch({ type: 'openThread', id: e.thread })}>
              <span className="mono tc-time">{fmtShortTime(e.start)}</span>
              <span className="tc-lines">
                <span className="tc-item">{e.title}</span>
                <span className="tc-sub">
                  {e.kind === 'focus' ? 'Focus block · Timmy' : e.with.map((x) => PEOPLE[x]!.name.split(' ')[0]).join(', ')}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </article>
  );
}

// ───────────── Triage queue ─────────────

const MOVES: { box: Box; key: string; label: string; icon: ReactNode }[] = [
  { box: 'follow-up', key: 'F', label: 'Follow Up', icon: <Reply size={14} /> },
  { box: 'waiting', key: 'W', label: 'Waiting', icon: <Hourglass size={14} /> },
  { box: 'read-through', key: 'R', label: 'Read Through', icon: <BookOpen size={14} /> },
  { box: 'archived', key: 'E', label: 'Archive', icon: <Archive size={14} /> },
];

function Triage({ threads }: { threads: Thread[] }) {
  const { dispatch } = useStore();
  const queue = [...threads].sort(byOldest);
  const sure = queue.filter((t) => t.suggestion?.confidence === 'high');

  return (
    <>
      <div className="page-head-row">
        <div>
          <h1 className="page-title">Triage</h1>
          <p className="page-sub">Timmy’s suggestion for each unsorted email, oldest first. Accept it, or pick another label and Timmy will learn from it.</p>
        </div>
        {sure.length > 0 && (
          <button className="btn btn-primary" onClick={() => dispatch({ type: 'acceptAll', ids: sure.map((t) => t.id) })}>
            <CheckCheck size={15} />
            Accept {sure.length} confident
          </button>
        )}
      </div>

      <div className="triage-list">
        {queue.map((t) => {
          const s = t.suggestion!;
          const target = labelOf(s.box);
          const from = t.messages[0]!.from;
          return (
            <article key={t.id} className="card triage-item">
              <div className="triage-main">
                <Avatar id={from} size={34} />
                <div className="triage-text">
                  <div className="row-top">
                    <span className="row-from">{PEOPLE[from]!.name}</span>
                    <span className="row-company">{fmtShortWhen(t.messages[0]!.at)}</span>
                  </div>
                  <button className="row-subject triage-subject" onClick={() => dispatch({ type: 'openThread', id: t.id })}>
                    {t.subject}
                  </button>
                  <p className="timmy-line" style={{ fontSize: 13, marginTop: 4 }}>
                    <Sparkles size={13} />
                    <span>
                      {s.reason}
                      {s.extra && <strong> {s.extra}.</strong>}
                    </span>
                  </p>
                </div>
              </div>
              <div className="triage-actions">
                <button className="suggest-pill" style={tint(target.color)} onClick={() => dispatch({ type: 'acceptSuggestion', id: t.id })}>
                  <Check size={14} />
                  <span>
                    {s.box === 'archived' ? 'Archive' : `Move to ${boxTag(s.box)}`}
                  </span>
                  <span className={`conf conf-${s.confidence}`}>{s.confidence === 'high' ? 'Sure' : s.confidence === 'medium' ? 'Likely' : 'Unsure'}</span>
                </button>
                {s.effort && <EffortChip effort={s.effort} />}
                <div className="triage-alt" role="group" aria-label="Or move to">
                  {MOVES.filter((m) => m.box !== s.box).map((m) => (
                    <button key={m.box} className="btn btn-xs btn-ghost" onClick={() => dispatch({ type: 'move', id: t.id, box: m.box })} title={`${m.label} (${m.key})`}>
                      {m.icon}
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            </article>
          );
        })}
        {queue.length === 0 && (
          <div className="card empty">
            <span className="empty-icon">
              <CheckCheck size={20} />
            </span>
            <strong>Inbox zero</strong>
            <span>Everything is in Follow Up, Waiting, Read Through or the archive.</span>
          </div>
        )}
      </div>
    </>
  );
}

const fmtShortWhen = (d: Date) => (dayDiff(d) === 0 ? fmtTime(d) : `Yesterday ${fmtTime(d)}`);

// ───────────── Drafts ─────────────

function Drafts({ threads }: { threads: Thread[] }) {
  const { state, dispatch } = useStore();
  return (
    <>
      <h1 className="page-title">Drafts</h1>
      <p className="page-sub">Replies Timmy prepared from your files and past messages. Nothing is sent until you press Send.</p>
      <div className="draft-grid">
        {threads.map((t) => {
          const d = t.draft!;
          const to = d.to[0]!;
          const paras = d.body.split(/\n\n+/);
          const lines = paras.slice(1, -1).slice(0, 2);
          return (
            <article key={t.id} className="card draft-card">
              <header className="draft-card-head">
                <Avatar id={to} size={28} />
                <div style={{ minWidth: 0 }}>
                  <div className="row-from">To {PEOPLE[to]!.name}</div>
                  <div className="row-company">{d.kind === 'nudge' ? 'Nudge · ' : ''}{boxTag(t.box)}</div>
                </div>
                {t.box === 'follow-up' && t.effort && <EffortChip effort={t.effort} />}
              </header>
              <h2 className="draft-card-subject">{d.subject}</h2>
              <div className="draft-card-body">
                {lines.map((l, i) => (
                  <p key={i}>{l}</p>
                ))}
              </div>
              <div className="chips">
                {d.sources.map((id) => (
                  <span key={id} className="chip">
                    <DocIcon kind={state.ws.files[id]!.kind} size={12} />
                    {state.ws.files[id]!.name.replace(/^\d{4}(-Q\d|-\d{2}-\d{2})? ?/, '')}
                  </span>
                ))}
              </div>
              <footer className="draft-card-foot">
                <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'openThread', id: t.id })}>
                  <Pencil size={14} />
                  Review
                </button>
                <button className="btn btn-sm btn-primary" onClick={() => dispatch({ type: 'sendDraft', id: t.id, track: true })}>
                  <Send size={14} />
                  {d.trackAs ? 'Send & track' : 'Send'}
                </button>
              </footer>
            </article>
          );
        })}
      </div>
      {threads.length === 0 && (
        <div className="card empty">
          <span className="empty-icon">
            <FilePenLine size={20} />
          </span>
          <strong>No drafts</strong>
          <span>
            Timmy drafts replies during triage. Press <Kbd>D</Kbd> on any thread to ask for one.
          </span>
        </div>
      )}
    </>
  );
}
