import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { loadCategory, loadLexiconIndex, searchLexicon, type SearchHit } from '../services/lexicon';
import type { LexiconIndex, VocabEntry } from '../types';

/** Searchable lexicon: core cards, curated British cards by category, and the 20,000-word layer. */
export default function LexiconView() {
  const { openVocab, vocabById, data, lexiconVersion } = useApp();
  const [index, setIndex] = useState<LexiconIndex | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [cat, setCat] = useState<string>('core');
  const [cards, setCards] = useState<VocabEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { void loadLexiconIndex().then(setIndex).catch((e) => setErr(String(e))); }, []);
  useEffect(() => {
    let live = true;
    if (!q.trim()) { setHits([]); return; }
    const t = setTimeout(() => { void searchLexicon(q).then((h) => { if (live) setHits(h); }).catch(() => undefined); }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  useEffect(() => {
    if (cat === 'core') { setCards(data.vocab); return; }
    void loadCategory(cat).then(setCards).catch((e) => setErr(String(e)));
  }, [cat, data.vocab]);

  const groupName = useMemo(() => {
    const m = new Map<string, string>([['core', 'Core register card']]);
    index?.categories.forEach((c) => m.set(c.id, c.name));
    return (g: string) => m.get(g) ?? (g.startsWith('w') ? `Word · top ${Number(g.slice(1)) * 1000}` : g);
  }, [index]);

  return (
    <main>
      <section className="section card">
        <div className="row">
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Lexicon</h2>
          <span className="spacer" />
          {index && <span className="small muted">{(data.vocab.length + index.curated).toLocaleString('en-GB')} curated cards · {index.words.toLocaleString('en-GB')} words</span>}
        </div>
        <input className="searchbox section" placeholder="Search any word or phrase — e.g. chips, queue, Leicester, sticky wicket" value={q} onChange={(e) => setQ(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        {err && <div className="notice err">Lexicon unavailable offline until first loaded online. ({err})</div>}
        {q.trim() ? (
          <div className="lexlist">
            {hits.length === 0 && <div className="small muted">No matches yet.</div>}
            {hits.map((h) => {
              const e = vocabById.get(h.id);
              return (
                <button key={h.id} className="lexitem" onClick={() => openVocab(h.id)}>
                  <div className="h">{h.headword}</div>
                  <div className="g">{e?.gloss ?? groupName(h.group)}</div>
                </button>
              );
            })}
          </div>
        ) : (
          <>
            <div className="cats">
              <button className="chip" aria-pressed={cat === 'core'} onClick={() => setCat('core')}>Core register ({data.vocab.length})</button>
              {index?.categories.map((c) => (
                <button key={c.id} className="chip" aria-pressed={cat === c.id} onClick={() => setCat(c.id)}>{c.name} ({c.count})</button>
              ))}
            </div>
            <div className="lexlist" data-v={lexiconVersion}>
              {cards.map((e) => (
                <button key={e.id} className="lexitem" onClick={() => openVocab(e.id)}>
                  <div className="h"><span className={`badge ${e.register_badge}`} style={{ display: 'inline-block', marginRight: 6 }} />{e.headword}</div>
                  <div className="g">{e.us_equivalent ? `US: ${e.us_equivalent} · ` : ''}{e.gloss ?? e.usage_context}</div>
                </button>
              ))}
            </div>
          </>
        )}
      </section>
      {index && <p className="tiny muted section">Sources: {index.licences.map((l) => `${l.name}${l.license ? ` (${l.license})` : ''}`).join(' · ')}</p>}
    </main>
  );
}
