/*
 * Approvals: one queue for everything Timmy prepared that needs your OK before
 * it happens. Emails to send, decisions on price or hiring, CRM changes and
 * calendar invites. Nothing goes out until you approve it here or on the thread.
 */
import { ArrowRight, Check, CircleSlash, Inbox, Lock, Stamp } from 'lucide-react';
import type { ReactNode } from 'react';
import { ACTIVITY } from '../../data/mock';
import { fmtStamp, fmtTime, plural } from '../../lib/format';
import { APPROVAL_KINDS, openApprovals, type Approval, type ApprovalKind } from '../../state/approvals';
import { scopedApprovals } from '../../state/scope';
import { ScopeNote } from '../../components/ProjectScope';
import { nextRun, whenLabel } from '../../state/schedule';
import { useStore, type Route } from '../../state/store';
import { URGENCY, type Urgency } from '../../state/urgency';
import { Frame } from '../../components/Frame';
import { EmptyState, SideHead } from '../../components/kit';
import { tint } from '../../components/common';
import { ApprovalCard } from './ApprovalCard';

export { ApprovalCard, ApprovalRow } from './ApprovalCard';

type ApprovalsRoute = Extract<Route, { view: 'approvals' }>;
const KINDS = Object.keys(APPROVAL_KINDS) as ApprovalKind[];

/** What's waiting on you, narrowed to the picked project. */
export function useApprovals() {
  const { state } = useStore();
  return scopedApprovals(state);
}

export function ApprovalsView() {
  const { state, dispatch } = useStore();
  const r = state.route as ApprovalsRoute;
  const all = useApprovals();
  const nav = (route: ApprovalsRoute) => dispatch({ type: 'navigate', route });

  return (
    <Frame
      tabs={[
        { id: 'open', label: 'Waiting on you', count: all.length },
        { id: 'history', label: 'Decided', count: state.approvalLog.length },
      ]}
      active={r.tab}
      onTab={(id) => nav({ view: 'approvals', tab: id as ApprovalsRoute['tab'], filter: r.filter })}
      scrollKey={`approvals-${r.tab}`}
    >
      {r.tab === 'open' ? <Queue all={all} filter={r.filter} /> : <History />}
    </Frame>
  );
}

