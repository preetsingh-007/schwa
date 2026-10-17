import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { analyzeProsody, compareProsody, contourShape } from '../src/lib/prosody';
import { encodePhonemes, decodePhonemes, nextShadowLevel } from '../src/services/corpus';
import { prosodyScore, compositeReward, SHADOW_WEIGHTS } from '../src/services/reward';
import { buildConnectedTarget } from '../src/lib/connectedSpeech';
import { alignToTarget, setAcousticCalibration, type AcousticCalibration } from '../src/services/ipaAligner';
import type { CorpusIndex, CorpusRow } from '../src/types';

const SR = 16000;
/** Voiced glide from f0a to f0b Hz (harmonic tone) with short gaps between "syllables". */
function glide(f0a: number, f0b: number, sec: number): Float32Array {
  const x = new Float32Array(Math.round(sec * SR));
  let ph = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / x.length;
    const f = f0a + (f0b - f0a) * t;
    ph += (2 * Math.PI * f) / SR;
    const syl = Math.sin(Math.PI * ((t * 8) % 1)) ** 2; // 8 syllable-like pulses
    x[i] = 0.3 * syl * (Math.sin(ph) + 0.4 * Math.sin(2 * ph));
  }
  return x;
}

describe('compareProsody', () => {
  const fall = analyzeProsody(glide(220, 140, 1.6), SR);
  const fallLow = analyzeProsody(glide(140, 90, 1.6), SR); // same shape, lower voice
  const rise = analyzeProsody(glide(140, 220, 1.6), SR);
  it('builds a median-relative contour shape', () => {
    const s = contourShape(fall).filter((v): v is number => v !== null);
    expect(s.length).toBeGreaterThan(10);
    expect(s[0]).toBeGreaterThan(s[s.length - 1]);
  });
  it('matches the same melody in a different register and rejects the opposite one', () => {
    const same = compareProsody(fallLow, fall);
    const opposite = compareProsody(rise, fall);
    expect(same.shapeCorr!).toBeGreaterThan(0.8);
    expect(opposite.shapeCorr!).toBeLessThan(-0.5);
    expect(same.intonation).toBeGreaterThan(opposite.intonation);
  });
  it('feeds the reference into the prosody score', () => {
    const withRef = prosodyScore(fallLow, null, 0, fall);
    expect(withRef.reference).toBeDefined();
    expect(prosodyScore(rise, null, 0, fall).score).toBeLessThan(withRef.score);
  });
  it('uses listen-and-repeat weights when given', () => {
    const r = compositeReward({ tier: 1, phonetic: 90, prosody: 60, lexical: 0, criticalRedundancies: 0, weights: SHADOW_WEIGHTS });
    expect(r.reward).toBeCloseTo(0.6 * 90 + 0.4 * 60);
  });
});

describe('corpus', () => {
  it('round-trips phoneme encoding', () => {
    const ph = ['əʊ', 'ɡ', 'θ', 'r', 'iː'];
    expect(decodePhonemes(encodePhonemes(ph))).toEqual(ph);
  });
  it('promotes after consistent passes and steps back after a bad run', () => {
    const good = Array.from({ length: 12 }, () => ({ reward: 85, passed: true }));
    expect(nextShadowLevel(3, good)).toBe(4);
    expect(nextShadowLevel(12, good)).toBe(12);
    const bad = Array.from({ length: 8 }, () => ({ reward: 40, passed: false }));
    expect(nextShadowLevel(3, bad)).toBe(2);
    expect(nextShadowLevel(1, bad)).toBe(1);
    expect(nextShadowLevel(3, good.slice(0, 5))).toBe(3);
  });
  const idx = 'public/corpus/index.json';
  it.runIf(existsSync(idx))('ships an annotated, attributed corpus', () => {
    const index = JSON.parse(readFileSync(idx, 'utf8')) as CorpusIndex;
    expect(index.total).toBeGreaterThan(20000);
    expect(index.levels).toHaveLength(12);
    const rows = JSON.parse(readFileSync(`public/corpus/${index.levels[0].file}`, 'utf8')) as CorpusRow[];
    expect(rows.every((r) => r.id && r.text && r.src)).toBe(true);
    expect(rows.filter((r) => r.ph && r.ph.length > 0).length / rows.length).toBeGreaterThan(0.99);
    expect(index.sources.find((s) => s.id === 'tatoeba')?.license).toBe('CC BY 2.0 FR');
  });
});

describe('acoustic calibration', () => {
  afterEach(() => setAcousticCalibration(null));
  const cal: AcousticCalibration = { minRate: 0.12, accept: { 'əʊ': { 'oʊ': 0.8 } }, insertions: { 'ɑː': { 'r@ɑːɹ': 0.9 } }, weakForms: { of: { 'ʌ': 0.7 } } };

  it('accepts deviations that RP reference speech triggers in the model', () => {
    const t = buildConnectedTarget(['go', 'far'], ['ɡˈəʊ', 'fˈɑː']);
    const produced = [{ p: 'ɡ' }, { p: 'oʊ' }, { p: 'f' }, { p: 'ɑː', tok: 'ɑːɹ' }, { p: 'r', tok: 'ɑːɹ' }];
    expect(alignToTarget(t, produced).diagnoses.RHOTIC).toBe(1);
    setAcousticCalibration(cal);
    const a = alignToTarget(t, produced);
    expect(a.diagnoses.RHOTIC).toBeUndefined();
    expect(a.diagnoses.GOAT_BACKED).toBeUndefined();
    expect(a.pairs.filter((p) => p.calibrated).length).toBe(2);
    expect(a.per).toBe(0);
  });

  it('still flags a standalone /r/ and genuine substitutions', () => {
    setAcousticCalibration(cal);
    const t = buildConnectedTarget(['far', 'go'], ['fˈɑː', 'ɡˈəʊ']);
    const a = alignToTarget(t, [{ p: 'f' }, { p: 'ɑː' }, { p: 'ɾ', tok: 'r' }, { p: 'ɡ' }, { p: 'oː' }]);
    expect(a.diagnoses.RHOTIC).toBe(1);
    expect(a.diagnoses.GOAT_MONOPHTHONG).toBe(1);
  });

  it('applies weak-form calibration per function word', () => {
    setAcousticCalibration(cal);
    const t = buildConnectedTarget(['cup', 'of', 'tea'], ['kˈʌp', 'ˈɒv', 'tˈiː']);
    const a = alignToTarget(t, [{ p: 'k' }, { p: 'ʌ' }, { p: 'p' }, { p: 'ʌ' }, { p: 'v' }, { p: 't' }, { p: 'iː' }]);
    expect(a.diagnoses.MISSED_SCHWA).toBeUndefined();
  });
});

describe('kokoroPhonemes (RP voice input)', async () => {
  const { kokoroPhonemes } = await import('../src/lib/g2p');
  it('drives the voice with RP BATH, weak forms, linking r and Kokoro symbol conventions', async () => {
    const ph = await kokoroPhonemes('Ask for a bath and a cup of tea, then rest.');
    expect(ph).toContain('ˈɑːsk');
    expect(ph).toContain('fəɹ ə');
    expect(ph).toContain('bˈɑːθ');
    expect(ph).toContain(' ən ');
    expect(ph).toContain(' əv ');
    expect(ph).toMatch(/tˈiː,/);
    expect(ph).toContain('ɹˈɛst.');
    expect(ph).not.toMatch(/[æ]|(^|[^eə])r/);
  });
});
