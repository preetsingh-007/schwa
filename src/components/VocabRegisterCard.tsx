import { useApp } from '../store';
import { speak } from '../services/tts';
import { recallProbability } from '../services/fsrs';
import { CloseIcon, SpeakerIcon } from './Icons';

const BADGE_NAME = {
  GREEN_EXECUTIVE_SAFE: '🟢 Executive / Boardroom Safe',
  AMBER_COLLEAGUE: '🟡 Colleague / Idiomatic Workplace',
  RED_COLLOQUIAL: '🔴 Colloquial / Social Only',
};

/** Scientific Vocabulary Context Card (register, pragmatics, phonetic trap, collocations). */
export default function VocabRegisterCard({ id, onClose }: { id: string; onClose: () => void }) {
  const { vocabById, vocabCards, settings } = useApp();
  const v = vocabById.get(id);
  if (!v) return null;
  const card = vocabCards.get(id);
  const recall = recallProbability(card, Date.now());
  const play = () => {
    if (v.audio_uri) void new Audio(`${import.meta.env.BASE_URL}${v.audio_uri.replace(/^\//, '')}`).play().catch(() => speak(v.headword, { voice: settings.ttsVoice, rate: 0.85 }));
    else void speak(v.headword, { voice: settings.ttsVoice, rate: 0.85 });
  };
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer vocabcard" role="dialog" aria-label={`Vocabulary card: ${v.headword}`}>
        <div className="row">
          <span className="label">{BADGE_NAME[v.register_badge]}</span>
          <span className="spacer" />
          <button className="iconbtn" onClick={onClose} aria-label="Close"><CloseIcon /></button>
        </div>
        <h2>{v.headword}</h2>
        <div className="row">
          <span className="ipa" style={{ fontSize: '1.25rem' }}>{v.ipa_rp}</span>
          <span className="mono muted">{v.syllable_stress}</span>
          <button className="btn ghost" onClick={play}><SpeakerIcon /> RP</button>
        </div>
        <div className="small muted">{v.register_label}</div>

        <h3>Phonetic trap</h3>
        <p className="small">{v.phonetic_trap}</p>
        <h3>Usage</h3>
        <p className="small">{v.usage_context}</p>
        <h3>Pragmatics</h3>
        <p className="small">{v.pragmatic_note}</p>
        {v.replaces_verbose.length > 0 && (
          <>
            <h3>Replaces</h3>
            <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
              {v.replaces_verbose.map((r) => <li key={r}><span className="cut minor" style={{ textDecorationColor: 'var(--crimson)' }}>{r}</span></li>)}
            </ul>
          </>
        )}
        {v.collocations.length > 0 && (
          <>
            <h3>Collocations</h3>
            <div className="pills">{v.collocations.map((c) => <span key={c} className="pill">{c}</span>)}</div>
          </>
        )}
        <h3>Say it aloud</h3>
        {v.examples_rp.map((ex) => (
          <div key={ex.text} className="alt" style={{ marginBottom: 8 }}>
            <div className="row">
              <span>{ex.text}</span>
              <span className="spacer" />
              <button className="iconbtn" onClick={() => void speak(ex.text, { voice: settings.ttsVoice })} aria-label="Hear example"><SpeakerIcon /></button>
            </div>
            {ex.ipa_connected && <div className="ipa muted small">{ex.ipa_connected}</div>}
          </div>
        ))}
        <h3>Memory (FSRS)</h3>
        <dl className="kv">
          <dt>Recall now</dt><dd>{card?.lastReview ? `${(recall * 100).toFixed(0)}%` : 'not yet practised'}</dd>
          <dt>Stability</dt><dd>{card ? `${card.stability.toFixed(1)} days` : '—'}</dd>
          <dt>Difficulty</dt><dd>{card ? card.difficulty.toFixed(1) : '—'}</dd>
          <dt>Retrieval τ</dt><dd>{card ? `${(card.tau * 100).toFixed(0)}% fluent in Tier 3` : '—'}</dd>
          <dt>Next due</dt><dd>{card?.lastReview ? new Date(card.due).toLocaleDateString('en-GB') : '—'}</dd>
        </dl>
      </aside>
    </>
  );
}
