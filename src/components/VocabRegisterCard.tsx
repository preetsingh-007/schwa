import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { speak } from '../services/tts';
import { recallProbability } from '../services/fsrs';
import { ensureEntry } from '../services/lexicon';
import { CloseIcon, SpeakerIcon } from './Icons';

const BADGE_NAME = {
  GREEN_EXECUTIVE_SAFE: '🟢 Executive / Boardroom Safe',
  AMBER_COLLEAGUE: '🟡 Colleague / Idiomatic Workplace',
  RED_COLLOQUIAL: '🔴 Colloquial / Social Only',
};

/** Scientific Vocabulary Context Card — core cards, curated lexicon cards and automatic word cards. */
export default function VocabRegisterCard({ id, onClose, onPractise }: { id: string; onClose: () => void; onPractise?: (id: string) => void }) {
  const { vocabById, vocabCards, settings } = useApp();
  const [loading, setLoading] = useState(false);
  const [imgOk, setImgOk] = useState(true);
  const v = vocabById.get(id);

  useEffect(() => {
    if (v) return;
    setLoading(true);
    void ensureEntry(id).finally(() => setLoading(false));
  }, [id, v]);

  if (!v) {
    return (
      <>
        <div className="scrim" onClick={onClose} />
        <aside className="drawer vocabcard" role="dialog" aria-label="Vocabulary card">
          <div className="row"><span className="spacer" /><button className="iconbtn" onClick={onClose} aria-label="Close"><CloseIcon /></button></div>
          <p className="muted">{loading ? 'Loading card…' : 'Card not available offline yet.'}</p>
        </aside>
      </>
    );
  }

  const card = vocabCards.get(id);
  const recall = recallProbability(card, Date.now());
  // Pre-rendered RP audio ships with the app (works in low-memory mode); otherwise render on device.
  const playClip = (uri: string | null | undefined, text: string, rate = 1) => {
    if (uri) void new Audio(`${import.meta.env.BASE_URL}${uri.replace(/^\//, '')}`).play().catch(() => speak(text, { voice: settings.ttsVoice, rate }));
    else void speak(text, { voice: settings.ttsVoice, rate });
  };
  const play = () => playClip(v.audio_uri, v.headword, 0.85);
  const imgQuery = encodeURIComponent(`${v.headword} ${v.category?.startsWith('uk_') || v.us_equivalent ? 'UK' : ''}`.trim());
  const auto = v.source === 'auto';

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer vocabcard" role="dialog" aria-label={`Vocabulary card: ${v.headword}`}>
        <div className="row">
          <span className="label">{auto ? `Word · ${v.pos || 'core English'}` : BADGE_NAME[v.register_badge]}</span>
          <span className="spacer" />
          <button className="iconbtn" onClick={onClose} aria-label="Close"><CloseIcon /></button>
        </div>
        <h2>{v.headword}</h2>
        <div className="row">
          <span className="ipa" style={{ fontSize: '1.25rem' }}>{v.ipa_rp}</span>
          {v.syllable_stress && <span className="mono muted">{v.syllable_stress}</span>}
          <button className="btn ghost" onClick={play}><SpeakerIcon /> RP</button>
          {onPractise && <button className="btn" onClick={() => onPractise(v.id)}>Practise this</button>}
        </div>
        <div className="small muted">{v.register_label}</div>

        {v.img && imgOk && (
          <figure className="cardimg">
            <img src={v.img} alt={v.wiki ?? v.headword} loading="lazy" referrerPolicy="no-referrer" onError={() => setImgOk(false)} />
            <figcaption className="tiny muted">Image: <a href={`https://en.wikipedia.org/wiki/${encodeURIComponent((v.wiki ?? v.headword).replace(/ /g, '_'))}`} target="_blank" rel="noreferrer">Wikipedia — {v.wiki}</a></figcaption>
          </figure>
        )}

        {v.gloss && <p style={{ fontSize: '1.02rem', marginTop: 12 }}>{v.gloss}</p>}
        {v.us_equivalent && <div className="notice"><b>American:</b> {v.us_equivalent}</div>}
        {v.pitfall && <div className="notice err">{v.pitfall}</div>}

        {v.phonetic_trap && (<><h3>Phonetic trap</h3><p className="small">{v.phonetic_trap}</p></>)}
        {v.usage_context && (<><h3>Usage</h3><p className="small">{v.usage_context}</p></>)}
        {v.pragmatic_note && (<><h3>Pragmatics</h3><p className="small">{v.pragmatic_note}</p></>)}
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
        {v.examples_rp.length > 0 && <h3>Say it aloud</h3>}
        {v.examples_rp.map((ex) => (
          <div key={ex.text} className="alt" style={{ marginBottom: 8 }}>
            <div className="row">
              <span>{ex.text}</span>
              <span className="spacer" />
              <button className="iconbtn" onClick={() => playClip(ex.audio_uri, ex.text)} aria-label="Hear example"><SpeakerIcon /></button>
            </div>
            {ex.ipa_connected && <div className="ipa muted small">{ex.ipa_connected}</div>}
          </div>
        ))}
        {v.exampleSource && <div className="tiny muted">Example: <a href={v.exampleSource.url} target="_blank" rel="noreferrer">{v.exampleSource.name}</a> · {v.exampleSource.license}</div>}

        <div className="row section small">
          <a href={`https://www.google.com/search?tbm=isch&q=${imgQuery}`} target="_blank" rel="noreferrer">Images ↗</a>
          {v.wiki && <a href={`https://en.wikipedia.org/wiki/${encodeURIComponent(v.wiki.replace(/ /g, '_'))}`} target="_blank" rel="noreferrer">Wikipedia ↗</a>}
          <a href={`https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(v.headword.toLowerCase().replace(/ /g, '-'))}`} target="_blank" rel="noreferrer">Cambridge Dictionary ↗</a>
        </div>

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
