#!/usr/bin/env python3
"""bgm.py — original procedural background music for an XMS project (MIT License).

The arrangement is driven by storyboard.json: every scene start is a cut (crash), every scene `hits` entry
gets a light accent, every `heavy` entry an impact. Each scene may set `music` to one energy label:
  intro | groove | lift | drive | pulse | break | build | peak | outro
(omitted → assigned from the scene's position in the film).

  python3 bgm.py <project> [--bpm 120] [--key "E minor"] [--mood drive|bright|chill] [--energy 0.8]
                           [--seed N] [--length SECONDS] [--out audio/bgm.wav]
Defaults come from storyboard.json → music {bpm, key, mood, energy, seed}. Requires numpy + scipy.
Writes the wav plus <out>.json (parameters, sections, cue list) used by beatgrid.py.
"""
import argparse, json, os, re, sys, wave
from pathlib import Path
import numpy as np
from scipy.signal import butter, sosfilt

sys.path.insert(0, str(Path(__file__).resolve().parent))  # sibling module xms.py
import xms  # noqa: E402

SR = 48000
NOTE = {'C': 0, 'C#': 1, 'DB': 1, 'D': 2, 'D#': 3, 'EB': 3, 'E': 4, 'F': 5, 'F#': 6, 'GB': 6, 'G': 7, 'G#': 8, 'AB': 8, 'A': 9, 'A#': 10, 'BB': 10, 'B': 11}
SCALE = {'minor': [0, 2, 3, 5, 7, 8, 10], 'major': [0, 2, 4, 5, 7, 9, 11]}
PROG = {('minor', 'drive'): [0, 5, 2, 6], ('minor', 'bright'): [0, 5, 2, 6], ('minor', 'chill'): [0, 3, 5, 4],
        ('major', 'drive'): [0, 4, 5, 3], ('major', 'bright'): [0, 4, 5, 3], ('major', 'chill'): [0, 5, 3, 4]}
LEVEL = {'intro': 0, 'break': 0, 'outro': 1, 'groove': 2, 'lift': 3, 'pulse': 3, 'build': 3, 'drive': 4, 'peak': 5}


def parse_key(k):
    m = re.fullmatch(r'\s*([A-Ga-g][#b]?)\s*(major|minor|maj|min|m)?\s*', k)
    if not m:
        raise SystemExit(f'cannot parse key {k!r} (e.g. "E minor", "C major", "F# minor")')
    root = NOTE[m.group(1).upper()]
    mode = 'major' if (m.group(2) or 'major').startswith('maj') else 'minor'
    return root, mode


def hz(semi_from_c, octave):
    return 440.0 * 2 ** ((semi_from_c - 9) / 12 + (octave - 4))


