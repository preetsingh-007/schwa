import { describe, expect, it } from 'vitest';
import { yinPitch, nPVI, analyzeProsody, segmentSpeech, rmsEnvelopeDb } from '../src/lib/prosody';
import { chunkBoundaries, resample, trimSilence } from '../src/lib/audioUtils';

const SR = 16000;
function tone(f: number, sec: number, amp = 0.3): Float32Array {
  const x = new Float32Array(Math.round(sec * SR));
  for (let i = 0; i < x.length; i++) x[i] = amp * (Math.sin((2 * Math.PI * f * i) / SR) + 0.4 * Math.sin((4 * Math.PI * f * i) / SR));
  return x;
}
function concat(...xs: Float32Array[]): Float32Array {
  const out = new Float32Array(xs.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of xs) { out.set(x, o); o += x.length; }
  return out;
}
const silence = (sec: number) => new Float32Array(Math.round(sec * SR));

describe('YIN pitch', () => {
  it('recovers the F0 of a harmonic tone', () => {
    const { f0 } = yinPitch(tone(150, 0.5), SR);
    const voiced = Array.from(f0).filter((v) => v > 0);
    const med = voiced.sort((a, b) => a - b)[Math.floor(voiced.length / 2)];
    expect(med).toBeGreaterThan(146);
    expect(med).toBeLessThan(154);
  });
  it('is unvoiced on silence', () => {
    expect(Array.from(yinPitch(silence(0.3), SR).f0).every((v) => v === 0)).toBe(true);
  });
});

describe('nPVI', () => {
  it('is 0 for isochronous (syllable-timed) intervals and large for alternating ones', () => {
    expect(nPVI([[0.1, 0.1, 0.1, 0.1]])).toBe(0);
    expect(nPVI([[0.2, 0.05, 0.2, 0.05]])).toBeCloseTo(120, 0);
  });
});

describe('pause detection & segmentation', () => {
  it('finds a > 400 ms mid-utterance hesitation', () => {
    const x = concat(silence(0.2), tone(140, 0.6), silence(0.7), tone(130, 0.6), silence(0.2));
    const p = analyzeProsody(x, SR);
    expect(p.longPauses).toHaveLength(1);
    expect(p.longPauses[0].end - p.longPauses[0].start).toBeGreaterThan(0.55);
    expect(p.f0MedianHz).toBeGreaterThan(120);
  });
  it('merges short gaps', () => {
    const x = concat(tone(140, 0.3), silence(0.08), tone(140, 0.3));
    expect(segmentSpeech(rmsEnvelopeDb(x, SR))).toHaveLength(1);
  });
});

describe('audio utils', () => {
  it('resamples 48k → 16k to a third of the length', () => {
    expect(resample(new Float32Array(48000), 48000, 16000)).toHaveLength(16000);
  });
  it('trims leading/trailing silence', () => {
    const x = concat(silence(1), tone(200, 0.5), silence(1));
    expect(trimSilence(x, SR).length / SR).toBeLessThan(1);
  });
  it('chunks long audio into ≤ 10 s windows', () => {
    const b = chunkBoundaries(concat(tone(150, 12), silence(0.5), tone(150, 12)), SR, 10);
    for (let i = 1; i < b.length; i++) expect(b[i] - b[i - 1]).toBeLessThanOrEqual(10 * SR);
    expect(b.at(-1)).toBe(Math.round(24.5 * SR));
  });
});
