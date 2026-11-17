import { Check, CircleDot, Hourglass, Minus, Send, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NOW } from '../data/mock';
import { fmtDay } from '../lib/format';
import { useStore, type ComposeDraft } from '../state/store';
import { firstName, isoDay, parseIsoDay, signOff } from '../state/ws';
import { AttachButton, FileChips } from './Attach';
import { AutoTextarea, PeoplePicker } from './kit';
import { Kbd, TimmyMark } from './common';
import { MicButton } from './Dictation';
import { joinAt } from '../lib/dictation';

const addDays = (n: number) => {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + n);
  return isoDay(d);
};

/** Mirrors Timmy's writing rules: the ask goes in the subject and the first sentence. */
const checksFor = (d: ComposeDraft) => {
  const first = d.body.split(/\n\n+/).find((p) => p.trim() && !/^(hi|hello|hey)\b/i.test(p.trim())) ?? '';
  return [
    { ok: /\b(by|approve|approval|confirm|review|send|could you|can you|\?)/i.test(d.subject), label: 'Action in subject' },
    { ok: /\?|could you|can you|please|confirm/i.test(first), label: 'Ask in first sentence' },
  ];
};

/** The compose window: a new email, optionally tracked in [02] Waiting. */
export function Compose() {
  const { state, dispatch } = useStore();
  const draft = state.compose!;
  const [min, setMin] = useState(false);
  const [showCc, setShowCc] = useState(!!draft.cc?.length);
  const [attaching, setAttaching] = useState(false);
  const subjectRef = useRef<HTMLInputElement>(null);
  const set = (change: Partial<ComposeDraft>) => dispatch({ type: 'compose', draft: { ...draft, ...change } });
  const tracking = !!draft.track;
  const projects = Object.values(state.ws.projects).filter((p) => p.status === 'active');

  useEffect(() => {
    if (draft.to.length && !draft.subject) subjectRef.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => dispatch({ type: 'compose', draft: null });

  // Dictated text goes in at the cursor, or at the end if you haven't clicked into the message.
  const caret = useRef<[number, number] | null>(null);
  const dictate = (said: string) => {
    const [start, end] = caret.current ?? [draft.body.length, draft.body.length];
    const next = joinAt(draft.body, start, end, said);
    set({ body: next.value });
    caret.current = [next.caret, next.caret];
    requestAnimationFrame(() => {
      const el = document.getElementById('compose-body') as HTMLTextAreaElement | null;
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  };

  const askTimmy = () => {
    const to = draft.to[0];
    const project = draft.project ? state.ws.projects[draft.project] : undefined;
    const due = draft.track?.due ? fmtDay(parseIsoDay(draft.track.due)) : null;
    const ask = draft.subject.trim() ? `could you ${draft.subject.trim().replace(/^[A-Z]/, (c) => c.toLowerCase()).replace(/\?$/, '')}` : 'could you take a look at the note below';
    const lines = [
      `Hi ${to && !firstName(to).includes('@') ? firstName(to) : 'there'},`,
      `${ask.charAt(0).toUpperCase()}${ask.slice(1)}${due ? ` by ${due}` : ''}?`,
      project?.goal ? `For context: ${project.goal}` : '',
      signOff('Best'),
    ].filter(Boolean);
    set({ body: lines.join('\n\n') });
  };

  const canSend = draft.to.length > 0 && (draft.subject.trim() || draft.body.trim());

  if (min) {
    return (
      <div className="compose compose-min" role="dialog" aria-label="New message (minimised)">
        <button className="compose-head" onClick={() => setMin(false)}>
          <strong>{draft.subject || 'New message'}</strong>
        </button>
        <button className="icon-btn sm" aria-label="Close" onClick={close}>
          <X size={15} />
        </button>
      </div>
    );
  }

  return (
    <section className="compose" role="dialog" aria-label="New message">
      <header className="compose-bar">
        <strong>{draft.subject ? draft.subject : 'New message'}</strong>
        <div style={{ display: 'flex', gap: 2 }}>
          <button className="icon-btn sm" aria-label="Minimise" onClick={() => setMin(true)}>
            <Minus size={15} />
          </button>
          <button className="icon-btn sm" aria-label="Close" onClick={close}>
            <X size={15} />
          </button>
        </div>
      </header>

      <div className="compose-fields">
        <div className="compose-field">
          <span className="draft-label">To</span>
          <PeoplePicker value={draft.to} onChange={(to) => set({ to })} placeholder="Name or email" />
          {!showCc && (
            <button className="btn btn-xs btn-ghost" onClick={() => setShowCc(true)}>
              Cc
            </button>
          )}
        </div>
        {showCc && (
          <div className="compose-field">
            <span className="draft-label">Cc</span>
            <PeoplePicker value={draft.cc ?? []} onChange={(cc) => set({ cc })} placeholder="Add people" />
          </div>
        )}
        <label className="compose-field">
          <span className="draft-label">Subject</span>
          <input ref={subjectRef} className="draft-subject" value={draft.subject} onChange={(e) => set({ subject: e.target.value })} placeholder="Put the ask here, e.g. Approval by Fri: Q1 budget" />
        </label>
      </div>

      <AutoTextarea
        id="compose-body"
        className="compose-body"
        minRows={7}
        value={draft.body}
        onChange={(e) => set({ body: e.target.value })}
        onSelect={(e) => (caret.current = [e.currentTarget.selectionStart, e.currentTarget.selectionEnd])}
        placeholder="Lead with the ask in the first sentence. Context goes below."
        aria-label="Message"
      />

      <div className="compose-track">
        <button className="switch" role="switch" aria-checked={tracking} aria-label="Track the reply in Waiting" onClick={() => set({ track: tracking ? null : { on: draft.to[0], item: '', due: addDays(4) } })} />
        <div className="compose-track-text">
          <span className="compose-track-title">
            <Hourglass size={13} />
            Track in [02] Waiting
          </span>
          {!tracking && <span className="muted">Keep this thread in Waiting until they send what you asked for.</span>}
          {tracking && (
            <div className="compose-track-fields">
              <input
                className="input"
                value={draft.track!.item}
                onChange={(e) => set({ track: { ...draft.track!, item: e.target.value } })}
                placeholder="What they owe you, e.g. Signed order form"
                aria-label="What they owe you"
              />
              <input
                className="input"
                type="date"
                value={draft.track!.due ?? ''}
                min={isoDay(NOW)}
                onChange={(e) => set({ track: { ...draft.track!, due: e.target.value } })}
                aria-label="Promised by"
              />
              {draft.to.length > 1 && (
                <select className="input" value={draft.track!.on ?? draft.to[0]} onChange={(e) => set({ track: { ...draft.track!, on: e.target.value } })} aria-label="Who owes it">
                  {draft.to.map((id) => (
                    <option key={id} value={id}>
                      {firstName(id)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="draft-checks">
        {checksFor(draft).map((c) => (
          <span key={c.label} className={c.ok ? 'ok' : ''}>
            {c.ok ? <Check size={12} strokeWidth={3} /> : <CircleDot size={12} />}
            {c.label}
          </span>
        ))}
        <label className="compose-project">
          <span className="muted">Project</span>
          <select className="input" value={draft.project ?? ''} onChange={(e) => set({ project: e.target.value || undefined })}>
            <option value="">None</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                [{p.num}] {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <FileChips files={draft.files} onRemove={(i) => set({ files: (draft.files ?? []).filter((_, at) => at !== i) })} className="chips compose-files" />

      <footer className="compose-foot">
        <button className="btn btn-sm btn-ghost" onClick={close}>
          <Trash2 size={14} />
          Discard
        </button>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <AttachButton files={draft.files ?? []} onChange={(files) => set({ files })} onBusy={setAttaching} />
          {!canSend && (
            <span className="compose-why" role="status">
              {!draft.to.length ? 'Add a recipient: someone in People or any email address.' : 'Add a subject or a message.'}
            </span>
          )}
          <MicButton onText={dictate} label="Dictate the message" />
          <button className="btn btn-sm" onClick={askTimmy} disabled={!draft.to.length}>
            <TimmyMark size={16} muted />
            Ask Timmy to draft
          </button>
          <button
            className="btn btn-sm btn-primary"
            // A file still on its way up would be left behind, so Send waits for it.
            disabled={!canSend || attaching || (tracking && !draft.track?.item.trim())}
            onClick={() => dispatch({ type: 'sendNew', draft })}
            title={tracking && !draft.track?.item.trim() ? 'Say what they owe you first' : undefined}
          >
            <Send size={14} />
            {tracking ? 'Send & track' : 'Send'}
            <Kbd>⌘↵</Kbd>
          </button>
        </div>
      </footer>
      <SendShortcut onSend={() => canSend && !attaching && (!tracking || draft.track?.item.trim()) && dispatch({ type: 'sendNew', draft })} />
    </section>
  );
}

function SendShortcut({ onSend }: { onSend: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        onSend();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSend]);
  return null;
}
