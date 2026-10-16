/**
 * Stream D (phonetic diff): weighted Needleman–Wunsch alignment between the
 * Target Modern RP IPA (Stream C) and the speaker's produced IPA (Stream B),
 * followed by articulatory diagnosis and the schwa-reduction check.
 */
import { substitutionCost, isVowel, isRpPhoneme, REDUCED_VOWELS } from '../lib/ipa';
import type { TargetPhone, TargetWord } from '../lib/connectedSpeech';

export interface ProducedPhone {
  p: string;
  /** seconds from start of the utterance */
  start?: number;
  end?: number;
}

export type PairKind = 'match' | 'drift' | 'error';

export type Diagnosis =
  | 'RETROFLEX' | 'DENTAL_STOP' | 'TH_STOPPING' | 'VW_MERGER' | 'GOAT_MONOPHTHONG' | 'GOAT_BACKED'
  | 'FACE_MONOPHTHONG' | 'TRAP_BATH' | 'LOT_THOUGHT' | 'RHOTIC' | 'TAP_R' | 'MISSED_SCHWA'
  | 'MISSED_LINKING_R' | 'VOWEL_LENGTH' | 'ELISION' | 'DELETION' | 'INSERTION' | 'SUBSTITUTION' | 'DRIFT';

export interface AlignedPair {
  target?: TargetPhone;
  produced?: ProducedPhone;
  kind: PairKind;
  cost: number;
  diagnosis?: Diagnosis;
  /** index of the target word this pair belongs to */
  word: number;
}

export interface WordAlignment {
  index: number;
  text: string;
  targetIpa: string;
  producedIpa: string;
  pairs: AlignedPair[];
  status: PairKind;
  start?: number;
  end?: number;
}

export interface AlignmentResult {
  pairs: AlignedPair[];
  words: WordAlignment[];
  /** plain phoneme error rate (S + D + I) / N */
  per: number;
  /** articulatory-cost-weighted PER, counts only crimson/amber cost */
  weightedPer: number;
  schwa: { expected: number; reduced: number; missedWords: number[] };
  diagnoses: Partial<Record<Diagnosis, number>>;
}

/** Diagnoses that are always crimson (phoneme-level interference habits). */
const CRIMSON: ReadonlySet<Diagnosis> = new Set<Diagnosis>([
  'RETROFLEX', 'TH_STOPPING', 'VW_MERGER', 'GOAT_MONOPHTHONG', 'FACE_MONOPHTHONG', 'TRAP_BATH',
  'LOT_THOUGHT', 'RHOTIC', 'VOWEL_LENGTH', 'DELETION', 'SUBSTITUTION',
]);

const DRIFT_THRESHOLD = 0.35;
const GAP_INSERT = 0.7;

function deletionCost(t: TargetPhone): number {
  if (t.linking) return 0.3;
  if (t.weak || t.p === 'ə') return 0.45;
  if (t.glottalOk) return 0.5;
  return isVowel(t.p) ? 0.9 : 0.8;
}

/**
 * Licensed vowel variation:
 *  - weak-form vowels are fine reduced, or as tense [i u] before vowels ("the apple", "to us");
 *  - unstressed /ɪ/ and /ə/ alternate freely in RP (weak-vowel merger: "tangible" -ɪ-/-ə-);
 *  - happY / pre-vocalic unstressed /ɪ/ is tense [i] in modern RP ("city", "caveat").
 */
function weakOk(t: TargetPhone, p: string): boolean {
  const unstressedWeak = t.stress === 0 && (t.p === 'ə' || t.p === 'ɪ');
  if ((t.weak || unstressedWeak) && REDUCED_VOWELS.has(p)) return true;
  if (t.p === 'ɪ' && p === 'iː' && (t.weak || t.tenseOk)) return true;
  return t.weak === true && t.p === 'ʊ' && p === 'uː';
}

/** Cost used inside the DP: substitution cost with RP allophonic licences. */
function pairCost(t: TargetPhone, p: string): number {
  if (t.p === p) return 0;
  if (t.glottalOk && p === 'ʔ') return 0.02;
  if (weakOk(t, p)) return 0.04;
  return substitutionCost(t.p, p);
}

