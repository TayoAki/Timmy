import { PHONE, useMedia } from '../../lib/useMedia';
import { CalendarClock, CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, FileText, Mail, Plus, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Avatar, DueChip, Folder, tint } from '../../components/common';
import { DocIcon } from '../../components/DocBits';
import { Frame } from '../../components/Frame';
import { SideHead } from '../../components/kit';
import { NOW } from '../../data/mock';
import type { Task, WEvent } from '../../data/ws-types';
import { fmtDay, fmtLongDate, fmtShortTime, plural } from '../../lib/format';
import { useStore, ws, type Route } from '../../state/store';
import { firstName, isoDay, parseIsoDay, patch, sameDay, weekStart } from '../../state/ws';
import { byDue, openTasks } from '../tasks/bits';
import { BlockTimeDialog } from './BlockTimeDialog';
import { EventDetail, EventDialog, type EventDraft } from './EventDialogs';
import {
  addDays,
  fmtClock,
  fmtDuration,
  fmtRange,
  KINDS,
  MIN,
  minutesOf,
  nextPrepEvent,
  rowLabel,
  setCalUi,
  startOfDay,
  topicsFor,
  useCalUi,
  withTopic,
} from './shared';

type CalRoute = Extract<Route, { view: 'calendar' }>;

const START_H = 7;
const END_H = 19;
/** Shortest block drawn, in pixels. */
const MIN_PX = 20;

const useCalRoute = (): CalRoute => {
  const { state } = useStore();
  return state.route.view === 'calendar' ? state.route : { view: 'calendar', tab: 'week' };
};

const routeDate = (r: CalRoute) => (r.date ? parseIsoDay(r.date) : startOfDay(NOW));

const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;

