/*
 * Voice dictation for the browser, after OpenWhispr's desktop model (MIT):
 * push-to-talk into whatever field is focused, a private on-device Whisper
 * engine or a fast cloud one, and a custom dictionary for names Whisper gets
 * wrong. Two engines sit behind one interface:
 *
 *   whisper  Whisper running in this browser (transformers.js in a Web Worker,
 *            WebGPU or WASM). Audio never leaves the device; the model downloads
 *            once (about 40 MB for Tiny) and the browser caches it.
 *   browser  The browser's own speech recognition (Web Speech API). Starts
 *            instantly; Chrome and Edge send the audio to their speech service.
 *
 *   const session = startDictation(getVoiceSettings(), { onPhase, onLevel, onResult, onError });
 *   session.stop();   // transcribe and deliver
 *   session.cancel(); // discard
 */
import { useSyncExternalStore } from 'react';
import { PEOPLE } from '../data/mock';
import { isLive } from '../live/clock';

/* ───────────── Settings ───────────── */

export type EngineId = 'whisper' | 'browser';
export type ShortcutId = 'ctrl-shift-space' | 'ctrl-alt-space' | 'f9';
export type ModelSize = 'tiny' | 'base';

export interface VoiceSettings {
  engine: EngineId;
  model: ModelSize;
  language: string;
  /** Hold to talk anywhere; tap once to keep listening. */
  pushToTalk: boolean;
  shortcut: ShortcutId;
  /** Names and words to spell your way: Whisper's output is corrected to these. */
  dictionary: string[];
}

export const LANGUAGES = [
  { code: 'en', name: 'English', whisper: 'english', bcp47: 'en-US' },
  { code: 'es', name: 'Spanish', whisper: 'spanish', bcp47: 'es-ES' },
  { code: 'fr', name: 'French', whisper: 'french', bcp47: 'fr-FR' },
  { code: 'de', name: 'German', whisper: 'german', bcp47: 'de-DE' },
  { code: 'pt', name: 'Portuguese', whisper: 'portuguese', bcp47: 'pt-BR' },
  { code: 'it', name: 'Italian', whisper: 'italian', bcp47: 'it-IT' },
  { code: 'nl', name: 'Dutch', whisper: 'dutch', bcp47: 'nl-NL' },
  { code: 'ja', name: 'Japanese', whisper: 'japanese', bcp47: 'ja-JP' },
  { code: 'hi', name: 'Hindi', whisper: 'hindi', bcp47: 'hi-IN' },
] as const;

export const MODELS: Record<ModelSize, { name: string; size: string; hint: string }> = {
  tiny: { name: 'Tiny', size: 'about 40 MB', hint: 'Fastest. Good for short replies.' },
  base: { name: 'Base', size: 'about 80 MB', hint: 'More accurate, a little slower.' },
};

export const SHORTCUTS: Record<ShortcutId, { label: string; match: (e: KeyboardEvent) => boolean; key: string }> = {
  'ctrl-shift-space': { label: 'Ctrl + Shift + Space', key: 'Space', match: (e) => e.code === 'Space' && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey },
  'ctrl-alt-space': { label: 'Ctrl + Alt + Space', key: 'Space', match: (e) => e.code === 'Space' && e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey },
  f9: { label: 'F9', key: 'F9', match: (e) => e.code === 'F9' && !e.ctrlKey && !e.altKey && !e.metaKey },
};

/** Full names and company names from the workspace: what Whisper most often misspells. */
export function workspaceWords(): string[] {
  // The demo's own company is a word to know there; a real workspace starts from its own people and companies.
  const out = new Set<string>(isLive() ? ['Timmy'] : ['Timmy', 'Northpeak']);
  for (const p of Object.values(PEOPLE)) {
    if (p.bot) continue;
    if (p.name.includes(' ')) out.add(p.name);
    if (p.company) {
      out.add(p.company);
      const first = p.company.split(' ')[0]!;
      if (p.company.includes(' ') && first.length > 3) out.add(first);
    }
  }
  return [...out];
}

