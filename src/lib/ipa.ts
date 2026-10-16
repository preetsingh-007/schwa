/**
 * IPA inventory, tokenisation, normalisation and articulatory features for
 * Modern RP (Standard Southern British). Everything downstream — alignment,
 * the confusion matrix, the heatmap — speaks in these canonical symbols.
 */

export const RP_VOWELS = [
  'iː', 'ɪ', 'e', 'æ', 'ʌ', 'ɑː', 'ɒ', 'ɔː', 'ʊ', 'uː', 'ɜː', 'ə',
  'eɪ', 'aɪ', 'ɔɪ', 'əʊ', 'aʊ', 'ɪə', 'eə', 'ʊə',
] as const;

export const RP_CONSONANTS = [
  'p', 'b', 't', 'd', 'k', 'ɡ', 'f', 'v', 'θ', 'ð', 's', 'z',
  'ʃ', 'ʒ', 'h', 'tʃ', 'dʒ', 'm', 'n', 'ŋ', 'l', 'r', 'w', 'j',
] as const;

/** The 44 phonemes of Modern RP, in a fixed order (row/column index of M_P). */
export const RP_PHONEMES: readonly string[] = [...RP_VOWELS, ...RP_CONSONANTS];
export const PHONEME_INDEX: ReadonlyMap<string, number> = new Map(RP_PHONEMES.map((p, i) => [p, i]));

/**
 * Non-RP realisations we track as extra confusion-matrix columns because they
 * are the signature interference habits of an Indian / international baseline.
 */
export const INTERFERENCE_PHONES = ['ʈ', 'ɖ', 'ɳ', 'ɭ', 'ʋ', 'β', 'oː', 'eː', 'oʊ', 'ɾ', 't̪', 'd̪', 'a', 'ɔ', 'ɑ'] as const;
export const DELETION = '∅';
export const OTHER = '·';
/** Columns of the (44 × K) confusion matrix: 44 RP phonemes + interference + deletion + other. */
export const CONFUSION_COLUMNS: readonly string[] = [...RP_PHONEMES, ...INTERFERENCE_PHONES, DELETION, OTHER];
export const COLUMN_INDEX: ReadonlyMap<string, number> = new Map(CONFUSION_COLUMNS.map((p, i) => [p, i]));

export function isVowel(p: string): boolean {
  return VOWEL_FEATURES.has(p);
}
export function isRpPhoneme(p: string): boolean {
  return PHONEME_INDEX.has(p);
}

// ---------------------------------------------------------------------------
// Articulatory features
// ---------------------------------------------------------------------------

type Manner = 'stop' | 'affricate' | 'fricative' | 'nasal' | 'lateral' | 'approximant' | 'tap' | 'trill';
interface ConsonantFeatures { place: number; manner: Manner; voiced: boolean }
/** height: 1 close … 4 open; back: 0 front … 2 back. Diphthongs carry an end point. */
interface VowelFeatures { height: number; back: number; round: boolean; long: boolean; end?: { height: number; back: number } }

