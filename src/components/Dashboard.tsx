import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { db } from '../services/db';
import PhonemeHeatmap from './PhonemeHeatmap';
import { TIPS } from '../lib/tips';
import { recallProbability } from '../services/fsrs';
import type { SessionLog } from '../types';
import type { Diagnosis } from '../services/ipaAligner';

interface Point { t: number; v: number }

/** One-series line chart with crosshair + tooltip (small multiples, never dual-axis). */
function LineChart({ title, points, fmt, domain }: { title: string; points: Point[]; fmt: (v: number) => string; domain?: [number, number] }) {
  const [hi, setHi] = useState<number | null>(null);
  const W = 300, H = 120, L = 30, B = 16;
  if (points.length < 2) {
    return (
      <div className="card">
        <div className="label">{title}</div>
        <div className="small muted" style={{ padding: '30px 0', textAlign: 'center' }}>Needs at least two sessions</div>
      </div>
    );
  }
  const vs = points.map((p) => p.v);
  const [lo, top] = domain ?? [Math.min(...vs), Math.max(...vs) || 1];
  const span = top - lo || 1;
  const x = (i: number) => L + (i / (points.length - 1)) * (W - L - 6);
  const y = (v: number) => 6 + (1 - (v - lo) / span) * (H - B - 10);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.v)}`).join(' ');
  const last = points[points.length - 1];
  return (
    <div className="card">
      <div className="row"><div className="label">{title}</div><span className="spacer" /><span className="mono small">{fmt(last.v)}</span></div>
      <div style={{ position: 'relative' }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={`${title} over sessions`}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const px = ((e.clientX - r.left) / r.width) * W;
            setHi(Math.max(0, Math.min(points.length - 1, Math.round(((px - L) / (W - L - 6)) * (points.length - 1)))));
          }}
          onPointerLeave={() => setHi(null)}>
          {[lo, lo + span / 2, top].map((g) => (
            <g key={g}>
              <line x1={L} x2={W - 6} y1={y(g)} y2={y(g)} stroke="var(--rule)" />
              <text x={L - 4} y={y(g) + 3} fontSize="9" textAnchor="end" fill="var(--muted)">{fmt(g)}</text>
            </g>
          ))}
          <path d={d} fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={x(points.length - 1)} cy={y(last.v)} r={4} fill="var(--ink)" stroke="var(--surface)" strokeWidth={2} />
          {hi !== null && (
            <>
              <line x1={x(hi)} x2={x(hi)} y1={4} y2={H - B} stroke="var(--muted)" />
              <circle cx={x(hi)} cy={y(points[hi].v)} r={4} fill="var(--ink)" stroke="var(--surface)" strokeWidth={2} />
            </>
          )}
        </svg>
        {hi !== null && (
          <div className="chart-tip" style={{ left: `${(x(hi) / W) * 100}%`, top: `${(y(points[hi].v) / H) * 100}%` }}>
            {new Date(points[hi].t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · {fmt(points[hi].v)}
          </div>
        )}
      </div>
    </div>
  );
}

/** Rolling mean per calendar day so the charts read as trends across sessions. */
function daily(logs: SessionLog[], pick: (s: SessionLog) => number | null | undefined): Point[] {
  const byDay = new Map<string, { t: number; sum: number; n: number }>();
  for (const s of logs) {
    const v = pick(s);
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    const k = new Date(s.ts).toDateString();
    const e = byDay.get(k) ?? { t: s.ts, sum: 0, n: 0 };
    e.sum += v; e.n++; byDay.set(k, e);
  }
  return Array.from(byDay.values()).sort((a, b) => a.t - b.t).map((e) => ({ t: e.t, v: e.sum / e.n }));
}

export default function Dashboard({ onDrill }: { onDrill: (phoneme: string) => void }) {
  const { learner, data, vocabCards } = useApp();
  const [logs, setLogs] = useState<SessionLog[]>([]);
  useEffect(() => { void db.sessions.orderBy('ts').toArray().then(setLogs); }, [learner.totalTurns]);

  const habits = useMemo(() => Object.entries(learner.habits)
    .filter(([, e]) => e && e.n > 0)
    .map(([k, e]) => ({ code: k as Diagnosis, rate: e!.value, n: e!.n }))
    .sort((a, b) => b.rate - a.rate), [learner.habits]);

  const now = Date.now();
  const byBadge = (['GREEN_EXECUTIVE_SAFE', 'AMBER_COLLEAGUE', 'RED_COLLOQUIAL'] as const).map((b) => {
    const items = data.vocab.filter((v) => v.register_badge === b);
    const practised = items.filter((v) => vocabCards.get(v.id)?.lastReview);
    const recall = practised.length ? practised.reduce((s, v) => s + recallProbability(vocabCards.get(v.id), now), 0) / practised.length : 0;
    return { b, total: items.length, practised: practised.length, recall };
  });
  const passedTurns = logs.filter((l) => l.passed).length;

  return (
    <main>
      <section className="section card">
        <div className="row">
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>44-phoneme Modern RP heatmap</h2>
          <span className="spacer" />
          <span className="small muted">{learner.totalTurns} spoken turns · {passedTurns} passed</span>
        </div>
        <div className="section"><PhonemeHeatmap onDrill={onDrill} /></div>
      </section>

      <section className="section grid2">
        <div className="card">
          <div className="label">Interference habits (EWMA rate per opportunity)</div>
          {habits.length === 0 && <div className="small muted section">Speak a few Tier 1 prompts to populate this.</div>}
          {habits.map((h) => (
            <div key={h.code} className="habit" title={TIPS[h.code].mechanics}>
              <span>{TIPS[h.code].title}</span>
              <div className="hbar"><span style={{ width: `${Math.min(100, h.rate * 100)}%`, background: h.rate > 0.3 ? 'var(--crimson)' : h.rate > 0.12 ? 'var(--amber)' : 'var(--emerald)' }} /></div>
              <span className="mono small">{(h.rate * 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>
        <div className="card">
          <div className="label">Prosody & conciseness vector V<sub>R</sub></div>
          <dl className="kv">
            <dt>r<sub>schwa</sub></dt><dd className="mono">{(learner.prosody.schwa.value * 100).toFixed(0)}% <span className="muted">({learner.prosody.schwa.n})</span></dd>
            <dt>r<sub>nPVI</sub></dt><dd className="mono">{learner.prosody.npvi.value.toFixed(0)} <span className="muted">target ≥ 55</span></dd>
            <dt>r<sub>fluency</sub></dt><dd className="mono">{(learner.prosody.fluency.value * 100).toFixed(0)}%</dd>
            <dt>r<sub>concise</sub></dt><dd className="mono">{(learner.prosody.concise.value * 100).toFixed(0)}% <span className="muted">({learner.prosody.concise.n})</span></dd>
          </dl>
          <div className="label section">Active vocabulary (FSRS)</div>
          {byBadge.map(({ b, total, practised, recall }) => (
            <div key={b} className="habit">
              <span><span className={`badge ${b}`} style={{ display: 'inline-block', marginRight: 6 }} />{practised}/{total} practised</span>
              <div className="hbar"><span style={{ width: `${recall * 100}%`, background: 'var(--ink)' }} /></div>
              <span className="mono small">{(recall * 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="label" style={{ marginBottom: 8 }}>Telemetry (daily means)</div>
        <div className="grid2">
          <LineChart title="Reward R(u)" points={daily(logs, (s) => s.reward)} fmt={(v) => v.toFixed(0)} domain={[0, 100]} />
          <LineChart title="Conciseness score" points={daily(logs, (s) => (s.metrics.concise === null ? null : s.metrics.concise * 100))} fmt={(v) => `${v.toFixed(0)}`} domain={[0, 100]} />
          <LineChart title="Schwa reduction %" points={daily(logs, (s) => (s.metrics.schwa === null ? null : s.metrics.schwa * 100))} fmt={(v) => `${v.toFixed(0)}%`} domain={[0, 100]} />
          <LineChart title="Vocabulary retrieval latency (ms)" points={daily(logs, (s) => s.metrics.retrievalPauseMs ?? null)} fmt={(v) => `${v.toFixed(0)}`} />
          <LineChart title="Rhythm nPVI" points={daily(logs, (s) => (s.metrics.npvi > 0 ? s.metrics.npvi : null))} fmt={(v) => v.toFixed(0)} />
          <LineChart title="Phoneme error rate %" points={daily(logs, (s) => (s.metrics.per > 0 ? s.metrics.per * 100 : null))} fmt={(v) => `${v.toFixed(0)}%`} />
        </div>
      </section>
    </main>
  );
}
