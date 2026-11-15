import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useId, useState } from 'react';
import { AutoTextarea, Field, Modal, Segmented } from '../../components/kit';
import { NOW } from '../../data/mock';
import type { Prompt, Routine } from '../../data/ws-types';
import { ws, useStore } from '../../state/store';
import { patch, put, uid } from '../../state/ws';
import { Group } from '../files/pickers';
import { OUTPUTS, linkInfo, linkOptions, useCases, type Output } from './lib';

/* ───────────── Prompts ───────────── */

/**
 * capture: a quick save to the Captured queue.
 * adapt: the weekly review — rewrite it, give it a use case and file it.
 * edit: change a filed prompt.
 */
export function PromptDialog({ mode, prompt, onClose }: { mode: 'capture' | 'adapt' | 'edit'; prompt?: Prompt; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [title, setTitle] = useState(prompt?.title ?? '');
  const [text, setText] = useState(prompt?.text ?? '');
  const [useCase, setUseCase] = useState(prompt?.useCase ?? '');
  const [output, setOutput] = useState<Output>(prompt?.output ?? 'email');
  const [project, setProject] = useState(prompt?.project ?? '');
  const listId = useId();
  const cases = useCases(state.ws).map((c) => c.name);
  const projects = Object.values(state.ws.projects).filter((p) => p.status === 'active');
  const filing = mode !== 'capture';
  const ok = !!text.trim() && (!filing || (!!title.trim() && !!useCase.trim()));

  const save = () => {
    if (!ok) return;
    const t = title.trim() || text.trim().split(/\s+/).slice(0, 5).join(' ');
    if (mode === 'capture') {
      dispatch(ws([put('prompts', { id: uid('prompt'), title: t, text: text.trim(), status: 'captured', created: NOW, project: project || undefined })], { toast: 'Captured. Adapt or discard it in the weekly review.', undo: true }));
    } else {
      const change = { title: t, text: text.trim(), useCase: useCase.trim(), output, project: project || undefined, status: 'filed' as const };
      dispatch(ws([patch('prompts', prompt!.id, change)], { toast: mode === 'adapt' ? `Filed under ${useCase.trim()}` : 'Prompt saved', undo: true }));
    }
    onClose();
  };

  const titles = { capture: 'Capture a prompt', adapt: 'Adapt and file', edit: 'Edit prompt' };
  const descs = {
    capture: 'Save it now, tidy it later. It waits in Captured until the weekly review.',
    adapt: 'Make it reusable: name what it does, swap specifics for placeholders, and file it by use case.',
    edit: 'Changes apply the next time you use it.',
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={titles[mode]}
      description={descs[mode]}
      width={560}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!ok} onClick={save}>
            {mode === 'capture' ? 'Capture' : mode === 'adapt' ? 'File prompt' : 'Save prompt'}
          </button>
        </>
      }
    >
      <Field label="Prompt">
        <AutoTextarea value={text} onChange={(e) => setText(e.target.value)} minRows={4} placeholder="e.g. Rewrite this thread as decisions, open actions and background." />
      </Field>
      <Field label="Title" hint={mode === 'capture' ? 'Optional. Timmy uses the first words if you leave it blank.' : undefined}>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What it does, e.g. Decision-first recap" />
      </Field>
      {filing && (
        <>
          <Field label="Use case" hint="Pick one or type a new one.">
            <input className="input" list={listId} value={useCase} onChange={(e) => setUseCase(e.target.value)} placeholder="e.g. Customer email" />
            <datalist id={listId}>
              {cases.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Group label="Output">
            <Segmented label="Output" value={output} onChange={setOutput} options={OUTPUTS.map((o) => ({ id: o.id, label: o.label, icon: o.icon }))} />
          </Group>
        </>
      )}
      <Field label="Project" hint="Project prompts also show on the project page, next to its source files.">
        <select className="input" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              [{p.num}] {p.name}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

/* ───────────── Routines ───────────── */

export function RoutineDialog({ routine, onClose }: { routine?: Routine; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(routine?.name ?? '');
  const [when, setWhen] = useState(routine?.when ?? '');
  const [links, setLinks] = useState(routine?.links ?? []);
  const [pick, setPick] = useState('');
  const groups = linkOptions(state.ws);
  const ok = !!name.trim() && links.length > 0;

  const add = (href: string) => {
    if (!href || links.some((l) => l.href === href)) return;
    const opt = groups.flatMap((g) => g.items).find((i) => i.href === href);
    setLinks([...links, { href, label: opt?.label ?? linkInfo(state.ws, href).label }]);
    setPick('');
  };
  const moveLink = (i: number, d: -1 | 1) => {
    const next = [...links];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    setLinks(next);
  };
  const save = () => {
    if (!ok) return;
    const item: Routine = { id: routine?.id ?? uid('routine'), name: name.trim(), when: when.trim() || undefined, links };
    dispatch(ws([put('routines', item)], { toast: routine ? 'Routine saved' : `Routine added: ${item.name}`, undo: true }));
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={routine ? 'Edit routine' : 'New routine'}
      description="Save the places a recurring task needs, so they open together when you start it."
      width={580}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!ok} onClick={save}>
            {routine ? 'Save routine' : 'Add routine'}
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weekly pipeline report" />
        </Field>
        <Field label="When">
          <input className="input" value={when} onChange={(e) => setWhen(e.target.value)} placeholder="e.g. Fridays, 3:00 PM" />
        </Field>
      </div>
      <Group label={`Links, in the order you open them (${links.length})`}>
        {links.length === 0 ? (
          <p className="lib-links-empty">Add the files, mail labels and sections this routine needs.</p>
        ) : (
          <ol className="lib-edit-links">
            {links.map((l, i) => {
              const info = linkInfo(state.ws, l.href);
              return (
                <li key={l.href}>
                  <info.icon size={15} className="lib-link-icon" aria-hidden />
                  <input
                    className="input lib-link-input"
                    value={l.label}
                    aria-label={`Label for link ${i + 1}`}
                    onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  />
                  <span className="lib-link-where">{info.where}</span>
                  <span className="lib-link-tools">
                    <button className="icon-btn sm" aria-label="Move up" disabled={i === 0} onClick={() => moveLink(i, -1)}>
                      <ArrowUp size={14} />
                    </button>
                    <button className="icon-btn sm" aria-label="Move down" disabled={i === links.length - 1} onClick={() => moveLink(i, 1)}>
                      <ArrowDown size={14} />
                    </button>
                    <button className="icon-btn sm" aria-label={`Remove ${l.label}`} onClick={() => setLinks(links.filter((_, j) => j !== i))}>
                      <X size={14} />
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        <div className="lib-add-link">
          <select className="input" value={pick} onChange={(e) => add(e.target.value)} aria-label="Add a link">
            <option value="">Add a file, mail label or section…</option>
            {groups.map((g) => (
              <optgroup key={g.group} label={g.group}>
                {g.items.map((it) => (
                  <option key={it.href} value={it.href} disabled={links.some((l) => l.href === it.href)}>
                    {it.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      </Group>
    </Modal>
  );
}
