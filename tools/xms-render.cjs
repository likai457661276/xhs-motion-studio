#!/usr/bin/env node
/* xms-render.cjs — XHS Motion Studio frame renderer (MIT License).
 * node xms-render.cjs <project> --mode preview|render|qa|cover|serve|styles [--draft] [--workers N] [--chunk 150] [--resume] [--quality .94] [--jpeg|--lossless] [--frame N]
 *   capture: final renders use lossless PNG frames, drafts use JPEG q.94 (faster); override with --jpeg / --lossless
 *   styles: --frame N --styles a,b,c --out sheet.png — the same frame under each style preset, composed into one labelled sheet
 * Normally invoked through `xms.py`, which compiles the timeline first.
 *
 * Design: one localhost-only static server per run; N independent headless browsers; each frame is drawn by
 * window.xmsRenderFrame(f) and captured in-page with canvas.toBlob (JPEG for video, PNG for stills/QA); frames are
 * streamed into one ffmpeg per chunk (resumable), chunks are joined with stream copy.
 */
'use strict';
const fs = require('fs'), fsp = fs.promises, path = require('path'), http = require('http'), os = require('os'), crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const RENDER_VERSION = 'xms-render-1';

/* ---------- args ---------- */
const argv = process.argv.slice(2), opt = { mode: 'preview', port: 0, workers: Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))), chunk: 150, quality: .94 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) { opt.project = a; continue; }
  const k = a.slice(2);
  if (['draft', 'resume', 'lossless', 'jpeg'].includes(k)) opt[k] = true; else opt[k] = argv[++i];
}
if (!opt.project) { console.error('usage: xms-render.cjs <project> --mode preview|render|qa|cover'); process.exit(2); }
const ROOT = path.resolve(opt.project), DRAFT = !!opt.draft, LOSSLESS = opt.lossless || (!DRAFT && !opt.jpeg),  /* final: PNG capture; draft: JPEG */ WORKERS = +opt.workers, CHUNK = +opt.chunk, Q = +opt.quality;
const OUT = DRAFT ? path.join(ROOT, '.xms/draft') : path.join(ROOT, 'build');
const TL_FILE = path.join(OUT, 'timeline.json');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const shaFile = f => sha(fs.readFileSync(f));
const log = (...a) => console.log('[xms]', ...a);

/* ---------- playwright / chrome discovery ---------- */
function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_MODULE, 'playwright-core', 'playwright'];
  const rt = '/var/tmp/sand-playwright-runtime';
  if (fs.existsSync(rt)) for (const d of fs.readdirSync(rt)) tries.push(path.join(rt, d, 'node_modules/playwright-core'));
  for (const t of tries) { if (!t) continue; try { const m = require(t); if (m.chromium) return m; } catch (_) {} }
  throw Error('playwright-core not found: npm i playwright-core (project-local) or set PLAYWRIGHT_MODULE');
}
const CHROME = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => fs.existsSync(p));

