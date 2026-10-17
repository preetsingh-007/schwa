// Records first launch on a brand-new browser profile: the one-time model
// download (sped up on the timeline) and the engine settings.
//
//   node scripts/demo/record-setup.mjs <outDir> <freshProfileDir> <cacheDir>
import { rmSync } from 'node:fs';
import { Session, sleep } from './lib/session.mjs';

const [outDir, profile, cacheDir] = process.argv.slice(2);
rmSync(profile, { recursive: true, force: true });
const s = new Session(outDir, { profile, cacheDir });

async function main() {
  await s.launch();
  const page = s.page;
  await page.goto(s.url);
  await page.waitForSelector('text=Load offline engine');
  await page.mouse.move(640, 420);
  await sleep(1200);
  await s.rec.start();
  await s.say('Open the app in Chrome, Edge or Safari. The first time, it needs to download the offline speech engine: about three hundred megabytes, once.');
  await s.click(page.getByRole('button', { name: 'Load offline engine' }), { pause: 1500 });
  const t0 = performance.now();
  s.rec.setSpeed(4);
  await page.waitForSelector('.mic', { timeout: 900000 });
  s.rec.setSpeed(1);
  console.log('download + init', ((performance.now() - t0) / 1000).toFixed(1), 's');
  await sleep(800);
  await s.say('After that it\'s cached, and LexiPhon works in flight mode. The next launch takes seconds.');
  await s.click('button[aria-label="Settings"]', { pause: 800 });
  await s.say('In Settings, the engine section shows what\'s cached. On an older iPhone, turn on low-memory mode, which skips the phoneme model and keeps prosody and vocabulary scoring.');
  await s.click('.drawer button[aria-label="Close"]', { pause: 800 });
  const d = await s.close();
  console.log('recorded', d.toFixed(1), 's');
}

main().catch(async (e) => { console.error(e); try { await s.close(); } catch { /* */ } process.exit(1); });
