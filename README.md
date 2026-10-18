# schwa

**Modern RP & lexical compression coach.** An offline-first, installable PWA where every learning interaction is spoken. It transcribes what you *meant* (Whisper), what your vocal tract *actually produced* (a wav2vec2 IPA model), and what a Modern RP speaker *would* say (espeak-ng + connected-speech rules). It then aligns them phoneme by phoneme and coaches you to say it again: shorter, crisper and more British.

All inference runs on-device in a Web Worker (ONNX Runtime Web via Transformers.js; WebGPU when available, WASM otherwise). Hosting is static on GitHub Pages and costs nothing. Progress lives in IndexedDB and can optionally sync to **your own private GitHub repo**. A Gemini key is supported but entirely optional.

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # unit tests (aligner, calibration, DSP, formants, FSRS, bandit, rules, sync, corpus)
npm run build        # static PWA in dist/
```

Open the app, tap **Load offline engine** (a one-time download, about 305 MB, cached for offline use), then tap the mic or hold **Space**. The neural RP voice (about 92 MB) downloads the first time you need it.

### Demo video

`scripts/demo/` records a trailer, setup guide and tutorial from the real app: real models and real scores, with a synthesised learner voice. See [`scripts/demo/README.md`](scripts/demo/README.md).

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

## Listen & repeat (the endless course)

Tap the mode chip until it reads **Repeat** (Auto mode also mixes it in). The neural RP voice reads a sentence aloud, you repeat it, and you are scored on pronunciation (60%) and on how closely your **melody, pitch range, tempo and rhythm match that same sentence's RP rendering** (40%). The prosody scoring compares against a real reference here, not a generic intonation shape.

- **Corpus:** 28,461 items in 12 difficulty levels (`public/corpus/`, about 4.5 MB in total, downloaded one level at a time). It combines 24,000 everyday sentences from [Tatoeba](https://tatoeba.org) (CC BY 2.0 FR, each with a link to its source and author) and about 4,400 passages from public-domain British books: Austen, Dickens, Conan Doyle, Jerome K. Jerome, Wells, Woolf, Grahame, Carroll, Chesterton, the Brontës. Sentences containing lexical Americanisms are dropped, and US spellings are converted.
- **Levels:** difficulty combines sentence length with word rarity. You move up a level after 12 or more turns at a pass rate of at least 70% (mean reward ≥ 75), and drop back a level after 8 turns averaging under 50. The bandit still picks *which* sentence comes next, from your weakest phonemes.
- **Neural RP voice:** [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) en-GB voices (Emma, George, Fable, Isabella), q8, about 92 MB once, run in their own worker so they can be unloaded on low-memory devices. Renders are cached in IndexedDB (last 400), and the next sentence is rendered in the background while you work on the current one. The same voice drives "Hear RP", vocabulary cards and Commute Mode. If it is unavailable, the app falls back to the system voice.
- **Rebuilding the corpus:** `python3 scripts/data-src/corpus.py <eng_sentences_detailed.tsv> <dir of Gutenberg .txt files>`, then `npm run annotate`.

## Lexicon & Words mode

The book icon opens a searchable lexicon. The **Words** mode (mode chip → *Words*) drills it by voice:

- **3,043 curated British cards** in 11 categories:
  - UK-vs-US vocabulary for food, home and transport;
  - education, work, money and the NHS;
  - culture, customs, sport and the pub;
  - idioms, slang, phrasal verbs and everyday phrases;
  - politeness and understatement ("what Britons really mean");
  - tricky pronunciations and place names;
  - precise professional vocabulary.

  Each has a register badge, gloss, usage, pragmatics, a false-friend warning where relevant, 1–2 example sentences and RP IPA. Cards with a picture or a different American word become **"name it"** drills: you see the picture or the US term and *say* the British word. Every card also has a listen-and-repeat drill on its example sentence.
- **20,000 automatic word cards**: the most frequent English lemmas from `wordfreq`, folded to dictionary headwords, with the most common WordNet sense, a real Tatoeba example sentence where one exists, RP IPA, and pronunciation tips generated from the phonemes (BATH, non-rhoticity, GOAT, yod, weak forms…). They are drilled band by band (top 1,000, then the next 1,000…), moving on once 80% of a band is passed.
- **Reviews:** FSRS schedules every card you practise. Due reviews take priority over new cards.
- **Pictures:** Wikipedia lead-image thumbnails for concrete things (every title is validated at build time, and broken or disambiguation pages are dropped), fetched only when shown and cached for offline use. Every card also links to Google Images, Wikipedia and the Cambridge Dictionary.
- **Place names:** for famously irregular words (Southwark, Leominster, Mainwaring…) the authored RP IPA overrides espeak's spelling-based guess everywhere: the card, the scorer's target and the RP voice (`src/lib/g2pOverrides.ts`, generated).

Build: `python3 scripts/data-src/words.py …` (see the header) → `npx vite-node scripts/build-lexicon.ts words_raw.json`. Curated cards live in `scripts/data-src/lexicon/*.json` (format and quality rules in `BRIEF.md`). They were written with AI assistance, then schema-validated, deduplicated and spot-checked. They have **not** been reviewed line by line by a human linguist.

## More Tier 2 & Tier 3 prompts

On top of the original 640 prompts, `public/prompts/` adds **1,970 Tier 2 compression items** and **2,008 Tier 3 monologue scenarios**, each written individually (no templates). They cover tech, the public sector, business services, everyday British life, careers and academia, workplace persuasion, explaining and presenting, social life, opinions and stories. `scripts/build-prompts.ts` validates every item:

- the model answer is at most about 45% of the verbose length;
- it triggers no critical redundancy rule;
- it actually contains its target vocabulary;
- targets resolve to real cards;
- no slang targets appear in work scenarios;
- duplicates are removed.

The packs load in the background, and the bandit picks from all of them.

## Calibration against British reference speech

The phoneme model (Stream B) was fine-tuned on transcripts labelled by espeak **en-US**, so part of what it outputs reflects the dictionary rather than the sound. Run on Kokoro's British voices, the uncalibrated scorer "heard" an /r/ in *car park*, an American GOAT vowel in *go*, and unreduced *of*/*but*. In other words, it penalised genuine RP.

