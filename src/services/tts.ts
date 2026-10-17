/**
 * Native RP reference audio via the platform's Web Speech synthesiser, using
 * an en-GB voice (e.g. "Daniel" / "Serena" on Apple devices, "Google UK
 * English" in Chrome). Used for reference playback and Commute Mode read-outs.
 */

import { rpVoice } from './rpVoice';
import { stopPcm } from './audio';

let voicesCache: SpeechSynthesisVoice[] = [];

/** Which reference voice speak() uses; set from Settings. */
const voiceConfig = { mode: 'system' as 'neural' | 'system', kokoroVoice: 'bf_emma' };
export function configureVoice(c: { mode: 'neural' | 'system'; kokoroVoice: string }): void {
  voiceConfig.mode = c.mode;
  voiceConfig.kokoroVoice = c.kokoroVoice;
}
export function neuralVoiceEnabled(): boolean {
  return voiceConfig.mode === 'neural';
}
export function currentKokoroVoice(): string {
  return voiceConfig.kokoroVoice;
}

export function ttsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function britishVoices(): SpeechSynthesisVoice[] {
  if (!ttsSupported()) return [];
  voicesCache = speechSynthesis.getVoices();
  return voicesCache.filter((v) => /en[-_]GB/i.test(v.lang));
}

export function onVoicesChanged(cb: () => void): () => void {
  if (!ttsSupported()) return () => undefined;
  speechSynthesis.addEventListener('voiceschanged', cb);
  return () => speechSynthesis.removeEventListener('voiceschanged', cb);
}

const PREFERRED = [/Daniel/i, /Serena/i, /Kate/i, /Oliver/i, /Google UK English Male/i, /Google UK English Female/i, /Arthur/i, /Martha/i];

export function pickVoice(name?: string): SpeechSynthesisVoice | undefined {
  const gb = britishVoices();
  if (name) {
    const v = gb.find((x) => x.name === name);
    if (v) return v;
  }
  for (const re of PREFERRED) {
    const v = gb.find((x) => re.test(x.name));
    if (v) return v;
  }
  return gb[0];
}

/**
 * Speak with the neural RP voice when enabled (rendering on device, cached),
 * otherwise — or if the neural voice fails — with the platform synthesiser.
 */
export async function speak(text: string, opts: { voice?: string; rate?: number } = {}): Promise<void> {
  if (!text.trim()) return;
  if (voiceConfig.mode === 'neural') {
    try {
      await rpVoice.play(text, voiceConfig.kokoroVoice, opts.rate && opts.rate < 0.9 ? 0.8 : 1);
      return;
    } catch {
      /* fall back to the system voice */
    }
  }
  return speakSystem(text, opts);
}

export function speakSystem(text: string, opts: { voice?: string; rate?: number } = {}): Promise<void> {
  if (!ttsSupported() || !text.trim()) return Promise.resolve();
  return new Promise((resolve) => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-GB';
    const v = pickVoice(opts.voice);
    if (v) u.voice = v;
    u.rate = opts.rate ?? 0.95;
    const done = () => resolve();
    u.onend = done;
    u.onerror = done;
    // iOS sometimes never fires onend; guard with a generous timeout.
    setTimeout(done, Math.max(4000, text.length * 150 + 3000));
    speechSynthesis.speak(u);
  });
}

export function stopSpeaking(): void {
  if (ttsSupported()) speechSynthesis.cancel();
  stopPcm();
}
