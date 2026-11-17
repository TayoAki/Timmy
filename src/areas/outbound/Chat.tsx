/*
 * Outbound → Website chat: the chat bubble on your site. Set it up (embed
 * code, look, greeting, the questions Timmy asks, help desk answers, who takes
 * over), try it in a live preview, and read or take over visitors' chats.
 * The preview answers from your own questions and help desk answers; nothing
 * in the preview is saved.
 *
 * On a real workspace (live mode) the same screens drive the real chat: the
 * snippet carries the workspace's own key, visitors' conversations arrive from
 * the server, and a teammate's actions on them are the chat's named commands.
 * Booking a call and pictures from visitors are not part of that yet.
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
import { patch, put, registerMail, uid } from '../../state/ws';
import { chatWidgetFor } from '../../data/ws-mock';
import { followUpName, newTalk, respond, type Talk } from '../../lib/chat-bot';
import { isLive } from '../../live/clock';
import { fromWire } from '../../live/patches';
import { useProfile } from '../../live/LiveApp';
import { shrinkImage } from '../docs/editor/nodeviews';

const OWNER = PEOPLE.me!.name.split(' ')[0]!;
/** Who "you" is on this screen: the demo's owner, or on a real workspace the person signed in. */
const me = () => (isLive() ? (PEOPLE.me?.name.split(' ')[0] ?? 'You') : OWNER);
const COLORS = ['#3f51d9', '#0f766e', '#d9730d', '#c14c8a', '#1c1b19', '#2f8a5b'];
const SLOTS = ['Tue, Nov 17 at 10:00 AM', 'Tue, Nov 17 at 2:30 PM', 'Wed, Nov 18 at 11:00 AM'];
/** How long a real workspace may keep visitors' conversations, in months. */
const RETENTION = [1, 3, 6, 12, 24];

/* ───────────── Shared pieces ───────────── */

function BotFace({ w, size = 34 }: { w: ChatWidget; size?: number }) {
  return w.icon ? (
    <img className="wc-face" src={w.icon} alt="" width={size} height={size} />
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
      {mine ? <span className="wc-face visitor">{visitor ?? <MessageCircle size={14} />}</span> : m.from === 'you' ? <span className="wc-face you">{(m.by ?? me())[0]}</span> : <BotFace w={w} size={26} />}
      <div className={`wc-bubble ${m.from}`} style={mine ? ({ '--wc': w.color } as CSSProperties) : undefined}>
        <span className="wc-time">
          {m.from === 'you' ? `${m.by ?? me()} · ` : m.from === 'timmy' ? 'Timmy · ' : ''}
          {timeOf(m.at)}
          {m.undelivered && <span className="wc-undelivered"> · Not shown to the visitor</span>}
        </span>
        {m.image ? <img className="wc-img" src={m.image} alt="Attached by the visitor" /> : <p>{m.text}</p>}
      </div>
    </div>
  );
}

/* ───────────── The tab ───────────── */

export function ChatTab() {
  const { state } = useStore();
  // A link to one chat (from Today, the notice, Speed to lead) opens it.
  const asked = state.route.view === 'outbound' && state.route.id && Object.hasOwn(state.ws.chats ?? {}, state.route.id) ? state.route.id : undefined;
  const [view, setView] = useState<'setup' | 'chats'>(() => (asked || Object.values(state.ws.chats ?? {}).some((c) => c.unread) ? 'chats' : 'setup'));
  const w = state.ws.chat?.site ?? chatWidgetFor(PEOPLE.me?.company ?? 'Your business');
  const unread = Object.values(state.ws.chats ?? {}).filter((c) => c.unread).length;
  return (
    <div className="wc">
      <div className="wc-head">
        <div>
          <h2 className="au-title">Website chat</h2>
          <p className="muted">
            Timmy answers visitors on {w.domain || 'your site'} from your help desk answers{isLive() ? ' and asks your questions' : ', asks your questions and books calls'}. You can take over any chat.
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
      {view === 'setup' ? <Setup w={w} /> : <Chats w={w} asked={asked} />}
    </div>
  );
}

