/**
 * The Feedback button: a few words to the people who run Timmy, from any screen (server/src/http/feedback.ts).
 * It sends the screen's name with it (which view, which tab), never what was on the screen.
 */
import { MessageSquareText } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { AutoTextarea, Modal } from '../components/kit';
import { useStore } from '../state/store';
import { isLive } from './clock';

/** "today/triage", "thread/conversation", "rules/approvals": which screen, nothing more. */
function pageOf(route: { view: string; tab?: string }): string {
  return [route.view, route.tab].filter(Boolean).join('/').slice(0, 120);
}

export function FeedbackDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async () => {
    if (text.trim().length < 2) return setError('Write a few words first.');
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/v1/feedback', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text.trim(), page: pageOf(state.route as { view: string; tab?: string }) }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'That didn’t send. Try again.');
      setText('');
      onClose();
      dispatch({ type: 'toast', text: 'Thanks! Your feedback reached the Timmy team.' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Send feedback"
      description="Something broken, confusing, or missing? Tell the Timmy team. The name of the screen you're on goes with it, nothing that's on it."
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || text.trim().length < 2} onClick={() => void send()}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Your feedback</span>
        <AutoTextarea className="input" minRows={5} maxLength={5000} value={text} onChange={(e) => setText(e.target.value)} placeholder="What happened, or what would make Timmy better?" autoFocus />
      </label>
      {error && (
        <p className="live-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

/** The button, in whatever shape its place needs; only on a real workspace (the demo has no one to send it to). */
export function FeedbackButton({ className, children, label = 'Send feedback' }: { className: string; children?: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  if (!isLive()) return null;
  return (
    <>
      <button className={className} aria-label={label} onClick={() => setOpen(true)}>
        {children ?? <MessageSquareText size={20} />}
      </button>
      <FeedbackDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
