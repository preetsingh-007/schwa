/**
 * Acoustic-model calibration against British reference speech.
 *
 * The wav2vec2 espeak phoneme model was fine-tuned on Common Voice with labels
 * produced by espeak *from the transcript* (en-US for English), so part of its
 * output reflects the dictionary rather than the acoustics: an RP speaker's
 * "car" comes out as [kɑːɹ], "go" as [ɡoʊ]. To avoid penalising genuine RP we
 * synthesise British speech with Kokoro's en-GB voices — driven by our own
 * RP target phonemes (en-GB-x-rp, weak forms), so the reference really is
 * RP — decode it with the
 * exact Stream B pipeline, align it against the espeak RP target, and record
 * how often each (target → produced) deviation occurs for *native-like* input.
 * Deviations that RP reference speech triggers routinely are "model-equivalent"
 * and are not counted as learner errors at runtime.
 *
 * Usage: npx vite-node scripts/calibrate-acoustic.ts [--limit N]
 * Writes public/data/acoustic_calibration.json (and a raw dump for inspection).
 *
 * With --isolated it measures the sound-ladder word lists and minimal pairs
 * instead (words said one at a time read differently: an RP /ɔː/ comes out as
 * [oː]) and merges only { isolated: {...} } into the file, leaving the sentence
 * rates untouched. Run after build-ladders.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { KokoroTTS } from 'kokoro-js';
import { kokoroPhonemes } from '../src/lib/g2p';
import { AutoModelForCTC, AutoProcessor, env, type Tensor } from '@huggingface/transformers';
import { targetFromText } from '../src/lib/g2p';
import { ctcGreedy } from '../src/lib/ctc';
import { resample, chunkBoundaries } from '../src/lib/audioUtils';
import { alignSequences, setAcousticCalibration } from '../src/services/ipaAligner';
import { MODELS } from '../src/workers/protocol';
import { normalizeWord } from '../src/lib/connectedSpeech';
import { ladderPrompt, type Ladders } from '../src/services/ladders';
import type { Prompt, VocabEntry } from '../src/types';

if (process.env.HF_CACHE_DIR) env.cacheDir = process.env.HF_CACHE_DIR;
const ROOT = process.cwd();
const ISOLATED = process.argv.includes('--isolated');
const RAW = process.env.CAL_RAW ?? join(ROOT, 'node_modules', '.cache', `lexiphon-calibration-raw${ISOLATED ? '-isolated' : ''}.json`);
const VOICES = ['bf_emma', 'bm_george', 'bm_fable', 'bf_isabella'];
const limit = Number(process.argv[process.argv.indexOf('--limit') + 1]) || Infinity;
const OUT = join(ROOT, 'public/data/acoustic_calibration.json');
/**
 * Contrasts the ladders teach, never accepted from the isolated-word run even when
 * RP voices trigger them: hiding /θ/→[s] or /ɪ/→[iː] would make those drills pointless.
 * A correct speaker sometimes loses one; the ladder's two-in-three rule absorbs it.
 */
const JUDGED: Record<string, string[]> = {
  θ: ['s', 't', 'f'], ð: ['d', 'z', 'v'], ɪ: ['iː'], iː: ['ɪ'], ʊ: ['uː'], uː: ['ʊ'],
  ʃ: ['s'], s: ['ʃ'], ʒ: ['dʒ', 'z'], v: ['w'], w: ['v'], æ: ['e'], e: ['æ'],
};

interface RawPair { t?: string; p?: string; tok?: string; weak?: string; prev?: string; next?: string }
interface RawUtt { text: string; voice: string; pairs: RawPair[] }

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Every word list and minimal-pair list the sound ladders can show. */
function isolatedTexts(): string[] {
  const ladders = (JSON.parse(readFileSync(join(ROOT, 'public/data/ladders.json'), 'utf8')) as { phonemes: Ladders }).phonemes;
  const out: string[] = [];
  for (const [ph, set] of Object.entries(ladders)) {
    for (let seed = 0; seed < 4; seed++) out.push(ladderPrompt(ph, set, 1, seed).text);
    for (let seed = 0; seed < 3; seed++) out.push(ladderPrompt(ph, set, 2, seed).text);
  }
  return Array.from(new Set(out));
}

