/**
 * Stream C post-processing: turns per-word citation-form IPA (from espeak-ng)
 * into a connected-speech Modern RP target — weak forms ("schwa crushing"),
 * linking /r/, and licensed /t/-glottalling.
 */
import { tokenizeDictionaryIpa, isVowel, type Phone } from './ipa';

export interface TargetPhone extends Phone {
  word: number;
  /** vowel of a function word that RP reduces (to /ə/ or /ɪ/) */
  weak?: boolean;
  /** /r/ inserted by the linking-r rule */
  linking?: boolean;
  /** /t/ that may be realised as a glottal stop [ʔ] */
  glottalOk?: boolean;
  /** unstressed /ɪ/ that modern RP realises as tense [i] (happY, pre-vocalic) */
  tenseOk?: boolean;
  /** normalised spelling of the function word a weak vowel belongs to (calibration key) */
  weakWord?: string;
}

export interface TargetWord {
  text: string;
  /** canonical connected-speech IPA for display, e.g. "tə" */
  ipa: string;
  phones: TargetPhone[];
  isFunction: boolean;
  weakApplied: boolean;
}

interface WeakRule {
  weak: string;
  /** form used before a vowel-initial word, if different */
  beforeVowel?: string;
  /** only reduce when the previous word is one of these (auxiliary reading) */
  after?: Set<string>;
  /** never reduce when followed by these */
  notBefore?: Set<string>;
}

const PRONOUNS = new Set(['i', 'you', 'we', 'they', 'he', 'she', 'it', 'who', 'that', 'there', 'which', 'what', 'this', 'people', 'team']);
const NEG = new Set(['not', "n't"]);

/** Function words whose unstressed (weak) forms carry the RP schwa. */
export const WEAK_FORMS: Record<string, WeakRule> = {
  a: { weak: 'ə' },
  an: { weak: 'ən' },
  the: { weak: 'ðə', beforeVowel: 'ðɪ' },
  and: { weak: 'ən' },
  to: { weak: 'tə', beforeVowel: 'tʊ' },
  for: { weak: 'fə' },
  of: { weak: 'əv' },
  at: { weak: 'ət' },
  from: { weak: 'frəm' },
  as: { weak: 'əz' },
  but: { weak: 'bət' },
  than: { weak: 'ðən' },
  or: { weak: 'ə' },
  can: { weak: 'kən', notBefore: NEG },
  could: { weak: 'kəd', notBefore: NEG },
  would: { weak: 'wəd', notBefore: NEG },
  should: { weak: 'ʃəd', notBefore: NEG },
  must: { weak: 'məst', notBefore: NEG },
  shall: { weak: 'ʃəl', notBefore: NEG },
  was: { weak: 'wəz', notBefore: NEG },
  were: { weak: 'wə', notBefore: NEG },
  are: { weak: 'ə', after: PRONOUNS, notBefore: NEG },
  am: { weak: 'əm', after: new Set(['i']) },
  have: { weak: 'həv', after: PRONOUNS, notBefore: NEG },
  has: { weak: 'həz', after: PRONOUNS, notBefore: NEG },
  had: { weak: 'həd', after: PRONOUNS, notBefore: NEG },
  does: { weak: 'dəz', notBefore: NEG },
  do: { weak: 'də', beforeVowel: 'dʊ', after: PRONOUNS, notBefore: NEG },
  them: { weak: 'ðəm' },
  us: { weak: 'əs' },
  your: { weak: 'jə' },
  her: { weak: 'hə' },
  some: { weak: 'səm' },
  there: { weak: 'ðə', notBefore: new Set() },
};

/** Words that RP spells with a final r (so a linking /r/ is licensed). */
function endsWithSpelledR(word: string): boolean {
  return /r(e)?$/i.test(word.replace(/[^a-z]/gi, '')) || /(re|rre)$/i.test(word);
}
const LINKING_R_VOWELS = new Set(['ɑː', 'ɔː', 'ɜː', 'ə', 'ɪə', 'eə', 'ʊə']);

export function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9']/g, '');
}

/**
 * Split text into word tokens exactly as the G2P layer will see them.
 * Hyphenated compounds and contractions stay whole.
 */
