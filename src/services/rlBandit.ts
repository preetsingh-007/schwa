/**
 * Reinforcement-learning core: the user state vector S_t (44 × K phoneme
 * confusion matrix, prosody/conciseness vector V_R, interference-habit rates)
 * and the contextual-bandit next-prompt scheduler.
 */
import { RP_PHONEMES, PHONEME_INDEX, CONFUSION_COLUMNS, COLUMN_INDEX, DELETION, OTHER, isVowel } from '../lib/ipa';
import type { AlignedPair, AlignmentResult, Diagnosis } from './ipaAligner';
import type { LearnerState, Prompt, PromptStat, VocabCard, Ewma, Tier, ConfusionState } from '../types';
import { recallProbability } from './fsrs';

export const ALPHA = 0.15;
const K = CONFUSION_COLUMNS.length;
const OTHER_COL = COLUMN_INDEX.get(OTHER)!;
const DEL_COL = COLUMN_INDEX.get(DELETION)!;

/** Prior: half the mass on the diagonal, half "not yet observed". */
function priorRow(i: number): number[] {
  const r = new Array<number>(K).fill(0);
  r[i] = 0.5;
  r[OTHER_COL] = 0.5;
  return r;
}

export function initialConfusion(now = Date.now()): ConfusionState {
  return {
    rows: RP_PHONEMES.map((_, i) => priorRow(i)),
    counts: RP_PHONEMES.map(() => 0),
    pending: RP_PHONEMES.map(() => 0),
    updatedAt: RP_PHONEMES.map(() => now),
  };
}

const ewma0 = (value = 0): Ewma => ({ value, n: 0 });

export function initialLearner(now = Date.now()): LearnerState {
  return {
    id: 'learner',
    version: 1,
    confusion: initialConfusion(now),
    habits: {},
    prosody: { schwa: ewma0(0.5), npvi: ewma0(45), fluency: ewma0(0.5), concise: ewma0(0.5) },
    totalTurns: 0,
    updatedAt: now,
  };
}

export function ewmaUpdate(e: Ewma, x: number, alpha = ALPHA): Ewma {
  // Bias-corrected start: the first observations move the estimate faster.
  const a = Math.max(alpha, 1 / (e.n + 1));
  return { value: (1 - a) * e.value + a * x, n: e.n + 1 };
}

/** Column that a produced phone counts as, treating licensed allophones as correct. */
function producedColumn(pair: AlignedPair, row: number): number {
  if (!pair.produced) return pair.target?.linking ? row : DEL_COL;
  if (pair.kind === 'match') return row; // ʔ for licensed /t/, reduced weak vowels, exact matches
  return COLUMN_INDEX.get(pair.produced.p) ?? OTHER_COL;
}

/** M_P[i,·] ← (1−α)·M_P[i,·] + α·e_j for every aligned target phoneme. */
export function updateConfusion(c: ConfusionState, pairs: AlignedPair[], now = Date.now()): ConfusionState {
  const rows = c.rows.map((r) => r.slice());
  const counts = c.counts.slice(), pending = c.pending.slice(), updatedAt = c.updatedAt.slice();
  for (const pair of pairs) {
    if (!pair.target) continue;
    const i = PHONEME_INDEX.get(pair.target.p);
    if (i === undefined) continue;
    const j = producedColumn(pair, i);
    const row = rows[i];
    for (let k = 0; k < K; k++) row[k] *= 1 - ALPHA;
    row[j] += ALPHA;
    counts[i]++; pending[i]++; updatedAt[i] = now;
  }
  return { rows, counts, pending, updatedAt };
}

export function mastery(c: ConfusionState, phoneme: string): number {
  const i = PHONEME_INDEX.get(phoneme);
  return i === undefined ? 0.5 : c.rows[i][i];
}

/** Strongest off-diagonal confusion for a phoneme (e.g. /əʊ/ → [oː]). */
export function topConfusion(c: ConfusionState, phoneme: string): { phone: string; p: number } | null {
  const i = PHONEME_INDEX.get(phoneme);
  if (i === undefined) return null;
  let best = -1, bp = 0;
  c.rows[i].forEach((v, k) => { if (k !== i && k !== OTHER_COL && v > bp) { bp = v; best = k; } });
  return best >= 0 && bp > 0.05 ? { phone: CONFUSION_COLUMNS[best], p: bp } : null;
}

// --- interference habits ------------------------------------------------------

const LINKING_VOWELS = new Set(['ɑː', 'ɔː', 'ɜː', 'ə', 'ɪə', 'eə', 'ʊə']);

/** How many chances the utterance gave to commit each habit. */
function opportunities(a: AlignmentResult): Partial<Record<Diagnosis, number>> {
  const o: Partial<Record<Diagnosis, number>> = {};
  const add = (d: Diagnosis, n = 1) => { o[d] = (o[d] ?? 0) + n; };
  const targets = a.pairs.filter((p) => p.target).map((p) => p.target!);
  targets.forEach((t, idx) => {
    if (t.p === 't' || t.p === 'd' || t.p === 'n' || t.p === 'l') add('RETROFLEX');
    if (t.p === 'θ' || t.p === 'ð') add('TH_STOPPING');
    if (t.p === 'v' || t.p === 'w') add('VW_MERGER');
    if (t.p === 'əʊ') add('GOAT_MONOPHTHONG');
    if (t.p === 'eɪ') add('FACE_MONOPHTHONG');
    if (t.p === 'ɑː') add('TRAP_BATH');
    if (t.p === 'ɒ' || t.p === 'ɔː') add('LOT_THOUGHT');
    if (t.p === 'r') add('TAP_R');
    if (t.linking) add('MISSED_LINKING_R');
    const next = targets[idx + 1];
    if (LINKING_VOWELS.has(t.p) && !t.weak && (!next || !isVowel(next.p))) add('RHOTIC');
  });
  if (a.schwa.expected) add('MISSED_SCHWA', a.schwa.expected);
  return o;
}