function texts(): string[] {
  const prompts = JSON.parse(readFileSync(join(ROOT, 'public/data/prompts_tiered.json'), 'utf8')) as Prompt[];
  const vocab = JSON.parse(readFileSync(join(ROOT, 'public/data/vocab_curriculum.json'), 'utf8')) as VocabEntry[];
  const out = prompts.filter((p) => p.tier === 1).map((p) => p.text);
  out.push(...prompts.filter((p) => p.tier === 2).map((p) => p.reference!));
  out.push(...vocab.flatMap((v) => v.examples_rp.map((e) => e.text)));
  const r = rng(11);
  for (let L = 1; L <= 8; L++) {
    const f = join(ROOT, `public/corpus/level-${String(L).padStart(2, '0')}.json`);
    if (!existsSync(f)) continue;
    const rows = (JSON.parse(readFileSync(f, 'utf8')) as { text: string; src: string }[]).filter((x) => x.src === 'tatoeba');
    for (let k = 0; k < 15; k++) out.push(rows[Math.floor(r() * rows.length)].text);
  }
  return Array.from(new Set(out));
}

async function collect(): Promise<RawUtt[]> {
  const prev: RawUtt[] = existsSync(RAW) ? JSON.parse(readFileSync(RAW, 'utf8')) : [];
  const done = new Set(prev.map((u) => `${u.voice}|${u.text}`));
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
  const vocabMap = JSON.parse(await (await fetch(`https://huggingface.co/${MODELS.phoneme.id}/resolve/main/vocab.json`)).text()) as Record<string, number>;
  const vocab: string[] = [];
  for (const [k, v] of Object.entries(vocabMap)) vocab[v] = k;
  const proc = await AutoProcessor.from_pretrained(MODELS.phoneme.id);
  const model = await AutoModelForCTC.from_pretrained(MODELS.phoneme.id, { dtype: 'q4' });
  const all = ISOLATED ? isolatedTexts().slice(0, limit) : texts().slice(0, Math.min(limit, 260));
  const out = [...prev];
  let i = 0;
  for (const text of all) {
    // Every text with two voices (one for the short isolated lists), rotating through the four best British voices.
    for (const voice of ISOLATED ? [VOICES[i % 4]] : [VOICES[i % 4], VOICES[(i + 1) % 4]]) {
      if (done.has(`${voice}|${text}`)) continue;
      const a = await tts.generate_from_ids(tts.tokenizer(await kokoroPhonemes(text), { truncation: true }).input_ids, { voice: voice as 'bf_emma' });
      const x = resample(a.audio as Float32Array, a.sampling_rate, 16000);
      const bounds = chunkBoundaries(x);
      const produced = [];
      for (let c = 0; c + 1 < bounds.length; c++) {
        const inputs = await proc(x.subarray(bounds[c], bounds[c + 1]));
        const { logits } = (await model(inputs)) as { logits: Tensor };
        const [, T, V] = logits.dims as number[];
        produced.push(...ctcGreedy(logits.data as Float32Array, T, V, vocab, bounds[c] / 16000));
      }
      const target = await targetFromText(text);
      const flat = target.flatMap((w) => w.phones);
      const pairs = alignSequences(flat, produced).map((pr, k, arr) => {
        const prevT = [...arr.slice(0, k)].reverse().find((q) => q.target)?.target?.p;
        const nextT = arr.slice(k + 1).find((q) => q.target)?.target?.p;
        return {
          t: pr.target?.p, p: pr.produced?.p, tok: pr.produced?.tok,
          weak: pr.target?.weak ? normalizeWord(target[pr.target.word].text) : undefined,
          prev: pr.target ? undefined : prevT, next: pr.target ? undefined : nextT,
        };
      });
      out.push({ text, voice, pairs });
      writeFileSync(RAW, JSON.stringify(out));
      console.log(`[${out.length}] ${voice} ${text.slice(0, 60)}`);
    }
    i++;
  }
  return out;
}