const KEY = 'timmy-voice-v1';
const defaults = (): VoiceSettings => ({
  engine: 'whisper',
  model: 'tiny',
  language: 'en',
  pushToTalk: true,
  shortcut: 'ctrl-shift-space',
  dictionary: workspaceWords(),
});

function loadSettings(): VoiceSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults(), ...(JSON.parse(raw) as Partial<VoiceSettings>) };
  } catch {
    /* storage unavailable */
  }
  return defaults();
}

let settings = loadSettings();
const settingsListeners = new Set<() => void>();

export const getVoiceSettings = () => settings;

export function setVoiceSettings(change: Partial<VoiceSettings>) {
  settings = { ...settings, ...change };
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage full or unavailable: the change still applies for this visit */
  }
  settingsListeners.forEach((l) => l());
}

export function useVoiceSettings(): [VoiceSettings, (change: Partial<VoiceSettings>) => void] {
  const s = useSyncExternalStore(
    (l) => (settingsListeners.add(l), () => settingsListeners.delete(l)),
    () => settings,
  );
  return [s, setVoiceSettings];
}

/* ───────────── What this browser can do ───────────── */

type SpeechRecognitionCtor = new () => SpeechRec;
interface SpeechRec {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

const speechCtor = (): SpeechRecognitionCtor | undefined => {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

export function voiceSupport() {
  return {
    secure: window.isSecureContext,
    mic: !!navigator.mediaDevices?.getUserMedia,
    whisper: typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && typeof MediaRecorder !== 'undefined',
    webgpu: 'gpu' in navigator,
    browser: !!speechCtor(),
  };
}

/** The engine to use: the chosen one if this browser has it, else the other, else none. */
export function resolveEngine(choice: EngineId): EngineId | null {
  const s = voiceSupport();
  const ok = (e: EngineId) => (e === 'whisper' ? s.whisper : s.browser);
  return ok(choice) ? choice : ok(choice === 'whisper' ? 'browser' : 'whisper') ? (choice === 'whisper' ? 'browser' : 'whisper') : null;
}

/* ───────────── Errors ───────────── */

export type VoiceErrorCode = 'unsupported' | 'insecure' | 'permission' | 'no-mic' | 'model' | 'network' | 'no-speech' | 'other';

export class VoiceError extends Error {
  constructor(
    public code: VoiceErrorCode,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

export const VOICE_ERRORS: Record<VoiceErrorCode, string> = {
  unsupported: 'This browser can’t record audio. Try a recent Chrome, Edge, Firefox or Safari.',
  insecure: 'The microphone only works on a secure (https) page.',
  permission: 'Microphone access is blocked. Allow it from the icon beside the address bar, then try again.',
  'no-mic': 'No microphone is available. Plug one in, or close other apps using it.',
  model: 'The voice model couldn’t be downloaded. Check your connection, or switch to your browser’s speech recognition.',
  network: 'Your browser’s speech service couldn’t be reached. Check your connection, or switch to Whisper in your browser.',
  'no-speech': 'Didn’t catch anything. Try again a little closer to the mic.',
  other: 'Dictation stopped unexpectedly. Try again.',
};

const micError = (err: unknown) => {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return new VoiceError('permission');
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError' || name === 'DevicesNotFoundError') return new VoiceError('no-mic');
  return new VoiceError('other', String(err));
};

/* ───────────── Microphone ───────────── */

class Mic {
  private ctx: AudioContext;
  private analyser: AnalyserNode;
  private buf: Float32Array<ArrayBuffer>;
  private recorder?: MediaRecorder;
  private chunks: Blob[] = [];

  private constructor(private stream: MediaStream) {
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
  }

  static async open(): Promise<Mic> {
    if (!window.isSecureContext) throw new VoiceError('insecure');
    if (!navigator.mediaDevices?.getUserMedia) throw new VoiceError('unsupported');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      return new Mic(stream);
    } catch (err) {
      throw micError(err);
    }
  }

  /** Loudness 0–1 (RMS, scaled so normal speech fills most of the meter). */
  level() {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) sum += v * v;
    return Math.min(1, Math.sqrt(sum / this.buf.length) * 6);
  }

  record() {
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.start(250);
  }

  stopRecording(): Promise<Blob> {
    return new Promise((resolve) => {
      const r = this.recorder;
      if (!r || r.state === 'inactive') return resolve(new Blob(this.chunks));
      r.onstop = () => resolve(new Blob(this.chunks, { type: r.mimeType }));
      r.stop();
    });
  }

  close() {
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    } catch {
      /* already stopped */
    }
    this.stream.getTracks().forEach((t) => t.stop());
    void this.ctx.close().catch(() => undefined);
  }
}

/** Decodes a recording to 16 kHz mono, the input Whisper expects. */
async function toPcm16k(blob: Blob): Promise<Float32Array> {
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    // A copy: the worker takes ownership of the buffer, and an AudioBuffer's own can't be transferred.
    if (audio.numberOfChannels === 1) return new Float32Array(audio.getChannelData(0));
    const out = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < ch.length; i++) out[i]! += ch[i]! / audio.numberOfChannels;
    }
    return out;
  } finally {
    void ctx.close().catch(() => undefined);
  }
}

