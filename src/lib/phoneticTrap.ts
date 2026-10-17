/**
 * Rule-based "phonetic trap" tips derived from a word's RP phonemes and its
 * spelling — so every one of the 20,000+ lexicon entries gets accurate,
 * consistent pronunciation guidance without hand-written IPA.
 */
import type { Phone } from './ipa';
import { isVowel } from './ipa';

export function stressedIpa(phones: Phone[]): string {
  return phones.map((p) => (p.stress === 2 ? 'ˈ' : p.stress === 1 ? 'ˌ' : '') + p.p).join('');
}

export function phoneticTraps(word: string, phones: Phone[]): string[] {
  const w = word.toLowerCase();
  const ps = phones.map((p) => p.p);
  const tips: string[] = [];
  const has = (p: string) => ps.includes(p);

  if (has('ɑː') && /a(s[kpt]|th|ff|f[t]|nce|nt|nd|nch|lf|lm)/.test(w) && !/ar/.test(w)) {
    tips.push('BATH vowel: long open back /ɑː/ (as in "father"), never short [æ].');
  }
  if (/[aeiouy]r(?![aeiouy])|r$|re$/.test(w.replace(/rr/g, 'r')) && !ps.slice(0, -1).some((p, i) => p === 'r' && isVowel(ps[i + 1] ?? ''))) {
    tips.push('Non-rhotic: the written r is silent here — lengthen the vowel instead of curling the tongue.');
  }
  if (has('əʊ')) tips.push('GOAT /əʊ/: start from a relaxed central schwa and glide to /ʊ/ — never a flat [oː].');
  if (has('eɪ')) tips.push('FACE /eɪ/: a full glide from /e/ up to /ɪ/, not a flat [eː].');
  if (has('θ') || has('ð')) tips.push(`Dental fricative ${has('θ') ? '/θ/' : '/ð/'}: tongue tip at the teeth with continuous airflow — not [t]/[d].`);
  if (has('v') && has('w')) tips.push('/v/ (teeth on lower lip, buzzing) vs /w/ (rounded lips, no teeth).');
  else if (has('v')) tips.push('/v/: upper teeth on the lower lip with audible friction — not [w] or [ʋ].');
  else if (has('w')) tips.push('/w/: round the lips without tooth contact — not [v] or [ʋ].');
  if (/[aeiou]tt?[aeiouy]/.test(w) && has('t') && phones.length > 3) tips.push('RP keeps a crisp /t/ between vowels — no American flap [ɾ].');
  if (ps.some((p, i) => (p === 't' || p === 'd' || p === 'n' || p === 's' || p === 'l') && ps[i + 1] === 'j' && ps[i + 2] === 'uː')) {
    tips.push('Keep the RP yod: /j/ before /uː/ (as in "tune" /tjuːn/, "news" /njuːz/).');
  }
  if (/ile$/.test(w) && ps.slice(-2).join('') === 'aɪl') tips.push('RP -ile is /aɪl/ (mobile, fragile) — not American /əl/.');
  const vowels = phones.filter((p) => isVowel(p.p));
  const reduced = vowels.filter((p) => p.stress === 0 && (p.p === 'ə' || p.p === 'ɪ')).length;
  if (vowels.length >= 3 && reduced >= 1) tips.push(`Stress-timed: ${stressedIpa(phones)} — reduce the unstressed syllables to /ə/ or /ɪ/.`);
  if (!tips.length && phones.some((p) => p.p === 't' || p.p === 'd' || p.p === 'n' || p.p === 'l')) {
    tips.push('Alveolar /t d n l/: tongue tip on the ridge behind the teeth, not curled back.');
  }
  return tips.slice(0, 2);
}
