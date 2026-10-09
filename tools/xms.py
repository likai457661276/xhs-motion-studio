#!/usr/bin/env python3
"""xms — XHS Motion Studio pipeline CLI (MIT License). Standard library only.

  init      <proj> [--theme T] [--title S]   scaffold a project (templates + lib + fonts)
  fonts     <proj>                           extract Noto Sans CJK SC Regular/Bold faces into <proj>/fonts (needs fontTools)
  update-lib <proj>                          refresh <proj>/lib from this kit
  timeline  <proj> [--draft]                 compile storyboard.json → build/timeline.json (final, needs a current lock) or .xms/draft/timeline.json
  lock      <proj> [--note S]                hash every asset in assets.json into a new append-only lock version
  status    <proj>                           show lock state and asset drift
  check     <proj> [--json]                  final-build gate: lock exists and matches the files on disk
  bgm       <proj> [args]                    generate original music (tools/bgm.py)
  beats     <proj> [args]                    beat-grid check (tools/beatgrid.py)
  draft     <proj> [--workers N]             fast iteration render: unlocked assets, writes .xms/draft/draft.mp4
  preview   <proj> [--draft]                 stills (start/mid/end per scene) + determinism check
  render    <proj> [--workers N] [--resume] [--jpeg]  final parallel render → build/silent.mp4 (PNG capture; --jpeg = faster JPEG q.94)
  qa        <proj> [--draft]                 automated QA → build/qa/qa-report.{json,md} + contact sheet
  cover     <proj> --frame N [--crop-y Y]    3:4 cover still → build/cover-3x4.png (auto crop keeps the text in frame)
  serve     <proj> [--draft] [--port P]      interactive browser preview on 127.0.0.1 (scrub frames, play with music)
  mix       <proj> [--draft]                 loudness-normalised music bed (-16 LUFS, TP -1.5)
  finish    <proj> [--out FILE]              mux H.264 + AAC (faststart) after verifying render/mix bindings, then validate
  validate  <file> [--project P]             technical delivery checks
"""
import argparse, datetime, hashlib, json, os, re, shutil, subprocess, sys
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
BOARD_SCHEMA, TL_SCHEMA, ASSET_SCHEMA = 'xms/storyboard-v1', 'xms/timeline-v1', 'xms/assets-v1'
MEDIA_EXT = {'.otf', '.ttf', '.woff', '.woff2', '.wav', '.mp3', '.m4a', '.flac', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif'}


class XmsError(Exception):
    pass


def read(p):
    with open(p, encoding='utf-8') as fh:
        return json.load(fh)


def write(p, v):
    Path(p).parent.mkdir(parents=True, exist_ok=True)
    Path(p).write_text(json.dumps(v, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def run(cmd, **kw):
    return subprocess.run([str(c) for c in cmd], check=True, **kw)


def py():
    return os.environ.get('XMS_PYTHON') or sys.executable


def inside(root, rel):
    p = (root / rel).resolve()
    base = root.resolve()
    if p != base and base not in p.parents:
        raise XmsError(f'path escapes project: {rel}')
    return p


# ---------------------------------------------------------------- film / timeline
def load_film(root):
    f = read(root / 'storyboard.json')
    if f.get('schema') != BOARD_SCHEMA:
        raise XmsError(f'storyboard.json schema must be {BOARD_SCHEMA}')
    themes = read(KIT / 'lib/themes.json')
    preset = themes['presets'].get(f.get('preset', 'xhs-9x16'))
    if not preset:
        raise XmsError(f'unknown preset {f.get("preset")}')
    f.setdefault('preset', 'xhs-9x16'); f.setdefault('theme', 'editorial-amber')
    if f['theme'] not in themes['themes']:
        raise XmsError(f'unknown theme {f["theme"]}; available: {", ".join(themes["themes"])}')
    f.setdefault('width', preset['width']); f.setdefault('height', preset['height']); f.setdefault('fps', preset.get('fps', 30))
    f.setdefault('seed', 42)
    f.setdefault('fonts', {'regular': 'fonts/NotoSansCJKsc-Regular.otf', 'bold': 'fonts/NotoSansCJKsc-Bold.otf'})
    if f['width'] % 2 or f['height'] % 2:
        raise XmsError('width/height must be even')
    ids = set()
    if not f.get('scenes'):
        raise XmsError('storyboard.json has no scenes')
    for s in f['scenes']:
        sid = s.get('id', '')
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', sid) or sid in ids:
            raise XmsError(f'scene id must be unique kebab-case: {sid!r}')
        ids.add(sid)
        sec = s.get('seconds')
        if not isinstance(sec, (int, float)) or sec <= 0:
            raise XmsError(f'{sid}.seconds must be > 0')
        for h in s.get('hits', []):
            if not 0 <= h < sec:
                raise XmsError(f'{sid}: hit {h} outside [0, {sec})')
        for h in s.get('heavy', []):
            if h not in s.get('hits', []):
                raise XmsError(f'{sid}: heavy {h} must also be listed in hits')
    return f


def media_paths(film):
    out = [film['fonts']['regular'], film['fonts']['bold']]
    if film.get('music', {}).get('file'):
        out.append(film['music']['file'])
    out += film.get('media', [])
    return out


def compile_timeline(root, draft=False):
    film = load_film(root)
    lock = None if draft else gate(root)
    fps, cur, scenes, cues, heavy = film['fps'], 0, [], [], []
    for i, s in enumerate(film['scenes']):
        n = round(s['seconds'] * fps)
        if abs(n - s['seconds'] * fps) > 1e-6:
            print(f'warning: {s["id"]}.seconds × fps is not an integer; rounded to {n} frames', file=sys.stderr)
        start = cur / fps
        item = dict(s, startFrame=cur, durationFrames=n, endFrame=cur + n, start=start)
        scenes.append(item)
        if i:
            cues.append({'t': start, 'kind': 'cut', 'scene': s['id']})
        for h in s.get('hits', []):
            cues.append({'t': round(start + h, 6), 'kind': 'heavy' if h in s.get('heavy', []) else 'hit', 'scene': s['id']})
        heavy += [round(start + h, 6) for h in s.get('heavy', [])]
        cur += n
    music = film.get('music', {})
    tl = {'schema': TL_SCHEMA, 'mode': 'draft' if draft else 'final', 'filmSha256': sha(root / 'storyboard.json'), 'lock': lock,
          'title': film.get('title', ''), 'preset': film['preset'], 'theme': film['theme'], 'themeOverrides': film.get('themeOverrides', {}),
          'width': film['width'], 'height': film['height'], 'fps': fps, 'seed': film['seed'], 'fonts': film['fonts'], 'music': music,
          'totalFrames': cur, 'durationSeconds': cur / fps, 'scenes': scenes, 'cues': cues, 'heavyAbs': heavy,
          'previewAudio': 'preview-audio.wav' if music.get('file') else None}
    out = root / ('.xms/draft/timeline.json' if draft else 'build/timeline.json')
    write(out, tl)
    return tl, out


# ---------------------------------------------------------------- asset lock (append-only versions)
def asset_list(root):
    p = root / 'assets.json'
    if not p.exists():
        raise XmsError('assets.json missing')
    a = read(p)
    if a.get('schema') != ASSET_SCHEMA:
        raise XmsError(f'assets.json schema must be {ASSET_SCHEMA}')
    seen = set()
    for x in a['assets']:
        if x['path'] in seen:
            raise XmsError(f'duplicate asset {x["path"]}')
        seen.add(x['path'])
        for k in ('license', 'source'):
            if not str(x.get(k) or '').strip():
                raise XmsError(f'{x["path"]}: "{k}" is required (use "original" for self-made assets)')
    return a['assets']


def current_state(root):
    rows = []
    for x in asset_list(root):
        p = inside(root, x['path'])
        rows.append({'path': x['path'], 'sha256': sha(p) if p.is_file() else None, 'bytes': p.stat().st_size if p.is_file() else 0,
                     'license': x['license'], 'source': x['source']})
    return sorted(rows, key=lambda r: r['path'])


def head(root):
    p = root / '.xms/lock.json'
    if not p.exists():
        return None, None
    ptr = read(p)
    lock_file = root / '.xms/locks' / f'{ptr["version"]}.json'
    if not lock_file.exists() or sha(lock_file) != ptr['sha256']:
        raise XmsError('lock history damaged (pointer/hash mismatch); restore .xms/locks from backup — never rewrite it')
    return ptr, read(lock_file)


def diff(old, new):
    o = {r['path']: r for r in (old or [])}; n = {r['path']: r for r in new}; out = []
    for k in sorted(o.keys() | n.keys()):
        a, b = o.get(k), n.get(k)
        if a is None: out.append({'path': k, 'change': 'added', 'new': b['sha256']})
        elif b is None: out.append({'path': k, 'change': 'removed', 'old': a['sha256']})
        else:
            for f in ('sha256', 'license', 'source'):
                if a[f] != b[f]:
                    out.append({'path': k, 'change': f, 'old': a[f], 'new': b[f]})
    return out


def missing_declarations(root, film):
    declared = {x['path'] for x in asset_list(root)}
    return [p for p in media_paths(film) if p not in declared]


def lock(root, note):
    film = load_film(root)
    miss = missing_declarations(root, film)
    if miss:
        raise XmsError(f'declare these media in assets.json first: {miss}')
    state = current_state(root)
    absent = [r['path'] for r in state if not r['sha256']]
    if absent:
        raise XmsError(f'asset files missing: {absent}')
    ptr, prev = head(root)
    d = diff(prev['assets'] if prev else None, state)
    if prev and not d:
        print(f'unchanged: lock {ptr["version"]} already matches'); return ptr
    version = f'v{(int(ptr["version"][1:]) + 1) if ptr else 1:04d}'
    rec = {'schema': 'xms/lock-v1', 'version': version, 'parent': ptr, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
           'note': note or ('initial lock' if not prev else 'asset update'), 'assets': state, 'diff': d}
    lf = root / '.xms/locks' / f'{version}.json'
    if lf.exists():
        raise XmsError(f'{lf} already exists; refusing to overwrite history')
    write(lf, rec)
    ptr = {'version': version, 'sha256': sha(lf)}
    write(root / '.xms/lock.json', ptr)
    for row in d:
        print(f'  {row["change"]:8} {row["path"]}')
    print(f'locked {version} ({len(state)} assets)')
    return ptr


def gate(root):
    """Final-build gate. Returns the lock pointer; raises with a readable diff if files drifted."""
    film = load_film(root)
    ptr, rec = head(root)
    if not ptr:
        raise XmsError('no asset lock yet: iterate with --draft, then run `xms.py lock <proj>` before final builds')
    miss = missing_declarations(root, film)
    if miss:
        raise XmsError(f'media used by storyboard.json but not declared in assets.json: {miss}')
    d = diff(rec['assets'], current_state(root))
    if d:
        rows = '\n'.join(f'  {r["change"]:8} {r["path"]}' for r in d)
        raise XmsError(f'assets differ from lock {ptr["version"]}:\n{rows}\nreview the change, then `xms.py lock <proj> --note "..."` to record a new version')
    return ptr


# ---------------------------------------------------------------- audio
def loudnorm(src_filter_inputs, filt, out, dur, target=-16.0, tp=-1.5, lra=11.0):
    base = ['ffmpeg', '-hide_banner', '-y'] + src_filter_inputs
    first = subprocess.run(base + ['-filter_complex', f'{filt},loudnorm=I={target}:TP={tp}:LRA={lra}:print_format=json[o]', '-map', '[o]', '-f', 'null', '-'],
                           capture_output=True, text=True, check=True).stderr
    m = json.loads(first[first.rindex('{'):first.rindex('}') + 1])
    ln = (f'loudnorm=I={target}:TP={tp}:LRA={lra}:measured_I={m["input_i"]}:measured_TP={m["input_tp"]}:measured_LRA={m["input_lra"]}'
          f':measured_thresh={m["input_thresh"]}:offset={m["target_offset"]}:linear=true')
    run(base + ['-filter_complex', f'{filt},{ln},aresample=48000[o]', '-map', '[o]', '-t', f'{dur:.6f}', '-ac', '2', '-c:a', 'pcm_s16le', out], capture_output=True)
    return m


def mix(root, draft=False):
    if draft:
        tl, tlp = compile_timeline(root, True); out = root / '.xms/draft/mix.wav'
    else:
        tl, tlp = compile_timeline(root, False); out = root / 'build/mix.wav'
    music = tl.get('music') or {}
    dur = tl['durationSeconds']
    os.makedirs(out.parent, exist_ok=True)
    if music.get('file'):
        src = inside(root, music['file'])
        if not src.exists():
            raise XmsError(f'music file missing: {music["file"]} (run `xms.py bgm`)')
        inputs = ['-i', str(src)]
        filt = f'[0:a]aresample=48000,aformat=channel_layouts=stereo,volume={music.get("gain", 1.0)},lowpass=f=16000:p=2,apad=whole_dur={dur:.6f},atrim=0:{dur:.6f}'
        m = loudnorm(inputs, filt, out, dur)
    else:
        run(['ffmpeg', '-hide_banner', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', f'{dur:.6f}', '-c:a', 'pcm_s16le', out], capture_output=True); m = None
    rep = {'timelineSha256': sha(tlp), 'lock': tl['lock'], 'input': music.get('file'), 'inputSha256': sha(inside(root, music['file'])) if music.get('file') else None,
           'mixSha256': sha(out), 'durationSeconds': dur, 'loudnormFirstPass': m}
    write(out.with_name('mix-report.json'), rep)
    print(f'mix → {out.relative_to(root)}')
    return rep


# ---------------------------------------------------------------- delivery
def moov_first(path):
    with open(path, 'rb') as f:
        off = 0
        size_total = os.path.getsize(path)
        while off < size_total:
            f.seek(off); hdr = f.read(16)
            if len(hdr) < 8: break
            size = int.from_bytes(hdr[:4], 'big'); kind = hdr[4:8].decode('latin1')
            if size == 1: size = int.from_bytes(hdr[8:16], 'big')
            if kind == 'moov': return True
            if kind == 'mdat': return False
            if size < 8: break
            off += size
    return False


def validate(path, root=None):
    path = Path(path)
    m = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)]))
    v = next(s for s in m['streams'] if s['codec_type'] == 'video'); a = next((s for s in m['streams'] if s['codec_type'] == 'audio'), None)
    problems = []
    tl = read(root / 'build/timeline.json') if root else None
    if v['codec_name'] != 'h264': problems.append(f'video codec {v["codec_name"]} != h264')
    if v.get('pix_fmt') != 'yuv420p': problems.append(f'pix_fmt {v.get("pix_fmt")} != yuv420p')
    if not a or a['codec_name'] != 'aac': problems.append('audio stream must be AAC')
    if not moov_first(path): problems.append('moov atom is not before mdat (no faststart)')
    if tl:
        if (v['width'], v['height']) != (tl['width'], tl['height']): problems.append(f'size {v["width"]}x{v["height"]} != {tl["width"]}x{tl["height"]}')
        if v['r_frame_rate'] != f'{tl["fps"]}/1': problems.append(f'fps {v["r_frame_rate"]} != {tl["fps"]}/1')
        if int(v.get('nb_frames', -1)) != tl['totalFrames']: problems.append(f'frames {v.get("nb_frames")} != {tl["totalFrames"]}')
        for s in (v, a):
            if s and abs(float(s['duration']) - tl['durationSeconds']) > max(1 / tl['fps'], .05): problems.append(f'{s["codec_type"]} duration {s["duration"]} != {tl["durationSeconds"]}')
    dec = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'null', '-'], capture_output=True, text=True)
    if dec.stderr.strip(): problems.append('decode errors: ' + dec.stderr.strip()[:400])
    loud = subprocess.run(['ffmpeg', '-hide_banner', '-i', str(path), '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
    I = re.findall(r'I:\s+(-?[\d.]+) LUFS', loud); P = re.findall(r'Peak:\s+(-?[\d.]+) dBFS', loud)
    peak = float(P[-1]) if P else None
    if peak is not None and peak > -1.0: problems.append(f'true peak {peak} dBTP > -1.0 (AAC overshoot / clipping risk)')
    rep = {'file': str(path), 'passed': not problems, 'problems': problems, 'sizeBytes': path.stat().st_size, 'durationSeconds': float(m['format']['duration']),
           'video': {k: v.get(k) for k in ('codec_name', 'profile', 'pix_fmt', 'width', 'height', 'r_frame_rate', 'nb_frames', 'bit_rate')},
           'audio': a and {k: a.get(k) for k in ('codec_name', 'sample_rate', 'channels', 'bit_rate')},
           'loudnessLUFS': float(I[-1]) if I else None, 'truePeakDbfs': peak, 'faststart': moov_first(path)}
    if root: write(root / 'build/delivery-report.json', rep)
    print(('PASS' if not problems else 'FAIL') + f'  {path}  {rep["durationSeconds"]:.3f}s  {rep["sizeBytes"] / 1e6:.1f} MB  LUFS {rep["loudnessLUFS"]}  peak {peak}')
    for p in problems: print('  - ' + p)
    if problems: raise XmsError('validation failed')
    return rep


def finish(root, out=None):
    gate(root)
    tl, tlp = compile_timeline(root, False)
    r = read(root / 'build/render-report.json')
    if r.get('mode') != 'render' or r.get('timelineSha256') != sha(tlp):
        raise XmsError('render is stale (timeline changed): run `xms.py render`')
    if r.get('lock') != tl['lock']:
        raise XmsError('render was made against another lock version: re-render')
    for rel, h in r['sourceSha256'].items():
        if sha(inside(root, rel)) != h:
            raise XmsError(f'source changed since render: {rel} → re-render')
    qa = root / 'build/qa/qa-report.json'
    if not qa.exists() or read(qa).get('timelineSha256') != sha(tlp) or read(qa).get('draft'):
        raise XmsError('no final QA report for this timeline: run `xms.py qa <proj>`')
    if read(qa).get('sourceSha256') != r['sourceSha256']:
        raise XmsError('QA was run on different code/assets than the render: rerun `xms.py qa <proj>`')
    if not read(qa)['passed']:
        raise XmsError(f'QA failed ({", ".join(read(qa)["failed"])}): see build/qa/qa-report.md')
    silent = root / 'build/silent.mp4'
    if sha(silent) != r['videoSha256']:
        raise XmsError('build/silent.mp4 does not match the render report')
    mr = root / 'build/mix-report.json'
    if not mr.exists() or read(mr).get('timelineSha256') != sha(tlp) or read(mr).get('mixSha256') != sha(root / 'build/mix.wav') or \
            (tl['music'].get('file') and read(mr).get('inputSha256') != sha(inside(root, tl['music']['file']))):
        mix(root)
    final = root / 'build/final.mp4'
    run(['ffmpeg', '-hide_banner', '-y', '-v', 'error', '-i', silent, '-i', root / 'build/mix.wav', '-map', '0:v:0', '-map', '1:a:0',
         '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', final])
    rep = validate(final, root)
    write(root / 'build/finalization.json', {'finalSha256': sha(final), 'renderReportSha256': sha(root / 'build/render-report.json'),
                                             'mixSha256': sha(root / 'build/mix.wav'), 'lock': tl['lock'], 'timelineSha256': sha(tlp)})
    if out:
        shutil.copy2(final, out); print(f'copied → {out}')
    return rep


# ---------------------------------------------------------------- scaffolding
def fonts(root):
    try:
        from fontTools.ttLib import TTCollection
    except ImportError:
        raise XmsError('fontTools is required for `fonts` (pip install fonttools), or copy SC .otf files into fonts/ yourself')
    src_dir = Path(os.environ.get('XMS_NOTO_DIR', '/usr/share/fonts/opentype/noto'))
    (root / 'fonts').mkdir(exist_ok=True)
    for weight, ttc, out in (('Regular', 'NotoSansCJK-Regular.ttc', 'NotoSansCJKsc-Regular.otf'), ('Bold', 'NotoSansCJK-Bold.ttc', 'NotoSansCJKsc-Bold.otf')):
        dst = root / 'fonts' / out
        if dst.exists():
            continue
        coll = TTCollection(str(src_dir / ttc))
        face = next((f for f in coll.fonts if 'CJK SC' in (f['name'].getDebugName(1) or '')), None)
        if face is None:
            raise XmsError(f'no "CJK SC" face in {src_dir / ttc}')
        face.save(str(dst)); print(f'font → fonts/{out}')
    a = read(root / 'assets.json')
    have = {x['path'] for x in a['assets']}
    for out in ('NotoSansCJKsc-Regular.otf', 'NotoSansCJKsc-Bold.otf'):
        if f'fonts/{out}' not in have:
            a['assets'].append({'path': f'fonts/{out}', 'license': 'SIL Open Font License 1.1', 'source': 'https://github.com/notofonts/noto-cjk',
                                'note': f'SC face extracted from the system Noto Sans CJK collection ({src_dir})'})
    write(root / 'assets.json', a)


def update_lib(root):
    (root / 'lib').mkdir(exist_ok=True)
    for f in ('xms-core.js', 'xms-type.js', 'xms-fx.js', 'themes.json'):
        shutil.copy2(KIT / 'lib' / f, root / 'lib' / f)
    print('lib updated')


def init(root, theme, title):
    if root.is_dir() and next(root.iterdir(), None) is not None:
        raise XmsError(f'{root} is not empty')
    root.mkdir(parents=True, exist_ok=True)
    for name in ('index.html', 'shots.js', 'qa.config.json'):
        shutil.copy2(KIT / 'templates' / name, root / name)
    shutil.copy2(KIT / 'templates/project.gitignore', root / '.gitignore')
    film = read(KIT / 'templates/storyboard.json')
    if theme: film['theme'] = theme
    if title: film['title'] = title
    write(root / 'storyboard.json', film)
    write(root / 'assets.json', {'schema': ASSET_SCHEMA, 'assets': []})
    (root / 'audio').mkdir(); update_lib(root)
    try:
        fonts(root)
    except XmsError as e:
        print('note:', e)
    print(f'project ready: {root}\nnext: edit storyboard.json + shots.js → xms.py bgm → xms.py draft (iterate) → xms.py lock → preview/qa/render/finish')


def node_tool(args):
    run(['node', KIT / 'tools/xms-render.cjs'] + args)


def main():
    sys.stdout.reconfigure(line_buffering=True)  # keep our lines in order with the node renderer's output
    ap = argparse.ArgumentParser(prog='xms', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('cmd'); ap.add_argument('target')
    ap.add_argument('--draft', action='store_true'); ap.add_argument('--json', action='store_true')
    ap.add_argument('--note'); ap.add_argument('--out'); ap.add_argument('--theme'); ap.add_argument('--title'); ap.add_argument('--project')
    ap.add_argument('--workers'); ap.add_argument('--resume', action='store_true'); ap.add_argument('--lossless', action='store_true'); ap.add_argument('--jpeg', action='store_true'); ap.add_argument('--frame'); ap.add_argument('--port'); ap.add_argument('--crop-y')
    a, rest = ap.parse_known_args()
    root = Path(a.target).resolve()
    extra = (['--workers', a.workers] if a.workers else []) + (['--resume'] if a.resume else []) + (['--lossless'] if a.lossless else []) + (['--jpeg'] if a.jpeg else [])
    c = a.cmd
    if c == 'init': init(root, a.theme, a.title)
    elif c == 'fonts': fonts(root)
    elif c == 'update-lib': update_lib(root)
    elif c == 'timeline':
        tl, out = compile_timeline(root, a.draft); print(f'{tl["mode"]} timeline → {out.relative_to(root)}: {tl["totalFrames"]} frames / {tl["durationSeconds"]:.3f}s')
    elif c == 'lock': lock(root, a.note)
    elif c == 'status':
        ptr, rec = head(root); print('lock:', ptr['version'] if ptr else 'none')
        for r in diff(rec['assets'] if rec else None, current_state(root)): print(f'  {r["change"]:8} {r["path"]}')
    elif c == 'check':
        ptr = gate(root)
        print(json.dumps({'ok': True, 'lock': ptr, 'assets': {r['path']: r['sha256'] for r in current_state(root)}}) if a.json else f'ok: lock {ptr["version"]} matches')
    elif c == 'bgm': run([py(), KIT / 'tools/bgm.py', root] + rest)
    elif c == 'beats': run([py(), KIT / 'tools/beatgrid.py', root] + rest)
    elif c == 'draft':
        compile_timeline(root, True); mix(root, True); node_tool([root, '--mode', 'render', '--draft'] + extra)
    elif c == 'preview':
        compile_timeline(root, a.draft); node_tool([root, '--mode', 'preview'] + (['--draft'] if a.draft else []) + extra)
    elif c == 'render':
        compile_timeline(root, False); node_tool([root, '--mode', 'render'] + extra)
    elif c == 'qa':
        compile_timeline(root, a.draft); node_tool([root, '--mode', 'qa'] + (['--draft'] if a.draft else []) + extra)
        run([py(), KIT / 'tools/qa.py', root] + (['--draft'] if a.draft else []) + rest)
    elif c == 'cover':
        compile_timeline(root, a.draft); node_tool([root, '--mode', 'cover', '--frame', a.frame or '0'] + (['--crop-y', a.crop_y] if a.crop_y else []) + (['--draft'] if a.draft else []))
    elif c == 'serve':
        compile_timeline(root, a.draft)
        if a.draft and not (root / '.xms/draft/mix.wav').exists() and (root / 'storyboard.json').exists() and load_film(root).get('music', {}).get('file'):
            try: mix(root, True)
            except XmsError as e: print('note: no preview audio:', e)
        node_tool([root, '--mode', 'serve'] + (['--draft'] if a.draft else []) + (['--port', a.port] if a.port else []))
    elif c == 'mix': mix(root, a.draft)
    elif c == 'finish': finish(root, a.out)
    elif c == 'validate': validate(Path(a.target), Path(a.project).resolve() if a.project else None)
    else: ap.error(f'unknown command {c}')


if __name__ == '__main__':
    try:
        main()
    except (XmsError, subprocess.CalledProcessError, FileNotFoundError, KeyError, ValueError) as e:
        sys.exit(f'xms: error: {e}')
