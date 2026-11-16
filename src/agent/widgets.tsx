/*
 * The UI Timmy puts in the conversation, one component per AG-UI tool in
 * tools.ts. Widgets read live app state, so they stay current after you act,
 * and they change things only when you press a button.
 */
import { ArrowRight, BadgeDollarSign, CalendarDays, Check, CircleCheck, FilePenLine, Flame, Hourglass, Mail, Sparkles, Stamp, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { NOW } from '../data/mock';
import { dayDiff, dueInfo, fmtDay, fmtTime, money } from '../lib/format';
import { type ApprovalKind } from '../state/approvals';
import { scopedApprovals, scopedThreads } from '../state/scope';
import { routeForHref, type ChatChoice, type ChatLink } from '../state/assistant';
import { counterpart, useStore, ws, type Action } from '../state/store';
import { openThreads, useUrgency } from '../state/urgency';
import { eventsOn, firstName, midSentence, parseIsoDay, personName, put, routeFromHref, uid } from '../state/ws';
import { ApprovalRow } from '../areas/approvals/ApprovalCard';
import { Avatar } from '../components/common';
import { SendDraftButton } from '../components/SendDraft';
import { UrgencyReasons, UrgencyTag } from '../components/Urgency';
import { assistant } from './conversations';
import type { WidgetName } from './tools';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
/** Tool arguments arrive as JSON; dates inside app actions come back as Dates. */
export const parseArgs = (json: string): Record<string, unknown> => {
  try {
    return JSON.parse(json, (_k, v) => (typeof v === 'string' && ISO.test(v) ? new Date(v) : v)) as Record<string, unknown>;
  } catch {
    return {};
  }
};

function Widget({ icon: Icon, title, action, children }: { icon: LucideIcon; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="aw" aria-label={title}>
      <header className="aw-head">
        <span className="aw-icon" aria-hidden>
          <Icon size={15} />
        </span>
        <h3 className="aw-title">{title}</h3>
        {action}
      </header>
      <div className="aw-body">{children}</div>
    </section>
  );
}

function GoTo({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="aw-go" onClick={onClick}>
      {label}
      <ArrowRight size={13} />
    </button>
  );
}

/* ───────────── Urgent mail ───────────── */

function UrgentWidget({ limit = 6, level = 'urgent' }: { limit?: number; level?: string }) {
  const { state, dispatch } = useStore();
  const { rank } = useUrgency();
  const all = rank(scopedThreads(state, openThreads(state.threads)));
  const rows = (level === 'all' ? all : all.filter((x) => x.u.level === 'urgent')).slice(0, limit);
  return (
    <Widget icon={Flame} title={level === 'all' ? 'Open mail, most urgent first' : 'Needs you today'} action={<GoTo label="Daily brief" onClick={() => dispatch({ type: 'navigate', route: { view: 'today', tab: 'brief' } })} />}>
      {rows.length === 0 ? (
        <p className="aw-empty">Nothing urgent. You’re clear for now.</p>
      ) : (
        <ol className="aw-list">
          {rows.map(({ t, u }, i) => {
            const who = t.box === 'waiting' && t.waiting ? t.waiting.on : counterpart(t);
            return (
              <li key={t.id} className="aw-row">
                <span className="aw-rank">{i + 1}</span>
                <Avatar id={who} size={26} />
                <div className="aw-text">
                  <button className="aw-link" onClick={() => dispatch({ type: 'openThread', id: t.id })}>
                    {t.ask}
                  </button>
                  <UrgencyReasons info={u} max={2} />
                </div>
                <div className="aw-actions">
                  <UrgencyTag info={u} />
                  {t.draft ? (
                    <SendDraftButton t={t} size="xs" preview />
                  ) : t.box !== 'waiting' ? (
                    <button className="btn btn-xs" onClick={() => dispatch({ type: 'makeDraft', id: t.id })}>
                      <FilePenLine size={12} />
                      Draft
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Widget>
  );
}

/* ───────────── Approvals ───────────── */

function ApprovalsWidget({ limit, kind }: { limit?: number; kind?: ApprovalKind }) {
  const { state, dispatch } = useStore();
  const all = scopedApprovals(state).filter((a) => !kind || a.kind === kind);
  const rows = limit ? all.slice(0, limit) : all;
  return (
    <Widget
      icon={Stamp}
      title={kind === 'email' ? 'Emails ready to send' : 'Waiting for your OK'}
      action={<GoTo label={`All ${all.length}`} onClick={() => dispatch({ type: 'navigate', route: { view: 'approvals', tab: 'open', filter: kind } })} />}
    >
      {rows.length === 0 ? (
        <p className="aw-empty">
          <CircleCheck size={14} /> Nothing is waiting on you.
        </p>
      ) : (
        <ul className="ap-rows aw-approvals">
          {rows.map((a) => (
            <ApprovalRow key={a.key} a={a} />
          ))}
        </ul>
      )}
    </Widget>
  );
}

/* ───────────── A day's calendar ───────────── */

function DayWidget({ date }: { date?: string }) {
  const { state, dispatch } = useStore();
  const day = date ? parseIsoDay(date) : NOW;
  const events = eventsOn(state.ws, day).filter((e) => e.kind !== 'personal' || e.end > NOW);
  // Free gaps of 30 minutes or more between now (or 9 AM) and 6 PM.
  const startOfDay = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9);
  const endOfDay = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 18);
  let cursor = day.toDateString() === NOW.toDateString() && NOW > startOfDay ? new Date(Math.ceil(NOW.getTime() / 9e5) * 9e5) : startOfDay;
  const gaps: { start: Date; end: Date }[] = [];
  for (const e of events.filter((x) => x.end > cursor)) {
    if (e.start.getTime() - cursor.getTime() >= 30 * 60000) gaps.push({ start: cursor, end: e.start });
    if (e.end > cursor) cursor = e.end;
  }
  if (endOfDay.getTime() - cursor.getTime() >= 30 * 60000) gaps.push({ start: cursor, end: endOfDay });

  const block = (g: { start: Date; end: Date }) => {
    const end = new Date(Math.min(g.end.getTime(), g.start.getTime() + 90 * 60000));
    dispatch(
      ws([put('events', { id: uid('ev'), title: 'Focus time', start: g.start, end, kind: 'focus', with: [] })], {
        toast: `Blocked ${fmtTime(g.start)}–${fmtTime(end)} for focus`,
        undo: true,
        log: `Blocked ${fmtTime(g.start)}–${fmtTime(end)} for focus from Ask Timmy`,
      }),
    );
  };

  const items = [...events.map((e) => ({ at: e.start, e })), ...gaps.map((g) => ({ at: g.start, g }))].sort((a, b) => a.at.getTime() - b.at.getTime());
  return (
    <Widget icon={CalendarDays} title={day.toDateString() === NOW.toDateString() ? 'Today' : day.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} action={<GoTo label="Calendar" onClick={() => dispatch({ type: 'navigate', route: { view: 'calendar', tab: 'day' } })} />}>
      <ol className="aw-list aw-day">
        {items.map((it) =>
          'e' in it && it.e ? (
            <li key={it.e.id} className={`aw-row aw-event${it.e.end < NOW ? ' past' : ''}${it.e.kind === 'focus' ? ' focus' : ''}`}>
              <span className="aw-time">{fmtTime(it.e.start)}</span>
              <div className="aw-text">
                <button className="aw-link" onClick={() => (it.e.thread ? dispatch({ type: 'openThread', id: it.e.thread }) : dispatch({ type: 'navigate', route: { view: 'calendar', tab: 'day' } }))}>
                  {it.e.title}
                </button>
                <span className="aw-sub">
                  until {fmtTime(it.e.end)}
                  {it.e.with.length ? ` · ${it.e.with.map(firstName).join(', ')}` : ''}
                </span>
              </div>
            </li>
          ) : 'g' in it && it.g ? (
            <li key={`gap-${it.g.start.getTime()}`} className="aw-row aw-gap">
              <span className="aw-time">{fmtTime(it.g.start)}</span>
              <div className="aw-text">
                <span>Free until {fmtTime(it.g.end)}</span>
              </div>
              <div className="aw-actions">
                <button className="btn btn-xs" onClick={() => block(it.g!)}>
                  Block for focus
                </button>
              </div>
            </li>
          ) : null,
        )}
      </ol>
    </Widget>
  );
}

/* ───────────── Pipeline ───────────── */

function PipelineWidget() {
  const { state, dispatch } = useStore();
  const deals = Object.values(state.deals).sort((a, b) => (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity));
  const open = deals.filter((d) => d.stage !== 'Closed won');
  return (
    <Widget icon={BadgeDollarSign} title="Pipeline" action={<span className="aw-meta">{money(open.reduce((n, d) => n + d.value, 0))} open</span>}>
      <div className="aw-stages" aria-label="Deals by stage">
        {[...new Set(deals.map((d) => d.stage))].map((stage) => {
          const inStage = deals.filter((d) => d.stage === stage);
          const total = inStage.reduce((n, d) => n + d.value, 0);
          return (
            <span key={stage} className={`aw-stage${stage === 'Closed won' ? ' won' : ''}`} style={{ flexGrow: Math.max(1, total) }}>
              <span className="aw-stage-name">{stage}</span>
              <span className="aw-stage-num">
                {inStage.length} · {money(total)}
              </span>
            </span>
          );
        })}
      </div>
      <table className="aw-table">
        <thead>
          <tr>
            <th scope="col">Deal</th>
            <th scope="col">Stage</th>
            <th scope="col" className="num">
              Value
            </th>
            <th scope="col">Next step</th>
          </tr>
        </thead>
        <tbody>
          {deals.map((d) => {
            const due = d.due ? dueInfo(d.due) : null;
            return (
              <tr key={d.id}>
                <td>
                  <button className="aw-link" onClick={() => dispatch({ type: 'navigate', route: { view: 'contact', id: d.contact, tab: 'overview' } })}>
                    {d.company}
                  </button>
                  <span className="aw-sub">{personName(d.contact)}</span>
                </td>
                <td>{d.stage}</td>
                <td className="num">{money(d.value)}</td>
                <td>
                  {d.stage === 'Closed won' ? 'Won' : d.next}
                  {due && d.stage !== 'Closed won' && <span className={`aw-sub tone-${due.tone}`}>{due.tone === 'overdue' ? due.label.replace(/Overdue (\d+)d/, '$1 days late') : due.label}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Widget>
  );
}

/* ───────────── One thread ───────────── */

function ThreadWidget({ id }: { id: string }) {
  const { state, dispatch } = useStore();
  const t = state.threads.find((x) => x.id === id);
  if (!t) return null;
  const open = (t.steps ?? []).filter((s) => !s.done);
  const paras = t.draft?.body.split(/\n\n+/) ?? [];
  return (
    <Widget icon={Mail} title={t.subject} action={<GoTo label="Open thread" onClick={() => dispatch({ type: 'openThread', id: t.id })} />}>
      <p className="aw-lede">
        <Sparkles size={13} aria-hidden /> {t.ask}
      </p>
      {open.length > 0 && (
        <ul className="aw-steps">
          {open.map((s) => (
            <li key={s.id}>
              <span>{s.text}</span>
              {(s.run || s.href) && (
                <button
                  className="btn btn-xs"
                  onClick={() => (s.run ? dispatch({ type: 'runStep', id: t.id, step: s.id }) : dispatch({ type: 'navigate', route: routeFromHref(s.href!) }))}
                >
                  {s.run ? 'Do it' : 'Open'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {t.draft ? (
        <div className="aw-draft">
          <span className="aw-sub">
            Draft to {t.draft.to.map(personName).join(', ')}
            {t.draft.trackAs ? ` · tracks ${t.draft.trackAs.item.charAt(0).toLowerCase()}${t.draft.trackAs.item.slice(1)}` : ''}
          </span>
          {paras.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
          <div className="aw-draft-actions">
            <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'openThread', id: t.id })}>
              Edit
            </button>
            <SendDraftButton t={t} />
          </div>
        </div>
      ) : (
        <div className="aw-draft-actions">
          <button className="btn btn-sm" onClick={() => dispatch({ type: 'makeDraft', id: t.id })}>
            <FilePenLine size={13} />
            Draft a reply
          </button>
        </div>
      )}
    </Widget>
  );
}

/* ───────────── Waiting: what others owe you ───────────── */

function WaitingWidget() {
  const { state, dispatch } = useStore();
  const rows = scopedThreads(state, state.threads.filter((t) => t.box === 'waiting' && t.waiting)).sort(
    (a, b) => (a.waiting!.due?.getTime() ?? Infinity) - (b.waiting!.due?.getTime() ?? Infinity),
  );
  return (
    <Widget icon={Hourglass} title="Waiting on others" action={<GoTo label="[02] Waiting" onClick={() => dispatch({ type: 'navigate', route: { view: 'box', box: 'waiting', tab: 'all' } })} />}>
      {rows.length === 0 ? (
        <p className="aw-empty">Nobody owes you anything right now.</p>
      ) : (
        <ul className="aw-list aw-waiting">
          {rows.map((t) => {
            const w = t.waiting!;
            const late = w.due ? w.due < NOW : -dayDiff(w.since) >= 5;
            const when = w.due ? (w.due < NOW ? `${-dayDiff(w.due)} days late` : `promised ${fmtDay(w.due)}`) : `no date · asked ${-dayDiff(w.since)} days ago`;
            return (
              <li key={t.id} className="aw-row">
                <Avatar id={w.on} size={24} />
                <div className="aw-text">
                  <button className="aw-link" onClick={() => dispatch({ type: 'openThread', id: t.id })}>
                    {firstName(w.on)}: {midSentence(w.item)}
                  </button>
                  <span className={`aw-sub${late ? ' tone-overdue' : ''}`}>{when}</span>
                </div>
                <div className="aw-actions">
                  {t.draft ? (
                    <>
                      <button className="btn btn-xs btn-ghost" onClick={() => dispatch({ type: 'openThread', id: t.id })}>
                        Review nudge
                      </button>
                      <SendDraftButton t={t} size="xs" label="Send & track" preview />
                    </>
                  ) : (
                    <button className={`btn btn-xs${late ? ' btn-primary' : ''}`} onClick={() => dispatch({ type: 'makeDraft', id: t.id })}>
                      <FilePenLine size={12} />
                      Draft nudge
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Widget>
  );
}

/* ───────────── Answer: bullets, links and choices ───────────── */

function AnswerWidget({ bullets = [], links = [], choices = [], preview, convo, callId, chosen }: { bullets?: string[]; links?: ChatLink[]; choices?: ChatChoice[]; preview?: string; convo: string; callId: string; chosen?: string }) {
  const { dispatch } = useStore();
  const go = (href: string) => dispatch({ type: 'navigate', route: routeForHref(href) ?? routeFromHref(href) });
  const pick = (c: ChatChoice) => {
    c.actions.forEach((a: Action) => dispatch(a));
    assistant.choose(convo, callId, c.after);
    if (c.open) go(c.open);
  };
  return (
    <div className="aw aw-plain">
      {preview && (
        <div className="aw-draft aw-preview">
          {preview.split(/\n\n+/).map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      )}
      {bullets.length > 0 && (
        <ul className="aw-bullets">
          {bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      )}
      {links.length > 0 && (
        <div className="aw-links">
          {links.map((l) => (
            <button key={l.href + l.label} className="aw-chip" onClick={() => go(l.href)}>
              <span>{l.label}</span>
              {l.sub && <span className="aw-sub">{l.sub}</span>}
            </button>
          ))}
        </div>
      )}
      {choices.length > 0 &&
        (chosen ? (
          <p className="aw-done">
            <Check size={13} /> {chosen}
          </p>
        ) : (
          <div className="aw-choices">
            {choices.map((c) => (
              <button key={c.id} className={`btn btn-sm${c.primary ? ' btn-primary' : c.cancel ? ' btn-ghost' : ''}`} onClick={() => pick(c)}>
                {c.label}
              </button>
            ))}
          </div>
        ))}
    </div>
  );
}

/** Renders one tool call. */
export function WidgetFor({ name, args, convo, callId, chosen }: { name: WidgetName | string; args: Record<string, unknown>; convo: string; callId: string; chosen?: string }) {
  switch (name) {
    case 'show_urgent':
      return <UrgentWidget limit={args.limit as number | undefined} level={args.level as string | undefined} />;
    case 'show_approvals':
      return <ApprovalsWidget limit={args.limit as number | undefined} kind={args.kind as ApprovalKind | undefined} />;
    case 'show_day':
      return <DayWidget date={args.date as string | undefined} />;
    case 'show_pipeline':
      return <PipelineWidget />;
    case 'show_thread':
      return <ThreadWidget id={String(args.id ?? '')} />;
    case 'show_waiting':
      return <WaitingWidget />;
    case 'show_answer':
      return (
        <AnswerWidget
          bullets={args.bullets as string[] | undefined}
          links={args.links as ChatLink[] | undefined}
          choices={args.choices as ChatChoice[] | undefined}
          preview={typeof args.preview === 'string' ? args.preview : undefined}
          convo={convo}
          callId={callId}
          chosen={chosen}
        />
      );
    default:
      return <p className="aw-empty">Timmy wanted to show “{name}”, which this version can’t display yet.</p>;
  }
}
