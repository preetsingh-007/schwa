/**
 * Annotates the curated JSON with data computed by the same Stream C G2P that
 * runs in the browser (espeak-ng en-GB-x-rp + connected-speech rules):
 *  - prompts[].phonemes           RP phonemes each prompt exercises (bandit features)
 *  - vocab[].phonemes             RP phonemes in each headword
 *  - vocab[].examples_rp[].ipa_connected   connected-speech IPA of each example
 * and reports headwords whose hand-written ipa_rp disagrees with espeak.
 *
 * Run: npm run annotate
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { targetFromText } from '../src/lib/g2p';
import { tokenizeDictionaryIpa, isRpPhoneme } from '../src/lib/ipa';
import { existsSync } from 'node:fs';
import { encodePhonemes } from '../src/services/corpus';
import type { CorpusIndex, CorpusRow, Prompt, VocabEntry } from '../src/types';

const dir = join(process.cwd(), 'public', 'data');
const read = <T>(f: string): T => JSON.parse(readFileSync(join(dir, f), 'utf8')) as T;
const write = (f: string, v: unknown) => writeFileSync(join(dir, f), JSON.stringify(v, null, 1) + '\n');

const uniq = (xs: string[]) => Array.from(new Set(xs.filter(isRpPhoneme)));

async function phonemesOf(text: string): Promise<string[]> {
  const t = await targetFromText(text);
  return uniq(t.flatMap((w) => w.phones.map((p) => p.p)));
}

const strip = (s: string) => s.replace(/[\/ˈˌ.\s]/g, '');

async function main() {
  const vocab = read<VocabEntry[]>('vocab_curriculum.json');
  const byId = new Map(vocab.map((v) => [v.id, v]));
  const mismatches: string[] = [];
  for (const v of vocab) {
    v.phonemes = await phonemesOf(v.headword);
    for (const ex of v.examples_rp) {
      const t = await targetFromText(ex.text);
      ex.ipa_connected = `/${t.map((w) => w.ipa).join(' ')}/`;
    }
    const mine = tokenizeDictionaryIpa(strip(v.ipa_rp)).map((p) => p.p).join('');
    const esp = (await targetFromText(v.headword)).flatMap((w) => w.phones.map((p) => p.p)).join('');
    if (mine !== esp) mismatches.push(`${v.headword.padEnd(22)} hand ${mine.padEnd(18)} espeak ${esp}`);
  }
  write('vocab_curriculum.json', vocab);

  const prompts = read<Prompt[]>('prompts_tiered.json');
  for (const p of prompts) {
    const own = await phonemesOf(p.tier === 3 ? p.text : p.reference ?? p.text);
    const vocabPh = p.targetVocab.flatMap((id) => byId.get(id)?.phonemes ?? []);
    // Tier 2/3 phoneme load = what the user is expected to say (reference + target vocabulary).
    p.phonemes = uniq(p.tier === 1 ? own : [...vocabPh, ...(p.tier === 2 ? own : [])]);
  }
  write('prompts_tiered.json', prompts);

  // Listen-and-repeat corpus: phoneme set per row (compact char encoding).
  const cdir = join(process.cwd(), 'public', 'corpus');
  if (existsSync(join(cdir, 'index.json')) && !process.argv.includes('--skip-corpus')) {
    const index = JSON.parse(readFileSync(join(cdir, 'index.json'), 'utf8')) as CorpusIndex;
    for (const lvl of index.levels) {
      const f = join(cdir, lvl.file);
      const rows = JSON.parse(readFileSync(f, 'utf8')) as CorpusRow[];
      let changed = false;
      for (const r of rows) {
        if (r.ph) continue;
        r.ph = encodePhonemes(await phonemesOf(r.text));
        changed = true;
      }
      if (changed) writeFileSync(f, JSON.stringify(rows));
      console.log(`corpus level ${lvl.level}: ${rows.length} rows`);
    }
  }

  // Pre-rendered RP audio for vocabulary cards (scripts/render-vocab-audio.ts), if present.
  const adir = join(process.cwd(), 'public', 'audio', 'rp');
  for (const v of vocab) {
    if (existsSync(join(adir, `${v.id}.mp3`))) v.audio_uri = `audio/rp/${v.id}.mp3`;
    v.examples_rp.forEach((ex, k) => {
      const f = `${v.id}-ex${k + 1}.mp3`;
      if (existsSync(join(adir, f))) (ex as { audio_uri?: string }).audio_uri = `audio/rp/${f}`;
    });
  }
  write('vocab_curriculum.json', vocab);
  console.log(`annotated ${vocab.length} vocab entries and ${prompts.length} prompts`);
  if (mismatches.length) console.log(`\nhand-written IPA vs espeak (review; differences in weak syllables are expected):\n${mismatches.join('\n')}`);
}

void main();
