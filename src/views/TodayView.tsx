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
  Target,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { DOCS, EVENTS, NOW, PEOPLE } from '../data/mock';
import type { Box, Thread } from '../data/types';
import { dayDiff, dueInfo, fmtDate, fmtLongDate, fmtShortTime, fmtTime, plural } from '../lib/format';
import { boxTag, byOldest, inBox, labelOf, useStore, type TodayTab } from '../state/store';
import { Avatar, EffortChip, Kbd, TimmyMark, tint } from '../components/common';
import { DocIcon } from '../components/DocBits';
import { Frame } from '../components/Frame';

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
  const owe = inBox(state.threads, 'follow-up');
  const waiting = inBox(state.threads, 'waiting');
  const quick = owe.filter((t) => t.effort === 'quick').length;
  const triage = inBox(state.threads, 'inbox');

  return (
    <>
      <p className="eyebrow">{fmtLongDate(NOW)}</p>
      <h1 className="page-title" style={{ marginTop: 4 }}>
        Good morning, Taylor.
      </h1>
      <p className="page-sub">
        Timmy sorted 31 new emails overnight. {owe.length > 0 ? `${plural(owe.length, 'thing')} need you` : 'Nothing needs you'}
        {quick > 0 ? ` — ${quick} are quick replies.` : '.'}
      </p>

      <Highlight />

      <div className="tri-grid">
        <OweCard threads={owe} />
        <WaitingCard threads={waiting} />
        <CalendarCard />
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Overnight triage</h2>
          <span className="section-sub">6:00 PM – 7:02 AM</span>
        </div>
        <div className="card card-pad triage-summary">
          <p>
            Timmy archived <strong>24 emails</strong> that matched your rules — receipts, calendar replies and newsletters — and saved 3 attachments
            to Drive with dated names. {triage.length > 0 ? (
              <>
                It left <strong>{plural(triage.length, 'email')}</strong> for you to confirm, oldest first.
              </>
            ) : (
              <>You’ve confirmed everything else. Inbox zero.</>
            )}
          </p>
          <div className="flow">
            <FlowStep color="var(--c-brown)" icon={<Archive size={14} />} n={24} label="Archived" />
            <FlowStep color="var(--c-red)" icon={<Reply size={14} />} n={4} label="Follow Up" />
            <FlowStep color="var(--c-amber)" icon={<Hourglass size={14} />} n={1} label="Waiting" />
            <FlowStep color="var(--c-sky)" icon={<BookOpen size={14} />} n={1} label="Read Through" />
            <FlowStep color="var(--c-slate)" icon={<Sparkles size={14} />} n={triage.length} label="Your call" />
          </div>
          {triage.length > 0 && (
            <button className="btn btn-sm" onClick={() => dispatch({ type: 'navigate', route: { view: 'today', tab: 'triage' } })}>
              Review {triage.length} in triage
              <ArrowRight size={14} />
            </button>
          )}
        </div>
      </section>

      <Suggestions />
    </>
  );
}

function FlowStep({ color, icon, n, label }: { color: string; icon: ReactNode; n: number; label: string }) {
  return (
    <div className="flow-step" style={tint(color)}>
      <span className="nav-icon" style={{ width: 26, height: 26, borderRadius: 7 }}>
        {icon}
      </span>
      <span className="mono flow-n">{n}</span>
      <span className="flow-label">{label}</span>
    </div>
  );
}

