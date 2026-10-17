import { describe, expect, it } from 'vitest';
import { frameFormants, f3Of, rhoticRatio, baselineF3 } from '../src/lib/formants';

const SR = 16000;
/** Source–filter vowel: 120 Hz pulse train through second-order resonators. */
function vowel(formants: [number, number][], sec: number, f3End?: number): Float32Array {
  const n = Math.round(sec * SR);
  const src = new Float32Array(n);
  for (let i = 0; i < n; i += Math.round(SR / 120)) src[i] = 1;
  let y = src;
  formants.forEach(([f, bw], k) => {
    const out = new Float32Array(n);
    let y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const fi = k === 2 && f3End ? f + (f3End - f) * (i / n) : f;
      const r = Math.exp((-Math.PI * bw) / SR), th = (2 * Math.PI * fi) / SR;
      const v = y[i] + 2 * r * Math.cos(th) * y1 - r * r * y2;
      out[i] = v; y2 = y1; y1 = v;
    }
    y = out;
  });
  const peak = y.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  return y.map((v) => (0.5 * v) / peak);
}

describe('LPC formants', () => {
  it('recovers F1–F3 of a synthetic [ɑ]', () => {
    const x = vowel([[700, 80], [1150, 90], [2600, 120]], 0.3);
    const f = frameFormants(x, 1600, 400, SR);
    expect(Math.abs(f[0] - 700)).toBeLessThan(80);
    expect(Math.abs(f[1] - 1150)).toBeLessThan(120);
    expect(Math.abs(f3Of(f)! - 2600)).toBeLessThan(150);
  });
  it('detects an F3 drop (r-colouring) against the speaker baseline', () => {
    const plain = vowel([[650, 80], [1100, 90], [2550, 120]], 0.35);
    const rhotic = vowel([[650, 80], [1200, 90], [2550, 120]], 0.35, 1650);
    const base = baselineF3(plain, SR, [[0.05, 0.3]]);
    expect(rhoticRatio(plain, SR, 0.02, 0.33, base)!).toBeGreaterThan(0.9);
    expect(rhoticRatio(rhotic, SR, 0.02, 0.33, base)!).toBeLessThan(0.8);
  });
});
