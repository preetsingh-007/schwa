/**
 * Runs the real Dual-Stream pipeline in Node (onnxruntime-node) on a recording,
 * printing the transcript, raw CTC phones, word-level RP diff and reward.
 *
 *   ffmpeg -i speech.wav -ac 1 -ar 16000 -f f32le speech.f32
 *   npx vite-node scripts/pipeline-check.ts speech.f32 ["Text the speaker was reading"]
 */
import { readFileSync } from 'node:fs';
import { pipeline, AutoProcessor, AutoModelForCTC, env } from '@huggingface/transformers';
import { targetFromText } from '../src/lib/g2p';
import { analyzeProsody } from '../src/lib/prosody';
import { normalizeAcousticToken } from '../src/lib/ipa';
import { evaluateTurn } from '../src/services/evaluate';
import type { ProducedPhone } from '../src/services/ipaAligner';
import type { CuratedData } from '../src/types';

if (process.env.HF_CACHE_DIR) env.cacheDir = process.env.HF_CACHE_DIR;
const raw = readFileSync(process.argv[2]);
const audio = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const t0 = Date.now();
const asr: any = await (pipeline as any)('automatic-speech-recognition', 'onnx-community/whisper-tiny.en', { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } });
const text = (await asr(audio)).text.trim();
console.log('ASR', Date.now() - t0, 'ms:', text);
const id = 'onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX';
const vocab = JSON.parse(await (await fetch(`https://huggingface.co/${id}/resolve/main/vocab.json`)).text()) as Record<string, number>;
const inv: string[] = []; for (const [k, v] of Object.entries(vocab)) inv[v] = k;
const proc = await AutoProcessor.from_pretrained(id);
const model = await AutoModelForCTC.from_pretrained(id, { dtype: 'q4' });
const t1 = Date.now();
const inputs = await proc(audio);
const { logits } = await model(inputs) as any;
const [, T, V] = logits.dims; const d = logits.data as Float32Array;
const toks: string[] = []; const produced: ProducedPhone[] = [];
let prev = -1, start = 0;
const flush = (id: number, s: number, e: number) => { const ph = normalizeAcousticToken(inv[id]); toks.push(inv[id]); ph.forEach((p) => produced.push({ p, start: s * 0.02, end: (e + 1) * 0.02 })); };
for (let t = 0; t < T; t++) { let b = 0, bv = -Infinity; for (let v = 0; v < V; v++) if (d[t * V + v] > bv) { bv = d[t * V + v]; b = v; } if (b !== prev) { if (prev > 0) flush(prev, start, t - 1); prev = b; start = t; } }
if (prev > 0) flush(prev, start, T - 1);
console.log('W2V', Date.now() - t1, 'ms raw:', toks.join(' '));
const target = await targetFromText(process.argv[3] ?? text);
const prosody = analyzeProsody(audio, 16000);
const dir = new URL('../public/data/', import.meta.url).pathname;
const data: CuratedData = { phonemes: [], vocab: JSON.parse(readFileSync(dir + 'vocab_curriculum.json', 'utf8')), rules: JSON.parse(readFileSync(dir + 'redundancy_rules.json', 'utf8')), prompts: [] };
const prompt = { id: 'x', tier: 3 as const, category: 'x', title: 'x', text: 'Say something inspiring', targetVocab: [], timeLimitSec: 60 };
const r = evaluateTurn({ prompt, attempt: 1, transcript: text, target, produced, prosody, semantic: null, audio }, data);
for (const w of r.alignment!.words) console.log(w.status.padEnd(6), w.text.padEnd(10), '/' + w.targetIpa + '/', '[' + w.producedIpa + ']', w.pairs.filter((p) => p.diagnosis && p.kind !== 'match').map((p) => `${p.target?.p ?? '+'}→${p.produced?.p ?? '∅'}:${p.diagnosis}`).join(' '));
console.log('PER', r.alignment!.per.toFixed(2), 'wPER', r.alignment!.weightedPer.toFixed(2), 'schwa', r.alignment!.schwa, 'diag', r.alignment!.diagnoses);
console.log('prosody', { npvi: prosody.npvi.toFixed(1), syl: prosody.syllables, rate: prosody.syllableRate.toFixed(2), pauses: prosody.longPauses.length, f0: prosody.f0MedianHz.toFixed(0), range: prosody.f0RangeSt.toFixed(1), slope: prosody.finalSlopeSt.toFixed(1) });
console.log('reward', r.reward, 'concise', r.concise?.score.toFixed(2), r.concise?.hits.map((h) => h.text));