// place: 0 bilabial, 1 labiodental, 2 dental, 3 alveolar, 4 postalveolar, 4.6 retroflex, 5 palatal, 6 velar, 6.5 labial-velar, 7 glottal
const C = (place: number, manner: Manner, voiced: boolean): ConsonantFeatures => ({ place, manner, voiced });
const CONSONANT_FEATURES = new Map<string, ConsonantFeatures>([
  ['p', C(0, 'stop', false)], ['b', C(0, 'stop', true)],
  ['t', C(3, 'stop', false)], ['d', C(3, 'stop', true)],
  ['t̪', C(2, 'stop', false)], ['d̪', C(2, 'stop', true)],
  ['ʈ', C(4.6, 'stop', false)], ['ɖ', C(4.6, 'stop', true)],
  ['k', C(6, 'stop', false)], ['ɡ', C(6, 'stop', true)],
  ['ʔ', C(7, 'stop', false)], ['q', C(6.5, 'stop', false)], ['c', C(5, 'stop', false)], ['ɟ', C(5, 'stop', true)],
  ['f', C(1, 'fricative', false)], ['v', C(1, 'fricative', true)],
  ['ɸ', C(0, 'fricative', false)], ['β', C(0, 'fricative', true)],
  ['θ', C(2, 'fricative', false)], ['ð', C(2, 'fricative', true)],
  ['s', C(3, 'fricative', false)], ['z', C(3, 'fricative', true)],
  ['ʃ', C(4, 'fricative', false)], ['ʒ', C(4, 'fricative', true)],
  ['ʂ', C(4.6, 'fricative', false)], ['ʐ', C(4.6, 'fricative', true)],
  ['ç', C(5, 'fricative', false)], ['x', C(6, 'fricative', false)], ['ɣ', C(6, 'fricative', true)],
  ['χ', C(6.5, 'fricative', false)], ['ʁ', C(6.5, 'fricative', true)], ['ħ', C(7, 'fricative', false)],
  ['h', C(7, 'fricative', false)], ['ɦ', C(7, 'fricative', true)],
  ['tʃ', C(4, 'affricate', false)], ['dʒ', C(4, 'affricate', true)],
  ['ts', C(3, 'affricate', false)], ['dz', C(3, 'affricate', true)],
  ['tɕ', C(4.8, 'affricate', false)], ['dʑ', C(4.8, 'affricate', true)], ['ɕ', C(4.8, 'fricative', false)], ['ʑ', C(4.8, 'fricative', true)],
  ['m', C(0, 'nasal', true)], ['n', C(3, 'nasal', true)], ['ɳ', C(4.6, 'nasal', true)], ['ɲ', C(5, 'nasal', true)], ['ŋ', C(6, 'nasal', true)], ['ɴ', C(6.5, 'nasal', true)],
  ['l', C(3, 'lateral', true)], ['ɭ', C(4.6, 'lateral', true)], ['ʎ', C(5, 'lateral', true)], ['ɬ', C(3, 'fricative', false)],
  ['r', C(3.5, 'approximant', true)], ['ɻ', C(4.6, 'approximant', true)],
  ['ɾ', C(3, 'tap', true)], ['ɽ', C(4.6, 'tap', true)], ['r̃', C(3, 'trill', true)],
  ['w', C(6.5, 'approximant', true)], ['ʋ', C(1, 'approximant', true)], ['j', C(5, 'approximant', true)],
]);

const V = (height: number, back: number, round: boolean, long: boolean, end?: [number, number]): VowelFeatures =>
  ({ height, back, round, long, end: end ? { height: end[0], back: end[1] } : undefined });
