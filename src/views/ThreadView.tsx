import {
  Archive,
  ArrowLeft,
  BookOpen,
  CalendarPlus,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  FlaskConical,
  Hourglass,
  ListChecks,
  ListPlus,
  NotebookPen,
  Paperclip,
  Reply,
  ReplyAll,
  Send,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NOW, PEOPLE } from '../data/mock';
import { decisionOps, firstName, isoDay, patch, pathOf, signOff } from '../state/ws';
import { BlockTimeDialog } from '../areas/calendar/BlockTimeDialog';
import { TaskDialog } from '../areas/tasks/TaskDialog';
import { AutoTextarea, Field, Modal } from '../components/kit';
import type { Box, Draft, MailFile, Thread } from '../data/types';
import { AttachButton, FileChips } from '../components/Attach';
import { ProjectPicker } from '../components/ProjectPicker';
import { EmailBody } from '../components/EmailBody';
import { fmtDay, fmtStamp } from '../lib/format';
import { acmeSeatPrice, counterpart, labelOf, useStore, ws, type ThreadTab } from '../state/store';
import { Avatar, Kbd, ThreadChips, TimmyMark } from '../components/common';
import { DocIcon, DocPath, DocThumb } from '../components/DocBits';
import { Frame } from '../components/Frame';
import { UrgencyLine } from '../components/Urgency';
import { MicButton } from '../components/Dictation';
import { joinAt } from '../lib/dictation';
import { ApprovalCard, ApprovalNotes } from '../areas/approvals/ApprovalCard';
import { draftNotes, openApprovals } from '../state/approvals';
import { isLive } from '../live/clock';
import { api } from '../live/api';

const MOVES: { box: Box; key: string; label: string; icon: ReactNode }[] = [
  { box: 'follow-up', key: 'f', label: 'Follow Up', icon: <Reply size={15} /> },
  { box: 'waiting', key: 'w', label: 'Waiting', icon: <Hourglass size={15} /> },
  { box: 'read-through', key: 'r', label: 'Read Through', icon: <BookOpen size={15} /> },
  { box: 'archived', key: 'e', label: 'Archive', icon: <Archive size={15} /> },
];

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

