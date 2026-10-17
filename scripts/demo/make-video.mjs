// Edits the final demo video: trailer → setup guide → step-by-step tutorial.
//
//   node scripts/demo/make-video.mjs <workDir>
//
// Expects (see scripts/demo/README.md): <work>/out/tutorial and <work>/out/setup
// (recordings), <work>/terminal.json (captured commands), the voice server.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import * as C from './lib/cards.mjs';
import { renderHtmlClip } from './lib/htmlclip.mjs';
import { buildVideo, loadTimeline, mixStems } from './lib/timeline.mjs';
import { NARRATOR } from './lib/session.mjs';

const W = process.argv[2];
const E = join(W, 'edit'); mkdirSync(E, { recursive: true });
const CACHE = join(W, 'voicecache');
const VOICE = process.env.VOICE_URL ?? 'http://127.0.0.1:5199/render';
const SR = 48000, FPS = 30;
const HERE = new URL('.', import.meta.url).pathname;
const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { maxBuffer: 1 << 30 });
const probe = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

// ------------------------------------------------------------------ audio helpers
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
/** parts: [{file, at, gain=1, trim?, fadeIn?, fadeOut?, duck?}] → stereo WAV of `dur` seconds. */
function mix(out, dur, parts) {
  const n = Math.ceil(dur * SR) * 2;
  const buf = new Float32Array(n);
  const voice = new Float32Array(n / 2); // envelope of ducking sources
  const decoded = parts.map((p) => ({ ...p, x: decode2(p.file, p.trim) }));
  for (const p of decoded.filter((q) => !q.duck)) {
    const s0 = Math.round(p.at * SR);
    for (let i = 0; i < p.x.length / 2; i++) { const j = s0 + i; if (j >= 0 && j < n / 2) voice[j] = Math.max(voice[j], Math.abs(p.x[2 * i]) + Math.abs(p.x[2 * i + 1])); }
  }
  // smooth the envelope (attack fast, release slow) for ducking music under speech
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
  return out;
}

// ------------------------------------------------------------------ voice-over
async function vo(text) {
  const opts = NARRATOR;
  const key = createHash('sha1').update(JSON.stringify([text, opts])).digest('hex').slice(0, 16);
  const file = join(CACHE, `${key}.wav`);
  if (!existsSync(file)) {
    const r = await fetch(VOICE, { method: 'POST', body: JSON.stringify({ text, ...opts }) });
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  }
  return { file, dur: probe(file), text };
}

// ------------------------------------------------------------------ captions
function chunks(text) {
  const parts = text.match(/[^.!?;:]+[.!?;:]*\s*/g) ?? [text];
  const out = [];
  for (let p of parts) {
    p = p.trim();
    while (p.length > 84) {
      const cut = p.lastIndexOf(' ', 70) > 30 ? p.lastIndexOf(' ', 70) : p.indexOf(' ', 60);
      if (cut < 0) break;
      out.push(p.slice(0, cut)); p = p.slice(cut + 1);
    }
    if (p) out.push(p);
  }
  return out;
}
const spoken = (s) => s.replace(/\bR P\b/g, 'RP').replace(/forty-four phoneme/g, '44-phoneme');
/** cues: [{t, dur, text}] → caption events split into readable chunks. */
function captionEvents(cues) {
  const ev = [];
  for (const c of cues) {
    const cs = chunks(spoken(c.text));
    const total = cs.reduce((a, s) => a + s.length, 0);
    let t = c.t;
    for (const s of cs) { const d = (c.dur * s.length) / total; ev.push({ start: t, end: t + d - 0.04, text: s }); t += d; }
  }
  return ev;
}
const ts = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = (s % 60).toFixed(2).padStart(5, '0'); return `${h}:${String(m).padStart(2, '0')}:${x}`; };
function writeAss(file, ev) {
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Cap,Inter,40,&H00FFFFFF,&H00FFFFFF,&H26101010,&H26101010,0,0,0,0,100,100,0,0,3,14,0,2,200,200,46,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  writeFileSync(file, head + ev.map((e) => `Dialogue: 0,${ts(Math.max(0, e.start))},${ts(e.end)},Cap,,0,0,0,,${e.text.replace(/[{}]/g, '')}`).join('\n') + '\n');
}
const SRT = [];
let clock = 0; // running position in the final video, for the SRT sidecar

