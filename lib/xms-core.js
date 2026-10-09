/* xms-core.js — runtime for XHS Motion Studio projects (MIT License).
 * Boots one page that serves both the interactive preview and headless export:
 *   fetch timeline.json + lib/themes.json → load fonts explicitly (FontFace) → validate theme contrast →
 *   run XMS.onPrepare hooks → expose the frame contract:
 *     window.__xmsMeta = { width, height, fps, totalFrames }
 *     window.xmsRenderFrame(frame)   // draws exactly that frame; never depends on the previous one
 *     window.__xmsReady = true
 * Scenes register with XMS.onPrepare(async tl => …) and XMS.onFrame((ctx, a) => …).
 */
(() => {
const XMS = window.XMS = window.XMS || {};
const hooks = { prepare: [], frame: null };
XMS.onPrepare = fn => hooks.prepare.push(fn);
XMS.onFrame = fn => { hooks.frame = fn; };
XMS.FAMILY = 'XMSSans';
XMS.font = (weight, size) => `${weight} ${size}px ${XMS.FAMILY}`;

/* ---------- WCAG contrast ---------- */
const lin = v => { v /= 255; return v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); };
XMS.luminance = hex => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); return .2126 * lin(r) + .7152 * lin(g) + .0722 * lin(b); };
XMS.contrast = (a, b) => { const x = XMS.luminance(a), y = XMS.luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
XMS.validateTheme = (theme, pairs, min = 4.5) => pairs.map(([f, b]) => ({ fg: f, bg: b, ratio: +XMS.contrast(theme[f], theme[b]).toFixed(2) })).filter(p => p.ratio < min);

/* ---------- QA instrumentation (inactive unless the renderer turns it on) ---------- */
XMS.qa = { on: false, suppressText: false, runs: [], gid: 0 };
XMS.logText = (ctx, r) => {
  if (!XMS.qa.on) return;
  const m = ctx.getTransform(), pts = [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]].map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const cxT = r.cx == null ? null : m.a * r.cx + m.c * ((r.y0 + r.y1) / 2) + m.e;
  XMS.qa.runs.push({ text: r.text, role: r.role, color: r.color, size: Math.round(r.size * Math.hypot(m.a, m.b)), halo: !!r.halo, align: r.align,
    cx: cxT == null ? null : Math.round(cxT * 10) / 10, alpha: +((r.alpha ?? 1) * ctx.globalAlpha).toFixed(3), moving: !!(r.moving || XMS.frameMoving), group: r.group || null,
    box: [Math.round(Math.min(...xs)), Math.round(Math.min(...ys)), Math.round(Math.max(...xs)), Math.round(Math.max(...ys))],
    rotated: Math.abs(m.b) > 1e-3 || Math.abs(m.c) > 1e-3 });
};

