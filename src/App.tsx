import { useEffect, useState } from 'react';
import { useApp } from './store';
import PracticeArena from './components/PracticeArena';
import Dashboard from './components/Dashboard';
import SettingsVault from './components/SettingsVault';
import VocabRegisterCard from './components/VocabRegisterCard';
import { ChartIcon, GearIcon, HeadphonesIcon, BackIcon, BookIcon } from './components/Icons';
import LexiconView from './components/LexiconView';
import { onSyncStatus, type SyncStatus } from './services/syncManager';
import { configureVoice } from './services/tts';
import type { Tier } from './types';

export type TierMode = 'auto' | 'sounds' | Tier | 'shadow' | 'words';

function ago(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function SyncPill({ onClick }: { onClick: () => void }) {
  const [st, setSt] = useState<SyncStatus>({ state: 'off', lastSyncAt: null, error: null });
  const [, tick] = useState(0);
  useEffect(() => onSyncStatus(setSt), []);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);
  const map: Record<SyncStatus['state'], [string, string]> = {
    off: ['', 'Local only'],
    idle: ['ok', `Synced ${ago(st.lastSyncAt)}`],
    syncing: ['warn', 'Syncing…'],
    pending: ['warn', 'Sync queued'],
    offline: ['warn', 'Offline · queued'],
    error: ['err', 'Sync error'],
  };
  const [cls, text] = map[st.state];
  return (
    <button className="chip" onClick={onClick} title={st.error ?? 'GitHub sync status'}>
      <span className={`dot ${cls}`} /> {text}
    </button>
  );
}

export default function App() {
  const { settings, updateSettings, vocabOpen, openVocab } = useApp();
  const [view, setView] = useState<'arena' | 'dashboard' | 'lexicon'>('arena');
  const [focusCard, setFocusCard] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tierMode, setTierMode] = useState<TierMode>('auto');
  const [focusPhoneme, setFocusPhoneme] = useState<string | null>(null);

  const cycleTier = () => setTierMode((t) => (t === 'auto' ? 'sounds' : t === 'sounds' ? 1 : t === 1 ? 2 : t === 2 ? 3 : t === 3 ? 'shadow' : t === 'shadow' ? 'words' : 'auto'));
  const practise = (id: string) => { setFocusCard(id); setTierMode('words'); setView('arena'); openVocab(null); };

  // Route speak() to the neural RP voice or the system synthesiser.
  useEffect(() => { configureVoice({ mode: settings.rpVoice, kokoroVoice: settings.kokoroVoice }); }, [settings.rpVoice, settings.kokoroVoice]);

  return (
    <div className="app">
      <header className="topbar">
        {view !== 'arena' ? (
          <button className="iconbtn" onClick={() => setView('arena')} aria-label="Back to practice"><BackIcon /></button>
        ) : null}
        <div className="brand"><span className="glyph">ə</span><span className="name">schwa</span></div>
        <button className="chip tier" onClick={cycleTier} title="Mode: tap to cycle Auto → Sounds → Tier 1 → 2 → 3 → Listen & repeat → Words">
          {tierMode === 'auto' ? 'Auto' : tierMode === 'sounds' ? 'Sounds' : tierMode === 'shadow' ? 'Repeat' : tierMode === 'words' ? 'Words' : `Tier ${tierMode}`}
        </button>
        <span className="spacer" />
        <button
          className="iconbtn"
          aria-pressed={settings.handsFree}
          onClick={() => void updateSettings({ handsFree: !settings.handsFree })}
          title="Hands-free Commute Mode (voice activity detection)"
          aria-label="Toggle hands-free commute mode"
        >
          <HeadphonesIcon />
        </button>
        <SyncPill onClick={() => setSettingsOpen(true)} />
        <button className="iconbtn" aria-pressed={view === 'lexicon'} onClick={() => setView(view === 'lexicon' ? 'arena' : 'lexicon')} aria-label="Lexicon" title="Lexicon"><BookIcon /></button>
        <button className="iconbtn" aria-pressed={view === 'dashboard'} onClick={() => setView(view === 'dashboard' ? 'arena' : 'dashboard')} aria-label="Progress dashboard"><ChartIcon /></button>
        <button className="iconbtn" onClick={() => setSettingsOpen(true)} aria-label="Settings"><GearIcon /></button>
      </header>

      {view === 'arena' ? (
        <PracticeArena tierMode={tierMode} focusPhoneme={focusPhoneme} clearFocus={() => setFocusPhoneme(null)} openSettings={() => setSettingsOpen(true)}
          focusCard={focusCard} clearFocusCard={() => setFocusCard(null)} />
      ) : view === 'lexicon' ? (
        <LexiconView />
      ) : (
        <Dashboard onDrill={(p) => { setFocusPhoneme(p); setTierMode('sounds'); setView('arena'); }} />
      )}

      {settingsOpen && <SettingsVault onClose={() => setSettingsOpen(false)} />}
      {vocabOpen && <VocabRegisterCard id={vocabOpen} onClose={() => openVocab(null)} onPractise={practise} />}
    </div>
  );
}
