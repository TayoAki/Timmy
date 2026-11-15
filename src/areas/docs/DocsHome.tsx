/* The Docs home: Recent, Meeting notes and Templates. */
import { ArrowUpRight, CalendarClock, FilePlus2, Link2, Plus, Presentation, Repeat, Sheet as SheetIcon, Star } from 'lucide-react';
import { useState } from 'react';
import { Avatar } from '../../components/common';
import { DocIcon } from '../../components/DocBits';
import { Frame } from '../../components/Frame';
import { EmptyState, Segmented } from '../../components/kit';
import { NOW } from '../../data/mock';
import type { Block, FileKind, WS } from '../../data/ws-types';
import { fmtDate, fmtListDate } from '../../lib/format';
import { useStore, ws } from '../../state/store';
import { patch, personName, type WsOp } from '../../state/ws';
import { NewDocDialog, type NewDocInitial } from './NewDocDialog';
import { NewDeckDialog, NewSheetDialog } from './NewFiles';
import { byUpdated, editableFiles, eventLabel, fmtWhen, meetingDocs, openFile, shortPath, upcomingMeetings, type MeetingDoc } from './shared';
import { SlideThumb } from './SlideThumb';
import { LAYOUT_SETS, TEMPLATE_LABEL, TEMPLATES, type LayoutSet } from './templates';

type Tab = 'recent' | 'meetings' | 'templates';

const SUB: Record<Tab, string> = {
  recent: 'Docs, sheets and slides, newest first. Name new files with a date, a subject and a keyword so they sort and search well.',
  meetings: 'Notes linked from calendar invites. A recurring meeting keeps one running doc, newest date on top, so either person can add a topic.',
  templates: 'Start from the shape the situation needs. Each template suggests a name that follows the convention.',
};

export function DocsView() {
  const { state, dispatch } = useStore();
  const W = state.ws;
  const tab: Tab = state.route.view === 'docs' ? state.route.tab : 'recent';
  const [newDoc, setNewDoc] = useState<NewDocInitial | null>(null);
  const [newSheet, setNewSheet] = useState(false);
  const [newDeck, setNewDeck] = useState<null | { layout?: LayoutSet['id'] }>(null);
  const files = editableFiles(W);
  const meetings = meetingDocs(W);

  return (
    <Frame
      tabs={[
        { id: 'recent', label: 'Recent', count: files.length },
        { id: 'meetings', label: 'Meeting notes', count: meetings.length },
        { id: 'templates', label: 'Templates' },
      ]}
      active={tab}
      onTab={(t) => dispatch({ type: 'navigate', route: { view: 'docs', tab: t as Tab } })}
      scrollKey={tab}
    >
      <div className="page-head-row doc-page-head">
        <div>
          <h1 className="page-title">{tab === 'recent' ? 'Docs' : tab === 'meetings' ? 'Meeting notes' : 'Templates'}</h1>
          <p className="page-sub">{SUB[tab]}</p>
        </div>
        <div className="doc-head-actions">
          <button className="btn" onClick={() => setNewSheet(true)}>
            <SheetIcon size={15} aria-hidden />
            New sheet
          </button>
          <button className="btn" onClick={() => setNewDeck({})}>
            <Presentation size={15} aria-hidden />
            New deck
          </button>
          <button className="btn btn-primary" onClick={() => setNewDoc({})}>
            <FilePlus2 size={15} aria-hidden />
            New doc
          </button>
        </div>
      </div>

      {tab === 'recent' && <Recent />}
      {tab === 'meetings' && <Meetings meetings={meetings} onNew={(i) => setNewDoc(i)} />}
      {tab === 'templates' && <Templates onDoc={(i) => setNewDoc(i)} onDeck={(layout) => setNewDeck({ layout })} />}

      <NewDocDialog open={!!newDoc} initial={newDoc ?? undefined} onClose={() => setNewDoc(null)} />
      <NewSheetDialog open={newSheet} onClose={() => setNewSheet(false)} />
      <NewDeckDialog open={!!newDeck} initial={newDeck ?? undefined} onClose={() => setNewDeck(null)} />
    </Frame>
  );
}