export function ThreadView({ id, tab }: { id: string; tab: ThreadTab }) {
  const { state, dispatch } = useStore();
  const t = state.threads.find((x) => x.id === id);
  // The reply box starts open (no-reply senders excepted); pressing Reply or A also focuses it.
  const [replying, setReplying] = useState(() => !!t && !PEOPLE[counterpart(t)]?.bot);
  const [focusReply, setFocusReply] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!t || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey || state.searchOpen) return;
      const move = MOVES.find((m) => m.key === e.key.toLowerCase());
      if (move) {
        e.preventDefault();
        dispatch({ type: 'move', id: t.id, box: move.box });
      } else if (e.key.toLowerCase() === 's') {
        dispatch({ type: 'toggleStar', id: t.id });
      } else if (e.key.toLowerCase() === 'd' && !t.draft) {
        dispatch({ type: 'makeDraft', id: t.id });
      } else if (e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setReplying(true);
        setFocusReply(true);
      } else if (e.key === 'Escape') {
        dispatch({ type: 'back' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [t, dispatch, state.searchOpen]);

  if (!t) return null;
  const label = labelOf(t.box);

  return (
    <Frame
      tabs={[
        { id: 'conversation', label: 'Conversation', count: t.messages.length },
        { id: 'links', label: 'Files & links', count: t.docs?.length ?? 0 },
        { id: 'history', label: 'Timmy’s log', count: t.history?.length ?? 0 },
      ]}
      active={tab}
      onTab={(x) => dispatch({ type: 'openThread', id: t.id, tab: x as ThreadTab })}
      scrollKey={`${t.id}-${tab}`}
    >
      <nav className="crumbs" aria-label="Breadcrumb">
        <button className="btn btn-xs btn-ghost" onClick={() => dispatch({ type: 'back' })} style={{ marginLeft: -8 }}>
          <ArrowLeft size={14} />
          Back
        </button>
        <span>Mail</span>
        <ChevronRight size={14} aria-hidden />
        <button onClick={() => dispatch({ type: 'navigate', route: { view: 'box', box: t.box, tab: 'all' } })}>
          [{label.num}] {label.name}
        </button>
      </nav>

      <div className="thread-head">
        <h1 className="thread-title">{t.subject}</h1>
        <ProjectPicker t={t} hotkey />
        <button
          className={`icon-btn${t.starred ? ' on' : ''}`}
          aria-label={t.starred ? 'Unstar (S)' : 'Star (S)'}
          title="Star (S)"
          onClick={() => dispatch({ type: 'toggleStar', id: t.id })}
        >
          <Star size={18} fill={t.starred ? 'currentColor' : 'none'} />
        </button>
      </div>
      <ThreadChips t={t} showProject={false} />
      <UrgencyLine t={t} />

      <div className="move-bar" role="group" aria-label="Move thread">
        {MOVES.map((m) => (
          <button
            key={m.box}
            className={`move-btn${t.box === m.box ? ' current' : ''}`}
            style={{ ['--tint' as string]: labelOf(m.box).color }}
            onClick={() => dispatch({ type: 'move', id: t.id, box: m.box })}
            aria-pressed={t.box === m.box}
          >
            {m.icon}
            <span>{m.label}</span>
            <Kbd>{m.key.toUpperCase()}</Kbd>
          </button>
        ))}
      </div>

      <ThreadActions t={t} onReply={() => (setReplying(true), setFocusReply(true), dispatch({ type: 'openThread', id: t.id, tab: 'conversation' }))} />

      {tab === 'conversation' && (
        <Conversation t={t} replying={replying} focusReply={focusReply} onReplyDone={() => (setReplying(false), setFocusReply(false))} />
      )}
      {tab === 'links' && <Links t={t} />}
      {tab === 'history' && <History t={t} />}
    </Frame>
  );
}

/** Decisions Timmy needs from you before this thread can move. */
function ThreadDecisions({ t }: { t: Thread }) {
  const { state } = useStore();
  const items = openApprovals(state).filter((a) => a.thread === t.id && a.kind !== 'email');
  if (!items.length) return null;
  return (
    <section className="thread-decisions" aria-label="Decisions for this thread">
      {items.map((a) => (
        <ApprovalCard key={a.key} a={a} inThread />
      ))}
    </section>
  );
}

function Summary({ t }: { t: Thread }) {
  return (
    <section className="summary">
      <TimmyMark size={30} />
      <div className="summary-body">
        <p className="summary-ask">{t.ask}</p>
        {t.context && <p className="summary-context">{t.context}</p>}
      </div>
    </section>
  );
}

function Conversation({ t, replying, focusReply, onReplyDone }: { t: Thread; replying: boolean; focusReply: boolean; onReplyDone: () => void }) {
  const { state } = useStore();
  // Who someone is, in full: their name, and the address the mail really came from or went to.
  const myAddress = state.conn.apps.gmail?.account ?? state.conn.apps.outlook?.account ?? PEOPLE.me?.email ?? '';
  const addressOf = (id: string) => (id === 'me' ? myAddress : PEOPLE[id]?.email || (id.startsWith('mail:') ? id.slice(5) : ''));
  const nameOf = (id: string) => (id === 'me' ? 'me' : PEOPLE[id]?.name || addressOf(id) || id);
  // The whole thread is shown; earlier messages can be folded away.
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const lastId = t.messages[t.messages.length - 1]!.id;

  return (
    <>
      <Summary t={t} />
      <div className="messages">
        {t.messages.map((m) => {
          const open = m.id === lastId || !collapsed.includes(m.id);
          const fromMe = m.from === 'me';
          return (
            <article key={m.id} className={`msg${open ? '' : ' collapsed'}`}>
              <button
                className="msg-head"
                onClick={() => setCollapsed((x) => (x.includes(m.id) ? x.filter((y) => y !== m.id) : [...x, m.id]))}
                disabled={m.id === lastId}
                aria-expanded={open}
                title={m.id === lastId ? undefined : open ? 'Fold this message' : 'Show this message'}
              >
                <Avatar id={m.from} size={32} />
                <div className="msg-who">
                  <span className="msg-from-line">
                    <span className="row-from">{fromMe ? 'You' : nameOf(m.from)}</span>
                    {addressOf(m.from) && <span className="msg-addr">&lt;{addressOf(m.from)}&gt;</span>}
                  </span>
                  {!open && <span className="row-company">{m.body.join(' ').replace(/\n/g, ' ').slice(0, 90)}</span>}
                </div>
                <span className="row-time" title={fmtFull(m.at)}>
                  {fmtStamp(m.at)}
                </span>
              </button>
              {open && (
                <div className="msg-body">
                  <MessageDetails t={t} m={m} nameOf={nameOf} addressOf={addressOf} />
                  <EmailBody t={t} m={m} />
                  {m.attachments && (
                    <div className="chips" style={{ marginTop: 12 }}>
                      {m.attachments.map((id) => (
                        <span key={id} className="chip">
                          <Paperclip size={12} />
                          {/* On a real workspace a synced message names its attachments by file name, not by a file in Timmy. */}
                          {state.ws.files[id]?.name ?? id}
                        </span>
                      ))}
                    </div>
                  )}
                  <FileChips files={m.files} className="chips msg-files" />
                </div>
              )}
            </article>
          );
        })}
      </div>
      <ThreadTodos t={t} />
      {t.suggestion?.extra && t.project && t.box === 'inbox' && <ArrivedCard t={t} />}
      <ThreadDecisions t={t} />
      {t.draft && <DraftCard t={t} draft={t.draft} />}
      {replying && !t.draft && <ReplyBox t={t} onDone={onReplyDone} autoFocus={focusReply} />}
    </>
  );
}

/** The to-dos that came from this thread (Timmy's from what it asks, and any made by hand), to check off here. */
function ThreadTodos({ t }: { t: Thread }) {
  const { state, dispatch } = useStore();
  const [making, setMaking] = useState(false);
  const todos = Object.values(state.ws.tasks)
    .filter((x) => x.thread === t.id)
    .sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || +new Date(a.created) - +new Date(b.created));
  // On a real workspace Timmy can make one from what the email asks, on request (server/src/agent/todo.ts).
  const canMake = isLive();
  if (!todos.length && !canMake) return null;
  const open = todos.filter((x) => x.status !== 'done').length;
  const make = async () => {
    setMaking(true);
    try {
      const r = await api.todoFromEmail(t.id);
      const project = r.task.project ? state.ws.projects[r.task.project] : undefined;
      dispatch({ type: 'toast', text: `To-do added: ${r.task.title}${project ? ` (in ${project.name})` : ''}` });
    } catch (e) {
      dispatch({ type: 'toast', text: (e as Error).message, tone: 'warn' });
    } finally {
      setMaking(false);
    }
  };
  return (
    <section className="thread-todos" aria-label="To-dos from this email">
      <h3>
        <ListChecks size={14} aria-hidden /> To-dos {todos.length ? open ? <span className="muted">{open} open</span> : <span className="muted">all done</span> : null}
        {canMake && (
          <button type="button" className="btn btn-xs btn-ghost thread-todo-make" disabled={making} onClick={() => void make()} title="Timmy reads the email and adds what it asks of you to Tasks, in this email’s project">
            <Sparkles size={12} aria-hidden /> {making ? 'Reading…' : 'Make a to-do'}
          </button>
        )}
      </h3>
      <ul>
        {todos.map((x) => (
          <li key={x.id} data-done={x.status === 'done' || undefined}>
            <label>
              <input
                type="checkbox"
                checked={x.status === 'done'}
                onChange={(e) => dispatch(ws([patch('tasks', x.id, { status: e.target.checked ? 'done' : 'todo' })], { toast: e.target.checked ? `Done: ${x.title}` : `Back on your list: ${x.title}`, undo: true }))}
              />
              <span className="thread-todo-title">{x.title}</span>
            </label>
            {x.due && <span className="thread-todo-due">due {fmtDay(new Date(x.due))}</span>}
            {x.by === 'timmy' && (
              <span className="thread-todo-by" title="Timmy added this from what the email asked">
                <Sparkles size={11} aria-hidden /> Timmy
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "to me, Sam ▾" under the sender, and Gmail's details when it is opened: every address, the date and the subject. */
function MessageDetails({ t, m, nameOf, addressOf }: { t: Thread; m: Thread['messages'][number]; nameOf: (id: string) => string; addressOf: (id: string) => string }) {
  const [open, setOpen] = useState(false);
  const short = (id: string) => (id === 'me' ? 'me' : nameOf(id).split(' ')[0]);
  const full = (id: string) => {
    const address = addressOf(id);
    const name = id === 'me' ? 'me' : nameOf(id);
    return address && name !== address ? `${name} <${address}>` : name;
  };
  const to = m.to.map(short).join(', ');
  return (
    <div className="msg-meta">
      <button type="button" className="msg-to" aria-expanded={open} onClick={() => setOpen((x) => !x)} title="Show details">
        to {to || 'undisclosed recipients'}
        {m.cc?.length ? `, cc ${m.cc.map(short).join(', ')}` : ''}
        <ChevronDown size={13} aria-hidden className={open ? 'msg-to-open' : undefined} />
      </button>
      {open && (
        <dl className="msg-details">
          <dt>from</dt>
          <dd>{full(m.from)}</dd>
          <dt>to</dt>
          <dd>{m.to.map(full).join(', ') || 'undisclosed recipients'}</dd>
          {m.cc?.length ? (
            <>
              <dt>cc</dt>
              <dd>{m.cc.map(full).join(', ')}</dd>
            </>
          ) : null}
          <dt>date</dt>
          <dd>{fmtFull(m.at)}</dd>
          <dt>subject</dt>
          <dd>{t.subject}</dd>
        </dl>
      )}
    </div>
  );
}

/** "Tuesday, November 17, 2026 at 3:12 PM" */
const fmtFull = (d: Date) => new Date(d).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/* ───────────── Actions that connect mail to tasks, calendar and projects ───────────── */

const recapBody = (t: Thread) => {
  const open = (t.steps ?? []).filter((s) => !s.done).map((s) => `• ${s.text}`);
  return [
    'Hi all,',
    `Where things stand: ${t.ask}.`,
    open.length ? `Open actions:\n${open.join('\n')}` : 'No open actions.',
    t.context ? `Background: ${t.context}` : '',
    signOff('Best'),
  ]
    .filter(Boolean)
    .join('\n\n');
};

function ThreadActions({ t, onReply }: { t: Thread; onReply: () => void }) {
  const { state, dispatch } = useStore();
  const [taskOpen, setTaskOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const project = t.project ? state.ws.projects[t.project] : undefined;
  const linkedTask = Object.values(state.ws.tasks).find((x) => x.thread === t.id && x.status !== 'done');
  const others = t.participants.filter((p) => p !== 'me');

  return (
    <div className="thread-actions" role="group" aria-label="Thread actions">
      <button className="btn btn-sm" onClick={onReply}>
        <Reply size={14} />
        Reply
        <Kbd>A</Kbd>
      </button>
      {!t.draft && (
        <button className="btn btn-sm" onClick={() => dispatch({ type: 'makeDraft', id: t.id })}>
          <Sparkles size={14} />
          Ask Timmy to draft
          <Kbd>D</Kbd>
        </button>
      )}
      {t.messages.length > 1 && others.length > 0 && (
        <button
          className="btn btn-sm btn-ghost"
          onClick={() =>
            dispatch({ type: 'compose', draft: { to: others, subject: `Recap: ${t.subject.replace(/^Re:\s*/, '')}`, body: recapBody(t), project: t.project } })
          }
        >
          <ReplyAll size={14} />
          Send a recap
        </button>
      )}
      <span className="thread-actions-sep" aria-hidden />
      {linkedTask ? (
        <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'navigate', route: { view: 'tasks', tab: 'board', project: linkedTask.project } })}>
          <ListChecks size={14} />
          Task: {linkedTask.title}
        </button>
      ) : (
        <button className="btn btn-sm btn-ghost" onClick={() => setTaskOpen(true)}>
          <ListPlus size={14} />
          Create task
        </button>
      )}
      <button className="btn btn-sm btn-ghost" onClick={() => setBlockOpen(true)}>
        <CalendarPlus size={14} />
        Block time
      </button>
      {project?.notesDoc && (
        <button className="btn btn-sm btn-ghost" onClick={() => setDecisionOpen(true)}>
          <NotebookPen size={14} />
          Record decision
        </button>
      )}
      {t.box === 'waiting' && t.waiting && (
        <button className="btn btn-sm btn-ghost demo-btn" onClick={() => dispatch({ type: 'simulateReply', id: t.id })} title="Demo only: pretend the reply arrived">
          <FlaskConical size={14} />
          Demo: {firstName(t.waiting.on)} replies
        </button>
      )}

      <TaskDialog
        open={taskOpen}
        onClose={() => setTaskOpen(false)}
        initial={{ title: t.ask.replace(/ by (Mon|Tue|Wed|Thu|Fri|Sat|Sun),.*$/, ''), thread: t.id, project: t.project, due: t.due, contact: counterpart(t), priority: t.effort === 'focus' ? 'high' : 'normal' }}
      />
      <BlockTimeDialog
        open={blockOpen}
        onClose={() => setBlockOpen(false)}
        title={t.subject.replace(/^Re:\s*/, '')}
        thread={t.id}
        task={linkedTask?.id}
        minutes={t.effort === 'focus' ? 90 : t.effort === 'quick' ? 15 : 60}
      />
      {project && (
        <DecisionDialog open={decisionOpen} onClose={() => setDecisionOpen(false)} t={t} projectName={`[${project.num}] ${project.name}`} />
      )}
    </div>
  );
}

function DecisionDialog({ open, onClose, t, projectName, archive }: { open: boolean; onClose: () => void; t: Thread; projectName: string; archive?: boolean }) {
  const { state, dispatch } = useStore();
  const last = t.messages[t.messages.length - 1]!;
  const suggested =
    t.id === 'acme-quote' && last.from !== 'me' ? `CFO approved 120 seats at $${acmeSeatPrice(state)} per seat; order form next` : last.body.find((p) => !/^(hi|hello|thanks)/i.test(p))?.slice(0, 120) ?? '';
  const [text, setText] = useState(suggested);
  useEffect(() => setText(suggested), [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => {
    if (!text.trim() || !t.project) return;
    dispatch(ws(decisionOps(state.ws, t.project, text.trim(), `Email: ${t.subject}`), { toast: `Recorded in ${projectName} running notes`, undo: true, log: `Recorded a decision for ${projectName}` }));
    if (archive) dispatch({ type: 'move', id: t.id, box: 'archived', quiet: true });
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a decision"
      description={`Adds a dated row to the top of the ${projectName} running notes.`}
      footer={
        <>
          <button className="btn btn-sm btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-sm btn-primary" onClick={save} disabled={!text.trim()}>
            <Check size={14} />
            {archive ? 'Record and archive' : 'Record decision'}
          </button>
        </>
      }
    >
      <Field label="Decision or update" hint={`${NOW.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · from this email`}>
        <AutoTextarea minRows={2} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), save())} />
      </Field>
    </Modal>
  );
}

/** Shown when the thing you were waiting on has arrived. */
function ArrivedCard({ t }: { t: Thread }) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const project = state.ws.projects[t.project!];
  return (
    <section className="arrived card">
      <Check size={18} className="arrived-icon" />
      <div className="arrived-body">
        <strong>The item you were waiting on arrived</strong>
        <span className="muted">Clear the label and write the decision into the project’s running notes, where the team will look for it.</span>
      </div>
      <div className="arrived-actions">
        <button className="btn btn-sm btn-primary" onClick={() => setOpen(true)}>
          <NotebookPen size={14} />
          Record decision and archive
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'move', id: t.id, box: 'archived' })}>
          Archive only
        </button>
      </div>
      {project && <DecisionDialog open={open} onClose={() => setOpen(false)} t={t} projectName={`[${project.num}] ${project.name}`} archive />}
    </section>
  );
}

