import { describe, expect, it } from 'vitest';
import { newCard, review, recallProbability, retrievability } from '../src/services/fsrs';
import { initialLearner, updateConfusion, mastery, selectNextPrompt, scorePrompts, spokenGrade, updateHabits, ALPHA } from '../src/services/rlBandit';
import { compositeReward, lexicalScore, TIER_WEIGHTS } from '../src/services/reward';
import { buildConnectedTarget } from '../src/lib/connectedSpeech';
import { alignToTarget } from '../src/services/ipaAligner';
import { concisenessReport } from '../src/services/redundancy';
import type { Prompt, RedundancyRule } from '../src/types';

const DAY = 86_400_000;

describe('FSRS', () => {
  it('grows stability on success and resets on failure', () => {
    const t0 = 1_700_000_000_000;
    let c = review(newCard('x', t0), 3, t0, 'tier2');
    const s1 = c.stability;
    c = review(c, 3, t0 + 3 * DAY, 'tier2');
    expect(c.stability).toBeGreaterThan(s1);
    const lapsed = review(c, 1, t0 + 20 * DAY, 'tier3');
    expect(lapsed.stability).toBeLessThan(c.stability);
    expect(lapsed.lapses).toBe(1);
  });
  it('retrievability is 0.9 after S days', () => {
    expect(retrievability(10, 10)).toBeCloseTo(0.9, 5);
    expect(recallProbability(undefined, Date.now())).toBe(0);
  });
  it('maps spoken performance to grades', () => {
    expect(spokenGrade({ deployed: false, hesitated: false, pronunciation: 'match' })).toBe(1);
    expect(spokenGrade({ deployed: true, hesitated: true, pronunciation: 'match' })).toBe(2);
    expect(spokenGrade({ deployed: true, hesitated: false, pronunciation: 'match' })).toBe(4);
  });
});

describe('confusion matrix', () => {
  it('applies the EWMA update to the produced column', () => {
    const t = buildConnectedTarget(['go'], ['ɡˈəʊ']);
    const a = alignToTarget(t, [{ p: 'ɡ' }, { p: 'oː' }]);
    const c = updateConfusion(initialLearner(0).confusion, a.pairs, 1);
    expect(mastery(c, 'əʊ')).toBeCloseTo(0.5 * (1 - ALPHA), 6);
    expect(mastery(c, 'ɡ')).toBeCloseTo(0.5 * (1 - ALPHA) + ALPHA, 6);
    c.rows.forEach((r) => expect(r.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6));
    const habits = updateHabits({}, a);
    expect(habits.GOAT_MONOPHTHONG!.value).toBe(1);
  });
});

describe('bandit scheduler', () => {
  const prompts: Prompt[] = [
    { id: 'goat', tier: 1, category: 'd', title: '', text: '', targetVocab: [], timeLimitSec: 10, phonemes: ['əʊ', 'ɡ'] },
    { id: 'th', tier: 1, category: 'd', title: '', text: '', targetVocab: [], timeLimitSec: 10, phonemes: ['θ', 'ɪ', 'n'] },
  ];
  it('prefers prompts loaded with weak phonemes', () => {
    const learner = initialLearner(0);
    const t = buildConnectedTarget(['go'], ['ɡˈəʊ']);
    for (let i = 0; i < 10; i++) learner.confusion = updateConfusion(learner.confusion, alignToTarget(t, [{ p: 'ɡ' }, { p: 'oː' }]).pairs, i);
    const tt = buildConnectedTarget(['thin'], ['θˈɪn']);
    for (let i = 0; i < 10; i++) learner.confusion = updateConfusion(learner.confusion, alignToTarget(tt, [{ p: 'θ' }, { p: 'ɪ' }, { p: 'n' }]).pairs, i);
    const best = selectNextPrompt(prompts, { learner, vocab: new Map(), stats: new Map(), now: 0, rng: () => 0 });
    expect(best?.prompt.id).toBe('goat');
  });
  it('honours the drill focus phoneme', () => {
    const s = scorePrompts(prompts, { learner: initialLearner(0), vocab: new Map(), stats: new Map(), now: 0, focusPhoneme: 'θ', rng: () => 0 });
    expect(s[0].prompt.id).toBe('th');
  });
});

describe('reward', () => {
  it('uses the tier weights and gates on critical redundancy', () => {
    expect(TIER_WEIGHTS[2]).toEqual([0.4, 0.2, 0.4]);
    const r = compositeReward({ tier: 2, phonetic: 90, prosody: 90, lexical: 90, criticalRedundancies: 1 });
    expect(r.reward).toBeCloseTo(90);
    expect(r.passed).toBe(false);
    expect(compositeReward({ tier: 2, phonetic: 90, prosody: 90, lexical: 90, criticalRedundancies: 0 }).passed).toBe(true);
  });
  it('renormalises when Stream B is off', () => {
    const r = compositeReward({ tier: 3, phonetic: null, prosody: 80, lexical: 100, criticalRedundancies: 0 });
    expect(r.weights[0]).toBe(0);
    expect(r.weights[1] + r.weights[2]).toBeCloseTo(1);
  });
  it('rewards target-vocabulary deployment', () => {
    const rules: RedundancyRule[] = [];
    const c = concisenessReport('The crux of the issue is the database.', rules);
    const hit = lexicalScore({ tier: 3, concise: c, targetVocab: ['a'], usedVocab: ['a'] });
    const miss = lexicalScore({ tier: 3, concise: c, targetVocab: ['a'], usedVocab: [] });
    expect(hit.score).toBeGreaterThan(miss.score);
  });
});
