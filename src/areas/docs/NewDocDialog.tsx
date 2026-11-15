import { useId, useMemo, useState } from 'react';
import { Field, Modal } from '../../components/kit';
import { NOW, PEOPLE } from '../../data/mock';
import type { Block, DocTemplate, Project, WEvent, WFile } from '../../data/ws-types';
import { useStore, ws } from '../../state/store';
import { firstName, patch, put, uid, type WsOp } from '../../state/ws';
import { composeName, DOC_KEYWORDS, NameField, parseName, type NameParts } from './naming';
import { eventLabel, FolderSelect, nextOccurrence, upcomingMeetings } from './shared';
import { buildBlocks, keyFor, TEMPLATES, templateDef, type TemplateKey } from './templates';

export interface NewDocInitial {
  template?: DocTemplate;
  project?: string;
  folder?: string;
  title?: string;
  /** Calendar event the doc is the running notes for. */
  event?: string;
  /** Blocks added after the template's own, e.g. a linked table. */
  blocks?: Block[];
  /** A specific template card when one doc template has two, e.g. 'tracker'. */
  templateKey?: TemplateKey;
}

const ME_FIRST = PEOPLE.me!.name.split(' ')[0]!;

const subjectFor = (key: TemplateKey, project?: Project, event?: WEvent) => {
  if (key === 'one-on-one') return event?.with.length ? `${ME_FIRST} / ${event.with.map(firstName).join(' / ')}` : '';
  return project?.name ?? event?.title ?? '';
};

const suggest = (key: TemplateKey, project?: Project, event?: WEvent): NameParts => {
  const def = templateDef(key);
  return { gran: def.gran, keyword: def.keyword, subject: subjectFor(key, project, event) };
};

/** Create and name a doc in one step, from a template. */
export function NewDocDialog(props: { open: boolean; onClose: () => void; initial?: NewDocInitial; onCreated?: (fileId: string) => void }) {
  if (!props.open) return null;
  return <NewDocForm {...props} />;
}

function NewDocForm({ onClose, initial, onCreated }: { onClose: () => void; initial?: NewDocInitial; onCreated?: (fileId: string) => void }) {
  const { state, dispatch } = useStore();
  const W = state.ws;
  const ids = { project: useId(), folder: useId() };
  const projects = Object.values(W.projects).filter((p) => p.status === 'active');
  const initialEvent = initial?.event ? W.events[initial.event] : undefined;

  const [key, setKey] = useState<TemplateKey>(() => {
    if (initial?.templateKey) return initial.templateKey;
    if (initial?.template) return keyFor(initial.template);
    if (initialEvent) return initialEvent.with.length === 1 && initialEvent.recurring ? 'one-on-one' : 'team-meeting';
    return 'blank';
  });
  const [projectId, setProjectId] = useState(initial?.project ?? '');
  const [eventId, setEventId] = useState(initial?.event ?? '');
  const [folder, setFolder] = useState(initial?.folder ?? (initial?.project ? W.projects[initial.project]?.folder : undefined) ?? 'f02');
  const [folderTouched, setFolderTouched] = useState(!!initial?.folder);
  const [name, setName] = useState<NameParts>(() =>
    initial?.title ? parseName(initial.title, DOC_KEYWORDS) : suggest(key, initial?.project ? W.projects[initial.project] : undefined, initialEvent),
  );
  const [nameTouched, setNameTouched] = useState(!!initial?.title);

  const project = projectId ? W.projects[projectId] : undefined;
  const event = eventId ? W.events[eventId] : undefined;
  const date = (event && nextOccurrence(event)) ?? NOW;
  const full = composeName(name, date);
  const meetings = useMemo(() => upcomingMeetings(W), [W]);

  const resuggest = (k: TemplateKey, p?: Project, e?: WEvent) => {
    if (!nameTouched) setName(suggest(k, p, e));
    else setName((n) => ({ ...n, gran: templateDef(k).gran, keyword: templateDef(k).keyword }));
  };

  const pickTemplate = (k: TemplateKey) => {
    setKey(k);
    resuggest(k, project, event);
  };

  const pickProject = (id: string) => {
    setProjectId(id);
    const p = id ? W.projects[id] : undefined;
    if (!folderTouched) setFolder(p?.folder ?? 'f02');
    if (!nameTouched) setName(suggest(key, p, event));
  };

  const pickEvent = (id: string) => {
    setEventId(id);
    const e = id ? W.events[id] : undefined;
    if (!nameTouched) setName(suggest(key, project, e));
  };

  const create = () => {
    if (!full) return;
    const fileId = uid('doc');
    const def = templateDef(key);
    const blocks = [...buildBlocks(key, { date, subject: name.subject.trim(), project, event }), ...(initial?.blocks ?? [])];
    const file: WFile = { id: fileId, name: full, kind: 'doc', folder, updated: NOW, owner: 'me', project: projectId || undefined };
    const ops: WsOp[] = [put('files', file), put('docs', { id: fileId, template: def.template, blocks, event: event?.id })];
    // The invite links the notes, so either person can open them and add a topic.
    if (event) {
      if (!event.notesDoc) ops.push(patch('events', event.id, { notesDoc: fileId }));
      else ops.push(patch('events', event.id, { docs: [...new Set([...(event.docs ?? []), fileId])] }));
    }
    dispatch(ws(ops, { toast: event ? `Created “${full}” and linked it from the invite` : `Created “${full}”`, undo: true, log: `Created the doc “${full}”` }));
    onClose();
    if (onCreated) onCreated(fileId);
    else dispatch({ type: 'navigate', route: { view: 'file', id: fileId } });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New doc"
      description="Pick a template and name the doc. It’s created in the folder you choose."
      width={600}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!full} onClick={create}>
            Create doc
          </button>
        </>
      }
    >
      <div className="field" role="radiogroup" aria-label="Template">
        <span className="field-label">Template</span>
        <div className="doc-tpl-pick">
          {TEMPLATES.filter((t) => t.card || t.key === key).map((t) => (
            <button key={t.key} type="button" role="radio" aria-checked={key === t.key} className="doc-tpl-opt" onClick={() => pickTemplate(t.key)}>
              <t.icon size={16} aria-hidden />
              <span>{t.name}</span>
            </button>
          ))}
        </div>
        <span className="field-hint">{templateDef(key).blurb}</span>
      </div>

      <form
        className="doc-form-contents"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <NameField
          value={name}
          date={date}
          keywords={DOC_KEYWORDS}
          placeholder={key === 'one-on-one' ? `${ME_FIRST} / Priya` : 'Project or subject, e.g. Acme'}
          onChange={(v) => {
            setName(v);
            setNameTouched(true);
          }}
        />
      </form>

      <div className="field-row">
        <div className="field">
          <label className="field-label" htmlFor={ids.project}>
            Project
          </label>
          <select id={ids.project} className="input" value={projectId} onChange={(e) => pickProject(e.target.value)}>
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                [{p.num}] {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor={ids.folder}>
            Folder
          </label>
          <FolderSelect
            id={ids.folder}
            ws={W}
            value={folder}
            onChange={(f) => {
              setFolder(f);
              setFolderTouched(true);
            }}
          />
        </div>
      </div>

      <Field label="Calendar invite" hint={event ? 'The invite links to this doc, so everyone in the meeting can open it and add a topic.' : 'Optional. Link recurring meetings so the notes open from the invite.'}>
        <select className="input" value={eventId} onChange={(e) => pickEvent(e.target.value)}>
          <option value="">Not linked to a meeting</option>
          {meetings.map((m) => (
            <option key={m.id} value={m.id}>
              {eventLabel(m)}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}
