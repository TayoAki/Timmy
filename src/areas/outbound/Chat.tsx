/*
 * Outbound → Website chat: the chat bubble on your site. Set it up (embed
 * code, look, greeting, the questions Timmy asks, help desk answers, who takes
 * over), try it in a live preview, and read or take over visitors' chats.
 * The preview answers from your own questions and help desk answers; nothing
 * in the preview is saved.
 */
import {
  ArrowUp,
  CalendarCheck,
  Check,
  Copy,
  Globe,
  Headphones,
  ImagePlus,
  Mail,
  MessageCircle,
  MessagesSquare,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { TimmyMark } from '../../components/common';
import { Segmented } from '../../components/kit';
import { NOW, PEOPLE } from '../../data/mock';
import type { ChatConvo, ChatMsg, ChatWidget } from '../../data/ws-types';
import { fmtStamp } from '../../lib/format';
import { useStore, ws } from '../../state/store';
import { patch, put, uid } from '../../state/ws';
import { chatWidgetFor } from '../../data/ws-mock';
import { shrinkImage } from '../docs/editor/nodeviews';
import { pictureUrl } from '../../lib/files';
import { LIVE } from '../../live/config';
import { uploadPicture } from '../../live/upload';

const OWNER = PEOPLE.me!.name.split(' ')[0]!;
const COLORS = ['#3f51d9', '#0f766e', '#d9730d', '#c14c8a', '#1c1b19', '#2f8a5b'];
const SLOTS = ['Tue, Nov 17 at 10:00 AM', 'Tue, Nov 17 at 2:30 PM', 'Wed, Nov 18 at 11:00 AM'];
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const STOP = new Set(['the', 'and', 'you', 'your', 'are', 'for', 'with', 'how', 'what', 'does', 'have', 'there', 'can', 'any', 'is', 'do', 'a', 'an', 'it', 'of', 'to', 'in', 'on', 'we', 'i', 'my']);
const SYN: Record<string, string> = { price: 'cost', pricing: 'cost', much: 'cost', costs: 'cost', expensive: 'cost', trial: 'free', saml: 'sso', okta: 'sso', login: 'sso' };

const words = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => SYN[w] ?? w);

/** The help desk answer that best matches what the visitor wrote, if any matches well. */
export function matchFaq(faq: ChatWidget['faq'], text: string) {
  const t = new Set(words(text));
  let best: { f: ChatWidget['faq'][number]; score: number } | null = null;
  for (const f of faq) {
    const q = words(f.q);
    const score = q.filter((w) => t.has(w)).length / Math.max(1, Math.min(q.length, 3));
    if (score > (best?.score ?? 0)) best = { f, score };
  }
  return best && best.score >= 0.5 ? best.f : null;
}

/* ───────────── What the preview bot says ───────────── */

interface Talk {
  email?: string;
  name?: string;
  q: number;
  answers: Record<string, string>;
  booked?: string;
  handedOff?: boolean;
}

type Reply = { text: string; slots?: boolean };

