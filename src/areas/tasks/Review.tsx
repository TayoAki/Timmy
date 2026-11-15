import { Archive, BookOpen, CalendarClock, CalendarPlus, CheckCheck, FileText, Lightbulb, ListChecks, MessageSquarePlus, Sparkles } from 'lucide-react';
import { useCallback, useState } from 'react';
import { EmptyState } from '../../components/kit';
import { NOW } from '../../data/mock';
import type { QuickNote, WS } from '../../data/ws-types';
import { fmtDay, fmtStamp } from '../../lib/format';
import { useStore, ws } from '../../state/store';
import { firstName, isoDay, patch, type WsOp } from '../../state/ws';
import { BlockTimeDialog } from '../calendar/BlockTimeDialog';
import { fmtRange, nextOneOnOne, rowLabel, showEvent, withTopic } from '../calendar/shared';
import { NewDocDialog } from '../docs/NewDocDialog';
import { reviewQueue } from './bits';
import { TaskDialog } from './TaskDialog';

type Action = 'task' | 'doc' | 'block' | 'agenda';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** People in the next 1:1 that a note mentions by first name. */
const mentions = (note: QuickNote, people: string[]) =>
  people.filter((p) => new RegExp(`\\b${escape(firstName(p))}\\b`, 'i').test(note.text));

