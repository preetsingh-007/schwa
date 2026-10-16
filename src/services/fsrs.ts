/**
 * FSRS-4.5 spaced-repetition scheduler (Free Spaced Repetition Scheduler,
 * default weights). Grades come from spoken performance, never button taps:
 * 1 Again · 2 Hard · 3 Good · 4 Easy.
 */
import type { VocabCard } from '../types';

export const FSRS_W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];
const DECAY = -0.5;
const FACTOR = 19 / 81; // so that R(S, S) = 0.9
const DAY = 86_400_000;
export const REQUEST_RETENTION = 0.9;

export type Grade = 1 | 2 | 3 | 4;

export function retrievability(elapsedDays: number, stability: number): number {
  if (stability <= 0) return 0;
  return Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / stability, DECAY);
}

/** P_recall(v, t) used by the bandit; unseen items have recall 0. */
export function recallProbability(card: VocabCard | undefined, now: number): number {
  if (!card || card.lastReview === null) return 0;
  return retrievability((now - card.lastReview) / DAY, card.stability);
}

export function intervalDays(stability: number, retention = REQUEST_RETENTION): number {
  return Math.max(1, Math.round((stability / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1)));
}

const clampD = (d: number) => Math.min(10, Math.max(1, d));
const initStability = (g: Grade) => Math.max(0.1, FSRS_W[g - 1]);
const initDifficulty = (g: Grade) => clampD(FSRS_W[4] - (g - 3) * FSRS_W[5]);

export function newCard(id: string, now: number): VocabCard {
  return { id, stability: 0, difficulty: 5, reps: 0, lapses: 0, lastReview: null, due: now, tau: 0, history: [], updatedAt: now };
}

export function review(card: VocabCard, grade: Grade, now: number, ctx: 'tier1' | 'tier2' | 'tier3'): VocabCard {
  let { stability: S, difficulty: D } = card;
  if (card.reps === 0 || card.lastReview === null) {
    S = initStability(grade);
    D = initDifficulty(grade);
  } else {
    const R = retrievability((now - card.lastReview) / DAY, S);
    // mean-reverting difficulty update
    D = clampD(FSRS_W[7] * initDifficulty(4) + (1 - FSRS_W[7]) * (D - FSRS_W[6] * (grade - 3)));
    if (grade === 1) {
      S = FSRS_W[11] * Math.pow(D, -FSRS_W[12]) * (Math.pow(S + 1, FSRS_W[13]) - 1) * Math.exp(FSRS_W[14] * (1 - R));
    } else {
      const hard = grade === 2 ? FSRS_W[15] : 1;
      const easy = grade === 4 ? FSRS_W[16] : 1;
      S = S * (1 + Math.exp(FSRS_W[8]) * (11 - D) * Math.pow(S, -FSRS_W[9]) * (Math.exp(FSRS_W[10] * (1 - R)) - 1) * hard * easy);
    }
  }
  S = Math.max(0.1, S);
  const days = grade === 1 ? 0 : intervalDays(S);
  return {
    ...card,
    stability: S,
    difficulty: D,
    reps: card.reps + 1,
    lapses: card.lapses + (grade === 1 && card.reps > 0 ? 1 : 0),
    lastReview: now,
    due: grade === 1 ? now + 10 * 60_000 : now + days * DAY,
    history: [...card.history, { t: now, grade, ctx }].slice(-50),
    updatedAt: now,
  };
}
