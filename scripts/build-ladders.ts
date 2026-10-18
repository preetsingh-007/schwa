/**
 * Builds public/data/ladders.json: a practice ladder for every RP phoneme.
 *
 *   1. example words   common words with the sound (stressed, for vowels)
 *   2. minimal pairs   word pairs that differ only in this sound and the one it
 *                      is most often confused with (thin/tin, vest/west), found
 *                      by swapping that phoneme in the lexicon's RP transcriptions
 *   3. short phrases   corpus items of 2–5 words that contain the sound
 *   4. sentences       corpus items of 6–12 words with the sound at least twice
 *
 * Phrase and sentence counts come from the same espeak RP pipeline the scorer
 * uses (targetFromText). Run after build-lexicon and the corpus build:
 *
 *   npx vite-node scripts/build-ladders.ts
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { targetFromText } from '../src/lib/g2p';
import { RP_PHONEMES, isVowel, tokenizeDictionaryIpa } from '../src/lib/ipa';
import type { CorpusIndex, CorpusRow, PhonemeInfo } from '../src/types';

const ROOT = process.cwd();
const read = <T>(p: string): T => JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as T;

/** The sound each phoneme is most often confused with; minimal pairs contrast the two. */
const CONTRAST: Record<string, string> = {
  iː: 'ɪ', ɪ: 'iː', e: 'æ', æ: 'e', ʌ: 'ɑː', ɑː: 'æ', ɒ: 'ɔː', ɔː: 'ɒ', ʊ: 'uː', uː: 'ʊ', ɜː: 'ɑː',
  eɪ: 'e', aɪ: 'ɔɪ', ɔɪ: 'aɪ', əʊ: 'ɔː', aʊ: 'ɑː', ɪə: 'eə', eə: 'ɪə', ʊə: 'ɔː',
  p: 'b', b: 'p', t: 'd', d: 't', k: 'ɡ', ɡ: 'k', f: 'v', v: 'w', θ: 't', ð: 'd', s: 'ʃ', z: 's',
  ʃ: 's', ʒ: 'dʒ', tʃ: 'ʃ', dʒ: 'j', m: 'n', n: 'ŋ', ŋ: 'n', l: 'r', r: 'l', w: 'v', j: 'dʒ',
};
const N_WORDS = 12, N_PAIRS = 9, N_PHRASES = 8, N_SENTENCES = 8;

interface WordRow { w: string; r: number; p: string; i: string; x?: string }
interface Item { id: string; text: string; source: { name: string; by?: string; license: string; url: string } }

