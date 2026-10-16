import { useEffect, useRef, useState } from 'react';
import { recorder } from '../services/audio';

/** 60 fps oscilloscope + a live syllable-rate meter (intensity peaks / second over the last 3 s). */
export default function Waveform({ active }: { active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [rate, setRate] = useState(0);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const buf = new Float32Array(2048);
    const levels: { t: number; v: number }[] = [];
    let lastRateUpdate = 0;
    const draw = (t: number) => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const style = getComputedStyle(canvas);
      ctx.strokeStyle = style.getPropertyValue('--rule').trim() || '#ddd';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
      const an = recorder.analyser;
      if (active && an) {
        an.getFloatTimeDomainData(buf);
        ctx.strokeStyle = style.getPropertyValue('--ink').trim() || '#000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        const step = buf.length / w;
        for (let x = 0; x < w; x++) {
          const v = buf[Math.floor(x * step)] ?? 0;
          const y = h / 2 - Math.max(-1, Math.min(1, v * 3)) * (h / 2 - 4);
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        levels.push({ t, v: recorder.level });
        while (levels.length && t - levels[0].t > 3000) levels.shift();
        if (t - lastRateUpdate > 400 && levels.length > 20) {
          lastRateUpdate = t;
          const vs = levels.map((l) => l.v);
          const thr = Math.max(0.01, (Math.max(...vs) + Math.min(...vs)) / 3);
          let peaks = 0, lastPeak = -1e9;
          for (let i = 2; i < vs.length - 2; i++) {
            if (vs[i] > thr && vs[i] >= vs[i - 1] && vs[i] >= vs[i + 1] && vs[i] > vs[i - 2] && vs[i] > vs[i + 2] && levels[i].t - lastPeak > 110) { peaks++; lastPeak = levels[i].t; }
          }
          setRate(peaks / ((levels[levels.length - 1].t - levels[0].t) / 1000 || 1));
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <div>
      <canvas ref={ref} className="wave" aria-hidden />
      {active && <div className="tiny muted mono">≈ {rate.toFixed(1)} syll/s {rate > 0 && rate < 3 ? '· slow' : rate > 6.5 ? '· fast' : ''}</div>}
    </div>
  );
}
