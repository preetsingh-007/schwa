import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store';
import { engine } from '../services/engine';
import { MODELS, type CacheStatus, type ModelKey } from '../workers/protocol';
import { exportBackupBlob, importBackup, syncNow, verifyAndPush, onSyncStatus, type SyncStatus } from '../services/syncManager';
import { testGeminiKey } from '../services/geminiEnhancer';
import { britishVoices, onVoicesChanged, speak } from '../services/tts';
import { resetAll } from '../services/db';
import { CloseIcon } from './Icons';
import { BRITISH_VOICES, KOKORO_APPROX_MB, rpVoice } from '../services/rpVoice';

const mb = (b: number) => `${(b / 1e6).toFixed(0)} MB`;

export default function SettingsVault({ onClose }: { onClose: () => void }) {
  const { settings, updateSettings, startEngine, engineState, engineModels, refresh } = useApp();
  const [cache, setCache] = useState<CacheStatus | null>(null);
  const [prog, setProg] = useState<Record<string, { loaded: number; total: number }>>({});
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [voices, setVoices] = useState(britishVoices());
  const [showToken, setShowToken] = useState(false);
  const [voiceState, setVoiceState] = useState(rpVoice.state);
  useEffect(() => rpVoice.subscribe(() => setVoiceState(rpVoice.state)), []);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => onSyncStatus(setSync), []);
  useEffect(() => onVoicesChanged(() => setVoices(britishVoices())), []);
  useEffect(() => { void engine.cacheStatus().then(setCache).catch(() => setCache(null)); }, [engineState]);
  useEffect(() => engine.onProgress((p) => setProg((cur) => ({ ...cur, [p.model]: engine.modelProgress(p.model) }))), []);

  const run = async (f: () => Promise<string | void>) => {
    setBusy(true); setMsg(null);
    try { const t = await f(); if (t) setMsg({ kind: 'ok', text: t }); } catch (e) { setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) }); } finally { setBusy(false); }
  };

  const download = async () => {
    const blob = await exportBackupBlob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `schwa-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Settings">
        <div className="row"><h2>Settings & vault</h2><span className="spacer" /><button className="iconbtn" onClick={onClose} aria-label="Close"><CloseIcon /></button></div>

        <h3>Offline engine</h3>
        {(Object.keys(MODELS) as ModelKey[]).map((k) => {
          const c = cache?.models[k];
          const p = prog[k];
          const pct = p && p.total ? Math.min(100, (p.loaded / p.total) * 100) : 0;
          const disabled = k === 'phoneme' && settings.phonemeModel === 'off';
          return (
            <div key={k} className="model-row">
              <div>
                <div className="small" style={{ fontWeight: 600 }}>{MODELS[k].label}</div>
                <div className="tiny muted mono">{MODELS[k].id}</div>
                {engineState === 'loading' && p && p.total > 0 && !engineModels[k] && <div className="progress"><span style={{ width: `${pct}%` }} /></div>}
              </div>
              <div className="small" style={{ textAlign: 'right' }}>
                {disabled ? <span className="muted">off</span> : engineModels[k] ? <span style={{ color: 'var(--emerald-ink)' }}>● loaded</span> : c?.cached ? <span>cached</span> : <span className="muted">~{MODELS[k].approxMB} MB</span>}
                {c && c.bytes > 0 && <div className="tiny muted">{mb(c.bytes)} on disk</div>}
              </div>
            </div>
          );
        })}
        <div className="model-row">
          <div><div className="small" style={{ fontWeight: 600 }}>espeak-ng G2P (Stream C, en-GB-x-rp)</div><div className="tiny muted">bundled with the app shell</div></div>
          <div className="small" style={{ color: 'var(--emerald-ink)' }}>● bundled</div>
        </div>
        <div className="row section">
          <button className="btn" disabled={engineState === 'loading'} onClick={() => void startEngine()}>
            {engineState === 'loading' ? 'Downloading…' : engineState === 'ready' ? 'Verify / reload' : 'Download & load for offline'}
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => void run(async () => { await engine.clearCache(); setCache(await engine.cacheStatus()); return 'Model cache cleared'; })}>Clear model cache</button>
        </div>
        {cache?.quota && <div className="tiny muted section">Storage {mb(cache.quota.usage)} of {mb(cache.quota.quota)} · persistent: {cache.persisted === null ? 'unknown' : cache.persisted ? 'yes' : 'no (browser may evict)'}</div>}
        <div className="field">
          <label className="small" htmlFor="dev">Compute device</label>
          <select id="dev" value={settings.device} onChange={(e) => void updateSettings({ device: e.target.value as typeof settings.device })}>
            <option value="auto">Auto (WebGPU on computers, WASM on phones)</option>
            <option value="webgpu">WebGPU</option>
            <option value="wasm">WASM (CPU)</option>
          </select>
        </div>
        <label className="toggle small">
          <input type="checkbox" checked={settings.phonemeModel === 'off'} onChange={(e) => void updateSettings({ phonemeModel: e.target.checked ? 'off' : 'full' })} />
          Low-memory mode (skip Stream B ~{MODELS.phoneme.approxMB} MB; no phoneme-level diff)
        </label>
        <div className="notice">Device/mode changes apply on the next reload of the engine. If the app keeps closing on your phone, schwa switches to WASM and then to low-memory mode by itself.</div>

        <h3>Reference voice (RP)</h3>
        <label className="toggle small">
          <input type="radio" name="rpv" checked={settings.rpVoice === 'neural'} onChange={() => void updateSettings({ rpVoice: 'neural' })} />
          Neural RP voice on device (Kokoro-82M, ~{KOKORO_APPROX_MB} MB once) — needed for Listen &amp; repeat scoring
        </label>
        <label className="toggle small">
          <input type="radio" name="rpv" checked={settings.rpVoice === 'system'} onChange={() => void updateSettings({ rpVoice: 'system' })} />
          System voice (no download; quality depends on the device)
        </label>
        {settings.rpVoice === 'neural' ? (
          <>
            <div className="field">
              <label className="small" htmlFor="kv">Voice</label>
              <select id="kv" value={settings.kokoroVoice} onChange={(e) => void updateSettings({ kokoroVoice: e.target.value as typeof settings.kokoroVoice })}>
                {BRITISH_VOICES.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
            </div>
            <div className="model-row">
              <div>
                <div className="small" style={{ fontWeight: 600 }}>Kokoro-82M en-GB</div>
                <div className="tiny muted mono">onnx-community/Kokoro-82M-v1.0-ONNX · q8</div>
                {voiceState === 'loading' && rpVoice.progress.total > 0 && <div className="progress"><span style={{ width: `${Math.min(100, (rpVoice.progress.loaded / rpVoice.progress.total) * 100)}%` }} /></div>}
              </div>
              <div className="small" style={{ textAlign: 'right' }}>
                {voiceState === 'ready' ? <span style={{ color: 'var(--emerald-ink)' }}>● loaded</span> : voiceState === 'loading' ? 'loading…' : voiceState === 'error' ? <span style={{ color: 'var(--crimson-ink)' }}>error</span> : <span className="muted">not loaded</span>}
              </div>
            </div>
            <div className="row section">
              <button className="btn ghost" disabled={voiceState === 'loading'} onClick={() => void run(async () => { await rpVoice.load(); return 'RP voice ready (cached for offline use)'; })}>Download &amp; load</button>
              <button className="btn ghost" disabled={voiceState !== 'ready'} onClick={() => { rpVoice.unload(); setVoiceState(rpVoice.state); }}>Unload (free memory)</button>
            </div>
            <div className="notice">Renders are cached on this device, so sentences you have heard replay instantly and offline. On older iPhones, unload the voice if the speech engine gets terminated.</div>
          </>
        ) : (
          <>
            <div className="field">
              <select value={settings.ttsVoice} onChange={(e) => void updateSettings({ ttsVoice: e.target.value })}>
                <option value="">Auto (best en-GB voice)</option>
                {voices.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
              </select>
            </div>
            {voices.length === 0 && <div className="notice">No en-GB voice found. On iOS/macOS add one in Settings → Accessibility → Spoken Content → Voices → English (UK).</div>}
          </>
        )}
        <button className="btn ghost section" disabled={busy} onClick={() => void run(async () => { await speak('The crux of the issue is the bottleneck in code review, so let\'s ask for a bit more time.', { voice: settings.ttsVoice }); })}>Test voice</button>

        <h3>GitHub private-repo sync</h3>
        <p className="tiny muted">Create a private repo (e.g. <span className="mono">schwa-data</span>) and a fine-grained PAT scoped to <b>only that repo</b> with <b>Contents: Read and write</b>. The token is stored only in this browser's IndexedDB.</p>
        <div className="field"><label className="small" htmlFor="gho">Repo owner</label><input id="gho" autoComplete="off" value={settings.ghOwner} onChange={(e) => void updateSettings({ ghOwner: e.target.value })} /></div>
        <div className="field"><label className="small" htmlFor="ghr">Private repo name</label><input id="ghr" autoComplete="off" value={settings.ghRepo} onChange={(e) => void updateSettings({ ghRepo: e.target.value })} /></div>
        <div className="field">
          <label className="small" htmlFor="ght">Fine-grained PAT</label>
          <div className="row">
            <input id="ght" style={{ flex: 1 }} type={showToken ? 'text' : 'password'} autoComplete="off" value={settings.ghToken} onChange={(e) => void updateSettings({ ghToken: e.target.value })} placeholder="github_pat_…" />
            <button className="btn ghost" onClick={() => setShowToken((s) => !s)}>{showToken ? 'Hide' : 'Show'}</button>
          </div>
        </div>
        <div className="field"><label className="small" htmlFor="ghp">File path</label><input id="ghp" value={settings.ghPath} onChange={(e) => void updateSettings({ ghPath: e.target.value })} /></div>
        <label className="toggle small"><input type="checkbox" checked={settings.autoSync} onChange={(e) => void updateSettings({ autoSync: e.target.checked })} /> Auto-sync after each turn and when connectivity returns</label>
        <div className="row section">
          <button className="btn" disabled={busy} onClick={() => void run(async () => { const t = await verifyAndPush(); await refresh(); return t; })}>Verify & push now</button>
          <button className="btn ghost" disabled={busy} onClick={() => void run(async () => { await syncNow(); await refresh(); })}>Sync</button>
        </div>
        {sync && sync.state !== 'off' && <div className={`notice ${sync.state === 'error' ? 'err' : ''}`}>Status: {sync.state}{sync.lastSyncAt ? ` · last ${new Date(sync.lastSyncAt).toLocaleString('en-GB')}` : ''}{sync.error ? ` · ${sync.error}` : ''}</div>}

        <h3>Backup</h3>
        <div className="row">
          <button className="btn ghost" onClick={() => void download()}>Export JSON</button>
          <button className="btn ghost" onClick={() => fileRef.current?.click()}>Import JSON (merge)</button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void run(async () => { await importBackup(await f.text(), 'merge'); await refresh(); return 'Backup merged'; });
            e.target.value = '';
          }} />
        </div>

        <h3>Optional: Gemini AI Studio key</h3>
        <div className="notice">100% optional. Enhances Tier 3 open-ended rewrites when online. Everything works without it. Only the transcript text of a Tier 3 turn is sent — never audio.</div>
        <div className="field"><label className="small" htmlFor="gem">AI Studio API key</label><input id="gem" type="password" autoComplete="off" value={settings.geminiKey} onChange={(e) => void updateSettings({ geminiKey: e.target.value })} placeholder="AIza…" /></div>
        <label className="toggle small"><input type="checkbox" checked={settings.geminiEnabled} onChange={(e) => void updateSettings({ geminiEnabled: e.target.checked })} /> Use Gemini 2.5 Flash enhancer when online</label>
        <button className="btn ghost section" disabled={busy || !settings.geminiKey} onClick={() => void run(async () => ((await testGeminiKey(settings.geminiKey)) ? 'Key works' : Promise.reject(new Error('Key rejected or offline'))))}>Test key</button>

        {msg && <div className={`notice ${msg.kind}`}>{msg.text}</div>}

        <h3>Danger zone</h3>
        <button className="btn danger" onClick={() => { if (confirm('Erase all local progress on this device? (Your GitHub copy is not touched.)')) void resetAll().then(refresh); }}>Reset local progress</button>
        <p className="tiny muted section">schwa v{__APP_VERSION__} · MIT · runs entirely on-device.</p>
      </aside>
    </>
  );
}