const rms = (pcm: Float32Array) => {
  let sum = 0;
  for (const v of pcm) sum += v * v;
  return Math.sqrt(sum / Math.max(1, pcm.length));
};

/* ───────────── Whisper (in a worker) ───────────── */

export interface ModelStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  model?: string;
  loaded?: number;
  total?: number;
  device?: 'webgpu' | 'wasm';
  error?: string;
}

let modelStatus: ModelStatus = { state: 'idle' };
const modelListeners = new Set<() => void>();
const setModelStatus = (s: ModelStatus) => {
  modelStatus = s;
  modelListeners.forEach((l) => l());
};

export function useModelStatus() {
  return useSyncExternalStore(
    (l) => (modelListeners.add(l), () => modelListeners.delete(l)),
    () => modelStatus,
  );
}

export const whisperModelId = (s: Pick<VoiceSettings, 'model' | 'language'>) => `onnx-community/whisper-${s.model}${s.language === 'en' ? '.en' : ''}`;

let worker: Worker | null = null;
let reqSeq = 0;
const pending = new Map<number, { resolve: (t: string) => void; reject: (e: VoiceError) => void }>();
const readyWaiters: { model: string; resolve: () => void; reject: (e: VoiceError) => void }[] = [];

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as { type: string; id?: number; text?: string; loaded?: number; total?: number; device?: 'webgpu' | 'wasm'; stage?: string; message?: string };
    if (m.type === 'progress') setModelStatus({ ...modelStatus, state: 'loading', loaded: m.loaded, total: m.total });
    else if (m.type === 'ready') {
      setModelStatus({ state: 'ready', model: modelStatus.model, device: m.device });
      readyWaiters.splice(0).forEach((w) => w.resolve());
    } else if (m.type === 'result' && m.id !== undefined) {
      pending.get(m.id)?.resolve(m.text ?? '');
      pending.delete(m.id);
    } else if (m.type === 'error') {
      const err = new VoiceError(m.stage === 'model' ? 'model' : 'other', m.message);
      if (m.stage === 'model') {
        setModelStatus({ state: 'error', model: modelStatus.model, error: m.message });
        readyWaiters.splice(0).forEach((w) => w.reject(err));
      }
      if (m.id !== undefined) {
        pending.get(m.id)?.reject(err);
        pending.delete(m.id);
      }
    }
  };
  worker.onerror = (e) => {
    const err = new VoiceError('model', e.message);
    setModelStatus({ state: 'error', model: modelStatus.model, error: e.message });
    readyWaiters.splice(0).forEach((w) => w.reject(err));
    pending.forEach((p) => p.reject(err));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** Downloads (or loads from the browser cache) the Whisper model ahead of the first dictation. */
export function preloadWhisper(s: Pick<VoiceSettings, 'model' | 'language'> = settings): Promise<void> {
  const model = whisperModelId(s);
  if (modelStatus.state === 'ready' && modelStatus.model === model) return Promise.resolve();
  return new Promise((resolve, reject) => {
    readyWaiters.push({ model, resolve, reject });
    if (modelStatus.state !== 'loading' || modelStatus.model !== model) {
      setModelStatus({ state: 'loading', model, loaded: 0, total: 0 });
      getWorker().postMessage({ type: 'load', model });
    }
  });
}

function transcribeWhisper(audio: Float32Array, s: VoiceSettings): Promise<string> {
  const model = whisperModelId(s);
  if (!(modelStatus.state === 'ready' && modelStatus.model === model)) setModelStatus({ state: 'loading', model, loaded: modelStatus.loaded ?? 0, total: modelStatus.total ?? 0 });
  const id = ++reqSeq;
  const language = LANGUAGES.find((l) => l.code === s.language)?.whisper ?? 'english';
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ type: 'transcribe', id, model, audio, language }, [audio.buffer]);
  });
}

