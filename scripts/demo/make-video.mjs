// Edits the phone-first demo: cold open → "Meet schwa" → eight features on a
// phone → how to get it → outro. One timeline, rendered twice:
//   schwa-demo.mp4           16:9, 1920×1080
//   schwa-demo-vertical.mp4  9:16, 1080×1920
//
//   node scripts/demo/make-video.mjs <workDir>
//
// Expects <work>/phone/app and <work>/phone/first-run (record-phone.mjs), any
// pick-up takes as <work>/phone-*/app (preferred over the main take), and
// the voice server (voice-server.ts). Every scene is a whole number of bars
// at 100 BPM, so cuts land on the beat of the score (music.py).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { LAYOUTS, background, coldCard, featureFg, footageMask, footageRect, getFg, logoCard } from './lib/scenes.mjs';
import { renderHtmlClip } from './lib/htmlclip.mjs';
import { buildVideo, loadTimeline, mixStems } from './lib/timeline.mjs';

const W = process.argv[2];
const E = join(W, 'edit'); mkdirSync(E, { recursive: true });
const HERE = new URL('.', import.meta.url).pathname;
const SCRIPT = JSON.parse(readFileSync(join(HERE, 'script.json'), 'utf8'));
const CACHE = join(W, 'voicecache'); mkdirSync(CACHE, { recursive: true });
const VOICE = process.env.VOICE_URL ?? 'http://127.0.0.1:5199/render';
const SR = 48000, FPS = 30, BAR = 2.4;
const ceilBars = (s) => Math.ceil(s / BAR - 1e-6) * BAR;
const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { maxBuffer: 1 << 30 });
const probe = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
const hash = (x) => createHash('sha1').update(JSON.stringify(x)).digest('hex').slice(0, 12);

// ------------------------------------------------------------------ voice
async function vo(id) {
  const l = SCRIPT.lines[id];
  const opts = { text: l.say ?? l.text, voice: SCRIPT.voices[l.who], rp: true, speed: SCRIPT.speed };
  const file = join(CACHE, `vo-${hash(opts)}.wav`);
  if (!existsSync(file)) {
    const r = await fetch(VOICE, { method: 'POST', body: JSON.stringify(opts) });
    if (!r.ok) throw new Error(`voice server: ${await r.text()}`);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  }
  return { id, file, dur: probe(file), text: l.text };
}

