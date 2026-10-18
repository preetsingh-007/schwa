// Turns a recorded timeline (frames + audio cues stamped in video time) into
// a constant-frame-rate video and two audio stems: narration, and "fx" (the
// app's own sounds plus the learner's voice).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SR = 48000;

export function loadTimeline(dir) {
  return JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8'));
}

/** size: 'W:H' to scale frames to exactly that (phone footage); default fits 1920×1080. */
export function buildVideo(dir, out, { fps = 30, size } = {}) {
  const tl = loadTimeline(dir);
  const fr = tl.frames;
  let list = '';
  for (let i = 0; i < fr.length; i++) {
    const next = i + 1 < fr.length ? fr[i + 1].t : tl.duration;
    const dur = next - fr[i].t;
    if (dur <= 0) continue;
    list += `file '${join(dir, 'frames', fr[i].name)}'\nduration ${dur.toFixed(4)}\n`;
  }
  list += `file '${join(dir, 'frames', fr.at(-1).name)}'\n`;
  writeFileSync(join(dir, 'frames.txt'), list);
  // Frames should be 1920×1080 (+/- a row); if the viewport came out short, fill
  // the height and trim the (blank) side margins instead of letterboxing.
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', join(dir, 'frames', fr[0].name)]).toString().trim().split(',').map(Number);
  const fit = size ? `scale=${size}:flags=lanczos` : h * (1920 / w) >= 1080 ? 'scale=1920:-2:flags=lanczos,crop=1920:1080:0:0' : 'scale=-2:1080:flags=lanczos,crop=1920:1080';
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt'),
    '-vf', `${fit},fps=${fps}`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', out]);
  return tl.duration;
}

/** Decode any audio file to mono float32 at SR. */
export function decode(file) {
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

export function writeWav(file, x) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  writeFileSync(file, b);
}

/** Mix cues into stems. gains: { narration, app, learner }. */
export function mixStems(dir, { gains = { narration: 1, app: 0.8, learner: 0.85 } } = {}) {
  const tl = loadTimeline(dir);
  const n = Math.ceil((tl.duration + 1) * SR);
  const narr = new Float32Array(n), fx = new Float32Array(n);
  for (const c of tl.audio) {
    const x = decode(c.file);
    const start = Math.round(c.t * SR);
    const stop = c.end !== undefined ? Math.round(c.end * SR) : start + x.length;
    const dst = c.kind === 'narration' ? narr : fx;
    const g = gains[c.kind] ?? 1;
    for (let i = 0; i < x.length && start + i < Math.min(n, stop); i++) {
      if (start + i < 0) continue;
      // short fade at a forced stop
      const tail = stop - (start + i);
      dst[start + i] += x[i] * g * (tail < 480 ? tail / 480 : 1);
    }
  }
  writeWav(join(dir, 'narration.wav'), narr);
  writeWav(join(dir, 'fx.wav'), fx);
  return tl;
}
