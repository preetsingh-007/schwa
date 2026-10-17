/**
 * The lexicon: 83 core register cards + ~3,000 curated British culture /
 * UK-vs-US / idiom / pragmatics cards + 20,000 automatic word cards. Data is
 * fetched lazily (per category, per frequency band) and kept in a registry so
 * prompts, scoring and the card drawer can look any entry up by id.
 */
import type { LexiconIndex, Prompt, VocabEntry, WordRow } from '../types';
import { decodePhonemes } from './corpus';
import { WEAK_FORMS } from '../lib/connectedSpeech';
import { phoneticTraps } from '../lib/phoneticTrap';
import { tokenizeDictionaryIpa } from '../lib/ipa';

const BASE = () => import.meta.env.BASE_URL;
const registry = new Map<string, VocabEntry>();
const listeners = new Set<() => void>();
let indexP: Promise<LexiconIndex> | null = null;
const catP = new Map<string, Promise<VocabEntry[]>>();
const bandP = new Map<number, Promise<VocabEntry[]>>();
let searchP: Promise<[string, string, string][]> | null = null;

export function onLexiconChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
function emit() { listeners.forEach((l) => l()); }

export function registerEntries(entries: VocabEntry[]): void {
  for (const e of entries) registry.set(e.id, e);
  emit();
}
export function getEntry(id: string): VocabEntry | undefined {
  return registry.get(id);
}
export function registrySize(): number {
  return registry.size;
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE()}${path}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

export function loadLexiconIndex(): Promise<LexiconIndex> {
  indexP ??= getJson<LexiconIndex>('lexicon/index.json').catch((e) => { indexP = null; throw e; });
  return indexP;
}

export function loadCategory(id: string): Promise<VocabEntry[]> {
  let p = catP.get(id);
  if (!p) {
    p = (async () => {
      const idx = await loadLexiconIndex();
      const c = idx.categories.find((x) => x.id === id);
      if (!c) return [];
      const cards = await getJson<VocabEntry[]>(`lexicon/${c.file}`);
      registerEntries(cards);
      return cards;
    })().catch((e) => { catP.delete(id); throw e; });
    catP.set(id, p);
  }
  return p;
}

/** All curated cards (~2 MB); loaded in the background after start-up. */
export async function loadAllCurated(): Promise<VocabEntry[]> {
  const idx = await loadLexiconIndex();
  return (await Promise.all(idx.categories.map((c) => loadCategory(c.id)))).flat();
}

export function wordRowToEntry(r: WordRow): VocabEntry {
  const phones = tokenizeDictionaryIpa(r.i);
  const weak = Object.hasOwn(WEAK_FORMS, r.w) ? WEAK_FORMS[r.w] : undefined;
  const traps = phoneticTraps(r.w, phones);
  if (weak) traps.unshift(`Function word: in connected speech it is usually weak /${weak.weak}/ — strong /${r.i.replace(/[ˈˌ]/g, '')}/ only when stressed or at the end of a clause.`);
  const tt = r.xs?.startsWith('tt');
  return {
    id: `w_${r.w}`,
    headword: r.w,
    ipa_rp: `/${r.i}/`,
    syllable_stress: '',
    audio_uri: null,
    phonetic_trap: traps.slice(0, 2).join(' '),
    register_badge: 'GREEN_EXECUTIVE_SAFE',
    register_label: `Core English word · frequency rank ${r.r.toLocaleString('en-GB')}`,
    usage_context: '',
    pragmatic_note: '',
    replaces_verbose: [],
    collocations: [],
    examples_rp: r.x ? [{ text: r.x, ipa_connected: '' }] : [],
    phonemes: decodePhonemes(r.ph),
    source: 'auto',
    gloss: r.d,
    pos: r.p,
    rank: r.r,
    exampleSource: r.x ? (tt
      ? { name: `Tatoeba #${r.xs!.slice(2)}${r.xb ? ` · ${r.xb}` : ''}`, url: `https://tatoeba.org/en/sentences/show/${r.xs!.slice(2)}`, license: 'CC BY 2.0 FR' }
      : { name: 'WordNet 3.0', url: 'https://wordnet.princeton.edu/', license: 'WordNet licence' }) : null,
  };
}

