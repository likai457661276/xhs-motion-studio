#!/usr/bin/env python3
"""qa.py — automated QA for an XMS render (MIT License). Needs numpy + Pillow.

Run through `xms.py qa <project> [--draft]` (which first captures build/qa/ with xms-render.cjs --mode qa).

Inputs   build/qa/runs.jsonl   every text run drawn on every frame (from the real draw calls)
         build/qa/samples/     sampled frames: <f>.png (normal) + <f>-bg.png (same frame, text suppressed)
         qa.config.json        thresholds, forbidden words, co-appear rules
Checks   theme contrast pairs · per-run contrast against the real local background (halo composited) ·
         centering (layout + pixel) · edge cutoff / margin · overlaps · 小红书 UI safe zones ·
         background brightness · min readable size · forbidden words (all on-screen strings + storyboard.json) ·
         must-co-appear rules on every frame ·
         disclosure: factBoundary present · 「示意画面」 badge visible on every illustrative frame, inside the safe
         area (from the run log and from pixels) · chart-like fx without a dataSource / illustrative flag (warn) ·
         a style preset was chosen
Outputs  build/qa/qa-report.json, qa-report.md, contact-sheet.jpg; exit 1 when a check fails (final mode).
"""
import argparse, collections, json, re, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageFont, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))  # sibling module xms.py
import xms  # noqa: E402

DEFAULT = {
    'minContrast': 4.5, 'minVisibleAlpha': 0.9, 'centerTolerancePx': 4, 'edgePx': 6, 'bgMinMean': 0.6, 'minReadablePx': 40,
    'overlapMinFraction': 0.06, 'ignoreRoles': ['decor'], 'safeZones': 'warn',
    'forbidden': ['Twitter', '推特', '刷到', '搬运', '点赞', '关注', '评论区见', {'pattern': r'(?<![A-Za-z0-9_])X(?![A-Za-z0-9_])', 'label': 'X (platform)'}],
    'coAppear': [], 'staticScanIgnoreKeys': ['id', 'file', 'path', 'schema', 'source', 'license', 'note', 'notes', 'fonts', 'music', 'motif', 'tint', 'theme', 'preset',
                             'style', 'src', 'prompt', 'corner', 'mode'],
}


def lum(rgb):
    c = np.asarray(rgb, dtype=np.float64) / 255
    c = np.where(c <= .04045, c / 12.92, ((c + .055) / 1.055) ** 2.4)
    return c[..., 0] * .2126 + c[..., 1] * .7152 + c[..., 2] * .0722


def parse_color(s):
    s = s.strip()
    if s.startswith('#'):
        h = s[1:]
        if len(h) == 3: h = ''.join(ch * 2 for ch in h)
        return [int(h[i:i + 2], 16) for i in (0, 2, 4)], 1.0 if len(h) == 6 else int(h[6:8], 16) / 255
    m = re.match(r'rgba?\(([^)]+)\)', s)
    if m:
        v = [float(x) for x in m.group(1).split(',')]
        return v[:3], (v[3] if len(v) > 3 else 1.0)
    raise ValueError(f'unsupported colour {s}')


def ratio(a, b):
    hi, lo = np.maximum(a, b), np.minimum(a, b)
    return (hi + .05) / (lo + .05)


def compile_patterns(items):
    out = []
    for it in items:
        if isinstance(it, str):
            out.append((it, re.compile(re.escape(it), re.I if it.isascii() else 0)))
        else:
            flags = re.I if 'i' in it.get('flags', '') else 0
            out.append((it.get('label', it['pattern']), re.compile(it['pattern'], flags)))
    return out


def strings(v, ignore, path=''):
    if isinstance(v, str): yield path, v
    elif isinstance(v, list):
        for i, x in enumerate(v): yield from strings(x, ignore, f'{path}[{i}]')
    elif isinstance(v, dict):
        for k, x in v.items():
            if k not in ignore: yield from strings(x, ignore, f'{path}.{k}' if path else k)


