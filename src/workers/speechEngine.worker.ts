/// <reference lib="webworker" />
/**
 * Dual-Stream offline speech engine. Runs entirely in this Web Worker:
 *   Stream A — Whisper-tiny.en (q8) → plain English transcript (lexical intent)
 *   Stream B — wav2vec2-lv60-espeak (q4) CTC → produced IPA with 20 ms timings
 *   Stream C — espeak-ng WASM (en-GB-x-rp) G2P + connected-speech rules → target RP IPA
 *   Stream D — YIN / RMS / nPVI prosody DSP
 * One inference session per model, reused for every turn.
 */
import { env, pipeline as hfPipeline, AutoProcessor, AutoModelForCTC, type AutomaticSpeechRecognitionPipeline, type FeatureExtractionPipeline, type PreTrainedModel, type Processor, type Tensor } from '@huggingface/transformers';
import { targetFromText } from '../lib/g2p';
import { analyzeProsody } from '../lib/prosody';
import { ctcGreedy } from '../lib/ctc';
import { chunkBoundaries } from '../lib/audioUtils';
import type { ProducedPhone } from '../services/ipaAligner';
import { MODELS, type AnalyzeRequest, type AnalyzeResponse, type CacheStatus, type InitOptions, type ModelKey, type WorkerEvent, type WorkerRequest } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

// The overloaded pipeline() signature is too complex for tsc to resolve; we only use two tasks.
const pipeline = hfPipeline as unknown as (task: string, model: string, opts: Record<string, unknown>) => Promise<unknown>;

const TRANSFORMERS_CACHE = 'transformers-cache';
const VOCAB_CACHE = 'lexiphon-vocab';
const SR = 16000;

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let w2vProcessor: Processor | null = null;
let w2vModel: PreTrainedModel | null = null;
let w2vVocab: string[] | null = null;
let embedder: FeatureExtractionPipeline | null = null;
let device: 'webgpu' | 'wasm' = 'wasm';
let initChain: Promise<void> = Promise.resolve();

function post(ev: WorkerEvent) {
  self.postMessage(ev);
}

function progressFor(model: ModelKey) {
  return (p: { status: string; file?: string; loaded?: number; total?: number }) => {
    post({ type: 'progress', model, file: p.file ?? '', loaded: p.loaded ?? 0, total: p.total ?? 0, status: p.status });
  };
}

