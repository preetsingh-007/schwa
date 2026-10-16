/**
 * Git-backed cloud sync to the user's own private repository using a
 * fine-grained PAT (Contents: Read & Write on that single repo).
 *
 * GET  /repos/{owner}/{repo}/contents/{path}  → remote document + blob SHA
 * merge deterministically with local state
 * PUT  /repos/{owner}/{repo}/contents/{path}  with `sha` (optimistic lock);
 * on 409/422 (someone else pushed) re-fetch, re-merge and retry.
 */
import { ALPHA } from './rlBandit';
import type { ConfusionState, Ewma, LearnerState, PromptStat, SessionLog, SyncDocument, VocabCard } from '../types';

const API = 'https://api.github.com';
export const MAX_SYNCED_SESSIONS = 1000;

export interface RepoConfig { owner: string; repo: string; token: string; path: string }

export class SyncError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

// --- base64 (UTF-8 safe) ------------------------------------------------------

export function encodeBase64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// --- deterministic merge -----------------------------------------------------

/**
 * Confusion-matrix merge via EWMA: a local row that saw k new observations
 * since the last sync is blended onto the remote row with weight
 * λ = 1 − (1 − α)^k — exactly the mass k EWMA updates would have had.
 */
export function mergeConfusion(local: ConfusionState, remote: ConfusionState): ConfusionState {
  const rows: number[][] = [], counts: number[] = [], pending: number[] = [], updatedAt: number[] = [];
  for (let i = 0; i < local.rows.length; i++) {
    const k = local.pending[i] ?? 0;
    const rRow = remote.rows[i] ?? local.rows[i];
    const lambda = k > 0 ? 1 - Math.pow(1 - ALPHA, k) : 0;
    const row = local.rows[i].map((v, j) => lambda * v + (1 - lambda) * (rRow[j] ?? 0));
    const sum = row.reduce((a, b) => a + b, 0) || 1;
    rows.push(row.map((v) => v / sum));
    counts.push((remote.counts[i] ?? 0) + k);
    pending.push(0);
    updatedAt.push(Math.max(local.updatedAt[i] ?? 0, remote.updatedAt[i] ?? 0));
  }
  return { rows, counts, pending, updatedAt };
}

function pickEwma(l: Ewma | undefined, r: Ewma | undefined, localNewer: boolean): Ewma | undefined {
  if (!l) return r;
  if (!r) return l;
  return localNewer ? l : r;
}

export function mergeLearner(local: LearnerState, remote: LearnerState): LearnerState {
  const localNewer = local.updatedAt >= remote.updatedAt;
  const habits: LearnerState['habits'] = {};
  for (const key of new Set([...Object.keys(local.habits), ...Object.keys(remote.habits)]) as Set<keyof LearnerState['habits']>) {
    const v = pickEwma(local.habits[key], remote.habits[key], localNewer);
    if (v) habits[key] = v;
  }
  const P = localNewer ? local.prosody : remote.prosody;
  return {
    id: 'learner',
    version: 1,
    confusion: mergeConfusion(local.confusion, remote.confusion),
    habits,
    prosody: P,
    totalTurns: Math.max(local.totalTurns, remote.totalTurns),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  };
}

