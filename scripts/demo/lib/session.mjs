// Drives the real app in Chromium for the demo recording: a pointer (or, on a
// phone, a tap indicator) that moves like a person's, learner speech rendered by
// the Kokoro voice server, and every sound the app plays captured onto the timeline.
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Recorder } from './recorder.mjs';

const VOICE = process.env.VOICE_URL ?? 'http://127.0.0.1:5199/render';
const CHROME = process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
export const LEARNER = 'bm_fable';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wavFromInt16(i16buf, sr) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(36 + i16buf.length, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(i16buf.length, 40);
  return Buffer.concat([b, i16buf]);
}
const wavInfo = (buf) => ({ sr: buf.readUInt32LE(24), pcm: buf.subarray(44), dur: (buf.length - 44) / 2 / buf.readUInt32LE(24) });

export class Session {
  /**
   * viewport: CSS size of the page; scale: device pixel ratio of the capture.
   * phone: touch emulation and a tap indicator instead of a mouse pointer.
   */
  constructor(outDir, { profile, cacheDir, url = 'http://127.0.0.1:5173/', viewport = { width: 1280, height: 720 }, scale = 1.5, phone = false }) {
    this.out = outDir; this.profile = profile; this.url = url;
    this.viewport = viewport; this.scale = scale; this.phone = phone;
    this.cache = cacheDir; mkdirSync(cacheDir, { recursive: true });
    mkdirSync(join(outDir, 'audio'), { recursive: true });
    this.audioN = 0; this.appAudioEnd = 0; this.cur = { x: 640, y: 400 };
  }

