/**
 * Builds public/lexicon/ from
 *   scripts/data-src/lexicon/<category>.json   curated cards (see BRIEF.md)
 *   <words_raw.json>                           automatic 20k-word layer (scripts/data-src/words.py)
 * adding RP IPA and phoneme sets (same espeak G2P as the app), rule-based
 * pronunciation tips, validated Wikipedia thumbnails, and a search index.
 *
 *   npx vite-node scripts/build-lexicon.ts <words_raw.json> [--no-wiki]
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tokenizeDictionaryIpa, isRpPhoneme } from '../src/lib/ipa';
import { phoneticTraps, stressedIpa } from '../src/lib/phoneticTrap';
import { encodePhonemes } from '../src/services/corpus';
import type { VocabEntry, RegisterBadge } from '../src/types';

const ROOT = process.cwd();
const SRC = join(ROOT, 'scripts/data-src/lexicon');
const OUT = join(ROOT, 'public/lexicon');
const WIKI_CACHE = join(ROOT, 'node_modules/.cache/lexiphon-wiki.json');
const noWiki = process.argv.includes('--no-wiki');

export const CATEGORIES: Record<string, string> = {
  uk_us_food: 'Food & drink (UK vs US)',
  uk_us_home: 'Home, clothes & family (UK vs US)',
  uk_us_transport: 'Transport, roads & town (UK vs US)',
  uk_institutions: 'Education, work, money & the NHS',
  uk_culture: 'Culture, customs, sport & the pub',
  idioms: 'British idioms',
  slang: 'Colloquial & slang',
  phrasal_everyday: 'Phrasal verbs & everyday phrases',
  pragmatics: 'Politeness, understatement & what Britons really mean',
  pronunciation_traps: 'Tricky pronunciations & place names',
  business: 'Precise professional vocabulary',
};

interface Authored {
  headword: string; register: 'GREEN' | 'AMBER' | 'RED'; us_equivalent?: string | null; gloss: string; usage: string;
  pragmatic_note?: string | null; pitfall?: string | null; examples: string[]; collocations?: string[]; wiki?: string | null; forms?: string[];
}

const BADGE: Record<string, RegisterBadge> = { GREEN: 'GREEN_EXECUTIVE_SAFE', AMBER: 'AMBER_COLLEAGUE', RED: 'RED_COLLOQUIAL' };
const LABEL: Record<RegisterBadge, string> = {
  GREEN_EXECUTIVE_SAFE: 'Boardroom, Academic & Formal Written Safe',
  AMBER_COLLEAGUE: 'Colleague & Idiomatic Workplace — fine for standups and Teams, avoid in contracts and papers',
  RED_COLLOQUIAL: 'Colloquial / Social Only — understand it, but keep it out of the workplace',
};

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function wikiThumb(title: string, cache: Record<string, string | null>): Promise<string | null> {
  if (title in cache) return cache[title];
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, {
      headers: { 'User-Agent': 'LexiPhon-build/0.2 (https://github.com/preetsingh-007/schwa)' },
    }).catch(() => null);
    if (res && res.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
    if (!res || !res.ok) { cache[title] = null; return null; }
    const j = (await res.json()) as { type?: string; thumbnail?: { source: string } };
    cache[title] = j.type === 'disambiguation' ? null : j.thumbnail?.source ?? null;
    return cache[title];
  }
  return null;
}

/**
 * Place names and other famously irregular words: espeak spells them out
 * ("Southwark" as /saʊθwɔːk/). The pronunciation-traps cards carry an authored
 * RP IPA; when it parses cleanly into RP phonemes it becomes a G2P override
 * (src/lib/g2pOverrides.ts), used by the scorer's target and the RP voice alike.
 */
