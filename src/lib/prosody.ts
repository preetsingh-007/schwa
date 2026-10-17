/**
 * Stream D (DSP): pitch (YIN), intensity envelope, pause detection,
 * syllable-nucleus estimation and the vocalic nPVI rhythm metric.
 * Pure functions over 16 kHz mono Float32 PCM so they run in the worker and in tests.
 */

export const HOP_SEC = 0.01;

export interface PitchTrack {
  /** Hz, 0 when unvoiced; one value per 10 ms hop */
  f0: Float32Array;
  hop: number;
}

/**
 * YIN fundamental-frequency estimator (de Cheveigné & Kawahara, 2002):
 * difference function → cumulative-mean normalisation → absolute threshold
 * → parabolic interpolation.
 */
export function yinPitch(x: Float32Array, sr: number, opts: { fmin?: number; fmax?: number; threshold?: number; frame?: number } = {}): PitchTrack {
  const fmin = opts.fmin ?? 65, fmax = opts.fmax ?? 450, threshold = opts.threshold ?? 0.15;
  const hop = Math.round(sr * HOP_SEC);
  const tauMax = Math.floor(sr / fmin);
  const tauMin = Math.max(2, Math.floor(sr / fmax));
  const W = opts.frame ?? tauMax; // integration window
  const frames = Math.max(0, Math.floor((x.length - W - tauMax) / hop) + 1);
  const f0 = new Float32Array(Math.max(frames, 0));
  const d = new Float32Array(tauMax + 1);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    // energy gate: skip near-silent frames
    let e = 0;
    for (let k = 0; k < W; k++) e += x[off + k] * x[off + k];
    if (e / W < 1e-6) { f0[f] = 0; continue; }
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let k = 0; k < W; k++) { const diff = x[off + k] - x[off + k + tau]; s += diff * diff; }
      d[tau] = s;
    }
    // cumulative mean normalised difference
    let running = 0;
    d[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) { running += d[tau]; d[tau] = running > 0 ? (d[tau] * tau) / running : 1; }
    let tauEst = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (d[tau] < threshold) {
        while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
        tauEst = tau; break;
      }
    }
    if (tauEst < 0) { f0[f] = 0; continue; }
    // parabolic interpolation
    const a = d[tauEst - 1] ?? d[tauEst], b = d[tauEst], c = d[tauEst + 1] ?? d[tauEst];
    const denom = a + c - 2 * b;
    const shift = denom !== 0 ? (a - c) / (2 * denom) : 0;
    f0[f] = sr / (tauEst + shift);
  }
  return { f0, hop: HOP_SEC };
}

/** RMS envelope in dBFS, 25 ms windows every 10 ms. */
export function rmsEnvelopeDb(x: Float32Array, sr: number): Float32Array {
  const hop = Math.round(sr * HOP_SEC), win = Math.round(sr * 0.025);
  const n = Math.max(0, Math.floor((x.length - win) / hop) + 1);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    const off = f * hop;
    for (let k = 0; k < win; k++) s += x[off + k] * x[off + k];
    out[f] = 10 * Math.log10(s / win + 1e-10);
  }
  return out;
}

function percentile(arr: ArrayLike<number>, q: number): number {
  const a = Array.from(arr).sort((p, r) => p - r);
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))))];
}

export interface Segment { start: number; end: number }

/** Speech/non-speech segmentation on the dB envelope with an adaptive floor. */
export function segmentSpeech(db: Float32Array, opts: { minGap?: number; minSpeech?: number } = {}): Segment[] {
  if (!db.length) return [];
  const floor = percentile(db, 0.1), peak = percentile(db, 0.98);
  // 9 dB above the noise floor — but when the clip is almost all speech the 10th
  // percentile *is* speech, so never sit closer than 20 dB below the peak.
  const thr = Math.max(Math.min(floor + 9, peak - 20), peak - 40, -60);
  const minGapFrames = Math.round((opts.minGap ?? 0.15) / HOP_SEC);
  const minSpeechFrames = Math.round((opts.minSpeech ?? 0.06) / HOP_SEC);
  const raw: Segment[] = [];
  let start = -1;
  for (let i = 0; i < db.length; i++) {
    const on = db[i] > thr;
    if (on && start < 0) start = i;
    if (!on && start >= 0) { raw.push({ start, end: i }); start = -1; }
  }
  if (start >= 0) raw.push({ start, end: db.length });
  const merged: Segment[] = [];
  for (const s of raw) {
    const last = merged[merged.length - 1];
    if (last && s.start - last.end < minGapFrames) last.end = s.end; else merged.push({ ...s });
  }
  return merged.filter((s) => s.end - s.start >= minSpeechFrames).map((s) => ({ start: s.start * HOP_SEC, end: s.end * HOP_SEC }));
}

