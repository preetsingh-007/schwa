/**
 * Acoustic rhoticity check. The phoneme model emits r-coloured units ("ɑːɹ",
 * "ɚ") for RP speakers too, so labels can't tell "car" [kɑː] from [kɑɹ].
 * Instead we measure the vowel itself: a pronounced post-vocalic /r/ lowers
 * F3 towards ~1.6–2 kHz, a non-rhotic RP vowel keeps it near the speaker's
 * baseline. The decision threshold is calibrated on British vs American
 * renderings of the same sentences (scripts/calibrate-rhotic.ts).
 */
import { isVowel } from './ipa';
import { baselineF3, f3Fall, rhoticRatio } from './formants';
import type { TargetWord } from './connectedSpeech';
import type { AlignedPair } from '../services/ipaAligner';

const R_VOWELS = new Set(['ɑː', 'ɔː', 'ɜː', 'ə', 'ɪə', 'eə', 'ʊə']);

export interface RhoticOpportunity { word: number; pair: number; t0: number; t1: number }

/** Vowels where the spelling has an r but RP pronounces none (before a consonant or a pause). */
export function rhoticOpportunities(words: TargetWord[], pairs: AlignedPair[]): RhoticOpportunity[] {
  const out: RhoticOpportunity[] = [];
  pairs.forEach((pr, k) => {
    const t = pr.target;
    if (!t || !pr.produced || pr.produced.start === undefined || !R_VOWELS.has(t.p) || t.weak) return;
    const w = words[t.word];
    if (!w || !/[aeiouy]r(?![aeiouy])|re$|res$|red$/i.test(w.text)) return;
    // the next target phone must not be a vowel or a (linking) /r/
    const nextT = pairs.slice(k + 1).find((q) => q.target)?.target;
    if (nextT && (isVowel(nextT.p) || nextT.p === 'r')) return;
    // only the last such vowel in the word (the one the spelled r follows)
    const laterSame = pairs.slice(k + 1).some((q) => q.target && q.target.word === t.word && R_VOWELS.has(q.target.p));
    if (laterSame) return;
    // span: from the vowel onset to the next produced phone that is not an /r/ (or +150 ms)
    const t0 = pr.produced.start;
    const nextP = pairs.slice(k + 1).find((q) => q.produced && q.produced.start !== undefined && !/^(r|ɾ|ɻ)$/.test(q.produced.p))?.produced;
    const t1 = Math.min(t0 + 0.3, Math.max(t0 + 0.08, nextP?.start ?? t0 + 0.15));
    out.push({ word: t.word, pair: k, t0, t1 });
  });
  return out;
}

/**
 * Speaker F3 baseline from vowels away from any /r/: front vowels preferred
 * (F3 is most stable there), falling back to any other vowel.
 */
export function speakerBaselineF3(audio: Float32Array, sr: number, pairs: AlignedPair[], exclude: Set<number> = new Set()): number {
  const front: [number, number][] = [], other: [number, number][] = [];
  pairs.forEach((pr, k) => {
    const p = pr.produced;
    if (!pr.target || !p || p.start === undefined || !isVowel(pr.target.p) || exclude.has(k)) return;
    const near = pairs.slice(Math.max(0, k - 1), k + 2).some((q) => q.produced && /^(r|ɾ|ɻ)$/.test(q.produced.p));
    if (near) return;
    (['iː', 'ɪ', 'e', 'æ', 'eɪ', 'aɪ'].includes(pr.target.p) ? front : other).push([p.start, p.start + 0.07]);
  });
  const spans = front.length >= 3 ? front : [...front, ...other];
  return spans.length >= 2 ? baselineF3(audio, sr, spans) : 0;
}

export interface RhoticMeasure extends RhoticOpportunity {
  /** lowest late-vowel F3 ÷ speaker baseline */
  ratio: number;
  /** late-vowel F3 ÷ vowel-onset F3 (the within-vowel fall) */
  fall: number;
}

export function measureRhoticity(audio: Float32Array, sr: number, words: TargetWord[], pairs: AlignedPair[]): RhoticMeasure[] {
  const opps = rhoticOpportunities(words, pairs);
  const base = speakerBaselineF3(audio, sr, pairs, new Set(opps.map((o) => o.pair)));
  if (!base) return [];
  const out: RhoticMeasure[] = [];
  for (const o of opps) {
    const ratio = rhoticRatio(audio, sr, o.t0, o.t1, base);
    const f = f3Fall(audio, sr, o.t0, o.t1);
    if (ratio !== null && f) out.push({ ...o, ratio, fall: f.tail / f.onset });
  }
  return out;
}

/** Combined rhoticity score (lower = more r-coloured): mean of the two F3 ratios. */
export function rhoticScore(m: Pick<RhoticMeasure, 'ratio' | 'fall'>): number {
  return (m.ratio + m.fall) / 2;
}
