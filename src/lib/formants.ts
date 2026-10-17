/**
 * LPC formant estimation (autocorrelation method + Levinson–Durbin, roots by
 * Durand–Kerner). Used for the acoustic rhoticity check: a pronounced /r/
 * pulls the third formant down sharply (F3 < ~2 kHz), while RP's non-rhotic
 * NURSE/START/NORTH vowels keep F3 near the speaker's baseline.
 */

export interface FormantFrame { t: number; f: number[] }

function levinson(r: Float64Array, order: number): Float64Array | null {
  const a = new Float64Array(order + 1);
  a[0] = 1;
  let err = r[0];
  if (err <= 0) return null;
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / err;
    const prev = a.slice();
    for (let j = 1; j < i; j++) a[j] = prev[j] + k * prev[i - j];
    a[i] = k;
    err *= 1 - k * k;
    if (err <= 0) return null;
  }
  return a;
}

/** Complex roots of 1 + a1 z^-1 + … + ap z^-p (as the monic polynomial z^p + a1 z^(p-1) + …). */
function polyRoots(a: Float64Array): [number, number][] {
  const n = a.length - 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) { const ang = (2 * Math.PI * i) / n + 0.4; re[i] = 0.9 * Math.cos(ang); im[i] = 0.9 * Math.sin(ang); }
  for (let iter = 0; iter < 80; iter++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      // p(z) via Horner
      let pr = 1, pi = 0;
      for (let k = 1; k <= n; k++) { const nr = pr * re[i] - pi * im[i] + a[k]; const ni = pr * im[i] + pi * re[i]; pr = nr; pi = ni; }
      // Π (z_i − z_j)
      let dr = 1, di = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const xr = re[i] - re[j], xi = im[i] - im[j];
        const nr = dr * xr - di * xi; di = dr * xi + di * xr; dr = nr;
      }
      const den = dr * dr + di * di || 1e-12;
      const qr = (pr * dr + pi * di) / den, qi = (pi * dr - pr * di) / den;
      re[i] -= qr; im[i] -= qi;
      moved = Math.max(moved, Math.abs(qr) + Math.abs(qi));
    }
    if (moved < 1e-9) break;
  }
  return Array.from(re, (r, i) => [r, im[i]] as [number, number]);
}

/** Formant frequencies (Hz, ascending) of one frame. */
export function frameFormants(x: Float32Array, start: number, len: number, sr: number, order = Math.round(sr / 1000) + 2): number[] {
  const w = new Float64Array(len);
  let prev = x[start - 1] ?? 0;
  for (let i = 0; i < len; i++) {
    const v = x[start + i] ?? 0;
    w[i] = (v - 0.97 * prev) * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (len - 1))); // pre-emphasis + Hamming
    prev = v;
  }
  const r = new Float64Array(order + 1);
  for (let k = 0; k <= order; k++) { let s = 0; for (let i = k; i < len; i++) s += w[i] * w[i - k]; r[k] = s; }
  r[0] *= 1 + 1e-9;
  const a = levinson(r, order);
  if (!a) return [];
  const out: number[] = [];
  for (const [zr, zi] of polyRoots(a)) {
    if (zi <= 0) continue;
    const f = (Math.atan2(zi, zr) * sr) / (2 * Math.PI);
    const bw = (-Math.log(Math.hypot(zr, zi)) * sr) / Math.PI;
    if (f > 150 && f < sr / 2 - 200 && bw < 500) out.push(f);
  }
  return out.sort((p, q) => p - q);
}

/** Formant tracks every `hop` seconds between t0 and t1. */
export function formantTrack(x: Float32Array, sr: number, t0: number, t1: number, hop = 0.01, win = 0.025): FormantFrame[] {
  const len = Math.round(win * sr);
  const frames: FormantFrame[] = [];
  for (let t = Math.max(0, t0); t + win <= Math.min(t1, x.length / sr); t += hop) {
    frames.push({ t, f: frameFormants(x, Math.round(t * sr), len, sr) });
  }
  return frames;
}

/** Third formant of a frame, choosing the formant in the plausible F3 band. */
export function f3Of(f: number[]): number | null {
  const cands = f.filter((v) => v > 1300 && v < 3800);
  if (cands.length < 1) return null;
  // F1 < 1000, F2 typically 800–2500; F3 is the next one above F2.
  const below = f.filter((v) => v < 1300);
  if (below.length >= 2) return cands[0];
  return cands.length >= 2 ? cands[1] : cands[0];
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/**
 * Rhotic drop for a vowel spanning [t0, t1]: the lowest F3 in its second half
 * relative to the speaker's baseline F3 (median over `baselineSpans`).
 * Returns the ratio (≈1 = no r-colouring; < ~0.8 = pronounced /r/).
 */
export function rhoticRatio(x: Float32Array, sr: number, t0: number, t1: number, baselineF3: number): number | null {
  if (t1 - t0 < 0.03 || baselineF3 <= 0) return null;
  const mid = t0 + (t1 - t0) * 0.4;
  const vals = formantTrack(x, sr, mid, t1).map((fr) => f3Of(fr.f)).filter((v): v is number => v !== null);
  if (vals.length < 2) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const low = sorted[Math.min(sorted.length - 1, 1)]; // 2nd-lowest, robust to a single bad frame
  return low / baselineF3;
}

/** F3 at the start (first 30 %) and end (last 60 %) of a vowel — the within-vowel F3 fall. */
export function f3Fall(x: Float32Array, sr: number, t0: number, t1: number): { onset: number; tail: number } | null {
  if (t1 - t0 < 0.04) return null;
  const on = formantTrack(x, sr, t0, t0 + Math.max(0.03, (t1 - t0) * 0.3)).map((fr) => f3Of(fr.f)).filter((v): v is number => v !== null);
  const tl = formantTrack(x, sr, t0 + (t1 - t0) * 0.4, t1).map((fr) => f3Of(fr.f)).filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (!on.length || tl.length < 2) return null;
  return { onset: median(on), tail: tl[Math.min(tl.length - 1, 1)] };
}

export function baselineF3(x: Float32Array, sr: number, spans: [number, number][]): number {
  const vals: number[] = [];
  for (const [a, b] of spans) for (const fr of formantTrack(x, sr, a, b, 0.02)) { const v = f3Of(fr.f); if (v) vals.push(v); }
  return median(vals);
}
