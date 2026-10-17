// Runs in the page before the app. Provides a virtual microphone the driver can
// "speak" into, a visible cursor, and a tap on every sound the app plays.
(() => {
  // Reproducible prompt choice: the bandit breaks ties with Math.random.
  let seed = Number(localStorage.getItem('__demoSeed') || 7) >>> 0;
  Math.random = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  const AC = window.AudioContext;
  let micCtx = null, micDest = null;
  const ensureMic = () => {
    if (!micCtx) { micCtx = new AC({ sampleRate: 48000 }); micDest = micCtx.createMediaStreamDestination(); }
    return micCtx;
  };
  const b64ToF32 = (b64) => {
    const bin = atob(b64); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const i16 = new Int16Array(u8.buffer); const f = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
    return f;
  };
  window.__micSpeak = async (b64, sr) => {
    const ctx = ensureMic(); await ctx.resume();
    const x = b64ToF32(b64);
    const buf = ctx.createBuffer(1, x.length, sr); buf.copyToChannel(x, 0);
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(micDest);
    await new Promise((r) => { src.onended = r; src.start(); });
  };
  navigator.mediaDevices.getUserMedia = async () => { ensureMic(); await micCtx.resume(); return micDest.stream; };

  // Tap app playback: every AudioBufferSourceNode.start() is reported with its PCM.
  const origStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...args) {
    try {
      if (this.context !== micCtx && this.buffer && window.__onAppAudio) {
        const d = this.buffer.getChannelData(0);
        const i16 = new Int16Array(d.length);
        for (let i = 0; i < d.length; i++) i16[i] = Math.max(-1, Math.min(1, d[i])) * 32767;
        let s = ''; const u8 = new Uint8Array(i16.buffer);
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        const id = Math.random().toString(36).slice(2);
        window.__onAppAudio({ id, sr: this.buffer.sampleRate, b64: btoa(s), offset: args[1] || 0 });
        const prevStop = this.stop.bind(this);
        this.stop = (...a) => { window.__onAppAudioStop && window.__onAppAudioStop(id); return prevStop(...a); };
      }
    } catch (e) { console.warn('tap failed', e); }
    return origStart.apply(this, args);
  };
  // <audio> playback (pre-rendered vocabulary clips): report the URL.
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { window.__onMediaPlay && window.__onMediaPlay(this.currentSrc || this.src); return origPlay.call(this); };

  // System voice: report text so the driver knows (we render it ourselves).
  if (window.speechSynthesis) {
    const origSpeak = speechSynthesis.speak.bind(speechSynthesis);
    speechSynthesis.speak = (u) => { window.__onSystemSpeak && window.__onSystemSpeak(u.text); setTimeout(() => u.onend && u.onend(new Event('end')), 1500); };
  }

  // Visible cursor + click ripple (headless captures have no pointer).
  const css = `#__cur{position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;transform:translate(-3px,-2px);transition:opacity .2s;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
  .__rip{position:fixed;z-index:2147483646;pointer-events:none;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #2563eb;background:rgba(37,99,235,.18);animation:__rip .55s ease-out forwards}
  @keyframes __rip{from{transform:scale(.3);opacity:1}to{transform:scale(1.6);opacity:0}}
  #__key{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;font:600 18px Inter,sans-serif;color:#fff;background:rgba(10,10,10,.82);padding:10px 18px;border-radius:10px;opacity:0;transition:opacity .2s}`;
  const mount = () => {
    if (document.getElementById('__cur')) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const c = document.createElement('div'); c.id = '__cur';
    c.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2l16 9.5-7 1.6-3.6 6.4z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    const k = document.createElement('div'); k.id = '__key'; document.body.appendChild(k);
    const p = window.__curPos || { x: -50, y: -50 }; c.style.left = p.x + 'px'; c.style.top = p.y + 'px';
  };
  window.__cursor = (x, y) => { mount(); window.__curPos = { x, y }; const c = document.getElementById('__cur'); c.style.left = x + 'px'; c.style.top = y + 'px'; };
  window.__ripple = (x, y) => { const r = document.createElement('div'); r.className = '__rip'; r.style.left = x + 'px'; r.style.top = y + 'px'; document.body.appendChild(r); setTimeout(() => r.remove(), 700); };
  window.__keycap = (txt) => { mount(); const k = document.getElementById('__key'); if (!txt) { k.style.opacity = 0; return; } k.innerHTML = txt; k.style.opacity = 1; };
  document.addEventListener('mousemove', (e) => window.__cursor(e.clientX, e.clientY), true);
  document.addEventListener('mousedown', (e) => window.__ripple(e.clientX, e.clientY), true);
  document.addEventListener('DOMContentLoaded', mount);
})();
