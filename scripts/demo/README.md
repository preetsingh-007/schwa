# Demo video pipeline

Produces `lexiphon-demo.mp4`: a trailer, a setup guide and a step-by-step tutorial, recorded from the real app.

Nothing in the tutorial is mocked. Every score, IPA tape and prosody chart is computed live by the on-device models in Chromium. The one synthetic element is the learner: their voice is rendered with Kokoro and played into a virtual microphone (`lib/inject.js`). First attempts use `accent: "l2"`, which applies habits the app coaches (/θ ð/ → [t d], v/w merger, GOAT [oː], unreduced schwa…) to the RP phonemes. Retries use the RP phonemes unchanged.

## Requirements

Node 20+, `ffmpeg`, Python 3 with `numpy`, a Chromium build (set `CHROME=/path/to/chrome`) and about 1 GB of disk for the model caches.

## Run

```bash
W=/tmp/lexiphon-demo                                     # any work directory
npm run dev -- --port 5173 &                              # the app
npx vite-node scripts/demo/voice-server.ts &              # Kokoro: narrator + learner voices on :5199

node scripts/demo/capture-terminal.mjs $W/clone $W/terminal.json   # real setup commands, timed
node scripts/demo/record-tutorial.mjs $W/out/tutorial $W/profile $W/voicecache
node scripts/demo/record-setup.mjs    $W/out/setup    $W/fresh-profile $W/voicecache
node scripts/demo/make-video.mjs $W                       # → $W/lexiphon-demo.mp4 (+ .srt)
```

The first `record-tutorial` run downloads the models into `$W/profile` (about 400 MB). `record-setup` deliberately starts from an empty profile, so it shows the real first-run download, sped up on the timeline and labelled as such.

## How it fits together

| File | Role |
| --- | --- |
| `lib/inject.js` | Runs in the page: virtual mic, visible cursor, seeded `Math.random` (reproducible prompt picks), and a tap on every sound the app plays |
| `lib/recorder.mjs` | CDP screencast on a virtual clock. It can pause (for voice rendering), speed up (for downloads) and rewind (for retakes) without leaving gaps |
| `lib/session.mjs` | Cursor-animated clicks, narration (`say`), learner speech (`speak`), and app-audio capture |
| `record-*.mjs` | The scripted tours. Narration adapts to the actual results (scores, flagged words) |
| `voice-server.ts` | Kokoro render server for the narrator (`bm_george`, RP phonemes) and the learner (`bm_fable`) |
| `music.py` | Original score synthesised with numpy: trailer cue, chapter sting, bed |
| `lib/cards.mjs`, `lib/htmlclip.mjs` | Title, chapter, step and terminal cards as HTML, rendered frame by frame |
| `make-video.mjs` | The edit: trailer cut to the music's bars, setup guide, tutorial chapters, captions, loudness |
