# LexiPhon

**Modern RP & lexical compression coach.** An offline-first, installable PWA where every learning interaction is spoken. It transcribes what you *meant* (Whisper), what your vocal tract *actually produced* (a wav2vec2 IPA model), and what a Modern RP speaker *would* say (espeak-ng + connected-speech rules). It then aligns them phoneme by phoneme and coaches you to say it again: shorter, crisper and more British.

All inference runs on-device in a Web Worker (ONNX Runtime Web via Transformers.js; WebGPU when available, WASM otherwise). Hosting is static on GitHub Pages and costs nothing. Progress lives in IndexedDB and can optionally sync to **your own private GitHub repo**. A Gemini key is supported but entirely optional.

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # 45 unit tests (aligner, DSP, FSRS, bandit, rules, sync)
npm run build        # static PWA in dist/
```

Open the app, tap **Load offline engine** (a one-time download, about 305 MB, cached for offline use), then tap the mic or hold **Space**.

### Deploying

`.github/workflows/deploy.yml` builds and deploys on every push to `main`. In the repo's **Settings → Pages**, set *Source* to **GitHub Actions**. The workflow sets `BASE_PATH=/<repo>/`, so the app is served at `https://<user>.github.io/<repo>/`. To install it, use *Share → Add to Home Screen* on iPhone/iPad, or *File → Add to Dock* in Safari on macOS.

## How a turn works

| Stream | Implementation | Output |
| --- | --- | --- |
| A · lexical intent | `onnx-community/whisper-tiny.en`, q8 (~41 MB) | plain-English transcript |
| B · acoustic phonemes | `onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX`, q4 (~242 MB), greedy CTC with 20 ms timings, ≤10 s chunks | produced IPA, including [ʈ ɖ ʋ oː eː ɾ] and rhotic /r/ |
| C · RP ground truth | espeak-ng WASM (`en-gb-x-rp` voice) per word + weak forms, linking /r/, licensed /t/→[ʔ], happY tensing | connected-speech target IPA |
| D · analysis | weighted Needleman–Wunsch on articulatory features; YIN F0, RMS, nPVI, pause detection; 615-rule redundancy dictionary; MiniLM similarity | diagnoses, schwa rate, prosody, conciseness |

The reward is **R(u) = w₁·S_phonetic + w₂·S_prosody + w₃·S_lexical**, with tier weights (0.75/0.25/0), (0.40/0.20/0.40) and (0.35/0.30/0.35). A prompt only advances when R ≥ 80 **and** no critical redundancy remains. Otherwise you have to **speak** the 1-line compressed target again.

The learner state S_t is a 44 × 61 phoneme confusion matrix (44 RP phonemes, plus tracked interference phones, deletion and "other" columns) updated by EWMA (α = 0.15). It also holds the V_R prosody/conciseness vector, per-habit EWMA rates and FSRS-4.5 cards for every vocabulary item. The next prompt is chosen by a UCB contextual bandit:

```
p* = argmax  β1·Σφ(1 − M_P[φ,φ])/√|Φp|  +  β2·Σv(1 − P_recall(v,t))  +  β3·√(2 ln N / (n_p + 1))
```

Tapping a phoneme on the dashboard heatmap biases the bandit toward prompts containing that phoneme (a targeted drill).

## Curated data (`public/data/`)

| File | Contents |
| --- | --- |
| `rp_phonemes_44.json` | 44 RP phonemes: articulation, mechanics, chart position, common interference |
| `vocab_curriculum.json` | 83 register-badged items (🟢 48 · 🟡 24 · 🔴 11) following the PRD card schema |
| `redundancy_rules.json` | 615 patterns: scaffolds, fillers, wordy phrases, pleonasms, Indian-English set phrases, hedges, intensifiers, British upgrades |
| `prompts_tiered.json` | 71 Tier 1 drills, 58 Tier 2 compression items, 511 Tier 3 scenarios (51 templates × 10 workplace domains, plus 1 general) |

The JSON is generated from `scripts/data-src/*.py` (`python3 scripts/data-src/gen.py`) and then annotated by `npm run annotate`. Annotation runs the same espeak G2P as the browser and fills in each prompt's phoneme set and each vocab example's connected IPA. Always run both steps after editing the content.

`scripts/pipeline-check.ts` runs the real models in Node on a recording, which is handy for checking the analysis end to end.

## Sync (your data, your repo)

1. Create a **private** repo, for example `lexiphon-data`.
2. Create a **fine-grained PAT** with access to *only that repo* and the **Contents: Read and write** permission.
3. In Settings, enter the owner, repo and token, then tap **Verify & push now**. LexiPhon refuses to push to a public repo.

The state is written to `state/lexiphon_state.json` through the Contents API with SHA optimistic locking. On a conflict the app re-pulls, merges and retries. Merging is deterministic:

- vocabulary: the latest review wins and histories are unioned
- confusion-matrix rows: EWMA blend with λ = 1 − (1 − α)^k, where k is the number of local observations since the last sync
- sessions: union by id

Offline changes stay queued as a dirty flag and are pushed when connectivity returns or the app is backgrounded. Export and Import JSON work without GitHub. The token is stored only in this browser's IndexedDB.

## Optional Gemini enhancer

If you paste a Google AI Studio key and enable it, Tier 3 results gain three British rewrites (Executive, Colleague, Idiomatic), a note on pragmatics and a Socratic follow-up question. Only the transcript text is sent. Every call has a timeout and falls back silently, and **no feature depends on it**.

## Platform notes and known limits

- **Model size vs the PRD estimate.** No IPA phoneme recogniser of ~75 MB exists in a browser-compatible format. The smallest suitable one is the 300M-parameter wav2vec2-lv60-espeak at q4 (~242 MB), so the full engine is about 305 MB rather than about 125 MB. On older iPhones, enable **Low-memory mode** in Settings: it skips Stream B, and prosody and lexical scoring still run, with weights renormalised.
- **Single-threaded WASM.** GitHub Pages can't send COOP/COEP headers, so WASM runs single-threaded unless WebGPU is available. In testing, an 11 s clip took about 2 s for ASR and about 1.6 s for phonemes on a desktop CPU.
- **Reference audio.** "Hear RP" uses the device's en-GB speech-synthesis voice. The `audio_uri` field is supported if you add recordings.
- **Accuracy of the diff.** The acoustic model was trained on multilingual Common Voice with espeak labels, so treat single-phone verdicts as strong hints rather than ground truth. Habit rates and the confusion matrix average out the noise.

## Layout

```
src/workers/speechEngine.worker.ts   Streams A–D in a Web Worker
src/lib/{ipa,connectedSpeech,g2p,prosody,audioUtils,tips}.ts
src/services/{ipaAligner,rlBandit,fsrs,reward,redundancy,evaluate}.ts
src/services/{db,githubSync,syncManager,geminiEnhancer,audio,tts,engine}.ts
src/components/{PracticeArena,ResultView,VocabRegisterCard,PhonemeHeatmap,Dashboard,SettingsVault,Waveform}.tsx
```

MIT licensed.