/**
 * Syllable nuclei ≈ intensity peaks inside voiced speech that stand ≥ 2 dB
 * above the surrounding dips (after de Jong & Wempe, 2009). Returns the
 * duration of each nucleus' vocalic interval (region within 3 dB of the peak).
 */
export function vocalicIntervals(db: Float32Array, f0: Float32Array, segments: Segment[]): { peaks: number[]; durations: number[][] } {
  const smooth = new Float32Array(db.length);
  for (let i = 0; i < db.length; i++) {
    let s = 0, c = 0;
    for (let k = -3; k <= 3; k++) { const v = db[i + k]; if (v !== undefined) { s += v; c++; } }
    smooth[i] = s / c;
  }
  const peaks: number[] = [];
  const durations: number[][] = [];
  for (const seg of segments) {
    const a = Math.round(seg.start / HOP_SEC), b = Math.min(smooth.length, Math.round(seg.end / HOP_SEC));
    const segDur: number[] = [];
    let lastPeak = -100;
    for (let i = a + 1; i < b - 1; i++) {
      if (!(smooth[i] >= smooth[i - 1] && smooth[i] > smooth[i + 1])) continue;
      if (!(f0[i] > 0 || f0[i - 1] > 0 || f0[i + 1] > 0)) continue; // must be voiced
      // prominence: must exceed the minimum on both sides (until a higher sample) by 2 dB
      let l = i, r = i, minL = smooth[i], minR = smooth[i];
      while (l > a && smooth[l - 1] <= smooth[i]) { l--; minL = Math.min(minL, smooth[l]); }
      while (r < b - 1 && smooth[r + 1] <= smooth[i]) { r++; minR = Math.min(minR, smooth[r]); }
      if (smooth[i] - Math.max(minL, minR) < 2 && !(l === a && r === b - 1)) continue;
      if (i - lastPeak < 8) continue; // ≥ 80 ms between nuclei
      lastPeak = i;
      peaks.push(i * HOP_SEC);
      let s = i, e = i;
      while (s > a && smooth[s - 1] > smooth[i] - 3) s--;
      while (e < b - 1 && smooth[e + 1] > smooth[i] - 3) e++;
      segDur.push((e - s + 1) * HOP_SEC);
    }
    durations.push(segDur);
  }
  return { peaks, durations };
}

/**
 * Normalised Pairwise Variability Index over successive vocalic intervals:
 * nPVI = 100/(m−1) · Σ |d_k − d_{k+1}| / ((d_k + d_{k+1}) / 2).
 * Computed within inter-pause runs; stress-timed British English ≈ 55–65,
 * syllable-timed speech ≈ 35–45.
 */
export function nPVI(runs: number[][]): number {
  let sum = 0, count = 0;
  for (const d of runs) {
    for (let k = 0; k + 1 < d.length; k++) {
      const m = (d[k] + d[k + 1]) / 2;
      if (m > 0) { sum += Math.abs(d[k] - d[k + 1]) / m; count++; }
    }
  }
  return count ? (100 * sum) / count : 0;
}

export interface ProsodyMetrics {
  duration: number;
  speakingTime: number;
  segments: Segment[];
  /** silent gaps > 400 ms between speech (lexical-retrieval hesitations) */
  longPauses: Segment[];
  pauseRatio: number;
  syllables: number;
  syllableRate: number;
  npvi: number;
  f0MedianHz: number;
  f0RangeSt: number;
  /** semitone slope over the final 500 ms of voicing (negative = falling) */
  finalSlopeSt: number;
  /** decimated contour for the UI: [time, semitones re 100 Hz] */
  contour: [number, number][];
}

export const HESITATION_SEC = 0.4;

export function hzToSt(hz: number, ref = 100): number {
  return 12 * Math.log2(hz / ref);
}

