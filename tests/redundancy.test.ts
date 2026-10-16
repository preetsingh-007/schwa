import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { concisenessReport, findRedundancies, vocabUsed, lexicalDiff } from '../src/services/redundancy';
import type { RedundancyRule, VocabEntry, Prompt } from '../src/types';

const rules = JSON.parse(readFileSync('public/data/redundancy_rules.json', 'utf8')) as RedundancyRule[];
const vocab = JSON.parse(readFileSync('public/data/vocab_curriculum.json', 'utf8')) as VocabEntry[];
const prompts = JSON.parse(readFileSync('public/data/prompts_tiered.json', 'utf8')) as Prompt[];

describe('curated data', () => {
  it('meets the PRD volumes', () => {
    expect(rules.length).toBeGreaterThanOrEqual(300);
    expect(prompts.filter((p) => p.tier === 3).length).toBeGreaterThanOrEqual(500);
    expect(new Set(prompts.map((p) => p.id)).size).toBe(prompts.length);
  });
  it('every rule compiles and every vocab reference resolves', () => {
    const ids = new Set(vocab.map((v) => v.id));
    for (const r of rules) expect(() => new RegExp(r.pattern, 'gi')).not.toThrow();
    for (const p of prompts) for (const v of p.targetVocab) expect(ids.has(v)).toBe(true);
    for (const p of prompts) expect(p.phonemes?.length ?? 0).toBeGreaterThan(0);
  });
  it('Tier 2 model answers are themselves concise (no critical redundancies)', () => {
    for (const p of prompts.filter((x) => x.tier === 2)) {
      const rep = concisenessReport(p.reference!, rules);
      expect(rep.critical, `${p.id}: ${p.reference}`).toBe(0);
      expect(vocabUsed(p.reference!, vocab.filter((v) => p.targetVocab.includes(v.id))).length, p.id).toBeGreaterThan(0);
    }
  });
  it('Tier 2 verbose sources trigger the dictionary', () => {
    const verbose = prompts.filter((x) => x.tier === 2);
    const flagged = verbose.filter((p) => findRedundancies(p.text, rules).length > 0);
    expect(flagged.length / verbose.length).toBeGreaterThan(0.6);
  });
});

describe('redundancy matcher', () => {
  it('flags the PRD examples with British upgrades', () => {
    const text = 'Actually what I am trying to say is that the main problem is the database. Please do the needful and revert back to me at the earliest.';
    const rep = concisenessReport(text, rules);
    expect(rep.critical).toBeGreaterThanOrEqual(2);
    expect(rep.compressed).toMatch(/crux of the issue/i);
    expect(rep.compressed).toMatch(/action this/i);
    expect(rep.compressed).toMatch(/keep me posted/i);
    const segs = lexicalDiff(text, rep.hits);
    expect(segs.some((s) => s.kind === 'cut')).toBe(true);
    expect(segs.some((s) => s.kind === 'add')).toBe(true);
  });
  it('substitutes capture groups', () => {
    const rep = concisenessReport('Can you intimate me when it ships?', rules);
    expect(rep.compressed).toBe('Can you let me know when it ships?');
  });
  it('leaves concise British English alone', () => {
    const rep = concisenessReport("That timeline might be a bit of a stretch, so let's prioritise the security fixes.", rules);
    expect(rep.critical).toBe(0);
    expect(rep.score).toBeGreaterThan(0.6);
  });
  it('matches inflected vocabulary', () => {
    expect(vocabUsed('We mitigated it and prioritised the rest', vocab)).toEqual(expect.arrayContaining(['lex_mitigate_01', 'lex_prioritise_01']));
  });
});
