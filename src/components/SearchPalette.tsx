import { FilePenLine, Hourglass, ListChecks, Paperclip, Reply, Search, UserRound } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BOXES, PEOPLE, PROJECTS } from '../data/mock';
import { pathOf } from '../state/ws';
import type { Box, Thread } from '../data/types';
import { byNewest, counterpart, labelOf, useStore } from '../state/store';
import { Avatar, Folder, Kbd, tint } from './common';
import { DocIcon } from './DocBits';

interface Parsed {
  text: string;
  from?: string;
  box?: Box;
  project?: string;
  hasDraft?: boolean;
  hasAttachment?: boolean;
}

const BOX_ALIASES: Record<string, Box> = {
  inbox: 'inbox',
  'follow-up': 'follow-up',
  followup: 'follow-up',
  owe: 'follow-up',
  waiting: 'waiting',
  'read-through': 'read-through',
  read: 'read-through',
  archived: 'archived',
  archive: 'archived',
};

function parse(q: string): Parsed {
  const out: Parsed = { text: '' };
  const words: string[] = [];
  for (const token of q.trim().split(/\s+/).filter(Boolean)) {
    const [k, v] = token.split(':') as [string, string | undefined];
    const key = k.toLowerCase();
    const val = v?.toLowerCase() ?? '';
    if (v !== undefined && key === 'from') {
      out.from = Object.values(PEOPLE).find((p) => p.name.toLowerCase().includes(val) || p.email.startsWith(val))?.id ?? '__none';
    } else if (v !== undefined && (key === 'label' || key === 'is' || key === 'in')) {
      out.box = BOX_ALIASES[val];
    } else if (v !== undefined && key === 'project') {
      out.project = PROJECTS.find((p) => p.id.startsWith(val) || p.name.toLowerCase().includes(val))?.id ?? '__none';
    } else if (v !== undefined && key === 'has') {
      if (val.startsWith('draft')) out.hasDraft = true;
      if (val.startsWith('attach') || val === 'file') out.hasAttachment = true;
    } else {
      words.push(token);
    }
  }
  out.text = words.join(' ').toLowerCase();
  return out;
}

const threadText = (t: Thread) =>
  [t.subject, t.ask, ...t.participants.map((p) => PEOPLE[p]!.name), ...t.messages.flatMap((m) => m.body)].join(' ').toLowerCase();

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

interface Result {
  key: string;
  icon: ReactNode;
  title: ReactNode;
  sub: ReactNode;
  meta?: ReactNode;
  run: () => void;
  group: string;
}

const TIPS = [
  { q: 'from:dana ', d: 'Search by who sent it. People are easier to remember than dates.' },
  { q: 'is:follow-up has:draft ', d: 'Replies Timmy has ready for you to send.' },
  { q: 'is:waiting ', d: 'Everything someone has promised you.' },
  { q: 'project:acme has:attachment ', d: 'Files that arrived by email for one project.' },
];

