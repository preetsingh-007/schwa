/** Main-thread RPC client for the speech-engine Web Worker. */
import type { AnalyzeRequest, AnalyzeResponse, CacheStatus, InitOptions, ModelKey, WorkerEvent, WorkerRequest } from '../workers/protocol';
import type { TargetWord } from '../lib/connectedSpeech';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
export interface ProgressInfo { model: ModelKey; file: string; loaded: number; total: number; status: string }

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

class EngineClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private progressListeners = new Set<(p: ProgressInfo) => void>();
  private fileProgress = new Map<string, ProgressInfo>();
  ready: Record<ModelKey, boolean> = { asr: false, phoneme: false, embed: false };
  device = 'wasm';
  private readyListeners = new Set<() => void>();

  private ensure(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('../workers/speechEngine.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<WorkerEvent>) => this.onEvent(e.data);
      this.worker.onerror = (e) => {
        const err = new Error(`Speech engine crashed: ${e.message || 'worker error'} (on iOS this usually means memory pressure — try Low-memory mode in Settings)`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.worker = null;
        this.ready = { asr: false, phoneme: false, embed: false };
        this.readyListeners.forEach((l) => l());
      };
    }
    return this.worker;
  }

  private onEvent(ev: WorkerEvent) {
    if (ev.type === 'progress') {
      const info: ProgressInfo = { model: ev.model, file: ev.file, loaded: ev.loaded, total: ev.total, status: ev.status };
      if (ev.file) this.fileProgress.set(`${ev.model}:${ev.file}`, info);
      this.progressListeners.forEach((l) => l(info));
      return;
    }
    if (ev.type === 'ready') {
      this.ready = ev.models;
      this.device = ev.device;
      this.readyListeners.forEach((l) => l());
      return;
    }
    const p = this.pending.get(ev.id);
    if (!p) return;
    this.pending.delete(ev.id);
    if (ev.ok) p.resolve(ev.result); else p.reject(new Error(ev.error));
  }

  private call<T>(msg: DistributiveOmit<WorkerRequest, 'id'>, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ensure().postMessage({ ...msg, id } as WorkerRequest, transfer);
    });
  }

  /** Aggregate download progress (bytes) for one model. */
  modelProgress(model: ModelKey): { loaded: number; total: number } {
    let loaded = 0, total = 0;
    for (const [k, v] of this.fileProgress) {
      if (!k.startsWith(`${model}:`)) continue;
      loaded += v.status === 'done' ? v.total || v.loaded : v.loaded;
      total += v.total;
    }
    return { loaded, total };
  }

  onProgress(l: (p: ProgressInfo) => void): () => void {
    this.progressListeners.add(l);
    return () => this.progressListeners.delete(l);
  }
  onReady(l: () => void): () => void {
    this.readyListeners.add(l);
    return () => this.readyListeners.delete(l);
  }

  init(opts: Omit<InitOptions, 'base'>): Promise<{ device: string }> {
    return this.call({ type: 'init', payload: { ...opts, base: import.meta.env.BASE_URL } });
  }
  analyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
    const copy = req.audio.slice();
    return this.call({ type: 'analyze', payload: { ...req, audio: copy } }, [copy.buffer]);
  }
  g2p(text: string): Promise<TargetWord[]> {
    return this.call({ type: 'g2p', payload: { text } });
  }
  embed(texts: string[]): Promise<number[][] | null> {
    return this.call({ type: 'embed', payload: { texts } });
  }
  cacheStatus(): Promise<CacheStatus> {
    return this.call({ type: 'cacheStatus', payload: {} });
  }
  clearCache(): Promise<boolean> {
    return this.call({ type: 'clearCache', payload: {} });
  }
}

export const engine = new EngineClient();

export function cosine(a: number[], b: number[]): number {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? s / Math.sqrt(na * nb) : 0;
}
