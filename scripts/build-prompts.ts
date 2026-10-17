/**
 * Validates and packages the authored Tier 2 / Tier 3 prompt packs
 * (scripts/data-src/prompts/tier{2,3}_<pack>.json, see BRIEF.md) into
 * lazily-loaded shards under public/prompts/.
 *
 * Checks: schema; target headwords resolve to lexicon/core card ids; Tier 2
 * references are ≤ 45 % of the verbose length, actually contain their
 * targets and trigger no critical redundancy rule; duplicates removed.
 * Run after scripts/build-lexicon.ts (card ids come from public/lexicon).
 *
 *   npx vite-node scripts/build-prompts.ts
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { concisenessReport, findRedundancies, tokenize, vocabUsed } from '../src/services/redundancy';
import { targetFromText } from '../src/lib/g2p';
import { isRpPhoneme } from '../src/lib/ipa';
import type { LexiconIndex, Prompt, RedundancyRule, VocabEntry } from '../src/types';

const ROOT = process.cwd();
const SRC = join(ROOT, 'scripts/data-src/prompts');
const OUT = join(ROOT, 'public/prompts');

interface T2 { domain: string; category: string; verbose: string; reference: string; targets: string[] }
interface T3 { domain: string; category: string; register: string; prompt: string; seconds: number; targets: string[] }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

async function phonemesOf(text: string): Promise<string[]> {
  return Array.from(new Set((await targetFromText(text)).flatMap((w) => w.phones.map((p) => p.p)).filter(isRpPhoneme)));
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const rules = JSON.parse(readFileSync(join(ROOT, 'public/data/redundancy_rules.json'), 'utf8')) as RedundancyRule[];
  const entries: VocabEntry[] = JSON.parse(readFileSync(join(ROOT, 'public/data/vocab_curriculum.json'), 'utf8'));
  const lex = JSON.parse(readFileSync(join(ROOT, 'public/lexicon/index.json'), 'utf8')) as LexiconIndex;
  for (const c of lex.categories) entries.push(...(JSON.parse(readFileSync(join(ROOT, 'public/lexicon', c.file), 'utf8')) as VocabEntry[]));
  const byHead = new Map<string, VocabEntry>();
  for (const e of entries) if (!byHead.has(e.headword.toLowerCase())) byHead.set(e.headword.toLowerCase(), e);

  // Single-word targets that are also everyday words ("well", "right", "dead" as slang)
  // would be "detected" in almost any answer — exclude the 2,000 most frequent words.
  const common = new Set<string>();
  for (const f of ['words-01.json', 'words-02.json']) {
    const p = join(ROOT, 'public/lexicon', f);
    if (existsSync(p)) for (const r of JSON.parse(readFileSync(p, 'utf8')) as { w: string }[]) common.add(r.w);
  }
  const ambiguous = (e: VocabEntry) => !/\s/.test(e.headword) && common.has(e.headword.toLowerCase());

  const packs: { file: string; tier: 2 | 3; pack: string; count: number }[] = [];
  const seen = new Set<string>();
  const report: string[] = [];
  for (const f of readdirSync(SRC).filter((x) => /^tier[23]_.+\.json$/.test(x)).sort()) {
    const tier = f.startsWith('tier2') ? 2 : 3;
    const pack = f.replace(/^tier[23]_|\.json$/g, '');
    let raw: (T2 | T3)[];
    try { raw = JSON.parse(readFileSync(join(SRC, f), 'utf8')); } catch (e) { report.push(`${f}: invalid JSON (${String(e)})`); continue; }
    const out: Prompt[] = [];
    const drop: Record<string, number> = {};
    const bump = (k: string) => { drop[k] = (drop[k] ?? 0) + 1; };
    let n = 0;
    for (const item of raw) {
      const targets = (item.targets ?? []).map((h) => byHead.get(String(h).toLowerCase())).filter((e): e is VocabEntry => !!e && !ambiguous(e));
      if (tier === 2) {
        const it = item as T2;
        if (!it.verbose || !it.reference) { bump('incomplete'); continue; }
        const key = norm(it.verbose);
        if (seen.has(key)) { bump('duplicate'); continue; }
        const vw = tokenize(it.verbose).length, rw = tokenize(it.reference).length;
        if (vw < 15 || rw > Math.ceil(vw * 0.5)) { bump('not compressed'); continue; }
        if (concisenessReport(it.reference, rules).critical > 0) { bump('reference has critical redundancy'); continue; }
        // keep only targets the model answer really uses
        const used = new Set(vocabUsed(it.reference, targets));
        const kept = targets.filter((t) => used.has(t.id));
        if (!kept.length) { bump('targets not in reference'); continue; }
        seen.add(key);
        out.push({
          id: `t2_${pack}_${++n}`, tier: 2, category: it.category || it.domain, title: 'Compress it — 10 seconds',
          text: it.verbose.trim(), reference: it.reference.trim(), targetVocab: kept.map((t) => t.id), timeLimitSec: 10,
          phonemes: Array.from(new Set([...(await phonemesOf(it.reference)), ...kept.flatMap((t) => t.phonemes ?? [])])),
        });
      } else {
        const it = item as T3;
        if (!it.prompt || tokenize(it.prompt).length < 8) { bump('incomplete'); continue; }
        const key = norm(it.prompt);
        if (seen.has(key)) { bump('duplicate'); continue; }
        if (!targets.length) { bump('no resolvable targets'); continue; }
        if (it.register === 'work' && targets.some((t) => t.register_badge === 'RED_COLLOQUIAL')) { bump('RED target in work register'); continue; }
        seen.add(key);
        const secs = [30, 45, 60].includes(it.seconds) ? it.seconds : 45;
        out.push({
          id: `t3_${pack}_${++n}`, tier: 3, category: it.category || it.domain,
          title: (it.category || it.domain || 'Monologue').replace(/^./, (c) => c.toUpperCase()),
          text: it.prompt.trim(), targetVocab: targets.slice(0, 3).map((t) => t.id), timeLimitSec: secs,
          phonemes: Array.from(new Set(targets.flatMap((t) => t.phonemes ?? []))),
        });
      }
    }
    const file = `tier${tier}-${pack}.json`;
    writeFileSync(join(OUT, file), JSON.stringify(out));
    packs.push({ file, tier, pack, count: out.length });
    const flagged = tier === 2 ? out.filter((p) => findRedundancies(p.text, rules).length > 0).length : 0;
    report.push(`${f}: ${raw.length} authored → ${out.length} kept${tier === 2 ? ` (${flagged} verbose texts trigger the dictionary)` : ''}${Object.keys(drop).length ? ` · dropped ${JSON.stringify(drop)}` : ''}`);
  }
  const index = { version: 1, packs, tier2: packs.filter((p) => p.tier === 2).reduce((s, p) => s + p.count, 0), tier3: packs.filter((p) => p.tier === 3).reduce((s, p) => s + p.count, 0) };
  writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 1) + '\n');
  console.log(report.join('\n'));
  console.log(`total: tier 2 ${index.tier2} · tier 3 ${index.tier3}`);
  if (!existsSync(join(OUT, 'index.json'))) process.exit(1);
}

void main();