async function main() {
  const phonemes = read<PhonemeInfo[]>('public/data/rp_phonemes_44.json');
  const lexicon: WordRow[] = readdirSync(join(ROOT, 'public/lexicon')).filter((f) => /^words-\d+\.json$/.test(f)).sort()
    .flatMap((f) => read<WordRow[]>(`public/lexicon/${f}`));
  // Headwords whose example sentence doesn't contain them were folded from another form
  // ("liv" from "lives", "pas" from "passed"); their transcription isn't trustworthy.
  const inExample = (x: WordRow) => !!x.x && new RegExp(`\\b${x.w}\\b`, 'i').test(x.x);
  const words = lexicon
    .filter((x) => /^[a-z]{2,9}$/.test(x.w) && x.p !== 'function word' && x.i && x.r <= 12000 && inExample(x))
    .map((x) => ({ ...x, phones: tokenizeDictionaryIpa(x.i) }));
  const byKey = new Map<string, (typeof words)[number]>();
  for (const x of words) {
    const k = x.phones.map((p) => p.p).join('.');
    if (!byKey.has(k) || byKey.get(k)!.r > x.r) byKey.set(k, x);
  }
  const syllables = (x: (typeof words)[number]) => x.phones.filter((p) => isVowel(p.p)).length;

  // ---- corpus candidates (levels 1–4), analysed once
  const index = read<CorpusIndex>('public/corpus/index.json');
  const rows: { row: CorpusRow; n: number; phones: string[] }[] = [];
  for (const lvl of index.levels.filter((l) => l.level <= 4)) {
    for (const row of read<CorpusRow[]>(`public/corpus/${lvl.file}`)) {
      const n = row.text.split(/\s+/).length;
      if (n < 2 || n > 12 || /[\d"“”]/.test(row.text)) continue;
      const target = await targetFromText(row.text);
      rows.push({ row, n, phones: target.flatMap((w) => w.phones.map((p) => p.p)) });
    }
  }
  console.log(`corpus candidates: ${rows.length}`);
  const item = (row: CorpusRow): Item => ({
    id: row.id, text: row.text,
    source: row.src === 'tatoeba'
      ? { name: `Tatoeba #${row.id.slice(2)}`, by: row.by, license: 'CC BY 2.0 FR', url: `https://tatoeba.org/en/sentences/show/${row.id.slice(2)}` }
      : { name: row.by, license: 'Public domain', url: index.sources.find((s) => s.id === row.src)?.url ?? 'https://www.gutenberg.org/' },
  });

  const out: Record<string, unknown> = {};
  for (const ph of RP_PHONEMES) {
    const info = phonemes.find((x) => x.symbol === ph);
    // 1. example words: the phoneme card's own examples first, then common words with the sound
    const has = (x: (typeof words)[number]) => x.phones.some((p) => p.p === ph && (!isVowel(ph) || ph === 'ə' || p.stress > 0));
    // CURE words (sure, poor, tour, your) are /ɔː/ for some RP speakers and /ʊə/ for others: no use as /ɔː/ examples
    const cure = (x: (typeof words)[number]) => ph === 'ɔː' && /(ure|oor|our)/.test(x.w);
    const ex = [...new Set([...(info?.examples ?? []).filter((w) => /^[a-z]+$/.test(w)),
      ...words.filter((x) => has(x) && !cure(x) && syllables(x) <= 2).sort((a, b) => a.r - b.r).map((x) => x.w)])].filter((w) => !cure({ w } as (typeof words)[number])).slice(0, N_WORDS);

    // 2. minimal pairs with the contrast phoneme
    const q = CONTRAST[ph];
    const pairs: [string, string, number][] = [];
    if (q) {
      for (const x of words) {
        x.phones.forEach((p, k) => {
          if (p.p !== ph) return;
          const swapped = x.phones.map((y, j) => (j === k ? q : y.p)).join('.');
          const y = byKey.get(swapped);
          if (y && y.w !== x.w) pairs.push([x.w, y.w, Math.max(x.r, y.r)]);
        });
      }
    }
    // prefer pairs of common words; fall back to the wider list for sounds with few pairs
    const common = pairs.filter((x) => x[2] <= 6000);
    const pool = common.length >= 3 ? common : pairs;
    const seen = new Set<string>();
    const bestPairs = pool.sort((a, b) => a[2] - b[2])
      .filter(([a, b]) => { const k = [a, b].sort().join('|'); if (seen.has(k) || seen.has(a) || seen.has(b)) return false; seen.add(k); seen.add(a); seen.add(b); return true; })
      .slice(0, N_PAIRS).map(([a, b]) => [a, b] as [string, string]);

    // 3–4. phrases and sentences from the corpus, most occurrences first
    const scored = rows.map((r) => ({ ...r, count: r.phones.filter((p) => p === ph).length })).filter((r) => r.count > 0);
    const phrases = scored.filter((r) => r.n <= 5).sort((a, b) => b.count - a.count || a.n - b.n).slice(0, N_PHRASES).map((r) => item(r.row));
    // sentences with the sound at least twice; rare sounds fall back to once
    const long = scored.filter((r) => r.n >= 6).sort((a, b) => b.count / b.n - a.count / a.n);
    const twice = long.filter((r) => r.count >= 2);
    const sentences = (twice.length >= 4 ? twice : long).slice(0, N_SENTENCES).map((r) => item(r.row));

    out[ph] = { ...(bestPairs.length ? { contrast: q } : {}), words: ex, pairs: bestPairs, phrases, sentences };
    console.log(`/${ph}/ words ${ex.length} · pairs ${bestPairs.length}${q ? ` vs /${q}/` : ''} (${bestPairs.slice(0, 2).map((p) => p.join('/')).join(', ')}) · phrases ${phrases.length} · sentences ${sentences.length}`);
  }
  writeFileSync(join(ROOT, 'public/data/ladders.json'), JSON.stringify({ version: 1, phonemes: out }));
}

void main();