function summarise(utts: RawUtt[]) {
  const sub: Record<string, Record<string, number>> = {};
  const tot: Record<string, number> = {};
  const ins: Record<string, Record<string, number>> = {};
  const insOpp: Record<string, number> = {};
  const weak: Record<string, Record<string, number>> = {};
  const weakTot: Record<string, number> = {};
  for (const u of utts) {
    for (const pr of u.pairs) {
      if (pr.t) {
        tot[pr.t] = (tot[pr.t] ?? 0) + 1;
        if (pr.prev === undefined) insOpp[pr.t] = (insOpp[pr.t] ?? 0) + 1;
        const key = pr.p ?? '∅';
        if (key !== pr.t) (sub[pr.t] ??= {})[key] = ((sub[pr.t] ??= {})[key] ?? 0) + 1;
        if (pr.weak) {
          const wk = `${pr.weak}`;
          weakTot[wk] = (weakTot[wk] ?? 0) + 1;
          (weak[wk] ??= {})[key] = ((weak[wk] ??= {})[key] ?? 0) + 1;
        }
      } else if (pr.p && pr.prev) {
        const k = pr.prev;
        const v = `${pr.p}${pr.tok && pr.tok.length > 1 && pr.tok !== pr.p ? `@${pr.tok}` : ''}`;
        (ins[k] ??= {})[v] = ((ins[k] ??= {})[v] ?? 0) + 1;
      }
    }
  }
  const MIN = 0.12;
  const rate = (m: Record<string, number>, n: number) =>
    Object.fromEntries(Object.entries(m).map(([k, c]) => [k, +(c / n).toFixed(3)]).filter(([, r]) => (r as number) >= MIN).sort((a, b) => (b[1] as number) - (a[1] as number)));
  const accept: Record<string, Record<string, number>> = {};
  for (const [t, m] of Object.entries(sub)) { const r = rate(m, tot[t]); if (Object.keys(r).length && tot[t] >= 8) accept[t] = r; }
  const insertions: Record<string, Record<string, number>> = {};
  for (const [t, m] of Object.entries(ins)) { const r = rate(m, insOpp[t] ?? 1); if (Object.keys(r).length && (insOpp[t] ?? 0) >= 8) insertions[t] = r; }
  const weakForms: Record<string, Record<string, number>> = {};
  for (const [w, m] of Object.entries(weak)) { const r = rate(m, weakTot[w]); if (Object.keys(r).length && weakTot[w] >= 4) weakForms[w] = r; }
  return { accept, insertions, weakForms, counts: tot };
}

function withoutJudged(accept: Record<string, Record<string, number>>) {
  const out: Record<string, Record<string, number>> = {};
  for (const [t, m] of Object.entries(accept)) {
    const kept = Object.fromEntries(Object.entries(m).filter(([p]) => !JUDGED[t]?.includes(p)));
    if (Object.keys(kept).length) out[t] = kept;
  }
  return out;
}

async function main() {
  mkdirSync(join(ROOT, 'node_modules', '.cache'), { recursive: true });
  setAcousticCalibration(null); // measure the raw, uncalibrated behaviour
  const utts = await collect();
  const s = summarise(utts);
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, unknown> : {};
  const doc = ISOLATED
    ? { ...prev, isolated: { utterances: utts.length, accept: withoutJudged(s.accept), insertions: s.insertions } }
    : {
      version: 1,
      generatedAt: new Date().toISOString().slice(0, 10),
      reference: `Kokoro-82M en-GB voices (${VOICES.join(', ')}) decoded by ${MODELS.phoneme.id}`,
      utterances: utts.length,
      minRate: 0.12,
      ...s,
      // measured by calibrate-rhotic and the --isolated run; keep them
      ...(prev.rhotic ? { rhotic: prev.rhotic } : {}),
      ...(prev.isolated ? { isolated: prev.isolated } : {}),
    };
  // non-ASCII escaped, as the file has always been written
  writeFileSync(OUT, JSON.stringify(doc, null, 1).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n');
  console.log(JSON.stringify({ accept: s.accept, insertions: s.insertions, ...(ISOLATED ? {} : { weakForms: s.weakForms }) }, null, 1));
}

void main();