/* ───────────── Recent ───────────── */

type KindFilter = 'all' | FileKind;

function Recent() {
  const { state, dispatch } = useStore();
  const W = state.ws;
  const [kind, setKind] = useState<KindFilter>('all');
  const files = editableFiles(W)
    .filter((f) => kind === 'all' || f.kind === kind)
    .sort(byUpdated);
  return (
    <>
      <div className="doc-filter">
        <Segmented<KindFilter>
          label="Show"
          value={kind}
          onChange={setKind}
          options={[
            { id: 'all', label: 'All' },
            { id: 'doc', label: 'Docs' },
            { id: 'sheet', label: 'Sheets' },
            { id: 'slides', label: 'Slides' },
          ]}
        />
      </div>
      {files.length === 0 ? (
        <EmptyState icon={FilePlus2} title="Nothing here yet" body="Files you create or open show up here, newest first." />
      ) : (
        <div className="table doc-recent">
          <div className="table-row table-head" role="presentation">
            <span>Name</span>
            <span>Location</span>
            <span>Owner</span>
            <span>Modified</span>
          </div>
          {files.map((f) => (
            <button key={f.id} className="table-row" onClick={() => openFile(dispatch, f.id)}>
              <span className="doc-recent-name">
                <DocIcon kind={f.kind} size={17} />
                <span className="doc-recent-text">
                  <span className="doc-recent-title">{f.name}</span>
                  <span className="doc-recent-sub">
                    {shortPath(W, f.folder)} · {f.owner === 'me' ? 'You' : personName(f.owner)}
                  </span>
                </span>
                {f.starred && <Star size={13} className="star-on doc-recent-star" fill="currentColor" aria-label="Starred" />}
              </span>
              <span className="cell-muted doc-ellipsis">{shortPath(W, f.folder)}</span>
              <span className="doc-owner">
                <Avatar id={f.owner} size={20} />
                <span className="doc-ellipsis">{f.owner === 'me' ? 'You' : personName(f.owner)}</span>
              </span>
              <span className="cell-muted mono">{fmtListDate(f.updated)}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/* ───────────── Meeting notes ───────────── */

/** Ops that add a topic to the agenda row for a meeting date, creating the row if needed. */
const addTopicOps = (W: WS, docId: string, date: Date, topic: string): WsOp[] => {
  const body = W.docs[docId];
  if (!body) return [];
  const label = fmtDate(date);
  const idx = body.blocks.findIndex((b) => b.type === 'table');
  const blocks: Block[] = body.blocks.map((b, i) => {
    if (i !== idx || b.type !== 'table') return b;
    const agenda = Math.max(1, b.columns.findIndex((c) => /agenda|topic/i.test(c)));
    const at = b.rows.findIndex((r) => r[0]?.trim() === label);
    if (at >= 0) {
      return { ...b, rows: b.rows.map((r, k) => (k === at ? r.map((c, j) => (j === agenda ? (c.trim() ? `${c.trim()}; ${topic}` : topic) : c)) : r)) };
    }
    return { ...b, rows: [b.columns.map((_, j) => (j === 0 ? label : j === agenda ? topic : '')), ...b.rows] };
  });
  if (idx < 0) return [];
  return [patch('docs', docId, { blocks }), patch('files', docId, { updated: NOW })];
};

function RunningOneOnOne({ md }: { md: MeetingDoc }) {
  const { state, dispatch } = useStore();
  const W = state.ws;
  const [topic, setTopic] = useState('');
  const table = md.body?.blocks.find((b) => b.type === 'table');
  const nextLabel = md.next ? fmtDate(md.next) : null;
  const row = table && table.type === 'table' ? (table.rows.find((r) => r[0]?.trim() === nextLabel) ?? table.rows[0]) : undefined;
  const agendaCol = table && table.type === 'table' ? Math.max(1, table.columns.findIndex((c) => /agenda/i.test(c))) : 1;
  const people = md.nextEvent?.with ?? [];

  const add = () => {
    const t = topic.trim();
    if (!t || !md.next) return;
    dispatch(ws(addTopicOps(W, md.file.id, md.next, t), { toast: `Added to the agenda for ${fmtDate(md.next)}`, undo: true }));
    setTopic('');
  };

  return (
    <article className="card doc-running">
      <div className="doc-running-head">
        <span className="doc-running-icon">
          <Repeat size={18} aria-hidden />
        </span>
        <div className="doc-running-title">
          <h2 className="section-title">{md.file.name}</h2>
          <span className="muted">
            {md.nextEvent ? `${md.nextEvent.title} · ${md.nextEvent.recurring ? 'weekly, ' : ''}linked from the invite` : 'Running notes'}
          </span>
        </div>
        <div className="doc-running-people" aria-label="People">
          {people.map((p) => (
            <Avatar key={p} id={p} size={26} />
          ))}
        </div>
      </div>
      <dl className="kv doc-running-kv">
        <dt>Next</dt>
        <dd>{md.next ? fmtWhen(md.next) : <span className="muted">No upcoming meeting</span>}</dd>
        <dt>Agenda</dt>
        <dd>{row?.[agendaCol]?.trim() ? row[agendaCol] : <span className="muted">Nothing yet. Add a topic below.</span>}</dd>
      </dl>
      <form
        className="doc-running-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input className="input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={`Add a topic for ${nextLabel ?? 'the next meeting'}`} aria-label="New agenda topic" disabled={!md.next} />
        <button className="btn" type="submit" disabled={!topic.trim() || !md.next}>
          <Plus size={14} aria-hidden />
          Add topic
        </button>
        <button className="btn btn-primary" type="button" onClick={() => openFile(dispatch, md.file.id)}>
          <ArrowUpRight size={14} aria-hidden />
          Open notes
        </button>
      </form>
    </article>
  );
}

function Meetings({ meetings, onNew }: { meetings: MeetingDoc[]; onNew: (i: NewDocInitial) => void }) {
  const { state, dispatch } = useStore();
  const W = state.ws;
  const running = meetings.filter((m) => m.body?.template === 'one-on-one');
  const linked = new Set(meetings.map((m) => m.file.id));
  const unlinked = Object.values(W.docs)
    .filter((d) => !linked.has(d.id) && (d.template === 'team-meeting' || d.template === 'one-on-one' || d.template === 'running-notes'))
    .map((d) => W.files[d.id])
    .filter((f) => !!f)
    .sort(byUpdated);
  const upcoming = upcomingMeetings(W);
  // One row per meeting series: the weekly standup shows once, not four times.
  const seen = new Set<string>();
  const withoutNotes = upcoming
    .filter((e) => !e.notesDoc && !Object.values(W.docs).some((d) => d.event === e.id) && e.with.length > 0)
    .filter((e) => (seen.has(e.title) ? false : (seen.add(e.title), true)))
    .slice(0, 5);

  const link = (docId: string, eventId: string) => {
    const e = W.events[eventId];
    if (!e) return;
    const ops: WsOp[] = [patch('docs', docId, { event: eventId })];
    if (!e.notesDoc) ops.push(patch('events', eventId, { notesDoc: docId }));
    else ops.push(patch('events', eventId, { docs: [...new Set([...(e.docs ?? []), docId])] }));
    dispatch(ws(ops, { toast: `Linked from “${e.title}”`, undo: true }));
  };

  return (
    <>
      {running.map((md) => (
        <RunningOneOnOne key={md.file.id} md={md} />
      ))}

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Linked from the calendar</h2>
          <span className="section-sub">Soonest first</span>
        </div>
        <div className="table doc-meetings">
          <div className="table-row table-head" role="presentation">
            <span>Notes</span>
            <span>Meeting</span>
            <span>Next</span>
          </div>
          {meetings.map((m) => (
            <button key={m.file.id} className="table-row" onClick={() => openFile(dispatch, m.file.id)}>
              <span className="doc-recent-name">
                <DocIcon kind="doc" size={17} />
                <span className="doc-recent-text">
                  <span className="doc-recent-title">{m.file.name}</span>
                  <span className="doc-recent-sub">{m.nextEvent?.title ?? m.events[0]?.title}</span>
                </span>
              </span>
              <span className="cell-muted doc-ellipsis">
                {(m.nextEvent ?? m.events[0])?.title}
                {m.body ? ` · ${TEMPLATE_LABEL[m.body.template]}` : ''}
              </span>
              <span className={m.next ? 'mono' : 'cell-muted'}>{m.next ? fmtWhen(m.next) : 'No upcoming meeting'}</span>
            </button>
          ))}
        </div>
      </section>

      {unlinked.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Not linked to an invite yet</h2>
            <span className="section-sub">Link notes from the invite so they open with the meeting</span>
          </div>
          <ul className="doc-unlinked">
            {unlinked.map((f) => (
              <li key={f.id}>
                <button className="doc-unlinked-name" onClick={() => openFile(dispatch, f.id)}>
                  <DocIcon kind="doc" size={16} />
                  <span className="doc-ellipsis">{f.name}</span>
                </button>
                <label className="doc-unlinked-pick">
                  <Link2 size={14} aria-hidden />
                  <select className="input" value="" onChange={(e) => e.target.value && link(f.id, e.target.value)} aria-label={`Link “${f.name}” from a meeting`}>
                    <option value="">Link from a meeting</option>
                    {upcoming.map((e) => (
                      <option key={e.id} value={e.id}>
                        {eventLabel(e)}
                      </option>
                    ))}
                  </select>
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}

      {withoutNotes.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Coming up without notes</h2>
            <span className="section-sub">Start the notes now and link them from the invite</span>
          </div>
          <ul className="doc-unlinked">
            {withoutNotes.map((e) => (
              <li key={e.id}>
                <span className="doc-unlinked-name static">
                  <CalendarClock size={16} aria-hidden />
                  <span className="doc-ellipsis">{eventLabel(e)}</span>
                </span>
                <button className="btn btn-sm" onClick={() => onNew({ event: e.id, template: e.with.length === 1 && e.recurring ? 'one-on-one' : 'team-meeting' })}>
                  <FilePlus2 size={14} aria-hidden />
                  Start notes
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/* ───────────── Templates ───────────── */

function Templates({ onDoc, onDeck }: { onDoc: (i: NewDocInitial) => void; onDeck: (layout: LayoutSet['id']) => void }) {
  return (
    <>
      <section className="section doc-first-section">
        <div className="section-head">
          <h2 className="section-title">Docs</h2>
          <span className="section-sub">Recurring meeting notes add the date for you</span>
        </div>
        <div className="doc-tpl-grid">
          {TEMPLATES.filter((t) => t.card).map((t) => (
            <button key={t.key} className="card doc-tpl-card" onClick={() => onDoc({ template: t.template, templateKey: t.key })}>
              <span className="doc-tpl-top">
                <span className="doc-tpl-icon">
                  <t.icon size={17} aria-hidden />
                </span>
                <span className="doc-tpl-name">{t.name}</span>
              </span>
              <span className="doc-tpl-blurb">{t.blurb}</span>
              <span className="doc-tpl-outline" aria-hidden>
                {t.outline.map((o) => (
                  <span key={o}>{o}</span>
                ))}
              </span>
              <span className="doc-tpl-use">
                Use template
                <ArrowUpRight size={14} aria-hidden />
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Slide layouts</h2>
          <span className="section-sub">Start decks from a reusable layout</span>
        </div>
        <div className="doc-tpl-grid">
          {LAYOUT_SETS.map((l) => (
            <button key={l.id} className="card doc-tpl-card" onClick={() => onDeck(l.id)}>
              <span className="deck-set-strip" aria-hidden>
                {l.slides.slice(0, 3).map((s, i) => (
                  <SlideThumb key={i} bare slide={{ ...s, id: `${l.id}-${i}` }} />
                ))}
              </span>
              <span className="doc-tpl-name">{l.name}</span>
              <span className="doc-tpl-blurb">{l.blurb}</span>
              <span className="doc-tpl-use">
                New deck
                <ArrowUpRight size={14} aria-hidden />
              </span>
            </button>
          ))}
        </div>
      </section>
    </>
  );
}
