/**
 * Scoring sanity check with synthetic speakers: a British voice repeating a
 * sentence (scored against a different British reference voice) should pass,
 * and an American voice saying the same thing should be flagged for
 * rhoticity and score lower. Uses the exact runtime pipeline + calibration.
 *
 *   npx vite-node scripts/validate-scoring.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KokoroTTS } from 'kokoro-js';
import { kokoroPhonemes } from '../src/lib/g2p';
import { AutoModelForCTC, AutoProcessor, env, type Tensor } from '@huggingface/transformers';
import { targetFromText } from '../src/lib/g2p';
import { ctcGreedy } from '../src/lib/ctc';
import { resample } from '../src/lib/audioUtils';
import { analyzeProsody } from '../src/lib/prosody';
import { setAcousticCalibration } from '../src/services/ipaAligner';
import { evaluateTurn } from '../src/services/evaluate';
import { MODELS } from '../src/workers/protocol';
import type { CuratedData, Prompt } from '../src/types';

if (process.env.HF_CACHE_DIR) env.cacheDir = process.env.HF_CACHE_DIR;
const ROOT = process.cwd();
const SENTENCES = [
  'I want to go to the shop for a cup of tea, but the car park is far away.',
  'The first workers start early in the morning.',
  'Ask the staff after class about the bath.',
  'Our market share is far larger than before.',
  'Go home slowly and don\'t phone Joe.',
  'Her partner works in the car park near the corner.',
];
const SPEAKERS = [['bm_george', 'British'], ['bm_fable', 'British'], ['am_michael', 'American'], ['af_heart', 'American']] as const;

async function main() {
  setAcousticCalibration(JSON.parse(readFileSync(join(ROOT, 'public/data/acoustic_calibration.json'), 'utf8')));
  const data: CuratedData = { phonemes: [], vocab: [], prompts: [], rules: JSON.parse(readFileSync(join(ROOT, 'public/data/redundancy_rules.json'), 'utf8')) };
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
  const vm = JSON.parse(await (await fetch(`https://huggingface.co/${MODELS.phoneme.id}/resolve/main/vocab.json`)).text()) as Record<string, number>;
  const vocab: string[] = [];
  for (const [k, v] of Object.entries(vm)) vocab[v] = k;
  const proc = await AutoProcessor.from_pretrained(MODELS.phoneme.id);
  const model = await AutoModelForCTC.from_pretrained(MODELS.phoneme.id, { dtype: 'q4' });
  const render = async (text: string, voice: string) => {
    const a = voice.startsWith('b')
      ? await tts.generate_from_ids(tts.tokenizer(await kokoroPhonemes(text), { truncation: true }).input_ids, { voice: voice as 'bf_emma' })
      : await tts.generate(text, { voice: voice as 'bf_emma' });
    return resample(a.audio as Float32Array, a.sampling_rate, 16000);
  };
  const rows: string[] = [];
  const totals: Record<string, number[]> = { British: [], American: [] };
  for (const text of SENTENCES) {
    const ref = analyzeProsody(await render(text, 'bf_emma'), 16000);
    const target = await targetFromText(text);
    const prompt: Prompt = { id: 'x', tier: 1, mode: 'shadow', level: 1, category: 'sentence', title: '', text, reference: text, targetVocab: [], timeLimitSec: 20 };
    for (const [voice, accent] of SPEAKERS) {
      const audio = await render(text, voice);
      const { logits } = (await model(await proc(audio))) as { logits: Tensor };
      const [, T, V] = logits.dims as number[];
      const produced = ctcGreedy(logits.data as Float32Array, T, V, vocab);
      const r = evaluateTurn({ prompt, attempt: 1, transcript: text, target, produced, prosody: analyzeProsody(audio, 16000), semantic: null, audio, reference: { prosody: ref, voice: 'bf_emma' } }, data);
      totals[accent].push(r.reward.reward);
      const diag = Object.entries(r.alignment!.diagnoses).filter(([k]) => !['ELISION', 'INSERTION'].includes(k)).map(([k, v]) => `${k}×${v}`).join(' ');
      rows.push(`${accent.padEnd(9)} ${voice.padEnd(11)} R=${r.reward.reward.toFixed(0).padStart(3)} phon=${r.reward.phonetic!.toFixed(0)} pros=${r.reward.prosody.toFixed(0)} melody=${r.prosodyBreakdown.reference?.shapeCorr?.toFixed(2) ?? '—'} ${r.reward.passed ? 'PASS' : 'fail'}  ${diag}`);
    }
    rows.push(`  ↳ "${text}"`);
  }
  console.log(rows.join('\n'));
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  console.log(`\nmean reward — British ${mean(totals.British).toFixed(1)} · American ${mean(totals.American).toFixed(1)}`);
}

void main();
