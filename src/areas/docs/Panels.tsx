/* Sidebar and context panel for Docs and for an open file. */
import { ArrowUpRight, CalendarClock, Clock, FilePlus2, FolderOpen, LayoutTemplate, Link2, Mail, NotebookPen } from 'lucide-react';
import { useState } from 'react';
import { PagesTree } from './PagesTree';
import { Folder as FolderGlyph, tint } from '../../components/common';
import { DocIcon, DocPath, DocThumb, kindMeta } from '../../components/DocBits';
import { SideHead } from '../../components/kit';
import type { WFile } from '../../data/ws-types';
import { fmtStamp } from '../../lib/format';
import { useStore, ws } from '../../state/store';
import { isoDay, patch, pathOf, personName, type WsOp } from '../../state/ws';
import { emailLink, showInFolder } from './FileView';
import { GRANS } from './naming';
import { NewDocDialog, type NewDocInitial } from './NewDocDialog';
import {
  byUpdated,
  docsLinkingFile,
  docsLinkingSheet,
  editableFiles,
  eventLabel,
  eventsForDoc,
  fmtWhen,
  meetingDocs,
  nextOccurrence,
  openFile,
  RpSection,
  upcomingMeetings,
} from './shared';
import { TEMPLATES } from './templates';

/* ───────────── Sidebar ───────────── */

export function DocsSide() {
  const { state, dispatch } = useStore();
  const W = state.ws;
  const r = state.route;
  const [newDoc, setNewDoc] = useState<NewDocInitial | null>(null);
  const currentFile = r.view === 'file' ? r.id : null;
  const tab = r.view === 'docs' ? r.tab : null;
  const files = editableFiles(W).sort(byUpdated);
  const meetings = meetingDocs(W);
  const projects = Object.values(W.projects).filter((p) => p.status === 'active');

  const fileItem = (f: WFile, hint?: string) => (
    <button key={f.id} className="nav-item compact" aria-current={currentFile === f.id ? 'page' : undefined} onClick={() => openFile(dispatch, f.id)} title={f.name}>
      <DocIcon kind={f.kind} size={16} />
      <span className="nav-text">
        <span className="nav-name">{f.name}</span>
        {hint && <span className="nav-hint">{hint}</span>}
      </span>
      <span />
    </button>
  );

  const tabItem = (id: 'recent' | 'meetings' | 'templates', label: string, Icon: typeof Clock, count?: number) => (
    <button className="nav-item" aria-current={tab === id ? 'page' : undefined} onClick={() => dispatch({ type: 'navigate', route: { view: 'docs', tab: id } })}>
      <span className="nav-icon" style={tint('var(--c-sky)')}>
        <Icon size={16} />
      </span>
      <span className="nav-text">
        <span className="nav-name">{label}</span>
      </span>
      <span className="nav-count">{count ?? ''}</span>
    </button>
  );

  return (
    <>
      <SideHead
        icon={<NotebookPen size={18} />}
        title="Docs"
        sub="Docs, sheets and slides"
        action={
          <button className="btn btn-primary" onClick={() => setNewDoc({})}>
            <FilePlus2 size={15} aria-hidden />
            New doc
          </button>
        }
      />
      <div className="side-scroll">
        <div className="side-group">
          {tabItem('recent', 'Recent', Clock, files.length)}
          {tabItem('meetings', 'Meeting notes', CalendarClock, meetings.length)}
          {tabItem('templates', 'Templates', LayoutTemplate)}
        </div>

        <PagesTree onNew={() => setNewDoc({})} />

        {meetings.length > 0 && (
          <div className="side-group">
            <div className="side-title">Meeting notes</div>
            {meetings.slice(0, 5).map((m) => fileItem(m.file, m.next ? fmtWhen(m.next) : undefined))}
          </div>
        )}

        <div className="side-group">
          <div className="side-title">Templates</div>
          {TEMPLATES.filter((t) => t.card).map((t) => (
            <button key={t.key} className="nav-item compact" onClick={() => setNewDoc({ template: t.template, templateKey: t.key })}>
              <t.icon size={15} className="doc-side-tpl" aria-hidden />
              <span className="nav-name">{t.name}</span>
              <span />
            </button>
          ))}
        </div>

        {projects.map((p) => {
          const pf = files.filter((f) => f.project === p.id).slice(0, 4);
          if (!pf.length) return null;
          return (
            <div key={p.id} className="side-group">
              <div className="side-title doc-side-project">
                <span className="doc-side-project-name">
                  <FolderGlyph color={p.color} size={14} />
                  {p.name}
                </span>
              </div>
              {pf.map((f) => fileItem(f))}
            </div>
          );
        })}
      </div>
      <NewDocDialog open={!!newDoc} initial={newDoc ?? undefined} onClose={() => setNewDoc(null)} />
    </>
  );
}

