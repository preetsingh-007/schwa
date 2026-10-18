// Deterministic HTML → video: every CSS animation (and an optional
// window.seek(t) hook) is stepped frame by frame, so motion is smooth no
// matter how busy the machine is.
import { spawn } from 'node:child_process';

/** alpha: transparent background, written as QuickTime Animation (.mov) for overlaying. */
export async function renderHtmlClip(page, html, { duration, fps = 30, out, setup, alpha = false }) {
  // setContent keeps the window object, so drop a previous page's seek hook
  await page.evaluate(() => { window.seek = undefined; });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  if (setup) await setup(page);
  await page.evaluate(() => { document.getAnimations().forEach((a) => a.pause()); });
  const enc = alpha ? ['-c:v', 'qtrle', '-pix_fmt', 'argb'] : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p'];
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-', ...enc, '-r', String(fps), out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const frames = Math.round(duration * fps);
  for (let i = 0; i < frames; i++) {
    const t = i / fps;
    await page.evaluate((ms) => {
      for (const a of document.getAnimations()) a.currentTime = ms;
      if (window.seek) window.seek(ms / 1000);
    }, t * 1000);
    const buf = alpha ? await page.screenshot({ type: 'png', omitBackground: true }) : await page.screenshot({ type: 'jpeg', quality: 92 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await new Promise((r, j) => ff.on('close', (c) => (c === 0 ? r() : j(new Error(`ffmpeg ${c}`)))));
}
