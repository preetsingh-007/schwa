import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../store';
import type { TierMode } from '../App';
import type { Prompt, Tier } from '../types';
import { recorder, TARGET_SR } from '../services/audio';
import { engine, cosine } from '../services/engine';
import { selectNextPrompt, suggestTier } from '../services/rlBandit';
import { evaluateTurn, commitTurn, type TurnResult } from '../services/evaluate';
import { scheduleSync } from '../services/syncManager';
import { enhanceMonologue, isGeminiAvailable } from '../services/geminiEnhancer';
import { speak, stopSpeaking } from '../services/tts';
import { TIPS } from '../lib/tips';
import { MODELS } from '../workers/protocol';
import { MicIcon, SkipIcon, StopIcon } from './Icons';
import Waveform from './Waveform';
import ResultView from './ResultView';

type Phase = 'idle' | 'recording' | 'analyzing' | 'result';

const SKIP_WORDS = /^(skip|next|skip it|next one|next prompt|pass)\.?$/i;

function spokenPrompt(p: Prompt, vocabNames: string[]): string {
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

  promptRef.current = prompt;
  attemptRef.current = attempt;
  const effectiveTier: Tier = tierMode === 'auto' ? suggestTier(learner) : tierMode;

  const pickNext = useCallback((excludeId?: string) => {
    const best = selectNextPrompt(data.prompts, {
      learner, vocab: vocabCards, stats: promptStats, now: Date.now(), tier: effectiveTier, excludeId, focusPhoneme: focusPhoneme ?? undefined,
    });
    setPrompt(best?.prompt ?? null);
    promptRef.current = best?.prompt ?? null;
    setAttempt(1); attemptRef.current = 1;
    setResult(null); setError(null); setPhase('idle');
    return best?.prompt ?? null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.prompts, effectiveTier, focusPhoneme, learner, vocabCards, promptStats]);

  // New prompt when tier / drill focus changes (not on every learner update).
  useEffect(() => { pickNext(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [effectiveTier, focusPhoneme]);

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
      if (SKIP_WORDS.test(res.transcript.trim())) { pickNext(p.id); return null; }
      let semantic: number | null = null;
      if (p.tier !== 1 && engine.ready.embed && res.transcript) {
        const embs = await engine.embed([res.transcript, p.tier === 2 ? p.reference ?? p.text : p.text]).catch(() => null);
        if (embs) semantic = cosine(embs[0], embs[1]);
      }
      const r = evaluateTurn({ prompt: p, attempt: attemptRef.current, transcript: res.transcript, target: res.target, produced: res.produced, prosody: res.prosody, semantic, audio }, data);
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
  }, [data, refresh, settings.geminiEnabled, settings.geminiKey, pickNext]);

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
    if (phase === 'result' && result?.reward.passed) { pickNext(prompt?.id); return; }
    void startRecording();
  }, [phase, result, prompt, pickNext, startRecording, stopRecording]);

  // Spacebar push-to-talk (hold), or "next" after a pass.
  useEffect(() => {
    const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isField(e.target) || settings.handsFree) return;
      e.preventDefault();
      if (phase === 'result' && result?.reward.passed) { pickNext(prompt?.id); return; }
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
        const p = promptRef.current ?? pickNext();
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
        if (r.reward.passed) pickNext(p.id);
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
          <span className="label">Tier {prompt.tier} · {prompt.tier === 1 ? 'Articulatory calibration' : prompt.tier === 2 ? 'Lexical compression' : 'Open-ended monologue'}</span>
          <span className="spacer" />
          {focusPhoneme && <button className="chip" onClick={clearFocus} title="Clear drill focus">Drill <span className="ipa">/{focusPhoneme}/</span> ✕</button>}
          {attempt > 1 && <span className="chip">Retry #{attempt - 1}</span>}
          <button className="iconbtn" onClick={() => pickNext(prompt.id)} title="Skip (or say “skip”)" aria-label="Skip prompt"><SkipIcon /></button>
        </div>
        <div className="small muted">{prompt.title}</div>
        <p className={`prompt-text ${prompt.tier === 2 ? 'verbose' : prompt.tier === 3 ? 'scenario' : ''}`}>{prompt.text}</p>
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
