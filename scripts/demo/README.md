# Demo video pipeline

Produces two cuts of the same ~2:15 demo:

| File | Format |
| --- | --- |
| `schwa-demo.mp4` | 16:9, 1920×1080: phone on the left, feature title on the right |
| `schwa-demo-vertical.mp4` | 9:16, 1080×1920: for phones, Shorts and Reels |
| `schwa-demo.srt` | Captions (they are also burned into both videos) |

Structure: a cold open, then "Meet schwa", eight numbered features shown on a phone, how to get it (open the GitHub Pages link, Add to Home Screen, load the engine once), and an outro.

## What's real

All app footage is the real app. It runs at phone size (390×800 CSS at 2×, with touch emulation) and is driven by Playwright. Every score, IPA tape and pitch chart is computed live by the on-device models.

What isn't real:
- **The learner's voice** is synthesised with Kokoro and played into a virtual microphone (`lib/inject.js`). First attempts use `accent: "l2"`, which applies habits the app coaches to the RP phonemes (/θ ð/ → [t d], v/w merger, GOAT [oː], unreduced schwa…). Retries are plain RP.
- **The narration** uses two Kokoro voices, `bf_emma` and `bm_george`.
- **The Safari share sheet and the home screen** in "Get schwa" are drawn, and labelled *Illustration* on screen.
- **The engine download** is visibly fast-forwarded.
- **The music** is original, synthesised with NumPy (`music.py`).

## Run

Requires Node 20+, `ffmpeg`, Python 3 with `numpy`, and a Chromium build (set `CHROME=/path/to/chrome`).

```bash
W=/tmp/schwa-demo
npm run dev -- --port 5173 &                         # the app
npx vite-node scripts/demo/voice-server.ts &         # Kokoro voices on :5199

node scripts/demo/record-phone.mjs $W/phone $W/profile $W/fresh-profile $W/voicecache
node scripts/demo/make-video.mjs $W                  # → $W/schwa-demo.mp4, -vertical.mp4, .srt
```

To redo a single feature, record a pick-up take, for example `ONLY=tier2 node scripts/demo/record-phone.mjs $W/phone-t2 …`. The edit prefers `phone-*` takes over the main one. `PLAN_ONLY=1 node scripts/demo/make-video.mjs $W` prints the scene timings without rendering.

## How it fits together

| File | Role |
| --- | --- |
| `script.json` | Every narration line, plus each feature's number, title and subtitle |
| `record-phone.mjs` | Performs each feature once in the real app and drops named marks (`t1_tap`, `rp_chart`…) |
| `lib/recorder.mjs` | CDP screencast on a virtual clock. It can pause (for renders) and rewind (for retakes) without gaps |
| `lib/session.mjs`, `lib/app.mjs` | Phone or desktop browser session, tap indicator, learner speech, app-audio capture, and app helpers |
| `make-video.mjs` | The edit. Scenes are cut from the marks, timed to whole bars at 100 BPM, scored, captioned and rendered in both layouts |
| `lib/scenes.mjs`, `lib/htmlclip.mjs` | Phone frame, titles, cards and illustrations as HTML, rendered frame by frame (with alpha for overlays) |
| `music.py` | The score, generated from the scene plan: intro, logo hit, groove, breakdown, outro |
| `voice-server.ts` | Kokoro render server for the narrators and the learner |