/** Whether the model files are already in the browser's cache. */
export async function isModelCached(s: Pick<VoiceSettings, 'model' | 'language'>) {
  try {
    const cache = await caches.open('transformers-cache');
    const keys = await cache.keys();
    const id = whisperModelId(s);
    return keys.some((r) => r.url.includes(`/${id}/`) && /decoder_model_merged/.test(r.url));
  } catch {
    return false;
  }
}

/** Whisper writes these for silence or noise. */
const NOISE = /\[[^\]]*\]|\((music|silence|no speech|inaudible|beep\w*|tone|static|buzzing)\)|^\s*\.+\s*$/gi;
/** Whole transcripts Whisper is known to invent from non-speech (tones, hum, breathing). */
const HALLUCINATIONS = new Set(['you', 'bye', 'thanks for watching', 'thank you for watching', 'please subscribe', 'subtitles by the amaraorg community']);
const isHallucination = (t: string) => HALLUCINATIONS.has(t.toLowerCase().replace(/[^a-z ]/g, '').trim());

/* ───────────── Sessions ───────────── */

export type Phase = 'starting' | 'listening' | 'transcribing';

export interface DictationCallbacks {
  onPhase(phase: Phase): void;
  onLevel?(level: number): void;
  /** Live words as you speak (browser engine only). */
  onInterim?(text: string): void;
  onResult(text: string): void;
  onError(err: VoiceError): void;
}

export interface DictationSession {
  engine: EngineId;
  stop(): void;
  cancel(): void;
}

const MAX_MS = 120_000;

export function startDictation(s: VoiceSettings, cb: DictationCallbacks): DictationSession {
  const engine = resolveEngine(s.engine);
  if (!engine) {
    queueMicrotask(() => cb.onError(new VoiceError(voiceSupport().secure ? 'unsupported' : 'insecure')));
    return { engine: s.engine, stop() {}, cancel() {} };
  }
  return engine === 'whisper' ? whisperSession(s, cb) : browserSession(s, cb);
}

