// CDP screencast recorder with a virtual clock. Frames, audio cues and
// markers are all stamped in "video time", which only advances while the
// recorder is running, and advances slower when sped up (speed > 1).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class Recorder {
  constructor(page, outDir, { width = 1920, height = 1200, quality = 88 } = {}) {
    this.page = page; this.dir = outDir; this.w = width; this.h = height; this.q = quality;
    mkdirSync(join(outDir, 'frames'), { recursive: true });
    this.frames = []; this.audio = []; this.markers = [];
    this.vt = 0; this.lastReal = null; this.paused = true; this.speed = 1; this.n = 0;
  }
  tick() {
    const now = performance.now();
    if (this.lastReal !== null && !this.paused) this.vt += (now - this.lastReal) / 1000 / this.speed;
    this.lastReal = now;
    return this.vt;
  }
  async start() {
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', async (f) => {
      const t = this.tick();
      try { await this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch { /* closed */ }
      if (this.paused) { this.pending = f.data; return; }
      this.pending = null;
      this.writeFrame(f.data, t);
    });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: this.q, maxWidth: this.w, maxHeight: this.h, everyNthFrame: 1 });
    this.resume();
  }
  writeFrame(b64, t) {
    const name = `f${String(this.n++).padStart(6, '0')}.jpg`;
    writeFileSync(join(this.dir, 'frames', name), Buffer.from(b64, 'base64'));
    this.frames.push({ name, t });
  }
  /** Re-stamp the last frame now (the screencast is silent while nothing repaints). */
  keep() { if (this.frames.length) this.frames.push({ name: this.frames.at(-1).name, t: this.tick() }); }
  pause() { this.keep(); this.tick(); this.paused = true; }
  resume() {
    this.tick(); this.paused = false;
    if (this.pending) { this.writeFrame(this.pending, this.vt); this.pending = null; } else this.keep();
  }
  /** Take a checkpoint; rewind() discards everything recorded after it (a retake). */
  checkpoint() { return { t: this.tick(), frames: this.frames.length, audio: this.audio.length, markers: this.markers.length }; }
  rewind(cp) {
    this.frames.length = cp.frames; this.audio.length = cp.audio; this.markers.length = cp.markers;
    this.vt = cp.t; this.lastReal = performance.now();
    this.markers.push({ t: cp.t, kind: 'cut' });
  }
  setSpeed(s) { this.tick(); this.speed = s; this.mark('speed', { speed: s }); }
  mark(kind, data = {}) { const t = this.tick(); this.markers.push({ t, kind, ...data }); return t; }
  /** An audio clip that starts now in video time (file is a WAV path). */
  cue(file, data = {}) { const t = this.tick(); if (!this.paused) this.audio.push({ t, file, ...data }); return t; }
  async stop() {
    this.keep();
    try { await this.cdp.send('Page.stopScreencast'); } catch { /* closed */ }
    this.paused = true;
    writeFileSync(join(this.dir, 'timeline.json'), JSON.stringify({ duration: this.vt, frames: this.frames, audio: this.audio, markers: this.markers }, null, 1));
    return this.vt;
  }
}
