/**
 * Endless listen-and-repeat corpus (Tatoeba sentences + public-domain British
 * prose), graded into 12 levels and fetched one level at a time.
 */
import { RP_PHONEMES } from '../lib/ipa';
import type { CorpusIndex, CorpusRow, Prompt, SessionLog } from '../types';

export const MAX_LEVEL = 12;
let indexP: Promise<CorpusIndex> | null = null;
const levels = new Map<number, Promise<Prompt[]>>();

export function loadCorpusIndex(): Promise<CorpusIndex> {
  indexP ??= fetch(`${import.meta.env.BASE_URL}corpus/index.json`).then((r) => {
    if (!r.ok) throw new Error('corpus index unavailable');
    return r.json() as Promise<CorpusIndex>;
  }).catch((e) => { indexP = null; throw e; });
  return indexP;
}

export function encodePhonemes(ph: string[]): string {
  return ph.map((p) => RP_PHONEMES.indexOf(p)).filter((i) => i >= 0).map((i) => String.fromCharCode(48 + i)).join('');
}
export function decodePhonemes(s: string | undefined): string[] {
  if (!s) return [];
  return [...s].map((c) => RP_PHONEMES[c.charCodeAt(0) - 48]).filter((p): p is string => !!p);
}

export function rowToPrompt(row: CorpusRow, level: number, index: CorpusIndex): Prompt {
  const isTatoeba = row.src === 'tatoeba';
  const src = index.sources.find((s) => s.id === row.src);
  const words = row.text.split(/\s+/).length;
  return {
    id: row.id,
    tier: 1,
    mode: 'shadow',
    level,
    category: isTatoeba ? 'sentence' : 'passage',
    title: isTatoeba ? `Level ${level} · everyday sentence` : `Level ${level} · ${row.by.split(' — ')[0]}`,
    text: row.text,
    reference: row.text,
    targetVocab: [],
    timeLimitSec: Math.min(50, Math.max(8, Math.round(words * 0.6 + 5))),
    phonemes: decodePhonemes(row.ph),
    source: isTatoeba
      ? { name: `Tatoeba #${row.id.slice(2)}`, by: row.by, license: 'CC BY 2.0 FR', url: `https://tatoeba.org/en/sentences/show/${row.id.slice(2)}` }
      : { name: row.by, license: 'Public domain', url: src?.url ?? 'https://www.gutenberg.org/' },
  };
}

export function loadLevel(level: number): Promise<Prompt[]> {
  const L = Math.min(MAX_LEVEL, Math.max(1, Math.round(level)));
  let p = levels.get(L);
  if (!p) {
    p = (async () => {
      const index = await loadCorpusIndex();
      const meta = index.levels.find((x) => x.level === L);
      if (!meta) return [];
      const r = await fetch(`${import.meta.env.BASE_URL}corpus/${meta.file}`);
      if (!r.ok) throw new Error(`corpus level ${L} unavailable`);
      const rows = (await r.json()) as CorpusRow[];
      return rows.map((row) => rowToPrompt(row, L, index));
    })().catch((e) => { levels.delete(L); throw e; });
    levels.set(L, p);
  }
  return p;
}

/** Download the current and next level in the background so practice continues offline. */
export function warmLevels(level: number): void {
  for (const L of [level, level + 1]) if (L >= 1 && L <= MAX_LEVEL) void loadLevel(L).catch(() => undefined);
}

/**
 * Level progression from the most recent listen-and-repeat turns at the
 * current level: promote after ≥ 12 turns with a ≥ 70 % pass rate and mean
 * reward ≥ 75; step back after ≥ 8 turns averaging under 50.
 */
export function nextShadowLevel(level: number, recentAtLevel: Pick<SessionLog, 'reward' | 'passed'>[]): number {
  const last = recentAtLevel.slice(0, 15);
  if (last.length >= 12) {
    const pass = last.filter((s) => s.passed).length / last.length;
    const mean = last.reduce((s, x) => s + x.reward, 0) / last.length;
    if (pass >= 0.7 && mean >= 75) return Math.min(MAX_LEVEL, level + 1);
  }
  const last8 = recentAtLevel.slice(0, 8);
  if (last8.length >= 8 && level > 1 && last8.reduce((s, x) => s + x.reward, 0) / last8.length < 50) return level - 1;
  return level;
}
