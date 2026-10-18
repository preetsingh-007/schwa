import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { backchain, canBuildUp, planBuildUp, problemWords, shouldBuildUp } from '../src/services/buildup';
import { advanceLadder, focusAccuracy, ladderPrompt, mergeLadders, needsCheck, pickLadderSound, weakSounds, type LadderSet, type Ladders } from '../src/services/ladders';
import { mergeLearner } from '../src/services/githubSync';
import { initialLearner, updateConfusion } from '../src/services/rlBandit';
import { buildConnectedTarget } from '../src/lib/connectedSpeech';
import { alignToTarget, setAcousticCalibration } from '../src/services/ipaAligner';
import { compositeReward, PHONETIC_WEIGHTS } from '../src/services/reward';
import { commitTurn, evaluateTurn } from '../src/services/evaluate';
import { analyzeProsody } from '../src/lib/prosody';
import { db, exportDocument, getLearner, isSyncDocument } from '../src/services/db';
import type { CuratedData, LadderDrill, LearnerState, Prompt } from '../src/types';

const sentence: Prompt = {
  id: 't1_069', tier: 1, category: 'meetings', title: 'Diagnostic: meetings',
  text: 'Could we move the Thursday call to half past ten?', reference: 'Could we move the Thursday call to half past ten?', targetVocab: [], timeLimitSec: 12,
};
const words = (statuses: Record<string, string>) => sentence.text.split(' ').map((w, index) => ({ index, text: w.replace(/\?$/, ''), status: statuses[w.replace(/\?$/, '')] ?? 'match' }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeResult = (statuses: Record<string, string>, transcript: string) => ({ alignment: { words: words(statuses) } as any, transcript });

describe('build-up', () => {
  it('drills the words that went wrong, in sentence order, then rebuilds from the end', () => {
    const r = fakeResult({ Thursday: 'error', move: 'error' }, 'could we move the thursday call to half past');
    expect(problemWords(sentence.text, r)).toEqual(['move', 'Thursday', 'ten']);
    expect(backchain(sentence.text)).toEqual(['half past ten?', 'the Thursday call to half past ten?']);
    const steps = planBuildUp(sentence, r);
    expect(steps.map((s) => s.text)).toEqual(['move', 'Thursday', 'ten', 'half past ten?', 'the Thursday call to half past ten?']);
    expect(steps.every((s) => s.drill?.kind === 'buildup' && s.drill.parent === sentence && s.drill.steps === 5)).toBe(true);
    expect(new Set(steps.map((s) => s.id)).size).toBe(5);
  });
  it('only breaks down sentences, after three misses', () => {
    expect(shouldBuildUp(sentence, 2)).toBe(false);
    expect(shouldBuildUp(sentence, 3)).toBe(true);
    expect(canBuildUp({ ...sentence, mode: 'nameit' })).toBe(false);
    expect(canBuildUp({ ...sentence, text: 'Hello there', reference: 'Hello there' })).toBe(false);
    const step = planBuildUp(sentence, fakeResult({ Thursday: 'error' }, sentence.text))[0];
    expect(canBuildUp(step)).toBe(false);
  });
});

const set: LadderSet = {
  contrast: 't', words: ['thin', 'think', 'both', 'three'], pairs: [['three', 'tree'], ['both', 'boat'], ['thank', 'tank']],
  phrases: [{ id: 'tt1', text: 'I think so.' }], sentences: [{ id: 'tt2', text: 'I think that you dropped something.' }],
};
const drill = (stage: 1 | 2 | 3 | 4): LadderDrill => ({ kind: 'ladder', phoneme: 'θ', stage, content: 'words' });

describe('sound ladders', () => {
  it('climbs after two passes per stage (one for sentences) and never moves back', () => {
    let lp = advanceLadder(undefined, drill(1), true, 1);
    expect(lp).toMatchObject({ stage: 1, wins: 1 });
    lp = advanceLadder(lp, drill(1), false, 2);
    expect(lp).toMatchObject({ stage: 1, wins: 1 });
    lp = advanceLadder(lp, drill(1), true, 3);
    expect(lp).toMatchObject({ stage: 2, wins: 0 });
    expect(advanceLadder(lp, drill(1), true, 4)).toMatchObject({ stage: 2, wins: 0 }); // an old stage doesn't count
    lp = advanceLadder({ stage: 4, wins: 0, updatedAt: 0 }, drill(4), true, 5);
    expect(lp.stage).toBe(5);
    expect(advanceLadder(lp, drill(4), true, 6).stage).toBe(5);
  });
  it('builds each stage, falling back when a sound has no pairs or sentences', () => {
    expect(ladderPrompt('θ', set, 1, 0).text).toBe('Thin. Think. Both.');
    const pairs = ladderPrompt('θ', set, 2, 0);
    expect(pairs.text).toBe('Three, tree. Both, boat. Thank, tank.');
    expect(pairs.drill).toMatchObject({ content: 'pairs', contrast: 't' });
    expect(ladderPrompt('θ', { ...set, pairs: [], contrast: undefined }, 2, 0).drill).toMatchObject({ content: 'words' });
    expect(ladderPrompt('θ', set, 4, 0).text).toBe('I think that you dropped something.');
    expect(ladderPrompt('θ', { ...set, sentences: [] }, 4, 0).drill).toMatchObject({ content: 'phrase' });
    expect(ladderPrompt('θ', { ...set, sentences: [], phrases: [] }, 4, 0).drill).toMatchObject({ content: 'words' });
  });
  it('picks a requested sound, else the ladder in progress, else the weakest sound', () => {
    const ladders: Ladders = { θ: set, w: { ...set, contrast: 'v' } };
    const t = buildConnectedTarget(['think'], ['θˈɪŋk']);
    let learner = initialLearner(0);
    expect(needsCheck(learner)).toBe(true);
    for (let i = 0; i < 5; i++) learner = { ...learner, confusion: updateConfusion(learner.confusion, alignToTarget(t, [{ p: 't' }, { p: 'ɪ' }, { p: 'ŋ' }, { p: 'k' }]).pairs, i) };
    expect(weakSounds(learner, ladders)).toEqual(['θ']);
    expect(pickLadderSound(learner, ladders)).toBe('θ');
    expect(pickLadderSound(learner, ladders, 'w')).toBe('w');
    expect(pickLadderSound({ ...learner, ladders: { w: { stage: 2, wins: 0, updatedAt: 9 } } }, ladders)).toBe('w');
    expect(pickLadderSound({ ...learner, ladders: { θ: { stage: 5, wins: 0, updatedAt: 9 } } }, ladders)).toBe(null);
  });
  it('counts how often the focus sound was right', () => {
    const t = buildConnectedTarget(['think', 'thin'], ['θˈɪŋk', 'θˈɪn']);
    const a = alignToTarget(t, [{ p: 't' }, { p: 'ɪ' }, { p: 'ŋ' }, { p: 'k' }, { p: 'θ' }, { p: 'ɪ' }, { p: 'n' }]);
    expect(focusAccuracy(a, ['θ'])).toEqual({ hit: 1, total: 2 });
  });
  it('scores word drills on the sounds alone, even in low-memory mode', () => {
    expect(compositeReward({ tier: 1, phonetic: 90, prosody: 20, lexical: 0, criticalRedundancies: 0, weights: PHONETIC_WEIGHTS }).reward).toBe(90);
    expect(Number.isFinite(compositeReward({ tier: 1, phonetic: null, prosody: 70, lexical: 0, criticalRedundancies: 0, weights: PHONETIC_WEIGHTS }).reward)).toBe(true);
  });
});

describe('saved progress stays intact', () => {
  const old = (over: Partial<LearnerState> = {}): LearnerState => ({ ...initialLearner(0), totalTurns: 40, shadowLevel: 3, wordBand: 2, updatedAt: 100, ...over });

  it('merging two devices saved before ladders existed adds nothing', () => {
    const m = mergeLearner(old(), old({ totalTurns: 55, updatedAt: 200 }));
    expect('ladders' in m).toBe(false);
    expect(m).toMatchObject({ totalTurns: 55, shadowLevel: 3, wordBand: 2 });
  });
  it('sync keeps ladders from either device; the further-along ladder wins', () => {
    const a = old({ ladders: { θ: { stage: 3, wins: 1, updatedAt: 10 }, w: { stage: 1, wins: 1, updatedAt: 50 } } });
    const b = old({ ladders: { θ: { stage: 2, wins: 0, updatedAt: 99 }, v: { stage: 5, wins: 0, updatedAt: 20 } } });
    expect(mergeLearner(a, old()).ladders).toEqual(a.ladders);
    expect(mergeLearner(old(), b).ladders).toEqual(b.ladders);
    expect(mergeLearner(a, b).ladders).toEqual({ θ: { stage: 3, wins: 1, updatedAt: 10 }, w: a.ladders!.w, v: b.ladders!.v });
    expect(mergeLadders(undefined, undefined)).toBeUndefined();
  });
  it('a ladder turn on old saved state adds the ladder and leaves everything else alone', async () => {
    await db.learner.put(old());
    await db.vocab.put({ id: 'lx_food_aubergine', stability: 4, difficulty: 5, reps: 2, lapses: 0, lastReview: 50, due: 500, tau: 0.5, history: [], updatedAt: 50 });
    const prompt = ladderPrompt('θ', set, 1, 0); // "Thin. Think. Both."
    const t = buildConnectedTarget(['thin', 'think', 'both'], ['θˈɪn', 'θˈɪŋk', 'bˈəʊθ']);
    const produced = t.flatMap((w) => w.phones.map((p) => ({ p: p.p })));
    const data: CuratedData = { phonemes: [], vocab: [], prompts: [], rules: [] };
    const audio = new Float32Array(16000);
    const r = evaluateTurn({ prompt, attempt: 1, transcript: 'Thin. Think. Both.', target: t, produced, prosody: analyzeProsody(audio, 16000), semantic: null, audio }, data);
    expect(r.reward.passed).toBe(true);
    await commitTurn(r, data);
    const after = await getLearner();
    expect(after.ladders).toEqual({ θ: { stage: 1, wins: 1, updatedAt: expect.any(Number) } });
    expect(after).toMatchObject({ totalTurns: 41, shadowLevel: 3, wordBand: 2 });
    expect(await db.vocab.get('lx_food_aubergine')).toMatchObject({ stability: 4, reps: 2 });
    // backups made now still import into the version that's installed today (same schema id)
    expect(isSyncDocument(await exportDocument())).toBe(true);
  });
  it('word drills use the single-word calibration; sentences are scored exactly as before', () => {
    setAcousticCalibration({ minRate: 0.12, accept: {}, insertions: {}, weakForms: {}, isolated: { accept: { ɔː: { oː: 0.6 } }, insertions: {} } });
    try {
      const t = buildConnectedTarget(['law'], ['lˈɔː']);
      const heard = [{ p: 'l' }, { p: 'oː' }];
      expect(alignToTarget(t, heard).pairs[1].kind).toBe('error');
      expect(alignToTarget(t, heard, undefined, 16000, { isolated: true }).pairs[1]).toMatchObject({ kind: 'match', calibrated: true });
      expect(alignToTarget(t, heard).pairs[1].kind).toBe('error'); // nothing leaks into the next alignment
    } finally {
      setAcousticCalibration(null);
    }
  });
  it('a word drill counts words by their sounds when the transcriber guesses wrong', () => {
    const prompt = ladderPrompt('θ', set, 1, 0);
    const t = buildConnectedTarget(['thin', 'think', 'both'], ['θˈɪn', 'θˈɪŋk', 'bˈəʊθ']);
    const produced = t.flatMap((w) => w.phones.map((p) => ({ p: p.p })));
    const audio = new Float32Array(16000);
    const input = { prompt, attempt: 1, target: t, produced, prosody: analyzeProsody(audio, 16000), semantic: null, audio };
    const data: CuratedData = { phonemes: [], vocab: [], prompts: [], rules: [] };
    const r = evaluateTurn({ ...input, transcript: 'Sin, sing, boat.' }, data);
    expect(r.wordCoverage).toBe(1);
    expect(r.reward.passed).toBe(true);
    // saying something else entirely still doesn't count
    const other = evaluateTurn({ ...input, transcript: 'Good morning.', produced: [{ p: 'ɡ' }, { p: 'ʊ' }, { p: 'd' }, { p: 'm' }, { p: 'ɔː' }, { p: 'n' }, { p: 'ɪ' }, { p: 'ŋ' }] }, data);
    expect(other.wordCoverage).toBeLessThan(0.5);
    expect(other.reward.passed).toBe(false);
    // sentences still need the words to be heard
    const s = evaluateTurn({ ...input, prompt: { ...sentence, text: 'Thin think both', reference: 'Thin think both' }, transcript: 'Sin, sing, boat.' }, data);
    expect(s.wordCoverage).toBe(0);
  });
  it('the focus sound must be right for a ladder step to pass', () => {
    const prompt = ladderPrompt('θ', set, 1, 0);
    const t = buildConnectedTarget(['thin', 'think', 'both'], ['θˈɪn', 'θˈɪŋk', 'bˈəʊθ']);
    const produced = t.flatMap((w) => w.phones.map((p) => ({ p: p.p === 'θ' ? 't' : p.p })));
    const audio = new Float32Array(16000);
    const r = evaluateTurn({ prompt, attempt: 1, transcript: 'Thin. Think. Both.', target: t, produced, prosody: analyzeProsody(audio, 16000), semantic: null, audio }, { phonemes: [], vocab: [], prompts: [], rules: [] });
    expect(r.reward.passed).toBe(false);
    expect(r.reward.blockers).toContain('/θ/ right 0 of 3 times');
  });
});