def inter(a, b):
    w = min(a[2], b[2]) - max(a[0], b[0]); h = min(a[3], b[3]) - max(a[1], b[1])
    return max(0, w) * max(0, h)


def area(a): return max(1, (a[2] - a[0]) * (a[3] - a[1]))


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('project'); ap.add_argument('--draft', action='store_true')
    a = ap.parse_args()
    root = Path(a.project).resolve(); base = root / ('.xms/draft' if a.draft else 'build'); qd = base / 'qa'
    tl = xms.read(base / 'timeline.json'); cfg = dict(DEFAULT); cfgf = root / 'qa.config.json'
    if cfgf.exists(): cfg.update(xms.read(cfgf))
    W, H, fps = tl['width'], tl['height'], tl['fps']
    themes = xms.read(root / 'lib/themes.json'); theme = dict(themes['themes'][tl['theme']], **tl.get('themeOverrides', {}))
    preset = themes['presets'][tl['preset']]; M = preset.get('margin', 60); zones = preset.get('uiZones', {})
    samples = xms.read(qd / 'samples.json')
    if samples['timelineSha256'] != xms.sha(base / 'timeline.json'):
        sys.exit('QA capture is stale: rerun `xms.py qa`')
    frames = [json.loads(l) for l in (qd / 'runs.jsonl').read_text(encoding='utf-8').splitlines() if l.strip()]
    assert len(frames) == tl['totalFrames'], 'runs.jsonl incomplete'
    # motion inference: a run whose box or opacity differs from the same run on a neighbouring frame is in motion
    def keyed(runs):
        seen = collections.Counter(); out = {}
        for r in runs:
            k = (r['text'], r['role']); out[(k, seen[k])] = r; seen[k] += 1
        return out
    K = [keyed(fr['runs']) for fr in frames]
    for i, fr in enumerate(frames):
        for key, r in K[i].items():
            for j in (i - 1, i + 1):
                o = K[j].get(key) if 0 <= j < len(frames) else None
                if o and (max(abs(a_ - b_) for a_, b_ in zip(r['box'], o['box'])) > .75 or abs(r['alpha'] - o['alpha']) > .02 or r['size'] != o['size']):
                    r['moving'] = True; break
    starts = [s['startFrame'] for s in tl['scenes']]
    scene_of = lambda f: tl['scenes'][max(i for i, s in enumerate(starts) if s <= f)]['id']
    ignore = set(cfg['ignoreRoles']); vis = cfg['minVisibleAlpha']
    checks = {}

    def add(name, items, level='fail', note=''):
        checks[name] = {'level': level, 'passed': not items, 'count': len(items), 'items': items[:60], 'note': note}

    # 1 theme pairs
    bad = []
    for f, b in themes['contrastPairs']:
        r = float(ratio(lum(parse_color(theme[f])[0]), lum(parse_color(theme[b])[0])))
        if r < cfg['minContrast']: bad.append(f'{f} on {b}: {r:.2f}:1')
    add('theme-contrast', bad, note=f'{len(themes["contrastPairs"])} role pairs of theme "{tl["theme"]}" ≥ {cfg["minContrast"]}:1')

    # 2 forbidden words — every on-screen string on every frame + storyboard.json + scene source literals
    pats = compile_patterns(cfg['forbidden']); hits = {}
    seen_text = collections.defaultdict(list)
    for fr in frames:
        for r in fr['runs']:
            if r['alpha'] > 0.01: seen_text[r['text']].append(fr['frame'])
    joined_by_frame = None
    for txt, fl in seen_text.items():
        for label, p in pats:
            if p.search(txt): hits.setdefault(f'on-screen "{txt}" matches {label}', fl[0])
    for path, s in strings(xms.read(root / 'storyboard.json'), set(cfg['staticScanIgnoreKeys'])):
        for label, p in pats:
            if p.search(s): hits.setdefault(f'storyboard.json {path} "{s}" matches {label}', None)
    src = (root / 'shots.js').read_text(encoding='utf-8')
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S); src = re.sub(r'(?m)//.*$', '', src)
    for lit in re.findall(r"'((?:[^'\\\n]|\\.)*)'|\"((?:[^\"\\\n]|\\.)*)\"|`((?:[^`\\]|\\.)*)`", src):
        s = next(x for x in lit if x) if any(lit) else ''
        for label, p in pats:
            if s and p.search(s): hits.setdefault(f'shots.js literal "{s[:40]}" matches {label}', None)
    add('forbidden-words', [f'{k}' + (f' (first at frame {v}, {v / fps:.2f}s)' if v is not None else '') for k, v in hits.items()],
        note=f'{len(seen_text)} distinct on-screen strings + storyboard.json + shots.js literals vs {len(pats)} patterns')

    # 3 co-appear rules on every frame
    bad = []
    for rule in cfg['coAppear']:
        w, q = re.compile(rule['when']), re.compile(rule['require']); bad_frames = []
        for fr in frames:
            trig = [r['alpha'] for r in fr['runs'] if r['alpha'] > .05 and w.search(r['text'])]
            if not trig: continue
            need = min(rule.get('minAlpha', .9), max(trig))
            ok = any(r['alpha'] >= need - 1e-3 and q.search(r['text']) for r in fr['runs'])
            if not ok: bad_frames.append(fr['frame'])
        if bad_frames:
            bad.append(f'/{rule["when"]}/ visible without /{rule["require"]}/ on {len(bad_frames)} frames, first {bad_frames[0]} ({bad_frames[0] / fps:.2f}s, {scene_of(bad_frames[0])})')
        rule['framesChecked'] = sum(1 for fr in frames if any(r['alpha'] > .05 and w.search(r['text']) for r in fr['runs']))
    add('co-appear', bad, note='; '.join(f'/{r["when"]}/ ⇒ /{r["require"]}/ on {r["framesChecked"]} frames' for r in cfg['coAppear']) or 'no rules configured')

    # 4 geometry from logged runs, all frames (static, visible, non-decor)
    def groups(runs):
        g = collections.defaultdict(list)
        for i, r in enumerate(runs): g[r['group'] or f'r{i}'].append(r)
        return g
    def settled_groups(all_runs):
        # a group (title row, rich line) is judged only when every member is visible and static
        g = groups([r for r in all_runs if r['role'] not in ignore and r['alpha'] > .01])
        return {k: rs for k, rs in g.items() if all(r['alpha'] >= vis and not r['moving'] for r in rs)}
    center, cut, margin, overlap, safe, small = {}, {}, {}, {}, {}, {}
    tol = cfg['centerTolerancePx']
    for fr in frames:
        f = fr['frame']; sid = scene_of(f)
        runs = [r for r in fr['runs'] if r['role'] not in ignore and r['alpha'] >= vis and not r['moving']]
        for gk, rs in settled_groups(fr['runs']).items():
            x0 = min(r['box'][0] for r in rs); x1 = max(r['box'][2] for r in rs)
            cx = rs[0]['cx']
            if cx is not None and abs(cx - W / 2) < 2 and not rs[0]['rotated']:
                err = (x0 + x1) / 2 - W / 2
                if abs(err) > tol: center.setdefault((sid, ''.join(r['text'] for r in rs)), (f, round(err, 1)))
        for r in runs:
            b = r['box']
            if b[0] < 0 or b[1] < 0 or b[2] > W or b[3] > H: cut.setdefault((sid, r['text']), (f, b))
            elif b[0] < M - 2 or b[2] > W - M + 2: margin.setdefault((sid, r['text']), (f, b))
            for zn, z in zones.items():
                if inter(b, [z['x'], z['y'], z['x'] + z['w'], z['y'] + z['h']]) > .1 * area(b): safe.setdefault((sid, r['text'], zn), f)
            if r['size'] < cfg['minReadablePx'] and not r['role'].startswith('badge'): small.setdefault((sid, r['text']), (f, r['size']))
        for i in range(len(runs)):
            for j in range(i + 1, len(runs)):
                A, B = runs[i], runs[j]
                if A['group'] and A['group'] == B['group']: continue
                if A['text'] == B['text'] and A['box'] == B['box']: continue
                if inter(A['box'], B['box']) > cfg['overlapMinFraction'] * min(area(A['box']), area(B['box'])):
                    overlap.setdefault((sid, A['text'], B['text']), f)
    add('center-layout', [f'{s} "{t}" off by {e:+} px at frame {f}' for (s, t), (f, e) in center.items()], note=f'frame-centred groups, every static frame, ±{tol}px')
    add('edge-cutoff', [f'{s} "{t}" box {b} leaves the canvas at frame {f}' for (s, t), (f, b) in cut.items()])
    add('margin', [f'{s} "{t}" inside the {M}px margin at frame {f} box {b}' for (s, t), (f, b) in margin.items()], level='warn')
    add('overlap', [f'{s} "{a_}" × "{b_}" at frame {f} ({f / fps:.2f}s)' for (s, a_, b_), f in overlap.items()])
    add('safe-zones', [f'{s} "{t}" overlaps 小红书 UI zone "{z}" at frame {f}' for (s, t, z), f in safe.items()], level='warn' if cfg['safeZones'] == 'warn' else 'fail',
        note='status bar / caption+interaction bar / right button rail')
    add('min-size', [f'{s} "{t}" {sz}px < {cfg["minReadablePx"]}px at frame {f}' for (s, t), (f, sz) in small.items()], level='warn')

    # 5 pixel checks on sample pairs
    halo_rgb, halo_a = parse_color(theme['halo'])
    con, cpx, edge, bright, rows = [], [], [], [], []
    badge_px = {}  # frame → {role: changed pixels inside the badge box} (text-only difference mask)
    for smp in samples['samples']:
        f = smp['frame']
        full = np.asarray(Image.open(qd / 'samples' / f'{f}.png').convert('RGB'), dtype=np.int16)
        bg = np.asarray(Image.open(qd / 'samples' / f'{f}-bg.png').convert('RGB'), dtype=np.int16)
        mask = np.abs(full - bg).sum(2) > 30
        bl = lum(bg); mean = float(bl.mean())
        if mean < cfg['bgMinMean']: bright.append(f'{smp["scene"]} frame {f}: background mean luminance {mean:.2f} < {cfg["bgMinMean"]}')
        e = cfg['edgePx']
        if mask[:e].any() or mask[-e:].any() or mask[:, :e].any() or mask[:, -e:].any(): edge.append(f'{smp["scene"]} frame {f}: text pixels within {e}px of the frame edge')
        worst = None
        for r in frames[f]['runs']:
            if r['role'].startswith('badge-'):
                x0, y0, x1, y1 = [max(0, int(v)) for v in r['box']]
                badge_px.setdefault(f, {})[r['role']] = int(mask[y0:y1, x0:x1].sum())
        runs = [r for r in frames[f]['runs'] if r['role'] not in ignore and r['alpha'] >= vis]
        for r in runs:
            x0, y0, x1, y1 = [int(v) for v in r['box']]; x0, y0 = max(0, x0), max(0, y0); x1, y1 = min(W, x1), min(H, y1)
            if x1 - x0 < 2 or y1 - y0 < 2: continue
            px = bg[y0:y1, x0:x1].astype(np.float64)
            if r['halo']: px = px * (1 - halo_a) + np.asarray(halo_rgb) * halo_a
            try: col, ca = parse_color(r['color'])
            except ValueError: continue
            rr = ratio(lum(px), float(lum(col)))
            v = float(np.median(rr) if r['rotated'] else np.percentile(rr, 10))
            worst = v if worst is None else min(worst, v)
            if v < cfg['minContrast']: con.append(f'{smp["scene"]} frame {f} "{r["text"]}" {r["color"]} → {v:.2f}:1')
        for gk, rs in settled_groups(frames[f]['runs']).items():
            if rs[0]['cx'] is None or abs(rs[0]['cx'] - W / 2) >= 2 or rs[0]['rotated']: continue
            x0 = max(0, min(r['box'][0] for r in rs) - 4); x1 = min(W, max(r['box'][2] for r in rs) + 4)
            y0 = max(0, min(r['box'][1] for r in rs)); y1 = min(H, max(r['box'][3] for r in rs))
            cols = np.where(mask[y0:y1, x0:x1].any(0))[0]
            if len(cols) < 4: continue
            err = (x0 + cols[0] + x0 + cols[-1] + 1) / 2 - W / 2
            if abs(err) > tol: cpx.append(f'{smp["scene"]} frame {f} "{"".join(r["text"] for r in rs)}" ink centre off by {err:+.1f}px')
        rows.append({'frame': f, 'scene': smp['scene'], 'bgMean': round(mean, 3), 'minRunContrast': worst and round(worst, 2)})
    add('contrast-runs', con, note=f'10th-percentile local contrast of every visible text run on {len(samples["samples"])} sampled frames, halo composited')
    add('center-pixels', cpx, note=f'ink extent from the text-only difference mask, ±{tol}px')
    add('edge-pixels', edge)
    add('background-brightness', bright, note=f'mean relative luminance ≥ {cfg["bgMinMean"]}')

    disclosure(root, tl, frames, samples, badge_px, add, scene_of, W, H, M, zones, vis, fps, a.draft)

    fails = [k for k, v in checks.items() if v['level'] == 'fail' and not v['passed']]
    warns = [k for k, v in checks.items() if v['level'] == 'warn' and not v['passed']]
    rep = {'passed': not fails, 'draft': a.draft, 'timelineSha256': samples['timelineSha256'], 'sourceSha256': samples.get('sourceSha256'), 'lock': tl.get('lock'), 'frames': len(frames),
           'sampleFrames': len(samples['samples']), 'failed': fails, 'warnings': warns, 'checks': checks, 'samples': rows,
           'minSampleContrast': min((r['minRunContrast'] for r in rows if r['minRunContrast']), default=None),
           'minBackgroundMean': min(r['bgMean'] for r in rows)}
    xms.write(qd / 'qa-report.json', rep)
    md = [f'# QA report — {tl["title"]}', '', f'**{"PASS" if not fails else "FAIL"}**{" (draft)" if a.draft else ""} · {len(frames)} frames logged · {len(samples["samples"])} sampled frames · '
          f'min sampled text contrast {rep["minSampleContrast"]}:1 · min background mean {rep["minBackgroundMean"]}', '', '| check | level | result | note |', '|---|---|---|---|']
    for k, v in checks.items():
        md.append(f'| {k} | {v["level"]} | {"ok" if v["passed"] else str(v["count"]) + " issue(s)"} | {v["note"]} |')
    for k, v in checks.items():
        if v['items']: md += ['', f'## {k}', ''] + [f'- {x}' for x in v['items']]
    (qd / 'qa-report.md').write_text('\n'.join(md) + '\n', encoding='utf-8')
    sheet(qd, samples['samples'], rows, tl, root)
    print(f'QA {"PASS" if not fails else "FAIL"}: ' + ', '.join(f'{k}={"ok" if v["passed"] else v["count"]}' for k, v in checks.items()))
    for k in fails + warns:
        for x in checks[k]['items'][:5]: print(f'  [{checks[k]["level"]}] {k}: {x}')
    print(f'report → {(qd / "qa-report.md").relative_to(root)} · contact sheet → {(qd / "contact-sheet.jpg").relative_to(root)}')
    sys.exit(1 if fails and not a.draft else 0)