/** Half-band decimation with a short FIR low-pass (16 kHz → 8 kHz). */
export function decimate2(x: Float32Array): Float32Array {
  const h = [-0.0106, 0, 0.0329, 0, -0.0827, 0, 0.3099, 0.5, 0.3099, 0, -0.0827, 0, 0.0329, 0, -0.0106];
  const half = (h.length - 1) / 2;
  const out = new Float32Array(Math.floor(x.length / 2));
  for (let n = 0; n < out.length; n++) {
    let s = 0;
    const c = 2 * n;
    for (let k = 0; k < h.length; k++) { const v = x[c + k - half]; if (v !== undefined) s += h[k] * v; }
    out[n] = s;
  }
  return out;
}

export function analyzeProsody(x: Float32Array, sr: number): ProsodyMetrics {
  const duration = x.length / sr;
  const db = rmsEnvelopeDb(x, sr);
  // Pitch is estimated on a 2× decimated signal (speech F0 < 450 Hz), which
  // makes YIN ~4× cheaper with no loss of accuracy in the voice range.
  const { f0: rawF0 } = yinPitch(decimate2(x), sr / 2);
  // align f0 frames to the envelope frames and median-smooth octave jumps
  const f0 = new Float32Array(db.length);
  for (let i = 0; i < f0.length; i++) f0[i] = rawF0[i] ?? 0;
  const segments = segmentSpeech(db);
  // unvoice f0 outside speech segments
  const inSpeech = new Uint8Array(db.length);
  for (const s of segments) for (let i = Math.round(s.start / HOP_SEC); i < Math.min(db.length, Math.round(s.end / HOP_SEC)); i++) inSpeech[i] = 1;
  for (let i = 0; i < f0.length; i++) if (!inSpeech[i]) f0[i] = 0;
  const voiced = Array.from(f0).filter((v) => v > 0);
  const med = voiced.length ? percentile(voiced, 0.5) : 0;
  // octave-error cleanup: drop values more than ~an octave from the median
  if (med > 0) for (let i = 0; i < f0.length; i++) if (f0[i] > 0 && (f0[i] > med * 1.9 || f0[i] < med / 1.9)) f0[i] = 0;
  // 5-point median filter inside voiced runs removes single-frame octave errors.
  const sm = f0.slice();
  for (let i = 2; i < f0.length - 2; i++) {
    if (f0[i] <= 0) continue;
    const win = [f0[i - 2], f0[i - 1], f0[i], f0[i + 1], f0[i + 2]].filter((v) => v > 0).sort((a, b) => a - b);
    sm[i] = win[Math.floor(win.length / 2)];
  }
  f0.set(sm);
  const cleaned = Array.from(f0).filter((v) => v > 0);

  const longPauses: Segment[] = [];
  for (let k = 0; k + 1 < segments.length; k++) {
    const gap = { start: segments[k].end, end: segments[k + 1].start };
    if (gap.end - gap.start > HESITATION_SEC) longPauses.push(gap);
  }
  const speakingTime = segments.reduce((s, g) => s + (g.end - g.start), 0);
  const span = segments.length ? segments[segments.length - 1].end - segments[0].start : 0;
  const { peaks, durations } = vocalicIntervals(db, f0, segments);

  let f0RangeSt = 0;
  if (cleaned.length > 10) f0RangeSt = hzToSt(percentile(cleaned, 0.9)) - hzToSt(percentile(cleaned, 0.1));

  // final contour slope (least squares over the last 500 ms of voicing)
  let finalSlopeSt = 0;
  const voicedIdx: number[] = [];
  for (let i = 0; i < f0.length; i++) if (f0[i] > 0) voicedIdx.push(i);
  if (voicedIdx.length > 8) {
    const lastT = voicedIdx[voicedIdx.length - 1];
    const tail = voicedIdx.filter((i) => i >= lastT - 50);
    const xs = tail.map((i) => i * HOP_SEC), ys = tail.map((i) => hzToSt(f0[i]));
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0, den = 0;
    for (let k = 0; k < xs.length; k++) { num += (xs[k] - mx) * (ys[k] - my); den += (xs[k] - mx) ** 2; }
    finalSlopeSt = den > 0 ? num / den : 0;
  }

  const contour: [number, number][] = [];
  const step = Math.max(1, Math.floor(f0.length / 300));
  for (let i = 0; i < f0.length; i += step) if (f0[i] > 0) contour.push([i * HOP_SEC, hzToSt(f0[i])]);

  return {
    duration,
    speakingTime,
    segments,
    longPauses,
    pauseRatio: span > 0 ? longPauses.reduce((s, p) => s + (p.end - p.start), 0) / span : 0,
    syllables: peaks.length,
    syllableRate: speakingTime > 0 ? peaks.length / speakingTime : 0,
    npvi: nPVI(durations),
    f0MedianHz: cleaned.length ? percentile(cleaned, 0.5) : 0,
    f0RangeSt,
    finalSlopeSt,
    contour,
  };
}