  async launch() {
    this.ctx = await chromium.launchPersistentContext(this.profile, {
      executablePath: CHROME, headless: true,
      // Chrome's own scale factor (not Playwright's), so the screencast is full resolution.
      viewport: null,
      args: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', `--window-size=${this.viewport.width},${this.viewport.height + 90}`, `--force-device-scale-factor=${this.scale}`],
    });
    this.page = this.ctx.pages()[0] ?? await this.ctx.newPage();
    // Browser UI size varies (and windows have a minimum width); resize so the viewport is exact.
    const cdp = await this.ctx.newCDPSession(this.page);
    const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget');
    const [iw, ih] = await this.page.evaluate(() => [innerWidth, innerHeight]);
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: bounds.width + this.viewport.width - iw, height: bounds.height + this.viewport.height - ih } });
    await cdp.detach();
    if (this.phone) {
      // keep the session: touch emulation lives as long as it does
      this.touch = await this.ctx.newCDPSession(this.page);
      await this.touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await this.ctx.addInitScript('window.__touchMode = true;');
    }
    this.cur = { x: this.viewport.width / 2, y: this.viewport.height * 0.6 };
    this.page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text().slice(0, 300)); });
    await this.page.exposeFunction('__onAppAudio', (a) => this.onAppAudio(a));
    await this.page.exposeFunction('__onAppAudioStop', (id) => this.onAppAudioStop(id));
    await this.page.exposeFunction('__onMediaPlay', (src) => this.onMediaPlay(src));
    await this.page.exposeFunction('__onSystemSpeak', (t) => console.log('[system voice]', t));
    await this.ctx.addInitScript({ path: new URL('./inject.js', import.meta.url).pathname });
    this.rec = new Recorder(this.page, this.out, { width: this.viewport.width * this.scale, height: this.viewport.height * this.scale + 20 });
  }

  // ---------------- audio ----------------
  onAppAudio({ id, sr, b64 }) {
    const pcm = Buffer.from(b64, 'base64');
    const file = join(this.out, 'audio', `app-${String(this.audioN++).padStart(3, '0')}.wav`);
    writeFileSync(file, wavFromInt16(pcm, sr));
    const dur = pcm.length / 2 / sr;
    const cue = { kind: 'app', id, dur };
    this.rec.cue(file, cue);
    this.appAudioEnd = Math.max(this.appAudioEnd, performance.now() + dur * 1000);
  }
  onAppAudioStop(id) {
    const c = this.rec.audio.find((a) => a.id === id);
    if (c && c.end === undefined) c.end = this.rec.tick();
  }
  async onMediaPlay(src) {
    if (!src || this.rec.paused) return;
    const t = this.rec.tick();
    const file = join(this.out, 'audio', `media-${String(this.audioN++).padStart(3, '0')}${src.slice(src.lastIndexOf('.'))}`);
    writeFileSync(file, Buffer.from(await (await fetch(src)).arrayBuffer()));
    this.rec.audio.push({ t, file, kind: 'app' });
  }
  appCues() { return this.rec.audio.filter((a) => a.kind === 'app').length; }
  /** Wait for the app to start a new sound after `n` cues, then for it to finish. */
  async waitNewAppAudio(n, timeout = 120000) {
    const t0 = performance.now();
    while (this.appCues() <= n && performance.now() - t0 < timeout) await sleep(100);
    await this.waitAppAudio();
  }
  async waitAppAudio(extra = 300) {
    await sleep(400);
    while (performance.now() < this.appAudioEnd) await sleep(100);
    await sleep(extra);
  }

  /** Render (or reuse) a clip from the voice server. Paused while rendering, so no gap shows. */
  async render(text, opts) {
    const key = createHash('sha1').update(JSON.stringify([text, opts])).digest('hex').slice(0, 16);
    const file = join(this.cache, `${key}.wav`);
    if (!existsSync(file)) {
      const wasPaused = this.rec?.paused;
      if (this.rec && !wasPaused) this.rec.pause();
      const r = await fetch(VOICE, { method: 'POST', body: JSON.stringify({ text, ...opts }) });
      if (!r.ok) throw new Error(`voice server: ${await r.text()}`);
      writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      if (this.rec && !wasPaused) this.rec.resume();
    }
    return { file, ...wavInfo(readFileSync(file)) };
  }
  /** Warm the cache without touching the timeline (one request per clip, however often asked). */
  prerender(text, opts) {
    const key = createHash('sha1').update(JSON.stringify([text, opts])).digest('hex').slice(0, 16);
    if (existsSync(join(this.cache, `${key}.wav`))) return Promise.resolve();
    this.inflight ??= new Map();
    if (!this.inflight.has(key)) {
      this.inflight.set(key, fetch(VOICE, { method: 'POST', body: JSON.stringify({ text, ...opts }) })
        .then((r) => r.arrayBuffer()).then((b) => writeFileSync(join(this.cache, `${key}.wav`), Buffer.from(b))).catch(() => undefined)
        .finally(() => this.inflight.delete(key)));
    }
    return this.inflight.get(key);
  }

  /** The learner speaks into the virtual microphone. */
  async speak(text, { accent, speed = 1 } = {}) {
    const clip = await this.render(text, accent ? { voice: LEARNER, accent, speed, v: 2 } : { voice: LEARNER, rp: true, speed });
    this.rec.cue(clip.file, { kind: 'learner', text, dur: clip.dur });
    await this.page.evaluate(([b, sr]) => window.__micSpeak(b, sr), [clip.pcm.toString('base64'), clip.sr]);
  }
  learnerClip(text, accent, speed = 1) {
    return this.prerender(text, accent ? { voice: LEARNER, accent, speed, v: 2 } : { voice: LEARNER, rp: true, speed });
  }

  // ---------------- pointer ----------------
  async moveTo(target, { ms = 650 } = {}) {
    const loc = typeof target === 'string' ? this.page.locator(target).first() : target.first();
    await loc.scrollIntoViewIfNeeded();
    const box = await loc.boundingBox();
    if (!box) throw new Error(`no box for ${target}`);
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    const steps = Math.max(8, Math.round(ms / 16));
    const { x: x0, y: y0 } = this.cur;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps, e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      await this.page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e);
      await sleep(ms / steps / 2);
    }
    this.cur = { x, y };
    return loc;
  }
  async click(target, { pause = 350, ms } = {}) {
    await this.moveTo(target, { ms });
    await sleep(120);
    await this.page.mouse.down(); await sleep(70); await this.page.mouse.up();
    await sleep(pause);
  }
  async type(target, text, delay = 85) {
    await this.click(target);
    for (const ch of text) { await this.page.keyboard.type(ch); await sleep(delay + Math.random() * 50); }
  }
  async scrollTo(selector, block = 'start') {
    await this.page.evaluate(([s, b]) => document.querySelector(s)?.scrollIntoView({ behavior: 'smooth', block: b }), [selector, block]);
    await sleep(900);
  }
  async scrollTop() { await this.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })); await sleep(900); }

  async close() { const d = await this.rec.stop(); await this.ctx.close(); return d; }
}
