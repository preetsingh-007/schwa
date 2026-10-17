import { normalizeAcousticToken } from './ipa';
import type { ProducedPhone } from '../services/ipaAligner';

export const CTC_FRAME_SEC = 0.02; // wav2vec2 conv stack stride = 320 samples at 16 kHz

/**
 * Greedy CTC decoding of [T × V] logits into canonical phones with timings.
 * Each phone keeps the raw model token (`tok`) so calibration can tell an
 * /r/ that came from an r-coloured unit like "ɑːɹ" from a standalone "ɹ".
 */
export function ctcGreedy(data: Float32Array, T: number, V: number, vocab: string[], offsetSec = 0): ProducedPhone[] {
  const out: ProducedPhone[] = [];
  let prev = -1, runStart = 0;
  const flush = (id: number, s: number, e: number) => {
    const tok = vocab[id];
    if (!tok) return;
    const phones = normalizeAcousticToken(tok);
    const t0 = offsetSec + s * CTC_FRAME_SEC, t1 = offsetSec + (e + 1) * CTC_FRAME_SEC;
    const dt = (t1 - t0) / Math.max(1, phones.length);
    phones.forEach((p, k) => out.push({ p, start: t0 + k * dt, end: t0 + (k + 1) * dt, tok }));
  };
  for (let t = 0; t < T; t++) {
    let best = 0, bv = -Infinity;
    const off = t * V;
    for (let v = 0; v < V; v++) { const x = data[off + v]; if (x > bv) { bv = x; best = v; } }
    if (best !== prev) {
      if (prev > 0) flush(prev, runStart, t - 1);
      prev = best; runStart = t;
    }
  }
  if (prev > 0) flush(prev, runStart, T - 1);
  return out;
}
