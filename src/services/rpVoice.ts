/**
 * Neural RP reference voice (Kokoro en-GB) — main-thread client with an
 * IndexedDB render cache, background prefetch and memory release.
 */
import type { ProsodyMetrics } from '../lib/prosody';
import type { SynthResult, TtsEvent, TtsRequest } from '../workers/tts.worker';
import { db } from './db';
import { playPcm } from './audio';

export const KOKORO_APPROX_MB = 92;
export const BRITISH_VOICES = [
  { id: 'bf_emma', label: 'Emma (female) · best quality' },
  { id: 'bm_george', label: 'George (male)' },
  { id: 'bm_fable', label: 'Fable (male)' },
  { id: 'bf_isabella', label: 'Isabella (female)' },
] as const;

export type VoiceState = 'off' | 'loading' | 'ready' | 'error';
export interface Reference { audio: Float32Array; sampleRate: number; prosody: ProsodyMetrics }

const MAX_CACHE = 400;

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

function keyOf(text: string, voice: string, speed: number): string {
  // FNV-1a over the normalised request; collisions are harmless (worst case a re-render).
  let h = 0x811c9dc5;
  const s = `${voice}|${speed}|${text.trim().replace(/\s+/g, ' ')}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${voice}:${speed}:${(h >>> 0).toString(36)}:${s.length}`;
}

function toPcm16(x: Float32Array): ArrayBuffer {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.max(-1, Math.min(1, x[i])) * 0x7fff;
  return out.buffer;
}
function fromPcm16(b: ArrayBuffer): Float32Array {
  const i16 = new Int16Array(b);
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 0x7fff;
  return out;
}

class RpVoice {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private inflight = new Map<string, Promise<Reference>>();
  private listeners = new Set<() => void>();
  state: VoiceState = 'off';
  error: string | null = null;
  progress = { loaded: 0, total: 0 };
  private files = new Map<string, { loaded: number; total: number }>();

  private emit() { this.listeners.forEach((l) => l()); }
  subscribe(l: () => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }

  private ensure(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('../workers/tts.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<TtsEvent>) => {
        const ev = e.data;
        if (ev.type === 'progress') {
          if (ev.file) this.files.set(ev.file, { loaded: ev.status === 'done' ? ev.total || ev.loaded : ev.loaded, total: ev.total });
          let loaded = 0, total = 0;
          for (const f of this.files.values()) { loaded += f.loaded; total += f.total; }
          this.progress = { loaded, total };
          this.emit();
          return;
        }
        const p = this.pending.get(ev.id);
        if (!p) return;
        this.pending.delete(ev.id);
        if (ev.ok) p.resolve(ev.result); else p.reject(new Error(ev.error));
      };
      this.worker.onerror = (e) => {
        const err = new Error(`RP voice crashed: ${e.message || 'worker error'}`);
        this.pending.forEach((p) => p.reject(err));
        this.pending.clear();
        this.worker = null;
        this.state = 'error';
        this.error = err.message;
        this.emit();
      };
    }
    return this.worker;
  }

  private call<T>(msg: DistributiveOmit<TtsRequest, 'id'>): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ensure().postMessage({ ...msg, id });
    });
  }

  async load(): Promise<void> {
    if (this.state === 'ready') return;
    this.state = 'loading';
    this.error = null;
    this.emit();
    try {
      await this.call({ type: 'init', base: import.meta.env.BASE_URL });
      this.state = 'ready';
    } catch (e) {
      this.state = 'error';
      this.error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      this.emit();
    }
  }

  /** Free the model's memory (iOS); renders already cached keep working. */
  unload(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
    this.inflight.clear();
    this.state = 'off';
    this.emit();
  }

  async cached(text: string, voice: string, speed = 1): Promise<Reference | null> {
    try {
      const hit = await db.audioCache.get(keyOf(text, voice, speed));
      if (!hit) return null;
      void db.audioCache.update(hit.key, { ts: Date.now() });
      return { audio: fromPcm16(hit.pcm), sampleRate: hit.sampleRate, prosody: hit.prosody as ProsodyMetrics };
    } catch {
      return null;
    }
  }

  /** Render (or fetch from cache) the RP reference for `text`. */
  render(text: string, voice: string, speed = 1): Promise<Reference> {
    const key = keyOf(text, voice, speed);
    const running = this.inflight.get(key);
    if (running) return running;
    const job = (async () => {
      const hit = await this.cached(text, voice, speed);
      if (hit) return hit;
      if (this.state !== 'ready') await this.load();
      const r = await this.call<SynthResult>({ type: 'synth', text, voice, speed });
      try {
        await db.audioCache.put({ key, ts: Date.now(), sampleRate: r.sampleRate, pcm: toPcm16(r.audio), prosody: r.prosody });
        const n = await db.audioCache.count();
        if (n > MAX_CACHE) {
          const old = await db.audioCache.orderBy('ts').limit(n - MAX_CACHE).primaryKeys();
          await db.audioCache.bulkDelete(old);
        }
      } catch { /* cache is best-effort */ }
      return r;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  /** Warm the cache for an upcoming prompt without blocking anything. */
  prefetch(text: string, voice: string): void {
    void this.render(text, voice).catch(() => undefined);
  }

  async play(text: string, voice: string, speed = 1): Promise<Reference> {
    const r = await this.render(text, voice, speed);
    await playPcm(r.audio, r.sampleRate);
    return r;
  }
}

export const rpVoice = new RpVoice();