def disclosure(root, tl, frames, samples, badge_px, add, scene_of, W, H, M, zones, vis, fps, draft):
    """Fact boundary, 示意画面 badge, chart sources, style choice."""
    sb = xms.read(root / 'storyboard.json')
    fb, bad = sb.get('factBoundary'), []
    if not isinstance(fb, dict):
        bad.append('storyboard.json has no "factBoundary" {real, illustrative, unverified, sources} — state what is sourced fact vs illustration')
    else:
        for k in ('real', 'illustrative', 'unverified', 'sources'):
            if not isinstance(fb.get(k), list):
                bad.append(f'factBoundary.{k} must be a list (use [] when empty)')
        if isinstance(fb.get('sources'), list) and not fb['sources']:
            bad.append('factBoundary.sources is empty — list the source of every factual claim')
    add('fact-boundary', bad, note='real / illustrative / unverified / sources declared in storyboard.json')

    labels = tl.get('labels') or {}
    def inside_safe(b):
        if b[0] < M - 2 or b[2] > W - M + 2 or b[1] < 0 or b[3] > H: return False
        return not any(inter(b, [z['x'], z['y'], z['x'] + z['w'], z['y'] + z['h']]) > 0 for z in zones.values())
    for role, key, check in (('badge-illustrative', 'illustrative', 'illustrative-label'),):
        miss, unsafe, nreq = {}, {}, 0
        for fr in frames:
            if not (fr.get('need') or {}).get(key): continue
            nreq += 1
            bs = [r for r in fr['runs'] if r['role'] == role and r['alpha'] >= vis]
            if not bs: miss.setdefault(scene_of(fr['frame']), []).append(fr['frame'])
            elif not all(inside_safe(r['box']) for r in bs): unsafe.setdefault(scene_of(fr['frame']), fr['frame'])
        items = [f'{s}: required 「{(labels.get(key) or {}).get("text", "")}」 missing on {len(fl)} frames, first {fl[0]} ({fl[0] / fps:.2f}s)' for s, fl in miss.items()]
        items += [f'{s}: badge outside the safe area at frame {f}' for s, f in unsafe.items()]
        for smp in samples['samples']:
            need = (frames[smp['frame']].get('need') or {}).get(key)
            px = badge_px.get(smp['frame'], {}).get(role)
            if need and px is not None and px < 40:
                items.append(f'{smp["scene"]} frame {smp["frame"]}: badge logged but only {px} label pixels visible')
        add(check, items, note=f'{nreq} frames require it (shots/elements flagged illustrative); log + sampled pixels; must sit inside the safe area')

    chart = {}
    for fr in frames:
        for c in fr.get('charts') or []:
            if not c.get('covered'): chart.setdefault((scene_of(fr['frame']), c['kind']), fr['frame'])
    add('chart-source', [f'{s}: chart-like fx "{k}" without dataSource or illustrative:true (first frame {f})' for (s, k), f in chart.items()], level='warn',
        note='candles / bars / line charts must cite real data (dataSource) or be flagged illustrative (adds 「示意画面」)')
    add('style-chosen', [] if tl.get('style') else ['storyboard.json "style" is not set — run `xms.py styles` and let the user pick'],
        level='warn' if draft else 'fail', note=f'style preset: {tl.get("style") or "(none)"}')


def sheet(qd, samples, rows, tl, root):
    tw, th, cols = 216, 384, 8
    n = len(samples); r_ = (n + cols - 1) // cols
    img = Image.new('RGB', (cols * tw, r_ * (th + 34)), (233, 229, 220)); d = ImageDraw.Draw(img)
    fp = root / tl['fonts']['regular']
    font = ImageFont.truetype(str(fp), 18) if fp.exists() else ImageFont.load_default()
    for i, smp in enumerate(samples):
        x, y = (i % cols) * tw, (i // cols) * (th + 34)
        im = Image.open(qd / 'samples' / f'{smp["frame"]}.png').convert('RGB').resize((tw - 6, th - 6), Image.LANCZOS)
        img.paste(im, (x + 3, y + 3))
        d.text((x + 6, y + th + 4), f'{smp["scene"]}  {smp["frame"] / tl["fps"]:.1f}s', fill=(22, 24, 29), font=font)
    img.save(qd / 'contact-sheet.jpg', quality=88)


if __name__ == '__main__':
    main()
