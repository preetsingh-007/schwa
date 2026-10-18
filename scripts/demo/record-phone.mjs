// Records the real app at phone size (390×800 CSS, 2×) for the demo video.
// No narration here: the script performs each feature once and drops named
// marks ("shots"); the edit (make-video.mjs) cuts scenes from those marks.
// The learner's voice is synthesised and played into a virtual microphone;
// every score and chart is computed live by the on-device models.
//
//   node scripts/demo/record-phone.mjs <outDir> <profileDir> <freshProfileDir> <cacheDir>
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Session, sleep } from './lib/session.mjs';
import { appHelpers, REFERENCE } from './lib/app.mjs';

const [outDir, profile, freshProfile, cacheDir] = process.argv.slice(2);
const PHONE = { viewport: { width: 390, height: 800 }, scale: 2, phone: true };
// ONLY=tier2,words re-records just those sections (a pick-up take; the edit prefers it).
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;

async function main() {
  const s = new Session(join(outDir, 'app'), { profile, cacheDir, ...PHONE });
  const A = appHelpers(s);
  const page = A.page;
  const mark = (name) => { s.rec.mark('shot', { name }); console.log('·', name); };
  /** One feature; if it throws, cut it from the footage and carry on. */
  const section = async (name, fn) => {
    if (ONLY && !ONLY.has(name)) return;
    const cp = s.rec.checkpoint();
    console.log('##', name);
    try { await fn(); } catch (e) {
      console.log(`!! ${name} dropped:`, e.message);
      s.rec.rewind(cp);
      for (const sel of ['.popover button[aria-label="Close"]', '.drawer button[aria-label="Close"]', 'button[aria-label="Back to practice"]', 'button[aria-label="Toggle hands-free commute mode"][aria-pressed="true"]']) {
        if (await page().$(sel)) await page().locator(sel).first().click().catch(() => undefined);
      }
      await s.scrollTop();
    }
  };

  await s.launch();
  await page().goto(s.url);
  await page().evaluate(async () => { localStorage.setItem('__demoSeed', '11'); await new Promise((r) => { const q = indexedDB.deleteDatabase('lexiphon'); q.onsuccess = q.onerror = q.onblocked = r; }); });
  await page().goto(s.url);
  await page().getByRole('button', { name: 'Load offline engine' }).click();
  await page().waitForSelector('.mic', { timeout: 300000 });
  await sleep(1500);
  await s.rec.start();

  await section('arena', async () => {
    mark('arena'); await sleep(2500);
    mark('chip'); await A.cycleTo('Tier 1'); await sleep(800);
  });

  await section('tier1', async () => {
    let t1, first;
    for (let attempt = 0; attempt < 6; attempt++) {
      const cp = s.rec.checkpoint();
      t1 = await A.skipUntil((t) => /r/i.test(t.replace(/r(?=[aeiouy])/gi, '')) && t.split(/\s+/).length >= 5 && t.split(/\s+/).length <= 12);
      s.learnerClip(t1, 'l2'); s.learnerClip(t1);
      mark('t1_prompt'); await sleep(1500);
      mark('t1_tap');
      first = await A.turn(t1, { accent: 'l2', onStop: () => mark('t1_stop') });
      if (first && !first.passed && await page().$('.ph.error')) break;
      console.log('retake: first attempt', first);
      s.rec.rewind(cp);
      await page().locator('button[aria-label="Skip prompt"]').click();
      await sleep(500);
    }
    mark('t1_result'); await sleep(1200);
    await s.scrollTo('.scorebar', 'center'); mark('t1_score'); await sleep(2500);
    await s.scrollTo('.tape', 'center'); mark('t1_tape'); await sleep(3000);
    await s.click('.wcard:has(.ph.error) .u .ph.error', { pause: 200 }); mark('t1_pop'); await sleep(3500);
    await s.click('.popover button[aria-label="Close"]', { pause: 300 });
    await s.scrollTop(); mark('t1_retry_ready'); await sleep(800);
    mark('t1_retry');
    let second = await A.turn(t1, { onStop: () => mark('t1_retry_stop') });
    if (!second?.passed) second = await A.turn(t1, { speed: 0.95 });
    console.log('tier1', first, second);
    mark('t1_pass'); await sleep(1000);
    await s.scrollTo('.scorebar', 'center'); mark('t1_pass_score'); await sleep(2500);
    await s.scrollTop();
  });

  await section('tier2', async () => {
    await A.cycleTo('Tier 2');
    const t2 = await A.skipUntil((t) => t.split(/\s+/).length <= 42);
    s.learnerClip(t2, undefined, 1.12);
    mark('t2_prompt'); await sleep(2500);
    mark('t2_tap');
    const w = await A.turn(t2, { speed: 1.12, onStop: () => mark('t2_stop') });
    mark('t2_result'); await sleep(1000);
    await s.scrollTo('.diffline', 'center'); mark('t2_diff'); await sleep(3000);
    const ref = REFERENCE.get(t2) ?? await A.text('.retry .say');
    s.learnerClip(ref);
    await s.scrollTo('.retry', 'center'); mark('t2_target'); await sleep(2000);
    await s.scrollTop();
    mark('t2_retry');
    const c = await A.turn(ref, { onStop: () => mark('t2_retry_stop') });
    console.log('tier2', w, c);
    mark('t2_pass'); await sleep(1000);
    await s.scrollTo('.diffline', 'center'); mark('t2_pass_diff'); await sleep(3000);
    await s.scrollTop();
  });

  await section('repeat', async () => {
    await A.cycleTo('Repeat');
    const t = await A.skipUntil((x) => x.split(/\s+/).length >= 6 && x.split(/\s+/).length <= 12);
    s.learnerClip(t);
    await page().waitForFunction(() => !document.querySelector('.prompt-head ~ .row button[disabled]'), null, { timeout: 120000 }).catch(() => undefined);
    await s.waitAppAudio();
    mark('rp_ready'); await sleep(1000);
    const n = s.appCues();
    mark('rp_listen');
    await s.click(page().getByRole('button', { name: 'Listen' }), { pause: 100 });
    await s.waitNewAppAudio(n);
    await sleep(400);
    mark('rp_tap');
    const r = await A.turn(t, { onStop: () => mark('rp_stop') });
    console.log('repeat', r);
    mark('rp_result'); await sleep(1000);
    await s.scrollTo('.chart', 'center'); mark('rp_chart'); await sleep(3500);
    await s.scrollTop();
  });

  await section('words', async () => {
    await A.cycleTo('Words');
    let t = null;
    try { t = await A.skipUntil(async (x, l) => l.startsWith('Words · name it') && !!(await A.answerFor(x, l)), 30); } catch { /* fall back below */ }
    t ??= await A.skipUntil(async (x, l) => !!(await A.answerFor(x, l)) && x.split(/\s+/).length <= 14);
    const ans = await A.answerFor(t, await A.promptLabel());
    s.learnerClip(ans);
    mark('w_prompt'); await sleep(2500);
    mark('w_tap');
    const r = await A.turn(ans, { onStop: () => mark('w_stop') });
    console.log('words', await A.promptLabel(), ans, r);
    mark('w_result'); await sleep(1000);
    await s.scrollTo('.scorebar', 'center'); mark('w_score'); await sleep(2500);
    await s.scrollTop();
  });

  await section('lexicon', async () => {
    await s.click('button[aria-label="Lexicon"]', { pause: 300 });
    mark('lex_open'); await sleep(1800);
    mark('lex_type'); await s.type('.searchbox', 'Leicester');
    await sleep(900);
    await s.click('.lexitem', { pause: 200 }); mark('lex_card'); await sleep(2500);
    const n = s.appCues();
    mark('lex_rp');
    await s.click(page().locator('.vocabcard').getByRole('button', { name: 'RP' }), { pause: 200 });
    await s.waitNewAppAudio(n, 15000);
    await sleep(800);
    await s.click('.vocabcard button[aria-label="Close"]', { pause: 300 });
    await s.click('button[aria-label="Back to practice"]', { pause: 400 });
  });

  // ---- a dozen turns off camera, so the progress map has something to show
  if (!ONLY || ONLY.has('dashboard')) {
    s.rec.pause();
    await A.cycleTo('Auto');
    let done = 0;
    for (let i = 0; i < 40 && done < 12; i++) {
      const t = await A.promptText(), l = await A.promptLabel();
      const a = await A.answerFor(t, l);
      if (!a || a.split(/\s+/).length > 22) { await page().locator('button[aria-label="Skip prompt"]').click(); await sleep(500); continue; }
      const r = await A.turn(a, { accent: done % 3 === 0 ? 'l2' : undefined }).catch((e) => { console.log('warm-up turn failed', e.message); return null; });
      done++;
      await page().locator('button[aria-label="Skip prompt"]').click();
      await sleep(600);
      console.log('warm-up', done, r);
    }
    await s.scrollTop();
    s.rec.resume();
  }

  await section('dashboard', async () => {
    await s.click('button[aria-label="Progress dashboard"]', { pause: 300 });
    mark('dash_open'); await sleep(2500);
    await s.scrollTo('.cgrid-wrap', 'center'); mark('dash_cons'); await sleep(2500);
    await s.scrollTop(); await sleep(400);
    const weak = await page().evaluate(() => {
      const cells = [...document.querySelectorAll('button.cell')];
      const score = (c) => { const m = getComputedStyle(c).backgroundColor.match(/\d+/g)?.map(Number) ?? [0, 0, 0]; return m[0] - m[1]; };
      let best = -1, idx = -1;
      cells.forEach((c, i) => { const v = score(c); if (v > best) { best = v; idx = i; } });
      return idx;
    });
    await s.moveTo(page().locator('button.cell').nth(Math.max(0, weak)));
    mark('dash_tap');
    await s.click(page().locator('button.cell').nth(Math.max(0, weak)), { pause: 300 });
    mark('dash_drill'); await sleep(2500);
  });

  await section('commute', async () => {
    let n = s.appCues();
    mark('cm_on');
    await s.click('button[aria-label="Toggle hands-free commute mode"]', { pause: 300 });
    await s.waitNewAppAudio(n);
    const a = await A.answerFor(await A.promptText(), await A.promptLabel());
    if (!a) throw new Error('commute prompt has no answer');
    await sleep(600);
    n = s.appCues();
    mark('cm_speak');
    await s.speak(a);
    await s.waitNewAppAudio(n);
    mark('cm_done'); await sleep(800);
    await s.click('button[aria-label="Toggle hands-free commute mode"]', { pause: 600 });
  });

  await section('settings', async () => {
    await s.click('button[aria-label="Settings"]', { pause: 300 });
    mark('set_open'); await sleep(2500);
    await page().evaluate(() => [...document.querySelectorAll('.drawer label.toggle')].find((l) => /Low-memory/.test(l.textContent ?? ''))?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await sleep(900);
    mark('set_lowmem'); await sleep(2500);
    await s.click('.drawer button[aria-label="Close"]', { pause: 600 });
  });
  console.log('app footage', (await s.close()).toFixed(1), 's');
  if (ONLY) return;

  // ---- first launch on a brand-new profile: the one-time engine download
  rmSync(freshProfile, { recursive: true, force: true });
  const f = new Session(join(outDir, 'first-run'), { profile: freshProfile, cacheDir, ...PHONE });
  await f.launch();
  await f.page.goto(f.url);
  await f.page.waitForSelector('text=Load offline engine');
  await sleep(1000);
  await f.rec.start();
  f.rec.mark('shot', { name: 'fr_open' }); await sleep(2500);
  f.rec.mark('shot', { name: 'fr_click' });
  await f.click(f.page.getByRole('button', { name: 'Load offline engine' }), { pause: 200 });
  await f.page.waitForSelector('.mic', { timeout: 900000 });
  f.rec.mark('shot', { name: 'fr_ready' }); await sleep(3000);
  console.log('first run footage', (await f.close()).toFixed(1), 's');
}

main().catch((e) => { console.error(e); process.exit(1); });
