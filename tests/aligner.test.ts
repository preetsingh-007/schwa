import { describe, expect, it } from 'vitest';
import { buildConnectedTarget } from '../src/lib/connectedSpeech';
import { alignToTarget, type ProducedPhone } from '../src/services/ipaAligner';
import { targetFromText } from '../src/lib/g2p';

const prod = (s: string): ProducedPhone[] => s.split(' ').filter(Boolean).map((p, i) => ({ p, start: i * 0.08, end: i * 0.08 + 0.08 }));

describe('connected speech (Stream C)', () => {
  it('applies weak forms, linking r and t-glottalling licences', async () => {
    const t = await targetFromText('I want to go to the shop for a cup of tea.');
    const byWord = Object.fromEntries(t.map((w) => [w.text, w]));
    expect(byWord['for'].ipa).toBe('fər'); // weak form + linking /r/ before "a"
    expect(byWord['of'].ipa).toBe('əv');
    expect(t.find((w) => w.text === 'want')!.phones.at(-1)!.glottalOk).toBe(true);
    expect(t.at(-1)!.ipa).toBe('tˈiː');
  });
  it('keeps strong forms at the end of a clause', async () => {
    const t = await targetFromText('What are you looking for?');
    expect(t.at(-1)!.weakApplied).toBe(false);
  });
  it('keeps pre-vocalic /r/ inside words', async () => {
    const t = await targetFromText('Americans hearing a story');
    expect(t[0].phones.map((p) => p.p).join('')).toBe('əmerɪkənz');
    expect(t[1].phones.map((p) => p.p).join('')).toBe('hɪərɪŋ');
  });
  it('produces non-rhotic targets', async () => {
    const t = await targetFromText('The first workers start early.');
    expect(t.flatMap((w) => w.phones.map((p) => p.p))).not.toContain('r');
  });
});

describe('alignToTarget (Stream D phonetic diff)', () => {
  const target = buildConnectedTarget(['go', 'home'], ['ɡˈəʊ', 'hˈəʊm']);

  it('scores a perfect RP realisation as all matches', () => {
    const a = alignToTarget(target, prod('ɡ əʊ h əʊ m'));
    expect(a.per).toBe(0);
    expect(a.words.every((w) => w.status === 'match')).toBe(true);
  });

  it('flags GOAT monophthongisation as crimson', () => {
    const a = alignToTarget(target, prod('ɡ oː h oː m'));
    expect(a.diagnoses.GOAT_MONOPHTHONG).toBe(2);
    expect(a.words.map((w) => w.status)).toEqual(['error', 'error']);
  });

  it('flags retroflex stops and rhotic insertions', () => {
    const t = buildConnectedTarget(['total', 'work'], ['tˈəʊtəl', 'wˈɜːk']);
    const a = alignToTarget(t, prod('ʈ əʊ ʈ ə l w ɜː r k'));
    expect(a.diagnoses.RETROFLEX).toBe(2);
    expect(a.diagnoses.RHOTIC).toBe(1);
  });

  it('accepts a glottal stop for licensed /t/', () => {
    const t = buildConnectedTarget(['quite', 'good'], ['kwˈaɪt', 'ɡˈʊd']);
    const a = alignToTarget(t, prod('k w aɪ ʔ ɡ ʊ d'));
    expect(a.per).toBe(0);
  });

  it('detects unreduced weak forms (missed schwa) as amber', () => {
    const t = buildConnectedTarget(['go', 'to', 'bed'], ['ɡˈəʊ', 'tˈuː', 'bˈed']);
    expect(t[1].ipa).toBe('tə');
    const ok = alignToTarget(t, prod('ɡ əʊ t ə b e d'));
    expect(ok.schwa).toMatchObject({ expected: 1, reduced: 1 });
    const missed = alignToTarget(t, prod('ɡ əʊ t uː b e d'));
    expect(missed.schwa.missedWords).toEqual([1]);
    expect(missed.diagnoses.MISSED_SCHWA).toBe(1);
    expect(missed.words[1].status).toBe('drift');
  });

  it('detects v/w merger and th-stopping', () => {
    const t = buildConnectedTarget(['very', 'thin'], ['vˈerɪ', 'θˈɪn']);
    const a = alignToTarget(t, prod('ʋ e r iː t ɪ n'));
    expect(a.diagnoses.VW_MERGER).toBe(1);
    expect(a.diagnoses.TH_STOPPING).toBe(1);
    // happY tensing: [i] for final /ɪ/ is fine
    expect(a.words[0].pairs.find((p) => p.target?.p === 'ɪ')!.kind).toBe('match');
  });

  it('assigns produced timings to words', () => {
    const a = alignToTarget(target, prod('ɡ əʊ h əʊ m'));
    expect(a.words[1].start).toBeCloseTo(0.16);
  });
});

describe('prototype-safe dictionaries', () => {
  it('handles words that collide with Object.prototype keys', async () => {
    const t = await targetFromText('The constructor called toString and valueOf.');
    expect(t.map((w) => w.text)).toEqual(['The', 'constructor', 'called', 'toString', 'and', 'valueOf']);
    expect(t.every((w) => w.phones.length > 0)).toBe(true);
  });
});
