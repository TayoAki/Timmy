/*
 * One item waiting for your OK. The full card shows the numbers or the email
 * that will go out; the compact row is for the daily brief and threads.
 */
import { ArrowRight, ChevronDown, ChevronUp, Hourglass, Info, Paperclip, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { PEOPLE } from '../../data/mock';
import { dueInfo } from '../../lib/format';
import { APPROVAL_KINDS, mayDecideCard, type Approval, type ApprovalNote } from '../../state/approvals';
import { useProfile } from '../../live/LiveApp';
import { useStore } from '../../state/store';
import { firstName, midSentence, personName } from '../../state/ws';
import { FileChips } from '../../components/Attach';
import { Avatar, ProjectChip, tint } from '../../components/common';
import { UrgencyReasons, UrgencyTag } from '../../components/Urgency';

const names = (ids: string[]) => ids.map((id) => personName(id)).join(', ');

function useActions(a: Approval) {
  const { dispatch } = useStore();
  // On a real workspace some cards are only for some people to decide; everyone else is told who it waits for.
  const mine = mayDecideCard(a, useProfile()?.profile);
  const run = (option: string) => dispatch({ type: 'resolve', key: a.key, option, change: a.change });
  const open = () => (a.thread ? dispatch({ type: 'openThread', id: a.thread }) : a.route && dispatch({ type: 'navigate', route: a.route }));
  return { run, open, mine };
}

export function ApprovalCard({ a, inThread }: { a: Approval; inThread?: boolean }) {
  const { state } = useStore();
  const { run, open, mine } = useActions(a);
  const [full, setFull] = useState(false);
  const titleId = useId();
  const meta = APPROVAL_KINDS[a.kind];
  const due = a.due ? dueInfo(a.due) : null;

  return (
    <article className="card ap-card" aria-labelledby={titleId}>
      <div className="ap-top">
        <span className="ap-kind" style={tint(meta.color)} title={meta.label}>
          <meta.icon size={16} />
        </span>
        <div className="ap-head">
          <h3 className="ap-title" id={titleId}>
            {a.title}
          </h3>
          <p className="ap-why">{a.why}</p>
        </div>
        <UrgencyTag info={a.urgency} always />
      </div>

      {a.facts && (
        <dl className="ap-facts">
          {a.facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}

      {a.email && (
        <div className="ap-email">
          <div className="ap-email-head">
            <span>
              To {names(a.email.to)}
              {a.email.cc?.length ? `, cc ${names(a.email.cc)}` : ''}
            </span>
            {a.email.kind === 'nudge' && <span className="chip plain">Nudge</span>}
          </div>
          <div className={`ap-email-body${full ? ' full' : ''}`}>
            {a.email.body.split(/\n\n+/).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
          <button type="button" className="ap-more" onClick={() => setFull((v) => !v)} aria-expanded={full}>
            {full ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {full ? 'Show less' : 'Show the whole email'}
          </button>
          {/* What goes out with the email, exactly as approved: the files uploaded for it, by name and size. */}
          <FileChips files={a.email.files} />
          {(a.email.trackAs || a.email.attachments?.length) && (
            <div className="chips">
              {a.email.trackAs && (
                <span className="chip">
                  <Hourglass size={12} />
                  Tracks: {midSentence(a.email.trackAs.item)} from {firstName(a.email.trackAs.on)}
                </span>
              )}
              {a.email.attachments?.map((id) => (
                <span key={id} className="chip">
                  <Paperclip size={12} />
                  {state.ws.files[id]?.name ?? id}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <ApprovalNotes notes={a.notes} />

      <div className="ap-foot">
        <div className="ap-context">
          {a.who && PEOPLE[a.who] && (
            <span className="ap-who">
              <Avatar id={a.who} size={20} />
              {personName(a.who)}
            </span>
          )}
          {due && a.kind !== 'email' && (
            <span className={`tone-${due.tone}`}>
              {due.tone === 'overdue' ? due.label.replace(/Overdue (\d+)d/, '$1 days late') : `Due ${due.label.charAt(0).toLowerCase()}${due.label.slice(1)}`}
            </span>
          )}
          {a.project && <ProjectChip id={a.project} />}
          <UrgencyReasons info={a.urgency} max={2} />
        </div>
        <div className="ap-actions">
          {(a.thread || a.route) && !inThread && (
            <button className="btn btn-sm btn-ghost" onClick={open}>
              {a.openLabel ?? (a.kind === 'email' ? 'Edit' : 'Open email')}
            </button>
          )}
          {mine ? (
            [...a.options].reverse().map((o) => (
              <button key={o.id} className={`btn btn-sm${o.primary ? ' btn-primary' : ''}${o.danger ? ' btn-quiet-danger' : ''}`} onClick={() => run(o.id)}>
                {o.label}
              </button>
            ))
          ) : (
            <span className="ap-waiting-for">Waiting for {a.decidedBy?.who} to decide</span>
          )}
        </div>
      </div>
    </article>
  );
}

/** What approving also does, and anything to check first. */
export function ApprovalNotes({ notes }: { notes?: ApprovalNote[] }) {
  if (!notes?.length) return null;
  return (
    <ul className="ap-notes">
      {notes.map((n) => (
        <li key={n.text} className={`ap-note ${n.tone}`}>
          {n.tone === 'warn' ? <TriangleAlert size={14} aria-label="Check first" /> : <Info size={14} aria-hidden />}
          <span>{n.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** A one-line version for the daily brief. */
export function ApprovalRow({ a }: { a: Approval }) {
  const { dispatch } = useStore();
  const { run, mine } = useActions(a);
  const meta = APPROVAL_KINDS[a.kind];
  const primary = a.options.find((o) => o.primary) ?? a.options[0]!;
  return (
    <li className="ap-row">
      <span className="ap-kind sm" style={tint(meta.color)} title={meta.label}>
        <meta.icon size={14} />
      </span>
      <div className="ap-row-text">
        <span className="ap-row-title">{a.title}</span>
        <span className="ap-row-sub">
          {meta.label}
          {a.who ? ` · ${personName(a.who)}` : ''} · {a.urgency.reasons[0]}
        </span>
      </div>
      <div className="ap-row-actions">
        <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'navigate', route: { view: 'approvals', tab: 'open', filter: a.kind } })}>
          Review
          <ArrowRight size={14} />
        </button>
        {mine && (
          <button className="btn btn-sm btn-primary" onClick={() => run(primary.id)}>
            {primary.label}
          </button>
        )}
      </div>
    </li>
  );
}
