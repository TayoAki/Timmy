import {
  ArrowRight,
  BadgeDollarSign,
  CalendarDays,
  ChevronDown,
  FilePenLine,
  FolderInput,
  Inbox,
  ListChecks,
  MoveRight,
  Plus,
  Send,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { DOCS, FOLDERS, NOW, PEOPLE, RELATIONSHIPS } from '../data/mock';
import type { ActivityKind, RuleGroup } from '../data/types';
import { dayDiff, fmtDay, fmtStamp, fmtTime, money } from '../lib/format';
import { useStore } from '../state/store';
import { Avatar, DueChip, Folder, TimmyMark, tint } from '../components/common';
import { DocIcon } from '../components/DocBits';
import { Frame } from '../components/Frame';
import { RULE_GROUPS } from '../components/Sidebar';

// ───────────── Activity ─────────────

const KIND_META: Record<ActivityKind, { icon: LucideIcon; color: string; label: string }> = {
  triage: { icon: Inbox, color: 'var(--c-slate)', label: 'Sorted' },
  move: { icon: MoveRight, color: 'var(--c-amber)', label: 'Moved' },
  draft: { icon: FilePenLine, color: 'var(--c-violet)', label: 'Drafted' },
  send: { icon: Send, color: 'var(--accent)', label: 'Sent' },
  file: { icon: FolderInput, color: 'var(--c-sky)', label: 'Filed' },
  task: { icon: ListChecks, color: 'var(--c-red)', label: 'Task' },
  calendar: { icon: CalendarDays, color: 'var(--c-green)', label: 'Calendar' },
  crm: { icon: BadgeDollarSign, color: 'var(--c-teal)', label: 'CRM' },
};

const ACTIVITY_TABS: { id: string; label: string; kinds: ActivityKind[] | null }[] = [
  { id: 'all', label: 'All', kinds: null },
  { id: 'sorting', label: 'Sorting', kinds: ['triage', 'move'] },
  { id: 'drafts', label: 'Drafts & sends', kinds: ['draft', 'send'] },
  { id: 'files', label: 'Files', kinds: ['file'] },
  { id: 'other', label: 'Tasks, calendar & CRM', kinds: ['task', 'calendar', 'crm'] },
];

export function ActivityView({ tab }: { tab: string }) {
  const { state, dispatch } = useStore();
  const active = ACTIVITY_TABS.find((t) => t.id === tab) ?? ACTIVITY_TABS[0]!;
  const [undone, setUndone] = useState<string[]>([]);
  const items = [...state.activity]
    .filter((a) => !active.kinds || active.kinds.includes(a.kind))
    .sort((a, b) => b.at.getTime() - a.at.getTime());

  const groups = new Map<string, typeof items>();
  for (const a of items) {
    const diff = dayDiff(a.at);
    const key = diff === 0 ? 'Today' : diff === -1 ? 'Yesterday' : fmtDay(a.at);
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }

  return (
    <Frame
      tabs={ACTIVITY_TABS.map((t) => ({
        id: t.id,
        label: t.label,
        count: state.activity.filter((a) => !t.kinds || t.kinds.includes(a.kind)).length,
      }))}
      active={active.id}
      onTab={(id) => dispatch({ type: 'navigate', route: { view: 'activity', tab: id } })}
    >
      <h1 className="page-title">Timmy’s activity</h1>
      <p className="page-sub">Everything Timmy did on your behalf, newest first. Undo anything for 7 days.</p>

      {[...groups.entries()].map(([day, list]) => (
        <section key={day} className="section">
          <div className="section-head">
            <h2 className="section-title">{day}</h2>
            <span className="section-sub">{list.length} actions</span>
          </div>
          <ol className="log">
            {list.map((a) => {
              const meta = KIND_META[a.kind];
              const isUndone = undone.includes(a.id);
              return (
                <li key={a.id} className={`log-item${isUndone ? ' undone' : ''}`}>
                  <span className="nav-icon" style={tint(meta.color)}>
                    <meta.icon size={15} />
                  </span>
                  <div className="log-text">
                    <p>{a.text}</p>
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      {meta.label} · {fmtTime(a.at)}
                      {isUndone && ' · undone'}
                    </span>
                  </div>
                  <div className="log-actions">
                    {a.threadId && (
                      <button className="btn btn-xs btn-ghost" onClick={() => dispatch({ type: 'openThread', id: a.threadId!, tab: 'history' })}>
                        Open
                        <ArrowRight size={13} />
                      </button>
                    )}
                    {!a.id.startsWith('live') && !isUndone && (
                      <button
                        className="btn btn-xs"
                        onClick={() => {
                          setUndone((u) => [...u, a.id]);
                          dispatch({ type: 'toast', text: 'Undone. Timmy will ask before doing this again.' });
                        }}
                      >
                        <Undo2 size={13} />
                        Undo
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </Frame>
  );
}

// ───────────── People ─────────────

export function PeopleView({ tab, person }: { tab: string; person?: string }) {
  const { state, dispatch } = useStore();
  const tabs = [
    { id: 'priority', label: 'Priority', test: (r: (typeof RELATIONSHIPS)[number]) => !!r.priority },
    { id: 'mine', label: 'My next step', test: (r: (typeof RELATIONSHIPS)[number]) => r.owner === 'me' },
    { id: 'all', label: 'All tracked', test: () => true },
  ];
  const active = tabs.find((t) => t.id === tab) ?? tabs[0]!;
  const rows = RELATIONSHIPS.filter(active.test);
  const deals = Object.values(state.deals);

  return (
    <Frame
      tabs={tabs.map((t) => ({ id: t.id, label: t.label, count: RELATIONSHIPS.filter(t.test).length }))}
      active={active.id}
      onTab={(id) => dispatch({ type: 'navigate', route: { view: 'people', tab: id, person } })}
      wide
    >
      <h1 className="page-title">People</h1>
      <p className="page-sub">The relationships you’re actively keeping up. Each one has a next step, an owner and a date.</p>

      <div className="deal-strip">
        {deals.map((d) => (
          <button key={d.id} className="card deal-tile" onClick={() => dispatch({ type: 'navigate', route: { view: 'people', tab: active.id, person: d.contact } })}>
            <span className="deal-logo" style={tint(d.stage === 'Closed won' ? 'var(--ok)' : 'var(--c-green)')}>
              {d.company[0]}
            </span>
            <span className="deal-tile-text">
              <strong>{d.company}</strong>
              <span className="muted">{d.name}</span>
            </span>
            <span className="deal-tile-right">
              <span className="mono">{money(d.value)}</span>
              <span className={`stage${d.stage === 'Closed won' ? ' won' : ''}`}>{d.stage}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="table" role="table" aria-label="Relationships">
        <div className="table-row table-head" role="row">
          <span role="columnheader">Person</span>
          <span role="columnheader">Last interaction</span>
          <span role="columnheader">Next step</span>
          <span role="columnheader">Due</span>
        </div>
        {rows.map((r) => {
          const p = PEOPLE[r.person]!;
          return (
            <div
              key={r.person}
              role="row"
              tabIndex={0}
              className={`table-row${person === r.person ? ' selected' : ''}`}
              onClick={() => dispatch({ type: 'navigate', route: { view: 'people', tab: active.id, person: r.person } })}
              onKeyDown={(e) => e.key === 'Enter' && dispatch({ type: 'navigate', route: { view: 'people', tab: active.id, person: r.person } })}
            >
              <span role="cell" className="cell-person">
                <Avatar id={r.person} size={30} />
                <span>
                  <strong>{p.name}</strong>
                  <span className="muted">
                    {p.company} · {r.cadence}
                  </span>
                </span>
              </span>
              <span role="cell" className="cell-muted">
                {r.last}
              </span>
              <span role="cell">
                {r.next}
                <span className="owner">{r.owner === 'me' ? 'You' : PEOPLE[r.owner]!.name.split(' ')[0]}</span>
              </span>
              <span role="cell">{r.due ? <DueChip due={r.due} /> : <span className="muted">—</span>}</span>
            </div>
          );
        })}
      </div>
    </Frame>
  );
}

// ───────────── Files ─────────────

export function FilesView({ tab, folder }: { tab: string; folder: string }) {
  const { state, dispatch } = useStore();
  const [kind, setKind] = useState('');
  const top = FOLDERS.find((f) => `[${f.num}] ${f.name}` === folder);
  const parent = FOLDERS.find((f) => f.children?.some((c) => `[${c.num}] ${c.name}` === folder));
  const children = top?.children ?? [];

  const linkedIds = new Set(state.threads.flatMap((t) => t.docs ?? []));
  const docs = Object.values(DOCS)
    .filter((d) => d.path.includes(folder))
    .filter((d) => tab !== 'linked' || linkedIds.has(d.id))
    .filter((d) => !kind || d.kind === kind)
    .sort((a, b) => a.name.localeCompare(b.name));

  const threadFor = (docId: string) => state.threads.find((t) => t.docs?.includes(docId));

  return (
    <Frame
      tabs={[
        { id: 'linked', label: 'From email' },
        { id: 'all', label: 'All files' },
      ]}
      active={tab}
      onTab={(id) => dispatch({ type: 'navigate', route: { view: 'files', tab: id, folder } })}
      wide
    >
      <nav className="drive-crumbs" aria-label="Breadcrumb">
        <span>My Drive</span>
        <span className="sep">›</span>
        {parent && (
          <>
            <button onClick={() => dispatch({ type: 'navigate', route: { view: 'files', tab, folder: `[${parent.num}] ${parent.name}` } })}>
              [{parent.num}] {parent.name}
            </button>
            <span className="sep">›</span>
          </>
        )}
        <span className="drive-current">
          {folder}
          <ChevronDown size={18} />
        </span>
      </nav>

      <div className="filters">
        <label className="filter">
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="File type">
            <option value="">File type</option>
            <option value="doc">Docs</option>
            <option value="sheet">Sheets</option>
            <option value="slides">Slides</option>
            <option value="pdf">PDFs</option>
          </select>
          <ChevronDown size={14} />
        </label>
        <span className="filter">
          People
          <ChevronDown size={14} />
        </span>
        <span className="filter">
          Last modified
          <ChevronDown size={14} />
        </span>
      </div>

      <div className="table files-table" role="table" aria-label="Files">
        <div className="table-row table-head" role="row">
          <span role="columnheader">Name ↑</span>
          <span role="columnheader">Came from</span>
          <span role="columnheader">Modified</span>
        </div>
        {children.map((c) => {
          const name = `[${c.num}] ${c.name}`;
          return (
            <div
              key={name}
              role="row"
              tabIndex={0}
              className="table-row"
              onClick={() => dispatch({ type: 'navigate', route: { view: 'files', tab, folder: name } })}
              onKeyDown={(e) => e.key === 'Enter' && dispatch({ type: 'navigate', route: { view: 'files', tab, folder: name } })}
            >
              <span role="cell" className="cell-person">
                <Folder color={c.color} size={22} />
                <span>
                  <strong style={{ fontWeight: 500 }}>{name}</strong>
                </span>
              </span>
              <span role="cell" className="cell-muted">
                Folder
              </span>
              <span role="cell" className="cell-muted">
                —
              </span>
            </div>
          );
        })}
        {docs.map((d) => {
          const t = threadFor(d.id);
          return (
            <div key={d.id} role="row" className="table-row" tabIndex={0} onClick={() => t && dispatch({ type: 'openThread', id: t.id, tab: 'links' })}>
              <span role="cell" className="cell-person">
                <DocIcon kind={d.kind} size={20} />
                <span>
                  <strong style={{ fontWeight: 500 }}>{d.name}</strong>
                  {d.createdByTimmy && <span className="muted">Named and filed by Timmy</span>}
                </span>
              </span>
              <span role="cell" className="cell-muted">
                {t ? (
                  <span className="came-from">
                    <Avatar id={t.participants.find((p) => p !== 'me') ?? 'me'} size={18} />
                    {t.subject}
                  </span>
                ) : (
                  '—'
                )}
              </span>
              <span role="cell" className="cell-muted">
                {fmtStamp(d.updated)}
              </span>
            </div>
          );
        })}
      </div>
      {children.length === 0 && docs.length === 0 && (
        <div className="empty">
          <strong>Nothing here yet</strong>
          <span>{tab === 'linked' ? 'No files from email in this folder. Try “All files”.' : 'This folder is empty.'}</span>
        </div>
      )}
    </Frame>
  );
}

// ───────────── Rules ─────────────

const RULE_INTRO: Record<RuleGroup, string> = {
  triage: 'How Timmy sorts new mail. Every email ends up in Follow Up, Waiting, Read Through or the archive.',
  writing: 'How drafts should sound. Timmy also learns from the edits you make before sending.',
  files: 'Where attachments go and what they’re called, so they’re easy to find by search.',
  schedule: 'When Timmy runs and how it uses your calendar.',
};

export function RulesView({ tab }: { tab: RuleGroup }) {
  const { state, dispatch } = useStore();
  const [text, setText] = useState('');
  const group = RULE_GROUPS.find((g) => g.id === tab)!;
  const rules = state.rules.filter((r) => r.group === tab);

  return (
    <Frame
      tabs={RULE_GROUPS.map((g) => ({ id: g.id, label: g.name, count: state.rules.filter((r) => r.group === g.id).length }))}
      active={tab}
      onTab={(id) => dispatch({ type: 'navigate', route: { view: 'rules', tab: id as RuleGroup } })}
    >
      <h1 className="page-title">{group.name}</h1>
      <p className="page-sub">{RULE_INTRO[tab]}</p>

      {tab === 'triage' && (
        <div className="loop">
          {[
            { n: 'Capture', d: 'New mail arrives' },
            { n: 'Organize', d: 'Timmy sorts it at 7:00' },
            { n: 'Review', d: 'You confirm in Triage' },
            { n: 'Act', d: 'Drafts, tasks, calendar' },
          ].map((s, i) => (
            <div key={s.n} className="loop-step">
              <span className="loop-n mono">{i + 1}</span>
              <strong>{s.n}</strong>
              <span className="muted">{s.d}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'schedule' && (
        <div className="card card-pad schedule">
          <div>
            <span className="eyebrow">Daily triage</span>
            <p className="schedule-time mono">7:00 AM</p>
            <span className="muted">Monday – Friday</span>
          </div>
          <div className="week">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
              <span key={i} className={i < 5 ? 'on' : ''}>
                {d}
              </span>
            ))}
          </div>
        </div>
      )}

      <ul className="rules">
        {rules.map((r) => (
          <li key={r.id} className={`card rule${r.enabled ? '' : ' off'}`}>
            <button className="switch" role="switch" aria-checked={r.enabled} aria-label={r.enabled ? 'Turn rule off' : 'Turn rule on'} onClick={() => dispatch({ type: 'toggleRule', id: r.id })} />
            <p className="rule-text">{r.text}</p>
            <span className="rule-hits mono">{r.hits ? `${r.hits}×` : 'new'}</span>
          </li>
        ))}
      </ul>

      <form
        className="add-rule"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          dispatch({ type: 'addRule', group: tab, text: text.trim() });
          setText('');
        }}
      >
        <TimmyMark size={26} muted />
        <input className="input" placeholder="Add a rule in plain language, e.g. “Anything from Acme legal goes to Follow Up”" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn btn-primary" type="submit">
          <Plus size={15} />
          Add rule
        </button>
      </form>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
        Last run {fmtTime(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 7, 2))} today. Rule counts show how often each rule has fired.
      </p>
    </Frame>
  );
}
