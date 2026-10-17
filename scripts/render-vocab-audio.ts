/**
 * Pre-renders RP audio for every vocabulary headword and example sentence with
 * Kokoro's en-GB voice, so vocabulary cards play instantly — and on devices
 * running in low-memory mode without the neural voice.
 *
 *   npx vite-node scripts/render-vocab-audio.ts [--voice bf_emma] [--force]
 *   npm run annotate      # links the files into vocab_curriculum.json
 *
 * Needs ffmpeg on PATH (WAV → 32 kbps mono MP3, ~4 KB per second).
 */
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { KokoroTTS } from 'kokoro-js';
import { kokoroPhonemes } from '../src/lib/g2p';
import type { VocabEntry } from '../src/types';

const ROOT = process.cwd();
const OUT = join(ROOT, 'public', 'audio', 'rp');
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const voice = arg('--voice') ?? 'bf_emma';
const force = process.argv.includes('--force');

async function main() {
  mkdirSync(OUT, { recursive: true });
  const vocab = JSON.parse(readFileSync(join(ROOT, 'public/data/vocab_curriculum.json'), 'utf8')) as VocabEntry[];
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
  const jobs: { file: string; text: string; speed: number }[] = [];
  for (const v of vocab) {
    jobs.push({ file: `${v.id}.mp3`, text: v.headword, speed: 0.9 });
    v.examples_rp.forEach((ex, k) => jobs.push({ file: `${v.id}-ex${k + 1}.mp3`, text: ex.text, speed: 1 }));
  }
  let n = 0;
  for (const j of jobs) {
    const mp3 = join(OUT, j.file);
    if (existsSync(mp3) && !force) continue;
    const a = await tts.generate_from_ids(tts.tokenizer(await kokoroPhonemes(j.text), { truncation: true }).input_ids, { voice: voice as 'bf_emma', speed: j.speed });
    const wav = `${mp3}.wav`;
    await a.save(wav);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', wav, '-ac', '1', '-ar', '24000', '-b:a', '32k', mp3]);
    rmSync(wav);
    console.log(`[${++n}/${jobs.length}] ${j.file}  ${j.text}`);
  }
  console.log(`done — ${jobs.length} clips in public/audio/rp (run npm run annotate to link them)`);
}

void main();
