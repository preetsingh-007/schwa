import { useState } from 'react';
import { useApp } from '../store';
import { mastery, topConfusion } from '../services/rlBandit';
import { PHONEME_INDEX } from '../lib/ipa';
import type { PhonemeInfo } from '../types';

/**
 * Sequential single-hue (emerald) scale for mastery M_P[i,i]; unseen phonemes
 * are neutral grey so "no data" never reads as "bad".
 */
export function masteryColor(m: number, seen: boolean): string {
  if (!seen) return 'var(--surface-2)';
  const t = Math.max(0, Math.min(1, (m - 0.3) / 0.65));
  return `color-mix(in oklab, var(--emerald) ${Math.round(12 + t * 80)}%, var(--surface))`;
}

const PLACES = ['bilabial', 'labiodental', 'dental', 'alveolar', 'postalveolar', 'palatal', 'velar', 'glottal'];
const MANNERS = ['plosive', 'affricate', 'fricative', 'nasal', 'lateral', 'approximant'];

export default function PhonemeHeatmap({ onDrill }: { onDrill: (p: string) => void }) {
  const { data, learner } = useApp();
  const [hover, setHover] = useState<PhonemeInfo | null>(null);
  const counts = learner.confusion.counts;
  const seen = (s: string) => (counts[PHONEME_INDEX.get(s) ?? -1] ?? 0) > 0;
  const vowels = data.phonemes.filter((p) => p.kind === 'vowel');
  const monoph = vowels.filter((v) => [...v.symbol].filter((c) => c !== 'ː').length === 1);
  const diph = vowels.filter((v) => !monoph.includes(v));
  const cons = data.phonemes.filter((p) => p.kind === 'consonant');

  const W = 360, H = 250;
  // Trapezium: front edge slants (close front at x=30, open front at x=110).
  const pos = (x: number, y: number) => ({ cx: 30 + y * 80 + x * (W - 60 - y * 80), cy: 20 + y * (H - 40) });
  const info = hover && (() => {
    const m = mastery(learner.confusion, hover.symbol);
    const top = topConfusion(learner.confusion, hover.symbol);
    const n = counts[PHONEME_INDEX.get(hover.symbol) ?? -1] ?? 0;
    return `/${hover.symbol}/ ${hover.keyword} · mastery ${(m * 100).toFixed(0)}% · ${n} obs${top ? ` · often → [${top.phone}] ${(top.p * 100).toFixed(0)}%` : ''}`;
  })();

  return (
    <div>
      <div className="grid2">
        <div>
          <div className="label">Vowel trapezium (monophthongs)</div>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%' }} role="img" aria-label="RP vowel trapezium coloured by mastery">
            <path d={`M30,20 L${W - 30},20 L${W - 30},${H - 20} L110,${H - 20} Z`} fill="none" stroke="var(--rule-strong)" />
            {monoph.map((v) => {
              const c = v.chart as { x: number; y: number };
              const { cx, cy } = pos(c.x, c.y);
              const m = mastery(learner.confusion, v.symbol);
              return (
                <g key={v.symbol} style={{ cursor: 'pointer' }} onClick={() => onDrill(v.symbol)} onPointerEnter={() => setHover(v)} onPointerLeave={() => setHover(null)}>
                  <circle cx={cx} cy={cy} r={19} fill={masteryColor(m, seen(v.symbol))} stroke="var(--surface)" strokeWidth={2} />
                  <circle cx={cx} cy={cy} r={24} fill="transparent" />
                  <text x={cx} y={cy + 6} textAnchor="middle" fontSize="17" fontFamily="var(--ipa)" fill="var(--ink)">{v.symbol}</text>
                </g>
              );
            })}
          </svg>
          <div className="label section">Diphthongs</div>
          <div className="row">
            {diph.map((v) => (
              <button key={v.symbol} className="cell" style={{ width: 52, background: masteryColor(mastery(learner.confusion, v.symbol), seen(v.symbol)) }}
                onClick={() => onDrill(v.symbol)} onPointerEnter={() => setHover(v)} onPointerLeave={() => setHover(null)} title={`${v.keyword}`}>
                {v.symbol}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="label">Consonants (place × manner; voiceless | voiced)</div>
          <table className="cgrid">
            <thead><tr><th />{PLACES.map((p) => <th key={p}>{p.slice(0, 5)}</th>)}</tr></thead>
            <tbody>
              {MANNERS.map((man) => (
                <tr key={man}>
                  <th>{man.slice(0, 6)}</th>
                  {PLACES.map((pl) => {
                    const here = cons.filter((c) => { const ch = c.chart as { place: string; manner: string }; return ch.place === pl && ch.manner === man; });
                    return (
                      <td key={pl}>
                        <div style={{ display: 'flex', gap: 2 }}>
                          {here.map((c) => (
                            <button key={c.symbol} className="cell" style={{ background: masteryColor(mastery(learner.confusion, c.symbol), seen(c.symbol)) }}
                              onClick={() => onDrill(c.symbol)} onPointerEnter={() => setHover(c)} onPointerLeave={() => setHover(null)} aria-label={`/${c.symbol}/ ${c.keyword}`}>
                              {c.symbol}
                            </button>
                          ))}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="row small section" style={{ minHeight: 22 }}>
        {info ? <span className="mono">{info}</span> : <span className="muted">Hover for detail · tap any phoneme to launch a targeted calibration drill.</span>}
      </div>
      <div className="row tiny muted">
        <span>Mastery M<sub>P</sub>[i,i]:</span>
        <span className="cell" style={{ width: 26, height: 14, background: 'var(--surface-2)' }} /> unseen
        {[0.35, 0.55, 0.75, 0.95].map((m) => <span key={m} className="cell" style={{ width: 26, height: 14, background: masteryColor(m, true) }} />)}
        <span>low → high</span>
      </div>
    </div>
  );
}
