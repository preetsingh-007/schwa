/**
 * Kokoro render server for the demo pipeline: the "learner" attempts that are
 * spoken into the virtual microphone, and the narrator's voice-over.
 *
 *   npx vite-node scripts/demo/voice-server.ts      # listens on :5199
 *
 * POST /render {text, voice, speed?, rp?} → 24 kHz mono WAV.
 * rp=true drives a British voice with our own RP phonemes (as the calibration
 * scripts do); accent="us" drives any voice with General American phonemes
 * (same timbre, rhotic accent); accent="l2" applies habits LexiPhon coaches
 * (/θ ð/ → [t d], /w/ → [v], GOAT → [oː], FACE → [eː], BATH/START → [a],
 * unreduced schwa, /ɪ/ → [i]) to the RP phonemes;
 * otherwise Kokoro's own front end is used.
 */
import { createServer } from 'node:http';
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';
import { phonemize } from 'phonemizer';
import { kokoroPhonemes } from '../../src/lib/g2p';

if (process.env.HF_CACHE_DIR) env.cacheDir = process.env.HF_CACHE_DIR;
const PORT = Number(process.env.VOICE_PORT ?? 5199);

function wav(x: Float32Array, sr: number): Buffer {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  return b;
}

const l2 = (p: string) => p.replace(/θ/g, 't').replace(/ð/g, 'd').replace(/w/g, 'v').replace(/əʊ/g, 'oː').replace(/eɪ/g, 'eː').replace(/ɑː/g, 'a')
  .replace(/ə/g, 'a').replace(/ɪ(?!ə)/g, 'i');

const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
let queue = Promise.resolve();

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    queue = queue.then(async () => {
      try {
        const { text, voice, speed = 1, rp = false, accent } = JSON.parse(body) as { text: string; voice: string; speed?: number; rp?: boolean; accent?: 'us' | 'l2' };
        const phonemes = accent === 'us' ? (await phonemize(text, 'en-us')).join(' ')
          : accent === 'l2' ? l2(await kokoroPhonemes(text))
            : rp ? await kokoroPhonemes(text) : null;
        const a = phonemes !== null
          ? await tts.generate_from_ids(tts.tokenizer(phonemes, { truncation: true }).input_ids, { voice: voice as 'bf_emma', speed })
          : await tts.generate(text, { voice: voice as 'bf_emma', speed });
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(wav(a.audio as Float32Array, a.sampling_rate));
      } catch (e) {
        res.writeHead(500); res.end(String(e));
      }
    });
  });
}).listen(PORT, '127.0.0.1', () => console.log(`voice server on :${PORT}`));
