import { ArrowUpRight, CalendarClock, ClipboardList, FileText, ListChecks, Mail, Pencil, Repeat, StickyNote, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Avatar, DueChip, tint } from '../../components/common';
import { DocIcon } from '../../components/DocBits';
import { AutoTextarea, Field, Modal, PeoplePicker, Segmented } from '../../components/kit';
import { NOW, PEOPLE } from '../../data/mock';
import type { EventKind, WEvent } from '../../data/ws-types';
import { fmtDay, fmtLongDate } from '../../lib/format';
import { useStore, ws } from '../../state/store';
import { isoDay, parseIsoDay, patch, personName, put, remove, uid, type WsOp } from '../../state/ws';
import { reviewQueue } from '../tasks/bits';
import { TaskDialog } from '../tasks/TaskDialog';
import { fmtDuration, fmtRange, kindMeta, KINDS, MIN, overlaps, timeValue } from './shared';

const DURATIONS = [15, 30, 45, 60, 90, 120, 180];

/* ───────────── Create / edit ───────────── */

export interface EventDraft {
  date?: string;
  time?: string;
  kind?: EventKind;
}

/** Create an event (no `event`) or edit one. */
export function EventDialog(props: { open: boolean; onClose: () => void; event?: WEvent; draft?: EventDraft }) {
  if (!props.open) return null;
  return <EventForm {...props} />;
}

