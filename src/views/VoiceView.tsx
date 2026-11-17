/* Settings › Voice: how dictation works, push-to-talk, the dictionary and where audio goes. */
import { AudioLines, Check, Plus, ShieldCheck, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Frame } from '../components/Frame';
import { MicButton } from '../components/Dictation';
import { Segmented } from '../components/kit';
import { isLive } from '../live/clock';
import {
  LANGUAGES,
  MODELS,
  SHORTCUTS,
  isModelCached,
  joinAt,
  preloadWhisper,
  resolveEngine,
  useModelStatus,
  useVoiceSettings,
  voiceSupport,
  whisperModelId,
  workspaceWords,
  type EngineId,
  type ModelSize,
  type ShortcutId,
} from '../lib/dictation';

export function VoiceView() {
  const [s, set] = useVoiceSettings();
  const support = voiceSupport();
  const using = resolveEngine(s.engine);

  return (
    <Frame tabs={[{ id: 'voice', label: 'Voice' }]} active="voice" onTab={() => {}}>
      <h1 className="page-title">Voice</h1>
      <p className="page-sub">
        Dictate anywhere you can type. Use the mic button in replies and new emails, or hold {SHORTCUTS[s.shortcut].label} in any field. Timmy fixes the names in your
        dictionary as it goes.
      </p>

      <section className="section" aria-labelledby="voice-engine">
        <div className="section-head">
          <h2 className="section-title" id="voice-engine">
            How Timmy listens
          </h2>
          {using && using !== s.engine && <span className="section-sub">Not available in this browser, so Timmy uses the other one</span>}
        </div>
        <div className="voice-engines" role="radiogroup" aria-labelledby="voice-engine">
          <EngineCard
            id="whisper"
            title="Private: Whisper in your browser"
            text="Audio never leaves this device. The model downloads once and your browser keeps it."
            available={support.whisper}
            checked={s.engine === 'whisper'}
            onPick={() => set({ engine: 'whisper' })}
            status={<WhisperStatus />}
          />
          <EngineCard
            id="browser"
            title="Fast: your browser’s speech recognition"
            text="Starts instantly with live words as you speak. Your browser sends the audio to its own speech service."
            available={support.browser}
            checked={s.engine === 'browser'}
            onPick={() => set({ engine: 'browser' })}
            status={support.browser ? <span className="voice-engine-status ok">Available in this browser</span> : <span className="voice-engine-status">Not available in this browser</span>}
          />
        </div>

        {s.engine === 'whisper' && support.whisper && <ModelPicker />}

        <div className="voice-row">
          <label className="voice-label" htmlFor="voice-lang">
            Language
          </label>
          <select id="voice-lang" className="input voice-select" value={s.language} onChange={(e) => set({ language: e.target.value })}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        {!support.secure && <p className="voice-note">The microphone only works on a secure (https) page.</p>}
      </section>

      <section className="section" aria-labelledby="voice-ptt">
        <div className="section-head">
          <h2 className="section-title" id="voice-ptt">
            Push-to-talk
          </h2>
        </div>
        <div className="voice-row" style={{ marginTop: 0 }}>
          <button
            className="switch"
            role="switch"
            aria-checked={s.pushToTalk}
            aria-label="Push-to-talk anywhere in Timmy"
            onClick={() => set({ pushToTalk: !s.pushToTalk })}
          />
          <span className="voice-label">Anywhere in Timmy</span>
          <select className="input voice-select" value={s.shortcut} onChange={(e) => set({ shortcut: e.target.value as ShortcutId })} aria-label="Push-to-talk shortcut" disabled={!s.pushToTalk}>
            {(Object.keys(SHORTCUTS) as ShortcutId[]).map((k) => (
              <option key={k} value={k}>
                {SHORTCUTS[k].label}
              </option>
            ))}
          </select>
        </div>
        <p className="voice-note">
          Hold the shortcut and talk; let go to insert at your cursor. Tap it once to keep listening hands-free, and tap again to insert. Esc cancels. With no text field
          focused, what you say goes to Ask Timmy, or to your clipboard.
        </p>
      </section>

      <section className="section" aria-labelledby="voice-try">
        <div className="section-head">
          <h2 className="section-title" id="voice-try">
            Try it
          </h2>
          <span className="section-sub">Nothing here is saved</span>
        </div>
        <TryIt />
      </section>

      <Dictionary />

      <section className="section" aria-labelledby="voice-privacy">
        <div className="section-head">
          <h2 className="section-title" id="voice-privacy">
            Where your audio goes
          </h2>
        </div>
        <dl className="voice-privacy">
          <dt>Whisper in your browser</dt>
          <dd>Stays on this device. Timmy never receives it. Only the model itself is downloaded, once, from Hugging Face’s servers.</dd>
          <dt>Your browser’s speech recognition</dt>
          <dd>Sent by your browser to its speech service (Google for Chrome, Microsoft for Edge, Apple for Safari) and handled under that company’s terms.</dd>
          <dt>The text</dt>
          <dd>Only the words you insert are kept, exactly as if you had typed them. Recordings are never stored.</dd>
        </dl>
      </section>
    </Frame>
  );
}

