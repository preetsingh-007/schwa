// Helpers for driving schwa itself: reading the prompt, switching modes,
// skipping off camera, and taking a spoken turn through the virtual mic.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from './session.mjs';

const ROOT = new URL('../../../', import.meta.url).pathname;

// ---- what the learner says: model answers and British headwords ----
const promptFiles = [join(ROOT, 'public/data/prompts_tiered.json'), ...readdirSync(join(ROOT, 'public/prompts')).filter((f) => f.startsWith('tier')).map((f) => join(ROOT, 'public/prompts', f))];
export const REFERENCE = new Map();
for (const f of promptFiles) {
  const d = JSON.parse(readFileSync(f, 'utf8'));
  for (const p of Array.isArray(d) ? d : d.prompts) if (p.reference) REFERENCE.set(p.text.trim(), p.reference);
}
const US_TO_UK = new Map(), GLOSS_TO_UK = new Map();
for (const f of readdirSync(join(ROOT, 'public/lexicon')).filter((x) => x.startsWith('cards-'))) {
  for (const c of JSON.parse(readFileSync(join(ROOT, 'public/lexicon', f), 'utf8'))) {
    if (c.us_equivalent) US_TO_UK.set(c.us_equivalent.trim(), c.headword);
    if (c.gloss) GLOSS_TO_UK.set(c.gloss.trim(), c.headword);
  }
}

export function appHelpers(s) {
  const page = () => s.page;
  const text = async (sel) => ((await page().locator(sel).first().textContent({ timeout: 2000 }).catch(() => '')) ?? '').trim();
  const promptText = () => text('.prompt-text');
  const promptLabel = () => text('.prompt-head .label');
  const modeLabel = () => text('.chip.tier');

  async function cycleTo(label) {
    for (let i = 0; i < 7 && (await modeLabel()) !== label; i++) { await s.click('.chip.tier', { pause: 500 }); await page().waitForTimeout(300); }
  }
  /** Skip prompts off camera until pred(text, label) holds. */
  async function skipUntil(pred, max = 40) {
    for (let i = 0; i < max; i++) {
      const t = await promptText(), l = await promptLabel();
      if (t && await pred(t, l)) return t;
      const was = s.rec.paused; s.rec.pause();
      await page().locator('button[aria-label="Skip prompt"]').click();
      await page().waitForTimeout(500);
      if (!was) s.rec.resume();
    }
    throw new Error('no matching prompt');
  }
  /** One spoken turn: tap the mic, speak, tap again. Returns the reward (null if none). */
  async function turn(answer, { accent, speed, onStop } = {}) {
    // Have the clip ready before the mic opens: the app's time limit runs in real time
    // even while the recording is paused for a render.
    const wasPaused = s.rec.paused; s.rec.pause();
    await s.learnerClip(answer, accent, speed);
    if (!wasPaused) s.rec.resume();
    const before = await text('.score-hero');
    await s.click('.mic', { pause: 150 });
    await page().waitForSelector('.mic.rec', { timeout: 5000 });
    await sleep(250);
    await s.speak(answer, { accent, speed });
    await sleep(350);
    if (await page().$('.mic.rec')) await s.click('.mic', { pause: 100 });
    onStop?.();
    await page().waitForFunction(() => !document.querySelector('.mic.busy') && !document.querySelector('.mic.rec'), null, { timeout: 120000 });
    const score = await text('.score-hero');
    if (!score || (score === before && !(await page().$('.verdict')))) return null;
    return { score: Number(score), passed: !!(await page().$('.verdict.pass')) };
  }
  /** What the learner says for the prompt on screen (null = can't answer). */
  async function answerFor(t, l) {
    if (l.startsWith('Words · name it')) {
      const us = t.match(/^American: “(.+)”\./)?.[1];
      const uk = us ? US_TO_UK.get(us) : GLOSS_TO_UK.get(t);
      return uk ? `In Britain we say ${uk}.` : null;
    }
    if (l.startsWith('Tier 2')) return REFERENCE.get(t) ?? null;
    if (l.startsWith('Tier 3')) return null;
    return t; // read aloud / listen & repeat
  }
  return { page, text, promptText, promptLabel, cycleTo, skipUntil, turn, answerFor };
}
