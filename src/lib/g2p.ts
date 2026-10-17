/**
 * Stream C: British English grapheme-to-phoneme via espeak-ng (compiled to
 * WASM, "en-gb-x-rp" Received Pronunciation voice), followed by the
 * connected-speech rules in connectedSpeech.ts.
 */
import { phonemize } from 'phonemizer';
import { buildConnectedTarget, clauseFinalFlags, splitWords, type TargetWord } from './connectedSpeech';

export const G2P_VOICE = 'en-gb-x-rp';

/** Small curated overrides where espeak's RP voice disagrees with modern RP dictionaries. */
const LEXICON: Record<string, string> = {
  schedule: 'ˈʃedjuːl',
  either: 'ˈaɪðə',
  neither: 'ˈnaɪðə',
  privacy: 'ˈprɪvəsi',
  vitamin: 'ˈvɪtəmɪn',
  tomato: 'təˈmɑːtəʊ',
  route: 'ruːt',
  garage: 'ˈɡærɑːʒ',
  leisure: 'ˈleʒə',
  advertisement: 'ədˈvɜːtɪsmənt',
  controversy: 'ˈkɒntrəvɜːsi',
  data: 'ˈdeɪtə',
  research: 'rɪˈsɜːtʃ',
  nuance: 'ˈnjuːɑːns',
  ok: 'ˌəʊˈkeɪ',
  okay: 'ˌəʊˈkeɪ',
};

function g2pToken(w: string): string {
  // espeak treats "." as a sentence break; keep tokens free of clause punctuation.
  return w.replace(/[.]/g, '').replace(/-/g, ' ');
}

/** Citation-form IPA for each word (one espeak call for the whole list). */
export async function citationIpa(words: string[]): Promise<string[]> {
  const out: string[] = new Array(words.length).fill('');
  const todo: number[] = [];
  words.forEach((w, i) => {
    const lex = LEXICON[w.toLowerCase()];
    if (lex) out[i] = lex; else todo.push(i);
  });
  if (todo.length) {
    // Joining with commas makes espeak return one clause per word, which keeps
    // word boundaries intact (it otherwise fuses clitics like "in the" → ɪnðə).
    const joined = todo.map((i) => g2pToken(words[i])).join(', ');
    const res = await phonemize(joined, G2P_VOICE);
    if (res.length === todo.length) {
      todo.forEach((i, k) => { out[i] = res[k].replace(/\s+/g, ''); });
    } else {
      for (const i of todo) out[i] = (await phonemize(g2pToken(words[i]), G2P_VOICE)).join('').replace(/\s+/g, '');
    }
  }
  return out;
}

/** Dynamic ground truth: the ideal connected-speech Modern RP IPA for `text`. */
export async function targetFromText(text: string): Promise<TargetWord[]> {
  const words = splitWords(text);
  if (!words.length) return [];
  const citation = await citationIpa(words);
  return buildConnectedTarget(words, citation, clauseFinalFlags(text));
}

/**
 * The RP target as a Kokoro phoneme string, so the neural voice speaks exactly
 * what we score against: en-GB-x-rp vowels (BATH /ɑː/), weak forms, linking /r/.
 * (Kokoro's own en-GB front end uses a northern-leaning espeak voice and full
 * function-word forms.) Symbols are mapped to the conventions Kokoro was
 * trained with: TRAP "a", DRESS "ɛ", NEAR "iə", /r/ "ɹ".
 */
export async function kokoroPhonemes(text: string): Promise<string> {
  const words = splitWords(text);
  if (!words.length) return '';
  const target = buildConnectedTarget(words, await citationIpa(words), clauseFinalFlags(text));
  const punct = text
    .replace(/[“”"«»()[\]{}…]/g, ' ')
    .split(/\s+/)
    .filter((w) => /[A-Za-z0-9]/.test(w))
    .map((w) => (w.match(/[.,;:!?]+$/) ?? [''])[0].replace(/[;:]/g, ','));
  const map: Record<string, string> = { æ: 'a', e: 'ɛ', r: 'ɹ', 'ɪə': 'iə' };
  return target
    .map((w, i) => w.phones.map((p) => (p.stress === 2 ? 'ˈ' : p.stress === 1 ? 'ˌ' : '') + (map[p.p] ?? p.p)).join('') + (punct[i] ?? ''))
    .join(' ');
}
