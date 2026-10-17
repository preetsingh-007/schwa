import { describe, expect, it } from 'vitest';
import { phoneticTraps } from '../src/lib/phoneticTrap';
import { tokenizeDictionaryIpa } from '../src/lib/ipa';
import { entryPrompts, nextWordBand, wordRowToEntry } from '../src/services/lexicon';
import { vocabUsed } from '../src/services/redundancy';
import type { VocabEntry } from '../src/types';

describe('phoneticTraps', () => {
  it('derives RP tips from phonemes and spelling', () => {
    expect(phoneticTraps('bath', tokenizeDictionaryIpa('bˈɑːθ')).join(' ')).toMatch(/BATH/);
    expect(phoneticTraps('car', tokenizeDictionaryIpa('kˈɑː')).join(' ')).toMatch(/Non-rhotic/);
    expect(phoneticTraps('code', tokenizeDictionaryIpa('kˈəʊd')).join(' ')).toMatch(/GOAT/);
    expect(phoneticTraps('tune', tokenizeDictionaryIpa('tjˈuːn')).join(' ')).toMatch(/yod/);
    expect(phoneticTraps('very', tokenizeDictionaryIpa('vˈerɪ')).join(' ')).toMatch(/\/v\//);
  });
});

describe('automatic word cards', () => {
  const e = wordRowToEntry({ w: 'for', r: 9, p: 'function word', d: 'intended for', i: 'fˈɔː', ph: '', x: 'This is for you.', xs: 'tt123', xb: 'CK' });
  it('adds the weak-form note to function words and attribution to examples', () => {
    expect(e.id).toBe('w_for');
    expect(e.phonetic_trap).toMatch(/weak \/fə\//);
    expect(e.exampleSource?.url).toContain('/123');
    expect(e.source).toBe('auto');
  });
  it('becomes a listen-and-repeat prompt', () => {
    const ps = entryPrompts(e);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ mode: 'shadow', text: 'This is for you.', targetVocab: ['w_for'] });
  });
});

describe('curated cards', () => {
  const chips: VocabEntry = {
    id: 'lx_uk_us_food_chips', headword: 'chips', ipa_rp: '/tʃˈɪps/', syllable_stress: '', audio_uri: null, phonetic_trap: '',
    register_badge: 'AMBER_COLLEAGUE', register_label: '', usage_context: '', pragmatic_note: '', replaces_verbose: [], collocations: [],
    examples_rp: [{ text: 'Shall we get fish and chips?', ipa_connected: '' }], source: 'lexicon', us_equivalent: 'French fries', gloss: 'Thick-cut fried potato strips.', forms: ['chip'],
  };
  it('yields a name-it drill and a repeat drill', () => {
    const ps = entryPrompts(chips);
    expect(ps.map((p) => p.mode)).toEqual(['nameit', 'shadow']);
    expect(ps[0].text).toContain('French fries');
    expect(ps[0].reference).toBe('chips');
  });
  it('recognises the word in a natural answer', () => {
    expect(vocabUsed('We just call them chips over here', [chips])).toEqual([chips.id]);
    expect(vocabUsed('Those are fries', [chips])).toEqual([]);
  });
});

describe('word bands', () => {
  it('advance at 80 % of the band', () => {
    expect(nextWordBand(1, 799, 1000, 20)).toBe(1);
    expect(nextWordBand(1, 800, 1000, 20)).toBe(2);
    expect(nextWordBand(20, 1000, 1000, 20)).toBe(20);
  });
});
