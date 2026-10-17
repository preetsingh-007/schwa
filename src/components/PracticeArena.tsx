import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../store';
import type { TierMode } from '../App';
import type { Prompt } from '../types';
import { recorder, TARGET_SR } from '../services/audio';
import { engine, cosine } from '../services/engine';
import { scorePrompts, selectNextPrompt, suggestTier } from '../services/rlBandit';
import { loadLevel, warmLevels } from '../services/corpus';
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

function spokenPrompt(p: Prompt, vocabNames: string[]): string {
  if (p.mode === 'shadow') return p.text;
  if (p.tier === 1) return `Read aloud. ${p.text}`;
  if (p.tier === 2) return `Compress this in ten seconds${vocabNames.length ? `, using ${vocabNames.join(' and ')}` : ''}. ${p.text}`;
  return `${p.text} ${vocabNames.length ? `Try to use: ${vocabNames.join(', ')}.` : ''}`;
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

export default function PracticeArena({ tierMode, focusPhoneme, clearFocus, openSettings }: {
  tierMode: TierMode; focusPhoneme: string | null; clearFocus: () => void; openSettings: () => void;
}) {
  const app = useApp();
  const { data, learner, vocabCards, promptStats, settings, engineState, engineError, engineModels, startEngine, refresh, openVocab, vocabById } = app;
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

  promptRef.current = prompt;
  attemptRef.current = attempt;
  /**
   * Choose the next prompt. Listen-and-repeat draws from the current corpus
   * level (with some review from the level below); Auto mixes it in with the
   * curated tiers. The bandit ranks either pool the same way.
   */
  const pickNext = useCallback(async (excludeId?: string): Promise<Prompt | null> => {
    const suggested = suggestTier(learner);
    const shadow = tierMode === 'shadow' || (tierMode === 'auto' && Math.random() < (suggested === 1 ? 0.5 : 0.25));
    const ctx = { learner, vocab: vocabCards, stats: promptStats, now: Date.now(), excludeId, focusPhoneme: focusPhoneme ?? undefined };
    let chosen: Prompt | null = null;
    if (shadow) {
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
    if (!chosen) chosen = selectNextPrompt(data.prompts, { ...ctx, tier: tierMode === 'auto' ? suggested : tierMode === 'shadow' ? 1 : tierMode })?.prompt ?? null;
    setPrompt(chosen);
    promptRef.current = chosen;
    setAttempt(1); attemptRef.current = 1;
    setResult(null); setError(null); setPhase('idle');
    return chosen;
  }, [data.prompts, tierMode, focusPhoneme, learner, vocabCards, promptStats]);

  // New prompt when the mode / drill focus changes (not on every learner update).
  useEffect(() => { void pickNext(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tierMode, focusPhoneme]);

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
      const res = await engine.analyze({ audio, sampleRate: TARGET_SR, referenceText: p.tier === 1 ? p.reference ?? p.text : undefined });
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
      if (!r.reward.passed) { setAttempt((a) => a + 1); attemptRef.current += 1; }
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
  }, [data, refresh, settings.geminiEnabled, settings.geminiKey, settings.rpVoice, settings.kokoroVoice, pickNext]);

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
    if (phase === 'result' && result?.reward.passed) { void pickNext(prompt?.id); return; }
    void startRecording();
  }, [phase, result, prompt, pickNext, startRecording, stopRecording]);

  // Spacebar push-to-talk (hold), or "next" after a pass.
  useEffect(() => {
    const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isField(e.target) || settings.handsFree) return;
      e.preventDefault();
      if (phase === 'result' && result?.reward.passed) { void pickNext(prompt?.id); return; }
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
      let lastSpoken = '';
      while (!cancelled && handsFreeRef.current) {
        const p = promptRef.current ?? await pickNext();
        if (!p) break;
        const key = `${p.id}:${attemptRef.current}`;
        if (lastSpoken !== key) {
          await speak(attemptRef.current === 1 ? spokenPrompt(p, vocabNames(p)) : 'Your turn.', { voice: settings.ttsVoice });
          lastSpoken = key;
        }
        if (cancelled) break;
        setPhase('idle');
        const audio = await listenOnce(p);
        if (!audio || cancelled) break;
        const r = await process(audio);
        if (!r || cancelled) continue;
        await speak(critique(r), { voice: settings.ttsVoice });
        if (r.reward.passed) await pickNext(p.id);
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
          LexiPhon runs Whisper (what you meant), a wav2vec2 IPA model (what your vocal tract produced) and espeak-ng (the RP target)
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
          <span className="label">{prompt.mode === 'shadow' ? `Listen & repeat · Level ${prompt.level}` : `Tier ${prompt.tier} · ${prompt.tier === 1 ? 'Articulatory calibration' : prompt.tier === 2 ? 'Lexical compression' : 'Open-ended monologue'}`}</span>
          <span className="spacer" />
          {focusPhoneme && <button className="chip" onClick={clearFocus} title="Clear drill focus">Drill <span className="ipa">/{focusPhoneme}/</span> ✕</button>}
          {attempt > 1 && <span className="chip">Retry #{attempt - 1}</span>}
          <button className="iconbtn" onClick={() => void pickNext(prompt.id)} title="Skip (or say “skip”)" aria-label="Skip prompt"><SkipIcon /></button>
        </div>
        <div className="small muted">{prompt.title}</div>
        <p className={`prompt-text ${prompt.tier === 2 ? 'verbose' : prompt.tier === 3 ? 'scenario' : ''}`}>{prompt.text}</p>
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
        {prompt.targetVocab.length > 0 && (
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
                <span className={`countdown ${remaining < 3 ? 'low' : ''}`}>● {remaining.toFixed(1)} s left — tap or release <span className="kbd">Space</span> to finish</span>
              ) : phase === 'analyzing' ? (
                <span><span className="spinner" /> Running Streams A–D on device…</span>
              ) : phase === 'result' && result?.reward.passed ? (
                <span>Passed — tap ▶ or press <span className="kbd">Space</span> for the next prompt</span>
              ) : phase === 'result' ? (
                <span><b>Spoken retry required</b> — tap the mic or hold <span className="kbd">Space</span> and say it again</span>
              ) : (
                <span>Tap the mic or hold <span className="kbd">Space</span> to speak · {engine.device.toUpperCase()}{!engineModels.phoneme ? ' · Stream B off' : ''}</span>
              )}
            </div>
          </div>
        </div>
        {error && <div className="notice err">{error}</div>}
      </section>

      {result && <ResultView r={result} />}
    </main>
  );
}
