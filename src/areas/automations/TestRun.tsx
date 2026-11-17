/*
 * The editor's Test run on a real workspace. The server walks the steps as they are drawn, with sample data or
 * with one of the emails that arrived recently, and says what each would do: what a Send or an Ask me first would
 * put forward in Approvals, and what would stop the automation being switched on. Nothing is done: no task, no
 * draft, no model call, nothing in Approvals, no run.
 */
import { CircleAlert, FlaskConical, Mail, MessageCircleQuestion, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, type AutomationTest, type TestEmail } from '../../live/api';

export type Walked = { done: string[]; skipped: string[] };

export function TestRun({ id, graph, startsFromEmail, onWalked, onClose }: {
  id: string;
  /** The steps and connections as they are on the canvas, saved or not. */
  graph: { nodes: unknown[]; edges: unknown[] };
  startsFromEmail: boolean;
  /** Which steps the test reached, to mark them on the canvas. */
  onWalked: (w: Walked) => void;
  onClose: () => void;
}) {
  const [emails, setEmails] = useState<TestEmail[]>([]);
  const [source, setSource] = useState('sample');
  const [result, setResult] = useState<AutomationTest | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const latest = useRef(graph);
  latest.current = graph;
  const walked = useRef(onWalked);
  walked.current = onWalked;

  const run = async (from: string) => {
    setBusy(true);
    setProblem('');
    try {
      const out = await api.automationTest(id, { ...(from === 'sample' ? { sample: true as const } : { eventId: from }), graph: latest.current });
      setResult(out);
      walked.current({ done: out.steps.map((s) => s.id), skipped: out.skipped });
    } catch (e) {
      setResult(null);
      setProblem(e instanceof ApiError && e.status === 404 && from !== 'sample' ? 'That email isn’t in Timmy any more. Pick another one.' : (e as Error).message || 'Timmy couldn’t run the test. Try again.');
    } finally {
      setBusy(false);
    }
  };

  // Opening the panel runs the test once with sample data, the way the button always has; the emails to pick from load beside it.
  useEffect(() => {
    void run('sample');
    if (startsFromEmail) api.automationTestEmails().then((r) => setEmails(r.emails), () => setEmails([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const from = result?.source === 'email' ? `${result.fields.name || result.fields.email}: “${result.fields.subject ?? ''}”` : 'sample data';
  return (
    <div className="ae-log ae-test" role="log" aria-label="Test run">
      <div className="ae-log-head">
        <FlaskConical size={14} aria-hidden />
        <strong>Test run</strong>
        <span className="muted">Nothing is sent, added or saved.</span>
        <button className="icon-btn sm" aria-label="Close the test run" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="ae-test-pick">
        <label className="ae-test-source">
          <span>Test with</span>
          <select className="input" aria-label="Test with" value={source} onChange={(e) => setSource(e.target.value)} disabled={busy}>
            <option value="sample">Sample data</option>
            {emails.map((e) => (
              <option key={e.id} value={e.id}>
                {e.from}: {e.subject || '(no subject)'}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-sm" onClick={() => void run(source)} disabled={busy}>
          {busy ? 'Testing…' : 'Run the test'}
        </button>
      </div>
      {startsFromEmail && !emails.length && <p className="ae-test-hint">When emails arrive in your mailbox, you can test with one of them here.</p>}
      {problem && (
        <p className="ae-test-problem" role="alert">
          {problem}
        </p>
      )}
      {result && (
        <>
          <p className="ae-test-hint">With {from}:</p>
          <ol className="ae-log-list">
            {result.steps.map((s, i) => (
              <li key={s.id}>
                <span className="ae-log-n">{i + 1}</span>
                <span className="ae-test-step">
                  <span>
                    <strong>{s.label}</strong> {s.text}
                  </span>
                  {s.notYet && <span className="ae-test-notyet">{s.notYet}</span>}
                  {s.wouldAsk && <WouldAsk ask={s.wouldAsk} />}
                </span>
              </li>
            ))}
          </ol>
          <div className={`ae-test-verdict${result.problems.length ? ' blocked' : ''}`}>
            {result.problems.length ? (
              <>
                <strong>
                  <CircleAlert size={13} aria-hidden /> What stops it being switched on
                </strong>
                <ul>
                  {result.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </>
            ) : (
              <span>Nothing stops it being switched on.</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** What a step would put forward in Approvals: shown here only, nothing is recorded. */
function WouldAsk({ ask }: { ask: NonNullable<AutomationTest['steps'][number]['wouldAsk']> }) {
  const email = ask.kind === 'email.reply';
  return (
    <span className="ae-test-ask">
      <span className="ae-test-ask-head">
        {email ? <Mail size={12} aria-hidden /> : <MessageCircleQuestion size={12} aria-hidden />}
        {email ? 'Would wait in Approvals for someone to send it' : 'Would ask in Approvals'}
      </span>
      {email ? (
        <>
          <span>To {ask.to?.join(', ')}</span>
          <span>Subject: {ask.subject}</span>
        </>
      ) : (
        <span>{ask.title}</span>
      )}
      {ask.body && <span className="muted">{ask.body}</span>}
    </span>
  );
}