/** "Nov 16 – 20, 2026" or "Nov 30 – Dec 4, 2026". */
const fmtWeek = (a: Date, b: Date) => {
  const left = a.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const right = a.getMonth() === b.getMonth() ? String(b.getDate()) : b.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${left} – ${right}, ${b.getFullYear()}`;
};

/* ───────────── Main view ───────────── */

export function CalendarView() {
  const { state, dispatch } = useStore();
  const r = useCalRoute();
  const ui = useCalUi();
  const date = routeDate(r);
  const isWeek = r.tab === 'week';
  const [detail, setDetail] = useState<string | null>(null);
  const [creating, setCreating] = useState<EventDraft | null>(null);
  const [blockFor, setBlockFor] = useState<Task | null>(null);
  const closeDetail = useCallback(() => setDetail(null), []);
  const closeCreate = useCallback(() => setCreating(null), []);
  const closeBlock = useCallback(() => setBlockFor(null), []);
  // A week of columns doesn't fit a phone: open on the day instead.
  const phone = useMedia(PHONE);
  useEffect(() => {
    if (phone && isWeek) dispatch({ type: 'navigate', route: { view: 'calendar', tab: 'day', date: r.date } });
  }, [phone]); // eslint-disable-line react-hooks/exhaustive-deps

  // Another screen asked to show an event (e.g. the weekly review link).
  useEffect(() => {
    if (ui.open) {
      setDetail(ui.open);
      setCalUi({ open: undefined });
    }
  }, [ui.open]);

  const monday = weekStart(date);
  const days = isWeek ? Array.from({ length: ui.weekend ? 7 : 5 }, (_, i) => addDays(monday, i)) : [date];
  const visible = Object.values(state.ws.events).filter((e) => !ui.hidden.includes(e.kind));
  const inRange = visible.filter((e) => days.some((d) => sameDay(d, e.start)));
  const focusMin = inRange.filter((e) => e.kind === 'focus').reduce((n, e) => n + Math.round((e.end.getTime() - e.start.getTime()) / MIN), 0);
  const next = inRange.filter((e) => e.start > NOW).sort((a, b) => a.start.getTime() - b.start.getTime())[0];

  const go = (change: Partial<CalRoute>) => dispatch({ type: 'navigate', route: { view: 'calendar', tab: r.tab, date: r.date, ...change } });
  const shift = (n: number) => go({ date: isoDay(addDays(date, n)) });
  const step = isWeek ? 7 : 1;

  const title = isWeek ? fmtWeek(days[0]!, days[days.length - 1]!) : fmtLongDate(date);
  const sub = isWeek
    ? `${plural(inRange.length, 'event')}${focusMin ? `, ${fmtDuration(focusMin)} blocked for focus` : ''}. Click an empty slot to add an event.`
    : `${plural(inRange.length, 'event')}.${next ? ` Next: ${next.title} at ${fmtClock(next.start)}.` : ''}`;

  const openEvent = (ev: WEvent) => {
    setCalUi({ selected: ev.id });
    setDetail(ev.id);
  };

  const grid = (
    <TimeGrid
      days={days}
      hourPx={isWeek ? 48 : 60}
      events={visible}
      selected={ui.selected}
      onEvent={openEvent}
      onSlot={(d, mins) => setCreating({ date: isoDay(d), time: `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}` })}
      onDay={(d) => dispatch({ type: 'navigate', route: { view: 'calendar', tab: 'day', date: isoDay(d) } })}
    />
  );

  return (
    <Frame
      tabs={[
        { id: 'week', label: 'Week' },
        { id: 'day', label: 'Day' },
      ]}
      active={r.tab}
      onTab={(id) => go({ tab: id as CalRoute['tab'] })}
      wide
      scrollKey={r.tab}
    >
      <h1 className="page-title">{title}</h1>
      <p className="page-sub">{sub}</p>

      <div className="filters cal-toolbar">
        <div className="cal-nav">
          <button className="icon-btn" aria-label={isWeek ? 'Previous week' : 'Previous day'} onClick={() => shift(-step)}>
            <ChevronLeft size={18} />
          </button>
          <button className="btn btn-sm" disabled={!r.date || sameDay(date, NOW)} onClick={() => go({ date: undefined })}>
            Today
          </button>
          <button className="icon-btn" aria-label={isWeek ? 'Next week' : 'Next day'} onClick={() => shift(step)}>
            <ChevronRight size={18} />
          </button>
        </div>
        {isWeek && (
          <button className="filter" aria-pressed={ui.weekend} onClick={() => setCalUi({ weekend: !ui.weekend })}>
            <CalendarDays size={14} />
            Weekend
          </button>
        )}
        <button className="btn btn-primary btn-sm cal-new" onClick={() => setCreating({ date: isoDay(date) })}>
          <Plus size={15} />
          New event
        </button>
      </div>

      {isWeek ? (
        grid
      ) : (
        <div className="cal-day-layout">
          {grid}
          <Unscheduled date={date} onBlock={setBlockFor} />
        </div>
      )}

      {detail && <EventDetail key={detail} id={detail} onClose={closeDetail} />}
      <EventDialog open={!!creating} onClose={closeCreate} draft={creating ?? undefined} />
      <BlockTimeDialog open={!!blockFor} onClose={closeBlock} title={blockFor?.title ?? ''} task={blockFor?.id} thread={blockFor?.thread} minutes={60} />
    </Frame>
  );
}

/* ───────────── Grid ───────────── */

interface Placed {
  ev: WEvent;
  lane: number;
  lanes: number;
}

/**
 * Side-by-side lanes for overlapping events. `minMs` is the shortest block the
 * grid draws, so a 15-minute event that is drawn taller still gets its own lane.
 */
function layout(events: WEvent[], minMs = 0): Placed[] {
  const endOf = (e: WEvent) => Math.max(e.end.getTime(), e.start.getTime() + minMs);
  const sorted = [...events].sort((a, b) => a.start.getTime() - b.start.getTime() || endOf(b) - endOf(a));
  const out: Placed[] = [];
  let cluster: Placed[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = 0;
  const flush = () => {
    for (const c of cluster) c.lanes = laneEnds.length;
    out.push(...cluster);
    cluster = [];
    laneEnds = [];
  };
  for (const ev of sorted) {
    if (cluster.length && ev.start.getTime() >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= ev.start.getTime());
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = endOf(ev);
    clusterEnd = cluster.length ? Math.max(clusterEnd, endOf(ev)) : endOf(ev);
    cluster.push({ ev, lane, lanes: 1 });
  }
  flush();
  return out;
}

function TimeGrid({
  days,
  hourPx,
  events,
  selected,
  onEvent,
  onSlot,
  onDay,
}: {
  days: Date[];
  hourPx: number;
  events: WEvent[];
  selected?: string;
  onEvent: (ev: WEvent) => void;
  onSlot: (day: Date, minutes: number) => void;
  onDay: (day: Date) => void;
}) {
  const hours = Array.from({ length: END_H - START_H }, (_, i) => START_H + i);
  const single = days.length === 1;
  const style = { '--cal-days': days.length, '--cal-hour': `${hourPx}px` } as CSSProperties;

  return (
    <div className={`cal-scroll${single ? ' single' : ''}`}>
      <div className="cal-grid" style={style}>
        <div className="cal-head">
          <span className="cal-gutter" />
          {days.map((d) => {
            const today = sameDay(d, NOW);
            const inner = (
              <>
                <span className="cal-dow">{d.toLocaleDateString('en-US', { weekday: single ? 'long' : 'short' })}</span>
                <span className="cal-dnum mono">{d.getDate()}</span>
              </>
            );
            return single ? (
              <div key={d.toISOString()} className="cal-dayhead" aria-current={today ? 'date' : undefined}>
                {inner}
              </div>
            ) : (
              <button key={d.toISOString()} className="cal-dayhead" aria-current={today ? 'date' : undefined} aria-label={`Open ${fmtLongDate(d)} in day view`} onClick={() => onDay(d)}>
                {inner}
              </button>
            );
          })}
        </div>
        <div className="cal-body">
          <div className="cal-hours" aria-hidden>
            {hours.map((h, i) => (
              <span key={h} className="cal-hour mono" style={{ top: i * hourPx }}>
                {hourLabel(h)}
              </span>
            ))}
          </div>
          {hours.slice(1).map((h, i) => (
            <span key={h} className="cal-line" style={{ top: (i + 1) * hourPx }} aria-hidden />
          ))}
          {days.map((d) => (
            <DayColumn
              key={d.toISOString()}
              compact={!single}
              day={d}
              hourPx={hourPx}
              events={events.filter((e) => sameDay(e.start, d))}
              selected={selected}
              onEvent={onEvent}
              onSlot={onSlot}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DayColumn({
  compact,
  day,
  hourPx,
  events,
  selected,
  onEvent,
  onSlot,
}: {
  compact: boolean;
  day: Date;
  hourPx: number;
  events: WEvent[];
  selected?: string;
  onEvent: (ev: WEvent) => void;
  onSlot: (day: Date, minutes: number) => void;
}) {
  const total = (END_H - START_H) * hourPx;
  const y = (d: Date) => Math.min(total, Math.max(0, ((minutesOf(d) - START_H * 60) / 60) * hourPx));
  const today = sameDay(day, NOW);
  const nowY = ((minutesOf(NOW) - START_H * 60) / 60) * hourPx;

  return (
    <div
      className="cal-col"
      data-today={today || undefined}
      title="Click an empty slot to add an event"
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const half = Math.floor(((e.clientY - rect.top) / hourPx) * 2);
        onSlot(day, Math.min(END_H * 60 - 30, START_H * 60 + half * 30));
      }}
    >
      {layout(events, (MIN_PX / hourPx) * 60 * MIN).map(({ ev, lane, lanes }) => {
        const top = y(ev.start);
        const height = Math.max(MIN_PX, y(ev.end) - top - 2);
        const short = height < 38;
        const tall = height >= 62;
        return (
          <button
            key={ev.id}
            className="cal-ev"
            data-kind={ev.kind}
            data-short={short || undefined}
            data-tall={tall || undefined}
            data-past={ev.end < NOW || undefined}
            aria-pressed={selected === ev.id}
            aria-label={`${ev.title}, ${fmtRange(ev.start, ev.end)}`}
            title={`${ev.title}, ${fmtRange(ev.start, ev.end)}`}
            style={{ top, height, left: `calc(${(lane * 100) / lanes}% + 3px)`, width: `calc(${100 / lanes}% - 6px)` }}
            onClick={() => onEvent(ev)}
          >
            <span className="cal-ev-title">{ev.title}</span>
            <span className="cal-ev-time mono">{short ? fmtShortTime(ev.start) : compact ? `${fmtShortTime(ev.start)} – ${fmtShortTime(ev.end)}` : fmtRange(ev.start, ev.end)}</span>
          </button>
        );
      })}
      {today && nowY >= 0 && nowY <= total && <span className="cal-now" style={{ top: nowY }} aria-hidden />}
    </div>
  );
}

/* ───────────── Day view: tasks without a time ───────────── */

function Unscheduled({ date, onBlock }: { date: Date; onBlock: (t: Task) => void }) {
  const { state } = useStore();
  const end = addDays(weekStart(date), 7);
  const tasks = openTasks(state.ws)
    .filter((t) => !t.event && t.due && t.due < end)
    .sort(byDue);

  return (
    <aside className="cal-aside" aria-labelledby="cal-unscheduled">
      <h2 className="section-title" id="cal-unscheduled">
        Due this week, not scheduled
      </h2>
      <p className="cal-aside-sub">A due date isn’t a plan. Give each one a time.</p>
      {tasks.length === 0 ? (
        <p className="cal-aside-empty">Every task due this week has time blocked.</p>
      ) : (
        <ul className="cal-due">
          {tasks.map((t) => {
            const p = t.project ? state.ws.projects[t.project] : undefined;
            return (
              <li key={t.id} className="cal-due-item">
                <span className="cal-due-title">{t.title}</span>
                <span className="cal-due-meta">
                  {t.due && <DueChip due={t.due} />}
                  {p && (
                    <span className="cal-due-project">
                      <Folder color={p.color} size={14} />
                      {p.name}
                    </span>
                  )}
                </span>
                <button className="btn btn-sm" onClick={() => onBlock(t)}>
                  <CalendarPlus size={14} />
                  Block time
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

/* ───────────── Sidebar ───────────── */

export function CalendarSide() {
  const { state, dispatch } = useStore();
  const r = state.route.view === 'calendar' ? state.route : null;
  const ui = useCalUi();
  const selected = r?.date ? parseIsoDay(r.date) : startOfDay(NOW);
  const [month, setMonth] = useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1));
  const [creating, setCreating] = useState(false);
  const closeCreate = useCallback(() => setCreating(false), []);

  const monday = weekStart(selected);
  const all = Object.values(state.ws.events);
  const thisWeek = all.filter((e) => e.start >= monday && e.start < addDays(monday, 7));
  const visible = all.filter((e) => !ui.hidden.includes(e.kind));

  const first = month;
  const offset = (first.getDay() + 6) % 7;
  const count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = [...Array.from({ length: offset }, () => null), ...Array.from({ length: count }, (_, i) => new Date(first.getFullYear(), first.getMonth(), i + 1))];

  const toggle = (k: (typeof KINDS)[number]['id']) =>
    setCalUi({ hidden: ui.hidden.includes(k) ? ui.hidden.filter((x) => x !== k) : [...ui.hidden, k] });

  return (
    <>
      <SideHead
        icon={<CalendarDays size={18} />}
        title="Calendar"
        sub={`${plural(thisWeek.length, 'event')} the week of ${monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
        action={
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Plus size={15} />
            New event
          </button>
        }
      />
      <div className="side-scroll">
        <div className="side-group">
          <div className="cal-mini-head">
            <h2 className="cal-mini-title">{first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</h2>
            <button className="icon-btn sm" aria-label="Previous month" onClick={() => setMonth(new Date(first.getFullYear(), first.getMonth() - 1, 1))}>
              <ChevronLeft size={16} />
            </button>
            <button className="icon-btn sm" aria-label="Next month" onClick={() => setMonth(new Date(first.getFullYear(), first.getMonth() + 1, 1))}>
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="cal-mini">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
              <span key={i} className="cal-mini-dow" aria-hidden>
                {d}
              </span>
            ))}
            {cells.map((d, i) => {
              if (!d) return <span key={`b${i}`} />;
              const n = visible.filter((e) => sameDay(e.start, d)).length;
              return (
                <button
                  key={d.getDate()}
                  className="cal-mini-day mono"
                  aria-current={sameDay(d, NOW) ? 'date' : undefined}
                  aria-pressed={!!r && sameDay(d, selected)}
                  aria-label={`${fmtLongDate(d)}${n ? `, ${plural(n, 'event')}` : ''}`}
                  onClick={() => dispatch({ type: 'navigate', route: { view: 'calendar', tab: 'day', date: isoDay(d) } })}
                >
                  {d.getDate()}
                  {n > 0 && <span className="cal-mini-dot" aria-hidden />}
                </button>
              );
            })}
          </div>
        </div>

        <div className="side-group">
          <div className="side-title">Calendars</div>
          {KINDS.map((k) => {
            const on = !ui.hidden.includes(k.id);
            const n = thisWeek.filter((e) => e.kind === k.id).length;
            return (
              <button key={k.id} className="nav-item compact cal-kind" role="switch" aria-checked={on} style={tint(k.color)} onClick={() => toggle(k.id)}>
                <span className="dot" />
                <span className="nav-name">
                  {k.plural}
                  <span className="cal-kind-count mono">{n}</span>
                </span>
                <span className="switch" aria-hidden />
              </button>
            );
          })}
          <p className="nav-hint cal-kind-hint">Hidden calendars stay out of the grid but still block time.</p>
        </div>
      </div>
      <EventDialog open={creating} onClose={closeCreate} draft={{ date: r?.date ?? isoDay(NOW) }} />
    </>
  );
}

