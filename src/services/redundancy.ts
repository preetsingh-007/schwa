/**
 * Local anti-verbosity engine: Redundancy Pattern Dictionary matcher,
 * compression rewrite, lexical density and target-vocabulary deployment.
 * Works fully offline; the Gemini enhancer only ever adds to its output.
 */
import type { RedundancyRule, VocabEntry } from '../types';

export interface RedundancyHit {
  rule: RedundancyRule;
  start: number;
  end: number;
  text: string;
  /** the rule's first replacement with capture groups ($1…) substituted */
  replacement: string;
}

interface Compiled { rule: RedundancyRule; re: RegExp; one: RegExp }
const cache = new WeakMap<RedundancyRule[], Compiled[]>();

function compile(rules: RedundancyRule[]): Compiled[] {
  let c = cache.get(rules);
  if (!c) {
    c = [];
    for (const rule of rules) {
      try { c.push({ rule, re: new RegExp(rule.pattern, 'gi'), one: new RegExp(rule.pattern, 'i') }); } catch { /* skip malformed rule */ }
    }
    cache.set(rules, c);
  }
  return c;
}

/** Find non-overlapping hits, preferring earlier and then longer matches. */
export function findRedundancies(text: string, rules: RedundancyRule[]): RedundancyHit[] {
  const all: RedundancyHit[] = [];
  for (const { rule, re, one } of compile(rules)) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      const replacement = m[0].replace(one, rule.replacements[0] ?? '');
      all.push({ rule, start: m.index, end: m.index + m[0].length, text: m[0], replacement });
    }
  }
  all.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || (a.rule.severity === 'critical' ? -1 : 1));
  const out: RedundancyHit[] = [];
  let cursor = -1;
  for (const h of all) {
    if (h.start >= cursor) { out.push(h); cursor = h.end; }
  }
  return out;
}

function matchCase(src: string, repl: string): string {
  if (!repl) return repl;
  if (src[0] && src[0] === src[0].toUpperCase() && src[0] !== src[0].toLowerCase()) return repl[0].toUpperCase() + repl.slice(1);
  return repl;
}

/** Apply the first replacement of every hit → the 1-line compressed target. */
export function compress(text: string, hits: RedundancyHit[]): string {
  let out = '';
  let pos = 0;
  for (const h of hits) {
    out += text.slice(pos, h.start) + matchCase(h.text, h.replacement);
    pos = h.end;
  }
  out += text.slice(pos);
  return tidy(out);
}

export function tidy(s: string): string {
  return s
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])\s*([,.;:!?])/g, '$2')
    .replace(/^[\s,;:]+/, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/(^|[.!?]\s+)([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase())
    .trim();
}

export interface DiffSegment { text: string; kind: 'keep' | 'cut' | 'add'; rule?: RedundancyRule }

/** Inline diff for Block A: struck-through verbose spans + emerald replacements. */
export function lexicalDiff(text: string, hits: RedundancyHit[]): DiffSegment[] {
  const segs: DiffSegment[] = [];
  let pos = 0;
  for (const h of hits) {
    if (h.start > pos) segs.push({ text: text.slice(pos, h.start), kind: 'keep' });
    segs.push({ text: h.text, kind: 'cut', rule: h.rule });
    if (h.replacement) segs.push({ text: h.replacement, kind: 'add', rule: h.rule });
    pos = h.end;
  }
  if (pos < text.length) segs.push({ text: text.slice(pos), kind: 'keep' });
  return segs;
}

const FUNCTION_WORDS = new Set(
  `a an the and or but if so as at by for from in into of off on onto out over to up with without about above after
  before below between during through under until upon via is am are was were be been being have has had do does did
  can could may might must shall should will would i me my mine we us our ours you your yours he him his she her hers
  it its they them their theirs this that these those there here what which who whom whose when where why how not no
  yes just very really quite also too then than such some any all each every both either neither much many more most
  own same other another one like actually basically literally um uh er erm okay ok well yeah'`.split(/\s+/),
);

export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[’]/g, "'").match(/[a-z0-9']+/g) ?? [];
}

/** Ure's lexical density: content words / total words. */
export function lexicalDensity(text: string): number {
  const toks = tokenize(text);
  if (!toks.length) return 0;
  return toks.filter((t) => !FUNCTION_WORDS.has(t)).length / toks.length;
}

/** Light stemmer for lemma matching of target vocabulary. */
export function stem(w: string): string {
  let s = w.toLowerCase();
  for (const suf of ['ational', 'ising', 'izing', 'ised', 'ized', 'ness', 'ingly', 'edly', 'ing', 'ies', 'ied', 'es', 'ed', 'ly', 's']) {
    if (s.length > suf.length + 3 && s.endsWith(suf)) { s = s.slice(0, -suf.length); break; }
  }
  return s.replace(/e$/, '');
}

function containsPhrase(tokens: string[], phrase: string): boolean {
  const p = tokenize(phrase).map(stem);
  if (!p.length) return false;
  const t = tokens.map(stem);
  outer: for (let i = 0; i + p.length <= t.length; i++) {
    for (let k = 0; k < p.length; k++) if (t[i + k] !== p[k]) continue outer;
    return true;
  }
  return false;
}

/** Which target vocabulary items were deployed in the transcript. */
export function vocabUsed(text: string, vocab: VocabEntry[]): string[] {
  const tokens = tokenize(text);
  return vocab.filter((v) => [v.headword, ...(v.forms ?? [])].some((f) => containsPhrase(tokens, f))).map((v) => v.id);
}

export interface ConcisenessReport {
  hits: RedundancyHit[];
  critical: number;
  minor: number;
  wordCount: number;
  redundantWordRatio: number;
  lexicalDensity: number;
  fillers: number;
  /** r_concise ∈ [0, 1] */
  score: number;
  compressed: string;
}

const FILLER_RE = /\b(um+|uh+|erm+|er|hmm+|uhm)\b/gi;

export function concisenessReport(text: string, rules: RedundancyRule[]): ConcisenessReport {
  const hits = findRedundancies(text, rules);
  const words = tokenize(text);
  const wc = words.length;
  const redundantWords = hits.reduce((s, h) => s + tokenize(h.text).length - tokenize(h.replacement).length, 0);
  const ratio = wc ? Math.max(0, redundantWords) / wc : 0;
  const ld = lexicalDensity(text);
  const fillers = (text.match(FILLER_RE) ?? []).length;
  const critical = hits.filter((h) => h.rule.severity === 'critical').length;
  const minor = hits.length - critical;
  const ldScore = Math.min(1, Math.max(0, (ld - 0.3) / 0.25));
  const score = wc === 0 ? 0 : Math.max(0, Math.min(1, 0.6 * (1 - Math.min(1, 2.5 * ratio)) + 0.4 * ldScore - 0.12 * critical - 0.05 * fillers));
  return { hits, critical, minor, wordCount: wc, redundantWordRatio: ratio, lexicalDensity: ld, fillers, score, compressed: compress(text, hits) };
}
