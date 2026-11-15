/*
 * Ask Timmy: a chat docked at the bottom of the right panel, on every screen.
 * The context above stays in view; questions and proposed changes happen here.
 * Proposed changes run only when you press their button.
 */
import { MicButton } from './Dictation';
import { ArrowRight, ArrowUp, Check, ChevronDown, ChevronUp, Maximize2, Minimize2, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { chatStore, contextOf, promptsFor, reply, routeForHref, useChat, type ChatChoice, type ChatLink, type ChatMessage } from '../state/assistant';
import { useStore } from '../state/store';
import { routeFromHref } from '../state/ws';
import { TimmyMark } from './common';
import '../styles/chat.css';

export function ChatPanel() {
  const { state, dispatch } = useStore();
  const chat = useChat();
  const [text, setText] = useState('');
  const ctx = contextOf(state, state.route);
  const [withCtx, setWithCtx] = useState(true);
  const stateRef = useRef(state);
  stateRef.current = state;
  const list = useRef<HTMLOListElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // A new screen brings its context back.
  useEffect(() => setWithCtx(true), [ctx?.label]);

  const go = (href: string) => {
    const special = routeForHref(href);
    if (special) dispatch({ type: 'navigate', route: special });
    else if (href.startsWith('thread:')) dispatch({ type: 'openThread', id: href.slice(7) });
    else dispatch({ type: 'navigate', route: routeFromHref(href) });
  };

  const send = (raw: string) => {
    const q = raw.trim();
    if (!q || chatStore.get().thinking) return;
    const c = withCtx ? ctx : null;
    if (chatStore.get().size === 'min') chatStore.size('normal');
    chatStore.ask(q, c?.label, () => reply(stateRef.current, q, c));
    setText('');
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  // Push-to-talk with no text field focused sends the words to Timmy.
  useEffect(() => {
    document.documentElement.dataset.voiceTarget = 'Ask Timmy';
    const onVoice = (e: Event) => {
      const t = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (!t) return;
      e.preventDefault();
      sendRef.current(t);
    };
    window.addEventListener('timmy:voice', onVoice);
    return () => {
      window.removeEventListener('timmy:voice', onVoice);
      delete document.documentElement.dataset.voiceTarget;
    };
  }, []);

  // Keep the newest message in view.
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.messages.length, chat.thinking, chat.size]);

  // Grow the input with its text, up to a few lines.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  const choose = (m: ChatMessage, c: ChatChoice) => {
    for (const a of c.actions) dispatch(a);
    chatStore.choose(m.id, c.id);
    if (c.open) go(c.open);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(text);
    }
  };

  const min = chat.size === 'min';
  const empty = chat.messages.length === 0 && !chat.thinking;
  const prompts = promptsFor(ctx?.route ?? null);

  return (
    <section className={`chat chat-${chat.size}`} aria-labelledby="chat-title">
      <header className="chat-head">
        <button className="chat-head-main" onClick={() => chatStore.size(min ? 'normal' : 'min')} aria-expanded={!min} aria-controls="chat-body">
          <TimmyMark size={22} />
          <h2 className="chat-title" id="chat-title">
            Ask Timmy
          </h2>
          {min && chat.messages.length > 0 && <span className="chat-count">{chat.messages.length}</span>}
        </button>
        <div className="chat-head-actions">
          {!min && chat.messages.length > 0 && (
            <button className="icon-btn sm" aria-label="Clear the conversation" title="Clear the conversation" onClick={() => chatStore.clear()}>
              <RotateCcw size={15} />
            </button>
          )}
          {!min && (
            <button
              className="icon-btn sm"
              aria-label={chat.size === 'max' ? 'Make the chat smaller' : 'Make the chat taller'}
              title={chat.size === 'max' ? 'Smaller' : 'Taller'}
              onClick={() => chatStore.size(chat.size === 'max' ? 'normal' : 'max')}
            >
              {chat.size === 'max' ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
          )}
          <button className="icon-btn sm" aria-label={min ? 'Open the chat' : 'Fold the chat away'} onClick={() => chatStore.size(min ? 'normal' : 'min')}>
            {min ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>
      </header>

      {!min && (
        <div className="chat-body" id="chat-body">
          {empty ? (
            <div className="chat-empty">
              <TimmyMark size={34} />
              <p className="chat-hello">
                <span>Hi Taylor,</span>
                <strong>How can I help?</strong>
              </p>
              <p className="chat-hint">Ask about your mail, calendar, files and deals. I only change things when you confirm.</p>
              <div className="chat-prompts">
                {prompts.map((p) => (
                  <button key={p} className="chat-prompt" onClick={() => send(p)}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <ol className="chat-list" ref={list} aria-live="polite" aria-label="Conversation">
              {chat.messages.map((m) => (m.role === 'user' ? <UserMessage key={m.id} m={m} /> : <TimmyMessage key={m.id} m={m} onLink={go} onChoose={(c) => choose(m, c)} />))}
              {chat.thinking && (
                <li className="chat-msg timmy">
                  <TimmyMark size={22} muted />
                  <p className="chat-thinking">
                    Timmy is thinking
                    <span className="chat-dots" aria-hidden>
                      <i />
                      <i />
                      <i />
                    </span>
                  </p>
                </li>
              )}
            </ol>
          )}

          {!empty && (
            <div className="chat-quick" aria-label="Suggestions">
              {prompts.slice(0, 3).map((p) => (
                <button key={p} className="chat-prompt sm" onClick={() => send(p)} disabled={chat.thinking}>
                  {p}
                </button>
              ))}
            </div>
          )}

          <form
            className="chat-form"
            onSubmit={(e) => {
              e.preventDefault();
              send(text);
            }}
          >
            {ctx && withCtx && (
              <span className="chat-ctx" title={`Timmy reads “${ctx.label}” with your question`}>
                <span className="chat-ctx-label">{ctx.label}</span>
                <button type="button" className="chat-ctx-x" aria-label={`Ask without “${ctx.label}”`} onClick={() => setWithCtx(false)}>
                  <X size={12} />
                </button>
              </span>
            )}
            <div className="chat-row">
              <textarea
                ref={input}
                className="chat-input"
                rows={1}
                value={text}
                placeholder="Ask Timmy anything…"
                aria-label="Ask Timmy"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKey}
              />
              <span className="chat-mic-slot">
                <MicButton label="Speak to Timmy" onText={(t) => setText((v) => (v.trim() ? `${v.trimEnd()} ${t}` : t))} />
              </span>
              <button type="submit" className="chat-send" aria-label="Send" disabled={!text.trim() || chat.thinking}>
                <ArrowUp size={16} />
              </button>
            </div>
          </form>
          <p className="chat-foot">
            <span>Enter to send</span>
            <span>Changes need your OK</span>
          </p>
        </div>
      )}
    </section>
  );
}

function UserMessage({ m }: { m: ChatMessage }) {
  return (
    <li className="chat-msg me">
      <div className="chat-bubble">{m.text}</div>
      {m.context && <span className="chat-about">About {m.context}</span>}
    </li>
  );
}

function TimmyMessage({ m, onLink, onChoose }: { m: ChatMessage; onLink: (href: string) => void; onChoose: (c: ChatChoice) => void }) {
  const chosen = m.choices?.find((c) => c.id === m.chosen);
  return (
    <li className="chat-msg timmy">
      <TimmyMark size={22} muted />
      <div className="chat-answer">
        {m.text.split('\n').map((p, i) => (
          <p key={i}>{p}</p>
        ))}
        {m.bullets && (
          <ul className="chat-bullets">
            {m.bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        )}
        {m.links && m.links.length > 0 && (
          <ul className="chat-links">
            {m.links.map((l: ChatLink, i) => (
              <li key={`${l.href}-${i}`}>
                <button className="chat-link" onClick={() => onLink(l.href)}>
                  <span className="chat-link-text">
                    <span className="chat-link-label">{l.label}</span>
                    {l.sub && <span className="chat-link-sub">{l.sub}</span>}
                  </span>
                  <ArrowRight size={14} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        {m.choices && !chosen && (
          <div className="chat-choices">
            {m.choices.map((c) => (
              <button key={c.id} className={`btn btn-sm${c.primary ? ' btn-primary' : ''}`} onClick={() => onChoose(c)}>
                {c.cancel ? <X size={14} /> : c.primary ? <Check size={14} /> : null}
                {c.label}
              </button>
            ))}
          </div>
        )}
        {chosen && (
          <p className={`chat-done${chosen.cancel ? ' off' : ''}`}>
            {chosen.cancel ? <X size={13} aria-hidden /> : <Check size={13} aria-hidden />}
            {chosen.after}
          </p>
        )}
      </div>
    </li>
  );
}
