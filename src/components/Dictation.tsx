/*
 * Voice input: a mic button for any text field, and push-to-talk anywhere in
 * the app (hold the shortcut to talk, release to insert; tap it to keep
 * listening, tap again to stop; Esc cancels). With no text field focused, the
 * transcript goes out as a `timmy:voice` window event ({ detail: { text } },
 * cancelable): a listener that uses it calls preventDefault(); if none does, the
 * text is copied to the clipboard instead. A listener can name itself for the
 * indicator with document.documentElement.dataset.voiceTarget = 'Ask Timmy'.
 */
import { LoaderCircle, Mic, Square, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SHORTCUTS,
  VOICE_ERRORS,
  VoiceError,
  editableTarget,
  getVoiceSettings,
  startDictation,
  typeInto,
  useModelStatus,
  useVoiceSettings,
  voiceSupport,
  type DictationSession,
  type Editable,
  type Phase,
} from '../lib/dictation';
import { useStore } from '../state/store';
import '../styles/dictation.css';

type Live = { phase: Phase; level: number; started: number; interim: string };
type DictationState = { phase: 'idle' } | Live | { phase: 'error'; error: VoiceError };

const isLive = (s: DictationState): s is Live => s.phase === 'starting' || s.phase === 'listening' || s.phase === 'transcribing';

