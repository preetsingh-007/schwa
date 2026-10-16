/** Small PCM helpers shared by the main thread, the worker and tests. */

/** Linear-interpolation resampler (good enough for 44.1/48 kHz → 16 kHz after the browser's own anti-alias filter). */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const ratio = from / to;
  const n = Math.floor(x.length / ratio);
  const out = new Float32Array(n);
  // simple box low-pass before decimation to limit aliasing
  const k = Math.max(1, Math.floor(ratio));
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    let s = 0, c = 0;
    for (let j = 0; j < k; j++) { const v = x[i0 + j]; if (v !== undefined) { s += v; c++; } }
    const a = c ? s / c : 0;
    const b = x[Math.min(x.length - 1, i0 + k)] ?? a;
    const frac = pos - i0;
    out[i] = k > 1 ? a : a + (b - a) * frac;
  }
  return out;
}

export function rms(x: Float32Array, start = 0, end = x.length): number {
  let s = 0;
  for (let i = start; i < end; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, end - start));
}

/** Trim leading/trailing silence, keeping a little padding. */
export function trimSilence(x: Float32Array, sr: number, padSec = 0.15): Float32Array {
  const win = Math.floor(sr * 0.02);
  const levels: number[] = [];
  for (let i = 0; i + win <= x.length; i += win) levels.push(rms(x, i, i + win));
  if (!levels.length) return x;
  const sorted = [...levels].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const peak = sorted[Math.floor(sorted.length * 0.98)];
  const thr = Math.max(floor * 3, peak * 0.05, 1e-4);
  let a = levels.findIndex((l) => l > thr);
  let b = levels.length - 1 - [...levels].reverse().findIndex((l) => l > thr);
  if (a < 0) return x;
  const pad = Math.floor(padSec * sr);
  a = Math.max(0, a * win - pad);
  b = Math.min(x.length, (b + 1) * win + pad);
  return x.slice(a, b);
}

/** Encode mono PCM as a 16-bit WAV blob (for playback of the user's own take). */
export function encodeWav(x: Float32Array, sr: number): Blob {
  const buf = new ArrayBuffer(44 + x.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + x.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

/** Choose chunk boundaries at the quietest 50 ms within the last 2 s of each window. */
export function chunkBoundaries(x: Float32Array, sr = 16000, maxSec = 10): number[] {
  const max = Math.floor(maxSec * sr);
  const bounds = [0];
  let start = 0;
  const win = Math.floor(0.05 * sr);
  while (x.length - start > max) {
    const searchFrom = start + max - 2 * sr;
    let best = start + max, bestE = Infinity;
    for (let s = searchFrom; s + win <= start + max; s += win / 2) {
      let e = 0;
      for (let k = 0; k < win; k++) e += x[s + k] * x[s + k];
      if (e < bestE) { bestE = e; best = s + Math.floor(win / 2); }
    }
    bounds.push(best);
    start = best;
  }
  bounds.push(x.length);
  return bounds;
}

