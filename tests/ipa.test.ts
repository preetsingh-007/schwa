import { describe, expect, it } from 'vitest';
import { RP_PHONEMES, tokenizeDictionaryIpa, normalizeAcousticToken, substitutionCost, CONFUSION_COLUMNS } from '../src/lib/ipa';

describe('IPA inventory', () => {
  it('has exactly 44 RP phonemes', () => {
    expect(RP_PHONEMES).toHaveLength(44);
    expect(new Set(RP_PHONEMES).size).toBe(44);
    expect(CONFUSION_COLUMNS.slice(0, 44)).toEqual(RP_PHONEMES);
  });
});

describe('tokenizeDictionaryIpa', () => {
  it('splits diphthongs/affricates and attaches stress to the vowel', () => {
    const ph = tokenizeDictionaryIpa('həlˈəʊ');
    expect(ph.map((p) => p.p)).toEqual(['h', 'ə', 'l', 'əʊ']);
    expect(ph[3].stress).toBe(2);
    expect(tokenizeDictionaryIpa('tʃˈɑːns').map((p) => p.p)).toEqual(['tʃ', 'ɑː', 'n', 's']);
  });
  it('normalises espeak notation to canonical RP symbols', () => {
    expect(tokenizeDictionaryIpa('sˈɛpɹət').map((p) => p.p)).toEqual(['s', 'e', 'p', 'r', 'ə', 't']);
    expect(tokenizeDictionaryIpa('kˈat').map((p) => p.p)).toEqual(['k', 'æ', 't']);
    expect(tokenizeDictionaryIpa('ɐwˈeɪ').map((p) => p.p)).toEqual(['ə', 'w', 'eɪ']);
  });
});

describe('normalizeAcousticToken', () => {
  it('keeps interference phones and splits r-coloured vowels', () => {
    expect(normalizeAcousticToken('ʈ')).toEqual(['ʈ']);
    expect(normalizeAcousticToken('ɚ')).toEqual(['ə', 'r']);
    expect(normalizeAcousticToken('ɑːɹ')).toEqual(['ɑː', 'r']);
    expect(normalizeAcousticToken('o')).toEqual(['oː']);
    expect(normalizeAcousticToken('ɹ')).toEqual(['r']);
    expect(normalizeAcousticToken('tʰ')).toEqual(['t']);
    expect(normalizeAcousticToken('<pad>')).toEqual([]);
  });
});

describe('substitutionCost', () => {
  it('ranks near neighbours below distant phonemes', () => {
    expect(substitutionCost('t', 't')).toBe(0);
    expect(substitutionCost('t', 'ʈ')).toBeLessThan(substitutionCost('t', 'k'));
    expect(substitutionCost('əʊ', 'oː')).toBeLessThan(substitutionCost('əʊ', 'iː'));
    expect(substitutionCost('p', 'iː')).toBe(1);
  });
});
