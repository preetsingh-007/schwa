/**
 * Raw microphone capture (no browser DSP — fricatives and aspiration bursts
 * must survive) via an AudioWorklet, with an energy-based Voice Activity
 * Detector for hands-free Commute Mode.
 */
import { resample, trimSilence } from '../lib/audioUtils';

export const TARGET_SR = 16000;

export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    sampleRate: 16000,
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
};

const WORKLET_SRC = `
class LexiCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('lexi-capture', LexiCapture);
`;

export interface VadOptions {
  /** silence that ends an utterance */
  endSilenceSec: number;
  /** hard cap on utterance length */
  maxSec: number;
  onStart?: () => void;
  onEnd?: (audio: Float32Array) => void;
}

type Mode = 'idle' | 'ptt' | 'vad-wait' | 'vad-speech';

export class Recorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  analyser: AnalyserNode | null = null;
  private chunks: Float32Array[] = [];
  private preroll: Float32Array[] = [];
  private mode: Mode = 'idle';
  private vad: VadOptions | null = null;
  private noiseFloor = 0.003;
  private aboveMs = 0;
  private belowMs = 0;
  private speechMs = 0;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  level = 0;

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }
  get isOpen(): boolean {
    return !!this.ctx && this.ctx.state !== 'closed';
  }
  get recording(): boolean {
    return this.mode === 'ptt' || this.mode === 'vad-speech';
  }

  async open(): Promise<void> {
    if (this.isOpen) { await this.ctx!.resume(); return; }
    this.stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC();
    await this.ctx.resume();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.source.connect(this.analyser);
    const onFrame = (f: Float32Array) => this.onFrame(f);
    if (this.ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(this.ctx, 'lexi-capture');
      node.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data);
      this.node = node;
    } else {
      const sp = this.ctx.createScriptProcessor(1024, 1, 1);
      sp.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
      this.node = sp;
    }
    this.source.connect(this.node);
    // Keep the graph pulling without making noise.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute).connect(this.ctx.destination);
  }

  private onFrame(f: Float32Array) {
    let s = 0;
    for (let i = 0; i < f.length; i++) s += f[i] * f[i];
    const r = Math.sqrt(s / f.length);
    this.level = r;
    const ms = (f.length / this.sampleRate) * 1000;
    if (this.mode === 'ptt') { this.chunks.push(f); return; }
    if (this.mode === 'vad-wait') {
      this.preroll.push(f);
      const keep = Math.ceil((0.4 * this.sampleRate) / f.length);
      while (this.preroll.length > keep) this.preroll.shift();
      const onset = Math.max(this.noiseFloor * 3.5, 0.012);
      if (r > onset) this.aboveMs += ms; else { this.aboveMs = 0; this.noiseFloor = 0.95 * this.noiseFloor + 0.05 * r; }
      if (this.aboveMs >= 120) {
        this.mode = 'vad-speech';
        this.chunks = [...this.preroll];
        this.preroll = [];
        this.belowMs = 0;
        this.speechMs = 0;
        this.vad?.onStart?.();
        this.maxTimer = setTimeout(() => this.finishVad(), (this.vad?.maxSec ?? 60) * 1000);
      }
      return;
    }
    if (this.mode === 'vad-speech') {
      this.chunks.push(f);
      this.speechMs += ms;
      const offset = Math.max(this.noiseFloor * 2.2, 0.008);
      if (r < offset) this.belowMs += ms; else this.belowMs = 0;
      if (this.belowMs >= (this.vad?.endSilenceSec ?? 1.5) * 1000 && this.speechMs > 500) this.finishVad();
    }
  }

  private finishVad() {
    if (this.mode !== 'vad-speech') return;
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = null;
    const audio = this.collect();
    this.mode = 'idle';
    this.vad?.onEnd?.(audio);
  }

  private collect(): Float32Array {
    const len = this.chunks.reduce((s, c) => s + c.length, 0);
    const all = new Float32Array(len);
    let o = 0;
    for (const c of this.chunks) { all.set(c, o); o += c.length; }
    this.chunks = [];
    return trimSilence(resample(all, this.sampleRate, TARGET_SR), TARGET_SR);
  }

  /** Push-to-talk */
  start(): void {
    if (!this.isOpen) throw new Error('microphone not open');
    this.chunks = [];
    this.mode = 'ptt';
  }
  stop(): Float32Array {
    if (this.mode !== 'ptt') return new Float32Array(0);
    this.mode = 'idle';
    return this.collect();
  }

  /** Hands-free: wait for speech, capture until trailing silence. */
  listen(opts: VadOptions): void {
    if (!this.isOpen) throw new Error('microphone not open');
    this.vad = opts;
    this.chunks = [];
    this.preroll = [];
    this.aboveMs = 0;
    this.mode = 'vad-wait';
  }
  cancel(): void {
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = null;
    this.mode = 'idle';
    this.chunks = [];
  }

  close(): void {
    this.cancel();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null; this.stream = null; this.node = null; this.source = null; this.analyser = null;
  }
}

export const recorder = new Recorder();

let playCtx: AudioContext | null = null;
let current: AudioBufferSourceNode | null = null;

/** Stop whatever playPcm() is playing. */
export function stopPcm(): void {
  try { current?.stop(); } catch { /* already stopped */ }
  current = null;
}

/** Play a PCM buffer (or a slice of it). One shared context: iOS limits how many can exist. */
export async function playPcm(x: Float32Array, sr = TARGET_SR, startSec = 0, endSec?: number): Promise<void> {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  playCtx = playCtx && playCtx.state !== 'closed' ? playCtx : new AC();
  const ctx = playCtx;
  await ctx.resume();
  stopPcm();
  const a = Math.max(0, Math.floor(startSec * sr));
  const b = Math.min(x.length, endSec !== undefined ? Math.ceil(endSec * sr) : x.length);
  if (b <= a) return;
  const buf = ctx.createBuffer(1, b - a, sr);
  buf.copyToChannel(x.slice(a, b), 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  current = src;
  await new Promise<void>((resolve) => { src.onended = () => resolve(); src.start(); });
  if (current === src) current = null;
}
