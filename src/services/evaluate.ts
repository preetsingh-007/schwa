/**
 * Turn evaluation: combines the four streams into feedback, the composite
 * reward and the advancement gate, then commits the RL state update.
 */
import { alignToTarget, type AlignmentResult, type Diagnosis, type ProducedPhone } from './ipaAligner';
import { concisenessReport, vocabUsed, tokenize, type ConcisenessReport } from './redundancy';
import { compositeReward, lexicalScore, phoneticScore, prosodyScore, PHONETIC_WEIGHTS, SHADOW_WEIGHTS, type LexicalBreakdown, type ProsodyBreakdown, type RewardResult } from './reward';
import { updateConfusion, updateHabits, updateProsodyVector, spokenGrade, ewmaUpdate } from './rlBandit';
import { newCard, review } from './fsrs';
import { db, getLearner, markDirty } from './db';
import { withStateLock } from './lock';
import { nextShadowLevel } from './corpus';
import { getEntry, nextWordBand } from './lexicon';
import { advanceLadder, focusAccuracy, FOCUS_PASS } from './ladders';
import type { TargetWord } from '../lib/connectedSpeech';
import { normalizeWord } from '../lib/connectedSpeech';
import type { ProsodyMetrics } from '../lib/prosody';
import type { CuratedData, Prompt, SessionLog, Tier, VocabEntry } from '../types';
import type { GeminiRewrite } from './geminiEnhancer';

export interface TurnInput {
  prompt: Prompt;
  attempt: number;
  transcript: string;
  target: TargetWord[];
  produced: ProducedPhone[] | null;
  prosody: ProsodyMetrics;
  /** cosine similarity from MiniLM, if available */
  semantic: number | null;
  audio: Float32Array;
  /** neural RP rendering of the same text (listen-and-repeat) */
  reference?: { prosody: ProsodyMetrics; voice: string } | null;
}

export interface TurnResult extends TurnInput {
  tier: Tier;
  alignment: AlignmentResult | null;
  prosodyBreakdown: ProsodyBreakdown;
  concise: ConcisenessReport | null;
  lexical: LexicalBreakdown | null;
  usedVocab: string[];
  hesitatedVocab: string[];
  /** mean silence (ms) immediately before deployed target vocabulary */
  retrievalPauseMs: number | null;
  reward: RewardResult;
  /** the 1-line compressed target to speak on retry */
  retryTarget: string;
  wordCoverage: number | null;
  topDiagnoses: { code: Diagnosis; count: number }[];
  gemini?: GeminiRewrite | null;
}

const FILLER_RE = /\b(um+|uh+|erm+|er|hmm+)\b/gi;

function wordCoverage(expected: string, heard: string): number {
  const exp = tokenize(expected);
  if (!exp.length) return 1;
  const bag = new Map<string, number>();
  for (const t of tokenize(heard)) bag.set(t, (bag.get(t) ?? 0) + 1);
  let hit = 0;
  for (const t of exp) {
    const n = bag.get(t) ?? 0;
    if (n > 0) { hit++; bag.set(t, n - 1); }
  }
  return hit / exp.length;
}

/** Share of words with at least half their sounds right (match or drift). */
function soundCoverage(a: AlignmentResult): number {
  if (!a.words.length) return 0;
  const said = a.words.filter((w) => {
    const t = w.pairs.filter((p) => p.target);
    return t.length > 0 && t.filter((p) => p.kind !== 'error' && (p.produced || p.calibrated)).length * 2 >= t.length;
  });
  return said.length / a.words.length;
}

/** Did a > 500 ms silence immediately precede the word (lexical-retrieval hesitation)? */
function hesitatedBefore(start: number | undefined, prosody: ProsodyMetrics): boolean {
  if (start === undefined) return false;
  return prosody.longPauses.some((p) => p.end - p.start > 0.5 && Math.abs(p.end - start) < 0.25);
}

