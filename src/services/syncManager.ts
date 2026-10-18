/**
 * Offline-first sync orchestration: local IndexedDB is always the primary
 * store; when online and configured, pull → merge → push to the user's
 * private GitHub repo. A `dirty` flag acts as the offline queue.
 */
import { exportDocument, getSettings, isSyncDocument, saveSettings, writeDocument } from './db';
import { mergeDocuments, syncWithRemote, verifyRepo, type RepoConfig } from './githubSync';
import { withStateLock } from './lock';
import type { Settings, SyncDocument } from '../types';

type Listener = (s: SyncStatus) => void;
export interface SyncStatus { state: 'off' | 'idle' | 'syncing' | 'error' | 'offline' | 'pending'; lastSyncAt: number | null; error: string | null }

const listeners = new Set<Listener>();
let status: SyncStatus = { state: 'off', lastSyncAt: null, error: null };
let timer: ReturnType<typeof setTimeout> | null = null;

function emit(s: Partial<SyncStatus>) {
  status = { ...status, ...s };
  listeners.forEach((l) => l(status));
}
export function onSyncStatus(l: Listener): () => void {
  listeners.add(l);
  l(status);
  return () => listeners.delete(l);
}

export function repoConfig(s: Settings): RepoConfig | null {
  if (!s.ghOwner.trim() || !s.ghRepo.trim() || !s.ghToken.trim()) return null;
  return { owner: s.ghOwner.trim(), repo: s.ghRepo.trim(), token: s.ghToken.trim(), path: s.ghPath.trim() || 'state/schwa_state.json' };
}

export async function refreshSyncStatus(): Promise<void> {
  const s = await getSettings();
  const cfg = repoConfig(s);
  if (!cfg) return emit({ state: 'off', lastSyncAt: s.lastSyncAt, error: null });
  if (!navigator.onLine) return emit({ state: 'offline', lastSyncAt: s.lastSyncAt });
  emit({ state: s.lastSyncError ? 'error' : s.dirty ? 'pending' : 'idle', lastSyncAt: s.lastSyncAt, error: s.lastSyncError });
}

export async function syncNow(): Promise<void> {
  const s = await getSettings();
  const cfg = repoConfig(s);
  if (!cfg) { emit({ state: 'off' }); return; }
  if (!navigator.onLine) { emit({ state: 'offline' }); return; }
  emit({ state: 'syncing', error: null });
  try {
    await withStateLock(async () => {
      const local = await exportDocument();
      const { doc, sha } = await syncWithRemote(cfg, local);
      await writeDocument(doc);
      await saveSettings({ lastSyncAt: Date.now(), lastSyncSha: sha, lastSyncError: null, dirty: false });
    });
    const after = await getSettings();
    emit({ state: 'idle', lastSyncAt: after.lastSyncAt, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await saveSettings({ lastSyncError: msg });
    emit({ state: 'error', error: msg });
  }
}

/** Debounced auto-sync after local changes. */
export function scheduleSync(delayMs = 4000): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    const s = await getSettings();
    if (s.autoSync && repoConfig(s)) await syncNow(); else await refreshSyncStatus();
  }, delayMs);
}

export async function verifyAndPush(): Promise<string> {
  const s = await getSettings();
  const cfg = repoConfig(s);
  if (!cfg) throw new Error('Enter owner, repo and token first');
  const info = await verifyRepo(cfg);
  if (!info.private) throw new Error(`${info.fullName} is PUBLIC — schwa only syncs to a private repo. Make it private first.`);
  await syncNow();
  if (status.state === 'error') throw new Error(status.error ?? 'sync failed');
  return `Synced with private repo ${info.fullName}`;
}

export function installSyncTriggers(): void {
  window.addEventListener('online', () => { void getSettings().then((s) => { if (s.dirty && s.autoSync) void syncNow(); else void refreshSyncStatus(); }); });
  window.addEventListener('offline', () => emit({ state: 'offline' }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void getSettings().then((s) => { if (s.dirty && s.autoSync && repoConfig(s)) void syncNow(); });
  });
  void refreshSyncStatus().then(() => getSettings()).then((s) => { if (s.autoSync && repoConfig(s)) void syncNow(); });
}

// --- manual JSON backup ---------------------------------------------------------

export async function exportBackupBlob(): Promise<Blob> {
  const doc = await exportDocument();
  return new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' });
}

export async function importBackup(text: string, mode: 'merge' | 'replace'): Promise<void> {
  const parsed = JSON.parse(text) as unknown;
  if (!isSyncDocument(parsed)) throw new Error('Not a schwa backup file');
  await withStateLock(async () => {
    const doc: SyncDocument = mode === 'replace' ? parsed : mergeDocuments(await exportDocument(), parsed);
    await writeDocument(doc);
    await saveSettings({ dirty: true });
  });
}