/** One dictation at a time: start, stop (transcribe and deliver), cancel. */
export function useDictation(onText: (text: string) => void) {
  const [st, setSt] = useState<DictationState>({ phase: 'idle' });
  const session = useRef<DictationSession | null>(null);
  const deliver = useRef(onText);
  deliver.current = onText;

  const start = useCallback(() => {
    if (session.current) return;
    setSt({ phase: 'starting', level: 0, started: Date.now(), interim: '' });
    session.current = startDictation(getVoiceSettings(), {
      onPhase: (phase) =>
        setSt((s) => ({ phase, level: 0, started: phase === 'listening' || !isLive(s) ? Date.now() : s.started, interim: isLive(s) ? s.interim : '' })),
      onLevel: (level) => setSt((s) => (s.phase === 'listening' ? { ...s, level } : s)),
      onInterim: (interim) => setSt((s) => (isLive(s) ? { ...s, interim } : s)),
      onResult: (text) => {
        session.current = null;
        setSt({ phase: 'idle' });
        deliver.current(text);
      },
      onError: (error) => {
        session.current = null;
        setSt({ phase: 'error', error });
      },
    });
  }, []);

  const stop = useCallback(() => session.current?.stop(), []);
  const cancel = useCallback(() => {
    session.current?.cancel();
    session.current = null;
    setSt({ phase: 'idle' });
  }, []);
  const dismiss = useCallback(() => setSt((s) => (s.phase === 'error' ? { phase: 'idle' } : s)), []);

  useEffect(() => () => session.current?.cancel(), []);

  // Errors clear themselves after a while.
  useEffect(() => {
    if (st.phase !== 'error') return;
    const t = window.setTimeout(dismiss, 9000);
    return () => window.clearTimeout(t);
  }, [st, dismiss]);

  // Re-render the elapsed time while listening.
  const [, tick] = useState(0);
  useEffect(() => {
    if (st.phase !== 'listening') return;
    const t = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [st.phase]);

  return { st, live: isLive(st), start, stop, cancel, dismiss };
}

const elapsed = (from: number) => {
  const s = Math.max(0, Math.floor((Date.now() - from) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Five bars that follow the mic level. */
export function LevelMeter({ level }: { level: number }) {
  return (
    <span className="mic-level" aria-hidden>
      {[0.45, 0.75, 1, 0.75, 0.45].map((f, i) => (
        <i key={i} style={{ transform: `scaleY(${Math.max(0.18, Math.min(1, level * f * 1.6))})` }} />
      ))}
    </span>
  );
}

function ModelProgress() {
  const m = useModelStatus();
  if (m.state !== 'loading') return <>Transcribing…</>;
  const pct = m.total ? Math.round(((m.loaded ?? 0) / m.total) * 100) : 0;
  return <>Downloading the voice model{pct ? ` ${pct}%` : '…'} (one time)</>;
}

/** What to do about an error: switch engine or open the settings. */
function ErrorFix({ error, onDone }: { error: VoiceError; onDone: () => void }) {
  const { dispatch } = useStore();
  const [, set] = useVoiceSettings();
  const support = voiceSupport();
  return (
    <span className="mic-fix">
      {error.code === 'model' && support.browser && (
        <button type="button" className="link-btn" onClick={() => (set({ engine: 'browser' }), onDone())}>
          Use browser speech instead
        </button>
      )}
      {error.code === 'network' && support.whisper && (
        <button type="button" className="link-btn" onClick={() => (set({ engine: 'whisper' }), onDone())}>
          Use Whisper in your browser
        </button>
      )}
      <button type="button" className="link-btn" onClick={() => (dispatch({ type: 'navigate', route: { view: 'voice' } }), onDone())}>
        Voice settings
      </button>
    </span>
  );
}

/** Esc cancels a live dictation before anything else on the page sees the key. */
function useEscToCancel(live: boolean, cancel: () => void) {
  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [live, cancel]);
}

/**
 * A mic button for a text field. Click to start, click again to insert, Esc to
 * cancel. `onText` receives the corrected transcript.
 */
export function MicButton({ onText, label = 'Dictate', className }: { onText: (text: string) => void; label?: string; className?: string }) {
  const d = useDictation(onText);
  const [settings] = useVoiceSettings();
  useEscToCancel(d.live, d.cancel);
  const st = d.st;

  if (isLive(st)) {
    return (
      <span className={`mic mic-live ${className ?? ''}`} role="group" aria-label="Dictation">
        <button type="button" className="mic-btn on" onClick={d.stop} disabled={st.phase !== 'listening'} aria-label="Stop and insert" title="Stop and insert">
          {st.phase === 'listening' ? <Square size={10} fill="currentColor" aria-hidden /> : <LoaderCircle size={15} className="mic-spin" aria-hidden />}
        </button>
        <span className="mic-status" aria-live="polite">
          {st.phase === 'starting' && 'Starting the mic…'}
          {st.phase === 'listening' && (
            <>
              <LevelMeter level={st.level} />
              <span className="mic-time">{elapsed(st.started)}</span>
            </>
          )}
          {st.phase === 'transcribing' && <ModelProgress />}
        </span>
        <button type="button" className="icon-btn sm" onClick={d.cancel} aria-label="Cancel dictation (Esc)" title="Cancel (Esc)">
          <X size={14} />
        </button>
      </span>
    );
  }

  return (
    <span className={`mic ${className ?? ''}`}>
      <button
        type="button"
        className="mic-btn"
        onClick={d.start}
        aria-label={label}
        title={settings.pushToTalk ? `${label} · or hold ${SHORTCUTS[settings.shortcut].label} anywhere` : label}
      >
        <Mic size={15} aria-hidden />
      </button>
      {st.phase === 'error' && (
        <span className="mic-error" role="alert">
          <span>{VOICE_ERRORS[st.error.code]}</span>
          <ErrorFix error={st.error} onDone={d.dismiss} />
          <button type="button" className="icon-btn sm mic-error-x" aria-label="Dismiss" onClick={d.dismiss}>
            <X size={13} />
          </button>
        </span>
      )}
    </span>
  );
}

/** A readable name for where the text will land. */
const fieldName = (el: Editable) =>
  el.getAttribute('aria-label') || (el as HTMLInputElement).placeholder?.slice(0, 40) || el.getAttribute('name') || 'the focused field';

/** Push-to-talk across the app, with a floating indicator. Mount once. */
export function PushToTalk() {
  const { dispatch } = useStore();
  const [s] = useVoiceSettings();
  const target = useRef<{ el: Editable; start?: number; end?: number; name: string } | null>(null);
  const mode = useRef<'idle' | 'hold' | 'toggle'>('idle');
  const pressedAt = useRef(0);
  const [hint, setHint] = useState<'hold' | 'toggle'>('hold');
  const [dest, setDest] = useState<string | null>(null);

  const d = useDictation((text) => {
    const t = target.current;
    target.current = null;
    mode.current = 'idle';
    if (t && t.el.isConnected) {
      typeInto(t.el, text, t.start !== undefined && t.end !== undefined ? { start: t.start, end: t.end } : undefined);
      return;
    }
    const unhandled = window.dispatchEvent(new CustomEvent('timmy:voice', { detail: { text }, cancelable: true }));
    if (!unhandled) return;
    const short = text.length > 60 ? `${text.slice(0, 57)}…` : text;
    void navigator.clipboard?.writeText(text).then(
      () => dispatch({ type: 'toast', text: `No text field was focused, so it’s on your clipboard: “${short}”` }),
      () => dispatch({ type: 'toast', text: `Heard: “${short}”. Click into a field first to type it there.` }),
    );
  });

  const live = useRef(false);
  live.current = d.live;
  const api = useRef(d);
  api.current = d;

  useEffect(() => {
    if (!s.pushToTalk) return;
    const sc = SHORTCUTS[s.shortcut];
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && live.current) {
        e.preventDefault();
        e.stopPropagation();
        mode.current = 'idle';
        target.current = null;
        api.current.cancel();
        return;
      }
      if (!sc.match(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (mode.current === 'toggle') {
        mode.current = 'idle';
        api.current.stop();
        return;
      }
      if (mode.current !== 'idle' || live.current) return;
      const el = editableTarget(document.activeElement);
      const sel = el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) ? { start: el.selectionStart ?? undefined, end: el.selectionEnd ?? undefined } : {};
      target.current = el ? { el, ...sel, name: fieldName(el) } : null;
      setDest(el ? fieldName(el) : null);
      pressedAt.current = Date.now();
      mode.current = 'hold';
      setHint('hold');
      api.current.dismiss();
      api.current.start();
    };
    const up = (e: KeyboardEvent) => {
      if (mode.current !== 'hold') return;
      const released = sc.key === 'Space' ? e.code === 'Space' || ['Control', 'Shift', 'Alt'].includes(e.key) : e.code === sc.key;
      if (!released) return;
      e.preventDefault();
      if (Date.now() - pressedAt.current < 350) {
        // A tap: keep listening until the next tap.
        mode.current = 'toggle';
        setHint('toggle');
        return;
      }
      mode.current = 'idle';
      api.current.stop();
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, [s.pushToTalk, s.shortcut]);

  const st = d.st;
  if (st.phase === 'idle') return null;
  const key = SHORTCUTS[s.shortcut].label;

  return (
    <div className={`ptt${st.phase === 'error' ? ' error' : ''}`} role="status" aria-live="polite">
      {st.phase === 'error' ? (
        <>
          <span>{VOICE_ERRORS[st.error.code]}</span>
          <ErrorFix error={st.error} onDone={d.dismiss} />
          <button type="button" className="icon-btn sm" aria-label="Dismiss" onClick={d.dismiss}>
            <X size={14} />
          </button>
        </>
      ) : (
        <>
          <span className="ptt-icon" aria-hidden>
            {st.phase === 'transcribing' || st.phase === 'starting' ? <LoaderCircle size={15} className="mic-spin" /> : <Mic size={15} />}
          </span>
          {st.phase === 'starting' && <span>Starting the mic…</span>}
          {st.phase === 'listening' && (
            <>
              <LevelMeter level={st.level} />
              <span className="mic-time">{elapsed(st.started)}</span>
              <span className="ptt-text">
                {st.interim ? (
                  <span className="ptt-interim">{st.interim}</span>
                ) : (
                  <>
                    {hint === 'hold' ? 'Release to insert' : `Press ${key} to insert`} · Esc cancels
                  </>
                )}
              </span>
            </>
          )}
          {st.phase === 'transcribing' && (
            <span>
              <ModelProgress />
            </span>
          )}
          <span className="ptt-dest">{dest ? `Into: ${dest}` : document.documentElement.dataset.voiceTarget ? `To: ${document.documentElement.dataset.voiceTarget}` : 'No field focused: copies the text'}</span>
        </>
      )}
    </div>
  );
}
