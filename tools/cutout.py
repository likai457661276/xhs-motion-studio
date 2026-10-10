#!/usr/bin/env python3
"""cutout.py — white / near-white background → transparent PNG (MIT License). Needs numpy + scipy + Pillow.

  python3 cutout.py <in.png> [--out OUT.png] [--threshold 238] [--soft 18] [--feather 1.0] [--trim] [--pad 12]
  (normally: xms.py cutout <in.png> --out assets/images/<id>.png)

How it works
  1. "whiteness" of a pixel = its darkest channel; background candidates are pixels with min(R,G,B) ≥ threshold - soft
  2. only candidates connected to the image border become background (flood fill) — white parts *inside* the subject
     (eyes, highlights, a white shirt enclosed by an outline) stay opaque
  3. alpha ramps from 0 (≥ threshold) to 1 (≤ threshold - soft) across the soft band; the 2 px anti-aliased rim gets its
     coverage estimated against the nearest ink colour (5×5 local minimum); then the edge is feathered with a
     small Gaussian restricted to the boundary region, so the outline is smooth but the interior stays fully opaque
  4. colours on semi-transparent edge pixels are un-mixed from white (removes the light halo on dark backgrounds)
  5. optional --trim crops to the subject's bounding box plus --pad pixels
Prints a short JSON report (size, subject coverage, bbox). Deterministic: same input → same bytes.
"""
import argparse, json, sys
from pathlib import Path
import numpy as np
from PIL import Image
from scipy import ndimage


def cutout(rgb, threshold=238, soft=18, feather=1.0):
    rgb = rgb.astype(np.float32)
    white = rgb.min(axis=2)                                   # 255 = pure white
    cand = white >= threshold - soft
    lab, n = ndimage.label(cand, structure=np.ones((3, 3), bool))
    border = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    bg = np.isin(lab, border[border > 0])
    # soft ramp inside the background-connected band; everything else is subject (alpha 1)
    ramp = np.clip((threshold - white) / max(soft, 1e-6), 0, 1)
    alpha = np.where(bg, ramp, 1.0).astype(np.float32)
    # anti-aliased rim (2 px next to the background): estimate coverage against the nearby ink colour,
    # so a grey rim pixel between a dark outline and white becomes partially transparent instead of a light halo
    ring = ndimage.binary_dilation(bg, iterations=2) & ~bg
    ink = ndimage.minimum_filter(white, size=5)
    alpha = np.where(ring, np.clip((255.0 - white) / np.maximum(255.0 - ink, 1.0), 0, 1), alpha).astype(np.float32)
    if feather > 0:
        edge = ndimage.binary_dilation(bg, iterations=3) & ndimage.binary_dilation(~bg, iterations=3)
        blurred = ndimage.gaussian_filter(alpha, feather)
        alpha = np.where(edge, np.minimum(alpha, blurred), alpha)  # only soften inward: never re-adds white fringe
        alpha = np.where(~bg & ~edge, 1.0, alpha)
    alpha = np.clip(alpha, 0, 1)
    # un-mix from white: observed = a·fg + (1-a)·255  →  fg = (observed - (1-a)·255) / a
    a3 = alpha[..., None]
    fg = np.where(a3 > 0.02, (rgb - (1 - a3) * 255.0) / np.maximum(a3, 0.02), rgb)
    out = np.dstack([np.clip(fg, 0, 255), alpha * 255]).round().astype(np.uint8)
    out[alpha <= 0.004] = 0
    return out, bg


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('src'); ap.add_argument('--out')
    ap.add_argument('--threshold', type=float, default=238, help='min(R,G,B) at/above which a border-connected pixel is fully transparent')
    ap.add_argument('--soft', type=float, default=18, help='width of the alpha ramp below the threshold')
    ap.add_argument('--feather', type=float, default=1.0, help='edge feather (Gaussian sigma, px); 0 = off')
    ap.add_argument('--trim', action='store_true', help='crop to the subject bounding box')
    ap.add_argument('--pad', type=int, default=12, help='padding kept around the bbox with --trim')
    a = ap.parse_args()
    src = Path(a.src)
    im = Image.open(src)
    if im.mode == 'RGBA' and np.asarray(im)[..., 3].min() < 255:
        print(f'note: {src.name} already has transparency; compositing on white before cutting', file=sys.stderr)
    base = Image.new('RGB', im.size, (255, 255, 255)); base.paste(im.convert('RGBA'), mask=im.convert('RGBA').split()[3])
    out, bg = cutout(np.asarray(base), a.threshold, a.soft, a.feather)
    ys, xs = np.nonzero(out[..., 3] > 8)
    if not len(xs):
        sys.exit('cutout: nothing left — the whole image is near-white (lower --threshold?)')
    box = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
    res = Image.fromarray(out, 'RGBA')
    if a.trim:
        p = a.pad; box = [max(0, box[0] - p), max(0, box[1] - p), min(res.width, box[2] + p), min(res.height, box[3] + p)]
        res = res.crop(box)
    dest = Path(a.out) if a.out else src.with_name(src.stem + '-cutout.png')
    dest.parent.mkdir(parents=True, exist_ok=True)
    res.save(dest, optimize=True)
    border_alpha = np.concatenate([out[0, :, 3], out[-1, :, 3], out[:, 0, 3], out[:, -1, 3]])
    rep = {'in': str(src), 'out': str(dest), 'size': list(res.size), 'subjectCoverage': round(float((out[..., 3] > 128).mean()), 4),
           'bbox': box, 'borderOpaquePixels': int((border_alpha > 128).sum())}
    if rep['borderOpaquePixels']:
        print('warning: the subject touches the image border — background was probably not plain white there', file=sys.stderr)
    print(json.dumps(rep, ensure_ascii=False))


if __name__ == '__main__':
    main()
