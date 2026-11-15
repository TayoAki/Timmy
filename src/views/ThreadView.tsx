import {
  Archive,
  ArrowLeft,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Hourglass,
  Paperclip,
  Reply,
  Send,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DOCS, PEOPLE } from '../data/mock';
import type { Box, Draft, Thread } from '../data/types';
import { fmtDay, fmtStamp } from '../lib/format';
import { labelOf, useStore, type ThreadTab } from '../state/store';
import { Avatar, Kbd, ThreadChips, TimmyMark } from '../components/common';
import { DocIcon, DocPath, DocThumb } from '../components/DocBits';
import { Frame } from '../components/Frame';

const MOVES: { box: Box; key: string; label: string; icon: ReactNode }[] = [
  { box: 'follow-up', key: 'f', label: 'Follow Up', icon: <Reply size={15} /> },
  { box: 'waiting', key: 'w', label: 'Waiting', icon: <Hourglass size={15} /> },
  { box: 'read-through', key: 'r', label: 'Read Through', icon: <BookOpen size={15} /> },
  { box: 'archived', key: 'e', label: 'Archive', icon: <Archive size={15} /> },
];

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

export function ThreadView({ id, tab }: { id: string; tab: ThreadTab }) {
  const { state, dispatch } = useStore();
  const t = state.threads.find((x) => x.id === id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!t || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey || state.searchOpen) return;
      const move = MOVES.find((m) => m.key === e.key.toLowerCase());
      if (move) {
        e.preventDefault();
        dispatch({ type: 'move', id: t.id, box: move.box });
      } else if (e.key.toLowerCase() === 's') {
        dispatch({ type: 'toggleStar', id: t.id });
      } else if (e.key === 'Escape') {
        dispatch({ type: 'back' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [t, dispatch, state.searchOpen]);

  if (!t) return null;
  const label = labelOf(t.box);

  return (
    <Frame
      tabs={[
        { id: 'conversation', label: 'Conversation', count: t.messages.length },
        { id: 'links', label: 'Files & links', count: t.docs?.length ?? 0 },
        { id: 'history', label: 'Timmy’s log', count: t.history?.length ?? 0 },
      ]}
      active={tab}
      onTab={(x) => dispatch({ type: 'openThread', id: t.id, tab: x as ThreadTab })}
      scrollKey={`${t.id}-${tab}`}
    >
      <nav className="crumbs" aria-label="Breadcrumb">
        <button className="btn btn-xs btn-ghost" onClick={() => dispatch({ type: 'back' })} style={{ marginLeft: -8 }}>
          <ArrowLeft size={14} />
          Back
        </button>
        <span>Mail</span>
        <ChevronRight size={14} aria-hidden />
        <button onClick={() => dispatch({ type: 'navigate', route: { view: 'box', box: t.box, tab: 'all' } })}>
          [{label.num}] {label.name}
        </button>
      </nav>

      <div className="thread-head">
        <h1 className="thread-title">{t.subject}</h1>
        <button
          className={`icon-btn${t.starred ? ' on' : ''}`}
          aria-label={t.starred ? 'Unstar (S)' : 'Star (S)'}
          title="Star (S)"
          onClick={() => dispatch({ type: 'toggleStar', id: t.id })}
        >
          <Star size={18} fill={t.starred ? 'currentColor' : 'none'} />
        </button>
      </div>
      <ThreadChips t={t} />

      <div className="move-bar" role="group" aria-label="Move thread">
        {MOVES.map((m) => (
          <button
            key={m.box}
            className={`move-btn${t.box === m.box ? ' current' : ''}`}
            style={{ ['--tint' as string]: labelOf(m.box).color }}
            onClick={() => dispatch({ type: 'move', id: t.id, box: m.box })}
            aria-pressed={t.box === m.box}
          >
            {m.icon}
            <span>{m.label}</span>
            <Kbd>{m.key.toUpperCase()}</Kbd>
          </button>
        ))}
      </div>

      {tab === 'conversation' && <Conversation t={t} />}
      {tab === 'links' && <Links t={t} />}
      {tab === 'history' && <History t={t} />}
    </Frame>
  );
}

function Summary({ t }: { t: Thread }) {
  return (
    <section className="summary">
      <TimmyMark size={30} />
      <div className="summary-body">
        <p className="summary-ask">{t.ask}</p>
        {t.context && <p className="summary-context">{t.context}</p>}
      </div>
    </section>
  );
}

function Conversation({ t }: { t: Thread }) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const lastId = t.messages[t.messages.length - 1]!.id;

  return (
    <>
      <Summary t={t} />
      <div className="messages">
        {t.messages.map((m) => {
          const open = m.id === lastId || expanded.includes(m.id);
          const p = PEOPLE[m.from]!;
          return (
            <article key={m.id} className={`msg${open ? '' : ' collapsed'}`}>
              <button className="msg-head" onClick={() => setExpanded((x) => (x.includes(m.id) ? x.filter((y) => y !== m.id) : [...x, m.id]))} disabled={m.id === lastId}>
                <Avatar id={m.from} size={32} />
                <div className="msg-who">
                  <span className="row-from">{m.from === 'me' ? 'You' : p.name}</span>
                  <span className="row-company">
                    {open
                      ? `to ${m.to.map((x) => (x === 'me' ? 'you' : PEOPLE[x]!.name.split(' ')[0])).join(', ')}${m.cc?.length ? `, cc ${m.cc.map((x) => PEOPLE[x]!.name.split(' ')[0]).join(', ')}` : ''}`
                      : m.body.join(' ').replace(/\n/g, ' ').slice(0, 90)}
                  </span>
                </div>
                <span className="row-time">{fmtStamp(m.at)}</span>
              </button>
              {open && (
                <div className="msg-body">
                  {m.body.map((para, i) => (
                    <p key={i}>{para}</p>
                  ))}
                  {m.attachments && (
                    <div className="chips" style={{ marginTop: 12 }}>
                      {m.attachments.map((id) => (
                        <span key={id} className="chip">
                          <Paperclip size={12} />
                          {DOCS[id]!.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {t.draft && <DraftCard t={t} draft={t.draft} />}
    </>
  );
}

/** Mirrors Timmy's writing rules so you can see the draft follows them. */
function checks(d: Draft) {
  const firstSentence = d.body.split('\n\n')[1] ?? '';
  return [
    { ok: /\b(by|confirm|approval|send|could you)\b/i.test(d.subject) || d.subject.startsWith('Re:'), label: 'Action in subject' },
    { ok: /\?|could you|please|confirm|attached|yes/i.test(firstSentence), label: 'Ask in first sentence' },
    { ok: d.sources.length > 0, label: `${d.sources.length} source${d.sources.length === 1 ? '' : 's'} checked` },
  ];
}

function DraftCard({ t, draft }: { t: Thread; draft: Draft }) {
  const { dispatch } = useStore();
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [draft.body]);

  const track = draft.trackAs;

  return (
    <section className="draft card" aria-label="Draft reply">
      <header className="draft-head">
        <TimmyMark size={26} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong>{draft.kind === 'nudge' ? 'Timmy drafted a nudge' : 'Timmy drafted a reply'}</strong>
          <div className="chips" style={{ marginTop: 6 }}>
            {draft.sources.map((id) => (
              <span key={id} className="chip">
                <DocIcon kind={DOCS[id]!.kind} size={12} />
                {DOCS[id]!.name}
              </span>
            ))}
          </div>
        </div>
      </header>

      <div className="draft-fields">
        <div className="draft-field">
          <span className="draft-label">To</span>
          <span className="recips">
            {draft.to.map((p) => (
              <span key={p} className="recip">
                <Avatar id={p} size={18} />
                {PEOPLE[p]!.name}
              </span>
            ))}
            {draft.cc?.map((p) => (
              <span key={p} className="recip cc">
                <Avatar id={p} size={18} />
                {PEOPLE[p]!.name} <span className="muted">cc</span>
              </span>
            ))}
          </span>
        </div>
        <label className="draft-field">
          <span className="draft-label">Subject</span>
          <input
            className="draft-subject"
            value={draft.subject}
            onChange={(e) => dispatch({ type: 'updateDraft', id: t.id, body: draft.body, subject: e.target.value })}
          />
        </label>
      </div>

      <textarea
        ref={area}
        className="draft-body"
        value={draft.body}
        onChange={(e) => dispatch({ type: 'updateDraft', id: t.id, body: e.target.value })}
        aria-label="Draft body"
        spellCheck
      />

      {draft.attachments && (
        <div className="chips" style={{ padding: '0 18px 12px' }}>
          {draft.attachments.map((id) => (
            <span key={id} className="chip accent">
              <Paperclip size={12} />
              {DOCS[id]!.name}
            </span>
          ))}
        </div>
      )}

      <div className="draft-checks">
        {checks(draft).map((c) => (
          <span key={c.label} className={c.ok ? 'ok' : ''}>
            {c.ok ? <Check size={12} strokeWidth={3} /> : <CircleDot size={12} />}
            {c.label}
          </span>
        ))}
        {track && (
          <span className="draft-track">
            <Hourglass size={12} />
            On send, tracks “{track.item}” in Waiting until {fmtDay(track.due)}
          </span>
        )}
      </div>

      <footer className="draft-foot">
        <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'discardDraft', id: t.id })}>
          <Trash2 size={14} />
          Discard
        </button>
        <div className="draft-send">
          {track && (
            <button className="btn btn-sm" onClick={() => dispatch({ type: 'sendDraft', id: t.id, track: false })}>
              Send only
            </button>
          )}
          <button className="btn btn-sm btn-primary" onClick={() => dispatch({ type: 'sendDraft', id: t.id, track: true })}>
            <Send size={14} />
            {track ? 'Send & track in Waiting' : 'Send'}
          </button>
        </div>
      </footer>
    </section>
  );
}

function Links({ t }: { t: Thread }) {
  const { state, dispatch } = useStore();
  const deal = t.deal ? state.deals[t.deal] : undefined;
  return (
    <div style={{ marginTop: 24 }}>
      <div className="link-grid">
        {(t.docs ?? []).map((id) => {
          const d = DOCS[id]!;
          return (
            <article key={id} className="card link-card">
              <DocThumb doc={d} />
              <div className="link-meta">
                <div className="file-name">
                  <DocIcon kind={d.kind} size={15} />
                  <span>{d.name}</span>
                </div>
                <DocPath path={d.path} />
                <span className="muted" style={{ fontSize: 12 }}>
                  {d.createdByTimmy ? 'Saved by Timmy · ' : ''}
                  {fmtStamp(d.updated)}
                </span>
              </div>
            </article>
          );
        })}
      </div>
      {(t.docs ?? []).length === 0 && <p className="muted">No files linked to this thread.</p>}
      {deal && (
        <div className="card card-pad deal-link" style={{ marginTop: 16 }}>
          <span className="deal-logo" style={{ ['--tint' as string]: 'var(--ok)' }}>
            {deal.company[0]}
          </span>
          <div style={{ flex: 1 }}>
            <strong>
              {deal.company} — {deal.name}
            </strong>
            <div className="muted" style={{ fontSize: 13 }}>
              CRM · {deal.stage} · next: {deal.next}
            </div>
          </div>
          <button className="btn btn-sm" onClick={() => dispatch({ type: 'navigate', route: { view: 'people', tab: 'priority', person: deal.contact } })}>
            Open in People
          </button>
        </div>
      )}
    </div>
  );
}

function History({ t }: { t: Thread }) {
  const items = [...(t.history ?? [])].reverse();
  return (
    <ol className="timeline" style={{ marginTop: 24 }}>
      {items.map((h, i) => (
        <li key={i}>
          <span className="timeline-dot">
            <Sparkles size={12} />
          </span>
          <div>
            <p>{h.text}</p>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {fmtStamp(h.at)}
            </span>
          </div>
        </li>
      ))}
      {items.length === 0 && (
        <li>
          <span className="timeline-dot">
            <ChevronDown size={12} />
          </span>
          <p className="muted">Timmy hasn’t acted on this thread.</p>
        </li>
      )}
    </ol>
  );
}
