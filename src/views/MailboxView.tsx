import { Archive, ArrowDown, ArrowUp, ChevronDown, ChevronRight, FilePenLine, Flame, Sparkles, Star } from 'lucide-react';
import { UrgencyTag } from '../components/Urgency';
import { useUrgency } from '../state/urgency';
import { scopedThreads } from '../state/scope';
import { ScopeNote } from '../components/ProjectScope';
import { useMemo, useState } from 'react';
import { BOXES, LABEL_GUIDE, PEOPLE, PROJECTS } from '../data/mock';
import type { Box, ProjectId, Thread } from '../data/types';
import { dayDiff, fmtListDate } from '../lib/format';
import { byNewest, byOldest, counterpart, inBox, isOverdue, labelOf, useStore } from '../state/store';
import { Avatar, Folder, ThreadChips } from '../components/common';
import { Frame, type TabDef } from '../components/Frame';

type Filter = (t: Thread) => boolean;
type Sort = 'urgency' | 'oldest' | 'newest';

const TABS: Record<string, { id: string; label: string; test: Filter }[]> = {
  'follow-up': [
    { id: 'all', label: 'All', test: () => true },
    { id: 'quick', label: 'Quick replies', test: (t) => t.effort === 'quick' },
    { id: 'focus', label: 'Needs focus', test: (t) => t.effort === 'focus' },
  ],
  waiting: [
    { id: 'all', label: 'All', test: () => true },
    { id: 'late', label: 'Late', test: isOverdue },
    { id: 'week', label: 'Due this week', test: (t) => !!t.waiting?.due && !isOverdue(t) && dayDiff(t.waiting.due) < 7 },
    { id: 'nodate', label: 'No date', test: (t) => !t.waiting?.due },
  ],
  inbox: [
    { id: 'all', label: 'All', test: () => true },
    { id: 'sure', label: 'Timmy is sure', test: (t) => t.suggestion?.confidence === 'high' },
    { id: 'unsure', label: 'Needs your call', test: (t) => t.suggestion?.confidence !== 'high' },
  ],
  'read-through': [
    { id: 'all', label: 'All', test: () => true },
    { id: 'report', label: 'Reports', test: (t) => t.kind === 'report' },
    { id: 'howto', label: 'How-to', test: (t) => t.kind === 'howto' },
    { id: 'reference', label: 'Reference', test: (t) => t.kind === 'reference' },
  ],
  archived: [{ id: 'all', label: 'All', test: () => true }],
  project: [
    { id: 'all', label: 'Open', test: (t) => t.box !== 'archived' },
    { id: 'owe', label: 'I owe', test: (t) => t.box === 'follow-up' },
    { id: 'waiting', label: 'Waiting', test: (t) => t.box === 'waiting' },
  ],
};