const VOWEL_FEATURES = new Map<string, VowelFeatures>([
  ['iː', V(1, 0, false, true)], ['ɪ', V(1.5, 0.3, false, false)], ['e', V(2.5, 0, false, false)],
  ['æ', V(3.5, 0, false, false)], ['ʌ', V(3.2, 1.4, false, false)], ['ɑː', V(4, 2, false, true)],
  ['ɒ', V(4, 2, true, false)], ['ɔː', V(2.5, 2, true, true)], ['ʊ', V(1.5, 1.6, true, false)],
  ['uː', V(1, 1.6, true, true)], ['ɜː', V(2.5, 1, false, true)], ['ə', V(2.6, 1, false, false)],
  ['eɪ', V(2.5, 0, false, true, [1.5, 0.3])], ['aɪ', V(4, 1, false, true, [1.5, 0.3])],
  ['ɔɪ', V(2.5, 2, true, true, [1.5, 0.3])], ['əʊ', V(2.6, 1, false, true, [1.5, 1.6])],
  ['aʊ', V(4, 1, false, true, [1.5, 1.6])], ['ɪə', V(1.5, 0.3, false, true, [2.6, 1])],
  ['eə', V(2.5, 0, false, true, [2.6, 1])], ['ʊə', V(1.5, 1.6, true, true, [2.6, 1])],
  // Non-RP vowels that the acoustic model can emit.
  ['oː', V(2, 2, true, true)], ['o', V(2, 2, true, false)], ['eː', V(2, 0, false, true)],
  ['oʊ', V(2, 2, true, true, [1.5, 1.6])], ['a', V(4, 0.6, false, false)], ['aː', V(4, 0.6, false, true)],
  ['ɔ', V(3, 2, true, false)], ['ɑ', V(4, 2, false, false)], ['ɛ', V(3, 0, false, false)], ['ɛː', V(3, 0, false, true)],
  ['ɐ', V(3.5, 1, false, false)], ['i', V(1, 0, false, false)], ['u', V(1, 1.6, true, false)],
  ['y', V(1, 0, true, false)], ['ø', V(2, 0, true, false)], ['œ', V(3, 0, true, false)], ['ɨ', V(1, 1, false, false)],
  ['ʉ', V(1, 1, true, false)], ['ɯ', V(1, 2, false, false)], ['ɵ', V(2, 1, true, false)], ['ɤ', V(2, 2, false, false)],
  ['əɪ', V(2.6, 1, false, true, [1.5, 0.3])], ['eʊ', V(2.5, 0, false, true, [1.5, 1.6])], ['ɛʊ', V(3, 0, false, true, [1.5, 1.6])],
  ['iə', V(1, 0, false, true, [2.6, 1])], ['ɛɪ', V(3, 0, false, true, [1.5, 0.3])], ['ai', V(4, 0.6, false, true, [1, 0])], ['au', V(4, 0.6, false, true, [1, 1.6])],
]);

export function featuresOf(p: string): ConsonantFeatures | VowelFeatures | undefined {
  return CONSONANT_FEATURES.get(p) ?? VOWEL_FEATURES.get(p);
}

const MANNER_DIST: Record<string, number> = {
  'stop|affricate': 0.25, 'stop|fricative': 0.4, 'affricate|fricative': 0.25,
  'approximant|tap': 0.2, 'tap|trill': 0.15, 'approximant|trill': 0.25,
  'lateral|approximant': 0.3, 'stop|tap': 0.3, 'fricative|approximant': 0.3,
  'lateral|tap': 0.35, 'nasal|stop': 0.5,
};
function mannerDistance(a: Manner, b: Manner): number {
  if (a === b) return 0;
  return MANNER_DIST[`${a}|${b}`] ?? MANNER_DIST[`${b}|${a}`] ?? 0.6;
}

/**
 * Articulatory substitution cost in [0, 1]. 0 = identical; ~0.15–0.35 = a
 * near neighbour (allophonic drift); > 0.35 = a genuinely different phoneme.
 */
