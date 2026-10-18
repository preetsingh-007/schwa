import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../store';
import type { TierMode } from '../App';
import type { Prompt } from '../types';
import { recorder, TARGET_SR } from '../services/audio';
import { engine, cosine } from '../services/engine';
import { scorePrompts, selectNextPrompt, suggestTier } from '../services/rlBandit';
import { loadLevel, warmLevels } from '../services/corpus';
import { ensureEntry, entryPrompts, loadAllCurated, loadWordBand } from '../services/lexicon';
import { advanceLadder, ladderProgress, ladderPrompt, loadLadders, needsCheck, pickLadderSound, STAGE_NAMES } from '../services/ladders';
import { planBuildUp, shouldBuildUp, STEP_TRIES } from '../services/buildup';
import { rpVoice, type Reference } from '../services/rpVoice';
import { evaluateTurn, commitTurn, type TurnResult } from '../services/evaluate';
import { scheduleSync } from '../services/syncManager';
import { enhanceMonologue, isGeminiAvailable } from '../services/geminiEnhancer';
import { speak, speakSystem, stopSpeaking } from '../services/tts';
import { playPcm } from '../services/audio';
import { TIPS } from '../lib/tips';
import { MODELS } from '../workers/protocol';
import { MicIcon, SkipIcon, SpeakerIcon, StopIcon } from './Icons';
import Waveform from './Waveform';
import ResultView from './ResultView';

type Phase = 'idle' | 'recording' | 'analyzing' | 'result';

const SKIP_WORDS = /^(skip|next|skip it|next one|next prompt|pass)\.?$/i;
/** How many recently served prompts the bandit avoids (skips leave no outcome to learn from). */
const RECENT_MAX = 25;

function spokenPrompt(p: Prompt, vocabNames: string[]): string {
  if (p.drill?.kind === 'buildup') return `${p.drill.part === 'word' ? 'Just this word.' : 'Now this part.'} ${p.text}`;
  if (p.mode === 'shadow') return p.text;
  if (p.tier === 1) return `Read aloud. ${p.text}`;
  if (p.tier === 2) return `Compress this in ten seconds${vocabNames.length ? `, using ${vocabNames.join(' and ')}` : ''}. ${p.text}`;
  return `${p.text} ${vocabNames.length ? `Try to use: ${vocabNames.join(', ')}.` : ''}`;
}

const isWordDrill = (p: Prompt) => (p.drill?.kind === 'buildup' && p.drill.part === 'word') || (p.drill?.kind === 'ladder' && (p.drill.content === 'words' || p.drill.content === 'pairs'));

function promptLabel(p: Prompt, tierMode: TierMode): ReactNode {
  if (p.drill?.kind === 'buildup') return `Build-up · step ${p.drill.step + 1} of ${p.drill.steps}`;
  // the label is upper-cased; IPA must not be (ɔ → Ɔ is a different symbol)
  if (p.drill?.kind === 'ladder') return <>Sounds · <span className="ipa">/{p.drill.phoneme}/</span> · {STAGE_NAMES[p.drill.stage]}</>;
  if (tierMode === 'sounds' && p.title.startsWith('Diagnostic')) return 'Sounds · quick check';
  if (p.mode === 'nameit') return 'Words · name it';
  if (p.mode === 'shadow' && p.cardId) return 'Words · listen & repeat';
  if (p.mode === 'shadow') return `Listen & repeat · Level ${p.level}`;
  return `Tier ${p.tier} · ${p.tier === 1 ? 'Articulatory calibration' : p.tier === 2 ? 'Lexical compression' : 'Open-ended monologue'}`;
}

function critique(r: TurnResult): string {
  const parts = [`Score ${Math.round(r.reward.reward)}.`];
  if (r.reward.passed) parts.push('Passed.');
  const crit = r.concise?.hits.find((h) => h.rule.severity === 'critical');
  if (crit) parts.push(`Cut "${crit.text}"${crit.replacement ? `, say "${crit.replacement}"` : ''}.`);
  for (const d of r.topDiagnoses.slice(0, 2)) {
    const word = r.alignment?.words.find((w) => w.pairs.some((p) => p.diagnosis === d.code))?.text;
    parts.push(`${TIPS[d.code].title}${word ? ` on "${word}"` : ''}.`);
  }
  if (!r.reward.passed) parts.push(`Try again: ${r.retryTarget}`);
  return parts.join(' ');
}