/** Actions waiting on someone else: RevOps for CRM writes, the exec in delegate mode. */
function HeldSection() {
  const { state, dispatch } = useStore();
  const held = state.conn.held;
  if (!held.length) return null;
  return (
    <section className="section" aria-labelledby="ap-held">
      <div className="section-head">
        <h2 className="section-title" id="ap-held">
          Waiting on someone else · {held.length}
        </h2>
        <span className="section-sub">Each runs as it was once they approve. In this preview you answer for them.</span>
      </div>
      <ul className="card held-list">
        {held.map((h) => (
          <li key={h.id} className="held-row">
            <span className="held-who">{h.who}</span>
            <div className="held-text">
              <strong>{h.title}</strong>
              <span className="muted">
                {h.detail} Asked by {h.by} · {fmtStamp(h.at)}
              </span>
            </div>
            <div className="held-actions">
              <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'release', id: h.id, approve: false })}>
                Declined
              </button>
              <button className="btn btn-sm" onClick={() => dispatch({ type: 'release', id: h.id, approve: true })}>
                <Check size={14} /> {h.who.replace(/ \(.*\)$/, '').split(' ')[0]} approved
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Queue({ all, filter }: { all: Approval[]; filter?: ApprovalKind }) {
  const { state, dispatch } = useStore();
  const shown = filter ? all.filter((a) => a.kind === filter) : all;
  const next = nextRun(state.schedule);
  const levels: Urgency[] = ['urgent', 'soon', 'later'];

  return (
    <>
      <h1 className="page-title">Approvals</h1>
      <p className="page-sub">
        Timmy prepares, you decide. Emails, invites, CRM changes and calls on price or hiring wait here until you approve them. Every choice is logged and can be undone from
        the notice that follows.
      </p>

      <ScopeNote hidden={openApprovals(state).length - all.length} noun={['approval', 'approvals']} />

      <HeldSection />

      <div className="filters" role="group" aria-label="Show">
        <button className="filter" aria-pressed={!filter} onClick={() => dispatch({ type: 'navigate', route: { view: 'approvals', tab: 'open' } })}>
          All
          <span className="filter-count">{all.length}</span>
        </button>
        {KINDS.map((k) => {
          const n = all.filter((a) => a.kind === k).length;
          if (!n && filter !== k) return null;
          const M = APPROVAL_KINDS[k];
          return (
            <button key={k} className="filter" aria-pressed={filter === k} onClick={() => dispatch({ type: 'navigate', route: { view: 'approvals', tab: 'open', filter: k } })}>
              <M.icon size={14} />
              {M.plural}
              <span className="filter-count">{n}</span>
            </button>
          );
        })}
      </div>

      {levels.map((level) => {
        const items = shown.filter((a) => a.urgency.level === level);
        if (!items.length) return null;
        return (
          <section key={level} className="section ap-group" aria-labelledby={`ap-${level}`}>
            <div className="section-head">
              <h2 className="section-title" id={`ap-${level}`}>
                {URGENCY[level].label}
              </h2>
              <span className="section-sub">
                {plural(items.length, 'item')} · {URGENCY[level].hint.toLowerCase()}
              </span>
            </div>
            <div className="ap-list">
              {items.map((a) => (
                <ApprovalCard key={a.key} a={a} />
              ))}
            </div>
          </section>
        );
      })}

      {shown.length === 0 && (
        <div className="section">
          <EmptyState
            icon={Check}
            title={filter ? `No ${APPROVAL_KINDS[filter].plural.toLowerCase()} waiting` : 'Nothing is waiting on you'}
            body={next ? `Timmy brings new drafts and decisions here after the next run, ${whenLabel(next)}.` : 'The morning run is paused. Turn it back on in Settings › Schedule.'}
            action={
              filter ? (
                <button className="btn btn-sm" onClick={() => dispatch({ type: 'navigate', route: { view: 'approvals', tab: 'open' } })}>
                  Show everything
                </button>
              ) : undefined
            }
          />
        </div>
      )}
    </>
  );
}

function History() {
  const { state, dispatch } = useStore();
  const log = state.approvalLog;
  return (
    <>
      <h1 className="page-title">Decided</h1>
      <p className="page-sub">What you approved or turned down, newest first. Approvals made from a thread are listed here too.</p>
      {log.length === 0 ? (
        <div className="section">
          <EmptyState icon={Stamp} title="Nothing decided yet" body="When you send a draft, update a deal or make a call Timmy brought you, it’s recorded here." />
        </div>
      ) : (
        <ol className="log ap-history">
          {log.map((x) => {
            const M = APPROVAL_KINDS[x.kind];
            return (
              <li key={x.id} className="log-item">
                <span className="nav-icon" style={tint(x.approved ? 'var(--ok)' : 'var(--c-slate)')}>
                  {x.approved ? <Check size={15} /> : <CircleSlash size={15} />}
                </span>
                <div className="log-text">
                  <p>{x.title}</p>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    {M.label} · {x.choice} · {fmtStamp(x.at)}
                  </span>
                </div>
                <div className="log-actions">
                  {x.thread && (
                    <button className="btn btn-xs btn-ghost" onClick={() => dispatch({ type: 'openThread', id: x.thread! })}>
                      Open
                      <ArrowRight size={13} />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

export function ApprovalsSide() {
  const { state, dispatch } = useStore();
  const r = state.route.view === 'approvals' ? state.route : null;
  const all = useApprovals();
  const urgent = all.filter((a) => a.urgency.level === 'urgent').length;
  const policy = state.rules.filter((x) => x.group === 'approvals' && x.enabled);
  const go = (route: ApprovalsRoute) => dispatch({ type: 'navigate', route });

  return (
    <>
      <SideHead
        icon={
          <span className="nav-icon" style={tint('var(--c-violet)')}>
            <Stamp size={16} />
          </span>
        }
        title="Approvals"
        sub={all.length ? `${all.length} waiting · ${urgent} urgent` : 'Nothing waiting'}
      />
      <div className="side-scroll">
        <div className="side-group">
          <div className="side-title">Waiting on you</div>
          <button className="nav-item compact" aria-current={r?.tab === 'open' && !r.filter ? 'page' : undefined} onClick={() => go({ view: 'approvals', tab: 'open' })}>
            <Inbox size={15} className="ap-nav-glyph" aria-hidden />
            <span className="nav-name">Everything</span>
            <span className={`nav-count${all.length ? ' strong' : ''}`}>{all.length || ''}</span>
          </button>
          {KINDS.map((k) => {
            const M = APPROVAL_KINDS[k];
            const n = all.filter((a) => a.kind === k).length;
            return (
              <button
                key={k}
                className="nav-item compact"
                aria-current={r?.tab === 'open' && r.filter === k ? 'page' : undefined}
                onClick={() => go({ view: 'approvals', tab: 'open', filter: k })}
              >
                <M.icon size={15} className="ap-nav-glyph" style={{ color: M.color }} aria-hidden />
                <span className="nav-name">{M.plural}</span>
                <span className="nav-count">{n || ''}</span>
              </button>
            );
          })}
          <button className="nav-item compact" aria-current={r?.tab === 'history' ? 'page' : undefined} onClick={() => go({ view: 'approvals', tab: 'history' })}>
            <Check size={15} className="ap-nav-glyph" aria-hidden />
            <span className="nav-name">Decided</span>
            <span className="nav-count">{state.approvalLog.length || ''}</span>
          </button>
        </div>

        <div className="side-group">
          <div className="side-title">What needs your OK</div>
          <ul className="ap-policy">
            {policy.map((p) => (
              <li key={p.id}>
                {p.locked ? <Lock size={13} aria-label="Always on" /> : <Check size={13} aria-hidden />}
                <span>{p.text}</span>
              </li>
            ))}
          </ul>
          <button className="btn btn-xs btn-ghost ap-policy-edit" onClick={() => dispatch({ type: 'navigate', route: { view: 'rules', tab: 'approvals' } })}>
            Edit approval rules
            <ArrowRight size={13} />
          </button>
        </div>
      </div>
    </>
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

export function ApprovalsContext() {
  const { state, dispatch } = useStore();
  const recent = state.approvalLog.slice(0, 5);
  const auto = ACTIVITY.filter((x) => x.kind === 'triage' || (x.kind === 'file' && /receipt/i.test(x.text))).slice(0, 3);

  return (
    <>
      <Section title="How approvals work">
        <ol className="ap-steps">
          <li>
            <strong>Timmy prepares.</strong> During the morning run it drafts replies, works out the numbers and lines up invites and CRM changes.
          </li>
          <li>
            <strong>You decide.</strong> Approve, edit or turn it down here, or on the email it came from.
          </li>
          <li>
            <strong>Timmy does it and logs it.</strong> Every action shows in Timmy’s activity, and the notice that follows has Undo.
          </li>
        </ol>
      </Section>

      <Section title="Done without asking" aside={<span className="rp-aside">Today</span>}>
        <p className="rp-text">Routine work your rules allow Timmy to handle on its own:</p>
        <ul className="ap-auto">
          {auto.map((x) => (
            <li key={x.id}>
              <span className="mono">{fmtTime(x.at)}</span>
              <span>{x.text}</span>
            </li>
          ))}
        </ul>
        <button className="btn btn-xs btn-ghost" onClick={() => dispatch({ type: 'navigate', route: { view: 'activity', tab: 'all' } })}>
          See all of Timmy’s activity
          <ArrowRight size={13} />
        </button>
      </Section>

      <Section title="Decided recently" aside={<span className="rp-aside mono">{state.approvalLog.length}</span>}>
        {recent.length === 0 ? (
          <p className="rp-text">Nothing yet. What you approve or turn down shows here.</p>
        ) : (
          <ul className="ap-auto">
            {recent.map((x) => (
              <li key={x.id}>
                {x.approved ? <Check size={13} className="ap-ok" aria-label="Approved" /> : <CircleSlash size={13} aria-label="Turned down" />}
                <span>
                  {x.title} <span className="muted">· {x.choice}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
