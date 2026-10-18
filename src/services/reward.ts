/**
 * Composite reward R(u) = w1·S_phonetic + w2·S_prosody + w3·S_lexical ∈ [0, 100]
 * and the advancement gate (R ≥ 80 and no critical redundancy left).
 */
import type { AlignmentResult } from './ipaAligner';
import { compareProsody, type ProsodyComparison, type ProsodyMetrics } from '../lib/prosody';
import type { ConcisenessReport } from './redundancy';
import type { Tier } from '../types';

export const TIER_WEIGHTS: Record<Tier, [number, number, number]> = {
  1: [0.75, 0.25, 0.0],
  2: [0.4, 0.2, 0.4],
  3: [0.35, 0.3, 0.35],
};
/** Listen-and-repeat: pronunciation-led, with prosody judged against a real reference rendering. */
export const SHADOW_WEIGHTS: [number, number, number] = [0.6, 0.4, 0.0];
/** single words and word pairs: the sounds alone */
export const PHONETIC_WEIGHTS: [number, number, number] = [1, 0, 0];
export const PASS_THRESHOLD = 80;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function phoneticScore(a: AlignmentResult): number {
  return 100 * clamp01(1 - 2.0 * a.weightedPer);
}

export interface ProsodyBreakdown {
  schwa: number | null;
  rhythm: number;
  fluency: number;
  intonation: number;
  score: number;
  /** present when a reference rendering was available */
  reference?: ProsodyComparison;
}

/** r_fluency: inverse mid-clause pause ratio with filler penalty. */
export function fluencyScore(p: ProsodyMetrics, fillers: number): number {
  return clamp01(1 - 2 * p.pauseRatio - 0.12 * p.longPauses.length - 0.1 * fillers);
}

/** Map vocalic nPVI onto [0,1]: ≤ 35 syllable-timed → 0, ≥ 57 stress-timed → 1. */
export function rhythmScore(npvi: number, syllables: number): number {
  if (syllables < 4) return 0.7; // too short to judge: neutral
  return clamp01((npvi - 35) / 22);
}

export function prosodyScore(p: ProsodyMetrics, schwaRate: number | null, fillers: number, ref?: ProsodyMetrics | null): ProsodyBreakdown {
  let rhythm = rhythmScore(p.npvi, p.syllables);
  let fluency = fluencyScore(p, fillers);
  // Monotone (< 3 st range) or a rising final on statements scores lower.
  let intonation = p.contour.length < 10 ? 0.7 : clamp01((p.f0RangeSt - 2) / 5) * (p.finalSlopeSt <= 2 ? 1 : 0.7);
  let reference: ProsodyComparison | undefined;
  if (ref && ref.contour.length >= 5) {
    // A real RP rendering of the same words replaces the generic heuristics.
    reference = compareProsody(p, ref);
    intonation = reference.intonation;
    rhythm = 0.4 * rhythm + 0.6 * reference.rhythm;
    fluency = fluency * (0.6 + 0.4 * reference.tempo);
  }
  const parts: [number | null, number][] = [[schwaRate, 0.35], [rhythm, 0.25], [fluency, 0.25], [intonation, 0.15]];
  const usable = parts.filter(([v]) => v !== null) as [number, number][];
  const wsum = usable.reduce((s, [, w]) => s + w, 0);
  const score = 100 * usable.reduce((s, [v, w]) => s + v * w, 0) / wsum;
  return { schwa: schwaRate, rhythm, fluency, intonation, score, reference };
}

export interface LexicalInputs {
  tier: Tier;
  concise: ConcisenessReport;
  targetVocab: string[];
  usedVocab: string[];
  /** words in the verbose source (Tier 2) */
  sourceWords?: number;
  /** cosine similarity to the reference meaning (MiniLM), if available */
  semantic?: number | null;
}

export interface LexicalBreakdown { vocab: number; concise: number; compression: number | null; semantic: number | null; score: number }

export function lexicalScore(x: LexicalInputs): LexicalBreakdown {
  const vocab = x.targetVocab.length ? x.usedVocab.filter((v) => x.targetVocab.includes(v)).length / x.targetVocab.length : 1;
  const concise = x.concise.score;
  let compression: number | null = null;
  if (x.tier === 2 && x.sourceWords) {
    const ratio = x.concise.wordCount / x.sourceWords;
    // ≤ 45 % of the source length is ideal; ≥ 100 % means nothing was compressed.
    compression = x.concise.wordCount < 3 ? 0 : clamp01((1 - ratio) / 0.55);
  }
  // Tier 2 compares with a paraphrase (high similarity expected); Tier 3 only checks the answer is on-topic.
  const [lo, span] = x.tier === 2 ? [0.35, 0.4] : [0.1, 0.35];
  const semantic = x.semantic === undefined || x.semantic === null ? null : clamp01((x.semantic - lo) / span);
  const parts: [number | null, number][] = x.tier === 2
    ? [[vocab, 0.35], [concise, 0.25], [compression, 0.2], [semantic, 0.2]]
    : [[vocab, 0.35], [concise, 0.4], [semantic, 0.25]];
  const usable = parts.filter(([v]) => v !== null) as [number, number][];
  const wsum = usable.reduce((s, [, w]) => s + w, 0);
  return { vocab, concise, compression, semantic, score: 100 * usable.reduce((s, [v, w]) => s + v * w, 0) / wsum };
}

export interface RewardResult {
  reward: number;
  weights: [number, number, number];
  phonetic: number | null;
  prosody: number;
  lexical: number;
  passed: boolean;
  blockers: string[];
}

export function compositeReward(o: {
  tier: Tier;
  phonetic: number | null;
  prosody: number;
  lexical: number;
  criticalRedundancies: number;
  /** Tier 1: share of the prompt's words that the ASR heard */
  wordCoverage?: number;
  /** override the tier weights (listen-and-repeat) */
  weights?: [number, number, number];
  /** blocker text when coverage fails (defaults to the read-aloud wording) */
  coverageMessage?: string;
}): RewardResult {
  let [w1, w2, w3] = o.weights ?? TIER_WEIGHTS[o.tier];
  if (o.phonetic === null) {
    // Stream B disabled (low-memory mode): renormalise over the remaining streams.
    const rest = w2 + w3;
    [w1, w2, w3] = rest > 0 ? [0, w2 / rest, w3 / rest] : [0, 1, 0];
  }
  const reward = w1 * (o.phonetic ?? 0) + w2 * o.prosody + w3 * o.lexical;
  const blockers: string[] = [];
  if (reward < PASS_THRESHOLD) blockers.push(`Reward ${reward.toFixed(0)} < ${PASS_THRESHOLD}`);
  if (o.tier !== 1 && o.criticalRedundancies > 0) blockers.push(`${o.criticalRedundancies} critical redundanc${o.criticalRedundancies === 1 ? 'y' : 'ies'} still present`);
  if (o.tier === 1 && o.wordCoverage !== undefined && o.wordCoverage < 0.7) blockers.push(o.coverageMessage ?? 'Read the whole prompt — some words were not heard');
  return { reward, weights: [w1, w2, w3], phonetic: o.phonetic, prosody: o.prosody, lexical: o.lexical, passed: blockers.length === 0, blockers };
}