export default function PracticeArena({ tierMode, focusPhoneme, clearFocus, openSettings, focusCard, clearFocusCard }: {
  tierMode: TierMode; focusPhoneme: string | null; clearFocus: () => void; openSettings: () => void;
  focusCard: string | null; clearFocusCard: () => void;
}) {
  const app = useApp();
  const { data, learner, vocabCards, promptStats, settings, engineState, engineError, engineModels, startEngine, refresh, openVocab, vocabById, allPrompts } = app;
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [attempt, setAttempt] = useState(1);
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<TurnResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recStart, setRecStart] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [progress, setProgress] = useState('');
  const promptRef = useRef<Prompt | null>(null);
  const attemptRef = useRef(1);
  const autoStop = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handsFreeRef = useRef(false);
  // Listen-and-repeat: the neural RP rendering of the current prompt, and the prefetched next one.
  const [ref, setRef] = useState<(Reference & { text: string }) | null>(null);
  const [refState, setRefState] = useState<'idle' | 'rendering' | 'ready' | 'error'>('idle');
  const [voiceProgress, setVoiceProgress] = useState(rpVoice.progress);
  const refRef = useRef<(Reference & { text: string }) | null>(null);
  const nextShadow = useRef<Prompt | null>(null);
  const interacted = useRef(false);
  refRef.current = ref;
  // Build-up: steps offered after repeated misses, and the run in progress (refs mirror state for async loops).
  const [offer, setOffer] = useState<Prompt[] | null>(null);
  const [buildup, setBuildup] = useState<{ steps: Prompt[]; index: number; parentAttempt: number } | null>(null);
  const buildupRef = useRef(buildup);
  buildupRef.current = buildup;
  const builtUp = useRef(new Set<string>());
  const [stepFails, setStepFails] = useState(0);
  const stepFailsRef = useRef(0);
  const [notice, setNotice] = useState<string | null>(null);

  promptRef.current = prompt;
  attemptRef.current = attempt;
  /**
   * Choose the next prompt. Listen-and-repeat draws from the current corpus
   * level (with some review from the level below); Auto mixes it in with the
   * curated tiers. The bandit ranks either pool the same way.
   */
  const recentIds = useRef<string[]>([]);
  const pickNext = useCallback(async (excludeId?: string): Promise<Prompt | null> => {
    setOffer(null); setBuildup(null); buildupRef.current = null; setNotice(null);
    const suggested = suggestTier(learner);
    const roll = Math.random();
    const words = tierMode === 'words' || !!focusCard || (tierMode === 'auto' && roll < 0.2);
    // Sounds mode, a heatmap tap, or about one in five Auto turns once there's a weak sound to work on.
    const sounds = !words && (tierMode === 'sounds' || (tierMode === 'auto' && roll < 0.4));
    const shadow = !words && !sounds && (tierMode === 'shadow' || (tierMode === 'auto' && roll < (suggested === 1 ? 0.7 : 0.55)));
    const ctx = { learner, vocab: vocabCards, stats: promptStats, now: Date.now(), excludeId, recent: new Set(recentIds.current), focusPhoneme: focusPhoneme ?? undefined };
    let chosen: Prompt | null = null;
    if (sounds) {
      try {
        const ladders = await loadLadders();
        if (tierMode === 'sounds' && !focusPhoneme && needsCheck(learner)) {
          // Not enough heard yet to know the weak sounds: a few diagnostic sentences first.
          chosen = selectNextPrompt(allPrompts.filter((p) => p.title.startsWith('Diagnostic')), { ...ctx, focusPhoneme: undefined })?.prompt ?? null;
          setNotice('Quick sound check: read a few sentences so schwa can find the sounds to work on.');
        } else {
          const ph = pickLadderSound(learner, ladders, focusPhoneme);
          if (ph) {
            const lp = ladderProgress(learner, ph);
            const stage = lp.stage === 5 ? 4 : lp.stage;
            for (let i = 0; i < 4 && (!chosen || chosen.id === excludeId); i++) chosen = ladderPrompt(ph, ladders[ph], stage, Math.floor(Math.random() * 997));
          } else if (tierMode === 'sounds') {
            setNotice('No weak sounds to work on right now. Here is a sentence instead.');
          }
        }
      } catch {
        chosen = null; // ladders not downloaded yet (offline): fall back below
      }
    }
    if (words) {
      try {
        if (focusCard) {
          const e = await ensureEntry(focusCard);
          chosen = e ? entryPrompts(e)[0] ?? null : null;
          clearFocusCard();
        } else {
          // ~60 % curated British cards, ~40 % the next frequency band of everyday words;
          // FSRS reviews that are due take priority over new cards.
          const curated = Math.random() < 0.6;
          const entries = curated ? await loadAllCurated() : await loadWordBand(learner.wordBand ?? 1);
          const pool = entries.flatMap(entryPrompts);
          const now = Date.now();
          const due = new Set([...vocabCards.values()].filter((c) => c.lastReview && c.due <= now).map((c) => c.id));
          const duePool = pool.filter((p) => p.cardId && due.has(p.cardId));
          chosen = selectNextPrompt(duePool.length && Math.random() < 0.7 ? duePool : pool, ctx)?.prompt ?? null;
        }
      } catch {
        chosen = null; // lexicon not downloaded yet (offline): fall back below
      }
    }
    if (shadow || (sounds && !chosen && tierMode === 'auto')) {
      try {
        const level = learner.shadowLevel ?? 1;
        warmLevels(level);
        const queued = nextShadow.current;
        if (queued && queued.level === level && queued.id !== excludeId && !focusPhoneme) chosen = queued;
        else {
          const review = level > 1 && Math.random() < 0.2;
          const pool = await loadLevel(review ? level - 1 : level);
          chosen = selectNextPrompt(pool, ctx)?.prompt ?? null;
        }
        // Prefetch the runner-up so its RP rendering is ready when this one is passed.
        const pool = await loadLevel(level);
        const runnerUp = scorePrompts(pool, { ...ctx, excludeId: chosen?.id }).find((x) => x.prompt.id !== chosen?.id)?.prompt ?? null;
        nextShadow.current = runnerUp;
      } catch {
        chosen = null; // corpus unavailable offline before first download: fall back to curated prompts
      }
    }
    if (!chosen) chosen = selectNextPrompt(allPrompts, { ...ctx, tier: typeof tierMode === 'number' ? tierMode : tierMode === 'auto' ? suggested : 1 })?.prompt ?? null;
    if (chosen) recentIds.current = [chosen.id, ...recentIds.current.filter((x) => x !== chosen.id)].slice(0, RECENT_MAX);
    setPrompt(chosen);
    promptRef.current = chosen;
    setAttempt(1); attemptRef.current = 1;
    setResult(null); setError(null); setPhase('idle');
    return chosen;
  }, [allPrompts, tierMode, focusPhoneme, focusCard, clearFocusCard, learner, vocabCards, promptStats]);

  // New prompt when the mode / drill focus changes (not on every learner update).
  // Clearing a consumed card focus (→ null) must not trigger another pick.
  const prevFocusCard = useRef<string | null>(null);
  useEffect(() => {
    const cleared = prevFocusCard.current !== null && focusCard === null;
    prevFocusCard.current = focusCard;
    if (cleared) return;
    void pickNext();
  /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [tierMode, focusPhoneme, focusCard]);

  useEffect(() => {
    const mark = () => { interacted.current = true; };
    window.addEventListener('pointerdown', mark, { once: true });
    window.addEventListener('keydown', mark, { once: true });
    return () => { window.removeEventListener('pointerdown', mark); window.removeEventListener('keydown', mark); };
  }, []);
  useEffect(() => rpVoice.subscribe(() => setVoiceProgress({ ...rpVoice.progress })), []);

  // Render (or load from cache) the RP reference for listen-and-repeat prompts, then warm the next one.
  useEffect(() => {
    setRef(null);
    if (!prompt || prompt.mode !== 'shadow' || settings.rpVoice !== 'neural') { setRefState('idle'); return; }
    let live = true;
    setRefState('rendering');
    rpVoice.render(prompt.text, settings.kokoroVoice).then((r) => {
      if (!live) return;
      setRef({ ...r, text: prompt.text });
      setRefState('ready');
      if (interacted.current && !settings.handsFree) void playPcm(r.audio, r.sampleRate);
      if (nextShadow.current) rpVoice.prefetch(nextShadow.current.text, settings.kokoroVoice);
    }).catch(() => { if (live) setRefState('error'); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt?.id, settings.rpVoice, settings.kokoroVoice]);

  const listen = useCallback(async (slow = false) => {
    const p = promptRef.current;
    if (!p) return;
    stopSpeaking();
    if (settings.rpVoice !== 'neural') { await speakSystem(p.text, { voice: settings.ttsVoice, rate: slow ? 0.75 : 0.95 }); return; }
    try {
      if (!slow && refRef.current?.text === p.text) await playPcm(refRef.current.audio, refRef.current.sampleRate);
      else await rpVoice.play(p.text, settings.kokoroVoice, slow ? 0.8 : 1);
    } catch {
      await speakSystem(p.text, { voice: settings.ttsVoice, rate: slow ? 0.75 : 0.95 });
    }
  }, [settings.rpVoice, settings.kokoroVoice, settings.ttsVoice]);

  useEffect(() => {
    if (phase !== 'recording') return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => engine.onProgress((p) => {
    const { loaded, total } = engine.modelProgress(p.model);
    if (total > 0) setProgress(`${MODELS[p.model].label.split(' (')[0]} · ${Math.round(loaded / 1e6)} / ${Math.round(total / 1e6)} MB`);
  }), []);

  const vocabNames = (p: Prompt) => p.targetVocab.map((id) => vocabById.get(id)?.headword).filter((x): x is string => !!x);

  // ---- Build-up: problem words, then phrases from the end, then the whole sentence again ----
  const showStep = (step: Prompt) => {
    setPrompt(step); promptRef.current = step;
    setAttempt(1); attemptRef.current = 1;
    stepFailsRef.current = 0; setStepFails(0);
    setResult(null); setError(null); setPhase('idle');
  };
  const startBuildUp = (steps: Prompt[]) => {
    const parent = steps[0].drill?.kind === 'buildup' ? steps[0].drill.parent : null;
    if (parent) builtUp.current.add(parent.id);
    const run = { steps, index: 0, parentAttempt: attemptRef.current };
    buildupRef.current = run; setBuildup(run); setOffer(null); setNotice(null);
    showStep(steps[0]);
  };
  /** Next step, or back to the whole sentence after the last one. */
  const advanceBuildUp = (toSentence = false) => {
    const run = buildupRef.current;
    if (!run) return;
    const index = run.index + 1;
    if (!toSentence && index < run.steps.length) {
      const next = { ...run, index };
      buildupRef.current = next; setBuildup(next);
      showStep(run.steps[index]);
      return;
    }
    const d = run.steps[0].drill;
    buildupRef.current = null; setBuildup(null);
    if (d?.kind !== 'buildup') return;
    setPrompt(d.parent); promptRef.current = d.parent;
    setAttempt(run.parentAttempt); attemptRef.current = run.parentAttempt;
    setResult(null); setError(null); setPhase('idle');
    setNotice('Now the whole sentence again.');
  };
  /** After a pass: the next build-up step, or a new prompt. */
  const nextAfterPass = (p: Prompt | null) => (p?.drill?.kind === 'buildup' ? advanceBuildUp() : void pickNext(p?.id));
  const skip = () => {
    const run = buildupRef.current;
    const d = run?.steps[0].drill;
    void pickNext(d?.kind === 'buildup' ? d.parent.id : promptRef.current?.id);
  };

  /** Run all four streams on one utterance, score it, commit the RL update. */
  const process = useCallback(async (audio: Float32Array): Promise<TurnResult | null> => {
    const p = promptRef.current;
    if (!p) return null;
    if (audio.length < TARGET_SR * 0.35) {
      setError("Didn't catch that — hold the mic (or Space) while you speak.");
      setPhase(attemptRef.current > 1 || result ? 'result' : 'idle');
      return null;
    }
    setPhase('analyzing');
    setError(null);
    try {
      // Name-it answers are free speech ("we call them chips"): score against what was said.
      const res = await engine.analyze({ audio, sampleRate: TARGET_SR, referenceText: p.tier === 1 && p.mode !== 'nameit' ? p.reference ?? p.text : undefined });
      if (SKIP_WORDS.test(res.transcript.trim())) { void pickNext(p.id); return null; }
      let reference: TurnResult['reference'] = null;
      if (p.mode === 'shadow' && settings.rpVoice === 'neural') {
        const r = refRef.current?.text === p.text ? refRef.current : await rpVoice.cached(p.text, settings.kokoroVoice);
        if (r?.prosody) reference = { prosody: r.prosody, voice: settings.kokoroVoice };
      }
      let semantic: number | null = null;
      if (p.tier !== 1 && engine.ready.embed && res.transcript) {
        const embs = await engine.embed([res.transcript, p.tier === 2 ? p.reference ?? p.text : p.text]).catch(() => null);
        if (embs) semantic = cosine(embs[0], embs[1]);
      }
      const r = evaluateTurn({ prompt: p, attempt: attemptRef.current, transcript: res.transcript, target: res.target, produced: res.produced, prosody: res.prosody, semantic, audio, reference }, data);
      setResult(r);
      setPhase('result');
      await commitTurn(r, data);
      void refresh();
      scheduleSync();
      if (p.drill?.kind === 'ladder') {
        const before = ladderProgress(learner, p.drill.phoneme);
        const after = advanceLadder(learner.ladders?.[p.drill.phoneme], p.drill, r.reward.passed, Date.now());
        if (after.stage !== before.stage) setNotice(after.stage === 5 ? `/${p.drill.phoneme}/ ladder complete!` : `Up a step for /${p.drill.phoneme}/: ${STAGE_NAMES[after.stage as 1 | 2 | 3 | 4].toLowerCase()} next.`);
      }
      if (!r.reward.passed) { setAttempt((a) => a + 1); attemptRef.current += 1; }
      if (!r.reward.passed && p.drill?.kind === 'buildup') {
        stepFailsRef.current += 1; setStepFails(stepFailsRef.current);
        if (settings.handsFree && stepFailsRef.current >= STEP_TRIES) advanceBuildUp();
      } else if (!r.reward.passed && shouldBuildUp(p, attemptRef.current - 1) && !builtUp.current.has(p.id)) {
        const steps = planBuildUp(p, r);
        if (steps.length) {
          if (settings.handsFree) startBuildUp(steps);
          else setOffer(steps);
        }
      }
      if (p.tier === 3 && isGeminiAvailable(settings.geminiKey, settings.geminiEnabled)) {
        void enhanceMonologue(settings.geminiKey, { prompt: p.text, transcript: r.transcript, targetWords: vocabNames(p) }).then((g) => {
          setResult((cur) => (cur && cur.audio === r.audio ? { ...cur, gemini: g } : cur));
        });
      }
      return r;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('idle');
      return null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, refresh, learner, settings.geminiEnabled, settings.geminiKey, settings.rpVoice, settings.kokoroVoice, settings.handsFree, pickNext]);

  const startRecording = useCallback(async () => {
    if (!promptRef.current || engineState !== 'ready') return;
    if (phase === 'recording' || phase === 'analyzing') return;
    try {
      stopSpeaking();
      await recorder.open();
      recorder.start();
      setRecStart(Date.now()); setNow(Date.now());
      setPhase('recording');
      setError(null);
      const limit = promptRef.current.timeLimitSec;
      autoStop.current = setTimeout(() => { void stopRecording(); }, limit * 1000);
    } catch (e) {
      setError(`Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineState, phase]);

  const stopRecording = useCallback(async () => {
    if (autoStop.current) { clearTimeout(autoStop.current); autoStop.current = null; }
    if (!recorder.recording) return;
    const audio = recorder.stop();
    await process(audio);
  }, [process]);

  /** Primary control: next prompt after a pass, else record / stop. */
  const onMic = useCallback(() => {
    if (phase === 'recording') { void stopRecording(); return; }
    if (phase === 'result' && result?.reward.passed) { nextAfterPass(prompt); return; }
    void startRecording();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, result, prompt, pickNext, startRecording, stopRecording]);

  // Spacebar push-to-talk (hold), or "next" after a pass.
  useEffect(() => {
    const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isField(e.target) || settings.handsFree) return;
      e.preventDefault();
      if (phase === 'result' && result?.reward.passed) { nextAfterPass(prompt); return; }
      void startRecording();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isField(e.target) || settings.handsFree) return;
      e.preventDefault();
      if (phase === 'recording') void stopRecording();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [phase, result, prompt, settings.handsFree, startRecording, stopRecording, pickNext]);

  // ---- Hands-free Commute Mode: TTS prompt → VAD capture → critique → loop ----
  useEffect(() => {
    if (!settings.handsFree || engineState !== 'ready') { handsFreeRef.current = false; recorder.cancel(); return; }
    handsFreeRef.current = true;
    let cancelled = false;
    const listenOnce = (p: Prompt) => new Promise<Float32Array | null>((resolve) => {
      recorder.listen({
        endSilenceSec: p.tier === 3 ? 2.2 : 1.3,
        maxSec: p.timeLimitSec,
        onStart: () => { setRecStart(Date.now()); setPhase('recording'); },
        onEnd: (audio) => resolve(audio),
      });
      const poll = setInterval(() => { if (cancelled || !handsFreeRef.current) { clearInterval(poll); recorder.cancel(); resolve(null); } }, 250);
    });
    (async () => {
      try { await recorder.open(); } catch (e) { setError(`Microphone unavailable: ${String(e)}`); return; }
      let lastSpoken = '', lastId = '';
      while (!cancelled && handsFreeRef.current) {
        const p = promptRef.current ?? await pickNext();
        if (!p) break;
        const key = `${p.id}:${attemptRef.current}`;
        if (lastSpoken !== key) {
          // a new prompt (or back to the sentence after a build-up) is read in full; a retry just gets a cue
          await speak(attemptRef.current === 1 || p.id !== lastId ? spokenPrompt(p, vocabNames(p)) : 'Your turn.', { voice: settings.ttsVoice });
          lastSpoken = key; lastId = p.id;
        }
        if (cancelled) break;
        setPhase('idle');
        const audio = await listenOnce(p);
        if (!audio || cancelled) break;
        const r = await process(audio);
        if (!r || cancelled) continue;
        await speak(critique(r), { voice: settings.ttsVoice });
        if (r.reward.passed) {
          if (p.drill?.kind === 'buildup') advanceBuildUp();
          else await pickNext(p.id);
        }
      }
    })();
    return () => { cancelled = true; handsFreeRef.current = false; recorder.cancel(); stopSpeaking(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.handsFree, engineState]);

  // ---------------------------------------------------------------------------

  if (engineState !== 'ready') {
    const total = MODELS.asr.approxMB + (settings.phonemeModel === 'full' ? MODELS.phoneme.approxMB : 0) + MODELS.embed.approxMB;
    return (
      <section className="section card empty">
        <h2 style={{ marginTop: 0 }}>Offline speech engine</h2>
        <p className="muted small" style={{ maxWidth: 520, margin: '0 auto' }}>
          schwa runs Whisper (what you meant), a wav2vec2 IPA model (what your vocal tract produced) and espeak-ng (the RP target)
          entirely on this device. The first load downloads ~{total} MB once; after that it works in flight mode.
        </p>
        <div className="section">
          {engineState === 'loading' ? (
            <div><span className="spinner" /> Loading models… <div className="small muted mono">{progress}</div></div>
          ) : (
            <button className="btn" onClick={() => void startEngine()}>Load offline engine</button>
          )}
        </div>
        {engineError && <div className="notice err">{engineError}</div>}
        <p className="tiny muted section"><button className="btn ghost" onClick={openSettings}>Engine settings</button></p>
      </section>
    );
  }

  if (!prompt) return <section className="section card empty">No prompts available for this tier.</section>;

  const remaining = recStart ? Math.max(0, prompt.timeLimitSec - (now - recStart) / 1000) : prompt.timeLimitSec;
  const used = new Set(result?.usedVocab ?? []);

  return (
    <main>
      <section className="section card" aria-live="polite">
        <div className="prompt-head">
          <span className="label">{promptLabel(prompt, tierMode)}</span>
          {prompt.drill?.kind === 'ladder' && <LadderDots stage={ladderProgress(learner, prompt.drill.phoneme).stage} />}
          <span className="spacer" />
          {focusPhoneme && <button className="chip" onClick={clearFocus} title="Clear drill focus">Drill <span className="ipa">/{focusPhoneme}/</span> ✕</button>}
          {attempt > 1 && <span className="chip">Retry #{attempt - 1}</span>}
          <button className="iconbtn" onClick={skip} title="Skip (or say “skip”)" aria-label="Skip prompt"><SkipIcon /></button>
        </div>
        {notice && <div className="notice small">{notice}</div>}
        <div className="small muted">{prompt.title}</div>
        <p className={`prompt-text ${prompt.tier === 2 ? 'verbose' : prompt.tier === 3 ? 'scenario' : ''}`}>{prompt.text}</p>
        {prompt.drill?.kind === 'buildup' && (
          <div className="small muted">
            From: “{prompt.drill.parent.text}”{' '}
            <button className="linkbtn" onClick={() => advanceBuildUp(true)}>Back to the whole sentence</button>
          </div>
        )}
        {prompt.drill?.kind === 'ladder' && (() => {
          const info = data.phonemes.find((x) => x.symbol === (prompt.drill as { phoneme: string }).phoneme);
          return info ? <div className="notice small"><b><span className="ipa">/{info.symbol}/</span> as in {info.keyword.split(' / ')[0].toLowerCase()}.</b> {info.mechanics}</div> : null;
        })()}
        {prompt.mode === 'shadow' && (
          <div className="row">
            <button className="btn" onClick={() => void listen(false)} disabled={refState === 'rendering'}><SpeakerIcon /> Listen</button>
            <button className="btn ghost" onClick={() => void listen(true)} disabled={refState === 'rendering'}>Slow</button>
            <span className="small muted">
              {refState === 'rendering'
                ? rpVoice.state === 'loading' && voiceProgress.total > 0
                  ? `Downloading RP voice · ${Math.round(voiceProgress.loaded / 1e6)} / ${Math.round(voiceProgress.total / 1e6)} MB`
                  : 'Preparing RP voice…'
                : refState === 'error' ? 'Neural voice unavailable — using the system voice'
                  : isWordDrill(prompt) ? 'Listen, then repeat — each word on its own, scored on the sounds.'
                    : 'Listen, then repeat it — copy the rhythm and the melody, not just the words.'}
            </span>
          </div>
        )}
        {prompt.source && (
          <div className="tiny muted" style={{ marginTop: 6 }}>
            <a href={prompt.source.url} target="_blank" rel="noreferrer" className="muted">{prompt.source.name}</a>
            {prompt.source.by ? ` · ${prompt.source.by}` : ''} · {prompt.source.license}
          </div>
        )}
        {prompt.tier === 2 && <div className="small muted">Say the same thing concisely — you have <b>{prompt.timeLimitSec} seconds</b>.</div>}
        {prompt.tier === 3 && <div className="small muted">Speak for up to {prompt.timeLimitSec} seconds.</div>}
        {prompt.mode === 'nameit' && (() => {
          const card = prompt.cardId ? vocabById.get(prompt.cardId) : undefined;
          const answered = phase === 'result';
          return (
            <div>
              {card?.img && <figure className="cardimg cue"><img src={card.img} alt="What is this called in the UK?" referrerPolicy="no-referrer" /></figure>}
              {card?.us_equivalent && card.gloss && <div className="small muted">{card.gloss.replace(new RegExp(card.headword, 'ig'), '…')}</div>}
              <div className="small muted section">Answer aloud — the British word, ideally in a short sentence.{answered ? '' : ' Stuck? Skip, and it comes back later.'}</div>
            </div>
          );
        })()}
        {prompt.mode === 'shadow' && prompt.cardId && (() => {
          const card = vocabById.get(prompt.cardId);
          if (!card) return null;
          return (
            <button className="lexitem" style={{ width: '100%', marginTop: 8 }} onClick={() => openVocab(card.id)}>
              <div className="h">{card.headword} <span className="ipa muted" style={{ fontWeight: 400 }}>{card.ipa_rp}</span></div>
              <div className="g">{card.pos ? `${card.pos} · ` : ''}{card.gloss}</div>
            </button>
          );
        })()}
        {prompt.targetVocab.length > 0 && !(prompt.mode === 'nameit' && phase !== 'result') && !(prompt.mode === 'shadow' && prompt.cardId) && (
          <div className="pills">
            {prompt.targetVocab.map((id) => {
              const v = vocabById.get(id);
              if (!v) return null;
              return (
                <button key={id} className={`pill ${used.has(id) ? 'used' : ''}`} onClick={() => openVocab(id)} title={v.register_label}>
                  <span className={`badge ${v.register_badge}`} />{v.headword}
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="section card">
        <div className="stage">
          <button
            className={`mic ${phase === 'recording' ? 'rec' : ''} ${phase === 'analyzing' ? 'busy' : ''}`}
            onClick={onMic}
            disabled={phase === 'analyzing' || settings.handsFree}
            aria-label={phase === 'recording' ? 'Stop recording' : phase === 'result' && result?.reward.passed ? 'Next prompt' : 'Start recording'}
          >
            {phase === 'recording' ? <StopIcon /> : phase === 'result' && result?.reward.passed ? <SkipIcon /> : <MicIcon />}
          </button>
          <div style={{ width: '100%' }}>
            <Waveform active={phase === 'recording' || settings.handsFree} />
            <div className="stage-status">
              {settings.handsFree ? (
                <span>{phase === 'recording' ? '● Listening…' : phase === 'analyzing' ? 'Analysing…' : 'Hands-free: speak after the prompt is read'}</span>
              ) : phase === 'recording' ? (
                <span className={`countdown ${remaining < 3 ? 'low' : ''}`}>● {remaining.toFixed(1)} s left — tap<span className="kbd-hint"> or release <span className="kbd">Space</span></span> to finish</span>
              ) : phase === 'analyzing' ? (
                <span><span className="spinner" /> Running Streams A–D on device…</span>
              ) : phase === 'result' && result?.reward.passed ? (
                <span>Passed — tap ▶<span className="kbd-hint"> or press <span className="kbd">Space</span></span> for the next prompt</span>
              ) : phase === 'result' ? (
                <span><b>Spoken retry required</b> — tap the mic<span className="kbd-hint"> or hold <span className="kbd">Space</span></span> and say it again</span>
              ) : (
                <span>Tap the mic<span className="kbd-hint"> or hold <span className="kbd">Space</span></span> to speak · {engine.device.toUpperCase()}{!engineModels.phoneme ? ' · Stream B off' : ''}</span>
              )}
            </div>
          </div>
        </div>
        {error && <div className="notice err">{error}</div>}
        {offer && phase === 'result' && !result?.reward.passed && (
          <div className="notice">
            <b>This one is tough. Let's break it down</b>: {describeSteps(offer)}, then the whole sentence again.
            <div className="row section">
              <button className="btn" onClick={() => startBuildUp(offer)}>Break it down</button>
              <button className="btn ghost" onClick={() => { builtUp.current.add(prompt.id); setOffer(null); }}>Keep trying</button>
            </div>
          </div>
        )}
        {buildup && phase === 'result' && !result?.reward.passed && stepFails >= STEP_TRIES && (
          <div className="row section">
            <span className="small muted">No problem, it'll come back round.</span>
            <button className="btn ghost" onClick={() => advanceBuildUp()}>Move on</button>
          </div>
        )}
      </section>

      {result && <ResultView r={result} />}
    </main>
  );
}

function describeSteps(steps: Prompt[]): string {
  const words = steps.filter((s) => s.drill?.kind === 'buildup' && s.drill.part === 'word').length;
  const phrases = steps.length - words;
  return [words && `${words} word${words > 1 ? 's' : ''}`, phrases && `${phrases} phrase${phrases > 1 ? 's' : ''}`].filter(Boolean).join(', ');
}

/** Four dots for a sound's ladder: filled up to the current stage, all green when complete. */
function LadderDots({ stage }: { stage: number }) {
  return (
    <span className="ladder-dots" title={stage === 5 ? 'Ladder complete' : `Step ${stage} of 4`}>
      {[1, 2, 3, 4].map((i) => <i key={i} className={stage === 5 ? 'done' : i < stage ? 'on' : i === stage ? 'now' : ''} />)}
    </span>
  );
}