// ------------------------------------------------------------------ pacing
/** Ranges of [start, end] to keep: silent stretches over `maxGap` s (model waits) keep `keep` s at each edge. */
function keepRanges(tl, start, end, maxGap = 5.5, keep = 1.8) {
  const busy = tl.audio.map((x) => [x.t, x.end ?? x.t + (x.dur ?? 3)]).filter(([a, b]) => b > start && a < end).sort((x, y) => x[0] - y[0]);
  const cuts = [];
  let cur = start;
  for (const [a, b] of busy) { if (a - cur > maxGap) cuts.push([cur + keep, a - keep]); cur = Math.max(cur, b); }
  if (end - cur > maxGap) cuts.push([cur + keep, end - keep]);
  const keepR = [];
  let from = start;
  for (const [a, b] of cuts) { keepR.push([from, a]); from = b; }
  keepR.push([from, end]);
  return keepR;
}

// ------------------------------------------------------------------ segments
const SEGS = [];
/**
 * Encode one segment: a video input (file + optional trim, or a looped image),
 * an audio mix, optional burned-in captions, overlays and edge fades.
 */
function segment(name, { video, trim, dur, audio = [], captions = [], overlays = [], fade = 0.25, fadeIn = fade, fadeOut = fade, vf = [] }) {
  const out = join(E, `seg-${String(SEGS.length).padStart(2, '0')}-${name}.mp4`);
  const wav = mix(join(E, `${name}.wav`), dur, audio);
  const args = [];
  if (trim) args.push('-ss', trim[0].toFixed(3), '-t', dur.toFixed(3));
  args.push('-i', video);
  args.push('-i', wav);
  for (const o of overlays) args.push('-loop', '1', '-i', o.png);
  let chain = `[0:v]fps=${FPS},scale=1920:1080,setsar=1${vf.length ? ',' + vf.join(',') : ''},tpad=stop_mode=clone:stop_duration=${dur.toFixed(2)}[v0]`;
  let last = 'v0';
  overlays.forEach((o, i) => {
    const a = o.from, b = o.to;
    chain += `;[${i + 2}:v]format=rgba,fade=in:st=${a}:d=0.3:alpha=1,fade=out:st=${Math.max(a, b - 0.3)}:d=0.3:alpha=1[o${i}];[${last}][o${i}]overlay=0:0:enable='between(t,${a},${b})'[v${i + 1}]`;
    last = `v${i + 1}`;
  });
  if (captions.length) {
    const ass = join(E, `${name}.ass`);
    const ev = captionEvents(captions);
    writeAss(ass, ev);
    chain += `;[${last}]subtitles='${ass}'[vs]`; last = 'vs';
  }
  const fades = [fadeIn && `fade=in:st=0:d=${fadeIn}`, fadeOut && `fade=out:st=${(dur - fadeOut).toFixed(3)}:d=${fadeOut}`].filter(Boolean);
  chain += `;[${last}]${fades.length ? fades.join(',') : 'null'}[vf]`;
  for (const c of captions.length ? captionEvents(captions) : []) SRT.push({ start: clock + c.start, end: clock + c.end, text: c.text });
  args.push('-filter_complex', chain, '-map', '[vf]', '-map', '1:a', '-t', dur.toFixed(3),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(SR), '-ac', '2', out);
  ff(args);
  SEGS.push(out);
  clock += dur;
  console.log(`  ${name}: ${dur.toFixed(1)} s`);
  return out;
}

