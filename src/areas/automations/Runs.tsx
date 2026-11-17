/*
 * The Runs tab of the automation editor, on a real workspace: what this automation has done lately.
 * Each run says what set it off, where it stands, and what every step did, with the error when one
 * failed. The list comes from the server and is read again every few seconds while the tab is open.
 */
import { useEffect, useState } from 'react';
import { ApiError, api, type AutomationRun, type AutomationRuns } from '../../live/api';
import { fmtStamp } from '../../lib/format';

const STATUS: Record<AutomationRun['status'], string> = { queued: 'Starting', running: 'Running', waiting: 'Waiting', done: 'Done', failed: 'Failed', cancelled: 'Stopped' };
const REFRESH_MS = 4000;

/** Where a run stands, in a few words. A run that is trying a failed step again says so. */
function standing(run: AutomationRun): string {
  if (run.status === 'queued' && run.steps.some((s) => s.error)) return 'Trying again';
  if (run.status === 'waiting' && run.wakeAt) return `Waiting until ${fmtStamp(run.wakeAt)}`;
  if (run.status === 'waiting') return 'Waiting for an OK';
  return STATUS[run.status];
}

export function Runs({ id, on, note }: { id: string; on: boolean; note?: string }) {
  const [data, setData] = useState<AutomationRuns | null>(null);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let open = true;
    const load = () =>
      api.automationRuns(id).then(
        (d) => open && (setData(d), setProblem('')),
        // An automation that was only just created hasn't reached the server yet: that is "no runs", not an error.
        (e: Error) => open && (e instanceof ApiError && e.status === 404 ? (setData({ automation: { id, on: false, note: null, nextRunAt: null }, runs: [] }), setProblem('')) : setProblem('Timmy couldn’t load the runs. It will try again in a moment.')),
      );
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      open = false;
      window.clearInterval(timer);
    };
  }, [id]);

  const runs = data?.runs ?? [];
  return (
    <div className="ae-settings ar" aria-label="Runs">
      {note && (
        <p className="ar-note" role="status">
          {note}
        </p>
      )}
      <p className="ae-hint">
        {on ? 'This automation is on. Each time it runs, the run shows here.' : 'This automation is off, so nothing starts it. Test run shows what it would do.'}
        {on && data?.automation.nextRunAt ? ` Next run: ${fmtStamp(data.automation.nextRunAt)}.` : ''}
      </p>
      {problem && <p className="ar-problem">{problem}</p>}
      {data && runs.length === 0 && !problem && <p className="muted ar-empty">No runs yet.</p>}
      <ol className="ar-list">
        {runs.map((run) => (
          <li key={run.id} className={`ar-run ${run.status}`}>
            <div className="ar-head">
              <span className={`ar-status ${run.status}`}>{standing(run)}</span>
              <span className="ar-when">{fmtStamp(run.createdAt)}</span>
            </div>
            <p className="ar-by">{run.startedBy}</p>
            <ol className="ar-steps">
              {run.steps.map((s) => (
                <li key={s.id} className={s.status}>
                  <strong>{s.label}</strong> {s.text}
                  {s.attempt > 1 && s.status !== 'failed' ? <span className="muted"> (try {s.attempt})</span> : null}
                  {s.error && <span className="ar-error"> {s.error}</span>}
                </li>
              ))}
            </ol>
            {run.error && run.status !== 'failed' && <p className="ar-error">{run.error}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}