/* ───────────── Context panel ───────────── */

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rp-section">
      <header className="rp-head">
        <h2 className="rp-title">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function CalendarContext() {
  const { state, dispatch } = useStore();
  const ui = useCalUi();
  const picked = ui.selected ? state.ws.events[ui.selected] : undefined;
  const ev = picked ?? nextPrepEvent(state.ws);
  const upcoming = Object.values(state.ws.events)
    .filter((e) => e.end > NOW && e.kind !== 'personal')
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, 5);
  const monday = weekStart(NOW);
  const focusMin = Object.values(state.ws.events)
    .filter((e) => e.kind === 'focus' && e.start >= monday && e.start < addDays(monday, 7))
    .reduce((n, e) => n + Math.round((e.end.getTime() - e.start.getTime()) / MIN), 0);
  const unscheduled = openTasks(state.ws).filter((t) => !t.event && t.due && t.due < addDays(monday, 7)).length;

  return (
    <>
      {ev && (
        <Section
          title={picked ? 'Selected event' : 'Prep for your next meeting'}
          aside={
            picked ? (
              <button className="rp-link" onClick={() => setCalUi({ selected: undefined })}>
                Show next
              </button>
            ) : undefined
          }
        >
          <Prep ev={ev} />
        </Section>
      )}

      {ev?.notesDoc && state.ws.docs[ev.notesDoc] && (
        <Section title={`Agenda for ${rowLabel(ev)}`}>
          <TopicForm key={ev.id} ev={ev} />
        </Section>
      )}

      <Section title="Coming up">
        <ul className="rp-list cal-upcoming">
          {upcoming.map((e) => (
            <li key={e.id}>
              <button className="rp-person" aria-pressed={ev?.id === e.id} onClick={() => setCalUi({ selected: e.id })}>
                <span className="cal-up-dot dot" style={tint(KINDS.find((k) => k.id === e.kind)!.color)} />
                <span className="rp-person-text">
                  <span className="rp-person-name">{e.title}</span>
                  <span className="rp-person-sub">
                    {sameDay(e.start, NOW) ? 'Today' : fmtDay(e.start)}, {fmtRange(e.start, e.end)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="This week">
        <p className="rp-text">
          {focusMin ? `${fmtDuration(focusMin)} blocked for focus.` : 'No focus time blocked yet.'}{' '}
          {unscheduled ? `${plural(unscheduled, 'task')} due this week still ${unscheduled === 1 ? 'has' : 'have'} no time.` : 'Every task due this week has time.'}
        </p>
        {unscheduled > 0 && (
          <button className="btn btn-sm cal-rp-btn" onClick={() => dispatch({ type: 'navigate', route: { view: 'calendar', tab: 'day', date: isoDay(NOW) } })}>
            <CalendarPlus size={14} />
            Plan them in day view
          </button>
        )}
      </Section>
    </>
  );
}

function Prep({ ev }: { ev: WEvent }) {
  const { state, dispatch } = useStore();
  const files = (ev.docs ?? []).map((d) => state.ws.files[d]).filter((f): f is NonNullable<typeof f> => !!f);
  const notes = ev.notesDoc ? state.ws.files[ev.notesDoc] : undefined;
  const thread = ev.thread ? state.threads.find((t) => t.id === ev.thread) : undefined;

  return (
    <div className="rp-card">
      <div className="rp-card-head">
        <CalendarClock size={15} />
        <strong>{ev.title}</strong>
      </div>
      <p className="cal-prep-when">
        {sameDay(ev.start, NOW) ? 'Today' : fmtDay(ev.start)}, {fmtRange(ev.start, ev.end)}
      </p>
      {ev.with.length > 0 && (
        <div className="cal-prep-people">
          {ev.with.map((p) => (
            <span key={p} className="cal-prep-person">
              <Avatar id={p} size={22} />
              {firstName(p)}
            </span>
          ))}
        </div>
      )}
      {ev.note && (
        <p className="timmy-line cal-prep-note">
          <Sparkles size={13} />
          {ev.note}
        </p>
      )}
      {(files.length > 0 || notes || thread) && (
        <ul className="cal-prep-links">
          {notes && (
            <li>
              <button className="cal-prep-link" onClick={() => dispatch({ type: 'navigate', route: { view: 'file', id: notes.id } })}>
                <FileText size={15} aria-hidden />
                <span>{notes.name}</span>
              </button>
            </li>
          )}
          {files.map((f) => (
            <li key={f.id}>
              <button className="cal-prep-link" onClick={() => dispatch({ type: 'navigate', route: { view: 'file', id: f.id } })}>
                <DocIcon kind={f.kind} size={15} />
                <span>{f.name}</span>
              </button>
            </li>
          ))}
          {thread && (
            <li>
              <button className="cal-prep-link" onClick={() => dispatch({ type: 'openThread', id: thread.id })}>
                <Mail size={15} aria-hidden />
                <span>{thread.subject}</span>
              </button>
            </li>
          )}
        </ul>
      )}
      <button className="btn btn-sm cal-rp-btn" onClick={() => setCalUi({ selected: ev.id, open: ev.id })}>
        Show details
      </button>
    </div>
  );
}

function TopicForm({ ev }: { ev: WEvent }) {
  const { state, dispatch } = useStore();
  const [text, setText] = useState('');
  const doc = state.ws.docs[ev.notesDoc!]!;
  const file = state.ws.files[ev.notesDoc!];
  const label = rowLabel(ev);
  const topics = topicsFor(doc, label);

  const add = () => {
    const topic = text.trim();
    if (!topic) return;
    dispatch(
      ws([patch('docs', doc.id, { blocks: withTopic(doc, label, topic) }), patch('files', doc.id, { updated: NOW })], {
        toast: `Added to ${file?.name ?? 'the running notes'}`,
        undo: true,
      }),
    );
    setText('');
  };

  return (
    <>
      {topics.length > 0 ? (
        <ul className="cal-topics">
          {topics.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      ) : (
        <p className="rp-text">No topics for {label} yet.</p>
      )}
      <form
        className="cal-topic-form"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a topic to the running notes" aria-label="Add a topic to the running notes" />
        <button className="btn btn-sm" type="submit" disabled={!text.trim()}>
          Add
        </button>
      </form>
      {file && (
        <p className="rp-note">
          <FileText size={13} />
          <span>
            Saved in{' '}
            <button className="rp-link" onClick={() => dispatch({ type: 'navigate', route: { view: 'file', id: file.id } })}>
              {file.name}
            </button>
          </span>
        </p>
      )}
    </>
  );
}