class Song:
    def __init__(s, dur, bpm, key, mood, energy, seed):
        s.N = int(SR * dur); s.dur = dur; s.B = 60 / bpm; s.bar = 4 * s.B
        s.L = np.zeros(s.N); s.R = np.zeros(s.N); s.rng = np.random.default_rng(seed)
        s.mood, s.e = mood, energy
        root, mode = parse_key(key); sc = SCALE[mode]
        s.chords = []
        for d in PROG[(mode, mood)]:
            tri = [root + sc[(d + k) % 7] + 12 * ((d + k) // 7) for k in (0, 2, 4)]
            s.chords.append((hz(tri[0], 2 if tri[0] < 5 else 1), [hz(n, 3) for n in tri]))
        s.tonic = [hz(root, 3), hz(root + 7, 3), hz(root + 12, 3)]

    # ---- dsp helpers
    def lp(s, x, f, o=2): return sosfilt(butter(o, min(f, SR / 2 - 100), 'low', fs=SR, output='sos'), x)
    def hp(s, x, f, o=2): return sosfilt(butter(o, f, 'high', fs=SR, output='sos'), x)
    def bp(s, x, lo, hi): return sosfilt(butter(2, [lo, min(hi, SR / 2 - 200)], 'band', fs=SR, output='sos'), x)
    def tt(s, d): return np.arange(int(d * SR)) / SR
    def noise(s, n): return s.rng.uniform(-1, 1, n)

    def put(s, t, sig, g=1.0, pan=0.0):
        i = int(round(t * SR))
        if i >= s.N or i < 0 or g == 0: return
        sig = sig[:s.N - i]; a = (pan + 1) * np.pi / 4
        s.L[i:i + len(sig)] += sig * g * np.cos(a); s.R[i:i + len(sig)] += sig * g * np.sin(a)

    # ---- instruments (all synthesized here)
    def kick(s, d=.34, punch=1.):
        t = s.tt(d); f = 50 + 130 * np.exp(-t * 30); x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 8)
        k = int(.003 * SR); x[:k] += s.noise(k) * .5 * punch; return np.tanh(x * 1.7)
    def clap(s, d=.22):
        t = s.tt(d); env = np.exp(-t * 20)
        for off in (0, .010, .021): k = int(off * SR); env[k:k + 220] += .6
        return s.bp(s.noise(len(t)), 1000, 6000) * env
    def rim(s):
        t = s.tt(.07); return s.bp(s.noise(len(t)), 1800, 5000) * np.exp(-t * 70) + .4 * np.sin(2 * np.pi * 820 * t) * np.exp(-t * 60)
    def hat(s, op=False):
        t = s.tt(.15 if op else .045); return s.hp(s.noise(len(t)), 7500) * np.exp(-t * (10 if op else 60))
    def saw(s, f, t, det=0.): return 2 * ((f * (1 + det) * t) % 1.0) - 1
    def bass(s, f, d, cut=1000):
        t = s.tt(d); x = .6 * s.saw(f, t) + .5 * np.sin(2 * np.pi * f * t)
        return np.tanh(s.lp(x, cut) * 2) * np.minimum(1, t / .004) * np.exp(-t * 4)
    def stab(s, fs, d, cut=2800, dec=5.):
        t = s.tt(d)
        if s.mood == 'drive':
            x = sum(s.saw(f, t, dt) for f in fs for dt in (-.007, 0, .007)) / (3 * len(fs))
        else:  # softer electric-piano-ish tone for bright / chill
            x = sum(np.sin(2 * np.pi * f * t) + .3 * np.sin(4 * np.pi * f * t) * np.exp(-t * 6) for f in fs) / len(fs)
            cut = cut * (.8 if s.mood == 'chill' else 1.2)
        return s.lp(x, cut) * np.minimum(1, t / .004) * np.exp(-t * dec)
    def pluck(s, f, d=.16, cut=5200):
        t = s.tt(d)
        if s.mood == 'bright':  # bell
            return (np.sin(2 * np.pi * f * t) + .35 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t * 18)) * np.exp(-t * 14)
        return s.lp(.7 * np.sign(np.sin(2 * np.pi * f * t)) + .3 * s.saw(f * 2, t), cut if s.mood == 'drive' else 2400) * np.exp(-t * 20)
    def pad(s, fs, d, cut=800):
        t = s.tt(d); x = sum(s.saw(f, t, dt) for f in fs for dt in (-.004, .004))
        return s.lp(x / (2 * len(fs)), cut) * np.minimum(1, t / .5) * np.minimum(1, np.maximum(0, d - t) / .5)
    def riser(s, d, f0=200, f1=5000):
        t = s.tt(d); p = t / d; n = s.noise(len(t)); out = np.zeros(len(t)); ch = int(.04 * SR)
        for i in range(0, len(t), ch):
            fc = f0 * (f1 / f0) ** (i / len(t)); out[i:i + ch] = s.bp(n[i:i + ch], fc * .7, fc * 1.4)
        return (out * 1.2 + .22 * np.sin(2 * np.pi * np.cumsum(140 * 2 ** (p * 2)) / SR)) * p ** 1.7
    def impact(s, d=1.4, big=1.):
        t = s.tt(d); f = 34 + 80 * np.exp(-t * 9); sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 2.4)
        return np.tanh((sub * 1.2 + s.lp(s.noise(len(t)), 3500) * np.exp(-t * 11) * .6) * big * 1.3)
    def crash(s, d=2.):
        t = s.tt(d); return s.hp(s.noise(len(t)), 5200) * np.exp(-t * 2.3) * .5
    def blip(s, f=1320):
        t = s.tt(.12); return np.sin(2 * np.pi * f * t * (1 + .6 * np.exp(-t * 40))) * np.exp(-t * 28)

    def chord(s, t): return s.chords[int(t // s.bar) % len(s.chords)]

    # ---- one beat of a section pattern
    def beat(s, label, b, t, t0, t1):
        B, e, chill = s.B, s.e, s.mood == 'chill'
        root, ch = s.chord(t); pos = (t - t0) / max(t1 - t0, 1e-9)
        hats16 = label in ('pulse', 'peak')
        if label == 'break':
            if b % 2 == 0: s.put(t, s.kick(.4, .3), .5); s.put(t + B / 2, s.kick(.3, .2), .3)
            if pos >= .4: s.put(t, s.blip(1760 if b % 4 == 0 else 1320), .06); s.put(t + B / 2, s.blip(1320), .06)
            return
        if label == 'build':
            s.put(t, s.kick(), .85); s.put(t + B / 2, s.bass(root, .2), .45 * e)
            n = 2 if pos < .5 else 4
            for k in range(n): s.put(t + k * B / n, s.hat(), .14 * (.6 + .4 * e), -.2)
            if b % 2: s.put(t, s.clap(), .4)
            return
        if chill and b % 2 == 1:
            pass
        else:
            s.put(t, s.kick(), .9 if chill else 1.0)
        if b % 2: s.put(t, s.rim() if chill else s.clap(), .4 if chill else .5, .05)
        s.put(t + B / 2, s.hat(True), .2 * (.5 + .5 * e), .25)
        n = 4 if hats16 else 2
        swing = .08 * B if s.mood != 'drive' else 0
        for k in range(n): s.put(t + k * B / n + (swing if k % 2 else 0), s.hat(), (.14 if k % 2 else .18) * (.5 + .5 * e), -.2)
        if label in ('drive', 'peak'):
            if b % 2 == 0:
                for off in (0, .75 * B, 1.5 * B): s.put(t + off, s.bass(root, .2), .55 * e, -.05)
        else:
            s.put(t + B / 2, s.bass(root, .22), .6 * e, -.05); s.put(t + .75 * B, s.bass(root * 2, .1), .25 * e)
        if b % 4 == 0: s.put(t, s.stab(ch, .7, 2600, 4.5), .4 * e, .2)
        if b % 4 == 2: s.put(t + B / 2, s.stab(ch, .25, 3200, 9), .3 * e, -.2)
        if label in ('lift', 'drive', 'peak', 'outro'):
            for k, f in enumerate([ch[0] * 2, ch[2] * 2, ch[1] * 2, ch[2] * 2]):
                s.put(t + k * B / 4, s.pluck(f), (.13 if label == 'lift' else .16) * e, .35 if k % 2 else -.35)


def auto_labels(scenes):
    n = len(scenes); out = []
    for i, sc in enumerate(scenes):
        if sc.get('music'): out.append(sc['music']); continue
        p = i / max(n - 1, 1)
        out.append('intro' if i == 0 else 'outro' if i == n - 1 else 'groove' if p < .35 else 'lift' if p < .6 else 'drive' if p < .8 else 'peak')
    bad = [l for l in out if l not in LEVEL]
    if bad: raise SystemExit(f'unknown music labels {bad}; use {sorted(LEVEL)}')
    return out


def main():
    ap = argparse.ArgumentParser(prog='bgm', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('project'); ap.add_argument('--bpm', type=float); ap.add_argument('--key'); ap.add_argument('--mood', choices=['drive', 'bright', 'chill'])
    ap.add_argument('--energy', type=float); ap.add_argument('--seed', type=int); ap.add_argument('--length', type=float); ap.add_argument('--out')
    a = ap.parse_args()
    root = Path(a.project).resolve(); film = xms.load_film(root); mu = film.get('music', {})
    bpm = a.bpm or mu.get('bpm', 120); key = a.key or mu.get('key', 'A minor'); mood = a.mood or mu.get('mood', 'drive')
    energy = max(.2, min(1.0, a.energy if a.energy is not None else mu.get('energy', .85))); seed = a.seed if a.seed is not None else mu.get('seed', film['seed'] % 100000)
    out = root / (a.out or mu.get('file', 'audio/bgm.wav'))
    fps = film['fps']; scenes, cur = [], 0
    for sc in film['scenes']:
        n = round(sc['seconds'] * fps); scenes.append(dict(sc, start=cur / fps, end=(cur + n) / fps)); cur += n
    dur = a.length or cur / fps
    labels = auto_labels(scenes)
    S = Song(dur, bpm, key, mood, energy, seed); B = S.B
    off_grid = [round(sc['start'], 3) for sc in scenes if abs(sc['start'] / B - round(sc['start'] / B)) > 1e-6]
    if off_grid: print(f'warning: cuts not on the {bpm:g} BPM beat grid: {off_grid}', file=sys.stderr)
    # ---- sections
    for i, (sc, lab) in enumerate(zip(scenes, labels)):
        t0, t1 = sc['start'], min(sc['end'], dur); prev = labels[i - 1] if i else None
        if lab == 'intro':
            S.put(t0, S.pad(S.tonic, t1 - t0, 600), .45)
            span = t1 - t0
            for x in (0, .25, .5, .625, .75, .8125, .875, .9375): S.put(t0 + x * span, S.kick(punch=.6), .7)
            for k in range(8): S.put(t0 + span / 2 + k * span / 16, S.hat(), .12 + .02 * k)
        elif lab == 'break':
            S.put(t0, S.pad([S.chords[0][0], S.chords[0][0] * 1.5, S.chords[0][0] * 2], t1 - t0, 300), .4)
            S.put(t0, S.pad([f * 2 for f in S.tonic], t1 - t0, 1400), .1)
        elif lab == 'outro':
            hv = [t0 + h for h in sc.get('heavy', []) if h <= 4] or [t0]
            S.put(t0, S.pad(S.tonic, hv[0] - t0 + .2, 900), .4)
            for x in np.arange(t0, hv[0] - .3, B):
                S.put(x, S.kick(punch=.5), .55)
        b0 = int(np.ceil(t0 / B - 1e-9))
        first_beat = (t0 + (hv[0] - t0)) if lab == 'outro' else t0
        end_beats = t1 - (2 if lab == 'outro' else 0)
        for b in range(b0, int(np.ceil(end_beats / B - 1e-9))):
            t = b * B
            if lab in ('intro', 'break') or t < first_beat - 1e-9:
                if lab == 'break': S.beat(lab, b - b0, t, t0, t1)
                continue
            S.beat(lab, b - b0, t, t0, t1)
        if lab == 'build':
            for k in range(16): S.put(t1 - 1 + k / 16, S.clap(.06), .06 + .02 * k)
        if lab == 'outro':
            fin = max(t0, t1 - 2); S.put(fin, S.kick(.6), 1.0)
            S.put(fin, S.stab([S.chords[0][1][0], S.chords[0][1][1], S.chords[0][1][2], S.chords[0][1][0] * 2], 2.0, 2600, 1.6), .6); S.put(fin, S.crash(2.0), .6)
        # transition risers into higher-energy material
        nxt = labels[i + 1] if i + 1 < len(labels) else None
        if nxt and (lab in ('intro', 'build') or nxt in ('break', 'peak')):
            S.put(t1 - 2, S.riser(2.0, 300 if nxt == 'break' else 200, 6000 if nxt == 'break' else 5000 + 1000 * LEVEL[nxt]), .45 + .05 * (lab != 'break'))
        if nxt == 'outro' and lab == 'peak':
            S.put(t1 - 1, S.crash(1.0)[::-1] * .8, .6)
        if lab == 'outro':
            S.put(hv[0] - 2 if hv[0] - 2 >= t0 else t0, S.riser(min(2.0, max(.5, hv[0] - t0)), 200, 8000), .55)
    # ---- cues from the timeline
    heavy_all = [sc['start'] + h for sc in scenes for h in sc.get('heavy', [])]
    last_heavy = max(heavy_all) if heavy_all else None
    cues = []
    for i, sc in enumerate(scenes):
        if i:
            S.put(sc['start'], S.crash(1.5), .4); cues.append({'t': round(sc['start'], 6), 'kind': 'cut', 'scene': sc['id']})
        if labels[i] == 'intro' and i + 1 < len(scenes):
            S.put(sc['end'], S.impact(1.6, 1.1), .9); S.put(sc['end'], S.crash(), .85)
        for h in sc.get('hits', []):
            t = sc['start'] + h
            if h in sc.get('heavy', []):
                big = 1.5 if t == last_heavy else 1.2
                S.put(t, S.impact(1.6, big), 1.2 if t == last_heavy else 1.0); S.put(t, S.crash(2.2), .6)
                cues.append({'t': round(t, 6), 'kind': 'heavy', 'scene': sc['id']})
            else:
                S.put(t, S.impact(.5, .6), .45); S.put(t, S.blip(1568), .12); cues.append({'t': round(t, 6), 'kind': 'hit', 'scene': sc['id']})
    mix = np.stack([S.L, S.R]); mix /= np.max(np.abs(mix)) + 1e-9
    mix = np.tanh(mix * 1.5) / np.tanh(1.5) * .9
    fade = int(min(1.2, dur / 4) * SR); mix[:, -fade:] *= np.linspace(1, 0, fade) ** 1.5
    os.makedirs(out.parent, exist_ok=True)
    with wave.open(str(out), 'w') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((mix.T * 32767).astype(np.int16).tobytes())
    meta = {'generator': 'xms bgm.py', 'license': 'original (generated by the project author with xms bgm.py)', 'bpm': bpm, 'key': key, 'mood': mood,
            'energy': energy, 'seed': seed, 'durationSeconds': dur, 'gridOffsetSeconds': 0.0,
            'sections': [{'scene': sc['id'], 'label': l, 'start': round(sc['start'], 6), 'end': round(sc['end'], 6)} for sc, l in zip(scenes, labels)], 'cues': sorted(cues, key=lambda c: c['t'])}
    xms.write(out.with_suffix('.json'), meta)
    rel = out.relative_to(root).as_posix()
    print(f'bgm → {rel}  ({dur:.2f}s, {bpm:g} BPM, {key}, {mood}, energy {energy:.2f}, {len(cues)} cues)')
    declared = {x['path'] for x in xms.read(root / 'assets.json')['assets']} if (root / 'assets.json').exists() else set()
    if rel not in declared:
        print(f'note: declare it in assets.json → {{"path": "{rel}", "license": "original", "source": "generated with xms bgm.py (seed {seed})"}}')


if __name__ == '__main__':
    main()
