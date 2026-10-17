"""Original score for the demo video, synthesised from scratch (no samples, no licences).

    python3 scripts/demo/music.py <outDir> [trailerSeconds]

Writes trailer.wav (builds, then lands on the logo), sting.wav (chapter cards)
and bed.wav (a quiet loopable pad for the setup guide). 48 kHz stereo.
"""
import sys, wave
import numpy as np

SR = 48000
rng = np.random.default_rng(7)
BPM = 100
BEAT = 60 / BPM
BAR = 4 * BEAT
# Am - F - C - G, voiced around middle C
PROG = [[57, 60, 64, 69], [53, 57, 60, 65], [48, 55, 60, 64], [55, 59, 62, 67]]


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def lowpass(x, cutoff, order=2):
    X = np.fft.rfft(x, axis=0)
    f = np.fft.rfftfreq(x.shape[0], 1 / SR)
    h = 1 / np.sqrt(1 + (f / cutoff) ** (2 * order))
    return np.fft.irfft(X * (h[:, None] if X.ndim == 2 else h), n=x.shape[0], axis=0)


def highpass(x, cutoff):
    return x - lowpass(x, cutoff)


def saw(f, t, phase=0.0):
    return 2 * ((f * t + phase) % 1) - 1


def env_adsr(n, a, d, s, r):
    e = np.ones(n) * s
    na, nd, nr = int(a * SR), int(d * SR), int(r * SR)
    na = min(na, n)
    e[:na] = np.linspace(0, 1, na)
    nd = min(nd, n - na)
    e[na:na + nd] = np.linspace(1, s, nd)
    if nr:
        e[-nr:] *= np.linspace(1, 0, nr)
    return e


def reverb(x, secs=2.4, mix=0.28):
    n = int(secs * SR)
    t = np.arange(n) / SR
    ir = rng.standard_normal((n, 2)) * np.exp(-t / (secs / 6.5))[:, None]
    ir = lowpass(ir, 5000)
    ir /= np.sqrt((ir ** 2).sum(axis=0))
    L = x.shape[0] + n
    N = 1 << int(np.ceil(np.log2(L)))
    wet = np.fft.irfft(np.fft.rfft(x, N, axis=0) * np.fft.rfft(ir, N, axis=0), N, axis=0)[:x.shape[0]]
    return (1 - mix) * x + mix * wet * 0.6


def place(buf, sig, start):
    i = int(start * SR)
    if i >= buf.shape[0]:
        return
    j = min(buf.shape[0], i + sig.shape[0])
    buf[i:j] += sig[: j - i]


def pad_chord(notes, dur, bright=1400):
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros((n, 2))
    for m in notes:
        for k, det in enumerate((-0.09, 0.0, 0.08)):
            f = hz(m) * 2 ** (det / 12)
            v = saw(f, t, rng.random())
            pan = 0.5 + (k - 1) * 0.35
            out[:, 0] += v * (1 - pan)
            out[:, 1] += v * pan
    out = lowpass(out, bright)
    out *= env_adsr(n, 0.6, 0.4, 0.8, 0.7)[:, None]
    return out / (len(notes) * 3)


def pluck(m, dur=0.45, vel=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = hz(m)
    v = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * 2 * f * t) + 0.12 * np.sin(2 * np.pi * 3 * f * t)
    v *= np.exp(-t * 7.5) * np.minimum(1, t * 400)
    return np.stack([v, v], axis=1) * 0.22 * vel


def kick(vel=1.0):
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    f = 45 + 95 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    v = np.sin(ph) * np.exp(-t * 9) + 0.05 * rng.standard_normal(n) * np.exp(-t * 120)
    return np.stack([v, v], axis=1) * 0.55 * vel


def hat(vel=1.0):
    n = int(0.06 * SR)
    t = np.arange(n) / SR
    v = highpass(rng.standard_normal(n), 7000) * np.exp(-t * 70)
    return np.stack([v * 0.9, v], axis=1) * 0.07 * vel