// ---------------------------------------------------------------------------
// Comparison against a reference rendering (listen-and-repeat)
// ---------------------------------------------------------------------------

/**
 * Time-normalised pitch shape: the voiced contour over the speech span,
 * averaged into `bins` and expressed in semitones relative to the speaker's
 * own median (so male/female and register differences cancel out).
 */
export function contourShape(p: ProsodyMetrics, bins = 40): (number | null)[] {
  const a = p.segments[0]?.start ?? 0;
  const b = p.segments[p.segments.length - 1]?.end ?? p.duration;
  const span = b - a;
  const out: (number | null)[] = new Array(bins).fill(null);
  if (span <= 0 || p.contour.length < 5) return out;
  const sums = new Array(bins).fill(0), counts = new Array(bins).fill(0);
  for (const [t, st] of p.contour) {
    const k = Math.floor(((t - a) / span) * bins);
    if (k < 0 || k >= bins) continue;
    sums[k] += st; counts[k]++;
  }
  const vals = p.contour.map((c) => c[1]).sort((x, y) => x - y);
  const med = vals[Math.floor(vals.length / 2)];
  for (let k = 0; k < bins; k++) if (counts[k]) out[k] = sums[k] / counts[k] - med;
  return out;
}

export interface ProsodyComparison {
  /** Pearson correlation of the time-normalised pitch shapes (−1…1), null if too little voicing */
  shapeCorr: number | null;
  /** your pitch range ÷ the reference's */
  rangeRatio: number;
  /** your speaking time ÷ the reference's */
  tempoRatio: number;
  npviRef: number;
  /** combined intonation similarity 0…1 */
  intonation: number;
  /** rhythm similarity 0…1 */
  rhythm: number;
  /** tempo acceptability 0…1 */
  tempo: number;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function compareProsody(user: ProsodyMetrics, ref: ProsodyMetrics): ProsodyComparison {
  const u = contourShape(user), r = contourShape(ref);
  const xs: number[] = [], ys: number[] = [];
  u.forEach((v, k) => { if (v !== null && r[k] !== null) { xs.push(v); ys.push(r[k] as number); } });
  let shapeCorr: number | null = null;
  if (xs.length >= 8) {
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length, my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let num = 0, dx = 0, dy = 0;
    for (let k = 0; k < xs.length; k++) { num += (xs[k] - mx) * (ys[k] - my); dx += (xs[k] - mx) ** 2; dy += (ys[k] - my) ** 2; }
    shapeCorr = dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
  }
  const rangeRatio = ref.f0RangeSt > 0.5 ? user.f0RangeSt / ref.f0RangeSt : 1;
  const tempoRatio = ref.speakingTime > 0 ? user.speakingTime / ref.speakingTime : 1;
  const shape = shapeCorr === null ? 0.6 : clamp01((shapeCorr + 0.1) / 0.8);
  const range = clamp01(rangeRatio / 0.8);
  const intonation = 0.65 * shape + 0.35 * range;
  const rhythm = user.syllables < 4 || ref.syllables < 4 ? 0.7 : clamp01(1 - Math.abs(user.npvi - ref.npvi) / 25);
  // Learners may be a little slower than the model voice; > 1.6× slower or rushing < 0.75× is penalised.
  const tempo = tempoRatio < 0.75 ? clamp01(1 - (0.75 - tempoRatio) * 3) : tempoRatio > 1.6 ? clamp01(1 - (tempoRatio - 1.6) * 1.5) : 1;
  return { shapeCorr, rangeRatio, tempoRatio, npviRef: ref.npvi, intonation, rhythm, tempo };
}