export function respond(w: ChatWidget, st: Talk, text: string): { replies: Reply[]; st: Talk } {
  const next: Talk = { ...st, answers: { ...st.answers } };
  const ask = (): Reply[] => {
    if (!next.email) return [{ text: 'What’s the best email to reach you?' }];
    const q = w.questions[next.q];
    if (q) return [{ text: q.text }];
    if (w.booking && !next.booked) return [{ text: `Thanks! Want to talk it through with ${OWNER}? Pick a time:`, slots: true }];
    return [{ text: `Thanks! ${OWNER} will be in touch at ${next.email}.` }];
  };

  if (/\b(human|person|someone|agent|real|talk to|speak to|manager|call me|phone)\b/i.test(text)) {
    next.handedOff = true;
    const em = text.match(EMAIL)?.[0];
    if (em) next.email = em;
    if (w.handoff === 'book') return { replies: [{ text: `Happy to set that up with ${OWNER}. Pick a time:`, slots: true }], st: next };
    if (w.handoff === 'email' && !next.email) return { replies: [{ text: `Leave your email and ${OWNER} will write back today.` }], st: next };
    return { replies: [{ text: `I’ve let ${OWNER} know. They’ll reply here${next.email ? `, or by email at ${next.email}` : '. What’s the best email in case you step away?'}` }], st: next };
  }

  const em = text.match(EMAIL)?.[0];
  if (em && !next.email) {
    next.email = em;
    const local = em.split('@')[0]!.split(/[._-]/)[0]!;
    next.name = local.charAt(0).toUpperCase() + local.slice(1);
    const rest = ask();
    return { replies: [{ text: `Thanks, ${next.name}! ${rest[0]!.text}`, slots: rest[0]!.slots }], st: next };
  }

  const f = matchFaq(w.faq, text);
  if (f) return { replies: [{ text: f.a }, ...(next.email ? [] : ask())], st: next };

  if (next.email && next.q < w.questions.length) {
    next.answers[w.questions[next.q]!.id] = text.trim();
    next.q += 1;
    return { replies: ask(), st: next };
  }

  if (!next.email) return { replies: [{ text: `Good question. I don’t have that answer yet, so ${OWNER} will reply. What’s the best email to reach you?` }], st: next };
  return { replies: [{ text: `Thanks. I’ve passed that to ${OWNER}.` }], st: next };
}

/* ───────────── Shared pieces ───────────── */

function BotFace({ w, size = 34 }: { w: ChatWidget; size?: number }) {
  return w.icon ? (
    <img className="wc-face" src={pictureUrl(w.icon)} alt="" width={size} height={size} />
  ) : (
    <span className="wc-face mark" style={{ width: size, height: size }}>
      <TimmyMark size={size} />
    </span>
  );
}

const initials = (c: ChatConvo) => (c.name ?? c.email ?? 'Visitor').split(/[\s@.]/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join('');
const timeOf = (d: Date) => (d.toDateString() === NOW.toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }));

function Bubble({ m, w, visitor }: { m: ChatMsg; w: ChatWidget; visitor?: string }) {
  const mine = m.from === 'visitor';
  return (
    <div className={`wc-row${mine ? ' visitor' : ''}`}>
      {mine ? <span className="wc-face visitor">{visitor ?? <MessageCircle size={14} />}</span> : m.from === 'you' ? <span className="wc-face you">{OWNER[0]}</span> : <BotFace w={w} size={26} />}
      <div className={`wc-bubble ${m.from}`} style={mine ? ({ '--wc': w.color } as CSSProperties) : undefined}>
        <span className="wc-time">
          {m.from === 'you' ? `${OWNER} · ` : m.from === 'timmy' ? 'Timmy · ' : ''}
          {timeOf(m.at)}
        </span>
        {m.image ? <img className="wc-img" src={m.image} alt="Attached by the visitor" /> : <p>{m.text}</p>}
      </div>
    </div>
  );
}

/* ───────────── The tab ───────────── */

export function ChatTab() {
  const { state } = useStore();
  const [view, setView] = useState<'setup' | 'chats'>(() => (Object.values(state.ws.chats ?? {}).some((c) => c.unread) ? 'chats' : 'setup'));
  const w = state.ws.chat?.site ?? chatWidgetFor(PEOPLE.me?.company ?? 'Your business');
  const unread = Object.values(state.ws.chats ?? {}).filter((c) => c.unread).length;
  return (
    <div className="wc">
      <div className="wc-head">
        <div>
          <h2 className="au-title">Website chat</h2>
          <p className="muted">
            Timmy answers visitors on {w.domain || 'your site'} from your help desk answers, asks your questions and books calls. You can take over any chat.
          </p>
        </div>
        <Segmented
          label="Website chat"
          value={view}
          onChange={setView}
          options={[
            { id: 'chats', label: unread ? `Chats · ${unread} new` : 'Chats' },
            { id: 'setup', label: 'Set up' },
          ]}
        />
      </div>
      {view === 'setup' ? <Setup w={w} /> : <Chats w={w} />}
    </div>
  );
}

/* ───────────── Set up ───────────── */

function Section({ title, hint, children, aside }: { title: string; hint: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="wc-sec">
      <header className="wc-sec-head">
        <span>
          <h3>{title}</h3>
          <p className="muted">{hint}</p>
        </span>
        {aside}
      </header>
      {children}
    </section>
  );
}