function findWordIndex(target: TargetWord[], v: VocabEntry): number {
  const forms = [v.headword, ...(v.forms ?? [])].map((f) => normalizeWord(f.split(/\s+/)[0]));
  return target.findIndex((w) => forms.some((f) => normalizeWord(w.text).startsWith(f.slice(0, Math.max(4, f.length - 2)))));
}

/** Core curriculum plus any lexicon entries the prompt targets (cards are looked up in the lexicon registry). */
function vocabPool(data: CuratedData, ids: string[]): VocabEntry[] {
  const core = new Set(data.vocab.map((v) => v.id));
  const extra = ids.filter((id) => !core.has(id)).map((id) => getEntry(id)).filter((v): v is VocabEntry => !!v);
  return [...data.vocab, ...extra];
}

export function evaluateTurn(input: TurnInput, data: CuratedData): TurnResult {
  const { prompt } = input;
  const tier = prompt.tier;
  // Single words and word pairs are judged on the sounds alone: rhythm and melody need a phrase.
  const d = prompt.drill;
  const wordDrill = (d?.kind === 'buildup' && d.part === 'word') || (d?.kind === 'ladder' && (d.content === 'words' || d.content === 'pairs'));
  const alignment = input.produced ? alignToTarget(input.target, input.produced, input.audio, 16000, { isolated: wordDrill }) : null;
  const fillers = (input.transcript.match(FILLER_RE) ?? []).length;
  const schwaRate = alignment && alignment.schwa.expected > 0 ? alignment.schwa.reduced / alignment.schwa.expected : null;
  const prosodyBreakdown = prosodyScore(input.prosody, schwaRate, fillers, input.reference?.prosody);

  const concise = tier === 1 ? null : concisenessReport(input.transcript, data.rules);
  const pool = vocabPool(data, prompt.targetVocab);
  const usedVocab = vocabUsed(input.transcript, pool);
  const lexical = concise
    ? lexicalScore({
      tier, concise, targetVocab: prompt.targetVocab, usedVocab,
      sourceWords: tier === 2 ? tokenize(prompt.text).length : undefined,
      semantic: input.semantic,
    })
    : null;

  // Name-it passes when the British word (or one of its forms) was said; read-aloud needs the words of the text.
  // Word drills also count a word as said when its sounds were mostly heard: with no sentence
  // around it the transcriber guesses ("law, all, more" → "since I old my"), and a mispronounced
  // word becomes a different word ("four" → "far") when that's exactly what the drill should mark.
  const coverage = prompt.mode === 'nameit'
    ? (prompt.cardId && usedVocab.includes(prompt.cardId) ? 1 : 0)
    : tier === 1 ? Math.max(wordCoverage(prompt.reference ?? prompt.text, input.transcript), wordDrill && alignment ? soundCoverage(alignment) : 0) : null;
  const reward = compositeReward({
    tier,
    phonetic: alignment ? phoneticScore(alignment) : null,
    prosody: prosodyBreakdown.score,
    lexical: lexical?.score ?? 0,
    criticalRedundancies: concise?.critical ?? 0,
    wordCoverage: coverage ?? undefined,
    weights: wordDrill ? PHONETIC_WEIGHTS : prompt.mode === 'shadow' ? SHADOW_WEIGHTS : undefined,
    coverageMessage: prompt.mode === 'nameit' ? `Say the British word — the answer is “${prompt.reference}”` : undefined,
  });
  // A ladder step also needs the sound(s) it practises to be right most of the time.
  if (d?.kind === 'ladder' && alignment) {
    for (const ph of [d.phoneme, ...(d.contrast ? [d.contrast] : [])]) {
      const { hit, total } = focusAccuracy(alignment, [ph]);
      if (total > 0 && hit / total < FOCUS_PASS) {
        reward.blockers.push(`/${ph}/ right ${hit} of ${total} times`);
        reward.passed = false;
      }
    }
  }

  const hesitatedVocab: string[] = [];
  const retrievalPauses: number[] = [];
  const vocabById = new Map(pool.map((v) => [v.id, v]));
  if (alignment) {
    for (const id of usedVocab) {
      const v = vocabById.get(id);
      if (!v) continue;
      const wi = findWordIndex(input.target, v);
      const start = wi >= 0 ? alignment.words[wi]?.start : undefined;
      if (start === undefined) continue;
      if (hesitatedBefore(start, input.prosody)) hesitatedVocab.push(id);
      const gap = input.prosody.longPauses.find((p) => Math.abs(p.end - start) < 0.25);
      retrievalPauses.push(gap ? (gap.end - gap.start) * 1000 : 0);
    }
  }

  let retryTarget = prompt.reference ?? prompt.text;
  if (tier === 3) retryTarget = concise && concise.hits.length ? concise.compressed : input.transcript;
  if (tier === 2 && concise && concise.hits.length && !prompt.reference) retryTarget = concise.compressed;

  const topDiagnoses = Object.entries(alignment?.diagnoses ?? {})
    .filter(([code]) => code !== 'ELISION' && code !== 'INSERTION')
    .map(([code, count]) => ({ code: code as Diagnosis, count: count as number }))
    .sort((a, b) => b.count - a.count);

  return {
    ...input, tier, alignment, prosodyBreakdown, concise, lexical, usedVocab, hesitatedVocab,
    retrievalPauseMs: retrievalPauses.length ? retrievalPauses.reduce((a, b) => a + b, 0) / retrievalPauses.length : null,
    reward, retryTarget, wordCoverage: coverage, topDiagnoses,
  };
}

