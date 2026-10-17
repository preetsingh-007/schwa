// HTML templates for the video's cards, in the app's own visual language
// (Inter, ink on paper, the ə glyph, emerald / amber / crimson accents).
// Every page is 1280×720 CSS px, captured at 1.5× → 1920×1080.

const FONTS = '<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Charis+SIL:wght@400;700&display=block" rel="stylesheet">';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const BASE = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1280px;height:720px;overflow:hidden}
body{font-family:Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;background:var(--bg);color:var(--ink)}
.light{--bg:#fafafa;--ink:#0a0a0a;--ink2:#3d3d3d;--muted:#737373;--rule:#e2e2e2;--card:#fff}
.dark{--bg:#0a0a0a;--ink:#f5f5f5;--ink2:#d4d4d4;--muted:#9a9a9a;--rule:#262626;--card:#141414}
:root{--em:#10b981;--em-ink:#047857;--amb:#f59e0b;--cr:#ef4444;--cr-ink:#b91c1c;--mono:'JetBrains Mono',ui-monospace,monospace;--ipa:'Charis SIL','DejaVu Serif',serif}
.mark{display:inline-grid;place-items:center;background:var(--ink);color:var(--bg);border-radius:22%;font-family:var(--ipa);font-weight:700;line-height:1;padding-bottom:.36em}
.kicker{font-size:15px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
@keyframes rise{from{opacity:0;transform:translateY(18px);filter:blur(6px)}to{opacity:1;transform:none;filter:none}}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes fadeout{from{opacity:1}to{opacity:0}}
@keyframes pop{0%{opacity:0;transform:scale(.6)}70%{opacity:1;transform:scale(1.04)}100%{opacity:1;transform:scale(1)}}
@keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.a{opacity:0;animation:rise .7s cubic-bezier(.2,.7,.2,1) forwards}
`;

function page(theme, css, body) {
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${BASE}${css}</style></head><body class="${theme}">${body}</body></html>`;
}
const d = (s) => `animation-delay:${s}s`;

/** Kinetic statement: lines rise in one after another. */
export function statement({ lines, theme = 'dark', size = 76, out = null }) {
  const css = `.wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 120px;gap:10px}
  .l{font-family:'Inter Display',Inter;font-weight:700;font-size:${size}px;letter-spacing:-.025em;line-height:1.08}
  .l em{font-style:normal;color:var(--em)} .l s{text-decoration:none;color:var(--muted)}
  .out{animation:fadeout .5s ease-in forwards;animation-delay:${out ?? 99}s}`;
  return page(theme, css, `<div class="wrap out">${lines.map((l, i) => `<div class="l a" style="${d(0.15 + i * (l.delay ?? 0.55))}">${l.html ?? esc(l)}</div>`).join('')}</div>`);
}

/** The three streams side by side on one phrase. */
export function triad() {
  const col = (k, title, model, body, i) => `<div class="col a" style="${d(0.3 + i * 0.9)}"><div class="kicker">${k}</div><div class="t">${title}</div><div class="v">${body}</div><div class="m">${model}</div></div>`;
  const css = `.wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 90px}
  h1{font-family:'Inter Display';font-size:46px;font-weight:700;letter-spacing:-.02em;margin-bottom:44px}
  .row{display:grid;grid-template-columns:repeat(3,1fr);gap:26px}
  .col{background:var(--card);border:1px solid var(--rule);border-radius:16px;padding:28px 30px}
  .t{font-size:27px;font-weight:700;margin:10px 0 22px}
  .v{font-family:var(--ipa);font-size:46px;line-height:1.1;min-height:60px}
  .v.txt{font-family:Inter;font-weight:600;font-size:40px}
  .m{margin-top:22px;font-family:var(--mono);font-size:15px;color:var(--muted)}
  .bad{color:#fff;background:var(--cr);border-radius:6px;padding:0 4px}
  .ok{color:var(--em)}`;
  return page('dark', css, `<div class="wrap"><h1 class="a" style="${d(0)}">Three streams. One phrase: <span style="color:var(--em)">“car park”</span></h1><div class="row">
    ${col('Stream A', 'What you meant', 'Whisper · on device', '<span class="txt" style="font-family:Inter;font-weight:600;font-size:40px">car park</span>', 0)}
    ${col('Stream B', 'What you actually said', 'wav2vec2 IPA · on device', 'kɑː<span class="bad">ɹ</span> pɑː<span class="bad">ɹ</span>k', 1)}
    ${col('Stream C', 'What RP would say', 'espeak-ng + connected speech', '<span class="ok">kɑː pɑːk</span>', 2)}
  </div></div>`);
}

/** Feature badges popping in. */
export function badges({ title, items, theme = 'dark' }) {
  const css = `.wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:46px}
  h1{font-family:'Inter Display';font-size:54px;font-weight:700;letter-spacing:-.02em;text-align:center}
  .g{display:grid;grid-template-columns:repeat(2,460px);gap:20px}
  .b{opacity:0;animation:pop .55s cubic-bezier(.2,.8,.2,1.2) forwards;display:flex;gap:18px;align-items:center;background:var(--card);border:1px solid var(--rule);border-radius:14px;padding:22px 26px}
  .i{width:44px;height:44px;border-radius:12px;background:var(--em);display:grid;place-items:center;color:#04120c;font-weight:800;font-size:22px;flex:none}
  .b b{display:block;font-size:24px} .b span{color:var(--muted);font-size:17px}`;
  return page(theme, css, `<div class="wrap"><h1 class="a">${title}</h1><div class="g">${items.map((x, i) => `<div class="b" style="${d(0.5 + i * 0.35)}"><div class="i">✓</div><div><b>${esc(x[0])}</b><span>${esc(x[1])}</span></div></div>`).join('')}</div></div>`);
}

/** Logo lock-up. */
export function logo({ sub = 'Modern RP & lexical compression coach', cta = '', theme = 'dark', glyphDelay = 0.1 }) {
  const css = `.wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center}
  .mark{width:150px;height:150px;font-size:112px;opacity:0;animation:pop .8s cubic-bezier(.2,.8,.2,1.15) forwards}
  .name{font-family:'Inter Display';font-weight:700;font-size:96px;letter-spacing:-.03em;margin-top:30px}
  .sub{font-size:28px;color:var(--ink2);margin-top:10px}
  .cta{margin-top:56px;font-size:20px;font-weight:600;color:var(--muted);letter-spacing:.08em;text-transform:uppercase}
  .line{width:420px;height:2px;background:var(--em);margin-top:30px;transform-origin:left;transform:scaleX(0);animation:grow .8s ease-out forwards}`;
  return page(theme, css, `<div class="wrap"><div class="mark" style="${d(glyphDelay)}">ə</div><div class="name a" style="${d(glyphDelay + 0.45)}">LexiPhon</div>
  <div class="line" style="${d(glyphDelay + 0.8)}"></div><div class="sub a" style="${d(glyphDelay + 1.0)}">${esc(sub)}</div>${cta ? `<div class="cta a" style="${d(glyphDelay + 1.6)}">${esc(cta)}</div>` : ''}</div>`);
}

/** Part / chapter divider. */
export function chapter({ kicker, title, sub = '', num = '' }) {
  const css = `.wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 140px}
  .num{font-family:'Inter Display';font-size:150px;font-weight:800;color:var(--rule);line-height:1;letter-spacing:-.04em}
  h1{font-family:'Inter Display';font-size:78px;font-weight:700;letter-spacing:-.03em;margin-top:8px}
  p{font-size:28px;color:var(--ink2);margin-top:18px;max-width:900px;line-height:1.35}
  .bar{position:absolute;left:140px;bottom:110px;width:180px;height:6px;border-radius:3px;background:var(--em);transform-origin:left;transform:scaleX(0);animation:grow .9s .4s ease-out forwards}
  .brand{position:absolute;right:60px;top:46px;display:flex;align-items:center;gap:12px;font-weight:700;font-size:22px}
  .brand .mark{width:38px;height:38px;font-size:26px}`;
  return page('light', css, `<div class="brand a"><span class="mark">ə</span>LexiPhon</div><div class="wrap">${num ? `<div class="num a">${esc(num)}</div>` : ''}<div class="kicker a" style="${d(0.15)}">${esc(kicker)}</div><h1 class="a" style="${d(0.3)}">${esc(title)}</h1>${sub ? `<p class="a" style="${d(0.55)}">${sub}</p>` : ''}</div><div class="bar"></div>`);
}

/** Numbered steps, appearing one by one (each step: [title, detail, code?]). */
export function steps({ kicker, title, items, gap = 1.1 }) {
  const css = `.wrap{position:absolute;inset:0;padding:70px 110px}
  h1{font-family:'Inter Display';font-size:52px;font-weight:700;letter-spacing:-.02em;margin:8px 0 34px}
  ol{list-style:none;display:flex;flex-direction:column;gap:16px}
  li{display:flex;gap:22px;align-items:flex-start;background:var(--card);border:1px solid var(--rule);border-radius:14px;padding:18px 24px}
  .n{flex:none;width:40px;height:40px;border-radius:50%;background:var(--ink);color:var(--bg);display:grid;place-items:center;font-weight:700;font-size:19px}
  li b{font-size:24px;display:block} li span{font-size:19px;color:var(--ink2);display:block;margin-top:4px;line-height:1.4}
  code{font-family:var(--mono);font-size:17px;background:#f2f2f2;border:1px solid var(--rule);border-radius:6px;padding:1px 7px;color:#0a0a0a}`;
  return page('light', css, `<div class="wrap"><div class="kicker a">${esc(kicker)}</div><h1 class="a" style="${d(0.15)}">${esc(title)}</h1><ol>${items.map((s, i) => `<li class="a" style="${d(0.6 + i * gap)}"><div class="n">${i + 1}</div><div><b>${s[0]}</b><span>${s[1]}</span></div></li>`).join('')}</ol></div>`);
}

/**
 * A terminal that replays a real session. script: [{cmd, at}] or [{out:[lines], at, dur}].
 * Commands type out; output lines appear spread across `dur` seconds.
 */
export function terminal({ title = 'Terminal', script, prompt = '~/schwa' }) {
  const css = `.win{position:absolute;left:90px;right:90px;top:56px;bottom:56px;background:#0d1117;border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.35);overflow:hidden;border:1px solid #30363d}
  .bar{height:44px;background:#161b22;display:flex;align-items:center;gap:9px;padding:0 18px;border-bottom:1px solid #30363d}
  .dot{width:13px;height:13px;border-radius:50%} .ttl{flex:1;text-align:center;color:#8b949e;font-size:15px;margin-right:60px}
  pre{font-family:var(--mono);font-size:19px;line-height:1.5;color:#c9d1d9;padding:22px 28px;position:absolute;left:0;right:0;bottom:0;top:44px;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end}
  pre>div{white-space:pre-wrap;word-break:break-word}
  .p{color:#3fb950} .dir{color:#58a6ff} .c{color:#f0f6fc} .dim{color:#8b949e} .ok{color:#3fb950} .err{color:#f85149} .cur{background:#c9d1d9;color:#0d1117}`;
  const body = `<div class="win"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="ttl">${esc(title)}</span></div><pre><div id="o"></div></pre></div>
  <script>
  const S=${JSON.stringify(script)}, P=${JSON.stringify(prompt)};
  const esc=(s)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const color=(l)=>{const e=esc(l);
    if(/\\b(passed|✓|ready in|added \\d+ packages)/i.test(l))return '<span class="ok">'+e+'</span>';
    if(/\\b(failed|error)\\b/i.test(l)&&!/0 failed/.test(l))return '<span class="err">'+e+'</span>';
    if(/^\\s*(>|npm notice|\\[copy-ort\\])/.test(l))return '<span class="dim">'+e+'</span>';
    return e;};
  window.seek=(t)=>{let h='';let cursorDone=false;
    for(let i=0;i<S.length;i++){const s=S[i];if(t<s.at)break;
      if(s.cmd!==undefined){const typed=s.cmd.slice(0,Math.floor((t-s.at)*24));const done=typed.length===s.cmd.length;
        const next=S[i+1];const active=!next||t<next.at;
        h+='<span class="p">➜</span> <span class="dir">'+P+'</span> <span class="c">'+esc(typed)+'</span>'+(active&&(!done||Math.floor(t*2)%2===0)?'<span class="cur"> </span>':'')+'\\n';}
      else{const n=Math.min(s.out.length,Math.floor((t-s.at)/Math.max(.001,s.dur)*s.out.length)+1);h+=s.out.slice(0,n).map(color).join('\\n')+'\\n';}}
    const last=S.filter(s=>t>=s.at).at(-1);
    if(last&&last.out&&last.prompt!==false&&t>=last.at+last.dur+0.3)h+='<span class="p">➜</span> <span class="dir">'+P+'</span> '+(Math.floor(t*2)%2===0?'<span class="cur"> </span>':'');
    document.getElementById('o').innerHTML=h;};
  window.seek(0);
  </script>`;
  return page('light', css + 'body{background:linear-gradient(135deg,#e8ecef,#f7f7f5)}', body);
}

/** A browser window frame; the viewport is transparent so footage shows through. */
export function browserFrame({ url = 'localhost:5173' }) {
  // Viewport hole: 1088×612 CSS at (96, 84) → 1632×918 px at (144, 126), where make-video pads the footage.
  const css = `body{background:transparent}
  .win{position:absolute;left:96px;top:36px;width:1088px;height:660px;border-radius:12px;box-shadow:0 0 0 1px rgba(0,0,0,.14),0 0 0 9999px #e9ecef}
  .top{position:absolute;left:96px;top:36px;width:1088px;height:48px;background:#f1f3f4;border-radius:12px 12px 0 0;border-bottom:1px solid #dadce0;display:flex;align-items:center;gap:9px;padding:0 16px}
  .dot{width:12px;height:12px;border-radius:50%} .url{margin-left:22px;flex:1;height:30px;background:#fff;border-radius:15px;display:flex;align-items:center;padding:0 16px;font-size:15px;color:#202124;gap:10px}
  .url i{font-style:normal;color:#5f6368}`;
  return page('light', css, `<div class="win"></div><div class="top"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><div class="url"><i>ⓘ</i>${esc(url)}</div></div>`);
}

/** Lower-third label for tutorial chapters (transparent background). */
export function lowerThird({ kicker, title }) {
  const css = `body{background:transparent}
  .lt{position:absolute;left:44px;bottom:44px;display:flex;align-items:stretch;background:rgba(10,10,10,.9);color:#fff;border-radius:12px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.25)}
  .bar{width:7px;background:var(--em)} .tx{padding:13px 24px 14px 18px}
  .k{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#9a9a9a;font-weight:600} .t{font-size:25px;font-weight:700;margin-top:2px}`;
  return page('light', css, `<div class="lt"><div class="bar"></div><div class="tx"><div class="k">${esc(kicker)}</div><div class="t">${esc(title)}</div></div></div>`);
}

/** Corner badge for sped-up footage. */
export function speedBadge({ text }) {
  const css = `body{background:transparent}.b{position:absolute;right:40px;top:40px;background:rgba(10,10,10,.88);color:#fff;font:700 24px Inter;padding:10px 18px;border-radius:10px;display:flex;gap:10px;align-items:center}.b i{font-style:normal;color:#10b981}`;
  return page('light', css, `<div class="b"><i>▶▶</i>${esc(text)}</div>`);
}
