// Records the tutorial: real turns in the running app, scored by the real
// on-device models. The learner's voice is synthesised (Kokoro) and played
// into a virtual microphone; everything else is the app as shipped.
//
//   node scripts/demo/record-tutorial.mjs <outDir> <profileDir> <cacheDir>
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Session, sleep } from './lib/session.mjs';

const [outDir, profile, cacheDir] = process.argv.slice(2);
// ONLY="Tier 2 · Lexical compression,…" records just those chapters (a pick-up take).
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const ROOT = new URL('../../', import.meta.url).pathname;
const s = new Session(outDir, { profile, cacheDir });

// ---- content lookups (answers the learner gives) ----
const promptFiles = [join(ROOT, 'public/data/prompts_tiered.json'), ...readdirSync(join(ROOT, 'public/prompts')).filter((f) => f.startsWith('tier')).map((f) => join(ROOT, 'public/prompts', f))];
const REFERENCE = new Map();
for (const f of promptFiles) {
  const d = JSON.parse(readFileSync(f, 'utf8'));
  for (const p of Array.isArray(d) ? d : d.prompts) if (p.reference) REFERENCE.set(p.text.trim(), p.reference);
}
const US_TO_UK = new Map(), GLOSS_TO_UK = new Map();
for (const f of readdirSync(join(ROOT, 'public/lexicon')).filter((f) => f.startsWith('cards-'))) {
  for (const c of JSON.parse(readFileSync(join(ROOT, 'public/lexicon', f), 'utf8'))) {
    if (c.us_equivalent) US_TO_UK.set(c.us_equivalent.trim(), c.headword);
    if (c.gloss) GLOSS_TO_UK.set(c.gloss.trim(), c.headword);
  }
}

// ---- app helpers ----
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

