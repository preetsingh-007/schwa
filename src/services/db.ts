/**
 * Local primary store (IndexedDB via Dexie): RL state vector, FSRS vocabulary
 * cards, prompt statistics, session logs and settings. Model weights live in
 * Cache Storage (managed by Transformers.js), not here.
 */
import Dexie, { type Table } from 'dexie';
import type { LearnerState, PromptStat, SessionLog, Settings, SyncDocument, VocabCard } from '../types';
import { initialLearner } from './rlBandit';
import { MAX_SYNCED_SESSIONS } from './githubSync';

export interface CachedAudio {
  key: string;
  ts: number;
  sampleRate: number;
  pcm: ArrayBuffer;
  prosody?: unknown;
}

export const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  ghOwner: '',
  ghRepo: 'schwa-data',
  ghToken: '',
  ghPath: 'state/schwa_state.json',
  geminiKey: '',
  geminiEnabled: false,
  handsFree: false,
  device: 'auto',
  phonemeModel: 'full',
  ttsVoice: '',
  rpVoice: 'neural',
  kokoroVoice: 'bf_emma',
  autoSync: true,
  lastSyncAt: null,
  lastSyncSha: null,
  lastSyncError: null,
  dirty: false,
};

class LexiDB extends Dexie {
  learner!: Table<LearnerState, string>;
  settings!: Table<Settings, string>;
  vocab!: Table<VocabCard, string>;
  sessions!: Table<SessionLog, string>;
  promptStats!: Table<PromptStat, string>;
  audioCache!: Table<CachedAudio, string>;

  // The app was first called LexiPhon. Storage ids (this database, the sync schema
  // 'lexiphon/state@1', cache names) keep that name so existing progress survives.
  constructor(name = 'lexiphon') {
    super(name);
    this.version(1).stores({
      learner: 'id',
      settings: 'id',
      vocab: 'id, due',
      sessions: 'id, ts, promptId, tier',
      promptStats: 'id',
    });
    // v2: cache of neural-voice renders (PCM16) so references replay instantly and offline.
    this.version(2).stores({ audioCache: 'key, ts' });
  }
}

export const db = new LexiDB();

export async function getLearner(): Promise<LearnerState> {
  return (await db.learner.get('learner')) ?? initialLearner();
}

export async function getSettings(): Promise<Settings> {
  const s = await db.settings.get('settings');
  return { ...DEFAULT_SETTINGS, ...s };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch, id: 'settings' as const };
  await db.settings.put(next);
  return next;
}

/** Flag that local state has changes not yet pushed (the offline sync queue). */
export async function markDirty(): Promise<void> {
  await saveSettings({ dirty: true });
}

export async function exportDocument(): Promise<SyncDocument> {
  const [learner, vocab, promptStats, sessions] = await Promise.all([
    getLearner(),
    db.vocab.toArray(),
    db.promptStats.toArray(),
    db.sessions.orderBy('ts').reverse().limit(MAX_SYNCED_SESSIONS).toArray(),
  ]);
  return { schema: 'lexiphon/state@1', exportedAt: Date.now(), learner, vocab, promptStats, sessions: sessions.reverse() };
}

export function isSyncDocument(x: unknown): x is SyncDocument {
  const d = x as SyncDocument;
  return !!d && d.schema === 'lexiphon/state@1' && !!d.learner && Array.isArray(d.vocab) && Array.isArray(d.sessions);
}

/** Replace local state with a document (used by import and after a merge). */
export async function writeDocument(doc: SyncDocument): Promise<void> {
  await db.transaction('rw', [db.learner, db.vocab, db.promptStats, db.sessions], async () => {
    await db.learner.put({ ...doc.learner, id: 'learner' });
    await db.vocab.clear();
    await db.vocab.bulkPut(doc.vocab);
    await db.promptStats.clear();
    await db.promptStats.bulkPut(doc.promptStats);
    await db.sessions.clear();
    await db.sessions.bulkPut(doc.sessions);
  });
}

export async function resetAll(): Promise<void> {
  await db.transaction('rw', [db.learner, db.vocab, db.promptStats, db.sessions], async () => {
    await Promise.all([db.learner.clear(), db.vocab.clear(), db.promptStats.clear(), db.sessions.clear()]);
  });
}
