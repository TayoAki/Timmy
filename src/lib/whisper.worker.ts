/*
 * Whisper speech-to-text in a Web Worker, so neither the main bundle nor the UI
 * thread carries the model. transformers.js is imported only when the first
 * transcription is asked for; the model downloads once and the browser caches it
 * (Cache Storage, "transformers-cache"). WebGPU when the browser has it, else WASM.
 *
 * In:  { type: 'load', model }  |  { type: 'transcribe', id, model, audio: Float32Array (16 kHz mono), language? }
 * Out: { type: 'progress', loaded, total, file? } | { type: 'ready', device } | { type: 'result', id, text } | { type: 'error', id?, stage, message }
 */

type Asr = (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;

let asr: Asr | null = null;
let loadedModel = '';
let loading: Promise<void> | null = null;

const post = (msg: unknown) => (self as unknown as Worker).postMessage(msg);

async function hasWebGpu() {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    return !!gpu && !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function load(model: string) {
  if (asr && loadedModel === model) return;
  if (loading) await loading;
  if (asr && loadedModel === model) return;
  loading = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowLocalModels = false;
    const files: Record<string, { loaded: number; total: number }> = {};
    const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === 'progress' && p.file && p.total) {
        files[p.file] = { loaded: p.loaded ?? 0, total: p.total };
        const all = Object.values(files);
        post({ type: 'progress', file: p.file, loaded: all.reduce((s, f) => s + f.loaded, 0), total: all.reduce((s, f) => s + f.total, 0) });
      }
    };
    const gpu = await hasWebGpu();
    const make = (device: 'webgpu' | 'wasm') =>
      pipeline('automatic-speech-recognition', model, {
        device,
        // The examples' recommended precision: full encoder and 4-bit decoder on GPU, 8-bit on CPU.
        dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
        progress_callback,
      } as never) as unknown as Promise<Asr>;
    let device: 'webgpu' | 'wasm' = gpu ? 'webgpu' : 'wasm';
    try {
      asr = await make(device);
    } catch (err) {
      if (device !== 'webgpu') throw err;
      device = 'wasm';
      asr = await make(device);
    }
    loadedModel = model;
    post({ type: 'ready', device });
  })();
  try {
    await loading;
  } finally {
    loading = null;
  }
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as { type: string; id?: number; model: string; audio?: Float32Array; language?: string };
  try {
    await load(msg.model);
  } catch (err) {
    post({ type: 'error', id: msg.id, stage: 'model', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (msg.type !== 'transcribe' || !msg.audio || !asr) return;
  try {
    const english = msg.model.endsWith('.en');
    const out = await asr(msg.audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      ...(english ? {} : { language: msg.language, task: 'transcribe' }),
    });
    const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim();
    post({ type: 'result', id: msg.id, text });
  } catch (err) {
    post({ type: 'error', id: msg.id, stage: 'transcribe', message: err instanceof Error ? err.message : String(err) });
  }
};