function EngineCard({
  id,
  title,
  text,
  available,
  checked,
  onPick,
  status,
}: {
  id: EngineId;
  title: string;
  text: string;
  available: boolean;
  checked: boolean;
  onPick: () => void;
  status: React.ReactNode;
}) {
  return (
    <button type="button" role="radio" aria-checked={checked} className="voice-engine" disabled={!available} onClick={onPick} data-engine={id}>
      <span className="voice-engine-name">
        {id === 'whisper' ? <ShieldCheck size={16} aria-hidden /> : <AudioLines size={16} aria-hidden />}
        {title}
        {checked && <Check size={15} aria-hidden style={{ marginLeft: 'auto' }} />}
      </span>
      <span className="voice-engine-text">{text}</span>
      {status}
    </button>
  );
}

function useCached() {
  const [s] = useVoiceSettings();
  const m = useModelStatus();
  const [cached, setCached] = useState<boolean | null>(null);
  useEffect(() => {
    let on = true;
    void isModelCached(s).then((c) => on && setCached(c));
    return () => {
      on = false;
    };
  }, [s.model, s.language, m.state]); // eslint-disable-line react-hooks/exhaustive-deps
  return cached;
}

function WhisperStatus() {
  const [s] = useVoiceSettings();
  const support = voiceSupport();
  const m = useModelStatus();
  const cached = useCached();
  if (!support.whisper) return <span className="voice-engine-status">Not available in this browser</span>;
  const current = m.model === whisperModelId(s);
  if (current && m.state === 'ready') return <span className="voice-engine-status ok">Ready · running on {m.device === 'webgpu' ? 'your graphics card (WebGPU)' : 'your processor (WebAssembly)'}</span>;
  if (current && m.state === 'loading') return <span className="voice-engine-status">Downloading the model…</span>;
  if (current && m.state === 'error') return <span className="voice-engine-status">The model couldn’t be downloaded</span>;
  if (cached) return <span className="voice-engine-status ok">Downloaded · loads when you first dictate</span>;
  return <span className="voice-engine-status">Model not downloaded yet ({MODELS[s.model].size})</span>;
}