function EventForm({ onClose, event, draft }: { onClose: () => void; event?: WEvent; draft?: EventDraft }) {
  const { state, dispatch } = useStore();
  const [id] = useState(() => event?.id ?? uid('ev'));
  const [title, setTitle] = useState(event?.title ?? '');
  const [kind, setKind] = useState<EventKind>(event?.kind ?? draft?.kind ?? 'meeting');
  const [date, setDate] = useState(event ? isoDay(event.start) : draft?.date ?? isoDay(NOW));
  const [time, setTime] = useState(event ? timeValue(event.start) : draft?.time ?? '10:00');
  const initialDur = event ? Math.round((event.end.getTime() - event.start.getTime()) / MIN) : 30;
  const [duration, setDuration] = useState(initialDur);
  const [people, setPeople] = useState<string[]>(event?.with ?? []);
  const [task, setTask] = useState(event?.task ?? '');
  const [note, setNote] = useState(event?.note ?? '');

  const [h, m] = (time || '00:00').split(':').map(Number);
  const start = date ? parseIsoDay(date, h, m) : null;
  const end = start ? new Date(start.getTime() + duration * MIN) : null;
  const clash = start && end ? overlaps(state.ws, start, end, id) : [];
  const tasks = Object.values(state.ws.tasks)
    .filter((t) => t.status !== 'done' || t.id === event?.task)
    .sort((a, b) => a.title.localeCompare(b.title));
  const durations = DURATIONS.includes(duration) ? DURATIONS : [...DURATIONS, duration].sort((a, b) => a - b);

  const save = () => {
    if (!title.trim() || !start || !end) return;
    const next: WEvent = {
      ...event,
      id,
      title: title.trim(),
      kind,
      start,
      end,
      with: people,
      note: note.trim() || undefined,
      task: task || undefined,
    };
    const ops: WsOp[] = [put('events', next)];
    if (event?.task && event.task !== task && state.ws.tasks[event.task]?.event === id) ops.push(patch('tasks', event.task, { event: undefined }));
    if (task) ops.push(patch('tasks', task, { event: id }));
    dispatch(ws(ops, { toast: event ? 'Event updated' : `Event added: ${fmtDay(start)}, ${fmtRange(start, end)}`, undo: true }));
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={event ? 'Edit event' : 'New event'}
      width={540}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!title.trim() || !start} onClick={save}>
            {event ? 'Save changes' : 'Add event'}
          </button>
        </>
      }
    >
      <form
        className="cal-form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="Title">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === 'focus' ? 'Focus: what you’ll work on' : 'What it’s about'} />
        </Field>
        <div className="field">
          <span className="field-label">Kind</span>
          <Segmented label="Kind" options={KINDS.map((k) => ({ id: k.id, label: k.label }))} value={kind} onChange={setKind} />
        </div>
        <div className="field-row cal-when">
          <Field label="Date">
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Start">
            <input className="input" type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
          <Field label="Length">
            <select className="input" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {durations.map((d) => (
                <option key={d} value={d}>
                  {fmtDuration(d)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {clash.length > 0 && (
          <p className="cal-warn" role="status">
            Overlaps with {clash.map((e) => e.title).join(', ')}.
          </p>
        )}
        <div className="field">
          <span className="field-label">Attendees</span>
          <PeoplePicker value={people} onChange={setPeople} placeholder="Invite people" />
        </div>
        <Field label="Linked task" hint="The task gets this event as its time block.">
          <select className="input" value={task} onChange={(e) => setTask(e.target.value)}>
            <option value="">None</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note">
          <AutoTextarea minRows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Agenda, prep, what to ask" />
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/* ───────────── Details ───────────── */

export function EventDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [mode, setMode] = useState<'view' | 'edit' | 'task'>('view');
  const back = useCallback(() => setMode('view'), []);
  const ev = id ? state.ws.events[id] : undefined;
  if (!ev) return null;

  const k = kindMeta(ev.kind);
  const files = (ev.docs ?? []).map((d) => state.ws.files[d]).filter((f): f is NonNullable<typeof f> => !!f);
  const notes = ev.notesDoc ? state.ws.files[ev.notesDoc] : undefined;
  const thread = ev.thread ? state.threads.find((t) => t.id === ev.thread) : undefined;
  const task = ev.task ? state.ws.tasks[ev.task] : undefined;
  const queue = reviewQueue(state.ws).length;
  const past = ev.end < NOW;

  const go = (fn: () => void) => {
    onClose();
    fn();
  };

  const del = () => {
    const ops: WsOp[] = [remove('events', ev.id)];
    if (task?.event === ev.id) ops.push(patch('tasks', task.id, { event: undefined }));
    dispatch(ws(ops, { toast: `Deleted “${ev.title}”`, undo: true }));
    onClose();
  };

  return (
    <>
      <Modal
        open={mode === 'view'}
        onClose={onClose}
        title={ev.title}
        description={`${fmtLongDate(ev.start)} · ${fmtRange(ev.start, ev.end)}`}
        width={520}
        footer={
          <>
            <button className="btn btn-ghost tk-danger" onClick={del}>
              <Trash2 size={15} />
              Delete
            </button>
            <span className="tk-foot-gap" />
            <button className="btn" onClick={() => setMode('edit')}>
              <Pencil size={14} />
              Edit
            </button>
            <button className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          </>
        }
      >
        <div className="chips">
          <span className="chip plain" style={tint(k.color)}>
            <span className="dot" />
            {k.label}
          </span>
          <span className="chip">
            <CalendarClock size={12} />
            {fmtDuration(Math.round((ev.end.getTime() - ev.start.getTime()) / MIN))}
            {past ? ' · ended' : ''}
          </span>
          {ev.recurring && (
            <span className="chip">
              <Repeat size={12} />
              Every week
            </span>
          )}
        </div>

        {ev.note && (
          <p className="cal-detail-note">
            <StickyNote size={15} aria-hidden />
            {ev.note}
          </p>
        )}

        {ev.kind === 'review' && (
          <div className="cal-detail-review">
            <ClipboardList size={16} aria-hidden />
            <span>{queue ? `${queue} captured items wait in your review queue.` : 'Your review queue is clear.'}</span>
            <button className="btn btn-sm btn-primary" onClick={() => go(() => dispatch({ type: 'navigate', route: { view: 'tasks', tab: 'review' } }))}>
              Open review queue
            </button>
          </div>
        )}

        {ev.with.length > 0 && (
          <div className="cal-detail-group">
            <h3 className="cal-detail-h">Attendees</h3>
            <ul className="cal-people">
              <li>
                <Avatar id="me" size={26} />
                <span>You</span>
                <span className="muted">Organizer</span>
              </li>
              {ev.with.map((p) => (
                <li key={p}>
                  <Avatar id={p} size={26} />
                  <span>{personName(p)}</span>
                  <span className="muted">{[PEOPLE[p]?.title, PEOPLE[p]?.company].filter(Boolean).join(', ')}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(files.length > 0 || notes || thread || task) && (
          <div className="cal-detail-group">
            <h3 className="cal-detail-h">Linked</h3>
            <ul className="cal-links">
              {notes && (
                <li>
                  <button className="cal-link" onClick={() => go(() => dispatch({ type: 'navigate', route: { view: 'file', id: notes.id } }))}>
                    <FileText size={15} className="cal-link-icon" aria-hidden />
                    <span className="cal-link-text">
                      <span className="cal-link-title">{notes.name}</span>
                      <span className="cal-link-sub">Running notes doc</span>
                    </span>
                    <ArrowUpRight size={15} className="cal-link-go" aria-hidden />
                  </button>
                </li>
              )}
              {files.map((f) => (
                <li key={f.id}>
                  <button className="cal-link" onClick={() => go(() => dispatch({ type: 'navigate', route: { view: 'file', id: f.id } }))}>
                    <DocIcon kind={f.kind} size={15} />
                    <span className="cal-link-text">
                      <span className="cal-link-title">{f.name}</span>
                      <span className="cal-link-sub">File to open</span>
                    </span>
                    <ArrowUpRight size={15} className="cal-link-go" aria-hidden />
                  </button>
                </li>
              ))}
              {thread && (
                <li>
                  <button className="cal-link" onClick={() => go(() => dispatch({ type: 'openThread', id: thread.id }))}>
                    <Mail size={15} className="cal-link-icon" aria-hidden />
                    <span className="cal-link-text">
                      <span className="cal-link-title">{thread.subject}</span>
                      <span className="cal-link-sub">Email</span>
                    </span>
                    <ArrowUpRight size={15} className="cal-link-go" aria-hidden />
                  </button>
                </li>
              )}
              {task && (
                <li>
                  <button className="cal-link" onClick={() => setMode('task')}>
                    <ListChecks size={15} className="cal-link-icon" aria-hidden />
                    <span className="cal-link-text">
                      <span className="cal-link-title">{task.title}</span>
                      <span className="cal-link-sub">Task this time is reserved for</span>
                    </span>
                    {task.due && task.status !== 'done' && <DueChip due={task.due} />}
                  </button>
                </li>
              )}
            </ul>
          </div>
        )}
      </Modal>

      <EventDialog open={mode === 'edit'} onClose={back} event={ev} />
      <TaskDialog open={mode === 'task'} onClose={back} initial={task} />
    </>
  );
}
