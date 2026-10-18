// Visual layers for the phone-first demo, in two layouts:
//   wide  1920×1080 — phone on the left, feature title on the right
//   tall  1080×1920 — feature title on top, phone below
// Feature scenes are three layers: background (static), the real app footage
// placed in the phone's screen, and a transparent foreground (bezel, status
// bar, titles, illustrations). Card scenes (cold open, logo, outro) are opaque.

export const LAYOUTS = {
  wide: {
    w: 1920, h: 1080,
    // phone screen (CSS px of the output frame); status bar sits above the footage
    screen: { x: 361, y: 109, w: 398, h: 861 }, status: 45, bezel: 14, radius: 64,
    text: { x: 830, y: 300, w: 960, num: 34, title: 76, sub: 36 },
    caption: { align: 1, size: 38, marginL: 830, marginR: 130, marginV: 330 },
  },
  tall: {
    w: 1080, h: 1920,
    screen: { x: 248, y: 450, w: 585, h: 1266 }, status: 66, bezel: 20, radius: 92,
    text: { x: 90, y: 110, w: 900, num: 36, title: 66, sub: 34 },
    caption: { align: 2, size: 42, marginL: 80, marginR: 80, marginV: 46 },
  },
};

/** Where the footage goes inside the screen (below the status bar). */
export function footageRect(L) {
  const s = L.screen;
  return { x: s.x, y: s.y + L.status, w: s.w, h: s.h - L.status };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const FONTS = '<link href="https://fonts.googleapis.com/css2?family=Charis+SIL:wght@400;700&family=JetBrains+Mono:wght@500&display=block" rel="stylesheet">';
const base = (L, transparent) => `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${L.w}px;height:${L.h}px;overflow:hidden;background:${transparent ? 'transparent' : '#0b0b0c'}}
body{font-family:Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;color:#f5f5f5}
:root{--em:#10b981;--em2:#34d399;--cr:#ef4444;--ipa:'Charis SIL','DejaVu Serif',serif}
@keyframes rise{from{opacity:0;transform:translateY(22px);filter:blur(6px)}to{opacity:1;transform:none;filter:none}}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes pop{0%{opacity:0;transform:scale(.6)}70%{opacity:1;transform:scale(1.05)}100%{opacity:1;transform:scale(1)}}
@keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes up{from{transform:translateY(105%)}to{transform:none}}
@keyframes strike{from{background-size:0 4px}to{background-size:100% 4px}}
.a{opacity:0;animation:rise .7s cubic-bezier(.2,.7,.2,1) forwards}
.mark{display:inline-grid;place-items:center;background:#f5f5f5;color:#0b0b0c;border-radius:23%;font-family:var(--ipa);font-weight:700;line-height:1;padding-bottom:.36em}
`;
const page = (L, css, body, transparent = false) => `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${base(L, transparent)}${css}</style></head><body>${body}</body></html>`;
const d = (s) => `animation-delay:${s}s`;

/** Alpha mask for the footage: the screen's rounded bottom corners (the status bar covers the top). */
export function footageMask(L) {
  const R = footageRect(L), r = L.radius - L.bezel;
  return `<!doctype html><html><head><style>*{margin:0}html,body{width:${R.w}px;height:${R.h}px;background:#000;overflow:hidden}
  div{width:${R.w}px;height:${R.h}px;background:#fff;border-radius:0 0 ${r}px ${r}px}</style></head><body><div></div></body></html>`;
}

/** Static backdrop: near-black with a soft emerald glow behind the phone. */
export function background(L) {
  const s = L.screen;
  const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
  return page(L, `body{background:
    radial-gradient(${s.w * 2.2}px ${s.h * 1.1}px at ${cx}px ${cy}px, rgba(16,185,129,.20), transparent 70%),
    radial-gradient(${L.w}px ${L.h}px at ${L.w * 0.85}px ${L.h * 0.1}px, rgba(52,211,153,.07), transparent 70%),
    linear-gradient(160deg,#101112,#08090a)}`, '');
}

/** iPhone-ish frame and status bar (the screen itself stays transparent). */
function phone(L, { browser = false } = {}) {
  const s = L.screen, b = L.bezel, k = s.w / 390;
  const rr = (x, y, w, h, r) => `M${x + r},${y}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${w - 2 * r}a${r},${r} 0 0 1 -${r},-${r}v-${h - 2 * r}a${r},${r} 0 0 1 ${r},-${r}z`;
  // the bezel is a path with the screen cut out, so it covers the footage's corners exactly
  return `<div class="body" style="left:${s.x - b}px;top:${s.y - b}px;width:${s.w + 2 * b}px;height:${s.h + 2 * b}px;border-radius:${L.radius}px"></div>
  <svg class="bezel" width="${L.w}" height="${L.h}"><path fill="#1c1c1e" fill-rule="evenodd" stroke="#3a3a3c" stroke-width="2"
    d="${rr(s.x - b, s.y - b, s.w + 2 * b, s.h + 2 * b, L.radius)} ${rr(s.x, s.y, s.w, s.h, L.radius - b)}"/></svg>
  <div class="status" style="left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${L.status}px;border-radius:${L.radius - b}px ${L.radius - b}px 0 0;font-size:${15 * k}px;padding:0 ${30 * k}px">
    <b>9:41</b><span class="island" style="width:${120 * k}px;height:${34 * k}px;top:${9 * k}px"></span><span class="icons">●●●● &nbsp;<i class="bat" style="width:${24 * k}px;height:${11 * k}px"></i></span></div>
  ${browser ? `<div class="safari" style="left:${s.x}px;top:${s.y + s.h - 74 * k}px;width:${s.w}px;height:${74 * k}px;border-radius:0 0 ${L.radius - b}px ${L.radius - b}px;padding:${10 * k}px ${14 * k}px">
    <div class="url" style="height:${42 * k}px;border-radius:${14 * k}px;font-size:${15 * k}px">🔒 ${esc(browser)}</div></div>` : ''}`;
}
const PHONE_CSS = `
.body{position:absolute;box-shadow:0 40px 90px rgba(0,0,0,.55)}
.bezel{position:absolute;left:0;top:0}
.status{position:absolute;background:#fafafa;color:#0a0a0a;display:flex;align-items:center;justify-content:space-between;font-family:Inter}
.status .island{position:absolute;left:50%;transform:translateX(-50%);background:#000;border-radius:99px}
.status .icons{font-size:.7em;letter-spacing:-1px;display:flex;align-items:center}
.status .bat{display:inline-block;border:1.5px solid #0a0a0a;border-radius:3px;background:linear-gradient(90deg,#0a0a0a 75%,transparent 75%)}
.safari{position:absolute;background:rgba(242,242,247,.96);border-top:1px solid #d1d1d6}
.safari .url{background:#fff;display:flex;align-items:center;justify-content:center;color:#1c1c1e;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.tag{position:absolute;background:rgba(10,10,10,.75);color:#fff;font:600 13px Inter;letter-spacing:.12em;text-transform:uppercase;padding:6px 10px;border-radius:6px}
`;

function titleBlock(L, f) {
  const t = L.text;
  return `<div class="tb" style="left:${t.x}px;top:${t.y}px;width:${t.w}px">
    <div class="num a" style="font-size:${t.num}px">${esc(f.num)} <span>/ 08</span></div>
    <div class="title a" style="font-size:${t.title}px;${d(0.12)}">${esc(f.title)}</div>
    <div class="line" style="${d(0.35)}"></div>
    <div class="sub a" style="font-size:${t.sub}px;${d(0.3)}">${esc(f.sub)}</div></div>`;
}
const TITLE_CSS = `
.tb{position:absolute}
.num{font-family:'JetBrains Mono',monospace;font-weight:500;color:var(--em2);letter-spacing:.06em}
.num span{color:#6b6b6b}
.title{font-family:'Inter Display',Inter;font-weight:700;letter-spacing:-.025em;line-height:1.04;margin-top:14px}
.sub{color:#bdbdbd;line-height:1.3;margin-top:22px}
.line{width:120px;height:5px;border-radius:3px;background:var(--em);margin-top:26px;transform-origin:left;transform:scaleX(0);animation:grow .7s ease-out forwards}
`;

/** Foreground for a feature scene. */
export function featureFg(L, f) {
  return page(L, PHONE_CSS + TITLE_CSS, phone(L) + titleBlock(L, f), true);
}

/**
 * Foreground for the "get it" scene: Safari with the URL, then the share sheet
 * and home screen (both drawn, and labelled as illustrations), then the
 * installed app with no browser chrome. t = { sheet, home, tap, app, fast? } in seconds;
 * fast = { from, to, n } labels the fast-forwarded engine download.
 */
export function getFg(L, { url, t }) {
  const s = L.screen, k = s.w / 390;
  const sr = L.radius - L.bezel;
  const at = (x) => `animation-delay:${x}s`;
  const apps = ['#ff9f0a', '#30d158', '#0a84ff', '#bf5af2', '#ff375f', '#64d2ff', '#ffd60a', '#5e5ce6', '#ac8e68', '#66d4cf', '#ff6961', '#8e8e93'];
  const css = PHONE_CSS + TITLE_CSS + `
  .browse{animation:fade .01s linear forwards reverse;${at(t.app)}}
  .clip{position:absolute;left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px;border-radius:${sr}px;overflow:hidden}
  .sheet{position:absolute;left:0;width:${s.w}px;top:${s.h * 0.42}px;height:${s.h * 0.58}px;background:#f2f2f7;border-radius:${16 * k}px ${16 * k}px ${sr}px ${sr}px;
    transform:translateY(105%);animation:up .45s cubic-bezier(.2,.8,.2,1) forwards, fade .01s linear forwards reverse;animation-delay:${t.sheet}s, ${t.home}s;padding:${18 * k}px ${16 * k}px;box-shadow:0 -10px 40px rgba(0,0,0,.25)}
  .sheet .row{background:#fff;border-radius:${12 * k}px;padding:${14 * k}px ${16 * k}px;font-size:${16 * k}px;color:#1c1c1e;margin-bottom:${10 * k}px;display:flex;justify-content:space-between}
  .sheet .row.hl{outline:${3 * k}px solid var(--em);animation:fade .3s ease forwards;${at(t.sheet + 0.6)};opacity:.4}
  .sheet .apps{display:flex;gap:${14 * k}px;margin:${4 * k}px 0 ${16 * k}px}
  .sheet .apps i{width:${56 * k}px;height:${56 * k}px;border-radius:${14 * k}px;display:block}
  .home{position:absolute;left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px;border-radius:${sr}px;overflow:hidden;opacity:0;
    background:linear-gradient(170deg,#0f3d33,#0b0b0c 70%);animation:fade .3s ease forwards, fade .01s linear forwards reverse;animation-delay:${t.home}s, ${t.app}s;
    padding:${80 * k}px ${26 * k}px;display:grid;grid-template-columns:repeat(4,1fr);gap:${26 * k}px ${18 * k}px;align-content:start}
  .home .ic{display:flex;flex-direction:column;align-items:center;gap:${6 * k}px;color:#fff;font-size:${11 * k}px}
  .home .ic i{width:${60 * k}px;height:${60 * k}px;border-radius:${14 * k}px;display:block;opacity:.85}
  .home .ic.me i{opacity:1;background:#0a0a0a;display:grid;place-items:center;font:700 ${38 * k}px var(--ipa);color:#fafafa;padding-bottom:${12 * k}px;font-style:normal;box-shadow:0 0 0 ${2 * k}px rgba(255,255,255,.25)}
  .home .ic.me{animation:pop .5s ease forwards;${at(t.home + 0.4)};opacity:0}
  .tapdot{position:absolute;width:${46 * k}px;height:${46 * k}px;border-radius:50%;background:rgba(255,255,255,.45);border:2px solid #fff;opacity:0;animation:fade .15s ease forwards, fade .2s ease forwards reverse;animation-delay:${t.tap}s, ${t.tap + 0.35}s}
  .tag.ill{opacity:0;animation:fade .2s forwards, fade .01s linear forwards reverse;animation-delay:${t.sheet}s, ${t.app}s}
  .tag.ff{opacity:0;background:var(--em);color:#04120c;animation:fade .2s forwards, fade .2s linear forwards reverse;animation-delay:${t.fast?.from ?? 999}s, ${t.fast?.to ?? 999}s}`;
  // the app icon sits in grid slot 6 (row 2, col 2)
  const col = 1, row = 1, cellW = (s.w - 52 * k - 3 * 18 * k) / 4;
  const icx = s.x + 26 * k + col * (cellW + 18 * k) + cellW / 2, icy = s.y + 80 * k + row * (60 * k + 6 * k + 13 * k + 26 * k) + 30 * k;
  const body = `<div class="browse">${phone(L, { browser: url })}</div>${phone(L)}
  <div class="clip"><div class="sheet"><div class="apps">${apps.slice(0, 5).map((c) => `<i style="background:${c}"></i>`).join('')}</div>
    <div class="row"><span>Copy</span><span>⧉</span></div><div class="row hl"><span><b>Add to Home Screen</b></span><span>⊞</span></div><div class="row"><span>Add Bookmark</span><span>☆</span></div></div></div>
  <div class="home">${apps.map((c, i) => (i === 5 ? '<div class="ic me"><i>ə</i>schwa</div>' : `<div class="ic"><i style="background:${c}"></i>&nbsp;</div>`)).join('')}</div>
  <div class="tapdot" style="left:${icx - 23 * k}px;top:${icy - 23 * k}px"></div>
  <div class="tag ill" style="left:${s.x + s.w / 2}px;top:${s.y + s.h - 44 * k}px;transform:translateX(-50%)">Illustration</div>
  ${t.fast ? `<div class="tag ff" style="left:${s.x + s.w / 2}px;top:${s.y + s.h - 44 * k}px;transform:translateX(-50%)">▶▶ ${t.fast.n}× · one-time download</div>` : ''}
  ${titleBlock(L, { num: '▶', title: 'Get schwa', sub: `${url} → Add to Home Screen` }).replace('<span>/ 08</span>', '')}`;
  return page(L, css, body, true);
}

/** Cold open: the problem, in two beats timed to the voice. */
export function coldCard(L, { t1, t2 }) {
  const wide = L.w > L.h;
  const css = `.wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 ${wide ? 150 : 90}px;gap:${wide ? 34 : 40}px}
  .l{font-family:'Inter Display',Inter;font-weight:700;letter-spacing:-.03em;line-height:1.1}
  .l1{font-size:${wide ? 84 : 100}px}.l2{font-size:${wide ? 64 : 76}px;color:#d4d4d4}
  .acc{color:var(--em2)}
  .x{color:#fca5a5;background:linear-gradient(var(--cr),var(--cr)) no-repeat 0 55%/0 4px;animation:strike .5s ease-out forwards;${d(t2 + 1.9)}}`;
  return page(L, css, `<div class="wrap"><div class="l l1 a" style="${d(t1)}">You know the words.</div>
    <div class="l l2 a" style="${d(t2)}">But your <span class="acc">accent</span> and the <span class="x">extra&nbsp;words</span> still get in the way.</div></div>`);
}

/** Logo lock-up: the ə mark, the wordmark, the line. */
export function logoCard(L, { tag, sub2 = '', t2 = 1.2 }) {
  const wide = L.w > L.h;
  const css = `.wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:0 60px;
    background:radial-gradient(${L.w * 0.6}px ${L.h * 0.5}px at 50% 45%, rgba(16,185,129,.16), transparent 70%)}
  .mark{width:${wide ? 170 : 210}px;height:${wide ? 170 : 210}px;font-size:${wide ? 128 : 158}px;opacity:0;animation:pop .8s cubic-bezier(.2,.8,.2,1.15) forwards}
  .name{font-family:'Inter Display',Inter;font-weight:700;font-size:${wide ? 120 : 140}px;letter-spacing:-.04em;margin-top:28px}
  .line{width:${wide ? 320 : 360}px;height:4px;background:var(--em);margin-top:22px;transform-origin:left;transform:scaleX(0);animation:grow .8s ease-out forwards}
  .tag{font-size:${wide ? 36 : 42}px;color:#d4d4d4;margin-top:26px}
  .s2{font-size:${wide ? 26 : 32}px;color:#9a9a9a;margin-top:46px;font-family:'JetBrains Mono',monospace;line-height:1.6}`;
  return page(L, css, `<div class="wrap"><div class="mark" style="${d(0.05)}">ə</div><div class="name a" style="${d(0.35)}">schwa</div>
    <div class="line" style="${d(0.7)}"></div><div class="tag a" style="${d(t2)}">${esc(tag)}</div>${sub2 ? `<div class="s2 a" style="${d(t2 + 0.8)}">${sub2}</div>` : ''}</div>`);
}
