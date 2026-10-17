/// <reference lib="webworker" />
/**
 * On-device neural RP voice: Kokoro-82M (q8, ~92 MB) with its en-GB voices.
 * Lives in its own worker so it can be terminated to free memory on iOS
 * without touching the speech-analysis engine. Each render also returns the
 * reference prosody (pitch contour, rhythm) used to score listen-and-repeat turns.
 */
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';
import { analyzeProsody, type ProsodyMetrics } from '../lib/prosody';
import { resample } from '../lib/audioUtils';
import { kokoroPhonemes } from '../lib/g2p';

declare const self: DedicatedWorkerGlobalScope;

export const KOKORO_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

export type TtsRequest =
  | { id: number; type: 'init'; base: string }
  | { id: number; type: 'synth'; text: string; voice: string; speed: number };
export type TtsEvent =
  | { type: 'result'; id: number; ok: true; result: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'progress'; file: string; loaded: number; total: number; status: string };
export interface SynthResult { audio: Float32Array; sampleRate: number; prosody: ProsodyMetrics }

let tts: KokoroTTS | null = null;
let loading: Promise<KokoroTTS> | null = null;

function post(ev: TtsEvent, transfer: Transferable[] = []) {
  self.postMessage(ev, transfer);
}

async function init(base: string): Promise<KokoroTTS> {
  if (tts) return tts;
  if (!loading) {
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    const wasm = env.backends.onnx.wasm;
    if (wasm) {
      wasm.wasmPaths = `${base}ort/`;
      wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    }
    loading = KokoroTTS.from_pretrained(KOKORO_ID, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) =>
        post({ type: 'progress', file: p.file ?? '', loaded: p.loaded ?? 0, total: p.total ?? 0, status: p.status }),
    }).then((m) => (tts = m)).catch((e) => { loading = null; throw e; });
  }
  return loading;
}

/** Kokoro handles ~500 phonemes per call; long passages are rendered sentence by sentence. */
function chunks(text: string): string[] {
  if (text.length < 300) return [text];
  const parts = text.match(/[^.!?;]+[.!?;]+["']?\s*|[^.!?;]+$/g) ?? [text];
  const out: string[] = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > 280 && cur) { out.push(cur.trim()); cur = ''; }
    cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function synth(text: string, voice: string, speed: number, base: string): Promise<SynthResult> {
  const model = await init(base);
  const pieces: Float32Array[] = [];
  let sr = 24000;
  for (const c of chunks(text)) {
    // British voices speak our RP target phonemes; others use Kokoro's own front end.
    const a = voice.startsWith('b')
      ? await model.generate_from_ids(model.tokenizer(await kokoroPhonemes(c), { truncation: true }).input_ids, { voice: voice as 'bf_emma', speed })
      : await model.generate(c, { voice: voice as 'bf_emma', speed });
    sr = a.sampling_rate;
    pieces.push(a.audio as Float32Array, new Float32Array(Math.round(sr * 0.18)));
  }
  const audio = new Float32Array(pieces.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of pieces) { audio.set(p, o); o += p.length; }
  const prosody = analyzeProsody(resample(audio, sr, 16000), 16000);
  return { audio, sampleRate: sr, prosody };
}

let baseUrl = '/';
self.onmessage = async (e: MessageEvent<TtsRequest>) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      baseUrl = m.base;
      await init(baseUrl);
      post({ type: 'result', id: m.id, ok: true, result: true });
    } else {
      const r = await synth(m.text, m.voice, m.speed, baseUrl);
      post({ type: 'result', id: m.id, ok: true, result: r }, [r.audio.buffer]);
    }
  } catch (err) {
    post({ type: 'result', id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