function ModelPicker() {
  const [s, set] = useVoiceSettings();
  const m = useModelStatus();
  const cached = useCached();
  const current = m.model === whisperModelId(s);
  const pct = current && m.state === 'loading' && m.total ? Math.round(((m.loaded ?? 0) / m.total) * 100) : 0;
  return (
    <>
      <div className="voice-row">
        <span className="voice-label" id="voice-model">
          Model
        </span>
        <Segmented<ModelSize>
          label="Whisper model"
          value={s.model}
          onChange={(model) => set({ model })}
          options={(Object.keys(MODELS) as ModelSize[]).map((k) => ({ id: k, label: `${MODELS[k].name} · ${MODELS[k].size.replace('about ', '')}` }))}
        />
        {!(current && (m.state === 'ready' || m.state === 'loading')) && !cached && (
          <button type="button" className="btn btn-sm" onClick={() => void preloadWhisper(s).catch(() => undefined)}>
            Download now
          </button>
        )}
      </div>
      <p className="voice-note">{MODELS[s.model].hint} English uses the faster English-only model.</p>
      {current && m.state === 'loading' && (
        <div className="voice-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Model download">
          <span className="voice-bar">
            <i style={{ width: `${pct}%` }} />
          </span>
          <span>
            {pct}% of {m.total ? `${Math.round(m.total / 1e6)} MB` : MODELS[s.model].size}
          </span>
        </div>
      )}
      {current && m.state === 'error' && (
        <p className="voice-note" role="alert">
          The model couldn’t be downloaded ({m.error?.slice(0, 120)}). Check your connection, or pick your browser’s speech recognition above.
        </p>
      )}
    </>
  );
}

function TryIt() {
  const [text, setText] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<[number, number] | null>(null);
  const insert = (said: string) => {
    const [start, end] = caret.current ?? [text.length, text.length];
    const next = joinAt(text, start, end, said);
    setText(next.value);
    caret.current = [next.caret, next.caret];
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  return (
    <div className="voice-try">
      <div className="voice-try-box">
        <textarea
          ref={area}
          className="input textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onSelect={(e) => (caret.current = [e.currentTarget.selectionStart, e.currentTarget.selectionEnd])}
          placeholder="Press the mic and say “Tell Dana Whitfield at Acme the quote is ready”."
          aria-label="Dictation test"
        />
        <MicButton onText={insert} label="Test dictation" />
      </div>
    </div>
  );
}

function Dictionary() {
  const [s, set] = useVoiceSettings();
  const [word, setWord] = useState('');
  const add = (w: string) => {
    const v = w.replace(/\s+/g, ' ').trim();
    if (!v || s.dictionary.some((x) => x.toLowerCase() === v.toLowerCase())) return;
    set({ dictionary: [...s.dictionary, v] });
  };
  const missing = workspaceWords().filter((w) => !s.dictionary.some((x) => x.toLowerCase() === w.toLowerCase()));
  return (
    <section className="section" aria-labelledby="voice-dict">
      <div className="section-head">
        <h2 className="section-title" id="voice-dict">
          Dictionary
        </h2>
        <span className="section-sub">{s.dictionary.length} words</span>
      </div>
      <p className="voice-note" style={{ marginTop: 0 }}>
        {isLive()
          ? 'Names and terms to spell your way, so a name you say is written the way you write it. It starts with your contacts and their companies.'
          : 'Names and terms to spell your way. “Dana Whitefield at north peak” becomes “Dana Whitfield at Northpeak”. It starts with your contacts and their companies.'}
      </p>
      <ul className="voice-words" aria-label="Dictionary words">
        {s.dictionary.map((w) => (
          <li key={w} className="voice-word">
            {w}
            <button type="button" className="icon-btn sm" aria-label={`Remove ${w}`} onClick={() => set({ dictionary: s.dictionary.filter((x) => x !== w) })}>
              <X size={12} />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="voice-add"
        onSubmit={(e) => {
          e.preventDefault();
          add(word);
          setWord('');
        }}
      >
        <input className="input" value={word} onChange={(e) => setWord(e.target.value)} placeholder="Add a name or term, e.g. Okafor" aria-label="Add to dictionary" />
        <button type="submit" className="btn btn-sm" disabled={!word.trim()}>
          <Plus size={14} />
          Add
        </button>
        {missing.length > 0 && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => set({ dictionary: [...s.dictionary, ...missing] })}>
            Add {missing.length} from your contacts
          </button>
        )}
      </form>
    </section>
  );
}