/* ---------- boot ---------- */
async function boot() {
  const exportMode = new URLSearchParams(location.search).has('export');
  document.body.classList.toggle('export', exportMode);
  const res = await fetch('timeline.json'); if (!res.ok) throw Error('timeline.json missing: run `xms.py timeline <project>` first');
  const tl = await res.json();
  const themes = await (await fetch('lib/themes.json')).json();
  const theme = Object.assign({}, themes.themes[tl.theme] || themes.themes['editorial-amber'], tl.themeOverrides || {});
  /* role aliases keep scene code readable */
  XMS.C = Object.assign(theme, { amber: theme.accent, amberT: theme.accentText, amberOnDark: theme.accentOnDark, teal: theme.second, navy: theme.third, sup: theme.support });
  XMS.themeIssues = XMS.validateTheme(theme, themes.contrastPairs);
  if (XMS.themeIssues.length) console.warn('theme contrast below 4.5:1', JSON.stringify(XMS.themeIssues));
  const preset = themes.presets[tl.preset] || themes.presets['xhs-9x16'];
  XMS.W = tl.width; XMS.H = tl.height; XMS.M = preset.margin ?? 60; XMS.zones = preset.uiZones || {}; XMS.preset = preset; XMS.timeline = tl;
  const fonts = tl.fonts || { regular: 'fonts/NotoSansCJKsc-Regular.otf', bold: 'fonts/NotoSansCJKsc-Bold.otf' };
  for (const [file, weight] of [[fonts.regular, '400'], [fonts.bold, '700']]) {
    const r = await fetch(file); if (!r.ok) throw Error('font missing: ' + file + ' (run `xms.py fonts <project>`)');
    const face = new FontFace(XMS.FAMILY, await r.arrayBuffer(), { weight }); await face.load(); document.fonts.add(face);
  }
  await document.fonts.ready;
  if (!document.fonts.check(XMS.font(700, 64), '中文') || !document.fonts.check(XMS.font(400, 64), '中文')) throw Error('CJK font not ready');
  const canvas = document.querySelector('#xms-canvas'), ctx = canvas.getContext('2d');
  canvas.width = tl.width; canvas.height = tl.height; document.title = tl.title || 'XMS';
  for (const fn of hooks.prepare) await fn(tl);
  if (!hooks.frame) throw Error('shots.js must call XMS.onFrame(...)');
  const starts = tl.scenes.map(s => s.startFrame);
  const sceneAt = f => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= f) lo = mid; else hi = mid - 1; } return lo; };
  window.__xmsMeta = { width: tl.width, height: tl.height, fps: tl.fps, totalFrames: tl.totalFrames };
  window.xmsRenderFrame = async frame => {
    if (!Number.isInteger(frame) || frame < 0 || frame >= tl.totalFrames) throw Error('frame out of range: ' + frame);
    const index = sceneAt(frame), scene = tl.scenes[index];
    XMS.qa.runs = []; XMS.qa.gid = 0; XMS.frameMoving = false;
    if (ctx.reset) ctx.reset(); else canvas.width = canvas.width;
    ctx.save();
    hooks.frame(ctx, { frame, index, scene, timeline: tl, fps: tl.fps, W: tl.width, H: tl.height,
      t: (frame - scene.startFrame) / tl.fps, T: frame / tl.fps, dur: scene.durationFrames / tl.fps,
      prev: tl.scenes[index - 1] || null, next: tl.scenes[index + 1] || null, isFirst: index === 0, isLast: index === tl.scenes.length - 1,
      hits: scene.hits || [], heavy: scene.heavy || [], heavyAbs: tl.heavyAbs || [] });
    ctx.restore();
    if (!exportMode) ui.show(frame);
  };
  /* capture helpers used by tools/xms-render.cjs (canvas pixels, no compositor screenshot) */
  const blobB64 = blob => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = bad; r.readAsDataURL(blob); });
  XMS.capture = async (frame, type = 'image/jpeg', quality = .94) => { await window.xmsRenderFrame(frame); return blobB64(await new Promise(r => canvas.toBlob(r, type, quality))); };
  XMS.pixelHash = async frame => { await window.xmsRenderFrame(frame); const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', d))).map(b => b.toString(16).padStart(2, '0')).join(''); };
  XMS.qaFrame = async (frame, suppress = false) => { XMS.qa.on = true; XMS.qa.suppressText = suppress; try { await window.xmsRenderFrame(frame); return XMS.qa.runs; } finally { XMS.qa.on = false; XMS.qa.suppressText = false; } };
  XMS.crop = async (frame, y, h, type = 'image/png') => { await window.xmsRenderFrame(frame); const c = document.createElement('canvas'); c.width = canvas.width; c.height = h;
    c.getContext('2d').drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h); return blobB64(await new Promise(r => c.toBlob(r, type, .95))); };
  const ui = player(tl, exportMode);
  await window.xmsRenderFrame(0); window.__xmsReady = true;
}
/* ---------- minimal preview player (hidden in export mode) ---------- */
function player(tl, exportMode) {
  const bar = document.querySelector('#xms-controls'); if (exportMode || !bar) return { show() {} };
  const play = bar.querySelector('button'), seek = bar.querySelector('input'), label = bar.querySelector('span'), audio = document.querySelector('audio');
  seek.max = tl.totalFrames - 1; let on = false, t0 = 0, from = 0, hasAudio = false;
  if (tl.previewAudio) fetch(tl.previewAudio, { method: 'HEAD' }).then(r => { if (r.ok) { audio.src = tl.previewAudio; hasAudio = true; } });
  const stop = () => { on = false; audio.pause(); play.textContent = '▶'; };
  const loop = async now => { if (!on) return; const sec = hasAudio ? audio.currentTime : from + (now - t0) / 1000;
    const f = Math.min(tl.totalFrames - 1, Math.floor(sec * tl.fps)); await window.xmsRenderFrame(f); if (f >= tl.totalFrames - 1) { stop(); return; } requestAnimationFrame(loop); };
  play.onclick = async () => { if (on) return stop(); if (+seek.value >= tl.totalFrames - 1) seek.value = 0; from = +seek.value / tl.fps; t0 = performance.now();
    if (hasAudio) { audio.currentTime = from; await audio.play(); } on = true; play.textContent = '❚❚'; requestAnimationFrame(loop); };
  seek.oninput = () => { stop(); window.xmsRenderFrame(+seek.value); };
  return { show(f) { seek.value = f; label.textContent = `${(f / tl.fps).toFixed(2)}s / ${tl.durationSeconds.toFixed(1)}s · #${f}`; } };
}
window.addEventListener('DOMContentLoaded', () => boot().catch(e => { console.error(e); window.__xmsBootError = String(e && e.stack || e); }));
})();