async function pickDevice(pref: InitOptions['device'], constrained = false): Promise<'webgpu' | 'wasm'> {
  if (pref === 'wasm' || (pref === 'auto' && constrained)) return 'wasm';
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return 'wasm';
  try {
    return (await gpu.requestAdapter()) ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

async function loadVocab(): Promise<string[]> {
  const url = `https://huggingface.co/${MODELS.phoneme.id}/resolve/main/vocab.json`;
  let res: Response | undefined;
  try {
    const cache = await caches.open(VOCAB_CACHE);
    res = await cache.match(url);
    if (!res) {
      const fresh = await fetch(url);
      if (!fresh.ok) throw new Error(`vocab.json HTTP ${fresh.status}`);
      await cache.put(url, fresh.clone());
      res = fresh;
    }
  } catch {
    res = await fetch(url);
  }
  const map = (await res.json()) as Record<string, number>;
  const arr: string[] = [];
  for (const [tok, idx] of Object.entries(map)) arr[idx] = tok;
  return arr;
}

async function init(opts: InitOptions): Promise<void> {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  const wasm = env.backends.onnx.wasm;
  if (wasm) {
    wasm.wasmPaths = `${opts.base}ort/`;
    wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  }
  device = await pickDevice(opts.device, opts.constrained);

  if (!asr) {
    asr = (await pipeline('automatic-speech-recognition', MODELS.asr.id, {
      dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : { encoder_model: 'q8', decoder_model_merged: 'q8' },
      device,
      progress_callback: progressFor('asr'),
    })) as AutomaticSpeechRecognitionPipeline;
  }
  // Warm up espeak-ng (loads its WASM + RP voice once).
  await targetFromText('hello');

  if (opts.phonemeModel === 'full' && !w2vModel) {
    w2vVocab = await loadVocab();
    w2vProcessor = await AutoProcessor.from_pretrained(MODELS.phoneme.id, { progress_callback: progressFor('phoneme') });
    w2vModel = await AutoModelForCTC.from_pretrained(MODELS.phoneme.id, { dtype: 'q4', device, progress_callback: progressFor('phoneme') });
  }
  if (opts.embeddings && !embedder) {
    try {
      embedder = (await pipeline('feature-extraction', MODELS.embed.id, { dtype: 'q8', device: 'wasm', progress_callback: progressFor('embed') })) as FeatureExtractionPipeline;
    } catch (e) {
      console.warn('[engine] embeddings unavailable', e);
    }
  }
  try { await navigator.storage?.persist?.(); } catch { /* not available in all workers */ }
  post({ type: 'ready', models: { asr: !!asr, phoneme: !!w2vModel, embed: !!embedder }, device });
}

async function recognisePhones(audio: Float32Array): Promise<ProducedPhone[]> {
  if (!w2vModel || !w2vProcessor) return [];
  const bounds = chunkBoundaries(audio);
  const phones: ProducedPhone[] = [];
  for (let c = 0; c + 1 < bounds.length; c++) {
    const slice = audio.subarray(bounds[c], bounds[c + 1]);
    if (slice.length < SR * 0.2) continue;
    const inputs = await w2vProcessor(slice);
    const { logits } = (await w2vModel(inputs)) as { logits: Tensor };
    const [, T, V] = logits.dims as number[];
    phones.push(...ctcGreedy(logits.data as Float32Array, T, V, w2vVocab ?? [], bounds[c] / SR));
    logits.dispose?.();
  }
  return phones;
}

async function transcribe(audio: Float32Array): Promise<string> {
  if (!asr) throw new Error('ASR model not loaded');
  const opts = audio.length > 30 * SR ? { chunk_length_s: 30, stride_length_s: 5 } : {};
  const res = (await asr(audio, opts)) as { text: string } | { text: string }[];
  const text = Array.isArray(res) ? res.map((r) => r.text).join(' ') : res.text;
  return text.replace(/\[(BLANK_AUDIO|MUSIC|NOISE)\]|\((?:[^)]*)\)/gi, '').replace(/\s+/g, ' ').trim();
}

async function analyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
  if (req.sampleRate !== SR) throw new Error(`expected ${SR} Hz audio`);
  const timings: Record<string, number> = {};
  const t = () => performance.now();
  let t0 = t();
  const prosody = analyzeProsody(req.audio, SR);
  timings.dsp = t() - t0;

  t0 = t();
  const transcript = await transcribe(req.audio);
  timings.asr = t() - t0;

  t0 = t();
  const produced = w2vModel ? await recognisePhones(req.audio) : null;
  timings.phonemes = t() - t0;

  t0 = t();
  const target = await targetFromText(req.referenceText ?? transcript);
  timings.g2p = t() - t0;
  return { transcript, produced, target, prosody, timings };
}

async function embed(texts: string[]): Promise<number[][] | null> {
  if (!embedder) return null;
  const out = await embedder(texts, { pooling: 'mean', normalize: true });
  return out.tolist() as number[][];
}

async function cacheStatus(): Promise<CacheStatus> {
  const models = {} as CacheStatus['models'];
  for (const k of Object.keys(MODELS) as ModelKey[]) models[k] = { cached: false, bytes: 0, files: 0 };
  try {
    const cache = await caches.open(TRANSFORMERS_CACHE);
    for (const req of await cache.keys()) {
      for (const k of Object.keys(MODELS) as ModelKey[]) {
        if (!req.url.includes(MODELS[k].id)) continue;
        const res = await cache.match(req);
        const len = Number(res?.headers.get('content-length') ?? 0);
        models[k].files++;
        models[k].bytes += len;
        if (req.url.endsWith('.onnx')) models[k].cached = true;
      }
    }
  } catch { /* Cache Storage unavailable */ }
  let persisted: boolean | null = null, quota: CacheStatus['quota'] = null;
  try {
    persisted = (await navigator.storage?.persisted?.()) ?? null;
    const est = await navigator.storage?.estimate?.();
    if (est) quota = { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  } catch { /* ignore */ }
  return { models, persisted, quota };
}

async function clearCache(): Promise<void> {
  await caches.delete(TRANSFORMERS_CACHE);
  await caches.delete(VOCAB_CACHE);
  asr = null; w2vModel = null; w2vProcessor = null; embedder = null;
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    let result: unknown;
    switch (msg.type) {
      case 'init':
        // Serialise inits; a later init may add models (e.g. Stream B toggled on).
        initChain = initChain.catch(() => undefined).then(() => init(msg.payload));
        await initChain;
        result = { device };
        break;
      case 'analyze':
        result = await analyze(msg.payload);
        break;
      case 'g2p':
        result = await targetFromText(msg.payload.text);
        break;
      case 'embed':
        result = await embed(msg.payload.texts);
        break;
      case 'cacheStatus':
        result = await cacheStatus();
        break;
      case 'clearCache':
        await clearCache();
        result = true;
        break;
    }
    post({ type: 'result', id: msg.id, ok: true, result });
  } catch (err) {
    post({ type: 'result', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
