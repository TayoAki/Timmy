import {
  ArrowUpRight,
  BadgeDollarSign,
  CalendarClock,
  Check,
  CircleCheck,
  Eye,
  Hourglass,
  Lightbulb,
  Sparkles,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { ACTIVITY, BOXES, DOCS, EVENTS, LABEL_GUIDE, NOW, PEOPLE, PROJECTS, RELATIONSHIPS } from '../data/mock';
import type { Thread } from '../data/types';
import { daysSince, fmtDay, fmtShortTime, fmtStamp, fmtTime, money } from '../lib/format';
import { inBox, useStore } from '../state/store';
import { Avatar, DueChip, Folder, TimmyMark, tint } from './common';
import { DocIcon, DocPath, DocThumb } from './DocBits';

export function RightPanel() {
  const { state, dispatch } = useStore();
  const r = state.route;

  let body: ReactNode;
  if (r.view === 'thread') {
    const t = state.threads.find((x) => x.id === r.id);
    body = t ? <ThreadContext t={t} /> : null;
  } else if (r.view === 'box') {
    body = <LabelContext id={r.box} />;
  } else if (r.view === 'people') {
    body = <PersonContext id={r.person ?? 'dana'} />;
  } else if (r.view === 'files') {
    body = <FilesContext />;
  } else if (r.view === 'rules') {
    body = <RulesContext />;
  } else if (r.view === 'activity') {
    body = <ActivityContext />;
  } else {
    body = <TodayContext />;
  }

  return (
    <aside className="right" aria-label="Context">
      <button className="icon-btn sm right-close" aria-label="Close panel" onClick={() => dispatch({ type: 'drawer', drawer: 'right' })}>
        <X size={16} />
      </button>
      {body}
    </aside>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rp-section">
      <header className="rp-head">
        <h3 className="rp-title">{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

// ───────────── Today ─────────────

function TodayContext() {
  const { state, dispatch } = useStore();
  const prep = EVENTS.find((e) => e.start > NOW && e.note && e.with.length > 0);
  const waitingSoon = inBox(state.threads, 'waiting')
    .filter((t) => t.waiting?.due)
    .sort((a, b) => a.waiting!.due!.getTime() - b.waiting!.due!.getTime())
    .slice(0, 3);

  return (
    <>
      <Section title="Today’s calendar" aside={<span className="rp-aside">{fmtDay(NOW)}</span>}>
        <ol className="agenda">
          {EVENTS.map((e) => {
            const past = e.end < NOW;
            return (
              <li key={e.id} className={`agenda-item${e.focus ? ' focus' : ''}${past ? ' past' : ''}`}>
                <span className="agenda-time mono">{fmtShortTime(e.start)}</span>
                <button
                  className="agenda-block"
                  onClick={() => e.threadId && dispatch({ type: 'openThread', id: e.threadId })}
                  disabled={!e.threadId}
                >
                  <span className="agenda-title">{e.title}</span>
                  <span className="agenda-sub">
                    {fmtTime(e.start)} – {fmtTime(e.end)}
                    {e.with.length > 0 && ` · ${e.with.map((p) => PEOPLE[p]!.name.split(' ')[0]).join(', ')}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </Section>

      {prep && (
        <Section title="Prep for your next meeting">
          <div className="rp-card">
            <div className="rp-card-head">
              <CalendarClock size={15} />
              <strong>{prep.title}</strong>
              <span className="muted">{fmtTime(prep.start)}</span>
            </div>
            <p className="timmy-line" style={{ fontSize: 13 }}>
              <Sparkles size={13} />
              {prep.note}
            </p>
            {prep.docs?.map((id) => (
              <div key={id} className="file-line">
                <DocIcon kind={DOCS[id]!.kind} size={15} />
                <span>{DOCS[id]!.name}</span>
              </div>
            ))}
            {prep.threadId && (
              <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => dispatch({ type: 'openThread', id: prep.threadId! })}>
                Open thread
              </button>
            )}
          </div>
        </Section>
      )}

      <Section title="Promised to you next">
        <ul className="rp-list">
          {waitingSoon.map((t) => (
            <li key={t.id}>
              <button className="rp-person" onClick={() => dispatch({ type: 'openThread', id: t.id })}>
                <Avatar id={t.waiting!.on} size={28} />
                <span className="rp-person-text">
                  <span className="rp-person-name">{t.waiting!.item}</span>
                  <span className="rp-person-sub">{PEOPLE[t.waiting!.on]!.name}</span>
                </span>
                <DueChip due={t.waiting!.due!} />
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

// ───────────── Thread ─────────────

function ThreadContext({ t }: { t: Thread }) {
  const { state, dispatch } = useStore();
  const deal = t.deal ? state.deals[t.deal] : undefined;
  const primary = t.docs?.[0] ? DOCS[t.docs[0]] : undefined;
  const others = t.participants.filter((p) => p !== 'me');
  const done = t.steps?.filter((s) => s.done).length ?? 0;

  return (
    <>
      {t.waiting && t.box === 'waiting' && (
        <Section title="Waiting on">
          <div className="rp-card waiting-card">
            <div className="rp-person" style={{ padding: 0 }}>
              <Avatar id={t.waiting.on} size={32} />
              <span className="rp-person-text">
                <span className="rp-person-name">{t.waiting.item}</span>
                <span className="rp-person-sub">from {PEOPLE[t.waiting.on]!.name}</span>
              </span>
            </div>
            <dl className="kv">
              <dt>Asked</dt>
              <dd>
                {fmtDay(t.waiting.since)} · {daysSince(t.waiting.since)}d ago
              </dd>
              <dt>Promised</dt>
              <dd>{t.waiting.due ? <DueChip due={t.waiting.due} /> : <span className="muted">No date given</span>}</dd>
            </dl>
            <p className="rp-note">
              <Hourglass size={13} />
              Stays in Waiting until the item itself arrives.
            </p>
          </div>
        </Section>
      )}

      {t.steps && t.steps.length > 0 && (
        <Section title="Next actions" aside={<span className="rp-aside mono">{done}/{t.steps.length}</span>}>
          <ul className="steps">
            {t.steps.map((s) => (
              <li key={s.id}>
                <button
                  className={`step${s.done ? ' done' : ''}`}
                  onClick={() => dispatch({ type: 'toggleStep', id: t.id, step: s.id })}
                  aria-pressed={s.done}
                >
                  <span className="step-box">{s.done && <Check size={12} strokeWidth={3} />}</span>
                  <span className="step-text">{s.text}</span>
                  {s.byTimmy && <span className="step-by">Timmy</span>}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {primary && (
        <Section title="Linked file" aside={t.docs!.length > 1 ? <button className="rp-link" onClick={() => dispatch({ type: 'openThread', id: t.id, tab: 'links' })}>All {t.docs!.length}</button> : undefined}>
          <div className="rp-card file-card">
            <DocThumb doc={primary} />
            <div className="file-meta">
              <div className="file-name">
                <DocIcon kind={primary.kind} size={15} />
                <span>{primary.name}</span>
              </div>
              <DocPath path={primary.path} />
              <span className="muted" style={{ fontSize: 12 }}>
                {primary.createdByTimmy ? 'Created by Timmy · ' : ''}Edited {fmtStamp(primary.updated)}
              </span>
            </div>
            <div className="file-actions">
              <button className="btn btn-sm">
                <ArrowUpRight size={14} />
                Open
              </button>
              <button className="btn btn-sm btn-ghost">
                <Eye size={14} />
                Preview
              </button>
            </div>
          </div>
        </Section>
      )}

      {deal && (
        <Section title="CRM record">
          <div className="rp-card">
            <div className="deal-head">
              <span className="deal-logo" style={tint('var(--c-green)')}>
                {deal.company[0]}
              </span>
              <div>
                <strong>{deal.company}</strong>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {deal.name}
                </div>
              </div>
              <span className={`stage${deal.stage === 'Closed won' ? ' won' : ''}`}>{deal.stage}</span>
            </div>
            <dl className="kv">
              <dt>Value</dt>
              <dd className="mono">{money(deal.value)}</dd>
              <dt>Last touch</dt>
              <dd>{deal.lastTouch}</dd>
              <dt>Next step</dt>
              <dd>
                {deal.next}
                <span className="muted"> · {deal.owner === 'me' ? 'You' : PEOPLE[deal.owner]!.name.split(' ')[0]}</span>
              </dd>
              {deal.due && (
                <>
                  <dt>Due</dt>
                  <dd>
                    <DueChip due={deal.due} />
                  </dd>
                </>
              )}
            </dl>
            {deal.suggestion && (
              <div className="suggest">
                <Lightbulb size={14} />
                <span>{deal.suggestion}</span>
                <button className="btn btn-xs" onClick={() => dispatch({ type: 'applyDeal', id: deal.id })}>
                  Apply
                </button>
              </div>
            )}
          </div>
        </Section>
      )}

      <Section title="People on this thread">
        <ul className="rp-list">
          {others.map((id) => {
            const p = PEOPLE[id]!;
            const rel = RELATIONSHIPS.find((x) => x.person === id);
            return (
              <li key={id}>
                <button
                  className="rp-person"
                  onClick={() => !p.bot && dispatch({ type: 'navigate', route: { view: 'people', tab: 'priority', person: id } })}
                >
                  <Avatar id={id} size={30} />
                  <span className="rp-person-text">
                    <span className="rp-person-name">{p.name}</span>
                    <span className="rp-person-sub">{[p.title, p.company].filter(Boolean).join(' · ') || p.email}</span>
                  </span>
                  {rel?.priority && <span className="chip accent">Priority</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </Section>
    </>
  );
}

// ───────────── Label / project ─────────────

function LabelContext({ id }: { id: string }) {
  const { state, dispatch } = useStore();
  const guide = LABEL_GUIDE[id];
  const box = BOXES.find((b) => b.id === id);

  if (guide && box) {
    const count = inBox(state.threads, box.id).length;
    return (
      <>
        <div className="rp-hero" style={tint(box.color)}>
          <Folder color={box.color} size={36} />
          <div>
            <div className="mono muted" style={{ fontSize: 12 }}>
              [{box.num}]
            </div>
            <h2 className="rp-hero-title">{box.name}</h2>
          </div>
        </div>
        <Section title={guide.title}>
          <p className="rp-text">{guide.body}</p>
        </Section>
        <Section title="Timmy’s rule">
          <div className="rp-card rule-quote">
            <TimmyMark size={22} muted />
            <p>{guide.rule}</p>
          </div>
          <button className="rp-link" style={{ marginTop: 10 }} onClick={() => dispatch({ type: 'navigate', route: { view: 'rules', tab: 'triage' } })}>
            Edit triage rules
          </button>
        </Section>
        <Section title="In this label">
          <div className="stat-row">
            <div className="stat">
              <span className="stat-num mono">{id === 'archived' ? '2.4k' : count}</span>
              <span className="stat-label">threads</span>
            </div>
            <div className="stat">
              <span className="stat-num mono">{state.threads.filter((t) => t.box === id && t.draft).length}</span>
              <span className="stat-label">drafts ready</span>
            </div>
            <div className="stat">
              <span className="stat-num mono">
                {state.threads.filter((t) => t.box === id && ((t.box === 'waiting' ? t.waiting?.due : t.due)?.getTime() ?? Infinity) < NOW.getTime()).length}
              </span>
              <span className="stat-label">overdue</span>
            </div>
          </div>
        </Section>
      </>
    );
  }

  const project = PROJECTS.find((p) => p.id === id)!;
  const threads = state.threads.filter((t) => t.project === id);
  const docs = [...new Set(threads.flatMap((t) => t.docs ?? []))].map((d) => DOCS[d]!);
  const dealId = threads.find((t) => t.deal)?.deal;
  const deal = dealId ? state.deals[dealId] : undefined;
  return (
    <>
      <div className="rp-hero" style={tint(project.color)}>
        <Folder color={project.color} size={36} />
        <div>
          <div className="mono muted" style={{ fontSize: 12 }}>
            [{project.num}] · {project.hint}
          </div>
          <h2 className="rp-hero-title">{project.name}</h2>
        </div>
      </div>
      {deal && (
        <Section title="Deal">
          <div className="rp-card">
            <div className="deal-head">
              <BadgeDollarSign size={18} className="muted" />
              <div>
                <strong className="mono">{money(deal.value)}</strong>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {deal.name}
                </div>
              </div>
              <span className="stage">{deal.stage}</span>
            </div>
          </div>
        </Section>
      )}
      <Section title="Files for this project" aside={<span className="rp-aside mono">{docs.length}</span>}>
        <ul className="rp-list">
          {docs.map((d) => (
            <li key={d.id} className="file-line">
              <DocIcon kind={d.kind} size={15} />
              <span>{d.name}</span>
            </li>
          ))}
        </ul>
        <p className="rp-note">
          <Lightbulb size={13} />
          Files live where you use them: [02] Work › {project.name.split(' ')[0]}.
        </p>
      </Section>
    </>
  );
}

// ───────────── People ─────────────

function PersonContext({ id }: { id: string }) {
  const { state, dispatch } = useStore();
  const p = PEOPLE[id]!;
  const rel = RELATIONSHIPS.find((x) => x.person === id);
  const deal = rel?.deal ? state.deals[rel.deal] : undefined;
  const threads = state.threads.filter((t) => t.participants.includes(id) && t.box !== 'archived');

  return (
    <>
      <div className="person-hero">
        <Avatar id={id} size={56} />
        <h2 className="rp-hero-title">{p.name}</h2>
        <p className="muted">
          {p.title} · {p.company}
        </p>
        <p className="mono muted" style={{ fontSize: 12 }}>
          {p.email}
        </p>
      </div>
      {rel && (
        <Section title="Relationship">
          <div className="rp-card">
            <dl className="kv">
              <dt>Cadence</dt>
              <dd>{rel.cadence}</dd>
              <dt>Last</dt>
              <dd>{rel.last}</dd>
              <dt>Next</dt>
              <dd>
                {rel.next}
                <span className="muted"> · {rel.owner === 'me' ? 'You' : PEOPLE[rel.owner]!.name.split(' ')[0]}</span>
              </dd>
              {rel.due && (
                <>
                  <dt>Due</dt>
                  <dd>
                    <DueChip due={rel.due} />
                  </dd>
                </>
              )}
            </dl>
          </div>
        </Section>
      )}
      {deal && (
        <Section title="Deal">
          <div className="rp-card">
            <div className="deal-head">
              <span className="deal-logo" style={tint('var(--c-green)')}>
                {deal.company[0]}
              </span>
              <div>
                <strong>{deal.company}</strong>
                <div className="muted mono" style={{ fontSize: 12.5 }}>
                  {money(deal.value)}
                </div>
              </div>
              <span className={`stage${deal.stage === 'Closed won' ? ' won' : ''}`}>{deal.stage}</span>
            </div>
            {deal.suggestion && (
              <div className="suggest">
                <Lightbulb size={14} />
                <span>{deal.suggestion}</span>
                <button className="btn btn-xs" onClick={() => dispatch({ type: 'applyDeal', id: deal.id })}>
                  Apply
                </button>
              </div>
            )}
          </div>
        </Section>
      )}
      <Section title="Open threads" aside={<span className="rp-aside mono">{threads.length}</span>}>
        <ul className="rp-list">
          {threads.map((t) => (
            <li key={t.id}>
              <button className="rp-thread" onClick={() => dispatch({ type: 'openThread', id: t.id })}>
                <span className="dot" style={tint(BOXES.find((b) => b.id === t.box)!.color)} />
                <span>{t.subject}</span>
              </button>
            </li>
          ))}
          {threads.length === 0 && <li className="muted">Nothing open.</li>}
        </ul>
      </Section>
    </>
  );
}

// ───────────── Files ─────────────

function FilesContext() {
  const examples = [
    { name: '2026 Budget — Working sheet', why: 'Year only: easy to search for' },
    { name: '2026-Q4 QBR — Briefing slides', why: 'Quarter for period files' },
    { name: '2026-11 Monthly review — Slides', why: 'Month for recurring files' },
    { name: '2026-11-13 Acme — Call notes', why: 'Full date when you know the folder' },
  ];
  return (
    <>
      <Section title="How Timmy names files">
        <p className="rp-text">
          Saved attachments get a date at the granularity they need, the project, then a keyword: <em>Doc</em>, <em>Meeting notes</em>,{' '}
          <em>Working sheet</em>, <em>Briefing slides</em> or <em>Form</em>.
        </p>
        <ul className="naming">
          {examples.map((e) => (
            <li key={e.name}>
              <code>{e.name}</code>
              <span>{e.why}</span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Folder rules">
        <ul className="rp-bullets">
          <li>At most 5 levels deep. The 6th level holds files only.</li>
          <li>Up to 99 folders per level, numbered so the ones you use most sort first.</li>
          <li>[99] is always the archive.</li>
          <li>File by where you’ll use it, not where it came from.</li>
        </ul>
      </Section>
    </>
  );
}

// ───────────── Rules ─────────────

function RulesContext() {
  const corrections = [
    { text: 'You changed “Hi Dana!” to “Hi Dana,”', rule: 'No exclamation marks in customer emails' },
    { text: 'You moved a Ramp notification from Follow Up to Archive', rule: 'Archive notifications' },
    { text: 'You shortened a reply to Marcus by 40%', rule: 'Keep replies to Marcus brief' },
  ];
  return (
    <>
      <Section title="How Timmy learns">
        <p className="rp-text">
          Rules are written in plain language. When you edit a draft or re-sort an email, Timmy proposes a rule change instead of guessing.
        </p>
      </Section>
      <Section title="Recent corrections">
        <ul className="rp-list">
          {corrections.map((c) => (
            <li key={c.text} className="correction">
              <CircleCheck size={15} />
              <div>
                <div>{c.text}</div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  Learned: {c.rule}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

// ───────────── Activity ─────────────

function ActivityContext() {
  const { state } = useStore();
  const today = state.activity.filter((a) => a.at.getDate() === NOW.getDate());
  const counts = {
    sorted: today.filter((a) => a.kind === 'triage' || a.kind === 'move').length + 30,
    drafted: today.filter((a) => a.kind === 'draft').length + 3,
    filed: today.filter((a) => a.kind === 'file').length,
  };
  return (
    <>
      <Section title="This morning">
        <div className="stat-row">
          <div className="stat">
            <span className="stat-num mono">{counts.sorted}</span>
            <span className="stat-label">sorted</span>
          </div>
          <div className="stat">
            <span className="stat-num mono">{counts.drafted}</span>
            <span className="stat-label">drafted</span>
          </div>
          <div className="stat">
            <span className="stat-num mono">{counts.filed}</span>
            <span className="stat-label">files saved</span>
          </div>
        </div>
      </Section>
      <Section title="Time saved this week">
        <div className="rp-card">
          <span className="stat-num mono" style={{ fontSize: 28 }}>
            3h 40m
          </span>
          <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            Estimated from {ACTIVITY.length * 9} sorted emails and 14 drafts you sent with light edits.
          </p>
        </div>
      </Section>
      <Section title="Undo">
        <p className="rp-text">Anything Timmy did can be undone from the log for 7 days. Undo also updates the rule that caused it.</p>
      </Section>
    </>
  );
}