/** Frequency band n (1 = the 1,000 most frequent lemmas). */
export function loadWordBand(n: number): Promise<VocabEntry[]> {
  let p = bandP.get(n);
  if (!p) {
    p = (async () => {
      const idx = await loadLexiconIndex();
      const s = idx.wordShards[n - 1];
      if (!s) return [];
      const rows = await getJson<WordRow[]>(`lexicon/${s.file}`);
      const entries = rows.map((r) => ({ ...wordRowToEntry(r), band: n }));
      registerEntries(entries);
      return entries;
    })().catch((e) => { bandP.delete(n); throw e; });
    bandP.set(n, p);
  }
  return p;
}

export interface SearchHit { headword: string; id: string; group: string }

export async function searchLexicon(q: string, limit = 40): Promise<SearchHit[]> {
  searchP ??= getJson<[string, string, string][]>('lexicon/search.json').catch((e) => { searchP = null; throw e; });
  const all = await searchP;
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const starts: SearchHit[] = [], contains: SearchHit[] = [];
  for (const [h, id, group] of all) {
    const l = h.toLowerCase();
    if (l.startsWith(needle)) starts.push({ headword: h, id, group });
    else if (l.includes(needle)) contains.push({ headword: h, id, group });
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

/** Make sure an entry referenced by id is in the registry (fetching its shard). */
export async function ensureEntry(id: string): Promise<VocabEntry | undefined> {
  if (registry.has(id)) return registry.get(id);
  if (id.startsWith('lx_')) {
    const idx = await loadLexiconIndex();
    const cat = idx.categories.find((c) => id.startsWith(`lx_${c.id}_`));
    if (cat) await loadCategory(cat.id);
  } else if (id.startsWith('w_')) {
    const hit = (await searchLexicon(id.slice(2), 400)).find((h) => h.id === id);
    const band = hit ? Number(hit.group.slice(1)) : NaN;
    if (band) await loadWordBand(band);
  }
  return registry.get(id);
}

// ---------------------------------------------------------------------------
// Words mode: prompts generated from lexicon entries
// ---------------------------------------------------------------------------

/** "Name it" when there is a picture or a different American word; otherwise listen-and-repeat its example. */
export function entryPrompts(e: VocabEntry): Prompt[] {
  const out: Prompt[] = [];
  const base = { tier: 1 as const, targetVocab: [e.id], cardId: e.id, phonemes: e.phonemes ?? [], category: e.category ?? 'word' };
  if (e.source === 'lexicon' && (e.img || e.us_equivalent)) {
    out.push({
      ...base,
      id: `nm:${e.id}`,
      mode: 'nameit',
      title: e.us_equivalent ? 'Say it the British way' : 'What do you call this in the UK?',
      text: e.us_equivalent ? `American: “${e.us_equivalent}”. What do Britons say?` : e.gloss ?? 'Name it',
      reference: e.headword,
      timeLimitSec: 8,
    });
  }
  const ex = e.examples_rp[0]?.text;
  if (ex) {
    out.push({
      ...base,
      id: `sw:${e.id}`,
      mode: 'shadow',
      title: e.source === 'auto' ? `Word #${e.rank?.toLocaleString('en-GB')} · ${e.headword}` : `${e.headword}`,
      text: ex,
      reference: ex,
      timeLimitSec: Math.min(30, Math.max(8, Math.round(ex.split(/\s+/).length * 0.6 + 5))),
      source: e.exampleSource ?? undefined,
    });
  }
  return out;
}

/** Band progression: move on once 80 % of the current band has been practised. */
export function nextWordBand(band: number, practisedInBand: number, bandSize: number, maxBand: number): number {
  return practisedInBand >= bandSize * 0.8 && band < maxBand ? band + 1 : band;
}