export function diagnose(t: TargetPhone, p: string): Diagnosis | undefined {
  const tp = t.p;
  if ((tp === 't' && p === 'ʈ') || (tp === 'd' && p === 'ɖ') || (tp === 'n' && p === 'ɳ') || (tp === 'l' && p === 'ɭ') || (tp === 's' && p === 'ʂ')) return 'RETROFLEX';
  if ((tp === 't' && p === 't̪') || (tp === 'd' && p === 'd̪')) return 'DENTAL_STOP';
  if ((tp === 'θ' && (p === 't' || p === 't̪' || p === 'ʈ')) || (tp === 'ð' && (p === 'd' || p === 'd̪' || p === 'ɖ'))) return 'TH_STOPPING';
  if ((tp === 'v' && (p === 'w' || p === 'ʋ' || p === 'β')) || (tp === 'w' && (p === 'v' || p === 'ʋ' || p === 'β'))) return 'VW_MERGER';
  if (tp === 'əʊ' && (p === 'oː' || p === 'ɔ' || p === 'ɔː' || p === 'ɒ')) return 'GOAT_MONOPHTHONG';
  if (tp === 'əʊ' && p === 'oʊ') return 'GOAT_BACKED';
  if (tp === 'eɪ' && (p === 'eː' || p === 'e')) return 'FACE_MONOPHTHONG';
  if (tp === 'ɑː' && (p === 'æ' || p === 'a')) return 'TRAP_BATH';
  if ((tp === 'ɒ' && (p === 'ɔ' || p === 'ɔː' || p === 'ɑ' || p === 'ɑː' || p === 'a' || p === 'oː')) || (tp === 'ɔː' && (p === 'ɒ' || p === 'ɔ' || p === 'oː'))) return 'LOT_THOUGHT';
  if (tp === 'r' && (p === 'ɾ' || p === 'ɻ' || p === 'ɽ')) return 'TAP_R';
  if (t.weak && isVowel(p) && !weakOk(t, p)) return 'MISSED_SCHWA';
  if ((tp === 'iː' && p === 'ɪ') || (tp === 'ɪ' && p === 'iː') || (tp === 'uː' && p === 'ʊ') || (tp === 'ʊ' && p === 'uː')) return 'VOWEL_LENGTH';
  return undefined;
}

function classify(t: TargetPhone, p: string, cost: number): { kind: PairKind; diagnosis?: Diagnosis } {
  if (t.p === p || (t.glottalOk && p === 'ʔ') || weakOk(t, p)) return { kind: 'match' };
  const d = diagnose(t, p);
  if (d === 'MISSED_SCHWA') return { kind: 'drift', diagnosis: d };
  if (d && CRIMSON.has(d)) return { kind: 'error', diagnosis: d };
  if (d) return { kind: 'drift', diagnosis: d };
  // A different RP phoneme is a phonemic substitution; a non-RP near neighbour is allophonic drift.
  if (isRpPhoneme(p) && isRpPhoneme(t.p)) return { kind: 'error', diagnosis: 'SUBSTITUTION' };
  if (cost <= DRIFT_THRESHOLD) return { kind: 'drift', diagnosis: 'DRIFT' };
  return { kind: 'error', diagnosis: 'SUBSTITUTION' };
}

/** Weighted global alignment (minimum total cost). */
export function alignSequences(target: TargetPhone[], produced: ProducedPhone[]): AlignedPair[] {
  const n = target.length, m = produced.length;
  const W = m + 1;
  const D = new Float64Array((n + 1) * W);
  const B = new Uint8Array((n + 1) * W); // 0 diag, 1 up (deletion), 2 left (insertion)
  for (let i = 1; i <= n; i++) { D[i * W] = D[(i - 1) * W] + deletionCost(target[i - 1]); B[i * W] = 1; }
  for (let j = 1; j <= m; j++) { D[j] = D[j - 1] + GAP_INSERT; B[j] = 2; }
  for (let i = 1; i <= n; i++) {
    const t = target[i - 1];
    const dc = deletionCost(t);
    for (let j = 1; j <= m; j++) {
      const diag = D[(i - 1) * W + j - 1] + pairCost(t, produced[j - 1].p);
      const up = D[(i - 1) * W + j] + dc;
      const left = D[i * W + j - 1] + GAP_INSERT;
      let best = diag, b = 0;
      if (up < best) { best = up; b = 1; }
      if (left < best) { best = left; b = 2; }
      D[i * W + j] = best;
      B[i * W + j] = b;
    }
  }
  const out: AlignedPair[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const b = i === 0 ? 2 : j === 0 ? 1 : B[i * W + j];
    if (b === 0) {
      const t = target[i - 1], p = produced[j - 1];
      const cost = pairCost(t, p.p);
      out.push({ target: t, produced: p, cost, word: t.word, ...classify(t, p.p, cost) });
      i--; j--;
    } else if (b === 1) {
      const t = target[i - 1];
      const elidable = t.linking || t.weak || t.p === 'ə' || t.glottalOk;
      out.push({
        target: t, cost: deletionCost(t), word: t.word,
        kind: elidable ? 'drift' : 'error',
        diagnosis: t.linking ? 'MISSED_LINKING_R' : elidable ? 'ELISION' : 'DELETION',
      });
      i--;
    } else {
      out.push({ produced: produced[j - 1], cost: GAP_INSERT, word: -1, kind: 'drift', diagnosis: 'INSERTION' });
      j--;
    }
  }
  out.reverse();
  resolveInsertions(out);
  return out;
}