/* ---------- localhost static server ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.otf': 'font/otf', '.ttf': 'font/ttf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif' };
const MEDIA = new Set(['.otf', '.ttf', '.woff', '.woff2', '.wav', '.mp3', '.m4a', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif']);
function serve(lockAssets) {
  const served = new Map(), errors = [];
  const routes = { '/timeline.json': TL_FILE, '/preview-audio.wav': path.join(OUT, 'mix.wav') };
  const srv = http.createServer(async (req, res) => {
    const deny = (c, m) => { res.writeHead(c, { 'content-type': 'text/plain' }); res.end(m); };
    const ra = req.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ra)) return deny(403, 'local only');
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'read only');
    let u; try { u = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return deny(400, 'bad url'); }
    if (u === '/') u = '/index.html';
    let file = routes[u];
    if (!file) {
      if (u.split('/').some(seg => seg.startsWith('.')) || u.includes('\0')) return deny(403, 'hidden path');
      file = path.resolve(ROOT, '.' + u);
      if (!file.startsWith(ROOT + path.sep)) return deny(403, 'outside project');
      if (/^\/(build|node_modules)\//.test(u)) return deny(403, 'not servable');
    }
    const ext = path.extname(file).toLowerCase();
    if (!TYPES[ext]) return deny(403, 'type not allowed');
    let buf; try { buf = await fsp.readFile(file); } catch { return deny(404, 'not found'); }
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (!routes[u]) {
      served.set(rel, sha(buf));
      if (lockAssets && MEDIA.has(ext)) {
        if (!(rel in lockAssets)) errors.push(`undeclared media served: ${rel}`);
        else if (lockAssets[rel] !== served.get(rel)) errors.push(`media differs from lock: ${rel}`);
      }
    }
    res.writeHead(200, { 'content-type': TYPES[ext], 'cache-control': 'no-store', 'content-length': buf.length });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
  return new Promise(ok => srv.listen(+opt.port || 0, '127.0.0.1', () => ok({ srv, url: `http://127.0.0.1:${srv.address().port}/index.html?export=1`, served, errors })));
}

/* ---------- browsers ---------- */
async function openWorker(pw, url, i) {
  const browser = await pw.chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-gpu', '--force-color-profile=srgb', '--font-render-hinting=none',
    '--disable-lcd-text', '--hide-scrollbars', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  const page = await browser.newPage({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 1 });
  const errs = []; page.on('pageerror', e => errs.push(String(e))); page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => window.__xmsReady || window.__xmsBootError, null, { timeout: 120000 });
  const be = await page.evaluate(() => window.__xmsBootError || null);
  if (be) throw Error(`worker ${i} boot failed: ${be}`);
  const meta = await page.evaluate(() => ({ ...window.__xmsMeta, themeIssues: XMS.themeIssues, ua: navigator.userAgent }));
  return { browser, page, errs, meta, i };
}
const b64 = s => Buffer.from(s, 'base64');

/* ---------- ffmpeg chunk encoder ---------- */
function encoder(out, fps, draft) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', LOSSLESS ? 'png' : 'mjpeg', '-i', '-',
    '-vf', LOSSLESS ? 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p' : 'scale=in_color_matrix=bt601:out_color_matrix=bt709:in_range=pc:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-preset', draft ? 'veryfast' : 'medium', '-crf', draft ? '23' : '18', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-r', String(fps), '-an', out];
  const p = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = ''; p.stderr.on('data', d => err += d);
  const done = new Promise((ok, bad) => p.on('close', c => c === 0 ? ok() : bad(Error('ffmpeg failed: ' + err))));
  return { write: buf => p.stdin.write(buf) ? null : new Promise(r => p.stdin.once('drain', r)), end: () => { p.stdin.end(); return done; } };
}

function check(cmd, args) { return execFileSync(cmd, args, { encoding: 'utf8' }); }

async function main() {
  if (!fs.existsSync(TL_FILE)) throw Error(`${path.relative(ROOT, TL_FILE)} missing; run xms.py timeline${DRAFT ? ' --draft' : ''}`);
  const tl = JSON.parse(fs.readFileSync(TL_FILE, 'utf8'));
  if (tl.mode !== (DRAFT ? 'draft' : 'final')) throw Error(`timeline mode ${tl.mode} does not match ${DRAFT ? 'draft' : 'final'} run`);
  let lockAssets = null;
  if (!DRAFT) {
    const xms = path.join(__dirname, 'xms.py');
    const r = JSON.parse(check(process.env.XMS_PYTHON || 'python3', [xms, 'check', ROOT, '--json']));
    if (JSON.stringify(r.lock) !== JSON.stringify(tl.lock)) throw Error('timeline was compiled against another lock version; recompile');
    lockAssets = r.assets;
  }
  if (opt.mode === 'serve') {  // interactive preview with the same routing as the renderer (Ctrl-C to stop)
    const { url } = await serve(null);
    log(`preview: ${url.replace('?export=1', '')}  (${DRAFT ? 'draft' : 'final'} timeline; localhost only; Ctrl-C to stop)`);
    return new Promise(() => {});
  }
  const pw = loadPlaywright();
  const { srv, url, served, errors } = await serve(lockAssets);
  const styleList = opt.mode === 'styles' ? String(opt.styles || '').split(',').filter(Boolean) : null;
  const n = styleList ? styleList.length : opt.mode === 'cover' ? 1 : opt.mode === 'preview' ? Math.max(2, Math.min(WORKERS, 2)) : WORKERS;
  const t0 = Date.now();
  const workers = await Promise.all(Array.from({ length: n }, (_, i) => openWorker(pw, styleList ? `${url}&style=${encodeURIComponent(styleList[i])}` : url, i)));
  const meta = workers[0].meta;
  if (meta.totalFrames !== tl.totalFrames) throw Error('page meta disagrees with timeline');
  if (meta.themeIssues && meta.themeIssues.length) log('warning: theme contrast issues', JSON.stringify(meta.themeIssues));
  const bootMs = Date.now() - t0;
  const guard = () => { if (errors.length) throw Error(errors.join('\n')); for (const w of workers) if (w.errs.length) throw Error(`page error (worker ${w.i}): ${w.errs[0]}`); };
  const sources = () => Object.fromEntries([...served.entries()].sort());
  const tlSha = shaFile(TL_FILE);
  try {
    if (opt.mode === 'render') await doRender(tl, workers, guard, sources, tlSha, bootMs);
    else if (opt.mode === 'preview') await doPreview(tl, workers, guard);
    else if (opt.mode === 'qa') await doQA(tl, workers, guard, sources);
    else if (opt.mode === 'cover') await doCover(tl, workers[0], guard);
    else if (opt.mode === 'styles') await doStyles(tl, workers, styleList, guard);
    else throw Error('unknown mode ' + opt.mode);
    guard();
  } finally {
    await Promise.all(workers.map(w => w.browser.close().catch(() => {})));
    srv.close();
  }
}

