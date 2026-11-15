import { BookOpen, Lightbulb, ListChecks, NotebookPen } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { activeProjects, dueFromIso } from '../areas/tasks/bits';
import { NOW } from '../data/mock';
import type { QuickNote, Task } from '../data/ws-types';
import { useStore, ws } from '../state/store';
import { put, uid } from '../state/ws';
import { Kbd } from './common';
import { AutoTextarea, Field, Modal, Segmented } from './kit';

type Mode = 'task' | 'note';

/** Remembered between openings, so a run of notes stays in note mode. */
let lastMode: Mode = 'task';

/** Quick capture (⌘J): a task or a note, filed into the review queue. Owned by the Tasks area. */
export function QuickCapture() {
  const { state, dispatch } = useStore();
  const close = useCallback(() => dispatch({ type: 'capture', open: false }), [dispatch]);
  if (!state.capture) return null;
  return <CaptureForm onClose={close} />;
}

function CaptureForm({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const r = state.route;
  const routeProject = r.view === 'tasks' ? r.project : r.view === 'project' ? r.id : undefined;

  const [mode, setModeState] = useState<Mode>(lastMode);
  const [text, setText] = useState('');
  const [kind, setKind] = useState<QuickNote['kind']>('thought');
  const [source, setSource] = useState('');
  const [title, setTitle] = useState('');
  const [project, setProject] = useState(routeProject ?? '');
  const [due, setDue] = useState('');
  const form = useRef<HTMLFormElement>(null);

  const setMode = (m: Mode) => {
    lastMode = m;
    setModeState(m);
  };

  // Put the cursor in the main field whenever the mode changes.
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('textarea, input')?.focus();
  }, [mode]);

  const ready = mode === 'note' ? !!text.trim() : !!title.trim();

  const save = () => {
    if (!ready) return;
    if (mode === 'note') {
      const note: QuickNote = { id: uid('note'), text: text.trim(), kind, source: kind === 'note' ? source.trim() || undefined : undefined, created: NOW };
      dispatch(ws([put('notes', note)], { toast: 'Captured to your review queue', undo: true }));
    } else {
      const task: Task = { id: uid('task'), title: title.trim(), status: 'todo', priority: 'normal', project: project || undefined, due: dueFromIso(due), created: NOW };
      dispatch(ws([put('tasks', task)], { toast: 'Task added', undo: true }));
    }
    onClose();
  };

  const projects = activeProjects(state.ws);

  return (
    <Modal
      open
      onClose={onClose}
      title="Quick capture"
      description={mode === 'note' ? 'Get it out of your head now. You’ll sort it in the weekly review.' : 'Lands in To do on your task board.'}
      width={500}
      footer={
        <>
          <span className="tk-capture-hint">
            <Kbd>Enter</Kbd> to save
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!ready} onClick={save}>
            {mode === 'note' ? 'Capture note' : 'Add task'}
          </button>
        </>
      }
    >
      <Segmented
        label="What to capture"
        options={[
          { id: 'task', label: 'Task', icon: ListChecks },
          { id: 'note', label: 'Note', icon: NotebookPen },
        ]}
        value={mode}
        onChange={setMode}
      />
      <form
        ref={form}
        className="tk-form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {mode === 'note' ? (
          <>
            <Field label={kind === 'thought' ? 'Your thought' : 'What you noted'}>
              <AutoTextarea
                minRows={3}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    save();
                  }
                }}
                placeholder={kind === 'thought' ? 'An idea, a question, something to raise' : 'A fact or quote worth keeping'}
              />
            </Field>
            <div className="field">
              <span className="field-label">Where it came from</span>
              <Segmented
                label="Where it came from"
                options={[
                  { id: 'thought', label: 'My thought', icon: Lightbulb },
                  { id: 'note', label: 'From a source', icon: BookOpen },
                ]}
                value={kind}
                onChange={setKind}
              />
            </div>
            {kind === 'note' && (
              <Field label="Source" hint="Optional. A meeting, video or article.">
                <input className="input" value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. Acme call, Nov 13" />
              </Field>
            )}
          </>
        ) : (
          <>
            <Field label="Task">
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Start with a verb: Send, Call, Draft…" />
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
          </>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