export function substitutionCost(a: string, b: string): number {
  if (a === b) return 0;
  const ca = CONSONANT_FEATURES.get(a), cb = CONSONANT_FEATURES.get(b);
  if (ca && cb) {
    const place = Math.min(1, Math.abs(ca.place - cb.place) / 4) * 0.45;
    const manner = mannerDistance(ca.manner, cb.manner);
    const voice = ca.voiced === cb.voiced ? 0 : 0.2;
    return clamp(place + manner + voice, 0.12, 1);
  }
  const va = VOWEL_FEATURES.get(a), vb = VOWEL_FEATURES.get(b);
  if (va && vb) {
    let cost = Math.abs(va.height - vb.height) * 0.12 + Math.abs(va.back - vb.back) * 0.12;
    cost += va.round === vb.round ? 0 : 0.08;
    cost += va.long === vb.long ? 0 : 0.08;
    if (!!va.end !== !!vb.end) cost += 0.3; // diphthong ↔ monophthong
    else if (va.end && vb.end) cost += (Math.abs(va.end.height - vb.end.height) + Math.abs(va.end.back - vb.end.back)) * 0.08;
    return clamp(cost, 0.1, 1);
  }
  // Glides are close to their vowel counterparts; everything else is a full mismatch.
  if ((a === 'w' && (b === 'ʊ' || b === 'uː' || b === 'u')) || (b === 'w' && (a === 'ʊ' || a === 'uː' || a === 'u'))) return 0.45;
  if ((a === 'j' && (b === 'ɪ' || b === 'iː' || b === 'i')) || (b === 'j' && (a === 'ɪ' || a === 'iː' || a === 'i'))) return 0.45;
  return 1;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// ---------------------------------------------------------------------------
// Tokenisation & normalisation
// ---------------------------------------------------------------------------

export interface Phone {
  /** canonical symbol */
  p: string;
  /** 0 unstressed, 1 secondary, 2 primary (only meaningful on vowels) */
  stress: 0 | 1 | 2;
}

/** Multi-character symbols, longest first, for greedy tokenisation of espeak strings. */
const MULTI = [
  'ɑːɹ', 'ɔːɹ', 'oːɹ', 'aɪə', 'aɪɚ', 'aʊə',
  'tʃ', 'dʒ', 'eɪ', 'aɪ', 'ɔɪ', 'əʊ', 'aʊ', 'ɪə', 'eə', 'ʊə', 'iə', 'oʊ', 'əl',
  'iː', 'ɑː', 'ɔː', 'uː', 'ɜː', 'oː', 'eː', 'aː', 'ɛː', 'ɪː', 'ʊː', 'əː', 'yː', 'øː',
  'ts', 'dz', 'tɕ', 'dʑ', 't̪', 'd̪', 'ɛɹ', 'ɪɹ', 'ʊɹ',
];

/** Symbols that are pure notation variants of a canonical RP phoneme. */
const VARIANTS: Record<string, string[]> = {
  g: ['ɡ'], ɡ: ['ɡ'], ɹ: ['r'], ɛ: ['e'], ɐ: ['ə'], ᵻ: ['ɪ'], ɚ: ['ə'], ɜ: ['ɜː'], əː: ['ɜː'],
  iə: ['ɪə'], ɛː: ['eə'], ɪː: ['iː'], ʊː: ['uː'], ɫ: ['l'], 'l̩': ['l'], 'n̩': ['n'], 'm̩': ['m'],
  əl: ['ə', 'l'], ɑːɹ: ['ɑː'], ɔːɹ: ['ɔː'], aɪɚ: ['aɪ', 'ə'], aɪə: ['aɪ', 'ə'], aʊə: ['aʊ', 'ə'],
  ɛɹ: ['eə'], ɪɹ: ['ɪə'], ʊɹ: ['ʊə'], i: ['iː'], u: ['uː'],
  S: ['ʃ'], Z: ['ʒ'], N: ['ŋ'], tS: ['tʃ'], dZ: ['dʒ'], th: ['θ'],
};

/** espeak-ng's en-GB voices write TRAP as [a]; phonemically that is /æ/. */
/** In citation forms espeak only writes ɹ where RP pronounces it (before a vowel), so keep it. */
const DICT_VARIANTS: Record<string, string[]> = {
  ...VARIANTS, a: ['æ'], aː: ['ɑː'],
  ɑːɹ: ['ɑː', 'r'], ɔːɹ: ['ɔː', 'r'], ɛɹ: ['e', 'r'], ɪɹ: ['ɪ', 'r'], ʊɹ: ['ʊ', 'r'],
};

/**
 * Acoustic-model normalisation differs from the dictionary side in two ways:
 *  1. r-coloured tokens mean the speaker *actually produced* an /r/, so they
 *     split into vowel + r (the aligner then sees rhotic insertions).
 *  2. Close-mid monophthongs [e] [o] are the FACE/GOAT interference vowels.
 */
const ACOUSTIC_VARIANTS: Record<string, string[]> = {
  ...VARIANTS,
  ɚ: ['ə', 'r'], ɝ: ['ɜː', 'r'], ɑːɹ: ['ɑː', 'r'], ɔːɹ: ['ɔː', 'r'], oːɹ: ['oː', 'r'], aɪɚ: ['aɪ', 'ə', 'r'],
  ɛɹ: ['e', 'r'], ɪɹ: ['ɪ', 'r'], ʊɹ: ['ʊ', 'r'], ər: ['ə', 'r'],
  e: ['eː'], o: ['oː'], r: ['ɾ'], 'r̃': ['ɾ'], ɽ: ['ɾ'],
  'tʰ': ['t'], 'pʰ': ['p'], 'kʰ': ['k'], 'tʃʰ': ['tʃ'], 'ʈʰ': ['ʈ'], 'ɖʰ': ['ɖ'], 'bʰ': ['b'], 'dʰ': ['d'], 'ɡʰ': ['ɡ'],
  ph: ['p'], kh: ['k'], th: ['t'], tsh: ['t', 's'], ts: ['t', 's'], dz: ['d', 'z'],
  ä: ['a'], 'e̞': ['eː'], 'o̞': ['oː'],
};

/** Strip tone digits, diacritics we don't model, and doubled length marks. */
function cleanToken(t: string): string {
  return t
    .replace(/[0-9.[\]^"?]/g, '')
    .replace(/:/g, 'ː')
    .replace(/ːː+/g, 'ː')
    .replace(/[̃ʲ]/g, '') // nasalisation tilde, palatalisation ʲ
    .replace(/(.)\1/u, '$1'); // geminate tokens like pː handled by ː below
}

function expand(token: string, table: Record<string, string[]>): string[] {
  if (!token) return [];
  if (table[token]) return table[token];
  // geminates / long consonants: 'pː' → 'p'
  if (token.length >= 2 && token.endsWith('ː') && CONSONANT_FEATURES.has(token.slice(0, -1))) return expand(token.slice(0, -1), table);
  return [token];
}

/**
 * Tokenise a dictionary (espeak-ng) IPA word such as "həlˈəʊ" into canonical
 * phones with stress attached to the following vowel.
 */
export function tokenizeDictionaryIpa(ipa: string): Phone[] {
  const out: Phone[] = [];
  let pendingStress: 0 | 1 | 2 = 0;
  const s = ipa.normalize('NFC').replace(/[\s.‿-]/g, '');
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === 'ˈ') { pendingStress = 2; i++; continue; }
    if (ch === 'ˌ') { pendingStress = 1; i++; continue; }
    if (ch === 'ː') { // stray length mark: lengthen previous vowel if we can
      const prev = out[out.length - 1];
      if (prev && VOWEL_FEATURES.has(prev.p + 'ː')) prev.p = normalizeOne(prev.p + 'ː', DICT_VARIANTS)[0];
      i++; continue;
    }
    let tok = '';
    for (const m of MULTI) {
      if (s.startsWith(m, i)) { tok = m; break; }
    }
    if (!tok) {
      tok = ch;
      // swallow combining marks following the base character
      while (i + tok.length < s.length && /[̀-ͯ]/.test(s[i + tok.length])) tok += s[i + tok.length];
    }
    i += tok.length;
    for (const p of normalizeOne(tok, DICT_VARIANTS)) {
      if (VOWEL_FEATURES.has(p)) { out.push({ p, stress: pendingStress }); pendingStress = 0; }
      else out.push({ p, stress: 0 });
    }
  }
  return out;
}

function normalizeOne(tok: string, table: Record<string, string[]>): string[] {
  return expand(cleanToken(tok), table).filter((p) => p.length > 0);
}

/** Normalise one token emitted by the wav2vec2 espeak CTC head. */
export function normalizeAcousticToken(tok: string): string[] {
  if (tok === '<pad>' || tok === '<s>' || tok === '</s>' || tok === '<unk>' || tok === '|') return [];
  return normalizeOne(tok.normalize('NFC'), ACOUSTIC_VARIANTS);
}

export function toIpaString(phones: { p: string; stress?: number }[]): string {
  return phones.map((ph) => (ph.stress === 2 ? 'ˈ' : ph.stress === 1 ? 'ˌ' : '') + ph.p).join('');
}

/** Vowels that are acceptable realisations of a reduced (weak) vowel. */
export const REDUCED_VOWELS = new Set(['ə', 'ɪ', 'ʊ', 'ɐ', 'ɨ', 'ᵻ', 'ɵ']);
