/*
 * Small pieces shared by the Projects and People areas.
 */
import { Check, Flag, Mail, Timer } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Avatar, DueChip, Folder } from '../../components/common';
import type { Task } from '../../data/ws-types';
import { useStore, ws } from '../../state/store';
import { patch, personName } from '../../state/ws';

/** Right-panel section, same look as the rest of the context panel. */
export function RpSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rp-section">
      <header className="rp-head">
        <h2 className="rp-title">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

/** A labelled group of controls. Not a <label>, so a click on the caption doesn't press the first button. */
export function Group({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <div className="field" role="group" aria-labelledby={id}>
      <span className="field-label" id={id}>
        {label}
      </span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

/** Section heading inside a page, with optional actions on the right. */
export function SectionHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="pj-section-head">
      <div className="pj-section-text">
        <h2 className="section-title">{title}</h2>
        {sub && <p className="section-sub">{sub}</p>}
      </div>
      {children && <div className="pj-section-actions">{children}</div>}
    </div>
  );
}

/** One task with a checkbox to mark it done. Click the title to edit it. */
export function TaskLine({
  task,
  onEdit,
  showProject,
  showContact = true,
}: {
  task: Task;
  onEdit?: (t: Task) => void;
  showProject?: boolean;
  showContact?: boolean;
}) {
  const { state, dispatch } = useStore();
  const done = task.status === 'done';
  const project = task.project ? state.ws.projects[task.project] : undefined;
  const toggle = () =>
    dispatch(
      ws([patch('tasks', task.id, { status: done ? 'todo' : 'done' })], {
        toast: done ? `Reopened “${task.title}”` : `Done: ${task.title}`,
        undo: true,
      }),
    );
  return (
    <li className={`pj-task${done ? ' done' : ''}`}>
      <button
        type="button"
        className="pj-check"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `Mark “${task.title}” as not done` : `Mark “${task.title}” as done`}
        onClick={toggle}
      >
        {done && <Check size={12} strokeWidth={3} />}
      </button>
      <button type="button" className="pj-task-body" onClick={() => onEdit?.(task)} disabled={!onEdit}>
        <span className="pj-task-title">{task.title}</span>
        <span className="pj-task-meta">
          {task.due && !done && <DueChip due={task.due} />}
          {task.status === 'doing' && (
            <span className="chip accent">
              <Timer size={12} />
              In progress
            </span>
          )}
          {task.priority === 'high' && !done && (
            <span className="chip">
              <Flag size={12} />
              High priority
            </span>
          )}
          {showContact && task.contact && (
            <span className="chip plain">
              <Avatar id={task.contact} size={16} />
              {personName(task.contact)}
            </span>
          )}
          {showProject && project && (
            <span className="chip plain">
              <Folder color={project.color} size={14} />
              {project.name}
            </span>
          )}
        </span>
      </button>
      {task.thread && state.threads.some((t) => t.id === task.thread) && (
        <button type="button" className="icon-btn sm" aria-label="Open the email this task came from" onClick={() => dispatch({ type: 'openThread', id: task.thread! })}>
          <Mail size={15} />
        </button>
      )}
    </li>
  );
}