function whisperSession(s: VoiceSettings, cb: DictationCallbacks): DictationSession {
  let mic: Mic | null = null;
  let done = false;
  let stopAsked = false;
  let meter = 0;
  let cap = 0;
  const finish = () => {
    done = true;
    window.clearInterval(meter);
    window.clearTimeout(cap);
    mic?.close();
  };

  const stop = async () => {
    if (done || stopAsked) return;
    stopAsked = true;
    if (!mic) return; // stop() before the mic opened: handled once it does
    window.clearInterval(meter);
    cb.onPhase('transcribing');
    try {
      const blob = await mic.stopRecording();
      finish();
      const pcm = await toPcm16k(blob);
      if (pcm.length < 16000 * 0.3 || rms(pcm) < 0.002) throw new VoiceError('no-speech');
      const raw = await transcribeWhisper(pcm, s);
      const text = applyDictionary(raw.replace(NOISE, '').replace(/\s+/g, ' ').trim(), s.dictionary);
      if (!text || isHallucination(text)) throw new VoiceError('no-speech');
      cb.onResult(text);
    } catch (err) {
      finish();
      cb.onError(err instanceof VoiceError ? err : new VoiceError('other', String(err)));
    }
  };

  cb.onPhase('starting');
  // Fetch the model while you talk, so the first transcription doesn't wait for it as long.
  void preloadWhisper(s).catch(() => undefined);
  Mic.open().then(
    (m) => {
      if (done) return m.close();
      mic = m;
      m.record();
      cb.onPhase('listening');
      meter = window.setInterval(() => cb.onLevel?.(m.level()), 70);
      cap = window.setTimeout(() => void stop(), MAX_MS);
      if (stopAsked) {
        stopAsked = false;
        void stop();
      }
    },
    (err) => {
      finish();
      cb.onError(err instanceof VoiceError ? err : micError(err));
    },
  );

  return {
    engine: 'whisper',
    stop: () => void stop(),
    cancel: () => {
      if (done) return;
      finish();
    },
  };
}

function browserSession(s: VoiceSettings, cb: DictationCallbacks): DictationSession {
  const Ctor = speechCtor()!;
  const rec = new Ctor();
  rec.lang = LANGUAGES.find((l) => l.code === s.language)?.bcp47 ?? 'en-US';
  rec.continuous = true;
  rec.interimResults = true;
  let finals = '';
  let interim = '';
  let mic: Mic | null = null;
  let meter = 0;
  let cap = 0;
  let done = false;
  let cancelled = false;
  let failed = false;

  const cleanup = () => {
    done = true;
    window.clearInterval(meter);
    window.clearTimeout(cap);
    mic?.close();
  };

  rec.onresult = (e) => {
    interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]!;
      if (r.isFinal) finals += `${r[0].transcript} `;
      else interim += r[0].transcript;
    }
    cb.onInterim?.(applyDictionary(`${finals}${interim}`.trim(), s.dictionary));
  };
  rec.onerror = (e) => {
    if (e.error === 'aborted' || cancelled) return;
    failed = true;
    cleanup();
    const code: VoiceErrorCode =
      e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'permission' : e.error === 'audio-capture' ? 'no-mic' : e.error === 'network' ? 'network' : e.error === 'no-speech' ? 'no-speech' : 'other';
    cb.onError(new VoiceError(code, e.error));
  };
  rec.onend = () => {
    const wasDone = done;
    cleanup();
    if (cancelled || failed || (wasDone && !finals && !interim)) return;
    const text = applyDictionary(`${finals}${interim}`.replace(/\s+/g, ' ').trim(), s.dictionary);
    if (text) cb.onResult(text);
    else cb.onError(new VoiceError('no-speech'));
  };

  cb.onPhase('starting');
  Mic.open().then(
    (m) => {
      if (done || cancelled) return m.close();
      mic = m;
      try {
        rec.start();
      } catch (err) {
        cleanup();
        return cb.onError(new VoiceError('other', String(err)));
      }
      cb.onPhase('listening');
      meter = window.setInterval(() => cb.onLevel?.(m.level()), 70);
      cap = window.setTimeout(() => rec.stop(), MAX_MS);
    },
    (err) => {
      cleanup();
      cb.onError(err instanceof VoiceError ? err : micError(err));
    },
  );

  return {
    engine: 'browser',
    stop: () => {
      if (done) return;
      window.clearInterval(meter);
      cb.onPhase('transcribing');
      try {
        rec.stop();
      } catch {
        rec.onend?.();
      }
    },
    cancel: () => {
      cancelled = true;
      cleanup();
      try {
        rec.abort();
      } catch {
        /* not started */
      }
    },
  };
}

/* ───────────── Custom dictionary ───────────── */

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