function Setup({ w }: { w: ChatWidget }) {
  const { state, dispatch } = useStore();
  // A workspace that has never saved its chat settings gets them on the first change.
  const set = (change: Partial<ChatWidget>, toast?: string) =>
    dispatch(ws([state.ws.chat?.[w.id] ? patch('chat', w.id, change) : put('chat', { ...w, ...change })], toast ? { toast } : undefined));
  const [domain, setDomain] = useState(w.domain);
  const [q, setQ] = useState('');
  const [fq, setFq] = useState('');
  const [fa, setFa] = useState('');
  const upload = useRef<HTMLInputElement>(null);
  const validDomain = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  const snippet = `<script src="https://timmy.app/chat.js" data-site="${w.domain || 'your-site'}" async></script>`;

  return (
    <div className="wc-setup">
      <div className="wc-form">
        <Section
          title="Show the chat"
          hint="The bubble sits in the bottom-right corner of every page."
          aside={
            <span className={`ae-switch${w.on ? ' on' : ''}`}>
              <span>{w.on ? 'On' : 'Off'}</span>
              <button role="switch" aria-checked={w.on} aria-label="Show the chat on your website" className="ae-switch-track" onClick={() => set({ on: !w.on }, w.on ? 'The chat is hidden on your site' : 'The chat is live on your site')}>
                <span className="ae-switch-thumb" />
              </button>
            </span>
          }
        >
          <label className="field">
            <span className="field-label">Website</span>
            <span className="wc-domain">
              <Globe size={15} aria-hidden />
              <input
                className="input"
                value={domain}
                aria-invalid={!validDomain}
                onChange={(e) => setDomain(e.target.value)}
                onBlur={() => validDomain && domain.trim() !== w.domain && set({ domain: domain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '') }, 'Website saved')}
              />
            </span>
            {!validDomain && <span className="field-error">That doesn’t look like a website address, e.g. northpeak.io</span>}
          </label>
        </Section>

        <Section title="Code snippet" hint="Paste this into the <head> of your website, or send it to whoever runs it.">
          <div className="wc-code">
            <pre>
              <code>{snippet}</code>
            </pre>
            <button
              className="btn btn-xs"
              onClick={() => {
                navigator.clipboard?.writeText(snippet).catch(() => undefined);
                dispatch({ type: 'toast', text: 'Copied. Paste it before </head> on your website.' });
              }}
            >
              <Copy size={13} aria-hidden />
              Copy
            </button>
          </div>
        </Section>

        <Section title="Look" hint="Name, picture and colour, so the chat feels like yours.">
          <div className="wc-look">
            <BotFace w={w} size={44} />
            <div className="wc-look-btns">
              <button className="btn btn-sm" onClick={() => upload.current?.click()}>
                <ImagePlus size={14} aria-hidden />
                {w.icon ? 'Change picture' : 'Upload a picture'}
              </button>
              {w.icon && (
                <button className="btn btn-sm btn-ghost" onClick={() => set({ icon: undefined })}>
                  Use Timmy’s
                </button>
              )}
              <input
                ref={upload}
                type="file"
                accept="image/png,image/jpeg"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  // On a real workspace the picture is uploaded and the settings keep a reference to it. The demo keeps it inline.
                  if (!LIVE) return set({ icon: await shrinkImage(f, 256) }, 'Picture updated');
                  uploadPicture(f, 'chat-icon', 256).then(
                    (icon) => set({ icon }, 'Picture updated'),
                    (err: Error) => dispatch({ type: 'toast', text: err.message, tone: 'warn' }),
                  );
                }}
              />
            </div>
          </div>
          <label className="field">
            <span className="field-label">Business name</span>
            <input className="input" value={w.name} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <div className="field">
            <span className="field-label">Colour</span>
            <div className="wc-colors" role="radiogroup" aria-label="Colour">
              {COLORS.map((c) => (
                <button key={c} role="radio" aria-checked={w.color === c} aria-label={c} className="wc-color" style={{ background: c }} onClick={() => set({ color: c })}>
                  {w.color === c && <Check size={13} strokeWidth={3} aria-hidden />}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span className="field-label">Greeting</span>
            <textarea className="input" rows={3} value={w.greeting} onChange={(e) => set({ greeting: e.target.value })} />
          </label>
        </Section>

        <Section title="Questions Timmy asks" hint="Once a visitor leaves an email, Timmy asks these one at a time. The answers go with the lead.">
          <ol className="wc-qs">
            {w.questions.map((x, i) => (
              <li key={x.id}>
                <span className="wc-q-n">{i + 1}</span>
                <span className="wc-q-text">{x.text}</span>
                <button className="icon-btn sm" aria-label={`Remove “${x.text}”`} onClick={() => set({ questions: w.questions.filter((y) => y.id !== x.id) })}>
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
            {w.questions.length === 0 && <li className="muted">No questions yet. Timmy will just take an email.</li>}
          </ol>
          <form
            className="wc-add"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (!q.trim()) return;
              set({ questions: [...w.questions, { id: uid('q'), text: q.trim() }] });
              setQ('');
            }}
          >
            <input className="input" placeholder="Add a question, e.g. What’s your budget?" value={q} onChange={(e) => setQ(e.target.value)} aria-label="New question" />
            <button className="btn" type="submit" disabled={!q.trim()}>
              <Plus size={14} aria-hidden />
              Add
            </button>
          </form>
        </Section>

        <Section title="Help desk answers" hint="Questions people often ask, and your answers. Timmy uses these word for word.">
          <div className="wc-faq">
            {w.faq.map((f) => (
              <details key={f.id} className="wc-faq-item">
                <summary>
                  {f.q}
                  <button
                    className="icon-btn sm"
                    aria-label={`Remove “${f.q}”`}
                    onClick={(e) => {
                      e.preventDefault();
                      set({ faq: w.faq.filter((y) => y.id !== f.id) });
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </summary>
                <p>{f.a}</p>
              </details>
            ))}
            {w.faq.length === 0 && <p className="muted">No answers yet.</p>}
          </div>
          <form
            className="wc-faq-add"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (!fq.trim() || !fa.trim()) return;
              set({ faq: [...w.faq, { id: uid('f'), q: fq.trim(), a: fa.trim() }] }, 'Answer added');
              setFq('');
              setFa('');
            }}
          >
            <input className="input" placeholder="Question, e.g. Do you integrate with Gmail?" value={fq} onChange={(e) => setFq(e.target.value)} aria-label="Help desk question" />
            <textarea className="input" rows={2} placeholder="Your answer" value={fa} onChange={(e) => setFa(e.target.value)} aria-label="Help desk answer" />
            <button className="btn" type="submit" disabled={!fq.trim() || !fa.trim()}>
              <Plus size={14} aria-hidden />
              Add answer
            </button>
          </form>
        </Section>

        <Section title="When someone asks for a person" hint="Timmy hands over instead of guessing.">
          <div className="wc-radios" role="radiogroup" aria-label="Hand-off">
            {(
              [
                ['notify', `Tell ${OWNER} and wait`, 'You get a heads-up and can take over the chat.'],
                ['book', 'Offer a call', 'Timmy shows three free times from your calendar.'],
                ['email', 'Take an email', 'You reply by email later.'],
              ] as const
            ).map(([id, label, hint]) => (
              <label key={id} className={`wc-radio${w.handoff === id ? ' on' : ''}`}>
                <input type="radio" name="handoff" checked={w.handoff === id} onChange={() => set({ handoff: id })} />
                <span>
                  <strong>{label}</strong>
                  <span className="muted">{hint}</span>
                </span>
              </label>
            ))}
          </div>
          <label className="wc-check">
            <input type="checkbox" checked={w.booking} onChange={(e) => set({ booking: e.target.checked })} />
            Offer to book a call once the questions are answered
          </label>
        </Section>
      </div>

      <div className="wc-preview-col">
        <Preview w={w} />
      </div>
    </div>
  );
}

/* ───────────── Live preview ───────────── */

function Preview({ w }: { w: ChatWidget }) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<'chat' | 'help'>('chat');
  const first = (): ChatMsg[] => [{ id: 'g', from: 'timmy', text: w.greeting, at: NOW }];
  const [msgs, setMsgs] = useState<(ChatMsg & { slots?: boolean })[]>(first);
  const [talk, setTalk] = useState<Talk>({ q: 0, answers: {} });
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMsgs((m) => (m.length === 1 && m[0]!.id === 'g' ? first() : m));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.greeting]);
  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, typing]);

  const say = (t: string, image?: string) => {
    if (!t.trim() && !image) return;
    setMsgs((m) => [...m, { id: uid('m'), from: 'visitor', text: t.trim(), at: NOW, image }]);
    setText('');
    if (image) return;
    const { replies, st } = respond(w, talk, t);
    setTalk(st);
    setTyping(true);
    window.setTimeout(() => {
      setTyping(false);
      setMsgs((m) => [...m, ...replies.map((r) => ({ id: uid('m'), from: 'timmy' as const, text: r.text, at: NOW, slots: r.slots }))]);
    }, 750);
  };

  const book = (slot: string) => {
    setTalk((t) => ({ ...t, booked: slot }));
    setMsgs((m) => [
      ...m.map((x) => ({ ...x, slots: false })),
      { id: uid('m'), from: 'visitor', text: slot, at: NOW },
      { id: uid('m'), from: 'timmy', text: `Booked: ${slot} with ${OWNER}.${talk.email ? ` The invite is on its way to ${talk.email}.` : ''}`, at: NOW },
    ]);
  };

  const restart = () => {
    setMsgs(first());
    setTalk({ q: 0, answers: {} });
    setTyping(false);
  };

  return (
    <div className="wc-site" aria-label="Preview of the chat on your website">
      <div className="wc-site-bar">
        <span className="wc-dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span className="wc-url">
          <Globe size={12} aria-hidden />
          {w.domain || 'your-site.com'}
        </span>
        <button className="btn btn-xs btn-ghost" onClick={restart} title="Start the preview chat again">
          <RotateCcw size={12} aria-hidden />
          Restart
        </button>
      </div>
      <div className="wc-site-page" aria-hidden>
        <span className="wc-ph w60" />
        <span className="wc-ph w40" />
        <span className="wc-ph w80 thin" />
        <span className="wc-ph w70 thin" />
      </div>
      <p className="wc-preview-note">Preview. It answers from your settings; nothing here is saved.</p>

      {w.on && open && (
        <div className="wc-window" style={{ '--wc': w.color } as CSSProperties} role="dialog" aria-label={`${w.name} chat`}>
          <header className="wc-win-head">
            <BotFace w={w} />
            <span className="wc-win-title">
              <strong>{w.name || 'Chat'}</strong>
              <span>
                <i className="wc-online" aria-hidden /> Timmy replies right away
              </span>
            </span>
            <button className="icon-btn sm" aria-label="Close the chat" onClick={() => setOpen(false)}>
              <X size={16} />
            </button>
          </header>
          <div className="wc-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>
              <MessageCircle size={13} aria-hidden /> Chat
            </button>
            <button role="tab" aria-selected={tab === 'help'} onClick={() => setTab('help')}>
              <Headphones size={13} aria-hidden /> Help desk
            </button>
          </div>
          {tab === 'chat' ? (
            <>
              <div className="wc-body" ref={body}>
                {msgs.map((m) => (
                  <div key={m.id}>
                    <Bubble m={m} w={w} />
                    {m.slots && !talk.booked && (
                      <div className="wc-slots">
                        {SLOTS.map((s) => (
                          <button key={s} className="wc-slot" onClick={() => book(s)}>
                            <CalendarCheck size={13} aria-hidden />
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {typing && (
                  <div className="wc-row">
                    <BotFace w={w} size={26} />
                    <div className="wc-bubble timmy wc-typing" aria-label="Timmy is typing">
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                )}
              </div>
              <form
                className="wc-compose"
                onSubmit={(e) => {
                  e.preventDefault();
                  say(text);
                }}
              >
                <button type="button" className="icon-btn sm" aria-label="Attach a picture" onClick={() => file.current?.click()}>
                  <Paperclip size={15} />
                </button>
                <input placeholder="Type your message" value={text} onChange={(e) => setText(e.target.value)} aria-label="Message" />
                <button type="submit" className="wc-send" aria-label="Send" disabled={!text.trim()}>
                  <ArrowUp size={15} />
                </button>
                <input
                  ref={file}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) say('', await shrinkImage(f, 800));
                  }}
                />
              </form>
            </>
          ) : (
            <div className="wc-body wc-help">
              <p className="muted">Questions people usually ask.</p>
              {w.faq.map((f) => (
                <details key={f.id} className="wc-faq-item">
                  <summary>{f.q}</summary>
                  <p>{f.a}</p>
                </details>
              ))}
              {w.faq.length === 0 && <p className="muted">No answers yet.</p>}
            </div>
          )}
          <footer className="wc-foot">Powered by Timmy</footer>
        </div>
      )}
      {w.on ? (
        <button className="wc-launcher" style={{ '--wc': w.color } as CSSProperties} aria-label={open ? 'Hide the chat' : 'Open the chat'} onClick={() => setOpen((o) => !o)}>
          {open ? <X size={22} /> : w.icon ? <img src={pictureUrl(w.icon)} alt="" /> : <MessageCircle size={24} />}
        </button>
      ) : (
        <p className="wc-off">The chat is off, so visitors don’t see it.</p>
      )}
    </div>
  );
}

/* ───────────── Visitors' chats ───────────── */

function Chats({ w }: { w: ChatWidget }) {
  const { state, dispatch } = useStore();
  const all = Object.values(state.ws.chats ?? {}).sort((a, b) => (b.messages.at(-1)?.at.getTime() ?? 0) - (a.messages.at(-1)?.at.getTime() ?? 0));
  const [filter, setFilter] = useState<'unread' | 'all' | 'starred'>(() => (all.some((c) => c.unread) ? 'unread' : 'all'));
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const list = useMemo(
    () =>
      all
        .filter((c) => (filter === 'unread' ? c.unread || c.id === openId : filter === 'starred' ? c.starred : true))
        .filter((c) => !q.trim() || `${c.name ?? ''} ${c.email ?? ''} ${c.company ?? ''} ${c.messages.map((m) => m.text).join(' ')}`.toLowerCase().includes(q.trim().toLowerCase())),
    [all, filter, q, openId],
  );
  const cur = openId ? state.ws.chats[openId] : undefined;
  const set = (id: string, change: Partial<ChatConvo>, toast?: string) => dispatch(ws([patch('chats', id, change)], toast ? { toast } : undefined));

  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight });
  }, [openId, cur?.messages.length]);

  const openChat = (c: ChatConvo) => {
    setOpenId(c.id);
    if (c.unread) set(c.id, { unread: false });
  };

  const send = () => {
    if (!cur || !text.trim()) return;
    set(cur.id, { messages: [...cur.messages, { id: uid('m'), from: 'you', text: text.trim(), at: NOW }], urgent: false });
    setText('');
  };

  return (
    <div className="wc-chats">
      <aside className="wc-list">
        <div className="wc-filter" role="tablist">
          {(
            [
              ['unread', `Unread${all.filter((c) => c.unread).length ? ` ${all.filter((c) => c.unread).length}` : ''}`],
              ['all', 'All'],
              ['starred', 'Starred'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={filter === id} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <label className="ae-search wc-search">
          <Search size={14} aria-hidden />
          <input placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search chats" />
        </label>
        <ul>
          {list.map((c) => {
            const last = c.messages.at(-1);
            return (
              <li key={c.id}>
                <button className={`wc-card${c.id === openId ? ' on' : ''}${c.unread ? ' unread' : ''}`} onClick={() => openChat(c)}>
                  <span className="wc-av">{initials(c)}</span>
                  <span className="wc-card-text">
                    <span className="wc-card-top">
                      <strong>{c.name ?? c.email ?? 'Visitor'}</strong>
                      {c.urgent && <span className="wc-urgent">Wants a person</span>}
                      <span className="wc-card-time">{last ? timeOf(last.at) : ''}</span>
                    </span>
                    <span className="wc-card-prev">{last ? `${last.from === 'visitor' ? '' : last.from === 'you' ? 'You: ' : 'Timmy: '}${last.image ? 'Sent a picture' : last.text}` : 'No messages yet'}</span>
                  </span>
                </button>
              </li>
            );
          })}
          {list.length === 0 && <li className="wc-none muted">{filter === 'unread' ? 'You’re all caught up.' : filter === 'starred' ? 'No starred chats.' : 'No chats yet.'}</li>}
        </ul>
      </aside>

      <section className="wc-thread">
        {!cur ? (
          <div className="wc-empty">
            <MessagesSquare size={22} aria-hidden />
            <strong>Pick a chat</strong>
            <span className="muted">Timmy answers on its own. Open a chat to read it or take over.</span>
          </div>
        ) : (
          <>
            <header className="wc-thread-head">
              <span className="wc-av wc-av-lg">{initials(cur)}</span>
              <span className="wc-thread-who">
                <strong>{cur.name ?? 'Visitor'}</strong>
                <span className="muted">
                  {[cur.email, cur.company, cur.page && `on ${w.domain}${cur.page}`].filter(Boolean).join(' · ') || `on ${w.domain}`}
                </span>
              </span>
              {cur.live && <span className="wc-live">Live</span>}
              <button className={`icon-btn${cur.starred ? ' on' : ''}`} aria-pressed={!!cur.starred} aria-label={cur.starred ? 'Unstar' : 'Star'} onClick={() => set(cur.id, { starred: !cur.starred })}>
                <Star size={17} fill={cur.starred ? 'currentColor' : 'none'} />
              </button>
              {cur.email && (
                <button className="btn btn-sm" onClick={() => dispatch({ type: 'compose', draft: { to: [cur.email!], subject: `Following up on your chat`, body: `Hi ${cur.name?.split(' ')[0] ?? 'there'},\n\nThanks for chatting with us on ${w.domain}.\n\n${OWNER}` } })}>
                  <Mail size={14} aria-hidden />
                  Email
                </button>
              )}
              <label className={`ae-switch wc-take${cur.live ? ' on' : ''}`}>
                <span>{cur.live ? 'You’re live' : 'Take over'}</span>
                <button
                  role="switch"
                  aria-checked={cur.live}
                  aria-label="Take over this chat"
                  className="ae-switch-track"
                  onClick={() => set(cur.id, { live: !cur.live, urgent: cur.live ? cur.urgent : false }, cur.live ? 'Timmy is answering this chat again' : 'You’re live. Timmy stops answering in this chat.')}
                >
                  <span className="ae-switch-thumb" />
                </button>
              </label>
            </header>
            {(cur.answers || cur.booked) && (
              <div className="wc-facts">
                {w.questions.map((x) =>
                  cur.answers?.[x.id] ? (
                    <span key={x.id} className="wc-fact">
                      <span className="muted">{x.text.replace(/\?$/, '')}</span> {cur.answers[x.id]}
                    </span>
                  ) : null,
                )}
                {cur.booked && (
                  <span className="wc-fact booked">
                    <CalendarCheck size={13} aria-hidden /> Booked {cur.booked}
                  </span>
                )}
              </div>
            )}
            <div className="wc-thread-body" ref={body}>
              {cur.messages.map((m) => (
                <Bubble key={m.id} m={m} w={w} visitor={initials(cur)} />
              ))}
            </div>
            <form
              className={`wc-compose wide${cur.live ? '' : ' off'}`}
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <Paperclip size={15} className="muted" aria-hidden />
              <input
                placeholder={cur.live ? `Reply to ${cur.name?.split(' ')[0] ?? 'the visitor'}` : 'Timmy is answering. Take over to reply yourself.'}
                value={text}
                disabled={!cur.live}
                onChange={(e) => setText(e.target.value)}
                aria-label="Your reply"
              />
              <button className="btn btn-primary btn-sm" type="submit" disabled={!cur.live || !text.trim()}>
                Send
              </button>
            </form>
            <p className="wc-meta muted">Last message {fmtStamp(cur.messages.at(-1)?.at ?? NOW)}</p>
          </>
        )}
      </section>
    </div>
  );
}