/* ───────────── Set up ───────────── */

/**
 * Where a website loads the chat from, on a real workspace: the chat's own address when the server has one (so
 * the chat runs apart from the app), else this app's address.
 */
function useLoader(live: boolean): string | undefined {
  const [loader, setLoader] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!live) return;
    let on = true;
    const own = `${window.location.origin}/chat.js`;
    fetch('/api/v1/chat/loader', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((d: { loader?: unknown } | null) => on && setLoader(typeof d?.loader === 'string' && /^https?:\/\/[^\s"'<>]+\/chat\.js$/.test(d.loader) ? d.loader : own))
      .catch(() => on && setLoader(own));
    return () => {
      on = false;
    };
  }, [live]);
  return loader;
}

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
  // On a real workspace the snippet loads the chat from this server, with the key the server made for this website.
  const live = isLive();
  const profile = useProfile();
  const mayRun = !live || !!profile?.profile.can.policy;
  const loader = useLoader(live);
  const snippet = live ? `<script src="${loader ?? ''}" data-site="${w.siteKey ?? ''}" async></script>` : `<script src="https://timmy.app/chat.js" data-site="${w.domain || 'your-site'}" async></script>`;
  const [privacy, setPrivacy] = useState(w.privacyUrl ?? '');
  const validPrivacy = privacy.trim() === '' || /^https:\/\/[^\s"'<>\\]{1,500}$/.test(privacy.trim());

  return (
    <div className="wc-setup">
      <div className="wc-form">
        <Section
          title="Show the chat"
          hint="The bubble sits in the bottom-right corner of every page."
          aside={
            <span className={`ae-switch${w.on ? ' on' : ''}`}>
              <span>{w.on ? 'On' : 'Off'}</span>
              <button
                role="switch"
                aria-checked={w.on}
                aria-label="Show the chat on your website"
                className="ae-switch-track"
                disabled={!mayRun}
                title={mayRun ? undefined : 'Only an owner or admin can switch the chat on or off'}
                // On a real workspace the server answers: switching on needs a website and an owner or admin.
                onClick={() => set({ on: !w.on }, live ? undefined : w.on ? 'The chat is hidden on your site' : 'The chat is live on your site')}
              >
                <span className="ae-switch-thumb" />
              </button>
            </span>
          }
        >
          {live && (
            <p className="muted wc-live-note">
              {mayRun
                ? 'While the chat is on, Timmy answers visitors by itself, word for word from the settings on this page. Switching it on is your OK for those answers, so only an owner or admin can switch it on, or change it while it is on.'
                : 'Only an owner or admin can switch the chat on, or change these settings while it is on.'}
            </p>
          )}
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
          {live && !w.siteKey ? (
            <p className="muted wc-live-note">Enter your website above first. The snippet is made for that website, and the chat only shows there.</p>
          ) : live && !loader ? (
            <p className="muted wc-live-note">Getting the snippet…</p>
          ) : (
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
          )}
          {live && w.siteKey && <p className="muted wc-live-note">The chat only appears on {w.domain || 'the website above'}, with or without “www.”. Pasted anywhere else, it stays hidden.</p>}
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
                  if (f) set({ icon: await shrinkImage(f, 256) }, 'Picture updated');
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
                ['notify', `Tell ${me()} and wait`, 'You get a heads-up and can take over the chat.'],
                ['book', 'Offer a call', live ? 'Not available yet.' : 'Timmy shows three free times from your calendar.'],
                ['email', 'Take an email', 'You reply by email later.'],
              ] as const
            ).map(([id, label, hint]) => {
              // Booking from the chat isn't built for real workspaces yet, so that choice can't be picked or look picked.
              // A chat that was set to it takes an email instead, and the screen shows that.
              const unavailable = live && id === 'book';
              const picked = live && w.handoff === 'book' ? id === 'email' : w.handoff === id;
              return (
                <label key={id} className={`wc-radio${picked ? ' on' : ''}${unavailable ? ' unavailable' : ''}`}>
                  <input type="radio" name="handoff" checked={picked} disabled={unavailable} onChange={() => set({ handoff: id })} />
                  <span>
                    <strong>{label}</strong>
                    <span className="muted">{hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {live ? (
            <p className="muted wc-live-note">Booking a call from the chat isn’t available yet. Timmy takes the visitor’s email instead, and you can reply or email them from Chats.</p>
          ) : (
            <label className="wc-check">
              <input type="checkbox" checked={w.booking} onChange={(e) => set({ booking: e.target.checked })} />
              Offer to book a call once the questions are answered
            </label>
          )}
        </Section>

        {live && (
          <Section title="Privacy" hint="Visitors’ chats are personal data. Say where your privacy policy is, and how long chats are kept.">
            <label className="field">
              <span className="field-label">Privacy policy link</span>
              <input
                className="input"
                placeholder="https://your-site.com/privacy"
                value={privacy}
                aria-invalid={!validPrivacy}
                disabled={!mayRun}
                onChange={(e) => setPrivacy(e.target.value)}
                onBlur={() => validPrivacy && privacy.trim() !== (w.privacyUrl ?? '') && set({ privacyUrl: privacy.trim() })}
              />
              {!validPrivacy && <span className="field-error">Enter the full address, starting with https://</span>}
              <span className="muted wc-live-note">When set, Timmy shows a short notice with this link whenever it asks a visitor for their email.</span>
            </label>
            <label className="field">
              <span className="field-label">Keep chats for</span>
              <select className="input" aria-label="Keep chats for" value={w.retentionMonths ?? 12} disabled={!mayRun} onChange={(e) => set({ retentionMonths: Number(e.target.value) })}>
                {RETENTION.map((m) => (
                  <option key={m} value={m}>
                    {m === 1 ? '1 month' : `${m} months`}
                  </option>
                ))}
              </select>
              <span className="muted wc-live-note">Older chats are deleted for good. You can also delete any single chat from Chats.</span>
            </label>
          </Section>
        )}
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
  const [msgs, setMsgs] = useState<(ChatMsg & { slots?: boolean; privacy?: boolean })[]>(first);
  const [talk, setTalk] = useState<Talk>(newTalk);
  const live = isLive();
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
    // A real website gets what the server says: the business follows up (never a person's name), and no call is offered.
    const { replies, st } = respond(w, talk, t, live ? { owner: followUpName(w), booking: false } : { owner: OWNER, booking: true });
    setTalk(st);
    setTyping(true);
    window.setTimeout(() => {
      setTyping(false);
      setMsgs((m) => [...m, ...replies.map((r) => ({ id: uid('m'), from: 'timmy' as const, text: r.text, at: NOW, slots: r.slots, privacy: live && !!r.asksEmail && !!w.privacyUrl }))]);
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
    setTalk(newTalk());
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
      <p className="wc-preview-note">
        Preview. It answers from your settings; nothing here is saved.{live && !w.on ? ' The chat is off, so visitors don’t see it yet.' : ''}
      </p>

      {/* On a real workspace the preview can be tried before the chat is switched on for visitors. */}
      {(w.on || live) && open && (
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
                    {m.privacy && w.privacyUrl && (
                      <p className="wc-privacy muted">
                        Your email is only used to reply to you.{' '}
                        <a href={w.privacyUrl} target="_blank" rel="noopener noreferrer">
                          Privacy policy
                        </a>
                      </p>
                    )}
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
                {/* Visitors can't send pictures on a real website yet, so the preview doesn't offer it there. */}
                {!live && (
                  <button type="button" className="icon-btn sm" aria-label="Attach a picture" onClick={() => file.current?.click()}>
                    <Paperclip size={15} />
                  </button>
                )}
                <input placeholder="Type your message" value={text} maxLength={live ? 2000 : undefined} onChange={(e) => setText(e.target.value)} aria-label="Message" />
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
      {w.on || live ? (
        <button className="wc-launcher" style={{ '--wc': w.color } as CSSProperties} aria-label={open ? 'Hide the chat' : 'Open the chat'} onClick={() => setOpen((o) => !o)}>
          {open ? <X size={22} /> : w.icon ? <img src={w.icon} alt="" /> : <MessageCircle size={24} />}
        </button>
      ) : (
        <p className="wc-off">The chat is off, so visitors don’t see it.</p>
      )}
    </div>
  );
}

/* ───────────── Visitors' chats ───────────── */

/** A chat older than the ones the screen lists, as the server describes it. */
interface OlderChat {
  id: string;
  name?: string;
  email?: string;
  page?: string;
  at: Date;
  messages: number;
  last?: { from: ChatMsg['from']; text: string };
}

const olderInitials = (c: OlderChat) => initials({ id: c.id, name: c.name, email: c.email, messages: [], live: false, unread: false });

/**
 * The chats kept beyond the newest ones listed above, read from the server a page at a time (real workspaces
 * only). They can be read and deleted; a newer message from the visitor brings a chat back to the list above.
 */
function OlderChats({ openId, onOpen }: { openId?: string; onOpen: (c: OlderChat) => void }) {
  const { dispatch } = useStore();
  const [pages, setPages] = useState<{ items: OlderChat[]; next: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const more = async (next?: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/chat/conversations${next ? `?before=${encodeURIComponent(next)}` : ''}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('not loaded');
      const page = fromWire<{ conversations: OlderChat[]; next: string | null }>(await res.text());
      setPages((p) => {
        const kept = next ? (p?.items ?? []) : [];
        return { items: [...kept, ...page.conversations.filter((c) => !kept.some((x) => x.id === c.id))], next: page.next };
      });
    } catch {
      dispatch({ type: 'toast', text: 'The older chats couldn’t be loaded. Try again.', tone: 'warn' });
    } finally {
      setBusy(false);
    }
  };
  if (!pages)
    return (
      <div className="wc-older">
        <button className="btn btn-xs btn-ghost" disabled={busy} onClick={() => void more()}>
          Show older chats
        </button>
      </div>
    );
  return (
    <div className="wc-older" role="region" aria-label="Older chats">
      <h4 className="wc-older-title">Older chats</h4>
      <ul>
        {pages.items.map((c) => (
          <li key={c.id}>
            <button className={`wc-card${c.id === openId ? ' on' : ''}`} onClick={() => onOpen(c)}>
              <span className="wc-av">{olderInitials(c)}</span>
              <span className="wc-card-text">
                <span className="wc-card-top">
                  <strong>{c.name ?? c.email ?? 'Visitor'}</strong>
                  <span className="wc-card-time">{timeOf(c.at)}</span>
                </span>
                <span className="wc-card-prev">{c.last ? `${c.last.from === 'visitor' ? '' : c.last.from === 'you' ? 'You: ' : 'Timmy: '}${c.last.text}` : 'Nothing was shown to the visitor'}</span>
              </span>
            </button>
          </li>
        ))}
        {pages.items.length === 0 && <li className="wc-none muted">No older chats. Every chat is listed above.</li>}
      </ul>
      {pages.next && (
        <button className="btn btn-xs btn-ghost" disabled={busy} onClick={() => void more(pages.next!)}>
          Show more
        </button>
      )}
    </div>
  );
}

/** An older chat, read from the stored copy. It can be read and deleted, not answered: it is not on the list of live chats. */
function OlderThread({ c, w, onGone }: { c: OlderChat; w: ChatWidget; onGone: () => void }) {
  const { dispatch } = useStore();
  const [messages, setMessages] = useState<ChatMsg[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let on = true;
    fetch(`/api/v1/chat/conversations/${encodeURIComponent(c.id)}/messages`, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error('not loaded');
        const got = fromWire<{ messages: ChatMsg[] }>(await res.text()).messages;
        if (on) setMessages(got);
      })
      .catch(() => on && setFailed(true));
    return () => {
      on = false;
    };
  }, [c.id]);
  const remove = () => {
    if (!window.confirm('Delete this chat for good? Its messages are removed from Timmy and can’t be brought back.')) return;
    dispatch({ type: 'chat', op: { op: 'delete', id: c.id } });
    onGone();
  };
  return (
    <>
      <header className="wc-thread-head">
        <span className="wc-av wc-av-lg">{olderInitials(c)}</span>
        <span className="wc-thread-who">
          <strong>{c.name ?? 'Visitor'}</strong>
          <span className="muted">{[c.email, c.page && `on ${w.domain}${c.page}`].filter(Boolean).join(' · ') || `on ${w.domain}`}</span>
        </span>
        <span className="wc-older-tag">Older chat</span>
      </header>
      <div className="wc-thread-body">
        {failed && <p className="muted wc-none">This chat couldn’t be loaded. It may have been deleted.</p>}
        {!failed && !messages && <p className="muted wc-none">Loading…</p>}
        {messages?.map((m) => (
          <Bubble key={m.id} m={m} w={w} visitor={olderInitials(c)} />
        ))}
      </div>
      <p className="wc-meta muted">
        Last message {fmtStamp(c.at)}. Read only: a new message from the visitor brings this chat back to the list.
        <button className="wc-delete" onClick={remove}>
          <Trash2 size={12} aria-hidden />
          Delete this chat
        </button>
      </p>
    </>
  );
}

function Chats({ w, asked }: { w: ChatWidget; asked?: string }) {
  const { state, dispatch } = useStore();
  const all = Object.values(state.ws.chats ?? {}).sort((a, b) => (b.messages.at(-1)?.at.getTime() ?? 0) - (a.messages.at(-1)?.at.getTime() ?? 0));
  const [filter, setFilter] = useState<'unread' | 'all' | 'starred'>(() => (all.some((c) => c.unread) ? 'unread' : 'all'));
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(asked ?? null);
  // On a real workspace, a chat older than the ones listed here, opened from the list below them.
  const [past, setPast] = useState<OlderChat | null>(null);
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
  const live = isLive();
  // The newest messages of each chat arrive with the screen; older ones are read from the server when asked for.
  const [older, setOlder] = useState<{ id: string; messages: ChatMsg[] } | null>(null);
  const shown = cur && older?.id === cur.id ? [...older.messages.filter((m) => !cur.messages.some((x) => x.id === m.id)), ...cur.messages] : (cur?.messages ?? []);

  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight });
  }, [openId, cur?.messages.length]);

  /*
   * What a teammate does to a chat. In the demo these are plain edits to the sample data. On a real workspace
   * each one is a named command the server acts on: a reply reaches the visitor through the Action gateway,
   * taking over stops Timmy, and deleting removes the stored conversation.
   */
  const markRead = (c: ChatConvo) => (live ? dispatch({ type: 'chat', op: { op: 'read', id: c.id } }) : set(c.id, { unread: false }));
  const star = (c: ChatConvo) => (live ? dispatch({ type: 'chat', op: { op: 'star', id: c.id, on: !c.starred } }) : set(c.id, { starred: !c.starred }));
  const takeOver = (c: ChatConvo) =>
    live ? dispatch({ type: 'chat', op: { op: 'takeOver', id: c.id, on: !c.live } }) : set(c.id, { live: !c.live, urgent: c.live ? c.urgent : false }, c.live ? 'Timmy is answering this chat again' : 'You’re live. Timmy stops answering in this chat.');
  const remove = (c: ChatConvo) => {
    if (!window.confirm('Delete this chat for good? Its messages are removed from Timmy and can’t be brought back.')) return;
    setOpenId(null);
    dispatch({ type: 'chat', op: { op: 'delete', id: c.id } });
  };
  const loadOlder = async (c: ChatConvo) => {
    try {
      const res = await fetch(`/api/v1/chat/conversations/${encodeURIComponent(c.id)}/messages`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('not loaded');
      setOlder({ id: c.id, messages: fromWire<{ messages: ChatMsg[] }>(await res.text()).messages });
    } catch {
      dispatch({ type: 'toast', text: 'The earlier messages couldn’t be loaded. Try again.', tone: 'warn' });
    }
  };

  const openChat = (c: ChatConvo) => {
    setPast(null);
    setOpenId(c.id);
    if (c.unread) markRead(c);
  };
  // A link to one chat opens it (even when this screen is already showing), and it is then read.
  useEffect(() => {
    const c = asked ? state.ws.chats[asked] : undefined;
    if (!c) return;
    setPast(null);
    setOpenId(c.id);
    if (c.unread) markRead(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);

  const send = () => {
    if (!cur || !text.trim()) return;
    if (live) dispatch({ type: 'chat', op: { op: 'reply', id: cur.id, text: text.trim(), message: uid('m'), by: PEOPLE.me?.name } });
    else set(cur.id, { messages: [...cur.messages, { id: uid('m'), from: 'you', text: text.trim(), at: NOW }], urgent: false });
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
        {live && filter === 'all' && !q.trim() && (
          <OlderChats
            openId={past?.id}
            onOpen={(c) => {
              setOpenId(null);
              setPast(c);
            }}
          />
        )}
      </aside>

      <section className="wc-thread">
        {past ? (
          <OlderThread key={past.id} c={past} w={w} onGone={() => setPast(null)} />
        ) : !cur ? (
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
              <button className={`icon-btn${cur.starred ? ' on' : ''}`} aria-pressed={!!cur.starred} aria-label={cur.starred ? 'Unstar' : 'Star'} onClick={() => star(cur)}>
                <Star size={17} fill={cur.starred ? 'currentColor' : 'none'} />
              </button>
              {cur.email && (
                // The follow-up is an ordinary email: it opens as a draft, and goes out only when you send it.
                <button className="btn btn-sm" onClick={() => dispatch({ type: 'compose', draft: { to: [live ? registerMail(cur.email!) : cur.email!], subject: `Following up on your chat`, body: `Hi ${cur.name?.split(' ')[0] ?? 'there'},\n\nThanks for chatting with us on ${w.domain}.\n\n${me()}` } })}>
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
                  onClick={() => takeOver(cur)}
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
              {live && !!cur.earlier && older?.id !== cur.id && (
                <button className="btn btn-xs btn-ghost wc-earlier" onClick={() => void loadOlder(cur)}>
                  Show {cur.earlier} earlier {cur.earlier === 1 ? 'message' : 'messages'}
                </button>
              )}
              {shown.map((m) => (
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
              {!live && <Paperclip size={15} className="muted" aria-hidden />}
              <input
                placeholder={cur.live ? `Reply to ${cur.name?.split(' ')[0] ?? 'the visitor'}` : 'Timmy is answering. Take over to reply yourself.'}
                value={text}
                maxLength={live ? 2000 : undefined}
                disabled={!cur.live}
                onChange={(e) => setText(e.target.value)}
                aria-label="Your reply"
              />
              <button className="btn btn-primary btn-sm" type="submit" disabled={!cur.live || !text.trim()}>
                Send
              </button>
            </form>
            <p className="wc-meta muted">
              Last message {fmtStamp(cur.messages.at(-1)?.at ?? NOW)}
              {live && (
                // A visitor can ask for their conversation to be removed; this removes it from Timmy for good.
                <button className="wc-delete" onClick={() => remove(cur)}>
                  <Trash2 size={12} aria-hidden />
                  Delete this chat
                </button>
              )}
            </p>
          </>
        )}
      </section>
    </div>
  );
}