/** "Ask Priya about timing for X" → "Timing for X". */
const topicFrom = (text: string, people: string[]) => {
  let t = text.trim().replace(/[.?!]+$/, '');
  for (const p of people) {
    t = t.replace(new RegExp(`^(ask|tell|check with|raise with|discuss with|talk to)\\s+${escape(firstName(p))}\\s+(about|for|whether|if|on)?\\s*`, 'i'), '');
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** The 1:1 agenda change for a note, or null when there is no 1:1 doc. */
const agendaOps = (state: WS, note: QuickNote): { ops: WsOp[]; where: string } | null => {
  const one = nextOneOnOne(state);
  if (!one) return null;
  const topic = topicFrom(note.text, one.ev.with);
  return {
    ops: [patch('docs', one.doc.id, { blocks: withTopic(one.doc, rowLabel(one.ev), topic) }), patch('files', one.doc.id, { updated: NOW })],
    where: `your 1:1 with ${one.ev.with.map(firstName).join(', ')}, ${fmtDay(one.ev.start)}`,
  };
};

export function Review() {
  const { state, dispatch } = useStore();
  const queue = reviewQueue(state.ws);
  const [startCount] = useState(queue.length);
  const [active, setActive] = useState<{ note: QuickNote; action: Exclude<Action, 'agenda'> } | null>(null);
  const [alsoAgenda, setAlsoAgenda] = useState(true);
  const one = nextOneOnOne(state.ws);
  const review = Object.values(state.ws.events)
    .filter((e) => e.kind === 'review' && e.end > NOW)
    .sort((a, b) => a.start.getTime() - b.start.getTime())[0];

  const close = useCallback(() => setActive(null), []);
  const done = Math.max(0, startCount - queue.length);

  const suggest = (n: QuickNote): Action => {
    if (one && mentions(n, one.ev.with).length) return 'agenda';
    if (n.kind === 'note') return 'doc';
    return 'task';
  };

  const archive = (n: QuickNote) => dispatch(ws([patch('notes', n.id, { processed: 'archived' })], { toast: 'Note archived', undo: true }));

  const toAgenda = (n: QuickNote) => {
    const a = agendaOps(state.ws, n);
    if (!a) return;
    dispatch(ws([...a.ops, patch('notes', n.id, { processed: 'archived' })], { toast: `Added to the agenda for ${a.where}`, undo: true }));
  };

  const activeAgenda = active?.action === 'block' && suggest(active.note) === 'agenda' ? agendaOps(state.ws, active.note) : null;

  return (
    <>
      <div className="tk-review-head">
        <p className="tk-progress" role="status">
          <strong className="mono">{queue.length}</strong> left
          {done > 0 && <span className="muted"> · {done} processed this session</span>}
        </p>
        {startCount > 0 && (
          <div className="tk-meter" aria-hidden>
            <span style={{ width: `${(done / startCount) * 100}%` }} />
          </div>
        )}
      </div>

      {review && (
        <div className="tk-review-cal">
          <CalendarClock size={16} aria-hidden />
          <p>
            Your weekly review is on the calendar: <strong>{fmtDay(review.start)}, {fmtRange(review.start, review.end)}</strong>. Its invite links back here.
          </p>
          <button className="btn btn-sm" onClick={() => showEvent(dispatch, review)}>
            Open event
          </button>
        </div>
      )}

      {queue.length === 0 ? (
        <EmptyState
          icon={CheckCheck}
          title="Review queue is clear"
          body="Every captured thought and note has a home. Press ⌘J the next time an idea shows up."
          action={
            <button className="btn btn-sm" onClick={() => dispatch({ type: 'navigate', route: { view: 'tasks', tab: 'board' } })}>
              Back to the board
            </button>
          }
        />
      ) : (
        <ol className="tk-queue">
          {queue.map((n) => {
            const s = suggest(n);
            const cls = (a: Action) => `btn btn-sm${s === a ? ' btn-primary' : ''}`;
            return (
              <li key={n.id} className="tk-note">
                <div className="tk-note-meta">
                  <span className={`chip tk-kind tk-kind-${n.kind}`}>
                    {n.kind === 'thought' ? <Lightbulb size={12} /> : <BookOpen size={12} />}
                    {n.kind === 'thought' ? 'Thought' : 'Note'}
                  </span>
                  {n.source && <span className="tk-note-source">from {n.source}</span>}
                  <span className="tk-note-time">Captured {fmtStamp(n.created)}</span>
                </div>
                <p className="tk-note-text">{n.text}</p>
                <p className="timmy-line tk-note-why">
                  <Sparkles size={13} />
                  {s === 'agenda'
                    ? `Mentions ${mentions(n, one!.ev.with).map(firstName).join(', ')}. Add it to the 1:1 agenda, and block prep time if it needs some.`
                    : s === 'doc'
                      ? 'Information from a source. Keep it as a permanent note you can search later.'
                      : 'Sounds like something to do. Make it a task with a project and a date.'}
                </p>
                <div className="tk-note-actions">
                  <button className={cls('task')} onClick={() => setActive({ note: n, action: 'task' })}>
                    <ListChecks size={14} />
                    Make it a task
                  </button>
                  <button className={cls('doc')} onClick={() => setActive({ note: n, action: 'doc' })}>
                    <FileText size={14} />
                    Save as note
                  </button>
                  <button className="btn btn-sm" onClick={() => (setAlsoAgenda(true), setActive({ note: n, action: 'block' }))}>
                    <CalendarPlus size={14} />
                    Block time
                  </button>
                  <button className={cls('agenda')} disabled={!one} onClick={() => toAgenda(n)}>
                    <MessageSquarePlus size={14} />
                    Add to 1:1 agenda
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => archive(n)}>
                    <Archive size={14} />
                    Archive
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <TaskDialog
        open={active?.action === 'task'}
        onClose={close}
        initial={active ? { title: active.note.text, notes: active.note.source ? `From ${active.note.source}` : undefined } : undefined}
        extraOps={active ? [patch('notes', active.note.id, { processed: 'task' })] : []}
        savedToast="Task added and cleared from the queue"
      />

      <NewDocDialog
        open={active?.action === 'doc'}
        onClose={close}
        initial={active ? { title: `${isoDay(active.note.created)} ${clip(active.note.text, 56)}`, template: 'private-notes' } : undefined}
        onCreated={() => active && dispatch(ws([patch('notes', active.note.id, { processed: 'note' })]))}
      />

      <BlockTimeDialog
        open={active?.action === 'block'}
        onClose={close}
        title={active ? (activeAgenda ? `Prep: ${topicFrom(active.note.text, one!.ev.with)}` : active.note.text) : ''}
        minutes={30}
        extraOps={active ? [patch('notes', active.note.id, { processed: 'calendar' }), ...(activeAgenda && alsoAgenda ? activeAgenda.ops : [])] : []}
        toastSuffix={activeAgenda && alsoAgenda ? ' · added to the 1:1 agenda' : ''}
      >
        {activeAgenda && (
          <label className="tk-check">
            <input type="checkbox" checked={alsoAgenda} onChange={(e) => setAlsoAgenda(e.target.checked)} />
            <span>
              Also add “{clip(topicFrom(active!.note.text, one!.ev.with), 60)}” to the agenda for {activeAgenda.where}
            </span>
          </label>
        )}
      </BlockTimeDialog>
    </>
  );
}
