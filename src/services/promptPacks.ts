/** Additional Tier 2 / Tier 3 prompt packs (public/prompts), loaded in the background. */
import type { Prompt } from '../types';

interface PackIndex { version: number; packs: { file: string; tier: 2 | 3; pack: string; count: number }[]; tier2: number; tier3: number }

let all: Promise<Prompt[]> | null = null;

export function loadPromptPacks(): Promise<Prompt[]> {
  all ??= (async () => {
    const base = import.meta.env.BASE_URL;
    const r = await fetch(`${base}prompts/index.json`);
    if (!r.ok) return [];
    const idx = (await r.json()) as PackIndex;
    const packs = await Promise.all(idx.packs.map(async (p) => {
      const res = await fetch(`${base}prompts/${p.file}`);
      return res.ok ? ((await res.json()) as Prompt[]) : [];
    }));
    return packs.flat();
  })().catch(() => { all = null; return []; });
  return all;
}