/** One spoken turn. Returns the reward (null if nothing came back). */
async function turn(answer, { accent, speed, space = false, narrate } = {}) {
  const before = await text('.score-hero');
  if (space) {
    await page().evaluate(() => document.activeElement?.blur());
    await s.keycap('hold <b>Space</b> to talk');
    await page().keyboard.down('Space');
  } else {
    await s.click('.mic', { pause: 150 });
  }
  await page().waitForSelector('.mic.rec', { timeout: 5000 });
  await sleep(250);
  await s.speak(answer, { accent, speed });
  await sleep(350);
  if (space) { await page().keyboard.up('Space'); await s.keycap(''); }
  else if (await page().$('.mic.rec')) await s.click('.mic', { pause: 100 });
  const talk = narrate ? s.say(narrate, { wait: false }) : Promise.resolve();
  await page().waitForFunction(() => !document.querySelector('.mic.busy') && !document.querySelector('.mic.rec'), null, { timeout: 120000 });
  await talk;
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

async function main() {
  await s.launch();
  // Fresh learner state; the model cache (Cache Storage) survives.
  await page().goto(s.url);
  await page().evaluate(async () => { localStorage.setItem('__demoSeed', '11'); await new Promise((r) => { const q = indexedDB.deleteDatabase('lexiphon'); q.onsuccess = q.onerror = q.onblocked = r; }); });
  await page().goto(s.url);
  await page().getByRole('button', { name: 'Load offline engine' }).click();
  await page().waitForSelector('.mic', { timeout: 300000 });
  await page().mouse.move(640, 420);
  await page().waitForTimeout(1500);
  await s.rec.start();
  /** Run one chapter; if it throws, cut it from the video, tidy the UI and carry on. */
  const run = async (title, fn) => {
    if (ONLY && !ONLY.has(title)) return;
    const cp = s.rec.checkpoint();
    s.rec.mark('chapter', { title }); console.log('##', title);
    try { await fn(); } catch (e) {
      console.log(`!! chapter "${title}" dropped:`, e.message);
      s.rec.rewind(cp);
      for (const sel of ['.popover button[aria-label="Close"]', '.drawer button[aria-label="Close"]', 'button[aria-label="Back to practice"]', 'button[aria-label="Toggle hands-free commute mode"][aria-pressed="true"]']) {
        if (await page().$(sel)) await page().locator(sel).first().click().catch(() => undefined);
      }
      await s.scrollTop();
    }
  };

  // ------------------------------------------------------------------ arena
  await run('The practice arena', async () => {
    await s.say('This is the practice arena. Every turn is spoken. You read, repeat or answer aloud, and LexiPhon coaches your pronunciation, your rhythm, and your choice of words.');
    await s.moveTo('.chip.tier');
    await s.say('The mode chip chooses what you practise. Auto lets the app decide. Let\'s step through the tiers, starting with Tier 1.');
    await cycleTo('Tier 1');
  });

  // ------------------------------------------------------------------ tier 1
  await run('Tier 1 · Read aloud', async () => {
    let t1, first;
    for (let attempt = 0; attempt < 6; attempt++) {
      const cp = s.rec.checkpoint();
      t1 = await skipUntil((t) => /r/i.test(t.replace(/r(?=[aeiouy])/gi, '')) && t.split(/\s+/).length >= 5 && t.split(/\s+/).length <= 14);
      s.learnerClip(t1, 'l2'); s.learnerClip(t1);
      await s.say('Tier 1 is articulatory calibration: read the sentence aloud. Tap the microphone, and speak. Our learner\'s first try carries a few habits from another accent.');
      first = await turn(t1, { accent: 'l2', narrate: 'Three models now run inside the browser. Whisper hears the words you meant. A wav2vec2 model hears the sounds you actually made. And espeak builds the Modern R P target. Nothing leaves your device.' });
      if (first && !first.passed && await page().$('.ph.error')) break;
      console.log('retake: first attempt', first);
      s.rec.rewind(cp);
      await page().locator('button[aria-label="Skip prompt"]').click();
      await page().waitForTimeout(500);
    }
    await s.scrollTo('.scorebar', 'center');
    await s.say(`${first.score}. The reward blends phonetic accuracy with prosody, and a prompt only advances at eighty or above.`);
    await s.scrollTo('.tape', 'center');
    const errWord = await page().locator('.wcard:has(.ph.error) .w').first().textContent();
    await s.say(`Block B lines up the R P target, on top, against the sounds you produced, phoneme by phoneme. Red marks a real substitution. Look at "${errWord}".`);
    await s.click('.wcard:has(.ph.error) .u .ph.error', { pause: 600 });
    await s.say('Tap any phoneme to see the articulation behind it, with a tip to fix it, and replay that word from your own recording.');
    await s.click('.popover button[aria-label="Close"]', { pause: 400 });
    await s.scrollTo('.chart', 'center');
    await s.say('Block C plots your pitch over time, with stress timing, tempo, pauses, and how often you reduce vowels to schwa.');
    await s.scrollTop();
    await s.say('To move on, you have to say it again. You can also hold the space bar to talk.');
    let second = await turn(t1, { space: true });
    if (!second?.passed) second = await turn(t1, { space: true, speed: 0.95 });
    await s.scrollTo('.scorebar', 'center');
    await s.say(second?.passed ? `${second.score}. Passed. The motor pattern is locked in. Tap next, or press space, for a new prompt.` : `${second?.score}. Closer. Keep repeating until it passes.`);
    await s.scrollTop();
  });

  // ------------------------------------------------------------------ tier 2
  await run('Tier 2 · Lexical compression', async () => {
    await cycleTo('Tier 2');
    const t2 = await skipUntil((t) => t.split(/\s+/).length <= 42);
    s.learnerClip(t2, undefined, 1.12);
    await s.say('Tier 2 trains concision. Here is a long-winded message. Say the same thing, briefly, in ten seconds, using the target words.');
    const w2 = await turn(t2, { speed: 1.12, narrate: 'Reading it back word for word is exactly what not to do.' });
    await s.scrollTo('.diffline', 'center');
    const cut = (await page().locator('.diffline .cut:not(.minor)').first().textContent().catch(() => null))?.trim();
    const words = (await text('.diffline + .row')).match(/(\d+) words/)?.[1];
    const used = await page().locator('.pills .pill.used').count();
    await s.say(cut
      ? `Struck-through phrases are redundancies, and "${cut.replace(/[.,]$/, '')}" is critical. With a critical redundancy left in, it can't pass, however clear it sounded.`
      : `Struck-through phrases are redundancies. ${words ? `${words} words, ` : ''}${used ? '' : 'and neither target phrase. '}It scored ${w2?.score ?? 'below eighty'}.`);
    await s.scrollTo('.diffline', 'start');
    const ref2 = REFERENCE.get(t2) ?? await text('.retry .say');
    s.learnerClip(ref2);
    await s.say('Underneath is a one-line compressed target. Say that aloud.');
    await s.scrollTop();
    const c2 = await turn(ref2);
    await s.scrollTo('.scorebar', 'center');
    await s.say(c2?.passed ? `${c2.score}, and passed. The target words light up when you use them, and each one is now scheduled for spaced review.` : `${c2?.score}. Much tighter.`);
    await s.scrollTop();
  });

  // ------------------------------------------------------------------ tier 3
  await run('Tier 3 · Open monologue', async () => {
    await cycleTo('Tier 3');
    await page().waitForTimeout(500);
    await s.say('Tier 3 is an open monologue: a realistic workplace or social scenario. Speak for up to a minute or two, and you are scored on pronunciation, prosody, concision, and whether you stayed on topic.');
  });

  // ------------------------------------------------------------------ repeat
  await run('Listen & repeat', async () => {
    await cycleTo('Repeat');
    const t4 = await skipUntil((t) => t.split(/\s+/).length >= 6 && t.split(/\s+/).length <= 13);
    s.learnerClip(t4);
    await page().waitForFunction(() => !document.querySelector('.prompt-head ~ .row button[disabled]'), null, { timeout: 120000 }).catch(() => undefined);
    await s.waitAppAudio();
    await s.say('Listen and repeat is an endless course: over twenty-eight thousand sentences in twelve levels. A neural R P voice, running on your device, reads each one.');
    await s.click(page().getByRole('button', { name: 'Slow' }), { pause: 100 });
    await s.waitAppAudio(500);
    await s.say('Now repeat it. Copy the melody and the rhythm, not just the words.');
    const r4 = await turn(t4, { narrate: 'Here you are scored on pronunciation, and on how closely your melody, pitch range, tempo and rhythm match the reference voice saying the same sentence.' });
    await s.scrollTo('.chart', 'center');
    await s.say(`${r4?.score ?? ''}. The green dashed line is the R P voice, time-aligned to your own pitch contour in black. Pass enough sentences and you move up a level.`);
    await s.scrollTop();
  });

  // ------------------------------------------------------------------ words
  await run('Words · British vocabulary', async () => {
    await cycleTo('Words');
    // a one-word answer (eggplant → aubergine) makes the clearest demo
    const t5 = await skipUntil(async (t, l) => l.startsWith('Words · name it') && /^In Britain we say \S+( \S+)?\.$/.test((await answerFor(t, l)) ?? ''));
    const a5 = await answerFor(t5, 'Words · name it');
    s.learnerClip(a5);
    await s.say(/^American:/.test(t5)
      ? 'Words mode drills three thousand curated British cards and twenty thousand everyday words. In a name-it drill, you see the American term, and say the British one.'
      : 'Words mode drills three thousand curated British cards and twenty thousand everyday words. In a name-it drill, you see a picture, and say what Britons call it.');
    const r5 = await turn(a5);
    await s.say(r5?.passed ? 'Correct.' : 'Nearly.');
    if (await page().$('.pills .pill')) {
      await s.click('.pills .pill', { pause: 500 });
      await s.say('Every card has R P pronunciation, usage notes, examples, and a memory model that schedules your next review.');
      await s.click(page().locator('.vocabcard').getByRole('button', { name: 'RP' }), { pause: 200 });
      await s.waitAppAudio(400);
      await s.click('.vocabcard button[aria-label="Close"]', { pause: 400 });
    }
  });

  // ------------------------------------------------------------------ lexicon
  await run('The lexicon', async () => {
    await s.click('button[aria-label="Lexicon"]', { pause: 500 });
    await s.say('The book icon opens the lexicon. It searches every card and word, offline.');
    await s.type('.searchbox', 'Leicester');
    await page().waitForTimeout(800);
    await s.click('.lexitem', { pause: 700 });
    await s.say('Famously irregular place names get hand-authored R P, which overrides the spelling everywhere: on the card, in the scorer\'s target, and in the voice.');
    await s.click(page().locator('.vocabcard').getByRole('button', { name: 'RP' }), { pause: 200 });
    await s.waitAppAudio(500);
    await s.click('.vocabcard button[aria-label="Close"]', { pause: 300 });
    await s.click('button[aria-label="Back to practice"]', { pause: 400 });
  });

  // ------------------------------------------------------------------ warm-up (off camera)
  if (!ONLY || ONLY.has('Your progress')) {
    s.rec.pause();
    await cycleTo('Auto');
    let done = 0;
    for (let i = 0; i < 40 && done < 12; i++) {
      const t = await promptText(), l = await promptLabel();
      const a = await answerFor(t, l);
      if (!a || a.split(/\s+/).length > 22) { await page().locator('button[aria-label="Skip prompt"]').click(); await page().waitForTimeout(500); continue; }
      const r = await turn(a, { accent: done % 3 === 0 ? 'l2' : undefined }).catch((e) => { console.log('warm-up turn failed', e.message); return null; });
      done++;
      await page().locator('button[aria-label="Skip prompt"]').click();
      await page().waitForTimeout(600);
      console.log('warm-up', done, r);
    }
    await s.scrollTop();
    s.rec.resume();
  }

  // ------------------------------------------------------------------ dashboard
  await run('Your progress', async () => {
    await s.say('After a dozen more turns, the dashboard fills in.');
    await s.click('button[aria-label="Progress dashboard"]', { pause: 800 });
    await s.say('Every phoneme you attempt lands on this forty-four phoneme Modern R P heatmap. Green is solid. Amber and red need work.');
    await s.scrollTo('.grid2', 'start');
    await s.say('Below are your interference habits, your prosody and concision profile, and every word in spaced review.');
    await s.scrollTop();
    const weak = await page().evaluate(() => {
      const cells = [...document.querySelectorAll('button.cell')];
      const score = (c) => { const m = getComputedStyle(c).backgroundColor.match(/\d+/g)?.map(Number) ?? [0, 0, 0]; return m[0] - m[1]; };
      let best = -1, idx = -1;
      cells.forEach((c, i) => { const v = score(c); if (v > best) { best = v; idx = i; } });
      return idx;
    });
    await s.moveTo(page().locator('button.cell').nth(Math.max(0, weak)));
    await s.say('Tap a weak sound to drill it. The prompt picker, a contextual bandit, now favours sentences that contain it.');
    await s.click(page().locator('button.cell').nth(Math.max(0, weak)), { pause: 1200 });
    await s.say('Your weakest sounds, words due for review, and prompts you haven\'t seen are always balanced the same way.');
  });

  // ------------------------------------------------------------------ commute
  await run('Hands-free Commute Mode', async () => {
    await s.say('The headphones button turns on hands-free Commute Mode. The app reads each prompt aloud, waits for you to speak, and reads back the critique. No screen needed.');
    let n = s.appCues();
    await s.click('button[aria-label="Toggle hands-free commute mode"]', { pause: 300 });
    await s.waitNewAppAudio(n);
    const a7 = await answerFor(await promptText(), await promptLabel());
    if (a7) {
      await sleep(600);
      n = s.appCues();
      await s.speak(a7);
      await s.waitNewAppAudio(n);
    }
    await s.click('button[aria-label="Toggle hands-free commute mode"]', { pause: 600 });
  });

  // ------------------------------------------------------------------ settings
  await run('Settings, sync & privacy', async () => {
    await s.click('button[aria-label="Settings"]', { pause: 700 });
    await s.say('Settings holds the engine options: the compute device, and a low-memory mode for older phones. You can also pick the R P voice.');
    await page().evaluate(() => document.querySelector('.drawer h3:nth-of-type(3)')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await sleep(900);
    await s.say('Your progress lives on this device. If you like, sync it to your own private GitHub repository with a fine-grained token, or export a JSON backup.');
    await page().evaluate(() => { const d = document.querySelector('.drawer'); d?.scrollTo({ top: d.scrollHeight, behavior: 'smooth' }); });
    await sleep(900);
    await s.say('A Gemini key adds British rewrites to Tier 3 answers, but it\'s entirely optional. Nothing depends on it.');
    await s.click('.drawer button[aria-label="Close"]', { pause: 600 });
  });

  const dur = await s.close();
  console.log('recorded', dur.toFixed(1), 's');
}

main().catch(async (e) => { console.error(e); try { await s.close(); } catch { /* */ } process.exit(1); });
