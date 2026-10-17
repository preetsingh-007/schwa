/**
 * Calibrates the acoustic rhoticity threshold: renders the same sentences
 * with Kokoro's British (non-rhotic) and American (rhotic) voices, measures
 * the F3 ratio at every spelled-r vowel, and picks the threshold with the best
 * balanced accuracy. Merges { rhotic: {...} } into acoustic_calibration.json.
 *
 *   npx vite-node scripts/calibrate-rhotic.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { KokoroTTS } from 'kokoro-js';
import { kokoroPhonemes } from '../src/lib/g2p';
import { AutoModelForCTC, AutoProcessor, env, type Tensor } from '@huggingface/transformers';
import { targetFromText } from '../src/lib/g2p';
import { ctcGreedy } from '../src/lib/ctc';
import { resample } from '../src/lib/audioUtils';
import { alignSequences, setAcousticCalibration } from '../src/services/ipaAligner';
import { measureRhoticity, rhoticScore } from '../src/lib/rhotic';
import { MODELS } from '../src/workers/protocol';
import type { Prompt, CorpusRow } from '../src/types';

if (process.env.HF_CACHE_DIR) env.cacheDir = process.env.HF_CACHE_DIR;
const ROOT = process.cwd();
const GB = ['bf_emma', 'bm_george'], US = ['af_heart', 'am_michael'];

function sentences(): string[] {
  const prompts = JSON.parse(readFileSync(join(ROOT, 'public/data/prompts_tiered.json'), 'utf8')) as Prompt[];
  const out = prompts.filter((p) => p.pillar === 'rhotic' || p.pillar === 'vowelspace').map((p) => p.text);
  const re = /\b\w*[aeiou]r(?![aeiouy])\w*\b/i;
  for (const L of [1, 2, 3, 4, 5]) {
    const f = join(ROOT, `public/corpus/level-0${L}.json`);
    if (!existsSync(f)) continue;
    const rows = (JSON.parse(readFileSync(f, 'utf8')) as CorpusRow[]).filter((r) => r.src === 'tatoeba' && re.test(r.text));
    out.push(...rows.slice(0, 22).map((r) => r.text));
  }
  return out;
}

async function main() {
  setAcousticCalibration(null);
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
  const vm = JSON.parse(await (await fetch(`https://huggingface.co/${MODELS.phoneme.id}/resolve/main/vocab.json`)).text()) as Record<string, number>;
  const vocab: string[] = [];
  for (const [k, v] of Object.entries(vm)) vocab[v] = k;
  const proc = await AutoProcessor.from_pretrained(MODELS.phoneme.id);
  const model = await AutoModelForCTC.from_pretrained(MODELS.phoneme.id, { dtype: 'q4' });
  const gb: number[] = [], us: number[] = [];
  const texts = sentences();
  for (const [i, text] of texts.entries()) {
    for (const [voice, bucket] of [[GB[i % 2], gb], [US[i % 2], us]] as const) {
      // British: our RP phonemes (non-rhotic). American: Kokoro's en-US front end (rhotic).
      const a = voice.startsWith('b')
        ? await tts.generate_from_ids(tts.tokenizer(await kokoroPhonemes(text), { truncation: true }).input_ids, { voice: voice as 'bf_emma' })
        : await tts.generate(text, { voice: voice as 'bf_emma' });
      const x = resample(a.audio as Float32Array, a.sampling_rate, 16000);
      const inputs = await proc(x);
      const { logits } = (await model(inputs)) as { logits: Tensor };
      const [, T, V] = logits.dims as number[];
      const produced = ctcGreedy(logits.data as Float32Array, T, V, vocab);
      const target = await targetFromText(text);
      const pairs = alignSequences(target.flatMap((w) => w.phones), produced);
      const m = measureRhoticity(x, 16000, target, pairs);
      bucket.push(...m.map((r) => rhoticScore(r)));
      console.log(`${voice.padEnd(10)} ${m.map((r) => `${target[r.word].text}:${r.ratio.toFixed(2)}/${r.fall.toFixed(2)}`).join(' ')}`);
    }
  }
  // Two operating points, chosen to keep false alarms on RP speech low:
  //   soft      = most sensitive point with <= 10 % false alarms (amber, possible /r/)
  //   threshold = most sensitive point with <= 6 % false alarms (crimson, /r/ heard)
  const stats = (thr: number) => {
    const fa = gb.filter((v) => v < thr).length / gb.length;
    const tpr = us.filter((v) => v < thr).length / us.length;
    return { fa, tpr, bacc: (1 - fa + tpr) / 2 };
  };
  let soft = { thr: 0.6, tpr: 0 }, hard = { thr: 0.6, tpr: 0 };
  for (let thr = 0.5; thr <= 1.0; thr += 0.005) {
    const s = stats(thr);
    if (s.fa <= 0.10 && s.tpr >= soft.tpr) soft = { thr, tpr: s.tpr };
    if (s.fa <= 0.06 && s.tpr >= hard.tpr) hard = { thr, tpr: s.tpr };
  }
  const best = { thr: +hard.thr.toFixed(3), bacc: stats(soft.thr).bacc };
  const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const rhotic = {
    threshold: best.thr, soft: +soft.thr.toFixed(3), balancedAccuracy: +best.bacc.toFixed(3),
    hardDetectionRate: +stats(best.thr).tpr.toFixed(3), hardFalseAlarmRate: +stats(best.thr).fa.toFixed(3), nonRhoticMedian: +med(gb).toFixed(3), rhoticMedian: +med(us).toFixed(3),
    nNonRhotic: gb.length, nRhotic: us.length,
    falseAlarmRate: +stats(soft.thr).fa.toFixed(3),
    softDetectionRate: +stats(soft.thr).tpr.toFixed(3),
    reference: `${GB.join('/')} vs ${US.join('/')} (Kokoro-82M), ${texts.length} sentences`,
  };
  const f = join(ROOT, 'public/data/acoustic_calibration.json');
  const doc = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  writeFileSync(f, JSON.stringify({ ...doc, rhotic }, null, 1) + '\n');
  console.log(rhotic);
}

void main();
