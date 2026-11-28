import { isLive } from '../live/clock';
import { InvoicesContext } from '../areas/invoices';
import { BidsContext } from '../areas/bids';
import {
  ArrowUpRight,
  BadgeDollarSign,
  CalendarClock,
  CalendarPlus,
  Check,
  CircleCheck,
  FolderOpen,
  Hourglass,
  Lightbulb,
  Send,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import { OutboundContext } from '../areas/outbound';
import { SocialContext } from '../areas/outbound/Social';
import type { ReactNode } from 'react';
import { ARCHIVED_BASE, BOXES, LABEL_GUIDE, NOW, PEOPLE } from '../data/mock';
import { pathOf, routeFromHref, todaysEvents } from '../state/ws';
import { ApprovalsContext } from '../areas/approvals';
import { CalendarContext } from '../areas/calendar';
import { DocsContext, FileContext } from '../areas/docs';
import { FilesContext } from '../areas/files';
import { LibraryContext } from '../areas/library';
import { PeopleContext } from '../areas/people';
import { ProjectsContext } from '../areas/projects';
import { TasksContext } from '../areas/tasks';
import type { Step, Thread } from '../data/types';
import { daysSince, fmtDay, fmtShortTime, fmtStamp, fmtTime, money } from '../lib/format';
import { inBox, labelOf, useStore } from '../state/store';
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
  } else if (r.view === 'people' || r.view === 'contact') {
    body = <PeopleContext />;
  } else if (r.view === 'files') {
    body = <FilesContext />;
  } else if (r.view === 'tasks') {
    body = <TasksContext />;
  } else if (r.view === 'calendar') {
    body = <CalendarContext />;
  } else if (r.view === 'docs') {
    body = <DocsContext />;
  } else if (r.view === 'invoices' || r.view === 'invoice') {
    body = <InvoicesContext />;
  } else if (r.view === 'bids' || r.view === 'bid') {
    body = <BidsContext />;
  } else if (r.view === 'file') {
    body = <FileContext />;
  } else if (r.view === 'projects' || r.view === 'project') {
    body = <ProjectsContext />;
  } else if (r.view === 'library') {
    body = <LibraryContext />;
  } else if (r.view === 'outbound' || r.view === 'campaign') {
    body = <OutboundContext />;
  } else if (r.view === 'social') {
    body = <SocialContext />;
  } else if (r.view === 'approvals') {
    body = <ApprovalsContext />;
  } else if (r.view === 'rules') {
    body = <RulesContext />;
  } else if (r.view === 'voice') {
    body = <VoiceContext />;
  } else if (r.view === 'appearance') {
    body = <AppearanceContext />;
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
        <h2 className="rp-title">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

// ───────────── Today ─────────────

function TodayContext() {
  const { state, dispatch } = useStore();
  const events = todaysEvents(state.ws);
  const prep = events.find((e) => e.start > NOW && e.note && e.with.length > 0);
  const waitingSoon = inBox(state.threads, 'waiting')
    .filter((t) => t.waiting?.due)
    .sort((a, b) => a.waiting!.due!.getTime() - b.waiting!.due!.getTime())
    .slice(0, 3);

  return (
    <>
      <Section title="Today’s calendar" aside={<span className="rp-aside">{fmtDay(NOW)}</span>}>
        <ol className="agenda">
          {events.map((e) => {
            const past = e.end < NOW;
            return (
              <li key={e.id} className={`agenda-item${e.kind === 'focus' ? ' focus' : ''}${past ? ' past' : ''}`}>
                <span className="agenda-time mono">{fmtShortTime(e.start)}</span>
                <button
                  className="agenda-block"
                  onClick={() =>
                    e.thread
                      ? dispatch({ type: 'openThread', id: e.thread })
                      : dispatch({ type: 'navigate', route: { view: 'calendar', tab: 'day' } })
                  }
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
                <DocIcon kind={state.ws.files[id]!.kind} size={15} />
                <span>{state.ws.files[id]!.name}</span>
              </div>
            ))}
            {prep.thread && (
              <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => dispatch({ type: 'openThread', id: prep.thread! })}>
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

/** The verb a next action shows, and does when clicked. */
function stepVerb(s: Step, t: Thread): { label: string; icon: LucideIcon } | undefined {
  if (s.run && !s.done) {
    switch (s.run.do) {
      case 'send':
        return t.draft ? { label: t.draft.trackAs ? 'Send & track' : 'Send', icon: Send } : undefined;
      case 'deal':
        return { label: 'Update', icon: BadgeDollarSign };
      case 'decide':
        return { label: s.run.verb, icon: Check };
      case 'block':
        return { label: 'Block', icon: CalendarPlus };
    }
  }
  if (s.href) return { label: 'Open', icon: ArrowUpRight };
  return undefined;
}

function ThreadContext({ t }: { t: Thread }) {
  const { state, dispatch } = useStore();
  const deal = t.deal ? state.deals[t.deal] : undefined;
  const primary = t.docs?.[0] ? state.ws.files[t.docs[0]] : undefined;
  const others = t.participants.filter((p) => p !== 'me');
  const done = t.steps?.filter((s) => s.done).length ?? 0;

  return (
    <>
      {t.waiting && t.box === 'waiting' && (
        <Section title="Waiting on">
          <div className="rp-card">
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
            {t.steps.map((s) => {
              const verb = stepVerb(s, t);
              const run = () =>
                s.run && !s.done
                  ? dispatch({ type: 'runStep', id: t.id, step: s.id })
                  : s.href
                    ? dispatch({ type: 'navigate', route: routeFromHref(s.href) })
                    : dispatch({ type: 'toggleStep', id: t.id, step: s.id });
              return (
                <li key={s.id} className={`step-row${s.done ? ' done' : ''}`}>
                  <button
                    className="step-check"
                    role="checkbox"
                    aria-checked={s.done}
                    aria-label={`${s.done ? 'Mark not done' : 'Mark done'}: ${s.text}`}
                    title={s.done ? 'Mark not done' : 'Mark done without doing it here'}
                    onClick={() => dispatch({ type: 'toggleStep', id: t.id, step: s.id })}
                  >
                    <span className="step-box">{s.done && <Check size={12} strokeWidth={3} />}</span>
                  </button>
                  <button className="step-main" onClick={run} title={verb ? `${verb.label}: ${s.text}` : undefined}>
                    <span className="step-text">{s.text}</span>
                    {s.byTimmy && <span className="step-by">Timmy</span>}
                    {verb && (
                      <span className="step-verb">
                        <verb.icon size={12} aria-hidden />
                        {verb.label}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
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
              <DocPath path={pathOf(state.ws, primary.folder)} />
              <span className="muted" style={{ fontSize: 12 }}>
                {primary.createdByTimmy ? 'Created by Timmy · ' : ''}Edited {fmtStamp(primary.updated)}
              </span>
            </div>
            <div className="file-actions">
              <button className="btn btn-sm" onClick={() => dispatch({ type: 'navigate', route: { view: 'file', id: primary.id } })}>
                <ArrowUpRight size={14} />
                Open
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'navigate', route: { view: 'files', tab: 'browse', folder: primary.folder } })}>
                <FolderOpen size={14} />
                Show in folder
              </button>
            </div>
          </div>
        </Section>
      )}

      {deal && state.showDeals && (
        <Section title="CRM record">
          <div className="rp-card">
            <div className="deal-head">
              <span className="deal-logo" style={tint('var(--ok)')}>
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
            const rel = state.ws.contacts[id];
            return (
              <li key={id}>
                <button
                  className="rp-person"
                  onClick={() => !p.bot && dispatch({ type: 'navigate', route: { view: 'contact', id, tab: 'overview' } })}
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
          <h2 className="rp-hero-title">
            <span className="rp-hero-num code">{box.num}</span>
            {box.name}
          </h2>
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
          <div className="rp-card">
            <dl className="kv flush">
              <dt>Threads</dt>
              <dd className="mono">{(id === 'archived' && !isLive() ? ARCHIVED_BASE + count : count).toLocaleString()}</dd>
              <dt>Drafts ready</dt>
              <dd className="mono">{state.threads.filter((t) => t.box === id && t.draft).length}</dd>
              <dt>Late</dt>
              <dd className="mono">
                {state.threads.filter((t) => t.box === id && ((t.box === 'waiting' ? t.waiting?.due : t.due)?.getTime() ?? Infinity) < NOW.getTime()).length}
              </dd>
            </dl>
          </div>
        </Section>
      </>
    );
  }

  const project = labelOf(id, state.ws);
  const threads = state.threads.filter((t) => t.project === id);
  const docs = [...new Set(threads.flatMap((t) => t.docs ?? []))].map((d) => state.ws.files[d]!);
  const dealId = threads.find((t) => t.deal)?.deal;
  const deal = dealId ? state.deals[dealId] : undefined;
  return (
    <>
      <div className="rp-hero" style={tint(project.color)}>
        <Folder color={project.color} size={36} />
        <div>
          <h2 className="rp-hero-title">
            <span className="rp-hero-num code">{project.num}</span>
            {project.name}
          </h2>
          <p className="muted" style={{ fontSize: 12.5 }}>
            {project.hint}
          </p>
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

// ───────────── Rules ─────────────

function RulesContext() {
  // The demo shows corrections a person might have made. A real workspace has no such record to show yet.
  const corrections = isLive() ? [] : [
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
        {corrections.length === 0 && <p className="rp-text">When you edit a draft or re-sort an email, the rule change Timmy proposes shows in Rules.</p>}
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

// ───────────── Appearance ─────────────

function VoiceContext() {
  return (
    <>
      <Section title="Talk instead of typing">
        <p className="rp-text">
          Press the mic in a reply, a new email or Ask Timmy, or hold your push-to-talk shortcut (Ctrl+Shift+Space unless you changed it) anywhere in Timmy.
        </p>
      </Section>
      <Section title="Where the words go">
        <p className="rp-text">With a text field focused, they land at the cursor. With nothing focused, they go to Ask Timmy below as a question.</p>
      </Section>
    </>
  );
}

function AppearanceContext() {
  return (
    <>
      <Section title="Readable in every palette">
        <p className="rp-text">Body and secondary text stay at 4.5:1 contrast or better in all three dark palettes and in light mode.</p>
      </Section>
      <Section title="Labels keep their colors">
        <p className="rp-text">
          Follow Up stays red, Waiting amber and Read Through blue in every palette, so a label means the same thing whichever look you pick.
        </p>
      </Section>
    </>
  );
}

// ───────────── Activity ─────────────

function ActivityContext() {
  const { state } = useStore();
  const today = state.activity.filter((a) => a.at.getDate() === NOW.getDate());
  const count = (...kinds: string[]) => today.filter((a) => kinds.includes(a.kind)).length;
  return (
    <>
      <Section title="Today so far" aside={<span className="rp-aside mono">{today.length} actions</span>}>
        <div className="rp-card">
          <dl className="kv flush">
            <dt>Sorting</dt>
            <dd className="mono">{count('triage', 'move')}</dd>
            <dt>Drafts</dt>
            <dd className="mono">{count('draft', 'send')}</dd>
            <dt>Files</dt>
            <dd className="mono">{count('file')}</dd>
            <dt>Calendar</dt>
            <dd className="mono">{count('calendar', 'task', 'crm')}</dd>
          </dl>
        </div>
      </Section>
      <Section title="Undo">
        <p className="rp-text">
          {isLive()
            ? 'Undo is on the notice that follows each change. A send can be stopped until its undo window ends, from the notice or from Approvals.'
            : 'Anything Timmy did can be undone from this log for 7 days. Undoing also updates the rule that caused it.'}
        </p>
      </Section>
    </>
  );
}