const lev = (a: string, b: string) => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
};

/**
 * Corrects a transcript to your spellings: "dana whitefield at north peak" →
 * "Dana Whitfield at Northpeak". Exact matches ignore case, spaces and punctuation;
 * near misses (one letter off, two for long names) count only for names of six
 * letters or more with the same first letter and the same number of words.
 */
export function applyDictionary(text: string, dictionary: string[]): string {
  if (!text || !dictionary.length) return text;
  const words = text.split(/\s+/).filter(Boolean);
  const entries = [...new Set(dictionary.map((d) => d.trim()).filter(Boolean))]
    .map((d) => ({ d, n: norm(d), k: d.split(/\s+/).length }))
    .filter((e) => e.n.length > 1)
    .sort((a, b) => b.k - a.k || b.n.length - a.n.length);
  const locked = new Array<boolean>(words.length).fill(false);

  for (const e of entries) {
    for (let k = Math.max(1, e.k - 1); k <= e.k + 1; k++) {
      for (let i = 0; i + k <= words.length; i++) {
        if (locked.slice(i, i + k).some(Boolean)) continue;
        const span = words.slice(i, i + k);
        const lead = span[0]!.match(/^[(“"‘']+/)?.[0] ?? '';
        const trail = span[k - 1]!.match(/[.,!?;:)”"’']+$/)?.[0] ?? '';
        const core = norm(span.join(''));
        const near = k === e.k && e.n.length >= 6 && core[0] === e.n[0] && lev(core, e.n) <= (e.n.length >= 9 ? 2 : 1);
        if (core !== e.n && !near) continue;
        words.splice(i, k, `${lead}${e.d}${trail}`);
        locked.splice(i, k, true);
      }
    }
  }
  return words.join(' ');
}

/* ───────────── Putting text where the cursor is ───────────── */

/** Joins dictated text into a value at a selection, with sensible spaces and capitals. */
export function joinAt(value: string, start: number, end: number, text: string) {
  const before = value.slice(0, start);
  const after = value.slice(end);
  let t = text.trim();
  const sentenceStart = !before.trim() || /[.!?]\s*$/.test(before) || /\n\s*$/.test(before);
  if (sentenceStart) t = t.charAt(0).toUpperCase() + t.slice(1);
  const lead = before && !/\s$/.test(before) && !/[(“"‘'/-]$/.test(before) ? ' ' : '';
  const tail = after && !/^\s/.test(after) && !/^[.,!?;:)”"’']/.test(after) ? ' ' : '';
  const insert = `${lead}${t}${tail}`;
  return { value: before + insert + after, caret: before.length + lead.length + t.length, insert };
}

export type Editable = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

const TEXT_INPUTS = /^(text|search|email|url|tel|password|)$/i;

/** The element push-to-talk should type into, if any. */
export function editableTarget(el: Element | null): Editable | null {
  if (!el || !(el instanceof HTMLElement)) return null;
  if (el instanceof HTMLTextAreaElement) return el.readOnly || el.disabled ? null : el;
  if (el instanceof HTMLInputElement) return TEXT_INPUTS.test(el.type) && !el.readOnly && !el.disabled ? el : null;
  if (el.isContentEditable) return el;
  return null;
}

/**
 * Types text into a field the way a keyboard would, so React's onChange and the
 * field's undo history both see it.
 */
export function typeInto(el: Editable, text: string, sel?: { start: number; end: number }) {
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const start = sel?.start ?? el.selectionStart ?? el.value.length;
    const end = sel?.end ?? el.selectionEnd ?? start;
    const { value, caret, insert } = joinAt(el.value, start, end, text);
    el.setSelectionRange(start, end);
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, insert);
    } catch {
      ok = false;
    }
    if (!ok || el.value !== value) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.setSelectionRange(caret, caret);
    return;
  }
  try {
    document.execCommand('insertText', false, ` ${text.trim()}`);
  } catch {
    el.textContent = `${el.textContent ?? ''} ${text.trim()}`;
  }
}