export function MailboxView({ box, tab }: { box: Box | ProjectId; tab: string }) {
  const { state, dispatch } = useStore();
  const isProject = !!state.ws.projects[box] || PROJECTS.some((p) => p.id === box);
  const label = labelOf(box, state.ws);
  const tabs = TABS[isProject ? 'project' : box]!;
  const active = tabs.find((t) => t.id === tab) ?? tabs[0]!;

  // The project picker narrows every mail list except the archive's search-style view.
  const base = isProject ? state.threads.filter((t) => t.project === box) : scopedThreads(state, inBox(state.threads, box));

  const [from, setFrom] = useState('');
  const [onlyDrafts, setOnlyDrafts] = useState(false);
  const [sort, setSort] = useState<Sort>(box === 'inbox' ? 'oldest' : box === 'follow-up' || box === 'waiting' || isProject ? 'urgency' : 'newest');
  const { rank } = useUrgency();

  const senders = useMemo(() => [...new Set(base.map(counterpart))], [base]);

  const filtered = base
    .filter(active.test)
    .filter((t) => !from || t.participants.includes(from))
    .filter((t) => !onlyDrafts || !!t.draft);
  const rows = sort === 'urgency' ? rank(filtered).map((x) => x.t) : [...filtered].sort(sort === 'oldest' ? byOldest : byNewest);

  const tabDefs: TabDef[] = tabs.map((t) => ({ id: t.id, label: t.label, count: base.filter(t.test).length }));
  const guide = LABEL_GUIDE[box];

  return (
    <Frame tabs={tabDefs} active={active.id} onTab={(id) => dispatch({ type: 'navigate', route: { view: 'box', box, tab: id } })} scrollKey={box}>
      <nav className="crumbs" aria-label="Breadcrumb">
        <button onClick={() => dispatch({ type: 'navigate', route: { view: 'today', tab: 'brief' } })}>Mail</button>
        <ChevronRight size={14} aria-hidden />
        {isProject && (
          <>
            <span>Projects</span>
            <ChevronRight size={14} aria-hidden />
          </>
        )}
        <span className="crumb-current" aria-current="page">
          [{label.num}] {label.name}
        </span>
      </nav>

      <div className="box-title">
        <Folder color={label.color} size={30} />
        <h1 className="page-title">{label.name}</h1>
      </div>
      <p className="page-sub">{guide ? guide.body : `Everything for ${label.name}, filed where you’ll use it.`}</p>
      {!isProject && <ScopeNote hidden={inBox(state.threads, box).length - base.length} />}

      <div className="filters">
        <label className="filter">
          <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Filter by person">
            <option value="">People</option>
            {senders.map((id) => (
              <option key={id} value={id}>
                {PEOPLE[id]!.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </label>
        <button className="filter" aria-pressed={onlyDrafts} onClick={() => setOnlyDrafts((v) => !v)}>
          <FilePenLine size={14} />
          Has draft
        </button>
        <label className="filter">
          {sort === 'urgency' ? <Flame size={14} /> : sort === 'oldest' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
            <option value="urgency">Most urgent first</option>
            <option value="oldest">Oldest first</option>
            <option value="newest">Newest first</option>
          </select>
          <ChevronDown size={14} />
        </label>
        {(from || onlyDrafts) && (
          <button className="btn btn-xs btn-ghost" onClick={() => (setFrom(''), setOnlyDrafts(false))}>
            Clear
          </button>
        )}
      </div>

      <div className="list-head">
        <span>
          {rows.length} {rows.length === 1 ? 'thread' : 'threads'}
          {box === 'archived' && ' shown · 2,418 more searchable'}
        </span>
        {box === 'inbox' && rows.length > 0 && (
          <button className="btn btn-xs" onClick={() => dispatch({ type: 'navigate', route: { view: 'today', tab: 'triage' } })}>
            <Sparkles size={13} />
            Open in triage
          </button>
        )}
      </div>

      <div role="list">
        {rows.map((t) => (
          <ThreadRow key={t.id} t={t} showProject={!isProject} />
        ))}
      </div>

      {rows.length === 0 && (
        <div className="empty">
          <span className="empty-icon">
            <Archive size={20} />
          </span>
          <strong>{base.length === 0 ? `${label.name} is empty` : 'No threads match'}</strong>
          <span>{base.length === 0 ? 'Timmy will file new mail here as it arrives.' : 'Try another tab or clear the filters.'}</span>
        </div>
      )}
    </Frame>
  );
}

export function ThreadRow({ t, showProject = true }: { t: Thread; showProject?: boolean }) {
  const { dispatch } = useStore();
  const { of } = useUrgency();
  const who = t.box === 'waiting' && t.waiting ? t.waiting.on : counterpart(t);
  const person = PEOPLE[who]!;
  const last = t.messages[t.messages.length - 1]!;
  const boxLabel = BOXES.find((b) => b.id === t.box)!;

  return (
    <div
      role="listitem"
      tabIndex={0}
      className={`row${t.unread ? ' unread' : ''}`}
      onClick={() => dispatch({ type: 'openThread', id: t.id })}
      onKeyDown={(e) => {
        if (e.key === 'Enter') dispatch({ type: 'openThread', id: t.id });
      }}
    >
      <Avatar id={who} size={36} />
      <div className="row-body">
        <div className="row-top">
          <span className="row-from">{person.name}</span>
          <span className="row-company">
            {person.company && !person.internal ? person.company : person.title}
            {t.messages.length > 1 && ` · ${t.messages.length} messages`}
          </span>
        </div>
        <span className="row-subject">{t.subject}</span>
        <span className="row-ask">
          <Sparkles size={13} />
          {t.ask}
        </span>
        <ThreadChips t={t} showProject={showProject} />
      </div>
      <div className="row-meta">
        <span className="row-time">{fmtListDate(last.at)}</span>
        <UrgencyTag info={of(t)} />
        {showProject === false && (
          <span className="chip plain" style={{ ['--tint' as string]: boxLabel.color }}>
            <span className="dot" />
            {boxLabel.name}
          </span>
        )}
        <div className="row-actions">
          <button
            className={`icon-btn sm${t.starred ? ' on' : ''}`}
            aria-label={t.starred ? 'Unstar' : 'Star'}
            onClick={(e) => {
              e.stopPropagation();
              dispatch({ type: 'toggleStar', id: t.id });
            }}
          >
            <Star size={15} fill={t.starred ? 'currentColor' : 'none'} />
          </button>
          {t.box !== 'archived' && (
            <button
              className="icon-btn sm"
              aria-label="Archive"
              onClick={(e) => {
                e.stopPropagation();
                dispatch({ type: 'move', id: t.id, box: 'archived' });
              }}
            >
              <Archive size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