def sub(m, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    v = np.sin(2 * np.pi * hz(m - 12) * t) * env_adsr(n, 0.02, 0.2, 0.7, 0.25)
    return np.stack([v, v], axis=1) * 0.22


def swell(dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    v = lowpass(rng.standard_normal((n, 2)), 9000) * ((t / dur) ** 3)[:, None]
    return v * 0.08


def duck(buf, hits, depth=0.55, rel=0.22):
    g = np.ones(buf.shape[0])
    for h in hits:
        i = int(h * SR)
        n = int(rel * SR)
        j = min(len(g), i + n)
        g[i:j] = np.minimum(g[i:j], 1 - depth * (1 - np.linspace(0, 1, j - i)) ** 2)
    return buf * g[:, None]


def master(x, peak=0.89):
    x = np.tanh(x * 1.4) / np.tanh(1.4)
    return x / (np.abs(x).max() + 1e-9) * peak


def write(path, x):
    x16 = (np.clip(x, -1, 1) * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(x16.tobytes())


def trailer(total):
    """Intro (pads) → groove → build → hit on the logo → ring out."""
    bars = int(np.ceil(total / BAR))
    hit_bar = bars - 3          # the logo lands here
    n = int((bars * BAR + 3) * SR)
    pads, plucks, drums, bass = (np.zeros((n, 2)) for _ in range(4))
    kicks = []
    for b in range(bars):
        ch = PROG[b % 4]
        t0 = b * BAR
        if b < hit_bar:
            place(pads, pad_chord(ch, BAR + 0.7, 900 + 700 * min(1, b / hit_bar)), t0)
        if 2 <= b < hit_bar:
            arp = [ch[0] + 12, ch[1] + 12, ch[2] + 12, ch[3] + 12, ch[2] + 12, ch[1] + 12, ch[3] + 12, ch[2] + 24]
            for k in range(8):
                place(plucks, pluck(arp[k], vel=0.75 + 0.25 * (k % 2 == 0)), t0 + k * BEAT / 2)
        if 4 <= b < hit_bar:
            place(bass, sub(ch[0], BAR), t0)
            steps = [0, 2] if b < 8 else [0, 1, 2, 3]
            for k in steps:
                place(drums, kick(), t0 + k * BEAT); kicks.append(t0 + k * BEAT)
        if 8 <= b < hit_bar:
            for k in range(4):
                place(drums, hat(), t0 + k * BEAT + BEAT / 2)
        if b == hit_bar - 1:
            place(pads, swell(BAR), t0)
    # the hit: big chord + low boom, ringing out
    th = hit_bar * BAR
    place(pads, pad_chord([45, 57, 60, 64, 69, 72], 3 * BAR, 2200) * 1.4, th)
    place(drums, kick(1.3), th)
    for k, m in enumerate([81, 76, 72, 69]):
        place(plucks, pluck(m, 1.2, 0.8), th + k * BEAT / 2)
    mix = duck(pads * 0.9 + bass, kicks) + plucks * 0.8 + drums
    mix = reverb(mix)
    fade = int(2.5 * SR)
    mix[-fade:] *= np.linspace(1, 0, fade)[:, None]
    return master(mix), th


def sting():
    n = int(4.5 * SR)
    x = np.zeros((n, 2))
    place(x, pad_chord([48, 55, 60, 64, 67], 4.0, 1800), 0)
    for k, m in enumerate([72, 76, 79, 84]):
        place(x, pluck(m, 1.0, 0.7), 0.15 + k * 0.12)
    x = reverb(x, 2.0, 0.35)
    x[-int(1.2 * SR):] *= np.linspace(1, 0, int(1.2 * SR))[:, None]
    return master(x, 0.7)


def bed(total=120):
    bars = int(np.ceil(total / BAR))
    n = int((bars * BAR + 1) * SR)
    x = np.zeros((n, 2))
    for b in range(bars):
        ch = PROG[b % 4]
        place(x, pad_chord(ch, BAR + 0.7, 800) * 0.8, b * BAR)
        for k, m in enumerate([ch[0] + 12, ch[2] + 12, ch[3] + 12, ch[1] + 24]):
            place(x, pluck(m, 0.8, 0.35), b * BAR + k * BEAT)
    x = reverb(x, 3.0, 0.4)
    f = int(2 * SR)
    x[:f] *= np.linspace(0, 1, f)[:, None]
    x[-f:] *= np.linspace(1, 0, f)[:, None]
    return master(x, 0.6)


if __name__ == '__main__':
    out = sys.argv[1]
    total = float(sys.argv[2]) if len(sys.argv) > 2 else 56
    tr, hit = trailer(total)
    write(f'{out}/trailer.wav', tr)
    write(f'{out}/sting.wav', sting())
    write(f'{out}/bed.wav', bed())
    print(f'trailer {tr.shape[0] / SR:.1f}s, logo hit at {hit:.2f}s; bar = {BAR:.2f}s')