async function main() {
  // ---- music
  const M = join(W, 'music'); mkdirSync(M, { recursive: true });
  if (!existsSync(join(M, 'trailer.wav'))) console.log(execFileSync('python3', [join(HERE, 'music.py'), M, '58']).toString().trim());
  const BAR = 2.4;
  const music = { trailer: join(M, 'trailer.wav'), sting: join(M, 'sting.wav'), bed: join(M, 'bed.wav') };

  // ---- recordings → video + stems
  // out/tutorial is the main take; out/tutorial-* are pick-up takes of single chapters, which win
  const T = join(W, 'out/tutorial'), S = join(W, 'out/setup');
  const takes = [...readdirSync(join(W, 'out')).filter((d) => d.startsWith('tutorial-')).sort().map((d) => join(W, 'out', d)), T];
  for (const d of [...takes, S]) if (!existsSync(join(d, 'video.mp4'))) { buildVideo(d, join(d, 'video.mp4')); mixStems(d); }
  const tut = loadTimeline(T), setup = loadTimeline(S);

  const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  // card clips are cached by content, so re-edits only render what changed
  const clip = async (name, html, dur) => {
    const f = join(E, `clip-${name}-${createHash('sha1').update(html + dur).digest('hex').slice(0, 10)}.mp4`);
    if (!existsSync(f)) await renderHtmlClip(page, html, { duration: dur, fps: FPS, out: f });
    return f;
  };
  const png = async (name, html) => { const f = join(E, `png-${name}.png`); await page.setContent(html, { waitUntil: 'load' }); await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: f, omitBackground: true }); return f; };

  // =================================================================== TRAILER
  console.log('trailer');
  // Find moments by narration line / cue kind across every take: → { d: takeDir, t }
  const TL = new Map(takes.map((d) => [d, loadTimeline(d)]));
  const narrAt = (re, dt = 0) => { for (const [d, tl] of TL) { const a = tl.audio.find((x) => x.kind === 'narration' && re.test(x.text)); if (a) return { d, t: a.t + dt }; } throw new Error(`no narration ${re}`); };
  const fxAfter = (kind, chapter, dt = 0) => {
    for (const [d, tl] of TL) {
      const c = tl.markers.find((m) => m.kind === 'chapter' && m.title === chapter);
      const a = c && tl.audio.find((x) => x.kind === kind && x.t >= c.t);
      if (a) return { d, t: a.t + dt };
    }
    throw new Error(`no ${kind} after ${chapter}`);
  };
  const shots = [
    { card: C.statement({ lines: ['Most apps check', 'your <em>words.</em>'].map((h) => ({ html: h })), size: 96 }), bars: 2, vo: 'Most apps check your words.' },
    { card: C.statement({ lines: ['LexiPhon checks', 'your <em>sounds.</em>'].map((h) => ({ html: h })), size: 96 }), bars: 2, vo: 'LexiPhon checks your sounds.' },
    { app: fxAfter('learner', 'Tier 1 · Read aloud', -0.6), bars: 1.5, fx: true },
    { card: C.triad(), bars: 3, vo: 'What you meant. What you actually said. And what R P would say.' },
    { app: narrAt(/^Block B/, 1.2), bars: 1.5 },
    { app: narrAt(/^Tap any phoneme/, -0.2), bars: 1 },
    { app: narrAt(/^Block C/, 0.3), bars: 1 },
    { card: C.statement({ lines: [{ html: 'Say it <em>shorter.</em>' }], size: 110 }), bars: 1, vo: 'Say it shorter.' },
    { app: narrAt(/^Struck-through/, 0.4), bars: 1.5 },
    { card: C.statement({ lines: [{ html: 'Sound <em>British.</em>' }], size: 110 }), bars: 1, vo: 'Sound British.' },
    { app: fxAfter('app', 'Listen & repeat', -0.3), bars: 1.5, fx: true },
    { app: narrAt(/^The book icon/, 7.0), bars: 1 },
    { app: narrAt(/forty-four phoneme/, 0.2), bars: 1.5 },
    { card: C.badges({ title: 'Private by design', items: [['100% on-device', 'Whisper · wav2vec2 · espeak-ng'], ['Works offline', 'installable PWA, flight-mode ready'], ['Free & open source', 'MIT licence, hosted free on Pages'], ['Your data, your repo', 'optional private GitHub sync']] }), bars: 2.5, vo: 'All on your device. Free, open source, and private by design.' },
  ];
  const tparts = []; const tvo = []; const tfx = [];
  let tt = 0;
  for (const [i, s] of shots.entries()) {
    const dur = s.bars * BAR;
    if (s.card) tparts.push(await clip(`trailer-${i}`, s.card, dur));
    else {
      const f = join(E, `clip-trailer-${i}.mp4`);
      ff(['-ss', s.app.t.toFixed(3), '-t', dur.toFixed(3), '-i', join(s.app.d, 'video.mp4'), '-an', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', String(FPS), f]);
      tparts.push(f);
      if (s.fx) tfx.push({ file: join(s.app.d, 'fx.wav'), trim: [s.app.t, s.app.t + dur], at: tt, gain: 1.0, fadeIn: 0.05, fadeOut: 0.3 });
    }
    if (s.vo) tvo.push({ ...(await vo(s.vo)), at: tt + 0.35 });
    tt += dur;
  }
  const hit = tt;
  tparts.push(await clip('trailer-logo', C.logo({ cta: 'Setup guide & tutorial ↓' }), 4 * BAR));
  tt += 4 * BAR;
  const tlist = join(E, 'trailer-list.txt');
  writeFileSync(tlist, tparts.map((f) => `file '${f}'`).join('\n'));
  const tvid = join(E, 'trailer-video.mp4');
  ff(['-f', 'concat', '-safe', '0', '-i', tlist, '-c', 'copy', tvid]);
  // the music's logo hit is bar 22 (see music.py); line our hit up with it
  const musicHit = 22 * BAR;
  segment('trailer', {
    video: tvid, dur: tt, fade: 0.4,
    audio: [
      { file: music.trailer, at: hit - musicHit, gain: 0.8, duck: 0.55 },
      ...tvo.map((v) => ({ file: v.file, at: v.at, gain: 1.1 })),
      ...tfx,
    ],
  });

  // =================================================================== PART 1 · SETUP
  console.log('setup');
  // the music bed continues across the setup guide (offset by running time so it doesn't restart audibly)
  let bedPos = 0;
  const bedAt = (dur) => { const p = { file: music.bed, at: 0, gain: 0.3, duck: 0.6, fadeIn: 0.3, fadeOut: 0.5, trim: [bedPos, bedPos + dur] }; bedPos = (bedPos + dur) % 100; return p; };
  const sting = (gain = 0.55) => ({ file: music.sting, at: 0, gain, duck: 0.5 });
  const voCard = async (name, html, lines, { min = 3, music: bed = true, lead = 0.7 } = {}) => {
    const vs = []; let t = lead;
    for (const l of lines) { const v = await vo(l); vs.push({ ...v, at: t }); t += v.dur + 0.35; }
    const dur = Math.max(min, t + 0.8);
    const f = await clip(name, html, dur);
    segment(name, { video: f, dur, audio: [...(bed ? [bedAt(dur)] : []), ...vs.map((v) => ({ file: v.file, at: v.at, gain: 1.05 }))] });
  };

  await voCard('part1', C.chapter({ kicker: 'Part 1', title: 'Setup guide', sub: 'From a fresh clone to your first scored sentence, in about five minutes.' }), ['Part one: the setup guide.'], { min: 3.5 });
  await voCard('requirements', C.steps({
    kicker: 'Before you start', title: 'What you need', gap: 0.9, items: [
      ['Node.js 20 or newer', 'plus <code>git</code> — only for running or building it yourself'],
      ['A recent browser', 'Chrome, Edge or Safari — desktop, iPhone or iPad'],
      ['A microphone', 'everything you practise is spoken aloud'],
      ['About 400 MB of space', 'the offline models download once, then work in flight mode'],
    ],
  }), ['You\'ll need Node.js twenty or newer and git, a recent Chrome, Edge or Safari, a microphone, and about four hundred megabytes of space for the offline models.']);

  // ---- terminal scenes from the real captured session
  const term = JSON.parse(readFileSync(join(W, 'terminal.json'), 'utf8'));
  // Real output, lightly trimmed: blank lines and npm's deprecation notices dropped, local paths shown as ~/schwa.
  const outLines = (step, max = 24) => step.lines.map((l) => l.text.replace(/\/\S*\/schwa\b/g, '~/schwa'))
    .filter((l) => l.trim() !== '' && !l.startsWith('npm warn deprecated')).slice(-max);
  const tScene = async (name, items, lines) => {
    // items: [{cmd}|{out, dur}] laid out back to back
    const script = []; let t = 0.6;
    for (const it of items) {
      if (it.cmd !== undefined) { script.push({ cmd: it.cmd, at: t }); t += it.cmd.length / 24 + 0.5; }
      else { script.push({ out: it.out, at: t, dur: it.dur }); t += it.dur + (it.pause ?? 0.6); }
    }
    const vs = []; let v0 = 0.5;
    for (const l of lines) { const v = await vo(l); vs.push({ ...v, at: v0 }); v0 += v.dur + 0.3; }
    const dur = Math.max(t + 1.2, v0 + 0.6);
    const f = await clip(name, C.terminal({ title: 'schwa — bash', script, prompt: name === 'term-clone' ? '~' : '~/schwa' }), dur);
    segment(name, { video: f, dur, audio: [bedAt(dur), ...vs.map((v) => ({ file: v.file, at: v.at, gain: 1.05 }))], captions: vs.map((v) => ({ t: v.at, dur: v.dur, text: v.text })) });
  };
  const [clone, install, test, dev] = term;
  const installSecs = Math.round(install.secs);
  await tScene('term-clone', [
    { cmd: clone.cmd }, { out: outLines(clone), dur: 0.8 },
    { cmd: 'cd schwa' }, { out: [], dur: 0.1, pause: 0.2 },
    { cmd: install.cmd }, { out: [...outLines(install, 14), ''], dur: 2.2 },
  ], [
    'Clone the repository, and install the dependencies.',
    `On this machine, npm install took about ${installSecs} seconds; it's sped up here.`,
  ]);
  const testOut = outLines(test, 26);
  await tScene('term-test', [
    { cmd: test.cmd }, { out: testOut, dur: 3.2, pause: 1.0 },
    { cmd: dev.cmd }, { out: outLines(dev, 12), dur: 1.0, pause: 2.0 },
  ], [
    'Optionally, run the unit tests: the aligner, scoring, spaced repetition, sync, and more.',
    'Then start the dev server, and open the local address it prints.',
  ]);

  // ---- first launch, framed in a browser window
  const frame = await png('browser', C.browserFrame({ url: 'localhost:5173' }));
  const sp = setup.markers.filter((m) => m.kind === 'speed');
  const fast = sp.length >= 2 ? [sp[0].t, sp[1].t] : null;
  const badge = await png('speed', C.speedBadge({ text: `${sp[0]?.speed ?? 12}× speed · first-run download` }));
  segment('first-launch', {
    video: join(S, 'video.mp4'), dur: setup.duration,
    vf: ['scale=1632:918', 'pad=1920:1080:144:126:#e9ecef'],
    overlays: [{ png: frame, from: 0, to: setup.duration + 1 }, ...(fast ? [{ png: badge, from: fast[0], to: fast[1] }] : [])],
    audio: [bedAt(setup.duration), { file: join(S, 'narration.wav'), at: 0 }, { file: join(S, 'fx.wav'), at: 0 }],
    captions: setup.audio.filter((a) => a.kind === 'narration').map((a) => ({ t: a.t, dur: a.dur, text: a.text })),
  });

  await voCard('deploy', C.steps({
    kicker: 'Optional', title: 'Host your own copy, free', gap: 1.6, items: [
      ['Fork the repository', 'on GitHub: <code>preetsingh-007/schwa</code>'],
      ['Settings → Pages → Source: GitHub Actions', 'the included workflow builds and deploys every push to <code>main</code>'],
      ['Open https://&lt;you&gt;.github.io/schwa/', 'static hosting — no server, no cost'],
      ['Install it like an app', 'Share → Add to Home Screen on iPhone · Install app in Chrome · File → Add to Dock in Safari'],
    ],
  }), [
    'To host your own copy, fork the repository and set GitHub Pages to deploy from GitHub Actions. Every push to main rebuilds and redeploys it, for free.',
    'Then install it like an app: Add to Home Screen on an iPhone, or Install app in Chrome.',
  ]);
  await voCard('sync', C.steps({
    kicker: 'Optional', title: 'Sync progress across devices', gap: 1.5, items: [
      ['Create a private repo', 'for example <code>lexiphon-data</code>'],
      ['Make a fine-grained token', 'access to only that repo · Contents: read and write'],
      ['Settings → GitHub sync → Verify &amp; push now', 'the app refuses to push to a public repo; the token never leaves this browser'],
    ],
  }), [
    'To keep progress in sync across devices, create a private repository, and a fine-grained token that can only write to it. Paste it into Settings. LexiPhon refuses to push to a public repo.',
  ]);

  // =================================================================== PART 2 · TUTORIAL
  console.log('tutorial');
  await voCard('part2', C.chapter({ kicker: 'Part 2', title: 'Tutorial', sub: 'A guided tour of real practice turns, scored live by the on-device models. The learner\'s voice is synthesised for this demo.' }), ['Part two: the tutorial. Every score you\'ll see is real, computed live on this device.'], { min: 4 });
  const ORDER = ['The practice arena', 'Tier 1 · Read aloud', 'Tier 2 · Lexical compression', 'Tier 3 · Open monologue', 'Listen & repeat',
    'Words · British vocabulary', 'The lexicon', 'Your progress', 'Hands-free Commute Mode', 'Settings, sync & privacy'];
  const found = [];
  for (const title of ORDER) {
    for (const d of takes) {
      const tl = loadTimeline(d);
      const chs = tl.markers.filter((m) => m.kind === 'chapter');
      const i = chs.findIndex((m) => m.title === title);
      if (i < 0) continue;
      found.push({ title, dir: d, tl, start: chs[i].t, end: i + 1 < chs.length ? chs[i + 1].t : tl.duration });
      break;
    }
  }
  for (const [i, ch] of found.entries()) {
    const { dir, tl, start, end } = ch;
    const card = await clip(`step-${i}`, C.chapter({ kicker: `Step ${i + 1} of ${found.length}`, title: ch.title }), 2.6);
    segment(`step-${i}`, { video: card, dur: 2.6, audio: [sting(0.45)], fade: 0.2 });
    const ranges = keepRanges(tl, start, end);
    ranges.forEach(([a, b], k) => segment(`tut-${i}${ranges.length > 1 ? `-${k}` : ''}`, {
      video: join(dir, 'video.mp4'), trim: [a, b], dur: b - a,
      fadeIn: k === 0 ? 0.2 : 0, fadeOut: k === ranges.length - 1 ? 0.2 : 0,
      audio: [{ file: join(dir, 'narration.wav'), trim: [a, b], at: 0 }, { file: join(dir, 'fx.wav'), trim: [a, b], at: 0 }],
      captions: tl.audio.filter((x) => x.kind === 'narration' && x.t >= a - 0.01 && x.t < b).map((x) => ({ t: x.t - a, dur: x.dur, text: x.text })),
    }));
  }

  // =================================================================== OUTRO
  const outro = await vo('That\'s LexiPhon: offline, private, and free. Clone it, run it, and start speaking.');
  const oclip = await clip('outro', C.logo({ cta: 'github.com/preetsingh-007/schwa', theme: 'dark' }), Math.max(7, outro.dur + 2.5));
  segment('outro', { video: oclip, dur: Math.max(7, outro.dur + 2.5), fade: 0.6, audio: [{ file: music.sting, at: 0.2, gain: 0.7 }, { file: outro.file, at: 1.4, gain: 1.05 }] });
  await browser.close();

  // =================================================================== CONCAT + LOUDNESS
  const list = join(E, 'segments.txt');
  writeFileSync(list, SEGS.map((f) => `file '${f}'`).join('\n'));
  const joined = join(E, 'joined.mp4');
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
  const final = join(W, 'lexiphon-demo.mp4');
  ff(['-i', joined, '-c:v', 'copy', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-ar', String(SR), '-movflags', '+faststart', final]);
  const srt = SRT.map((c, i) => `${i + 1}\n${ts(c.start).replace('.', ',').padStart(11, '0')}0 --> ${ts(c.end).replace('.', ',').padStart(11, '0')}0\n${c.text}\n`).join('\n');
  writeFileSync(join(W, 'lexiphon-demo.srt'), srt);
  // chapter list (YouTube-style) for the description
  console.log(`\nfinal: ${final} (${probe(final).toFixed(1)} s)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
