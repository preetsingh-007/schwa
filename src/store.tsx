import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CuratedData, LearnerState, PromptStat, Settings, VocabCard, VocabEntry } from './types';
import { db, getLearner, getSettings, saveSettings } from './services/db';
import { engine } from './services/engine';
import { setAcousticCalibration, type AcousticCalibration } from './services/ipaAligner';
import type { ModelKey } from './workers/protocol';
import { getEntry, loadAllCurated, onLexiconChange } from './services/lexicon';
import { loadPromptPacks } from './services/promptPacks';

export async function loadCuratedData(): Promise<CuratedData> {
  const base = import.meta.env.BASE_URL;
  const get = async <T,>(f: string): Promise<T> => {
    const r = await fetch(`${base}data/${f}`);
    if (!r.ok) throw new Error(`Failed to load ${f}`);
    return (await r.json()) as T;
  };
  const [phonemes, vocab, rules, prompts, calibration] = await Promise.all([
    get<CuratedData['phonemes']>('rp_phonemes_44.json'),
    get<CuratedData['vocab']>('vocab_curriculum.json'),
    get<CuratedData['rules']>('redundancy_rules.json'),
    get<CuratedData['prompts']>('prompts_tiered.json'),
    get<AcousticCalibration>('acoustic_calibration.json').catch(() => null),
  ]);
  // Model-bias corrections measured on British reference speech (see scripts/calibrate-acoustic.ts).
  setAcousticCalibration(calibration);
  return { phonemes, vocab, rules, prompts, calibration };
}

export type EngineState = 'idle' | 'loading' | 'ready' | 'error';

interface AppState {
  data: CuratedData;
  settings: Settings;
  learner: LearnerState;
  vocabCards: Map<string, VocabCard>;
  promptStats: Map<string, PromptStat>;
  /** core curriculum + every lexicon card loaded so far */
  vocabById: { get(id: string): VocabEntry | undefined };
  /** bumps whenever lexicon cards finish loading */
  lexiconVersion: number;
  /** curated core prompts + the background-loaded Tier 2/3 packs */
  allPrompts: CuratedData['prompts'];
  engineState: EngineState;
  engineError: string | null;
  engineModels: Record<ModelKey, boolean>;
  updateSettings: (p: Partial<Settings>) => Promise<void>;
  refresh: () => Promise<void>;
  startEngine: () => Promise<void>;
  openVocab: (id: string | null) => void;
  vocabOpen: string | null;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}

export function AppProvider({ data, initialSettings, initialLearner, children }: { data: CuratedData; initialSettings: Settings; initialLearner: LearnerState; children: ReactNode }) {
  const [settings, setSettings] = useState(initialSettings);
  const [learner, setLearner] = useState(initialLearner);
  const [vocabCards, setVocabCards] = useState(new Map<string, VocabCard>());
  const [promptStats, setPromptStats] = useState(new Map<string, PromptStat>());
  const [engineState, setEngineState] = useState<EngineState>('idle');
  const [engineError, setEngineError] = useState<string | null>(null);
  const [engineModels, setEngineModels] = useState(engine.ready);
  const [vocabOpen, openVocab] = useState<string | null>(null);

  const [lexiconVersion, setLexiconVersion] = useState(0);
  useEffect(() => onLexiconChange(() => setLexiconVersion((v) => v + 1)), []);
  // Curated lexicon (~3,000 cards) loads in the background so it never delays start-up.
  useEffect(() => {
    const t = setTimeout(() => {
      void loadAllCurated().catch(() => undefined).then(() => loadPromptPacks()).then((ps) => { if (ps.length) setExtraPrompts(ps); });
    }, 1500);
    return () => clearTimeout(t);
  }, []);
  const [extraPrompts, setExtraPrompts] = useState<CuratedData['prompts']>([]);
  const allPrompts = useMemo(() => (extraPrompts.length ? [...data.prompts, ...extraPrompts] : data.prompts), [data.prompts, extraPrompts]);
  const vocabById = useMemo(() => {
    const core = new Map(data.vocab.map((v) => [v.id, v]));
    return { get: (id: string) => core.get(id) ?? getEntry(id) };
  // lexiconVersion: recreate so consumers re-render when cards arrive
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.vocab, lexiconVersion]);

  const refresh = useCallback(async () => {
    const [l, s, cards, stats] = await Promise.all([getLearner(), getSettings(), db.vocab.toArray(), db.promptStats.toArray()]);
    setLearner(l);
    setSettings(s);
    setVocabCards(new Map(cards.map((c) => [c.id, c])));
    setPromptStats(new Map(stats.map((c) => [c.id, c])));
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => engine.onReady(() => {
    setEngineModels({ ...engine.ready });
    if (!engine.ready.asr) setEngineState((s) => (s === 'ready' ? 'idle' : s));
  }), []);

  const updateSettings = useCallback(async (p: Partial<Settings>) => {
    setSettings(await saveSettings(p));
  }, []);

  const startEngine = useCallback(async () => {
    setEngineState('loading');
    setEngineError(null);
    try {
      const s = await getSettings();
      await engine.init({ device: s.device, phonemeModel: s.phonemeModel, embeddings: true });
      setEngineModels({ ...engine.ready });
      setEngineState('ready');
    } catch (e) {
      setEngineError(e instanceof Error ? e.message : String(e));
      setEngineState('error');
    }
  }, []);

  const value: AppState = {
    data, settings, learner, vocabCards, promptStats, vocabById, lexiconVersion, allPrompts, engineState, engineError, engineModels,
    updateSettings, refresh, startEngine, openVocab, vocabOpen,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
