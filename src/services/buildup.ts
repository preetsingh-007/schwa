/**
 * Build-up: when a sentence keeps failing, break it down. First the words
 * that went wrong, one at a time; then the sentence rebuilt from the end
 * ("ten" → "half past ten" → …) so every step keeps the natural final fall;
 * then the whole sentence again. Phrases, not just words, so weak forms and
 * linking survive (an isolated "to" is never reduced to /tə/).
 */
import { normalizeWord } from '../lib/connectedSpeech';
import { tokenize } from './redundancy';
import type { TurnResult } from './evaluate';
import type { Prompt } from '../types';

/** Failed attempts at a sentence before offering to break it down. */
export const BUILDUP_AFTER = 3;
/** Failed attempts at one step before moving on anyway. */
export const STEP_TRIES = 2;
const MAX_WORDS = 3;

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean);

/** Sentence-type prompts that can be broken down (not free speech, not a single word, not a step itself). */
export function canBuildUp(p: Prompt): boolean {
  return p.tier === 1 && p.mode !== 'nameit' && p.drill?.kind !== 'buildup' && words(p.reference ?? p.text).length >= 3;
}

export function shouldBuildUp(p: Prompt, failedAttempts: number): boolean {
  return canBuildUp(p) && failedAttempts >= BUILDUP_AFTER;
}

/** Up to three words to drill: mispronounced ones first, then ones that weren't heard at all. */
export function problemWords(text: string, r: Pick<TurnResult, 'alignment' | 'transcript'>): string[] {
  const out: string[] = [];
  const add = (w: string) => {
    const clean = w.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
    if (clean && !out.some((o) => normalizeWord(o) === normalizeWord(clean))) out.push(clean);
  };
  const aw = r.alignment?.words ?? [];
  for (const w of aw) if (w.status === 'error') add(w.text);
  if (out.length < MAX_WORDS) {
    const heard = new Set(tokenize(r.transcript));
    for (const w of words(text)) if (!heard.has(tokenize(w)[0] ?? '')) add(w);
  }
  if (!out.length) for (const w of aw) if (w.status === 'drift') add(w.text);
  // keep sentence order
  const order = words(text).map((w) => normalizeWord(w.replace(/[^\p{L}\p{N}']/gu, '')));
  return out.slice(0, MAX_WORDS).sort((a, b) => order.indexOf(normalizeWord(a)) - order.indexOf(normalizeWord(b)));
}

/** Phrases taken from the end of the sentence, each longer than the last, all shorter than the sentence. */
export function backchain(text: string): string[] {
  const w = words(text);
  const n = w.length;
  const lengths = [Math.min(3, n - 1), Math.round(n * 0.65)].filter((l, i, a) => l >= 2 && l < n && (i === 0 || l > a[i - 1]));
  return lengths.map((l) => w.slice(n - l).join(' '));
}

/** The build-up steps for a failed sentence; empty if there's nothing useful to break down. */
export function planBuildUp(parent: Prompt, r: Pick<TurnResult, 'alignment' | 'transcript'>): Prompt[] {
  const text = parent.reference ?? parent.text;
  const parts = [
    ...problemWords(text, r).map((t) => ({ text: t, part: 'word' as const })),
    ...backchain(text).map((t) => ({ text: t, part: 'phrase' as const })),
  ];
  if (parts.length < 2) return [];
  return parts.map((s, step) => ({
    id: `bu:${parent.id}:${step}`,
    tier: 1,
    mode: 'shadow',
    category: 'buildup',
    title: s.part === 'word' ? 'Just this word' : 'Build it back up',
    text: s.text,
    reference: s.text,
    targetVocab: [],
    timeLimitSec: Math.max(5, Math.round(words(s.text).length * 0.7 + 4)),
    drill: { kind: 'buildup', parent, step, steps: parts.length, part: s.part },
  }));
}
