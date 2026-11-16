/*
 * Ask Timmy: a chat workspace opened from the bottom bar (or ⌘I). You ask in
 * plain words; Timmy (an AG-UI agent) shows the work it does, answers, and
 * puts live widgets from the app in the conversation. Nothing is sent or
 * changed until you press a button in a widget.
 */
import type { Message } from '@ag-ui/core';
import { ArrowUp, BadgeDollarSign, CalendarDays, Check, ChevronDown, FilePenLine, History, Hourglass, LoaderCircle, Mail, Plus, Stamp, Sun, Trash2, X, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { portalRoot } from '../lib/portal';
import { contextOf } from '../state/assistant';
import { useStore } from '../state/store';
import { TimmyMark, Kbd } from '../components/common';
import { MicButton } from '../components/Dictation';
import { AGENT_KIND, bridge } from './agent';
import { assistant, useAssistant, type Conversation } from './conversations';
import { parseArgs, WidgetFor } from './widgets';
import '../styles/assistant.css';

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
export const ASK_KEY = `${MOD}I`;

/** The bottom bar's entry point. */
export function AssistantLauncher() {
  return (
    <button className="ai-launch" onClick={assistant.open} aria-haspopup="dialog" title={`Ask Timmy (${ASK_KEY})`}>
      <TimmyMark size={26} />
      <span className="ai-launch-text">Ask Timmy to do anything…</span>
      <Kbd>{ASK_KEY}</Kbd>
      <span className="ai-launch-cta" aria-hidden>
        Ask<span className="ai-launch-name"> Timmy</span>
        <ArrowUp size={14} />
      </span>
    </button>
  );
}

interface Card {
  icon: LucideIcon;
  title: string;
  body: string;
  ask: string;
}

const cardsFor = (view: string | undefined, deals = true): Card[] => {
  if (view === 'thread')
    return [
      { icon: Mail, title: 'Summarize this thread', body: 'What it needs, by when, and the next actions.', ask: 'Summarize this thread' },
      { icon: FilePenLine, title: 'Draft a reply', body: 'A reply from your files and past mail, ready to send.', ask: 'Draft a reply' },
      { icon: Sun, title: 'Plan my day', body: 'Urgent mail, today’s meetings and what needs your OK.', ask: 'Plan my day' },
    ];
  if (view === 'calendar')
    return [
      { icon: CalendarDays, title: 'What’s on today?', body: 'Your meetings and the free time between them.', ask: 'What’s on today?' },
      { icon: Sun, title: 'Plan my day', body: 'Urgent mail, today’s meetings and what needs your OK.', ask: 'Plan my day' },
      { icon: Stamp, title: 'Clear my approvals', body: 'Everything waiting on you, ready to approve.', ask: 'What needs my approval?' },
    ];
  return [
    { icon: Sun, title: 'Plan my day', body: 'Urgent mail, today’s meetings and what needs your OK.', ask: 'Plan my day' },
    { icon: Stamp, title: 'Clear my approvals', body: 'Drafts, decisions, CRM updates and invites, ready to approve.', ask: 'What needs my approval?' },
    deals
      ? { icon: BadgeDollarSign, title: 'Brief me on the pipeline', body: 'Open deals, next steps and what’s late.', ask: 'Brief me on the pipeline' }
      : { icon: Hourglass, title: 'Who owes me?', body: 'What others promised you, and nudges for the late ones.', ask: 'Who owes me?' },
  ];
};

const SOURCES = ['Gmail', 'Calendar', 'Drive', 'CRM'];

/** The overlay, mounted once in the app. */
export function Assistant() {
  const { state, dispatch } = useStore();
  const a = useAssistant();
  const [text, setText] = useState('');
  const [useScreen, setUseScreen] = useState(true);
  const [history, setHistory] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const openedRoute = useRef(state.route);

  // What the local agent sees and does.
  const stateRef = useRef(state);
  stateRef.current = state;
  const routeRef = useRef(state.route);
  routeRef.current = state.route;
  bridge.state = () => stateRef.current;
  bridge.route = () => routeRef.current;
  bridge.dispatch = dispatch;

  const here = contextOf(state, state.route);
  const scopeName = state.scope ? state.ws.projects[state.scope]?.name : undefined;
  // What Timmy is told you have open: the screen, plus the project you narrowed to.
  const screen = here || scopeName ? { label: [here?.label, scopeName && scopeName !== here?.label ? scopeName : null].filter(Boolean).join(' · ') } : null;
  const convo = a.convos.find((c) => c.id === a.active) ?? null;
  const running = a.running && a.running.convo === convo?.id ? a.running : null;

  // ⌘I anywhere opens the chat. While it's open, ⌘I puts you back in the box;
  // pressed from the box itself, it closes the chat.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        const box = input.current;
        if (assistant.isOpen() && box && document.activeElement !== box) {
          box.focus();
          box.setSelectionRange(box.value.length, box.value.length);
        } else assistant.toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // While the chat is open, what you type goes into it. Letters never reach the
  // single-key shortcuts behind it (archive, star, compose…).
  useEffect(() => {
    if (!a.open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || e.key.length !== 1 || e.key === ' ') return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) {
        // Typing in a field inside the chat is fine; anywhere else, stop the page's shortcuts.
        if (!el.closest('.ai-shell')) e.stopImmediatePropagation();
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      const box = input.current;
      if (!box) return;
      const key = e.key;
      setText((v) => v + key);
      box.focus();
      window.setTimeout(() => box.setSelectionRange(box.value.length, box.value.length), 0);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [a.open]);

  // Push-to-talk with no text field focused sends the words to Timmy.
  useEffect(() => {
    document.documentElement.dataset.voiceTarget = 'Ask Timmy';
    const onVoice = (e: Event) => {
      const t = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (!t) return;
      e.preventDefault();
      const s = contextOf(stateRef.current, routeRef.current);
      void assistant.ask(t, s?.label);
    };
    window.addEventListener('timmy:voice', onVoice);
    return () => {
      window.removeEventListener('timmy:voice', onVoice);
      delete document.documentElement.dataset.voiceTarget;
    };
  }, []);

  // Opening: focus the input. Following a link out of the chat closes it.
  useEffect(() => {
    if (a.open) {
      openedRoute.current = state.route;
      setUseScreen(true);
      window.setTimeout(() => input.current?.focus(), 30);
    }
  }, [a.open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (a.open && state.route !== openedRoute.current) assistant.close();
  }, [state.route]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!a.open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        assistant.close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [a.open]);

  // Back to the box after an answer, or when the first question moves it to the bottom.
  useEffect(() => {
    if (!a.open || a.running) return;
    const el = document.activeElement;
    if (!el || el === document.body || !el.isConnected || !el.closest('.ai-shell')) input.current?.focus();
  }, [a.open, !!a.running, convo?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the newest message in view.
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [convo?.messages, running?.steps.length]);

  // Grow the input with its text.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text, a.open, convo?.id]);

  if (!a.open) return null;

  const send = (q = text) => {
    if (!q.trim() || a.running) return;
    void assistant.ask(q, useScreen ? screen?.label : undefined);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const composer = (big: boolean) => (
    <form
      className={`ai-composer${big ? ' big' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        ref={input}
        className="ai-input"
        rows={big ? 2 : 1}
        value={text}
        placeholder={big ? 'Ask Timmy to do something, e.g. “Draft replies to everything urgent”' : 'Ask a follow-up…'}
        aria-label="Ask Timmy"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="ai-tools">
        {screen && useScreen ? (
          <span className="ai-screen" title="Timmy can see what you have open">
            <span className="ai-screen-label">Using: {screen.label}</span>
            <button type="button" className="ai-screen-x" aria-label={`Ask without “${screen.label}”`} onClick={() => setUseScreen(false)}>
              <X size={12} />
            </button>
          </span>
        ) : screen ? (
          <button type="button" className="ai-screen add" onClick={() => setUseScreen(true)}>
            <Plus size={12} /> Use what’s open
          </button>
        ) : null}
        <span className="ai-tools-end">
          <MicButton label="Speak to Timmy" onText={(t) => setText((v) => (v.trim() ? `${v.trimEnd()} ${t}` : t))} />
          <button type="submit" className="ai-send" aria-label="Send" disabled={!text.trim() || !!a.running}>
            {a.running ? <LoaderCircle size={16} className="ai-spin" /> : <ArrowUp size={16} />}
          </button>
        </span>
      </div>
    </form>
  );

  return createPortal(
    <div className="ai-overlay" onMouseDown={(e) => e.target === e.currentTarget && assistant.close()}>
      <div className={`ai-shell${history ? ' show-history' : ''}`} role="dialog" aria-modal="true" aria-label="Ask Timmy">
        <aside className="ai-side" aria-label="Conversations">
          <button className="btn btn-primary ai-new" onClick={() => (assistant.newChat(), setHistory(false), input.current?.focus())}>
            <Plus size={15} />
            New chat
          </button>
          <div className="ai-side-scroll">
            {a.convos.length > 0 && <div className="side-title">Recent</div>}
            {a.convos.map((c) => (
              <div key={c.id} className="ai-convo-row">
                <button className="ai-convo" aria-current={c.id === a.active ? 'page' : undefined} onClick={() => (assistant.select(c.id), setHistory(false))}>
                  <span className="ai-convo-title">{c.title}</span>
                  <span className="ai-convo-when">{when(c.updated)}</span>
                </button>
                <button className="icon-btn sm ai-convo-x" aria-label={`Delete “${c.title}”`} onClick={() => assistant.remove(c.id)}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {a.convos.length === 0 && <p className="ai-side-empty">Your conversations with Timmy are kept here, in this browser.</p>}
          </div>
          <div className="ai-side-foot">
            <span className="side-title">Connected</span>
            {SOURCES.map((s) => (
              <span key={s} className="ai-source">
                <span className="dot" aria-hidden />
                {s}
              </span>
            ))}
            <span className="ai-agent-kind">{AGENT_KIND === 'server' ? 'Timmy agent on the server (AG-UI)' : 'Timmy agent in this browser (AG-UI)'}</span>
          </div>
        </aside>

        <main className="ai-main">
          <header className="ai-head">
            <button className="icon-btn sm ai-history-btn" aria-label="Conversations" aria-expanded={history} onClick={() => setHistory((v) => !v)}>
              <History size={16} />
            </button>
            <span className="ai-head-title">
              <TimmyMark size={22} />
              {convo ? convo.title : 'Ask Timmy'}
            </span>
            <span className="ai-head-end">
              {convo && (
                <button className="btn btn-xs btn-ghost" onClick={() => (assistant.newChat(), input.current?.focus())}>
                  <Plus size={13} />
                  New chat
                </button>
              )}
              <button className="icon-btn sm" aria-label="Close (Esc)" title="Close (Esc)" onClick={assistant.close}>
                <X size={16} />
              </button>
            </span>
          </header>

          {!convo ? (
            <div className="ai-welcome">
              <TimmyMark size={44} />
              <h2 className="ai-welcome-title">What should Timmy do?</h2>
              <p className="ai-welcome-sub">Ask in plain words. Timmy works through your mail, calendar, files and deals and shows you what it found. Nothing is sent or changed until you say so.</p>
              {composer(true)}
              <p className="ai-sources">
                Working from {SOURCES.join(', ').replace(/, ([^,]*)$/, ' and $1')}
              </p>
              <div className="ai-cards">
                {cardsFor(state.route.view, state.showDeals).map((c) => (
                  <button key={c.title} className="ai-card" onClick={() => send(c.ask)}>
                    <c.icon size={18} aria-hidden />
                    <strong>{c.title}</strong>
                    <span>{c.body}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              <div className="ai-thread" ref={list} aria-live="polite">
                <div className="ai-thread-inner">
                  <Messages convo={convo} running={running} />
                  {a.error && <p className="ai-error">Timmy couldn’t finish that: {a.error}</p>}
                </div>
              </div>
              <div className="ai-dock">{composer(false)}</div>
            </>
          )}
          <p className="ai-foot">
            Timmy prepares the work; you approve anything that’s sent or changed.<span className="ai-foot-keys"> {ASK_KEY} opens this anywhere.</span>
          </p>
        </main>
      </div>
    </div>,
    portalRoot(),
  );
}

function Messages({ convo, running }: { convo: Conversation; running: { steps: { name: string; done: boolean }[] } | null }) {
  const msgs = convo.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
  const pending = running && !msgs.slice(lastUser + 1).some((m) => m.role === 'assistant');
  return (
    <>
      {msgs.map((m, i) =>
        m.role === 'user' ? (
          <div key={m.id} className="ai-msg me">
            <div className="ai-bubble">{typeof m.content === 'string' ? m.content : ''}</div>
            {convo.asked[m.id] && <span className="ai-asked">From {convo.asked[m.id]}</span>}
          </div>
        ) : (
          <Answer key={m.id} m={m} convo={convo} liveSteps={running && i === msgs.length - 1 ? running.steps : null} />
        ),
      )}
      {pending && (
        <div className="ai-msg timmy">
          <TimmyMark size={26} />
          <div className="ai-answer">
            <Steps steps={running!.steps} live />
          </div>
        </div>
      )}
    </>
  );
}

function Answer({ m, convo, liveSteps }: { m: Message; convo: Conversation; liveSteps: { name: string; done: boolean }[] | null }) {
  const steps = liveSteps ?? (convo.steps[m.id] ?? []).map((name) => ({ name, done: true }));
  const calls = m.role === 'assistant' ? (m.toolCalls ?? []) : [];
  return (
    <div className="ai-msg timmy">
      <TimmyMark size={26} />
      <div className="ai-answer">
        {steps.length > 0 && <Steps steps={steps} live={!!liveSteps} />}
        {typeof m.content === 'string' && m.content && <p className="ai-text">{m.content}</p>}
        {calls.map((c) => (
          <WidgetFor key={c.id} name={c.function.name} args={parseArgs(c.function.arguments)} convo={convo.id} callId={c.id} chosen={convo.chosen[c.id]} />
        ))}
      </div>
    </div>
  );
}

/** The work Timmy did: live while it runs, then folded into one line. */
function Steps({ steps, live }: { steps: { name: string; done: boolean }[]; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const allDone = steps.length > 0 && steps.every((s) => s.done);
  if (!live && allDone) {
    return (
      <div className="ai-steps folded">
        <button className="ai-steps-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <Check size={13} />
          Worked through {steps.length} {steps.length === 1 ? 'step' : 'steps'}
          <ChevronDown size={13} className={open ? 'up' : ''} />
        </button>
        {open && (
          <ol className="ai-steps-list">
            {steps.map((s, i) => (
              <li key={i}>
                <Check size={12} /> {s.name}
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  }
  return (
    <ol className="ai-steps-list live" aria-label="Timmy is working">
      {steps.map((s, i) => (
        <li key={i} className={s.done ? 'done' : 'doing'}>
          {s.done ? <Check size={12} /> : <LoaderCircle size={12} className="ai-spin" />} {s.name}
        </li>
      ))}
      {steps.length === 0 && (
        <li className="doing">
          <LoaderCircle size={12} className="ai-spin" /> Thinking…
        </li>
      )}
    </ol>
  );
}

const when = (ms: number) => {
  const d = new Date(ms);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