async function doRender(tl, workers, guard, sources, tlSha, bootMs) {
  const dir = path.join(OUT, 'chunks'); await fsp.mkdir(dir, { recursive: true });
  const chunks = [];
  for (let s = 0, i = 0; s < tl.totalFrames; s += CHUNK, i++) chunks.push({ i, s, e: Math.min(tl.totalFrames, s + CHUNK) });
  // sources are known once the page booted (all libs/fonts fetched during boot)
  const srcKey = sha(JSON.stringify(sources()));
  const keyOf = c => sha([RENDER_VERSION, tlSha, srcKey, LOSSLESS ? 'png' : Q, DRAFT, c.s, c.e].join('|'));
  const todo = chunks.filter(c => {
    const f = path.join(dir, `c${String(c.i).padStart(4, '0')}`);
    if (opt.resume && fs.existsSync(f + '.mp4') && fs.existsSync(f + '.json') && JSON.parse(fs.readFileSync(f + '.json', 'utf8')).key === keyOf(c)) return false;
    return true;
  });
  log(`render ${tl.totalFrames} frames · ${chunks.length} chunks (${chunks.length - todo.length} reused) · ${workers.length} workers · ${LOSSLESS ? 'PNG (lossless)' : 'JPEG q=' + Q}${DRAFT ? ' · DRAFT' : ''}`);
  const tStart = Date.now(); let doneFrames = 0; const perWorker = workers.map(() => ({ frames: 0, ms: 0 }));
  const queue = todo.slice();
  await Promise.all(workers.map(async (w, wi) => {
    for (let c; (c = queue.shift());) {
      const base = path.join(dir, `c${String(c.i).padStart(4, '0')}`);
      const enc = encoder(base + '.part.mp4', tl.fps, DRAFT);
      for (let f = c.s; f < c.e; f++) {
        const t = Date.now();
        const data = await w.page.evaluate(([f, q, png]) => XMS.capture(f, png ? 'image/png' : 'image/jpeg', q), [f, Q, LOSSLESS]);
        perWorker[wi].ms += Date.now() - t; perWorker[wi].frames++;
        const p = enc.write(b64(data)); if (p) await p;
        doneFrames++;
      }
      await enc.end(); guard();
      await fsp.rename(base + '.part.mp4', base + '.mp4');
      await fsp.writeFile(base + '.json', JSON.stringify({ key: keyOf(c), s: c.s, e: c.e }));
      const el = (Date.now() - tStart) / 1000;
      log(`chunk ${c.i + 1}/${chunks.length} [${c.s}–${c.e - 1}] w${wi} · ${doneFrames}/${todo.reduce((a, c) => a + c.e - c.s, 0)} frames · ${(doneFrames / el).toFixed(1)} fps`);
    }
  }));
  const captureS = (Date.now() - tStart) / 1000;
  const list = path.join(dir, 'list.txt');
  await fsp.writeFile(list, chunks.map(c => `file 'c${String(c.i).padStart(4, '0')}.mp4'`).join('\n') + '\n');
  const silent = path.join(OUT, 'silent.mp4');
  const tc = Date.now();
  check('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', silent]);
  const nb = parseInt(check('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', silent]), 10);
  if (nb !== tl.totalFrames) throw Error(`silent.mp4 has ${nb} frames, expected ${tl.totalFrames}`);
  const rendered = perWorker.reduce((a, w) => a + w.frames, 0);
  const rep = { mode: 'render', draft: DRAFT, renderVersion: RENDER_VERSION, createdAt: new Date().toISOString(), timelineSha256: tlSha, lock: tl.lock,
    sourceSha256: sources(), workers: workers.length, chunkFrames: CHUNK, capture: LOSSLESS ? 'png' : 'jpeg', jpegQuality: LOSSLESS ? null : Q, totalFrames: tl.totalFrames, renderedFrames: rendered,
    reusedChunks: chunks.length - todo.length, browserBootSeconds: bootMs / 1000, captureEncodeSeconds: +captureS.toFixed(2), concatSeconds: (Date.now() - tc) / 1000,
    wallMsPerFrame: rendered ? +(captureS * 1000 / rendered).toFixed(1) : 0,
    workerMsPerFrame: perWorker.map(w => w.frames ? +(w.ms / w.frames).toFixed(1) : 0), userAgent: workers[0].meta.ua,
    videoSha256: shaFile(silent) };
  await fsp.writeFile(path.join(OUT, 'render-report.json'), JSON.stringify(rep, null, 2) + '\n');
  log(`silent.mp4 ready: ${nb} frames · capture+encode ${captureS.toFixed(1)}s · ${rep.wallMsPerFrame} ms/frame wall · per-worker ${rep.workerMsPerFrame.join('/')} ms`);
  if (DRAFT) {
    const mixf = path.join(OUT, 'mix.wav'), out = path.join(OUT, 'draft.mp4');
    const a = fs.existsSync(mixf) ? ['-i', mixf, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '160k'] : [];
    check('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', silent, ...a, '-c:v', 'copy', '-movflags', '+faststart', out]);
    log(`draft → ${path.relative(ROOT, out)} (not a delivery: assets unlocked, no QA gate)`);
  }
}