/**
 * Attach insertions to a word and detect rhoticity: an /r/ produced after a
 * vowel where RP has none (before a consonant or a pause) is the non-rhotic
 * error the curriculum targets.
 */
function resolveInsertions(pairs: AlignedPair[]): void {
  for (let k = 0; k < pairs.length; k++) {
    const pr = pairs[k];
    if (pr.target) continue;
    let prevT: AlignedPair | undefined, nextT: AlignedPair | undefined;
    for (let a = k - 1; a >= 0; a--) if (pairs[a].target) { prevT = pairs[a]; break; }
    for (let a = k + 1; a < pairs.length; a++) if (pairs[a].target) { nextT = pairs[a]; break; }
    pr.word = prevT ? prevT.word : nextT ? nextT.word : 0;
    const p = pr.produced!.p;
    const prevIsVowel = !!prevT?.target && isVowel(prevT.target.p);
    const nextIsVowelSameWord = !!nextT?.target && isVowel(nextT.target.p) && nextT.word === prevT?.word;
    if ((p === 'r' || p === 'ɾ' || p === 'ɻ') && prevIsVowel && !nextIsVowelSameWord) {
      // A produced /r/ before a vowel-initial next word is an (intrusive/linking) r, not rhoticity.
      const nextWordStartsWithVowel = !!nextT?.target && nextT.word !== prevT?.word && isVowel(nextT.target.p);
      if (!nextWordStartsWithVowel) { pr.kind = 'error'; pr.diagnosis = 'RHOTIC'; pr.cost = 0.9; }
    }
  }
}

function joinIpa(ps: (string | undefined)[]): string {
  return ps.filter(Boolean).join('');
}

export function alignToTarget(words: TargetWord[], produced: ProducedPhone[]): AlignmentResult {
  const target = words.flatMap((w) => w.phones);
  const pairs = alignSequences(target, produced);

  const wordAligns: WordAlignment[] = words.map((w, index) => ({
    index, text: w.text, targetIpa: w.ipa, producedIpa: '', pairs: [], status: 'match' as PairKind,
  }));
  for (const pr of pairs) {
    const wa = wordAligns[pr.word];
    if (!wa) continue;
    wa.pairs.push(pr);
  }
  const diagnoses: Partial<Record<Diagnosis, number>> = {};
  let S = 0, Dl = 0, I = 0, weighted = 0;
  for (const pr of pairs) {
    if (pr.diagnosis) diagnoses[pr.diagnosis] = (diagnoses[pr.diagnosis] ?? 0) + 1;
    if (pr.kind === 'match') continue;
    if (!pr.produced) Dl++; else if (!pr.target) I++; else S++;
    weighted += pr.kind === 'error' ? Math.max(pr.cost, 0.6) : Math.min(pr.cost, 0.35) * 0.6;
  }
  for (const wa of wordAligns) {
    wa.producedIpa = joinIpa(wa.pairs.map((p) => p.produced?.p));
    wa.status = wa.pairs.some((p) => p.kind === 'error') ? 'error' : wa.pairs.some((p) => p.kind === 'drift') ? 'drift' : 'match';
    const times = wa.pairs.map((p) => p.produced).filter((p): p is ProducedPhone => !!p && p.start !== undefined);
    if (times.length) { wa.start = times[0].start; wa.end = times[times.length - 1].end; }
  }

  // Schwa-crushing check on weak-form function words.
  let expected = 0, reduced = 0;
  const missedWords: number[] = [];
  words.forEach((w, idx) => {
    if (!w.weakApplied) return;
    const vowelPairs = wordAligns[idx].pairs.filter((p) => p.target?.weak);
    if (!vowelPairs.length) return;
    expected++;
    const ok = vowelPairs.every((p) => !p.produced || weakOk(p.target!, p.produced.p));
    if (ok) reduced++; else missedWords.push(idx);
  });

  const N = Math.max(1, target.length);
  return {
    pairs,
    words: wordAligns,
    per: (S + Dl + I) / N,
    weightedPer: Math.min(1, weighted / N),
    schwa: { expected, reduced, missedWords },
    diagnoses,
  };
}