/* ───────────── Context: Docs home ───────────── */

export function DocsContext() {
  const { dispatch } = useStore();
  return (
    <>
      <RpSection title="Naming convention">
        <p className="rp-text">Start with the date at the detail the work needs, then the project or subject, then a keyword. Files sort by date, and searching “project + keyword” finds them.</p>
        <ul className="naming">
          {GRANS.filter((g) => g.example).map((g) => (
            <li key={g.id}>
              <code>{g.example}</code>
              <span>
                {g.label}: {g.when?.toLowerCase()}
              </span>
            </li>
          ))}
        </ul>
      </RpSection>
      <RpSection title="Templates">
        <p className="rp-text">
          Start meeting docs from a template so each one has the same shape: decisions first, then notes, then action items. A recurring meeting keeps one running doc, newest date on top, linked from the invite.
        </p>
        <button className="rp-link doc-rp-link" onClick={() => dispatch({ type: 'navigate', route: { view: 'docs', tab: 'templates' } })}>
          Browse templates
        </button>
      </RpSection>
      <RpSection title="Figures that stay current">
        <p className="rp-text">Keep numbers in a sheet and put them in docs as a linked table. When the sheet changes, every doc that links it shows the new figures.</p>
      </RpSection>
    </>
  );
}

/* ───────────── Context: an open file ───────────── */