export function updateHabits(habits: LearnerState['habits'], a: AlignmentResult): LearnerState['habits'] {
  const out = { ...habits };
  const opp = opportunities(a);
  for (const [code, n] of Object.entries(opp) as [Diagnosis, number][]) {
    if (!n) continue;
    const hits = a.diagnoses[code] ?? 0;
    out[code] = ewmaUpdate(out[code] ?? ewma0(0), Math.min(1, hits / n));
  }
  return out;
}

export function updateProsodyVector(
  v: LearnerState['prosody'],
  m: { schwa: number | null; npvi: number; fluency: number; concise: number | null },
): LearnerState['prosody'] {
  return {
    schwa: m.schwa === null ? v.schwa : ewmaUpdate(v.schwa, m.schwa),
    npvi: m.npvi > 0 ? ewmaUpdate(v.npvi, m.npvi) : v.npvi,
    fluency: ewmaUpdate(v.fluency, m.fluency),
    concise: m.concise === null ? v.concise : ewmaUpdate(v.concise, m.concise),
  };
}

// --- vocabulary grading from speech -----------------------------------------------

/** Spoken grade: deployed fluently & cleanly → Easy … not deployed → Again. */
export function spokenGrade(o: { deployed: boolean; hesitated: boolean; pronunciation: 'match' | 'drift' | 'error' | 'unknown' }): 1 | 2 | 3 | 4 {
  if (!o.deployed) return 1;
  if (o.hesitated || o.pronunciation === 'error') return 2;
  if (o.pronunciation === 'match') return 4;
  return 3;
}

// --- bandit scheduler -------------------------------------------------------------------

export interface BanditContext {
  learner: LearnerState;
  vocab: Map<string, VocabCard>;
  stats: Map<string, PromptStat>;
  now: number;
  tier?: Tier;
  excludeId?: string;
  /** prompts served recently (skipped or not): avoided while anything else is eligible */
  recent?: ReadonlySet<string>;
  /** optional focus phoneme (dashboard drill) */
  focusPhoneme?: string;
  rng?: () => number;
}

export const BETAS = { phonetic: 1.0, lexical: 0.8, uncertainty: 0.35 };

export interface ScoredPrompt { prompt: Prompt; score: number; parts: { phonetic: number; lexical: number; uncertainty: number } }

/**
 * p* = argmax_p β1·Σ_{φ∈p}(1 − M_P[φ,φ])/√|Φ_p| + β2·Σ_{v∈p}(1 − P_recall(v,t)) + β3·UCB(p)
 * The phonetic sum is √-normalised so long prompts don't win by length alone.
 */
export function scorePrompts(prompts: Prompt[], ctx: BanditContext): ScoredPrompt[] {
  const totalServed = Array.from(ctx.stats.values()).reduce((s, x) => s + x.n, 0);
  const rng = ctx.rng ?? Math.random;
  const eligible = prompts.filter((p) => (!ctx.tier || p.tier === ctx.tier) && p.id !== ctx.excludeId);
  // A skip records no outcome, so without this the argmax would bounce between the same two prompts.
  const fresh = ctx.recent?.size ? eligible.filter((p) => !ctx.recent!.has(p.id)) : eligible;
  const pool = fresh.length ? fresh : eligible;
  const scored = pool.map((prompt) => {
    const phon = Array.from(new Set(prompt.phonemes ?? []));
    let phonetic = 0;
    for (const ph of phon) phonetic += 1 - mastery(ctx.learner.confusion, ph);
    phonetic = phon.length ? phonetic / Math.sqrt(phon.length) : 0;
    if (ctx.focusPhoneme && phon.includes(ctx.focusPhoneme)) phonetic += 3;
    let lexical = 0;
    for (const id of prompt.targetVocab) lexical += 1 - recallProbability(ctx.vocab.get(id), ctx.now);
    const st = ctx.stats.get(prompt.id);
    const n = st?.n ?? 0;
    const uncertainty = Math.sqrt((2 * Math.log(totalServed + 2)) / (n + 1));
    let score = BETAS.phonetic * phonetic + BETAS.lexical * lexical + BETAS.uncertainty * uncertainty;
    // Don't immediately repeat something just passed; tiny noise breaks ties.
    if (st?.passed && ctx.now - st.lastServed < 30 * 60_000) score -= 2;
    score += rng() * 1e-3;
    return { prompt, score, parts: { phonetic, lexical, uncertainty } };
  });
  return scored.sort((a, b) => b.score - a.score);
}

export function selectNextPrompt(prompts: Prompt[], ctx: BanditContext): ScoredPrompt | null {
  return scorePrompts(prompts, ctx)[0] ?? null;
}

/** Suggest a tier from the state vector when the user leaves tier on Auto. */
export function suggestTier(learner: LearnerState): Tier {
  const diag = RP_PHONEMES.map((p) => mastery(learner.confusion, p));
  const seen = learner.confusion.counts.filter((c) => c > 0).length;
  const meanMastery = diag.reduce((a, b) => a + b, 0) / diag.length;
  if (learner.totalTurns < 6 || seen < 20 || meanMastery < 0.6) return 1;
  if (learner.prosody.concise.n < 8 || learner.prosody.concise.value < 0.7) return 2;
  return 3;
}