`scripts/calibrate-acoustic.ts` measures this bias. It renders 520 utterances (Tier 1/2 texts, vocabulary examples and corpus sentences) with four British voices **driven by our own RP phonemes**, decodes them through the exact Stream B pipeline, aligns them against the RP target, and records every deviation that RP speech triggers. Deviations that occur in at least 20% of cases are model-equivalent: they are shown dotted in the tape and never counted as errors (`public/data/acoustic_calibration.json`).

What the calibration found:

- **Judged normally:** BATH /ɑː/ vs [æ] (the model hears this one correctly), the GOAT monophthong [oː], retroflexion, /v/–/w/, /θ ð/, vowel length, and weak forms of *to, the, a, an, for, them, than, could, should*.
- **Model-equivalent (the model can't tell them apart, so they're not judged):** GOAT [əʊ] vs [oʊ], parts of LOT, SQUARE and NEAR, the model's r-coloured units, and weak forms of *of, and, at, was, from, but, have, are*. For these words the model outputs the strong vowel even when the speaker reduces it, and even invents the /d/ of "and".
- **Why the voice is phoneme-driven:** Kokoro's own en-GB front end gives BATH words a short northern vowel ("ask" as [æsk]) and doesn't reduce function words. The first calibration run, on that input, would have hidden BATH errors entirely.