export function SearchPalette() {
  const { state, dispatch } = useStore();
  const [q, setQ] = useState(state.searchQuery);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const close = () => dispatch({ type: 'search', open: false });

  useEffect(() => {
    input.current?.focus();
  }, []);

  const p = useMemo(() => parse(q), [q]);
  const hasQuery = q.trim().length > 0;

  const results: Result[] = useMemo(() => {
    const out: Result[] = [];
    const threads = (hasQuery ? state.threads : state.threads.filter((t) => t.starred || t.unread))
      .filter((t) => !p.from || t.participants.includes(p.from))
      .filter((t) => !p.box || t.box === p.box)
      .filter((t) => !p.project || t.project === p.project)
      .filter((t) => !p.hasDraft || !!t.draft)
      .filter((t) => !p.hasAttachment || t.messages.some((m) => m.attachments?.length))
      .filter((t) => !p.text || threadText(t).includes(p.text))
      .sort(byNewest)
      .slice(0, 7);

    for (const t of threads) {
      const label = labelOf(t.box);
      out.push({
        key: `t-${t.id}`,
        group: hasQuery ? 'Threads' : 'Starred & unread',
        icon: <Avatar id={counterpart(t)} size={28} />,
        title: <Highlight text={t.subject} q={p.text} />,
        sub: (
          <>
            {PEOPLE[counterpart(t)]!.name} · <Highlight text={t.ask} q={p.text} />
          </>
        ),
        meta: (
          <span className="chip plain" style={tint(label.color)}>
            <span className="dot" />
            {label.name}
          </span>
        ),
        run: () => {
          close();
          dispatch({ type: 'openThread', id: t.id });
        },
      });
    }

    if (hasQuery && !p.box && !p.hasDraft) {
      const W = state.ws;
      const projectFolder = p.project ? W.projects[p.project]?.folder : undefined;
      const files = Object.values(W.files)
        .filter((d) => !d.filing && !d.shortcutOf)
        .filter((d) => !p.text || `${d.name} ${d.description ?? ''}`.toLowerCase().includes(p.text))
        .filter((d) => !p.from || d.owner === p.from || d.sharedBy === p.from)
        .filter((d) => !projectFolder || d.folder === projectFolder || d.project === p.project)
        .sort((a, b) => b.updated.getTime() - a.updated.getTime())
        .slice(0, 5);
      for (const d of files) {
        out.push({
          key: `d-${d.id}`,
          group: 'Files',
          icon: (
            <span className="palette-file">
              <DocIcon kind={d.kind} size={16} />
            </span>
          ),
          title: <Highlight text={d.name} q={p.text} />,
          sub: pathOf(W, d.folder).join(' / '),
          run: () => {
            close();
            dispatch({ type: 'navigate', route: { view: 'file', id: d.id } });
          },
        });
      }
      if (p.text && !p.from) {
        const tasks = Object.values(W.tasks)
          .filter((x) => x.status !== 'done' && x.title.toLowerCase().includes(p.text) && (!p.project || x.project === p.project))
          .slice(0, 3);
        for (const x of tasks) {
          out.push({
            key: `t-${x.id}`,
            group: 'Tasks',
            icon: (
              <span className="palette-file">
                <ListChecks size={16} />
              </span>
            ),
            title: <Highlight text={x.title} q={p.text} />,
            sub: [x.project ? W.projects[x.project]?.name : null, x.status === 'doing' ? 'In progress' : 'To do'].filter(Boolean).join(' · '),
            run: () => {
              close();
              dispatch({ type: 'navigate', route: { view: 'tasks', tab: 'board', project: x.project } });
            },
          });
        }
        const projects = Object.values(W.projects)
          .filter((x) => `${x.name} ${x.client ?? ''}`.toLowerCase().includes(p.text))
          .slice(0, 3);
        for (const x of projects) {
          out.push({
            key: `pr-${x.id}`,
            group: 'Projects',
            icon: <Folder color={x.color} size={22} />,
            title: (
              <>
                <span className="code muted">[{x.num}]</span> <Highlight text={x.name} q={p.text} />
              </>
            ),
            sub: x.goal ?? x.client ?? '',
            run: () => {
              close();
              dispatch({ type: 'navigate', route: { view: 'project', id: x.id, tab: 'overview' } });
            },
          });
        }
      }
      const people = Object.values(W.contacts)
        .filter((x) => !x.bot && p.text && `${x.name} ${x.company ?? ''} ${x.email}`.toLowerCase().includes(p.text))
        .slice(0, 3);
      for (const x of people) {
        out.push({
          key: `p-${x.id}`,
          group: 'People',
          icon: <Avatar id={x.id} size={28} />,
          title: <Highlight text={x.name} q={p.text} />,
          sub: [x.title, x.company].filter(Boolean).join(' · ') || x.email,
          meta: (
            <span className="chip">
              <UserRound size={12} />
              from:{x.name.split(' ')[0]!.toLowerCase()}
            </span>
          ),
          run: () => {
            close();
            dispatch({ type: 'navigate', route: { view: 'contact', id: x.id, tab: 'overview' } });
          },
        });
      }
    }
    return out;
  }, [p, hasQuery, state.threads, state.ws, dispatch]);

  useEffect(() => setActive(0), [q]);

  const add = (token: string) => {
    setQ((v) => (v.includes(token.trim()) ? v : `${v.trim() ? `${v.trim()} ` : ''}${token}`));
    input.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      results[active]?.run();
    } else if (e.key === 'Escape') {
      close();
    }
  };

  let lastGroup = '';

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search mail, files and people">
        <div className="palette-input">
          <Search size={20} />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search mail, files and people…"
            aria-label="Search"
            spellCheck={false}
          />
          <Kbd>esc</Kbd>
        </div>
        <div className="palette-chips">
          <button className="filter" onClick={() => add('from:')} aria-pressed={!!p.from}>
            <UserRound size={14} />
            People
          </button>
          {BOXES.slice(1, 4).map((b) => (
            <button key={b.id} className="filter" style={tint(b.color)} onClick={() => add(`is:${b.id} `)} aria-pressed={p.box === b.id}>
              {b.id === 'follow-up' ? <Reply size={14} /> : b.id === 'waiting' ? <Hourglass size={14} /> : <span className="dot" />}
              {b.name}
            </button>
          ))}
          <button className="filter" onClick={() => add('has:draft ')} aria-pressed={!!p.hasDraft}>
            <FilePenLine size={14} />
            Has draft
          </button>
          <button className="filter" onClick={() => add('has:attachment ')} aria-pressed={!!p.hasAttachment}>
            <Paperclip size={14} />
            Attachment
          </button>
        </div>
        <div className="palette-body">
          {!hasQuery && (
            <>
              <div className="palette-group">Search like Timmy does</div>
              <div className="palette-tips">
                {TIPS.map((t) => (
                  <button key={t.q} className="palette-tip" onClick={() => add(t.q)}>
                    <code>{t.q.trim()}</code>
                    <span>{t.d}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {results.map((r, i) => {
            const header = r.group !== lastGroup ? <div className="palette-group">{r.group}</div> : null;
            lastGroup = r.group;
            return (
              <div key={r.key}>
                {header}
                <button className="palette-item" data-active={i === active} onMouseMove={() => setActive(i)} onClick={r.run}>
                  {r.icon}
                  <span style={{ minWidth: 0 }}>
                    <span className="title" style={{ display: 'block' }}>
                      {r.title}
                    </span>
                    <span className="sub" style={{ display: 'block' }}>
                      {r.sub}
                    </span>
                  </span>
                  {r.meta}
                </button>
              </div>
            );
          })}
          {hasQuery && results.length === 0 && (
            <div className="empty" style={{ padding: 32 }}>
              <strong>No matches</strong>
              <span>Try the person’s name. <code className="code">from:</code> is usually the fastest way back to a thread.</span>
            </div>
          )}
        </div>
        <div className="palette-foot">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> to move <Kbd>↵</Kbd> to open
          </span>
          <span className="hide-sm">
            Operators: <code className="code">from:</code> <code className="code">is:</code> <code className="code">project:</code>{' '}
            <code className="code">has:draft</code>
          </span>
        </div>
      </div>
    </div>
  );
}

