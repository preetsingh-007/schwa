import type { TargetWord } from '../lib/connectedSpeech';
import type { ProducedPhone } from '../services/ipaAligner';
import type { ProsodyMetrics } from '../lib/prosody';

export const MODELS = {
  asr: { id: 'onnx-community/whisper-tiny.en', label: 'Whisper-tiny.en (Stream A · lexical intent)', approxMB: 41 },
  phoneme: { id: 'onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX', label: 'wav2vec2-lv60-espeak IPA (Stream B · acoustic phonemes)', approxMB: 242 },
  embed: { id: 'Xenova/all-MiniLM-L6-v2', label: 'all-MiniLM-L6-v2 (semantic check)', approxMB: 23 },
} as const;
export type ModelKey = keyof typeof MODELS;

export interface InitOptions {
  device: 'auto' | 'webgpu' | 'wasm';
  phonemeModel: 'full' | 'off';
  embeddings: boolean;
  /** Vite BASE_URL, used to locate /ort/*.wasm */
  base: string;
}

export interface AnalyzeRequest {
  audio: Float32Array;
  sampleRate: number;
  /** Tier 1: the text the user was asked to read; ground truth comes from it. */
  referenceText?: string;
}

export interface AnalyzeResponse {
  transcript: string;
  produced: ProducedPhone[] | null;
  target: TargetWord[];
  prosody: ProsodyMetrics;
  timings: Record<string, number>;
}

export type WorkerRequest =
  | { id: number; type: 'init'; payload: InitOptions }
  | { id: number; type: 'analyze'; payload: AnalyzeRequest }
  | { id: number; type: 'g2p'; payload: { text: string } }
  | { id: number; type: 'embed'; payload: { texts: string[] } }
  | { id: number; type: 'cacheStatus'; payload: Record<string, never> }
  | { id: number; type: 'clearCache'; payload: Record<string, never> };

export type WorkerEvent =
  | { type: 'result'; id: number; ok: true; result: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'progress'; model: ModelKey; file: string; loaded: number; total: number; status: string }
  | { type: 'ready'; models: Record<ModelKey, boolean>; device: string };

export interface CacheStatus {
  models: Record<ModelKey, { cached: boolean; bytes: number; files: number }>;
  persisted: boolean | null;
  quota: { usage: number; quota: number } | null;
}