Calibration removes the bias, but it would also make rhoticity invisible, because the model writes [ɑːɹ] for British "car" too. So rhoticity is judged **acoustically**: an LPC formant tracker measures the third formant (F3) at the end of each spelled-r vowel, relative to your own baseline. A pronounced /r/ pulls F3 down sharply. `scripts/calibrate-rhotic.ts` sets the thresholds by contrasting British and American renderings of 130 sentences (281 measurements). The check is deliberately conservative. **"/r/ heard"** (crimson) fires on about 6% of non-rhotic vowels and catches about 25% of pronounced /r/. **"possible /r/"** (amber) catches about 52% at about 10% false alarms.

`scripts/validate-scoring.ts` is the regression check. Over 6 sentences, British voices average R = 88.5 (10/12 pass), and American voices saying the same sentences average R = 79.7, with BATH and /r/ errors flagged. 7/12 American attempts still pass, which is the honest limit of this phoneme model: the American features it can't hear (GOAT, LOT) are exactly the ones calibration had to mark as model-equivalent.

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

1. Create a **private** repo, for example `schwa-data`.
2. Create a **fine-grained PAT** with access to *only that repo* and the **Contents: Read and write** permission.
3. In Settings, enter the owner, repo and token, then tap **Verify & push now**. schwa refuses to push to a public repo.

The state is written to `state/schwa_state.json` through the Contents API with SHA optimistic locking. On a conflict the app re-pulls, merges and retries. Merging is deterministic:

- vocabulary: the latest review wins and histories are unioned
- confusion-matrix rows: EWMA blend with λ = 1 − (1 − α)^k, where k is the number of local observations since the last sync
- sessions: union by id

Offline changes stay queued as a dirty flag and are pushed when connectivity returns or the app is backgrounded. Export and Import JSON work without GitHub. The token is stored only in this browser's IndexedDB.

## Optional Gemini enhancer

If you paste a Google AI Studio key and enable it, Tier 3 results gain three British rewrites (Executive, Colleague, Idiomatic), a note on pragmatics and a Socratic follow-up question. Only the transcript text is sent. Every call has a timeout and falls back silently, and **no feature depends on it**.

## Platform notes and known limits

- **Model size vs the PRD estimate.** No IPA phoneme recogniser of ~75 MB exists in a browser-compatible format. The smallest suitable one is the 300M-parameter wav2vec2-lv60-espeak at q4 (~242 MB), so the full engine is about 305 MB rather than about 125 MB. On older iPhones, enable **Low-memory mode** in Settings: it skips Stream B, and prosody and lexical scoring still run, with weights renormalised.
- **Single-threaded WASM.** GitHub Pages can't send COOP/COEP headers, so WASM runs single-threaded unless WebGPU is available. In testing, an 11 s clip took about 2 s for ASR and about 1.6 s for phonemes on a desktop CPU.
- **Reference audio.** The neural voice is synthetic and southern-British rather than a guaranteed textbook RP. Vocabulary cards ship with pre-rendered MP3s (`scripts/render-vocab-audio.ts`), so they work even without the voice model.
- **What calibration can't fix.** Where British reference speech itself makes the model emit an American-looking label, the model can't tell RP from the American variant. Those contrasts (for example some GOAT and LOT realisations) are marked as model-equivalent, not judged. Rhoticity is checked acoustically instead.
- **Accuracy of the diff.** The acoustic model was trained on multilingual Common Voice with espeak labels, so treat single-phone verdicts as strong hints rather than ground truth. Habit rates and the confusion matrix average out the noise.

## Layout

```
src/workers/speechEngine.worker.ts   Streams A–D in a Web Worker
src/workers/tts.worker.ts            Kokoro neural RP voice (separate, unloadable)
src/lib/{ipa,connectedSpeech,g2p,prosody,formants,rhotic,ctc,audioUtils,tips}.ts
src/services/{ipaAligner,rlBandit,fsrs,reward,redundancy,evaluate,corpus}.ts
src/services/{db,githubSync,syncManager,geminiEnhancer,audio,tts,rpVoice,engine}.ts
src/components/{PracticeArena,ResultView,VocabRegisterCard,PhonemeHeatmap,Dashboard,SettingsVault,Waveform}.tsx
```

MIT licensed.
