/*
 * Today, on a real workspace: what the automations told you today. A “Notify me” step set to
 * “Timmy (Today page)” lands here, and so does Timmy saying it switched an automation off and why.
 * The same lines are in the activity log; nothing shows when there is nothing to say.
 */
import { ArrowRight, Workflow } from 'lucide-react';
import { tint } from '../../components/common';
import { dayDiff, fmtTime } from '../../lib/format';
import { useStore } from '../../state/store';

const SHOWN = 5;

export function AutomationNotices() {
  const { state, dispatch } = useStore();
  const today = state.activity.filter((a) => a.kind === 'automation' && dayDiff(a.at) === 0);
  if (!today.length) return null;
  return (
    <section className="section" aria-labelledby="brief-automations">
      <div className="section-head">
        <h2 className="section-title" id="brief-automations">
          From your automations
        </h2>
        {today.length > SHOWN && (
          <button className="btn btn-xs btn-ghost" onClick={() => dispatch({ type: 'navigate', route: { view: 'activity', tab: 'other' } })}>
            See all {today.length}
            <ArrowRight size={13} />
          </button>
        )}
      </div>
      <ol className="log">
        {today.slice(0, SHOWN).map((a) => (
          <li key={a.id} className="log-item">
            <span className="nav-icon" style={tint('var(--c-indigo)')}>
              <Workflow size={15} />
            </span>
            <div className="log-text">
              <p>{a.text}</p>
              <span className="muted" style={{ fontSize: 12.5 }}>
                {fmtTime(a.at)}
              </span>
            </div>
            <div className="log-actions">
              {a.threadId && (
                <button className="btn btn-xs btn-ghost" onClick={() => dispatch({ type: 'openThread', id: a.threadId!, tab: 'history' })}>
                  Open
                  <ArrowRight size={13} />
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