/** A plain reply, with the option to track the answer in Waiting. */
function ReplyBox({ t, onDone, autoFocus }: { t: Thread; onDone: () => void; autoFocus?: boolean }) {
  const { dispatch } = useStore();
  const who = counterpart(t);
  const [body, setBody] = useState(`Hi ${firstName(who)},\n\n`);
  const [track, setTrack] = useState(false);
  const [item, setItem] = useState('');
  const [due, setDue] = useState(isoDay(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 3)));
  const area = useRef<HTMLTextAreaElement>(null);
  // Focus only when asked (Reply or A): an open-by-default box shouldn't take the keyboard
  // shortcuts away or scroll the thread out of view.
  useEffect(() => {
    const el = area.current;
    if (el && autoFocus) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [autoFocus]);
  // Files attached from the person's computer (real workspaces). Each is uploaded as it is picked.
  const [files, setFiles] = useState<MailFile[]>([]);
  const [attaching, setAttaching] = useState(false);
  const send = () => {
    if (!body.trim() || (track && !item.trim()) || attaching) return;
    dispatch({ type: 'reply', id: t.id, body, track: track ? { on: who, item: item.trim(), due } : null, ...(files.length ? { files } : {}) });
    onDone();
  };
  // Dictated text goes in at the cursor, or at the end if you haven't clicked into the reply.
  const caret = useRef<[number, number] | null>(null);
  const dictate = (said: string) => {
    const [start, end] = caret.current ?? [body.length, body.length];
    const next = joinAt(body, start, end, said);
    setBody(next.value);
    caret.current = [next.caret, next.caret];
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  return (
    <section className="draft card" aria-label="Reply">
      <header className="draft-head">
        <Avatar id="me" size={26} />
        <div style={{ flex: 1 }}>
          <strong>Reply to {PEOPLE[who]?.name ?? who}</strong>
        </div>
      </header>
      <textarea
        ref={area}
        className="draft-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onSelect={(e) => (caret.current = [e.currentTarget.selectionStart, e.currentTarget.selectionEnd])}
        aria-label="Reply"
        rows={6}
      />
      <div className="compose-track">
        <button className="switch" role="switch" aria-checked={track} aria-label="Track the reply in Waiting" onClick={() => setTrack((v) => !v)} />
        <div className="compose-track-text">
          <span className="compose-track-title">
            <Hourglass size={13} />
            Track in [02] Waiting
          </span>
          {track ? (
            <div className="compose-track-fields">
              <input className="input" value={item} onChange={(e) => setItem(e.target.value)} placeholder="What they owe you" aria-label="What they owe you" />
              <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Promised by" />
            </div>
          ) : (
            <span className="muted">Without tracking, sending clears the label and archives the thread.</span>
          )}
        </div>
      </div>
      <FileChips files={files} onRemove={(i) => setFiles((list) => list.filter((_, at) => at !== i))} className="chips reply-files" />
      <footer className="draft-foot">
        <span className="draft-foot-left">
          <button className="btn btn-sm btn-ghost" onClick={onDone}>
            <Trash2 size={14} />
            Discard
          </button>
          <MicButton onText={dictate} label="Dictate your reply" />
          <AttachButton files={files} onChange={setFiles} onBusy={setAttaching} />
        </span>
        <button className="btn btn-sm btn-primary" onClick={send} disabled={!body.trim() || (track && !item.trim()) || attaching}>
          <Send size={14} />
          {track ? 'Send & track in Waiting' : 'Send'}
        </button>
      </footer>
    </section>
  );
}

/** Mirrors Timmy's writing rules so you can see the draft follows them. */
function checks(d: Draft) {
  const firstSentence = d.body.split('\n\n')[1] ?? '';
  return [
    { ok: /\b(by|confirm|approval|send|could you)\b/i.test(d.subject) || d.subject.startsWith('Re:'), label: 'Action in subject' },
    { ok: /\?|could you|please|confirm|attached|yes/i.test(firstSentence), label: 'Ask in first sentence' },
    { ok: d.sources.length > 0, label: `${d.sources.length} source${d.sources.length === 1 ? '' : 's'} checked` },
  ];
}

function DraftCard({ t, draft }: { t: Thread; draft: Draft }) {
  const { state, dispatch } = useStore();
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [draft.body]);

  const track = draft.trackAs;
  // Files added to the draft from the person's computer (real workspaces). They are kept with the draft on the
  // server, so whoever approves it sees them, and a file still on its way up holds Send back.
  const attached = (draft.files ?? []) as MailFile[];
  const [attaching, setAttaching] = useState(false);
  const setFiles = (files: MailFile[]) => dispatch({ type: 'updateDraft', id: t.id, body: draft.body, files });

  return (
    <section className="draft card" aria-label="Draft reply">
      <header className="draft-head">
        <TimmyMark size={26} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong>{draft.kind === 'nudge' ? 'Timmy drafted a nudge' : 'Timmy drafted a reply'}</strong>
          <div className="chips" style={{ marginTop: 6 }}>
            {draft.sources.map((id) => (
              <span key={id} className="chip">
                <DocIcon kind={state.ws.files[id]!.kind} size={12} />
                {state.ws.files[id]!.name}
              </span>
            ))}
          </div>
        </div>
      </header>

      <div className="draft-fields">
        <div className="draft-field">
          <span className="draft-label">To</span>
          <span className="recips">
            {draft.to.map((p) => (
              <span key={p} className="recip">
                <Avatar id={p} size={18} />
                {PEOPLE[p]!.name}
              </span>
            ))}
            {draft.cc?.map((p) => (
              <span key={p} className="recip cc">
                <Avatar id={p} size={18} />
                {PEOPLE[p]!.name} <span className="muted">cc</span>
              </span>
            ))}
          </span>
        </div>
        <label className="draft-field">
          <span className="draft-label">Subject</span>
          <input
            className="draft-subject"
            value={draft.subject}
            onChange={(e) => dispatch({ type: 'updateDraft', id: t.id, body: draft.body, subject: e.target.value })}
          />
        </label>
      </div>

      <textarea
        ref={area}
        className="draft-body"
        value={draft.body}
        onChange={(e) => dispatch({ type: 'updateDraft', id: t.id, body: e.target.value })}
        aria-label="Draft body"
        spellCheck
      />

      {draft.attachments && (
        <div className="chips" style={{ padding: '0 18px 12px' }}>
          {draft.attachments.map((id) => (
            <span key={id} className="chip accent">
              <Paperclip size={12} />
              {state.ws.files[id]!.name}
            </span>
          ))}
        </div>
      )}

      <FileChips files={draft.files} onRemove={(i) => setFiles(attached.filter((_, at) => at !== i))} className="chips reply-files" />

      <ApprovalNotes notes={draftNotes(state, t)} />

      <div className="draft-checks">
        {checks(draft).map((c) => (
          <span key={c.label} className={c.ok ? 'ok' : ''}>
            {c.ok ? <Check size={12} strokeWidth={3} /> : <CircleDot size={12} />}
            {c.label}
          </span>
        ))}
        {track && (
          <span className="draft-track">
            <Hourglass size={12} />
            On send, tracks “{track.item}” in Waiting until {fmtDay(track.due)}
          </span>
        )}
      </div>

      <footer className="draft-foot">
        <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'discardDraft', id: t.id })}>
          <Trash2 size={14} />
          Discard
        </button>
        <div className="draft-send">
          <AttachButton files={attached} onChange={setFiles} onBusy={setAttaching} />
          {track && (
            <button className="btn btn-sm" disabled={attaching} onClick={() => dispatch({ type: 'sendDraft', id: t.id, track: false })}>
              Send only
            </button>
          )}
          <button className="btn btn-sm btn-primary" disabled={attaching} onClick={() => dispatch({ type: 'sendDraft', id: t.id, track: true })}>
            <Send size={14} />
            {track ? 'Send & track in Waiting' : 'Send'}
          </button>
        </div>
      </footer>
    </section>
  );
}