/** Vocabulary review histories: latest review wins; histories are unioned. */
export function mergeVocab(local: VocabCard[], remote: VocabCard[]): VocabCard[] {
  const map = new Map<string, VocabCard>();
  for (const c of remote) map.set(c.id, c);
  for (const l of local) {
    const r = map.get(l.id);
    if (!r) { map.set(l.id, l); continue; }
    const winner = (l.lastReview ?? 0) >= (r.lastReview ?? 0) ? l : r;
    const seen = new Set<string>();
    const history = [...r.history, ...l.history]
      .filter((h) => { const k = `${h.t}:${h.grade}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.t - b.t)
      .slice(-50);
    map.set(l.id, { ...winner, history, updatedAt: Math.max(l.updatedAt, r.updatedAt) });
  }
  return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export function mergePromptStats(local: PromptStat[], remote: PromptStat[]): PromptStat[] {
  const map = new Map<string, PromptStat>();
  for (const s of remote) map.set(s.id, s);
  for (const l of local) {
    const r = map.get(l.id);
    map.set(l.id, r ? {
      id: l.id,
      n: Math.max(l.n, r.n),
      lastServed: Math.max(l.lastServed, r.lastServed),
      bestReward: Math.max(l.bestReward, r.bestReward),
      passed: l.passed || r.passed,
      updatedAt: Math.max(l.updatedAt, r.updatedAt),
    } : l);
  }
  return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export function mergeSessions(local: SessionLog[], remote: SessionLog[]): SessionLog[] {
  const map = new Map<string, SessionLog>();
  for (const s of [...remote, ...local]) map.set(s.id, s);
  return Array.from(map.values()).sort((a, b) => a.ts - b.ts).slice(-MAX_SYNCED_SESSIONS);
}

export function mergeDocuments(local: SyncDocument, remote: SyncDocument | null): SyncDocument {
  if (!remote) {
    return { ...local, learner: { ...local.learner, confusion: { ...local.learner.confusion, pending: local.learner.confusion.pending.map(() => 0) } } };
  }
  return {
    schema: 'lexiphon/state@1',
    exportedAt: Date.now(),
    learner: mergeLearner(local.learner, remote.learner),
    vocab: mergeVocab(local.vocab, remote.vocab),
    promptStats: mergePromptStats(local.promptStats, remote.promptStats),
    sessions: mergeSessions(local.sessions, remote.sessions),
  };
}

// --- REST client ---------------------------------------------------------------

function headers(token: string): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function contentsUrl(c: RepoConfig): string {
  const path = c.path.split('/').map(encodeURIComponent).join('/');
  return `${API}/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${path}`;
}

async function explain(res: Response): Promise<SyncError> {
  let detail = '';
  try { detail = ((await res.json()) as { message?: string }).message ?? ''; } catch { /* no body */ }
  const hint = res.status === 401 ? 'token rejected — check the PAT' : res.status === 403 ? 'token lacks Contents: Read & Write on this repo (or rate-limited)' : res.status === 404 ? 'repo not found or token has no access' : '';
  return new SyncError(`GitHub ${res.status}${detail ? `: ${detail}` : ''}${hint ? ` (${hint})` : ''}`, res.status);
}

export async function verifyRepo(c: RepoConfig, fetchImpl: typeof fetch = fetch): Promise<{ private: boolean; fullName: string }> {
  const res = await fetchImpl(`${API}/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`, { headers: headers(c.token) });
  if (!res.ok) throw await explain(res);
  const j = (await res.json()) as { private: boolean; full_name: string };
  return { private: j.private, fullName: j.full_name };
}

export async function fetchRemote(c: RepoConfig, fetchImpl: typeof fetch = fetch): Promise<{ doc: SyncDocument | null; sha: string | null }> {
  const res = await fetchImpl(`${contentsUrl(c)}?t=${Date.now()}`, { headers: headers(c.token), cache: 'no-store' });
  if (res.status === 404) {
    // Distinguish "file not created yet" from "no access to repo".
    await verifyRepo(c, fetchImpl);
    return { doc: null, sha: null };
  }
  if (!res.ok) throw await explain(res);
  const j = (await res.json()) as { content?: string; sha: string; encoding?: string; download_url?: string };
  let text: string;
  if (j.content && j.encoding === 'base64') text = decodeBase64Utf8(j.content);
  else {
    // Files > 1 MB come back without inline content; fetch the raw blob.
    const raw = await fetchImpl(contentsUrl(c), { headers: { ...headers(c.token), Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
    if (!raw.ok) throw await explain(raw);
    text = await raw.text();
  }
  const doc = JSON.parse(text) as SyncDocument;
  if (doc?.schema !== 'lexiphon/state@1') throw new SyncError('Remote file is not a LexiPhon state document');
  return { doc, sha: j.sha };
}

export async function pushRemote(c: RepoConfig, doc: SyncDocument, sha: string | null, fetchImpl: typeof fetch = fetch): Promise<string> {
  const body = {
    message: `LexiPhon sync · ${new Date(doc.exportedAt).toISOString()}`,
    content: encodeBase64Utf8(JSON.stringify(doc)),
    ...(sha ? { sha } : {}),
  };
  const res = await fetchImpl(contentsUrl(c), { method: 'PUT', headers: { ...headers(c.token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw await explain(res);
  const j = (await res.json()) as { content: { sha: string } };
  return j.content.sha;
}

/**
 * Pull → merge → push with SHA optimistic locking. Returns the merged
 * document (which the caller writes back locally) and the new blob SHA.
 */
export async function syncWithRemote(
  c: RepoConfig,
  local: SyncDocument,
  fetchImpl: typeof fetch = fetch,
  maxAttempts = 3,
): Promise<{ doc: SyncDocument; sha: string }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { doc: remote, sha } = await fetchRemote(c, fetchImpl);
    const merged = mergeDocuments(local, remote);
    try {
      const newSha = await pushRemote(c, merged, sha, fetchImpl);
      return { doc: merged, sha: newSha };
    } catch (e) {
      lastErr = e;
      if (e instanceof SyncError && (e.status === 409 || e.status === 422)) continue; // SHA moved underneath us
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new SyncError('Sync failed after retries');
}