/** Persist the RL update for one evaluated turn (IndexedDB) and queue a sync. */
export function commitTurn(r: TurnResult, data: CuratedData): Promise<SessionLog> {
  return withStateLock(() => commitTurnUnlocked(r, data));
}

async function commitTurnUnlocked(r: TurnResult, data: CuratedData): Promise<SessionLog> {
  const now = Date.now();
  const learner = await getLearner();
  const next = { ...learner };
  // Tier 1 aligns against the prompt text; if the user said something else the
  // alignment is meaningless and must not pollute the confusion matrix.
  const alignmentTrusted = r.tier !== 1 || (r.wordCoverage ?? 0) >= 0.5;
  if (r.alignment && alignmentTrusted) {
    next.confusion = updateConfusion(learner.confusion, r.alignment.pairs, now);
    next.habits = updateHabits(learner.habits, r.alignment);
  }
  next.prosody = updateProsodyVector(learner.prosody, {
    schwa: r.prosodyBreakdown.schwa,
    npvi: r.prosody.syllables >= 4 ? r.prosody.npvi : 0,
    fluency: r.prosodyBreakdown.fluency,
    concise: r.concise ? r.concise.score : null,
  });
  next.totalTurns = learner.totalTurns + 1;
  next.updatedAt = now;

  // FSRS updates from spoken performance on the prompt's target vocabulary
  // (plus any curriculum word deployed spontaneously in a Tier 3 monologue).
  const ids = new Set([...r.prompt.targetVocab, ...(r.tier === 3 ? r.usedVocab : [])]);
  const ctx = r.tier === 1 ? 'tier1' : r.tier === 2 ? 'tier2' : 'tier3';
  const cards = await db.vocab.bulkGet([...ids]);
  const vocabById = new Map(vocabPool(data, [...ids]).map((v) => [v.id, v]));
  const updated = [...ids].map((id, k) => {
    const card = cards[k] ?? newCard(id, now);
    // Name-it turns only count if the word was actually said; read-aloud turns always deploy it.
    const deployed = r.tier === 1 && r.prompt.mode !== 'nameit' ? true : r.usedVocab.includes(id);
    const v = vocabById.get(id);
    const wi = v ? findWordIndex(r.target, v) : -1;
    const status = wi >= 0 && r.alignment ? r.alignment.words[wi]?.status ?? 'unknown' : 'unknown';
    const hesitated = r.hesitatedVocab.includes(id);
    const reviewed = review(card, spokenGrade({ deployed, hesitated, pronunciation: status }), now, ctx);
    if (r.tier === 3) {
      const tau = ewmaUpdate({ value: card.tau, n: card.reps }, deployed && !hesitated ? 1 : 0);
      reviewed.tau = tau.value;
    }
    return reviewed;
  });

  const stat = (await db.promptStats.get(r.prompt.id)) ?? { id: r.prompt.id, n: 0, lastServed: 0, bestReward: 0, passed: false, updatedAt: now };
  // Only corpus sentences (which carry a level) drive listen-and-repeat level progression.
  const shadowLevel = r.prompt.mode === 'shadow' && r.prompt.level !== undefined ? r.prompt.level : undefined;
  const log: SessionLog = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ts: now,
    promptId: r.prompt.id,
    tier: r.tier,
    ...(shadowLevel !== undefined ? { shadowLevel } : {}),
    attempt: r.attempt,
    reward: Math.round(r.reward.reward * 10) / 10,
    phonetic: Math.round((r.reward.phonetic ?? 0) * 10) / 10,
    prosody: Math.round(r.reward.prosody * 10) / 10,
    lexical: Math.round(r.reward.lexical * 10) / 10,
    passed: r.reward.passed,
    transcript: r.transcript.slice(0, 2000),
    metrics: {
      per: r.alignment ? Math.round(r.alignment.per * 1000) / 1000 : 0,
      schwa: r.prosodyBreakdown.schwa,
      npvi: Math.round(r.prosody.npvi * 10) / 10,
      fluency: Math.round(r.prosodyBreakdown.fluency * 1000) / 1000,
      concise: r.concise ? Math.round(r.concise.score * 1000) / 1000 : null,
      syllableRate: Math.round(r.prosody.syllableRate * 100) / 100,
      longPauses: r.prosody.longPauses.length,
      vocabUsed: r.usedVocab,
      retrievalPauseMs: r.retrievalPauseMs === null ? null : Math.round(r.retrievalPauseMs),
    },
  };

  if (shadowLevel !== undefined && shadowLevel === (learner.shadowLevel ?? 1)) {
    const recent = await db.sessions.orderBy('ts').reverse().filter((x) => x.shadowLevel === shadowLevel).limit(20).toArray();
    next.shadowLevel = nextShadowLevel(shadowLevel, [log, ...recent]);
  }

  // Sound ladders: climb after enough passes at the current stage.
  if (r.prompt.drill?.kind === 'ladder') {
    const ph = r.prompt.drill.phoneme;
    next.ladders = { ...(learner.ladders ?? {}), [ph]: advanceLadder(learner.ladders?.[ph], r.prompt.drill, r.reward.passed, now) };
  }

  // Words mode: move to the next frequency band once 80 % of the current one has been passed.
  const card = r.prompt.cardId ? getEntry(r.prompt.cardId) : undefined;
  if (card?.source === 'auto' && card.band && card.band === (learner.wordBand ?? 1) && r.reward.passed) {
    const bandIds = new Set(r.prompt.cardId ? [r.prompt.id] : []);
    const passed = await db.promptStats.filter((st) => st.passed && st.id.startsWith('sw:w_') && getEntry(st.id.slice(3))?.band === card.band).count();
    const total = passed + (bandIds.size && !stat.passed ? 1 : 0);
    next.wordBand = nextWordBand(card.band, total, 1000, 20);
  }

  await db.transaction('rw', [db.learner, db.vocab, db.promptStats, db.sessions], async () => {
    await db.learner.put(next);
    if (updated.length) await db.vocab.bulkPut(updated);
    await db.promptStats.put({
      ...stat,
      n: stat.n + 1,
      lastServed: now,
      bestReward: Math.max(stat.bestReward, r.reward.reward),
      passed: stat.passed || r.reward.passed,
      updatedAt: now,
    });
    await db.sessions.put(log);
  });
  await markDirty();
  return log;
}