function Links({ t }: { t: Thread }) {
  const { state, dispatch } = useStore();
  const deal = t.deal ? state.deals[t.deal] : undefined;
  return (
    <div style={{ marginTop: 24 }}>
      <div className="link-grid">
        {(t.docs ?? []).map((id) => {
          const d = state.ws.files[id]!;
          return (
            <article
              key={id}
              className="card link-card"
              role="button"
              tabIndex={0}
              aria-label={`Open ${d.name}`}
              onClick={() => dispatch({ type: 'navigate', route: { view: 'file', id } })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  dispatch({ type: 'navigate', route: { view: 'file', id } });
                }
              }}
            >
              <DocThumb doc={d} />
              <div className="link-meta">
                <div className="file-name">
                  <DocIcon kind={d.kind} size={15} />
                  <span>{d.name}</span>
                </div>
                <DocPath path={pathOf(state.ws, d.folder)} />
                <span className="muted" style={{ fontSize: 12 }}>
                  {d.createdByTimmy ? 'Saved by Timmy · ' : ''}
                  {fmtStamp(d.updated)}
                </span>
              </div>
            </article>
          );
        })}
      </div>
      {(t.docs ?? []).length === 0 && <p className="muted">No files linked to this thread.</p>}
      {deal && (
        <div className="card card-pad deal-link" style={{ marginTop: 16 }}>
          <span className="deal-logo" style={{ ['--tint' as string]: 'var(--ok)' }}>
            {deal.company[0]}
          </span>
          <div style={{ flex: 1 }}>
            <strong>
              {deal.company} — {deal.name}
            </strong>
            <div className="muted" style={{ fontSize: 13 }}>
              CRM · {deal.stage} · next: {deal.next}
            </div>
          </div>
          <button className="btn btn-sm" onClick={() => dispatch({ type: 'navigate', route: { view: 'people', tab: 'priority', person: deal.contact } })}>
            Open in People
          </button>
        </div>
      )}
    </div>
  );
}

function History({ t }: { t: Thread }) {
  const items = [...(t.history ?? [])].reverse();
  return (
    <ol className="timeline" style={{ marginTop: 24 }}>
      {items.map((h, i) => (
        <li key={i}>
          <span className="timeline-dot">
            <Sparkles size={12} />
          </span>
          <div>
            <p>{h.text}</p>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {fmtStamp(h.at)}
            </span>
          </div>
        </li>
      ))}
      {items.length === 0 && (
        <li>
          <span className="timeline-dot">
            <ChevronDown size={12} />
          </span>
          <p className="muted">Timmy hasn’t acted on this thread.</p>
        </li>
      )}
    </ol>
  );
}