function Highlight() {
  const { state, dispatch } = useStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(state.highlight);
  const focus = EVENTS.find((e) => e.focus);

  return (
    <div className={`highlight${state.highlightDone ? ' done' : ''}`}>
      <span className="highlight-icon">
        <Target size={18} />
      </span>
      <div className="highlight-body">
        <span className="eyebrow">Today’s highlight</span>
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
        {focus && !editing && (
          <span className="muted" style={{ fontSize: 12.5 }}>
            Focus block {fmtTime(focus.start)} – {fmtTime(focus.end)} · suggested by Timmy from your Follow Up list
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
  const sorted = [...threads].sort((a, b) => (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity));
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
  const { dispatch } = useStore();
  const startH = 8;
  const endH = 18;
  const pct = (d: Date) => ((d.getHours() + d.getMinutes() / 60 - startH) / (endH - startH)) * 100;
  const upcoming = EVENTS.filter((e) => e.end > NOW).slice(0, 3);

  return (
    <article className="card tri-card">
      <CardHead
        icon={<CalendarDays size={16} />}
        color="var(--c-green)"
        title="Today’s calendar"
        count={EVENTS.length}
        to={() => dispatch({ type: 'drawer', drawer: 'right' })}
      />
      <div className="daystrip" aria-label="Day overview, 8 AM to 6 PM">
        {EVENTS.map((e) => (
          <span
            key={e.id}
            className={`daystrip-ev${e.focus ? ' focus' : ''}`}
            style={{ left: `${pct(e.start)}%`, width: `${Math.max(pct(e.end) - pct(e.start), 1.6)}%` }}
            title={`${e.title} · ${fmtTime(e.start)}`}
          />
        ))}
        <span className="daystrip-now" style={{ left: `${pct(NOW)}%` }} />
        <div className="daystrip-ticks mono">
          <span>8</span>
          <span>10</span>
          <span>12</span>
          <span>2</span>
          <span>4</span>
          <span>6</span>
        </div>
      </div>
      <ul className="tc-list">
        {upcoming.map((e) => (
          <li key={e.id}>
            <button onClick={() => e.threadId && dispatch({ type: 'openThread', id: e.threadId })}>
              <span className="mono tc-time">{fmtShortTime(e.start)}</span>
              <span className="tc-lines">
                <span className="tc-item">{e.title}</span>
                <span className="tc-sub">
                  {e.focus ? 'Focus block · Timmy' : e.with.map((x) => PEOPLE[x]!.name.split(' ')[0]).join(', ')}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </article>
  );
}

// ───────────── Suggestions (Timmy's proposed next steps) ─────────────

interface Sug {
  key: string;
  text: ReactNode;
  sources?: string[];
  primary: { label: string; icon?: ReactNode; run: () => void };
  secondary?: { label: string; run: () => void };
}

function Suggestions() {
  const { state, dispatch } = useStore();
  const t = (id: string) => state.threads.find((x) => x.id === id)!;
  const open = (id: string) => () => dispatch({ type: 'openThread', id });

  const all: Sug[] = [];
  const acme = t('acme-quote');
  if (acme.draft && acme.box === 'follow-up')
    all.push({
      key: 'acme',
      text: (
        <>
          <strong>Dana</strong> asked for a revised quote for 120 seats by Tuesday. I copied proposal v3 to v4 with the 101–250 tier price and drafted a
          reply that asks for her CFO’s approval by Friday.
        </>
      ),
      sources: acme.draft.sources,
      primary: { label: 'Review draft', icon: <FilePenLine size={14} />, run: open('acme-quote') },
    });
  const sow = t('northwind-sow');
  if (sow.draft && sow.box === 'waiting')
    all.push({
      key: 'sow',
      text: (
        <>
          <strong>Marcus</strong> said he’d send the signed SOW on Friday. It’s 3 days late, and you meet him at 10:30. I drafted a short nudge — or
          ask him in person.
        </>
      ),
      sources: sow.draft.sources,
      primary: { label: 'Review nudge', icon: <FilePenLine size={14} />, run: open('northwind-sow') },
    });
  const bw = state.deals.brightwave!;
  if (bw.stage !== 'Closed won')
    all.push({
      key: 'brightwave',
      text: (
        <>
          <strong>Elena</strong> sent the countersigned Brightwave order form. Move the deal to <strong>Closed won</strong> ($36,000) and link the signed
          form?
        </>
      ),
      primary: { label: 'Update CRM', icon: <Check size={14} />, run: () => dispatch({ type: 'applyDeal', id: 'brightwave' }) },
      secondary: { label: 'Open email', run: open('brightwave-signed') },
    });
  const travel = t('travel-budget');
  if (travel.box === 'waiting')
    all.push({
      key: 'travel',
      text: (
        <>
          <strong>Priya</strong> hasn’t replied about the travel budget in 6 days. I added it to the agenda for your 3:00 PM 1:1.
        </>
      ),
      sources: ['priya-1on1'],
      primary: { label: 'Open thread', run: open('travel-budget') },
    });

  const shown = all.filter((s) => !state.dismissed.includes(s.key));

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">Timmy suggests</h2>
        <span className="section-sub">{shown.length ? `${shown.length} ready for you` : 'All caught up'}</span>
      </div>
      <div className="sug-list">
        {shown.map((s) => (
          <article key={s.key} className="card sug">
            <TimmyMark size={30} />
            <div className="sug-body">
              <p>{s.text}</p>
              {s.sources && (
                <div className="chips" style={{ marginTop: 8 }}>
                  {s.sources.map((id) => (
                    <span key={id} className="chip">
                      <DocIcon kind={DOCS[id]!.kind} size={12} />
                      {DOCS[id]!.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="sug-actions">
              <button className="btn btn-sm btn-primary" onClick={s.primary.run}>
                {s.primary.icon}
                {s.primary.label}
              </button>
              {s.secondary ? (
                <button className="btn btn-sm btn-ghost" onClick={s.secondary.run}>
                  {s.secondary.label}
                </button>
              ) : (
                <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'dismiss', key: s.key })}>
                  Not now
                </button>
              )}
            </div>
          </article>
        ))}
        {shown.length === 0 && (
          <div className="card empty">
            <span className="empty-icon">
              <CheckCheck size={20} />
            </span>
            <strong>Nothing waiting on a decision</strong>
            <span>Timmy will suggest next steps as new mail arrives.</span>
          </div>
        )}
      </div>
    </section>
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
  const { dispatch } = useStore();
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
              <h3 className="draft-card-subject">{d.subject}</h3>
              <div className="draft-card-body">
                {lines.map((l, i) => (
                  <p key={i}>{l}</p>
                ))}
              </div>
              <div className="chips">
                {d.sources.map((id) => (
                  <span key={id} className="chip">
                    <DocIcon kind={DOCS[id]!.kind} size={12} />
                    {DOCS[id]!.name.replace(/^\d{4}(-Q\d|-\d{2}-\d{2})? ?/, '')}
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