export function splitWords(text: string): string[] {
  return text
    .replace(/[“”"«»()[\]{}…]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, ''))
    .filter((w) => w.length > 0);
}

/** Positions after which the speaker is likely to pause (clause punctuation). */
export function clauseFinalFlags(text: string): boolean[] {
  return text
    .replace(/[“”"«»()[\]{}…]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '').length > 0)
    .map((w) => /[.,;:!?—–]$/.test(w));
}

/**
 * Apply connected-speech rules.
 * @param words surface word tokens
 * @param citation citation-form IPA per word (same length as words)
 * @param clauseFinal whether a pause follows each word
 */
export function buildConnectedTarget(words: string[], citation: string[], clauseFinal: boolean[] = []): TargetWord[] {
  const result: TargetWord[] = [];
  const phonesPerWord = citation.map((ipa) => tokenizeDictionaryIpa(ipa));

  for (let i = 0; i < words.length; i++) {
    const norm = normalizeWord(words[i]);
    const prev = i > 0 ? normalizeWord(words[i - 1]) : '';
    const next = i + 1 < words.length ? normalizeWord(words[i + 1]) : '';
    const isLast = i === words.length - 1 || !!clauseFinal[i];
    const nextPhones = phonesPerWord[i + 1];
    const nextStartsWithVowel = !!nextPhones && nextPhones.length > 0 && isVowel(nextPhones[0].p) && !isLast;

    let phones: TargetPhone[] = phonesPerWord[i].map((ph) => ({ ...ph, word: i }));
    // Non-rhotic citation form: a word-final /r/ after a vowel is only ever a linking /r/ (re-added below).
    if (phones.length > 1 && phones[phones.length - 1].p === 'r' && isVowel(phones[phones.length - 2].p)) phones = phones.slice(0, -1);
    let weakApplied = false;
    const rule = WEAK_FORMS[norm];
    const isFunction = !!rule;
    if (rule && !isLast) {
      const ok = (!rule.after || rule.after.has(prev)) && !(rule.notBefore && rule.notBefore.has(next)) && !(norm === 'there' && !/^(is|are|was|were|'s|will|has|have|must|might|may|seems|seem)$/.test(next));
      if (ok) {
        const form = nextStartsWithVowel && rule.beforeVowel ? rule.beforeVowel : rule.weak;
        phones = tokenizeDictionaryIpa(form).map((ph) => ({ ...ph, stress: 0, word: i, weak: isVowel(ph.p), weakWord: isVowel(ph.p) ? norm : undefined }));
        weakApplied = true;
      }
    }

    // Linking /r/: "far away" → /fɑːr əˈweɪ/
    const last = phones[phones.length - 1];
    if (last && nextStartsWithVowel && LINKING_R_VOWELS.has(last.p) && endsWithSpelledR(norm)) {
      phones = [...phones, { p: 'r', stress: 0, word: i, linking: true }];
    }

    // /t/-glottalling licence: word-final /t/ before a consonant-initial word or a pause.
    const fin = phones[phones.length - 1];
    if (fin && fin.p === 't' && (isLast || (nextPhones && nextPhones.length > 0 && !isVowel(nextPhones[0].p)))) {
      fin.glottalOk = true;
    }
    // …and word-internal /t/ before a consonant ("football", "Gatwick").
    for (let k = 0; k < phones.length - 1; k++) {
      if (phones[k].p === 't' && !isVowel(phones[k + 1].p) && phones[k + 1].p !== 'r' && phones[k + 1].p !== 'j' && phones[k + 1].p !== 'w') phones[k].glottalOk = true;
    }

    // happY tensing: unstressed /ɪ/ word-finally or before another vowel.
    phones.forEach((ph, k) => {
      if (ph.p === 'ɪ' && ph.stress === 0 && (k === phones.length - 1 || isVowel(phones[k + 1].p))) ph.tenseOk = true;
    });

    result.push({
      text: words[i],
      ipa: phones.map((ph) => (ph.stress === 2 ? 'ˈ' : ph.stress === 1 ? 'ˌ' : '') + ph.p).join(''),
      phones,
      isFunction,
      weakApplied,
    });
  }
  return result;
}