/* deterministic shuffle */
function shuffled(arr, seed) { const a = arr.slice(); let s = seed >>> 0; for (let i = a.length - 1; i > 0; i--) { s = (s * 1664525 + 1013904223) >>> 0; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

async function doPreview(tl, workers, guard) {
  const dir = path.join(OUT, 'preview'); await fsp.rm(dir, { recursive: true, force: true }); await fsp.mkdir(dir, { recursive: true });
  const stills = [];
  for (const s of tl.scenes) for (const [tag, f] of [['a', s.startFrame + Math.min(8, s.durationFrames - 1)], ['b', s.startFrame + Math.floor(s.durationFrames / 2)], ['c', s.endFrame - 2]]) stills.push({ name: `${s.id}-${tag}.png`, f });
  for (const st of stills) await fsp.writeFile(path.join(dir, st.name), b64(await workers[0].page.evaluate(f => XMS.capture(f, 'image/png'), st.f)));
  guard();
  // determinism: same frames in two orders on one browser, and once on a second, independent browser
  const pool = Array.from({ length: 5 }, (_, k) => Math.min(tl.totalFrames - 1, Math.floor((k + ((tl.seed * (k + 1) * 0.6180339887) % 1)) * tl.totalFrames / 5)));  // one frame per fifth of the film
  const hashes = async (w, order) => { const o = {}; for (const f of order) o[f] = await w.page.evaluate(f => XMS.pixelHash(f), f); return o; };
  const A = await hashes(workers[0], pool), B = await hashes(workers[0], pool.slice().reverse()), C = await hashes(workers[1], shuffled(pool, 7));
  const rows = pool.map(f => ({ frame: f, hash: A[f].slice(0, 16), sameOrder: A[f] === B[f], crossBrowser: A[f] === C[f] }));
  const pass = rows.every(r => r.sameOrder && r.crossBrowser);
  const rep = { mode: 'preview', draft: DRAFT, stills: stills.map(s => ({ ...s })), determinism: { pass, frames: rows } };
  await fsp.writeFile(path.join(OUT, 'preview-report.json'), JSON.stringify(rep, null, 2) + '\n');
  log(`${stills.length} stills → ${path.relative(ROOT, dir)}`);
  for (const r of rows) log(`  frame ${String(r.frame).padStart(5)} ${r.hash}…  reorder ${r.sameOrder ? 'ok' : 'MISMATCH'}  cross-browser ${r.crossBrowser ? 'ok' : 'MISMATCH'}`);
  log(`determinism: ${pass ? 'PASS' : 'FAIL'}`);
  if (!pass) process.exitCode = 1;
}

async function doQA(tl, workers, guard, sources) {
  const dir = path.join(OUT, 'qa'); await fsp.rm(dir, { recursive: true, force: true }); await fsp.mkdir(path.join(dir, 'samples'), { recursive: true });
  const cfgFile = path.join(ROOT, 'qa.config.json'); const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
  const fr = cfg.sampleFractions || [0.3, 0.55, 0.8, 0.94];
  // 1) text-run log for every frame (geometry from the real draw calls)
  const t0 = Date.now(); const out = new Array(tl.totalFrames); let next = 0;
  // per frame: text runs + what had to be disclosed (示意 / AI badges) + chart-like fx and whether they cite a source or are flagged 示意
  await Promise.all(workers.map(async w => { for (let f; (f = next++) < tl.totalFrames;)
    out[f] = await w.page.evaluate(async f => ({ runs: await XMS.qaFrame(f), need: XMS.lastNeed, charts: XMS.lastCharts }), f); }));
  await fsp.writeFile(path.join(dir, 'runs.jsonl'), out.map((r, f) => JSON.stringify({ frame: f, ...r })).join('\n') + '\n');
  guard();
  // 2) sampled frame pairs: normal + text-suppressed (background only) for contrast / centering / edge checks
  const samples = [];
  // steady-state samples: move a sample out of the 0.8 s effect window after any hit (rings/confetti sweep over text there)
  const settle = cfg.hitSettleSeconds ?? .8;
  for (const s of tl.scenes) for (const k of fr) {
    let t = k * (s.durationFrames - 1) / tl.fps; const lim = s.durationFrames / tl.fps - .35;
    for (let pass = 0; pass < 4; pass++) for (const h of s.hits || []) if (t >= h - .05 && t < h + settle && h + settle <= lim) t = h + settle;
    samples.push({ scene: s.id, frame: Math.min(s.endFrame - 1, s.startFrame + Math.round(t * tl.fps)) });
  }
  let si = 0;
  await Promise.all(workers.map(async w => { for (let x; (x = samples[si++]);) {
    const full = await w.page.evaluate(f => XMS.capture(f, 'image/png'), x.frame);
    await w.page.evaluate(f => XMS.qaFrame(f, true), x.frame);
    const bg = await w.page.evaluate(() => new Promise(r => document.querySelector('#xms-canvas').toBlob(b => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(b); }, 'image/png')));
    await fsp.writeFile(path.join(dir, 'samples', `${x.frame}.png`), b64(full)); await fsp.writeFile(path.join(dir, 'samples', `${x.frame}-bg.png`), b64(bg));
  } }));
  guard();
  await fsp.writeFile(path.join(dir, 'samples.json'), JSON.stringify({ draft: DRAFT, samples, timelineSha256: shaFile(TL_FILE), sourceSha256: sources(), seconds: (Date.now() - t0) / 1000 }, null, 2));
  log(`qa capture: ${tl.totalFrames} frames logged + ${samples.length} sample pairs in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function doCover(tl, w, guard) {
  const themes = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/themes.json'), 'utf8'));
  const cp = themes.presets['cover-3x4'], f = Math.max(0, Math.min(tl.totalFrames - 1, +(opt.frame || 0))), h = cp.height;
  const runs = (await w.page.evaluate(f => XMS.qaFrame(f), f)).filter(r => r.role !== 'decor' && r.alpha > .2);
  // auto crop: fit every text run if possible, else fit everything except header pills, else the preset default
  const fit = rs => { if (!rs.length) return null; const t = Math.min(...rs.map(r => r.box[1])) - 24, b = Math.max(...rs.map(r => r.box[3])) + 24;
    return b - t > h ? null : Math.round(Math.max(0, Math.min(tl.height - h, (t + b) / 2 - h / 2))); };
  let y = opt['crop-y'] !== undefined ? +opt['crop-y'] : fit(runs) ?? fit(runs.filter(r => r.role !== 'pill')) ?? cp.cropY;
  const cut = runs.filter(r => r.box[1] < y || r.box[3] > y + h).map(r => r.text);
  await fsp.writeFile(path.join(OUT, 'cover-3x4.png'), b64(await w.page.evaluate(([f, y, h]) => XMS.crop(f, y, h), [f, y, h])));
  guard();
  const badges = await w.page.evaluate(() => (XMS.coverBadges || []).map(b => b.text));
  if (badges.length) log('cover labels: ' + badges.map(b => `「${b}」`).join(' '));
  log(`cover 3:4 (${tl.width}×${h}, crop y=${y}) from frame ${f} → ${path.relative(ROOT, path.join(OUT, 'cover-3x4.png'))}`);
  if (cut.length) log('warning: outside the 3:4 crop: ' + JSON.stringify(cut) + ' (choose another --frame or --crop-y)');
}

async function doStyles(tl, workers, list, guard) {
  const f = Math.max(0, Math.min(tl.totalFrames - 1, +(opt.frame || 0)));
  const themes = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/themes.json'), 'utf8'));
  const shots = await Promise.all(workers.map(w => w.page.evaluate(f => XMS.capture(f, 'image/png'), f)));
  guard();
  const panels = list.map((id, i) => ({ letter: 'ABCD'[i], id, label: themes.styles[id].label, en: themes.styles[id].en || '', note: themes.styles[id].note || '', png: shots[i] }));
  // compose in the page (project fonts are already loaded there): one row of panels with A/B/C headers
  const sheet = await workers[0].page.evaluate(async ({ panels, title, W, H }) => {
    const pw = 540, ph = Math.round(H * pw / W), pad = 40, head = 150, lab = 128, foot = 90;
    const c = document.createElement('canvas'); c.width = panels.length * pw + (panels.length + 1) * pad; c.height = head + lab + ph + foot + pad;
    const g = c.getContext('2d'); g.fillStyle = '#ECE8DF'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#16181D'; g.textBaseline = 'middle'; g.font = XMS.font(700, 52); g.fillText('画风三选一', pad, 62);
    g.font = XMS.font(400, 28); g.fillStyle = '#4A4F57'; g.fillText(title, pad, 116);
    for (const [i, p] of panels.entries()) {
      const x = pad + i * (pw + pad), y = head;
      const img = new Image(); img.src = 'data:image/png;base64,' + p.png; await img.decode();
      g.fillStyle = '#16181D'; g.beginPath(); g.arc(x + 34, y + 38, 34, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#FFFFFF'; g.font = XMS.font(700, 42); g.textAlign = 'center'; g.fillText(p.letter, x + 34, y + 40); g.textAlign = 'left';
      g.fillStyle = '#16181D'; g.font = XMS.font(700, 40); g.fillText(p.label, x + 86, y + 26);
      g.fillStyle = '#4A4F57'; g.font = XMS.font(400, 24); g.fillText(`${p.id} · ${p.en}`, x + 86, y + 66);
      g.fillText(p.note, x, y + 108, pw);
      g.save(); g.shadowColor = 'rgba(0,0,0,0.18)'; g.shadowBlur = 24; g.shadowOffsetY = 8; g.drawImage(img, x, y + lab, pw, ph); g.restore();
    }
    g.fillStyle = '#4A4F57'; g.font = XMS.font(400, 28);
    g.fillText('回复 A / B / C 选择画风 → 写入 storyboard.json 的 "style"（未选择时定稿渲染会拒绝执行）', pad, c.height - pad - foot / 2 + 10);
    return await new Promise(r => c.toBlob(b => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(b); }, 'image/png'));
  }, { panels, title: `${tl.title} · 镜头 ${opt.shot || ''} · ${(f / tl.fps).toFixed(2)}s（第 ${f} 帧）`, W: tl.width, H: tl.height });
  const out = path.resolve(opt.out || path.join(OUT, 'styles', 'styles.png'));
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, b64(sheet));
  await fsp.writeFile(out.replace(/\.png$/, '.json'), JSON.stringify({ frame: f, shot: opt.shot || null, options: panels.map(({ png, ...p }) => p) }, null, 2) + '\n');
  log(`style sheet (${list.join(' / ')}) from frame ${f} → ${path.relative(process.cwd(), out)}`);
}

main().catch(e => { console.error('[xms] ERROR', e.message || e); process.exit(1); });
