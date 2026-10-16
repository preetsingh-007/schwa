import { describe, expect, it } from 'vitest';
import { mergeDocuments, mergeConfusion, syncWithRemote, encodeBase64Utf8, decodeBase64Utf8 } from '../src/services/githubSync';
import { initialLearner, ALPHA } from '../src/services/rlBandit';
import { newCard, review } from '../src/services/fsrs';
import type { SyncDocument } from '../src/types';

function doc(over: Partial<SyncDocument> = {}): SyncDocument {
  return { schema: 'lexiphon/state@1', exportedAt: 0, learner: initialLearner(0), vocab: [], promptStats: [], sessions: [], ...over };
}

describe('base64', () => {
  it('round-trips IPA', () => {
    const s = 'ʌnˈten.ə.bəl — /əʊ/ ✓';
    expect(decodeBase64Utf8(encodeBase64Utf8(s))).toBe(s);
  });
});

describe('merge', () => {
  it('blends confusion rows by λ = 1 − (1 − α)^k', () => {
    const local = initialLearner(0).confusion, remote = initialLearner(0).confusion;
    local.rows[0] = local.rows[0].map(() => 0); local.rows[0][1] = 1; local.pending[0] = 3;
    const m = mergeConfusion(local, remote);
    const lambda = 1 - (1 - ALPHA) ** 3;
    expect(m.rows[0][1]).toBeCloseTo(lambda, 6);
    expect(m.rows[0][0]).toBeCloseTo((1 - lambda) * 0.5, 6);
    expect(m.pending[0]).toBe(0);
    expect(m.rows[5]).toEqual(remote.rows[5]);
  });
  it('keeps the latest vocab review and unions histories and sessions', () => {
    const a = review(newCard('v', 0), 3, 1000, 'tier2');
    const b = review(newCard('v', 0), 4, 2000, 'tier3');
    const s = (id: string, ts: number) => ({ id, ts, promptId: 'p', tier: 1 as const, attempt: 1, reward: 0, phonetic: 0, prosody: 0, lexical: 0, passed: false, transcript: '', metrics: { per: 0, schwa: null, npvi: 0, fluency: 0, concise: null, syllableRate: 0, longPauses: 0, vocabUsed: [] } });
    const m = mergeDocuments(doc({ vocab: [a], sessions: [s('x', 1)] }), doc({ vocab: [b], sessions: [s('y', 2)] }));
    expect(m.vocab[0].lastReview).toBe(2000);
    expect(m.vocab[0].history).toHaveLength(2);
    expect(m.sessions.map((x) => x.id)).toEqual(['x', 'y']);
  });
});

describe('syncWithRemote', () => {
  it('creates the file when missing, then retries on SHA conflict', async () => {
    const calls: string[] = [];
    let puts = 0;
    let stored: string | null = null;
    const fake = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url.replace(/\?.*$/, '')}`);
      if (method === 'GET' && url.includes('/contents/')) {
        if (!stored) return new Response('{"message":"Not Found"}', { status: 404 });
        return Response.json({ content: encodeBase64Utf8(stored), encoding: 'base64', sha: 'abc' });
      }
      if (method === 'GET') return Response.json({ private: true, full_name: 'me/lexiphon-data' });
      puts++;
      if (puts === 1) { stored = JSON.stringify(doc()); return new Response('{"message":"sha mismatch"}', { status: 409 }); }
      const body = JSON.parse(String(init!.body)) as { sha?: string; content: string };
      expect(body.sha).toBe('abc');
      return Response.json({ content: { sha: 'def' } });
    }) as typeof fetch;
    const res = await syncWithRemote({ owner: 'me', repo: 'lexiphon-data', token: 't', path: 'state/lexiphon_state.json' }, doc(), fake);
    expect(res.sha).toBe('def');
    expect(puts).toBe(2);
    expect(calls[0]).toContain('/contents/state/lexiphon_state.json');
  });
});
