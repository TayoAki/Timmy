/*
 * Every Send button for a prepared draft goes through here, so sending from
 * the chat, the Drafts tab or a list behaves like Approvals: you see what goes
 * out and what else it settles before it leaves. A draft with nothing riding
 * on it sends in one click where you can already read it.
 */
import { Send } from 'lucide-react';
import { useState } from 'react';
import type { Thread } from '../data/types';
import { draftNotes } from '../state/approvals';
import { useStore } from '../state/store';
import { personName } from '../state/ws';
import { ApprovalNotes } from '../areas/approvals/ApprovalCard';
import { Modal } from './kit';

const lowerFirst = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);

export function SendDraftButton({ t, size = 'sm', label, preview = false }: { t: Thread; size?: 'xs' | 'sm'; label?: string; preview?: boolean }) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const d = t.draft;
  if (!d) return null;
  const notes = draftNotes(state, t);
  const settles = state.decisions.find((x) => x.whileDraft && x.thread === t.id && !x.chosen);
  const choice = settles?.options.find((o) => o.primary);
  // Where the body isn't on screen (a list, a chat line), always show it first.
  const check = preview || notes.length > 0;
  const name = label ?? (d.trackAs ? 'Send & track' : d.kind === 'nudge' ? 'Send nudge' : 'Send');
  const send = () => {
    dispatch({ type: 'sendDraft', id: t.id, track: true });
    setOpen(false);
  };
  return (
    <>
      <button className={`btn btn-${size} btn-primary`} onClick={() => (check ? setOpen(true) : send())} aria-haspopup={check ? 'dialog' : undefined}>
        <Send size={size === 'xs' ? 12 : 13} />
        {check ? `${name}…` : name}
      </button>
      {open && (
        <Modal
          open
          onClose={() => setOpen(false)}
          title={`Send to ${d.to.map((p) => personName(p).split(' ')[0]).join(', ')}?`}
          description="Check what goes out before it leaves. Nothing is sent until you press Send."
          width={560}
          footer={
            <>
              <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="btn btn-sm" onClick={() => (setOpen(false), dispatch({ type: 'openThread', id: t.id }))}>
                Edit first
              </button>
              {settles && (
                <button className="btn btn-sm" onClick={() => (setOpen(false), dispatch({ type: 'navigate', route: { view: 'approvals', tab: 'open' } }))}>
                  Decide first
                </button>
              )}
              <button className="btn btn-sm btn-primary" onClick={send} data-autofocus>
                <Send size={13} />
                {choice ? `Send and ${lowerFirst(choice.label)}` : name}
              </button>
            </>
          }
        >
          <div className="send-check">
            <p className="send-check-subject">
              <span className="muted">Subject</span> {d.subject}
            </p>
            <div className="send-check-body">
              {d.body.split(/\n\n+/).map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
            <ApprovalNotes notes={notes} />
          </div>
        </Modal>
      )}
    </>
  );
}