async function writeOverrides(): Promise<number> {
  const { phonemize } = await import('phonemizer');
  const f = join(SRC, 'pronunciation_traps.json');
  if (!existsSync(f)) return 0;
  const cards = JSON.parse(readFileSync(f, 'utf8')) as Authored[];
  const out: Record<string, string> = {};
  for (const c of cards) {
    const head = c.headword.trim();
    if (/\s/.test(head)) continue;
    const m = (c.pitfall ?? '').match(/\/([^/]{2,40})\//) ?? (c.usage ?? '').match(/\/([^/]{2,40})\//);
    if (!m) continue;
    const ipa = m[1].replace(/[.\s]/g, '');
    const phones = tokenizeDictionaryIpa(ipa);
    if (!phones.length || !phones.every((p) => isRpPhoneme(p.p)) || !/[ˈ]/.test(ipa) && phones.filter((p) => /[aeiouəɪʊʌɒɑɔɜ]/.test(p.p)).length > 1) continue;
    // Only override where espeak actually disagrees (it is right about "ask", wrong about "Southwark").
    const esp = tokenizeDictionaryIpa((await phonemize(head, 'en-gb-x-rp')).join('')).map((p) => p.p).join(' ');
    if (esp === phones.map((p) => p.p).join(' ')) continue;
    // Monosyllables are often written without a stress mark; stress the vowel so prosody stays natural.
    const stressed = /[ˈ]/.test(ipa) ? ipa : ipa.replace(/(^|[^ˈˌ])([iɪeæʌɑɒɔʊuɜəa][ːɪʊə]?)/, '$1ˈ$2');
    out[head.toLowerCase()] = stressed;
  }
  const body = Object.entries(out).sort().map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n');
  writeFileSync(join(ROOT, 'src/lib/g2pOverrides.ts'),
    `// Generated by scripts/build-lexicon.ts from the pronunciation-traps lexicon. Do not edit by hand.\nexport const G2P_OVERRIDES: Record<string, string> = {\n${body}\n};\n`);
  return Object.keys(out).length;
}

let citationIpa: typeof import('../src/lib/g2p').citationIpa;
let targetFromText: typeof import('../src/lib/g2p').targetFromText;

async function ipaFor(text: string): Promise<{ ipa: string; phonemes: string[]; traps: string[] }> {
  const t = await targetFromText(text);
  const phones = t.flatMap((w) => w.phones);
  return {
    ipa: `/${t.map((w) => w.ipa).join(' ')}/`,
    phonemes: Array.from(new Set(phones.map((p) => p.p).filter(isRpPhoneme))),
    traps: t.length === 1 ? phoneticTraps(text, phones) : phoneticTraps(text.split(/\s+/).sort((a, b) => b.length - a.length)[0], t.sort((a, b) => b.phones.length - a.phones.length)[0].phones),
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`G2P overrides: ${await writeOverrides()}`);
  // Import G2P only after the overrides file is written, so this run uses it.
  ({ citationIpa, targetFromText } = await import('../src/lib/g2p'));
  const wikiCache: Record<string, string | null> = existsSync(WIKI_CACHE) ? JSON.parse(readFileSync(WIKI_CACHE, 'utf8')) : {};
  const core = JSON.parse(readFileSync(join(ROOT, 'public/data/vocab_curriculum.json'), 'utf8')) as VocabEntry[];
  const taken = new Set(core.flatMap((v) => [v.headword.toLowerCase(), ...(v.forms ?? []).map((f) => f.toLowerCase())]));
  const search: [string, string, string][] = [];
  for (const v of core) search.push([v.headword, v.id, 'core']);

  const categories: { id: string; name: string; file: string; count: number }[] = [];
  const problems: string[] = [];
  for (const f of readdirSync(SRC).filter((x) => x.endsWith('.json')).sort()) {
    const cat = f.replace(/\.json$/, '');
    let raw: Authored[];
    try { raw = JSON.parse(readFileSync(join(SRC, f), 'utf8')) as Authored[]; } catch (e) { problems.push(`${f}: invalid JSON (${String(e)})`); continue; }
    const cards: VocabEntry[] = [];
    for (const a of raw) {
      const head = a.headword?.trim();
      if (!head || !a.gloss || !Array.isArray(a.examples) || !a.examples.length || !BADGE[a.register]) { problems.push(`${cat}: incomplete card ${JSON.stringify(a.headword)}`); continue; }
      const key = head.toLowerCase();
      if (taken.has(key)) { problems.push(`${cat}: duplicate "${head}"`); continue; }
      taken.add(key);
      const examples = a.examples.filter((x) => typeof x === 'string' && x.trim()).slice(0, 2);
      const p = await ipaFor(head);
      const exIpa = await Promise.all(examples.map(async (x) => ({ text: x.trim(), ipa_connected: `/${(await targetFromText(x)).map((w) => w.ipa).join(' ')}/` })));
      let img: string | null = null;
      if (a.wiki && !noWiki) { img = await wikiThumb(a.wiki, wikiCache); await sleep(60); }
      cards.push({
        id: `lx_${cat}_${slug(head)}`,
        headword: head,
        ipa_rp: p.ipa,
        syllable_stress: '',
        audio_uri: null,
        phonetic_trap: p.traps.join(' '),
        register_badge: BADGE[a.register],
        register_label: LABEL[BADGE[a.register]],
        usage_context: a.usage ?? '',
        pragmatic_note: a.pragmatic_note ?? '',
        replaces_verbose: [],
        collocations: (a.collocations ?? []).slice(0, 3),
        examples_rp: exIpa,
        forms: a.forms?.length ? a.forms : undefined,
        phonemes: p.phonemes,
        category: cat,
        gloss: a.gloss,
        us_equivalent: a.us_equivalent ?? null,
        pitfall: a.pitfall ?? null,
        wiki: img ? a.wiki ?? null : null,
        img,
        source: 'lexicon',
      });
      search.push([head, `lx_${cat}_${slug(head)}`, cat]);
    }
    const file = `cards-${cat}.json`;
    writeFileSync(join(OUT, file), JSON.stringify(cards));
    categories.push({ id: cat, name: CATEGORIES[cat] ?? cat, file, count: cards.length });
    writeFileSync(WIKI_CACHE, JSON.stringify(wikiCache));
    console.log(`${cat}: ${cards.length} cards (${cards.filter((c) => c.img).length} with images)`);
  }

  // Automatic layer: 20k lemmas in frequency bands of 1,000.
  const wordShards: { file: string; from: number; to: number; count: number }[] = [];
  const wordsPath = process.argv[2];
  if (wordsPath && existsSync(wordsPath)) {
    const rows = JSON.parse(readFileSync(wordsPath, 'utf8')) as { w: string; r: number; p: string; d: string; x?: string; xs?: string; xb?: string }[];
    const BAND = 1000;
    for (let b = 0; b * BAND < rows.length; b++) {
      const band = rows.slice(b * BAND, (b + 1) * BAND);
      const ipas = await citationIpa(band.map((r) => r.w));
      const out = band.map((r, k) => {
        const phones = tokenizeDictionaryIpa(ipas[k]);
        return { ...r, i: stressedIpa(phones), ph: encodePhonemes(phones.map((p) => p.p)) };
      });
      const file = `words-${String(b + 1).padStart(2, '0')}.json`;
      writeFileSync(join(OUT, file), JSON.stringify(out));
      wordShards.push({ file, from: b * BAND + 1, to: b * BAND + band.length, count: band.length });
      for (const r of band) if (!taken.has(r.w)) search.push([r.w, `w_${r.w}`, `w${b + 1}`]);
      console.log(`words band ${b + 1}: ${band.length}`);
    }
  }

  search.sort((a, b) => a[0].localeCompare(b[0]));
  writeFileSync(join(OUT, 'search.json'), JSON.stringify(search));
  const index = {
    version: 1,
    categories,
    curated: categories.reduce((s, c) => s + c.count, 0),
    wordShards,
    words: wordShards.reduce((s, w) => s + w.count, 0),
    licences: [
      { name: 'Curated cards', note: 'Authored with AI assistance for LexiPhon, schema-validated; IPA generated by espeak-ng (en-GB-x-rp).' },
      { name: 'wordfreq', url: 'https://github.com/rspeer/wordfreq', license: 'CC BY-SA 4.0 (frequency data)' },
      { name: 'Princeton WordNet 3.0', url: 'https://wordnet.princeton.edu/', license: 'WordNet 3.0 licence' },
      { name: 'Tatoeba', url: 'https://tatoeba.org/', license: 'CC BY 2.0 FR' },
      { name: 'Wikipedia / Wikimedia Commons', url: 'https://www.wikipedia.org/', license: 'Thumbnails loaded on demand; licences per image' },
    ],
  };
  writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 1) + '\n');
  writeFileSync(WIKI_CACHE, JSON.stringify(wikiCache));
  console.log(`curated ${index.curated} · words ${index.words} · search ${search.length}`);
  if (problems.length) console.log(`\n${problems.length} problems:\n${problems.slice(0, 60).join('\n')}`);
}

void main();