export function FileContext() {
  const { state, dispatch } = useStore();
  const W = state.ws;
  const id = state.route.view === 'file' ? state.route.id : '';
  const entry = W.files[id];
  const file = entry?.shortcutOf ? W.files[entry.shortcutOf] : entry;
  if (!file) return null;

  const emails = state.threads.filter((t) => t.docs?.includes(file.id));
  const events = Object.values(W.events)
    .filter((e) => e.docs?.includes(file.id) || e.notesDoc === file.id || W.docs[file.id]?.event === e.id)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const projects = Object.values(W.projects).filter((p) => p.sources.includes(file.id) || p.notesDoc === file.id);
  const docs = [...new Map([...docsLinkingSheet(W, file.id).map((x) => x.file), ...docsLinkingFile(W, file.id)].map((f) => [f.id, f])).values()];
  const nothing = !emails.length && !events.length && !projects.length && !docs.length;

  const body = W.docs[file.id];
  const outgoing = body
    ? [...new Set(body.blocks.flatMap((b) => (b.type === 'file' ? [b.file] : b.type === 'linked-table' ? [b.sheet] : [])))].map((x) => W.files[x]).filter((f): f is WFile => !!f)
    : [];
  const meetingish = body && (body.template === 'team-meeting' || body.template === 'one-on-one' || body.template === 'running-notes') && eventsForDoc(W, file.id).length === 0;

  const linkEvent = (eventId: string) => {
    const e = W.events[eventId];
    if (!e) return;
    const ops: WsOp[] = [patch('docs', file.id, { event: eventId })];
    if (!e.notesDoc) ops.push(patch('events', eventId, { notesDoc: file.id }));
    else ops.push(patch('events', eventId, { docs: [...new Set([...(e.docs ?? []), file.id])] }));
    dispatch(ws(ops, { toast: `Linked from “${e.title}”`, undo: true }));
  };

  return (
    <>
      <RpSection title="Details">
        <div className="rp-card file-card">
          <DocThumb doc={file} />
          <dl className="kv">
            <dt>Type</dt>
            <dd>{kindMeta(file.kind).label}</dd>
            <dt>Location</dt>
            <dd>
              <DocPath path={pathOf(W, file.folder)} />
            </dd>
            <dt>Owner</dt>
            <dd>{file.owner === 'me' ? 'You' : personName(file.owner)}</dd>
            <dt>Modified</dt>
            <dd>{fmtStamp(file.updated)}</dd>
            <dt>Keywords</dt>
            <dd>{file.description ? file.description : <span className="muted">None</span>}</dd>
          </dl>
          <div className="file-actions">
            <button className="btn btn-sm" onClick={() => dispatch(emailLink(W, file))}>
              <Mail size={14} aria-hidden />
              Email a link
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => dispatch(showInFolder(file))}>
              <FolderOpen size={14} aria-hidden />
              Show in folder
            </button>
          </div>
        </div>
      </RpSection>

      <RpSection title="Linked from">
        {nothing && <p className="rp-text muted">Nothing links here yet. Link it from a doc, a meeting invite or a project so people find it when they need it.</p>}
        <ul className="rp-list">
          {emails.map((t) => (
            <li key={t.id}>
              <button className="rp-thread" onClick={() => dispatch({ type: 'openThread', id: t.id })}>
                <Mail size={14} className="doc-rp-icon" aria-hidden />
                <span className="doc-rp-text">
                  <span className="doc-ellipsis">{t.subject}</span>
                  <span className="doc-rp-sub">Email</span>
                </span>
              </button>
            </li>
          ))}
          {events.map((e) => {
            const n = nextOccurrence(e) ?? e.start;
            return (
              <li key={e.id}>
                <button className="rp-thread" onClick={() => dispatch({ type: 'navigate', route: { view: 'calendar', tab: 'day', date: isoDay(n) } })}>
                  <CalendarClock size={14} className="doc-rp-icon" aria-hidden />
                  <span className="doc-rp-text">
                    <span className="doc-ellipsis">{e.title}</span>
                    <span className="doc-rp-sub">
                      {e.notesDoc === file.id ? 'Notes for this meeting' : 'Meeting'} · {fmtWhen(n)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {projects.map((p) => (
            <li key={p.id}>
              <button className="rp-thread" onClick={() => dispatch({ type: 'navigate', route: { view: 'project', id: p.id, tab: 'overview' } })}>
                <FolderGlyph color={p.color} size={15} />
                <span className="doc-rp-text">
                  <span className="doc-ellipsis">{p.name}</span>
                  <span className="doc-rp-sub">{p.notesDoc === file.id ? 'Project running notes' : 'Project source'}</span>
                </span>
              </button>
            </li>
          ))}
          {docs.map((d) => (
            <li key={d.id}>
              <button className="rp-thread" onClick={() => openFile(dispatch, d.id)}>
                <DocIcon kind={d.kind} size={14} />
                <span className="doc-rp-text">
                  <span className="doc-ellipsis">{d.name}</span>
                  <span className="doc-rp-sub">{file.kind === 'sheet' && docsLinkingSheet(W, file.id).some((x) => x.file.id === d.id) ? 'Linked table' : 'Linked in a doc'}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {meetingish && (
          <label className="doc-rp-link-event">
            <Link2 size={14} aria-hidden />
            <select className="input" value="" onChange={(e) => e.target.value && linkEvent(e.target.value)} aria-label="Link from a meeting invite">
              <option value="">Link from a meeting invite</option>
              {upcomingMeetings(W).map((e) => (
                <option key={e.id} value={e.id}>
                  {eventLabel(e)}
                </option>
              ))}
            </select>
          </label>
        )}
      </RpSection>

      {outgoing.length > 0 && (
        <RpSection title="Links in this doc">
          <ul className="rp-list">
            {outgoing.map((f) => (
              <li key={f.id}>
                <button className="rp-thread" onClick={() => openFile(dispatch, f.id)}>
                  <DocIcon kind={f.kind} size={14} />
                  <span className="doc-ellipsis">{f.name}</span>
                  <ArrowUpRight size={13} className="doc-rp-go" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </RpSection>
      )}
    </>
  );
}
