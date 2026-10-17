import { useMemo, useState } from 'react';
import type { TurnResult } from '../services/evaluate';
import type { AlignedPair, WordAlignment } from '../services/ipaAligner';
import { lexicalDiff } from '../services/redundancy';
import { PASS_THRESHOLD } from '../services/reward';
import { TIPS } from '../lib/tips';
import { useApp } from '../store';
import { playPcm } from '../services/audio';
import { speak } from '../services/tts';
import { CloseIcon, SpeakerIcon } from './Icons';

function Sub({ name, v, w }: { name: string; v: number | null; w: number }) {
  return (
    <div className="subscore">
      <div className="label">{name} · w{w.toFixed(2)}</div>
      <div className="v">{v === null ? '—' : Math.round(v)}</div>
      <div className="meter"><span style={{ width: `${v ?? 0}%` }} /></div>
    </div>
  );
}

export default function ResultView({ r }: { r: TurnResult }) {
  const [w1, w2, w3] = r.reward.weights;
  const passed = r.reward.passed;
  return (
    <>
      <section className="section card">
        <div className="scorebar">
          <div className="hero-col">
            <div className="label">Reward R(u)</div>
            <div className={`score-hero ${passed ? 'pass' : 'fail'}`}>{Math.round(r.reward.reward)}</div>
          </div>
          <Sub name="Phonetic" v={r.reward.phonetic} w={w1} />
          <Sub name="Prosody" v={r.reward.prosody} w={w2} />
          <Sub name="Lexical" v={r.tier === 1 ? null : r.reward.lexical} w={w3} />
        </div>
        <div className={`verdict ${passed ? 'pass' : 'fail'}`}>
          {passed ? '✓ Passed — motor pattern locked in' : `✗ Not yet — need ≥ ${PASS_THRESHOLD} and no critical redundancy`}
        </div>
        {!passed && <ul className="blockers">{r.reward.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
      </section>
      <LexicalBlock r={r} />
      <AlignmentTape r={r} />
      <ProsodyStrip r={r} />
    </>
  );
}

// ---------------- Block A: conciseness & lexical diff ----------------

function LexicalBlock({ r }: { r: TurnResult }) {
  const { vocabById, openVocab } = useApp();
  const segs = useMemo(() => (r.concise ? lexicalDiff(r.transcript, r.concise.hits) : null), [r]);
  return (
    <section className="section card">
      <div className="label">Block A · {r.tier === 1 ? 'What was heard' : 'Conciseness & lexical diff'}</div>
      <p className="diffline">
        {!r.transcript && <span className="muted">(no words recognised)</span>}
        {segs
          ? segs.map((s, i) =>
            s.kind === 'keep' ? <span key={i}>{s.text}</span>
              : s.kind === 'cut' ? <span key={i} className={`cut ${s.rule?.severity === 'minor' ? 'minor' : ''}`} title={s.rule?.note}>{s.text}</span>
                : <span key={i} className="add">{s.text}</span>)
          : r.transcript}
      </p>
      {r.concise && (
        <div className="row small muted">
          <span>{r.concise.wordCount} words</span>
          <span>· lexical density {(r.concise.lexicalDensity * 100).toFixed(0)}%</span>
          <span>· conciseness {(r.concise.score * 100).toFixed(0)}</span>
          {r.concise.critical > 0 && <span style={{ color: 'var(--crimson-ink)' }}>· {r.concise.critical} critical</span>}
          {r.semantic !== null && <span>· {r.tier === 2 ? 'meaning match' : 'on-topic'} {Math.max(0, r.semantic * 100).toFixed(0)}%</span>}
        </div>
      )}
      {r.wordCoverage !== null && r.wordCoverage < 1 && (
        <div className="small muted">Heard {(r.wordCoverage * 100).toFixed(0)}% of the prompt's words.</div>
      )}
      {r.prompt.targetVocab.length > 0 && r.tier !== 1 && (
        <div className="pills">
          {r.prompt.targetVocab.map((id) => {
            const v = vocabById.get(id);
            if (!v) return null;
            const ok = r.usedVocab.includes(id);
            const hes = r.hesitatedVocab.includes(id);
            return (
              <button key={id} className={`pill ${ok ? 'used' : ''}`} onClick={() => openVocab(id)}>
                <span className={`badge ${v.register_badge}`} />{ok ? '✓' : '✗'} {v.headword}{hes ? ' · hesitated' : ''}
              </button>
            );
          })}
        </div>
      )}
      <div className="retry">
        <div className="label">{r.reward.passed ? 'Model version' : r.prompt.mode === 'shadow' ? 'Listen again, then repeat' : '1-line compressed target — say this aloud'}</div>
        <div className="say">{r.retryTarget || '—'}</div>
      </div>
      {r.gemini && (
        <div className="alts">
          <div className="label">Gemini enhancer (optional)</div>
          <div className="alt"><span className="badge GREEN_EXECUTIVE_SAFE" style={{ display: 'inline-block', marginRight: 6 }} /><b>Executive concise:</b> {r.gemini.executive}</div>
          <div className="alt"><span className="badge AMBER_COLLEAGUE" style={{ display: 'inline-block', marginRight: 6 }} /><b>Natural colleague:</b> {r.gemini.colleague}</div>
          <div className="alt"><b>Idiomatic:</b> {r.gemini.idiomatic}</div>
          {r.gemini.pragmatics && <div className="small muted">{r.gemini.pragmatics}</div>}
          {r.gemini.followUp && <div className="alt"><b>Socratic follow-up (answer aloud):</b> {r.gemini.followUp}</div>}
        </div>
      )}
    </section>
  );
}

// ---------------- Block B: dual-IPA alignment tape ----------------

function phoneLabel(p: AlignedPair, side: 't' | 'u'): string {
  if (side === 't') return p.target ? (p.target.stress === 2 ? 'ˈ' : p.target.stress === 1 ? 'ˌ' : '') + p.target.p : '';
  return p.produced ? p.produced.p : '∅';
}

function AlignmentTape({ r }: { r: TurnResult }) {
  const { data } = useApp();
  const [sel, setSel] = useState<{ pair: AlignedPair; word: WordAlignment } | null>(null);
  if (!r.alignment) {
    return (
      <section className="section card">
        <div className="label">Block B · Dual-IPA alignment</div>
        <div className="notice">Stream B (acoustic IPA model) is off — enable it in Settings for phoneme-level feedback.</div>
        <p className="ipa">/{r.target.map((w) => w.ipa).join(' ')}/</p>
      </section>
    );
  }
  const a = r.alignment;
  if (r.tier === 1 && (r.wordCoverage ?? 1) < 0.5) {
    return (
      <section className="section card">
        <div className="label">Block B · Dual-IPA alignment</div>
        <div className="notice err">What you said doesn't match the prompt, so phoneme feedback is skipped (and your phoneme map is not updated). Read the prompt text aloud.</div>
      </section>
    );
  }
  return (
    <section className="section card">
      <div className="row">
        <div className="label">Block B · Target RP IPA (top) vs your produced IPA (bottom)</div>
        <span className="spacer" />
        <span className="small muted mono">PER {(a.per * 100).toFixed(0)}% · weighted {(a.weightedPer * 100).toFixed(0)}%</span>
      </div>
      <div className="tape section">
        {a.words.map((w) => (
          <div key={w.index} className={`wcard ${w.status}`}>
            <div className="w">{w.text}</div>
            <div className="t">{w.pairs.filter((p) => p.target).map((p, i) => (
              <button key={i} className={`ph ${p.kind}${p.calibrated ? ' cal' : ''}`} onClick={() => setSel({ pair: p, word: w })}>{phoneLabel(p, 't')}</button>
            ))}</div>
            <div className="u">{w.pairs.map((p, i) => (
              <button key={i} className={`ph ${p.produced ? p.kind : 'gap'}${p.calibrated ? ' cal' : ''}`} onClick={() => setSel({ pair: p, word: w })}>{phoneLabel(p, 'u')}</button>
            ))}</div>
          </div>
        ))}
      </div>
      <div className="legend">
        <span><i style={{ background: 'var(--emerald)' }} />exact RP match</span>
        <span><i style={{ background: 'var(--amber)' }} />allophonic drift / missed schwa</span>
        <span><i style={{ background: 'var(--crimson)' }} />phoneme substitution / rhotic / retroflex</span>
        <span><u style={{ textDecorationStyle: 'dotted' }}>dotted</u> = model-equivalent (RP reference speech reads the same)</span>
        <span>tap any phoneme for articulatory mechanics</span>
      </div>
      {a.rhoticity.length > 0 && (
        <div className="row section small">
          <span className="label">Non-rhotic check (F3):</span>
          {a.rhoticity.map((m, i) => {
            const thr = data.calibration?.rhotic?.threshold ?? 0.8;
            const ok = m.ratio >= thr;
            return (
              <span key={i} className="chip" title={`F3 at the end of the vowel is ${(m.ratio * 100).toFixed(0)}% of your baseline; below ${(thr * 100).toFixed(0)}% means an /r/ was pronounced`}>
                {r.target[m.word]?.text} {ok ? '✓ no /r/' : '✗ /r/ heard'}
              </span>
            );
          })}
        </div>
      )}
      {r.topDiagnoses.length > 0 && (
        <div className="row section">
          {r.topDiagnoses.slice(0, 6).map((d) => (
            <span key={d.code} className="chip" title={TIPS[d.code].mechanics}>{TIPS[d.code].title} × {d.count}</span>
          ))}
        </div>
      )}
      {sel && <ArticulationCard pair={sel.pair} word={sel.word} audio={r.audio} onClose={() => setSel(null)} />}
    </section>
  );
}

function ArticulationCard({ pair, word, audio, onClose }: { pair: AlignedPair; word: WordAlignment; audio: Float32Array; onClose: () => void }) {
  const { data, settings } = useApp();
  const info = pair.target ? data.phonemes.find((p) => p.symbol === pair.target!.p) : undefined;
  const tip = pair.diagnosis ? TIPS[pair.diagnosis] : null;
  const interf = info?.interference?.find((x) => x.phone === pair.produced?.p);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="popover" role="dialog" aria-label="Articulatory mechanics">
        <div className="row">
          <h4>
            {pair.target ? <span className="ipa">/{pair.target.p}/</span> : 'Inserted'} → <span className="ipa">[{pair.produced?.p ?? '∅'}]</span>
            <span className="muted small"> in “{word.text}”</span>
          </h4>
          <span className="spacer" />
          <button className="iconbtn" onClick={onClose} aria-label="Close"><CloseIcon /></button>
        </div>
        {pair.kind === 'match' && !pair.calibrated && <div className="notice ok">Exact RP realisation{pair.produced?.p === 'ʔ' ? ' (licensed glottal stop)' : ''}.</div>}
        {pair.calibrated && <div className="notice">Counted as correct: British reference speech produces this same reading in the acoustic model, so it isn't evidence of an error.</div>}
        {tip && pair.kind !== 'match' && (
          <>
            <div style={{ fontWeight: 600, marginTop: 6 }}>{tip.title}</div>
            <p className="small" style={{ margin: '4px 0' }}>{interf?.fix ?? tip.mechanics}</p>
          </>
        )}
        {info && (
          <p className="small muted" style={{ margin: '6px 0' }}>
            <b className="ipa">/{info.symbol}/</b> {info.keyword} — {info.description} {info.mechanics}
          </p>
        )}
        <div className="row">
          <span className="ipa">RP: /{word.targetIpa}/</span>
          <span className="ipa muted">You: [{word.producedIpa || '∅'}]</span>
        </div>
        <div className="row section">
          <button className="btn ghost" onClick={() => void speak(word.text, { voice: settings.ttsVoice, rate: 0.8 })}><SpeakerIcon /> Hear RP</button>
          {word.start !== undefined && (
            <button className="btn ghost" onClick={() => void playPcm(audio, 16000, Math.max(0, word.start! - 0.05), (word.end ?? word.start!) + 0.08)}>
              <SpeakerIcon /> Hear yours
            </button>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------- Block C: prosody & schwa strip ----------------

function refRuns(pts: [number, number][]): [number, number][][] {
  const runs: [number, number][][] = [];
  let cur: [number, number][] = [];
  pts.forEach((c, i) => {
    if (i > 0 && (c[0] - pts[i - 1][0] > 0.08 || Math.abs(c[1] - pts[i - 1][1]) > 5)) { if (cur.length) runs.push(cur); cur = []; }
    cur.push(c);
  });
  if (cur.length) runs.push(cur);
  return runs;
}

function ProsodyStrip({ r }: { r: TurnResult }) {
  const p = r.prosody;
  const [hover, setHover] = useState<{ x: number; t: number; st: number } | null>(null);
  const W = 640, H = 140, padL = 34, padB = 18;
  const dur = Math.max(p.duration, 0.5);
  const userMed = (() => { const v = p.contour.map((c) => c[1]).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; })();
  // Reference contour, time-normalised onto your speech span and shifted to your median pitch.
  const refP = r.reference?.prosody;
  const refPts: [number, number][] = [];
  if (refP && refP.contour.length > 4) {
    const ra = refP.segments[0]?.start ?? 0, rb = refP.segments[refP.segments.length - 1]?.end ?? refP.duration;
    const ua = p.segments[0]?.start ?? 0, ub = p.segments[p.segments.length - 1]?.end ?? p.duration;
    const rv = refP.contour.map((c) => c[1]).sort((a, b) => a - b);
    const refMed = rv[Math.floor(rv.length / 2)];
    for (const [t, st] of refP.contour) refPts.push([ua + ((t - ra) / (rb - ra || 1)) * (ub - ua), st - refMed + userMed]);
  }
  const sts = [...p.contour.map((c) => c[1]), ...refPts.map((c) => c[1])];
  const lo = sts.length ? Math.min(...sts) - 2 : -2, hi = sts.length ? Math.max(...sts) + 2 : 14;
  const x = (t: number) => padL + (t / dur) * (W - padL - 6);
  const y = (st: number) => 6 + (1 - (st - lo) / (hi - lo || 1)) * (H - padB - 12);
  const med = sts.length ? [...sts].sort((a, b) => a - b)[Math.floor(sts.length / 2)] : 0;
  const first = p.segments[0]?.start ?? 0, last = p.segments[p.segments.length - 1]?.end ?? dur;
  // Stylised RP declarative envelope: gentle declination, then a high-fall on the nucleus.
  const env = `M${x(first)},${y(med + 3)} L${x(Math.max(first, last - 0.45))},${y(med + 1)} L${x(Math.max(first, last - 0.3))},${y(med + 3.5)} L${x(last)},${y(med - 4)}`;
  // Break the contour into voiced runs.
  const runs: [number, number][][] = [];
  let cur: [number, number][] = [];
  p.contour.forEach((c, i) => {
    // new run on unvoiced gaps or implausible jumps (> 5 st between neighbouring frames)
    if (i > 0 && (c[0] - p.contour[i - 1][0] > 0.06 || Math.abs(c[1] - p.contour[i - 1][1]) > 5)) { if (cur.length) runs.push(cur); cur = []; }
    cur.push(c);
  });
  if (cur.length) runs.push(cur);
  const missed = r.alignment?.schwa.missedWords.map((i) => r.target[i]?.text).filter(Boolean) ?? [];
  const pb = r.prosodyBreakdown;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const t = ((px - padL) / (W - padL - 6)) * dur;
    let best: [number, number] | null = null;
    for (const c of p.contour) if (!best || Math.abs(c[0] - t) < Math.abs(best[0] - t)) best = c;
    if (best && Math.abs(best[0] - t) < 0.15) setHover({ x: (x(best[0]) / W) * 100, t: best[0], st: best[1] }); else setHover(null);
  };

  return (
    <section className="section card">
      <div className="label">Block C · Prosody & schwa strip</div>
      <div style={{ position: 'relative' }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="chart" style={{ height: 160 }} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Pitch contour against the RP high-fall envelope">
          {p.longPauses.map((g, i) => (
            <rect key={i} x={x(g.start)} y={4} width={Math.max(2, x(g.end) - x(g.start))} height={H - padB - 8} fill="var(--amber)" opacity={0.16} />
          ))}
          <line x1={padL} x2={W - 6} y1={H - padB} y2={H - padB} stroke="var(--rule-strong)" />
          <text x={padL - 6} y={y(hi - 2)} fontSize="10" textAnchor="end" fill="var(--muted)">{Math.round(hi - 2)}</text>
          <text x={padL - 6} y={y(lo + 2)} fontSize="10" textAnchor="end" fill="var(--muted)">{Math.round(lo + 2)}</text>
          <text x={padL} y={H - 4} fontSize="10" fill="var(--muted)">0 s</text>
          <text x={W - 6} y={H - 4} fontSize="10" textAnchor="end" fill="var(--muted)">{dur.toFixed(1)} s</text>
          {refPts.length > 0
            ? refRuns(refPts).map((run, i) => (
              <path key={`r${i}`} d={run.map((c, k) => `${k ? 'L' : 'M'}${x(c[0])},${y(c[1])}`).join(' ')} fill="none" stroke="var(--emerald)" strokeWidth={2} strokeDasharray="5 4" opacity={0.9} />
            ))
            : <path d={env} fill="none" stroke="var(--emerald)" strokeWidth={2} strokeDasharray="5 4" opacity={0.8} />}
          {runs.map((run, i) => (
            <path key={i} d={run.map((c, k) => `${k ? 'L' : 'M'}${x(c[0])},${y(c[1])}`).join(' ')} fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {hover && <line x1={(hover.x / 100) * W} x2={(hover.x / 100) * W} y1={4} y2={H - padB} stroke="var(--muted)" strokeWidth={1} />}
        </svg>
        {hover && <div className="chart-tip" style={{ left: `${hover.x}%`, top: 8 }}>{hover.t.toFixed(2)} s · {hover.st.toFixed(1)} st</div>}
      </div>
      <div className="legend">
        <span><i style={{ background: 'var(--ink)' }} />your F0 (semitones re 100 Hz)</span>
        <span><i style={{ background: 'var(--emerald)' }} />{refPts.length ? 'RP reference voice (same sentence, time-aligned)' : 'RP declarative high-fall envelope'}</span>
        <span><i style={{ background: 'var(--amber)', opacity: 0.4 }} />pause &gt; 400 ms</span>
      </div>
      <div className="row section small">
        <span className="chip">nPVI {p.npvi.toFixed(0)} {p.syllables < 4 ? '' : p.npvi >= 55 ? '· stress-timed ✓' : p.npvi < 42 ? '· syllable-timed' : ''}</span>
        <span className="chip">{p.syllableRate.toFixed(1)} syll/s</span>
        <span className="chip">{p.longPauses.length} hesitation{p.longPauses.length === 1 ? '' : 's'}</span>
        <span className="chip">range {p.f0RangeSt.toFixed(1)} st</span>
        <span className="chip">final {p.finalSlopeSt < -2 ? 'fall ✓' : p.finalSlopeSt > 2 ? 'rise' : 'level'}</span>
        {pb.reference && (
          <>
            <span className="chip" title="Correlation of your pitch shape with the RP reference">melody match {pb.reference.shapeCorr === null ? '—' : `${Math.round(Math.max(0, pb.reference.shapeCorr) * 100)}%`}</span>
            <span className="chip" title="Your pitch range relative to the reference">range ×{pb.reference.rangeRatio.toFixed(2)}</span>
            <span className="chip" title="Your speaking time relative to the reference">tempo ×{pb.reference.tempoRatio.toFixed(2)}</span>
            <span className="chip">ref nPVI {pb.reference.npviRef.toFixed(0)}</span>
          </>
        )}
        {pb.schwa !== null && <span className="chip">schwa {(pb.schwa * 100).toFixed(0)}%</span>}
      </div>
      {missed.length > 0 && (
        <div className="small section">
          <span className="label">Not crushed to /ə/: </span>
          {missed.map((w, i) => <span key={i} className="cut minor" style={{ textDecoration: 'none', marginRight: 6 }}>{w}</span>)}
        </div>
      )}
    </section>
  );
}