// ------------------------------------------------------------------ audio mixing
function decode2(file, trim) {
  const args = ['-loglevel', 'error'];
  if (trim) args.push('-ss', String(trim[0]), '-to', String(trim[1]));
  args.push('-i', file, '-f', 'f32le', '-ac', '2', '-ar', String(SR), '-');
  const raw = execFileSync('ffmpeg', args, { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}
function writeWav2(file, x) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  writeFileSync(file, b);
}
/** parts: [{file, at, gain, trim?, fadeIn?, fadeOut?, duck?}]; ducking parts dip under the voice parts. */
function mix(out, dur, parts) {
  const n = Math.ceil(dur * SR) * 2;
  const buf = new Float32Array(n);
  const voice = new Float32Array(n / 2);
  const decoded = parts.map((p) => ({ ...p, x: decode2(p.file, p.trim) }));
  for (const p of decoded.filter((q) => q.voice)) {
    const s0 = Math.round(p.at * SR);
    for (let i = 0; i < p.x.length / 2; i++) { const j = s0 + i; if (j >= 0 && j < n / 2) voice[j] = Math.max(voice[j], Math.abs(p.x[2 * i]) + Math.abs(p.x[2 * i + 1])); }
  }
  let e = 0; const env = new Float32Array(n / 2);
  for (let i = 0; i < env.length; i++) { const v = voice[i] > 0.01 ? 1 : 0; e = v > e ? e + (v - e) * 0.004 : e + (v - e) * 0.00012; env[i] = e; }
  for (const p of decoded) {
    const s0 = Math.round(p.at * SR), len = p.x.length / 2, g = p.gain ?? 1;
    const fi = (p.fadeIn ?? 0) * SR, fo = (p.fadeOut ?? 0) * SR;
    for (let i = 0; i < len; i++) {
      const j = s0 + i; if (j < 0 || j >= n / 2) continue;
      let k = g; if (fi && i < fi) k *= i / fi; if (fo && len - i < fo) k *= (len - i) / fo;
      if (p.duck) k *= 1 - p.duck * env[j];
      buf[2 * j] += p.x[2 * i] * k; buf[2 * j + 1] += p.x[2 * i + 1] * k;
    }
  }
  writeWav2(out, buf);
}

// ------------------------------------------------------------------ captions
function chunks(text) {
  const parts = text.match(/[^.!?;:]+[.!?;:]*\s*/g) ?? [text];
  const out = [];
  for (let p of parts) {
    p = p.trim();
    while (p.length > 52) {
      const cut = p.lastIndexOf(' ', 46) > 18 ? p.lastIndexOf(' ', 46) : p.indexOf(' ', 40);
      if (cut < 0) break;
      out.push(p.slice(0, cut).replace(/,$/, '')); p = p.slice(cut + 1);
    }
    if (p) out.push(p);
  }
  return out;
}
function captionEvents(cues) {
  const ev = [];
  for (const c of cues) {
    const cs = chunks(c.text), total = cs.reduce((a, s) => a + s.length, 0);
    let t = c.t;
    for (const s of cs) { const dd = (c.dur * s.length) / total; ev.push({ start: t, end: t + dd - 0.04, text: s }); t += dd; }
  }
  return ev;
}
const ts = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = (s % 60).toFixed(2).padStart(5, '0'); return `${h}:${String(m).padStart(2, '0')}:${x}`; };
function writeAss(file, L, ev) {
  const c = L.caption;
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${L.w}\nPlayResY: ${L.h}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Cap,Inter,${c.size},&H00F5F5F5,&H00F5F5F5,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,0,2,${c.align},${c.marginL},${c.marginR},${c.marginV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  writeFileSync(file, head + ev.map((e) => `Dialogue: 0,${ts(Math.max(0, e.start))},${ts(e.end)},Cap,,0,0,0,,${e.text.replace(/[{}]/g, '')}`).join('\n') + '\n');
}
const srtTime = (s) => { const ms = Math.round(s * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };

// ------------------------------------------------------------------ scene plan
// Footage clips: { at: mark, a, b } (seconds around the mark), or until: 'learner' | 'app'
// (end of the first such sound starting after the clip start), or cue: 'app' + after: mark
// (start at the first app sound after that mark). audio: false mutes the app's sound.
const FEATURES = {
  f1: { voAfter: 0, clips: [{ cue: 'learner', after: 't1_tap', a: -0.9, until: 'learner', pad: 0.4 }, { at: 't1_result', a: -0.3, b: 1.2 }, { at: 't1_score', a: 0, b: 2.2 }, { at: 't1_tape', a: 0, b: 3.2 }] },
  f2: { voAt: 0.2, clips: [{ at: 't1_pop', a: -0.5, b: 3.0 }, { cue: 'learner', after: 't1_retry', a: -0.8, until: 'learner', pad: 0.3, audio: false }, { at: 't1_pass_score', a: 0, b: 2.6 }] },
  f3: { voAt: 0.3, clips: [{ at: 't2_prompt', a: 0, b: 1.8 }, { cue: 'learner', after: 't2_tap', a: -0.8, b: 2.4, audio: false }, { at: 't2_diff', a: 0, b: 2.8 }, { at: 't2_target', a: 0, b: 1.6 }, { at: 't2_pass_diff', a: 0, b: 2.6 }] },
  f4: { voAfter: 0, clips: [{ at: 'rp_listen', a: -0.2, until: 'app', pad: 0.2 }, { cue: 'learner', after: 'rp_tap', a: -0.8, until: 'learner', pad: 0.2, audio: false }, { at: 'rp_chart', a: 0, b: 3.2 }] },
  f5: { voAt: 0.3, clips: [{ at: 'w_prompt', a: 0, b: 1.6 }, { cue: 'learner', after: 'w_tap', a: -0.8, until: 'learner', pad: 0.2, audio: false }, { at: 'w_score', a: 0, b: 1.6 }, { at: 'lex_type', a: -0.2, b: 2.3 }, { at: 'lex_card', a: 0, b: 1.8 }, { at: 'lex_rp', a: 0, until: 'app', pad: 0.5, b: 1.8 }] },
  f6: { voAt: 0.3, clips: [{ at: 'dash_open', a: 0, b: 2.4 }, { at: 'dash_cons', a: 0, b: 2.2 }, { at: 'dash_tap', a: -0.6, b: 2.8 }] },
  f7: { voAt: 0.2, clips: [{ at: 'cm_on', a: -0.3, b: 1.8, audio: false }, { cue: 'learner', after: 'cm_speak', a: -0.3, until: 'learner', pad: 0.2, audio: false }, { cue: 'app', after: 'cm_speak', a: -0.3, until: 'app', pad: 0.4 }] },
  f8: { voAt: 0.3, clips: [{ at: 'set_open', a: 0, b: 3.0 }, { at: 'set_lowmem', a: 0, b: 3.4 }] },
};

async function main() {
  // ---- footage → phone-size video + sound stem
  const pickups = readdirSync(W).filter((d) => d.startsWith('phone-') && existsSync(join(W, d, 'app/timeline.json'))).sort();
  const SRC = { fr: join(W, 'phone/first-run'), ...Object.fromEntries(pickups.map((d) => [d, join(W, d, 'app')])), app: join(W, 'phone/app') };
  for (const d of Object.values(SRC)) if (!existsSync(join(d, 'video.mp4'))) { buildVideo(d, join(d, 'video.mp4'), { size: '780:1600' }); mixStems(d); }
  const TL = Object.fromEntries(Object.entries(SRC).map(([k, d]) => [k, loadTimeline(d)]));
  /** the take a feature comes from: the first (pick-ups first) that has its opening mark */
  const takeFor = (c) => Object.keys(SRC).find((k) => k !== 'fr' && TL[k].markers.some((m) => m.kind === 'shot' && m.name === (c.at ?? c.after)));
  const markT = (src, name) => { const m = TL[src].markers.find((x) => x.kind === 'shot' && x.name === name); if (!m) throw new Error(`no mark ${name}`); return m.t; };
  // a sound of this kind starting within `within` s of t (null if there isn't one)
  const cueAfter = (src, kind, t, within = 8) => TL[src].audio.find((x) => x.kind === kind && x.t >= t - 0.05 && x.t <= t + within && (x.dur ?? 0) > 0) ?? null;
  const resolve = (src, c) => {
    const from = markT(src, c.at ?? c.after);
    const cue = c.cue && cueAfter(src, c.cue, from);
    const base = cue ? cue.t : from; // a and b are relative to the sound when the clip is anchored on one
    const start = base + (c.a ?? 0);
    const q = c.until && cueAfter(src, c.until, start);
    const end = q ? q.t + (q.end !== undefined ? q.end - q.t : q.dur) + (c.pad ?? 0) : base + (c.b ?? 2.5);
    return { src, start, end, speed: c.speed ?? 1, audio: c.audio !== false && (c.speed ?? 1) === 1 };
  };

  // ---- plan every scene
  const scenes = [];
  let t = 0;
  const add = (s) => { s.start = t; t += s.dur; scenes.push(s); };
  { const a = await vo('cold1'), b = await vo('cold2');
    const lines = [{ ...a, at: 0.4 }, { ...b, at: 0.4 + a.dur + 0.35 }];
    add({ id: 'cold', kind: 'card', music: 'intro', lines, dur: ceilBars(lines[1].at + b.dur + 0.5) }); }
  { const a = await vo('logo1'), b = await vo('logo2');
    const lines = [{ ...a, at: 0.5 }, { ...b, at: 0.5 + a.dur + 0.2 }];
    add({ id: 'logo', kind: 'card', music: 'hit', lines, dur: ceilBars(lines[1].at + b.dur + 0.7) }); }
  for (const [id, f] of Object.entries(FEATURES)) {
    const take = takeFor(f.clips[0]);
    const clips = f.clips.map((c) => resolve(take, c));
    let pos = 0;
    for (const c of clips) { c.sceneAt = pos; pos += (c.end - c.start) / c.speed; }
    const v = await vo(id);
    const voStart = f.voAfter !== undefined ? clips[f.voAfter].sceneAt + (clips[f.voAfter].end - clips[f.voAfter].start) + 0.1 : f.voAt;
    const dur = ceilBars(Math.max(pos, voStart + v.dur + 0.7));
    add({ id, kind: 'feature', music: 'groove', meta: SCRIPT.features[id], clips, lines: [{ ...v, at: voStart }], dur, captions: true });
  }
  { // get it: Safari → share sheet → home screen → app → load once
    const g1 = await vo('g1'), g2 = await vo('g2'), g3 = await vo('g3');
    const lines = [{ ...g1, at: 0.4 }, { ...g2, at: 0.4 + g1.dur + 0.25 }];
    const g2e = lines[1].at + g2.dur;
    const tt = { sheet: lines[1].at + 1.5, home: g2e - 0.3, tap: g2e + 1.5, app: g2e + 1.9 };
    lines.push({ ...g3, at: tt.app + 0.2 });
    const loadSrc = resolve('fr', { at: 'fr_click', a: -0.3, b: markT('fr', 'fr_ready') - markT('fr', 'fr_click') + 0.3 });
    const loadSlot = Math.max(1.5, g3.dur - 0.8);
    const speed = Math.max(1, (loadSrc.end - loadSrc.start) / loadSlot);
    const open = resolve('fr', { at: 'fr_open', a: 0, b: 2.4 });
    const clips = [
      { ...open, speed: open.end - open.start > tt.app ? 1 : (open.end - open.start) / tt.app, audio: false, sceneAt: 0 },
      { ...loadSrc, speed, audio: false, sceneAt: tt.app },
      { ...resolve('fr', { at: 'fr_ready', a: 0, b: 3 }), audio: false, sceneAt: tt.app + (loadSrc.end - loadSrc.start) / speed },
    ];
    const dur = ceilBars(Math.max(lines[2].at + g3.dur + 0.8, clips[2].sceneAt + 1.5));
    tt.fast = { from: tt.app + 0.3, to: clips[2].sceneAt, n: Math.round(speed) };
    add({ id: 'get', kind: 'get', music: 'breakdown', clips, lines, tt, dur, captions: true });
  }
  { const a = await vo('out1'), b = await vo('out2');
    const lines = [{ ...a, at: 0.6 }, { ...b, at: 0.6 + a.dur + 0.3 }];
    add({ id: 'outro', kind: 'card', music: 'outro', lines, dur: ceilBars(lines[1].at + b.dur + 2.2) }); }
  const total = t;
  for (const s of scenes) console.log(`${s.id.padEnd(6)} ${s.start.toFixed(1).padStart(6)}  ${s.dur.toFixed(1)} s  (${Math.round(s.dur / BAR)} bars)`);
  console.log(`total ${total.toFixed(1)} s`);
  if (process.env.PLAN_ONLY) {
    for (const s of scenes.filter((x) => x.clips)) console.log(s.id, s.clips.map((c) => `${(c.end - c.start).toFixed(1)}${c.speed > 1 ? `×${c.speed.toFixed(1)}` : ''}`).join(' + '), '| vo', s.lines.map((l) => `${l.at.toFixed(1)}+${l.dur.toFixed(1)}`).join(', '));
    return;
  }

  // ---- footage per scene (shared by both layouts), at phone resolution
  for (const s of scenes.filter((x) => x.clips)) {
    s.footage = join(E, `foot-${s.id}-${hash([s.clips, s.dur])}.mp4`);
    if (existsSync(s.footage)) continue;
    const src = join(SRC[s.clips[0].src], 'video.mp4');
    const parts = s.clips.map((c, i) => `[0:v]trim=start=${c.start.toFixed(3)}:end=${c.end.toFixed(3)},setpts=(PTS-STARTPTS)/${c.speed.toFixed(4)}[c${i}]`).join(';');
    // where a clip is placed later than the previous one ends (get scene), hold the previous frame
    const pads = s.clips.map((c, i) => {
      const next = s.clips[i + 1]?.sceneAt;
      const len = (c.end - c.start) / c.speed;
      return next !== undefined && next > c.sceneAt + len + 0.01 ? `[c${i}]tpad=stop_mode=clone:stop_duration=${(next - c.sceneAt - len).toFixed(3)}[p${i}]` : `[c${i}]null[p${i}]`;
    }).join(';');
    ff(['-i', src, '-filter_complex', `${parts};${pads};${s.clips.map((_, i) => `[p${i}]`).join('')}concat=n=${s.clips.length}:v=1:a=0,fps=${FPS},tpad=stop_mode=clone:stop_duration=${s.dur},trim=duration=${s.dur.toFixed(3)}[v]`,
      '-map', '[v]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '15', '-pix_fmt', 'yuv420p', s.footage]);
  }

  // ---- soundtrack (shared): voice + the app's own sounds + score ducked under the voice
  const sections = scenes.map((s) => ({ kind: s.music, start: s.start, bars: Math.round(s.dur / BAR) }));
  writeFileSync(join(E, 'sections.json'), JSON.stringify(sections));
  const music = join(E, `music-${hash(sections)}.wav`);
  if (!existsSync(music)) execFileSync('python3', [join(HERE, 'music.py'), 'score', join(E, 'sections.json'), music]);
  const parts = [{ file: music, at: 0, gain: 0.55, duck: 0.62 }];
  for (const s of scenes) {
    for (const l of s.lines) parts.push({ file: l.file, at: s.start + l.at, gain: 1.05, voice: true });
    for (const c of s.clips ?? []) if (c.audio) parts.push({ file: join(SRC[c.src], 'fx.wav'), trim: [c.start, c.end], at: s.start + c.sceneAt, gain: 0.95, duck: 0.75, fadeIn: 0.03, fadeOut: 0.15 });
  }
  const mixWav = join(E, 'mix.wav');
  mix(mixWav, total + 0.5, parts);
  const audio = join(E, 'mix-norm.m4a');
  ff(['-i', mixWav, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-ar', String(SR), audio]);
  const capEv = captionEvents(scenes.filter((s) => s.captions).flatMap((s) => s.lines.map((l) => ({ t: s.start + l.at, dur: l.dur, text: l.text }))));
  writeFileSync(join(W, 'schwa-demo.srt'), captionEvents(scenes.flatMap((s) => s.lines.map((l) => ({ t: s.start + l.at, dur: l.dur, text: l.text }))))
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n'));

  // ---- render each layout
  const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true });
  for (const [name, L] of Object.entries(LAYOUTS)) {
    console.log(`render ${name}`);
    const page = await browser.newPage({ viewport: { width: L.w, height: L.h }, deviceScaleFactor: 1 });
    const clip = async (key, html, dur, alpha = false) => {
      const f = join(E, `${name}-${key}-${hash([html, dur])}.${alpha ? 'mov' : 'mp4'}`);
      if (!existsSync(f)) await renderHtmlClip(page, html, { duration: dur, fps: FPS, out: f, alpha });
      return f;
    };
    const bg = join(E, `${name}-bg.png`);
    await page.setContent(background(L), { waitUntil: 'load' }); await page.screenshot({ path: bg });
    const R = footageRect(L);
    const mask = join(E, `${name}-mask.png`);
    await page.setViewportSize({ width: R.w, height: R.h });
    await page.setContent(footageMask(L), { waitUntil: 'load' }); await page.screenshot({ path: mask });
    await page.setViewportSize({ width: L.w, height: L.h });
    const segs = [];
    for (const s of scenes) {
      const out = join(E, `${name}-scene-${s.id}.mp4`);
      if (s.kind === 'card') {
        const html = s.id === 'cold' ? coldCard(L, { t1: s.lines[0].at, t2: s.lines[1].at })
          : s.id === 'logo' ? logoCard(L, { tag: 'Your pocket coach for modern British English', t2: s.lines[1].at })
            : logoCard(L, { tag: 'Free. Private. Yours.', sub2: `${SCRIPT.url}<br>Open it, then Add to Home Screen`, t2: s.lines[1].at });
        segs.push(await clip(`card-${s.id}`, html, s.dur));
        continue;
      }
      const fg = s.kind === 'get' ? await clip('fg-get', getFg(L, { url: SCRIPT.url, t: s.tt }), s.dur, true)
        : await clip(`fg-${s.id}`, featureFg(L, s.meta), 1.6, true);
      ff(['-loop', '1', '-t', s.dur.toFixed(3), '-i', bg, '-i', s.footage, '-i', fg, '-loop', '1', '-t', s.dur.toFixed(3), '-i', mask, '-filter_complex',
        `[1:v]scale=${R.w}:${R.h}:flags=lanczos,setsar=1,format=rgba[f0];[3:v]format=gray[m];[f0][m]alphamerge[f];[2:v]tpad=stop_mode=clone:stop_duration=${s.dur}[g];[0:v][f]overlay=${R.x}:${R.y}[a];[a][g]overlay=0:0,fps=${FPS},format=yuv420p[v]`,
        '-map', '[v]', '-t', s.dur.toFixed(3), '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', out]);
      segs.push(out);
    }
    await page.close();
    const list = join(E, `${name}-list.txt`);
    writeFileSync(list, segs.map((f) => `file '${f}'`).join('\n'));
    const silent = join(E, `${name}-video.mp4`);
    ff(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', silent]);
    const ass = join(E, `${name}.ass`);
    writeAss(ass, L, capEv);
    const final = join(W, name === 'wide' ? 'schwa-demo.mp4' : 'schwa-demo-vertical.mp4');
    ff(['-i', silent, '-i', audio, '-vf', `subtitles='${ass}'`, '-map', '0:v', '-map', '1:a', '-t', total.toFixed(3),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', final]);
    console.log(`  → ${final} (${probe(final).toFixed(1)} s)`);
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
