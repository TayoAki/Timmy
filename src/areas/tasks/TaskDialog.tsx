import { CalendarClock, CalendarPlus, Mail, Target, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { AutoTextarea, Field, Modal, PeoplePicker, Segmented } from '../../components/kit';
import { NOW } from '../../data/mock';
import type { Priority, Task, TaskStatus } from '../../data/ws-types';
import { fmtDay } from '../../lib/format';
import { useStore, ws } from '../../state/store';
import { isoDay, put, remove, uid, type WsOp } from '../../state/ws';
import { BlockTimeDialog } from '../calendar/BlockTimeDialog';
import { fmtRange, showEvent } from '../calendar/shared';
import { activeProjects, dueFromIso, PRIORITIES, STATUSES } from './bits';

/**
 * Create or edit a task. Owned by the Tasks area; used from mail, projects and people.
 * Creates when `initial.id` is absent, edits when present.
 *
 * Optional extras for callers in this area: `extraOps` are saved in the same change
 * (one Undo reverts both), `savedToast` replaces the toast text.
 */
export function TaskDialog(props: {
  open: boolean;
  onClose: () => void;
  initial?: Partial<Task>;
  extraOps?: WsOp[];
  savedToast?: string;
}) {
  if (!props.open) return null;
  return <TaskForm {...props} />;
}

function TaskForm({ onClose, initial, extraOps, savedToast }: Parameters<typeof TaskDialog>[0]) {
  const { state, dispatch } = useStore();
  const existing = initial?.id ? state.ws.tasks[initial.id] : undefined;
  const base: Partial<Task> = { ...existing, ...initial };
  const isEdit = !!existing;

  const [id] = useState(() => initial?.id ?? uid('task'));
  const [title, setTitle] = useState(base.title ?? '');
  const [notes, setNotes] = useState(base.notes ?? '');
  const [project, setProject] = useState(base.project ?? '');
  const [due, setDue] = useState(base.due ? isoDay(base.due) : '');
  const [priority, setPriority] = useState<Priority>(base.priority ?? 'normal');
  const [status, setStatus] = useState<TaskStatus>(base.status ?? 'todo');
  const [contact, setContact] = useState<string[]>(base.contact ? [base.contact] : []);
  const [blocking, setBlocking] = useState(false);

  const projects = activeProjects(state.ws);
  const thread = base.thread ? state.threads.find((t) => t.id === base.thread) : undefined;
  const event = existing?.event ? state.ws.events[existing.event] : base.event ? state.ws.events[base.event] : undefined;
  const isHighlight = !!title.trim() && state.highlight === title.trim();

  const build = (): Task => ({
    ...existing,
    id,
    title: title.trim(),
    notes: notes.trim() || undefined,
    project: project || undefined,
    due: dueFromIso(due, base.due),
    priority,
    status,
    created: existing?.created ?? NOW,
    thread: base.thread,
    contact: contact[0],
    event: existing?.event ?? base.event,
  });

  const save = () => {
    if (!title.trim()) return;
    dispatch(ws([...(extraOps ?? []), put('tasks', build())], { toast: isEdit ? 'Task updated' : savedToast ?? 'Task added', undo: true }));
    onClose();
  };

  const del = () => {
    if (!existing) return;
    const linked = existing.event ? state.ws.events[existing.event] : undefined;
    const ops: WsOp[] = [remove('tasks', existing.id)];
    if (linked?.kind === 'focus' && linked.task === existing.id) ops.push(remove('events', linked.id));
    dispatch(ws(ops, { toast: ops.length > 1 ? 'Task and its focus block deleted' : 'Task deleted', undo: true }));
    onClose();
  };

  const highlight = () => {
    dispatch({ type: 'setHighlight', text: title.trim() });
    dispatch({ type: 'toast', text: `Today’s highlight: ${title.trim()}` });
  };

  return (
    <>
      <Modal
        open={!blocking}
        onClose={onClose}
        title={isEdit ? 'Edit task' : 'New task'}
        width={560}
        footer={
          <>
            {isEdit && (
              <button className="btn btn-ghost tk-danger" onClick={del}>
                <Trash2 size={15} />
                Delete
              </button>
            )}
            <span className="tk-foot-gap" />
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!title.trim()} onClick={save}>
              {isEdit ? 'Save changes' : 'Add task'}
            </button>
          </>
        }
      >
        <form
          className="tk-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Field label="Task" hint={thread && !isEdit ? 'Name the actual action, not the email subject.' : undefined}>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Start with a verb: Send, Call, Draft…" />
          </Field>

          <Field label="Notes">
            <AutoTextarea minRows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Context, links, the next step" />
          </Field>

          <div className="field-row">
            <Field label="Project">
              <select className="input" value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    [{p.num}] {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Due">
              <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>
          </div>

          <div className="field-row">
            <div className="field">
              <span className="field-label">Priority</span>
              <Segmented label="Priority" options={PRIORITIES} value={priority} onChange={setPriority} />
            </div>
            <div className="field">
              <span className="field-label">Status</span>
              <Segmented label="Status" options={STATUSES.map((s) => ({ id: s.id, label: s.label }))} value={status} onChange={setStatus} />
            </div>
          </div>

          <div className="field">
            <span className="field-label">Person</span>
            <PeoplePicker single value={contact} onChange={setContact} placeholder="Link a contact" />
          </div>

          {thread && (
            <div className="tk-link-row">
              <Mail size={15} aria-hidden />
              <span className="tk-link-text">
                <span className="tk-link-title">{thread.subject}</span>
                <span className="tk-link-sub">The email this task came from</span>
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  onClose();
                  dispatch({ type: 'openThread', id: thread.id });
                }}
              >
                Open email
              </button>
            </div>
          )}

          {event && (
            <div className="tk-link-row">
              <CalendarClock size={15} aria-hidden />
              <span className="tk-link-text">
                <span className="tk-link-title">{event.title}</span>
                <span className="tk-link-sub">
                  {fmtDay(event.start)}, {fmtRange(event.start, event.end)}
                </span>
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  onClose();
                  showEvent(dispatch, event);
                }}
              >
                Open in calendar
              </button>
            </div>
          )}

          <div className="tk-form-actions">
            <button type="button" className="btn btn-sm" disabled={!title.trim()} onClick={() => setBlocking(true)}>
              <CalendarPlus size={14} />
              {event ? 'Block more time' : 'Block time'}
            </button>
            <button type="button" className="btn btn-sm" disabled={!title.trim() || isHighlight} onClick={highlight}>
              <Target size={14} />
              {isHighlight ? 'Today’s highlight' : 'Make today’s highlight'}
            </button>
          </div>
          <button type="submit" hidden />
        </form>
      </Modal>

      <BlockTimeDialog
        open={blocking}
        onClose={() => setBlocking(false)}
        title={title.trim()}
        task={id}
        thread={base.thread}
        minutes={60}
        extraOps={[...(extraOps ?? []), put('tasks', build())]}
        toastSuffix={isEdit ? '' : ' · task added'}
        onBooked={() => onClose()}
      />
    </>
  );
}
