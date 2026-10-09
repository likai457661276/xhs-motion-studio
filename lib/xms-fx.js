/* xms-fx.js — deterministic motion effects for canvas explainer videos (XHS Motion Studio, MIT License).
 * Contract: every effect is a pure function of (time, seed, options). No Math.random, no requestAnimationFrame,
 * no state carried between frames, so any frame can be rendered alone, in any order, on any worker.
 * Colours default to the active theme (XMS.C). See docs/API.md for the full reference with examples.
 */
(() => {
const XMS = window.XMS = window.XMS || {};
const C = () => XMS.C;
const W = () => XMS.W || 1080, H = () => XMS.H || 1920;
/* ---------- math ---------- */
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const prog = (t, start, dur) => clamp((t - start) / dur);
const ease = {
  out: x => 1 - Math.pow(1 - clamp(x), 3),
  in: x => Math.pow(clamp(x), 3),
  inOut: x => { x = clamp(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; },
  back: x => { x = clamp(x); const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); },
};
/** hash(n) → [0,1): stateless pseudo-random value for an index/seed */
const hash = n => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
/** rng(seed) → () => [0,1): seeded sequence (mulberry32) for precomputation only */
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) | 0; let x = Math.imul(s ^ (s >>> 15), 1 | s); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const suppressed = () => XMS.qa && XMS.qa.suppressText;

/* ---------- shapes & transforms ---------- */
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
/** card(ctx, x, y, w, h, { r=28, fill=panel, stroke, lw=4, shadow=true }) */
function card(ctx, x, y, w, h, o = {}) {
  ctx.save();
  if (o.shadow !== false) { ctx.shadowColor = 'rgba(36,50,74,0.14)'; ctx.shadowBlur = 36; ctx.shadowOffsetY = 14; }
  rr(ctx, x, y, w, h, o.r ?? 28); ctx.fillStyle = o.fill || C().panel; ctx.fill(); ctx.shadowColor = 'transparent';
  if (o.stroke) { ctx.lineWidth = o.lw || 4; ctx.strokeStyle = o.stroke; ctx.stroke(); }
  ctx.restore();
}
/** pop(t, at, d=.45) → scale 0 → overshoot → 1 */
const pop = (t, at, d = .45) => t < at ? 0 : ease.back(prog(t, at, d));
/** at(ctx, x, y, scale, rot, fn): draw fn() in a local frame */
function at(ctx, x, y, s, rot, fn) { ctx.save(); ctx.translate(x, y); if (rot) ctx.rotate(rot); if (s !== 1) ctx.scale(s, s); fn(); ctx.restore(); }
/** exitGroup(ctx, q, fn, cx, cy): fade + shrink a group while q goes 0→1 */
function exitGroup(ctx, q, fn, cx = W() / 2, cy = 1050) { if (q >= 1) return; ctx.save(); ctx.globalAlpha *= 1 - q; ctx.translate(cx, cy); ctx.scale(1 - .05 * q, 1 - .05 * q); ctx.translate(-cx, -cy); fn(); ctx.restore(); }
/** shake(T, heavyTimes, amp=13) → [dx, dy] decaying camera shake after each heavy beat */
function shake(T, heavy = [], amp = 13) { let dx = 0, dy = 0; for (const h of heavy) { const k = T - h; if (k >= 0 && k < .45) { const a = amp * Math.exp(-k * 9); dx += a * Math.sin(k * 83); dy += a * Math.cos(k * 71); } }
  if (Math.hypot(dx, dy) > .5) XMS.frameMoving = true; /* QA: geometry checks skip shaken frames */ return [dx, dy]; }

/* ---------- text effects: word-cascade in, letter-explode out ---------- */
/** glyphs(ctx, L, t, o): draw a XMS.type.layout result with per-character motion.
 * o: { start=0, stagger=.04, dur=.5, seed=1, exitAt, exitDur=.3, static=false, color=ink, accent=accentText, halo=true, alpha=1, skipAcc=false } */
function glyphs(ctx, L, t, o = {}) {
  const start = o.start ?? 0, st = o.stagger ?? .04, d = o.dur ?? .5, seed = o.seed ?? 1, c = C();
  ctx.save(); ctx.font = L.font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const base = ctx.globalAlpha, seg = new Map();
  for (const g of L.glyphs) {
    if (o.skipAcc && g.acc) continue;
    const p = o.static ? 1 : prog(t, start + g.i * st, d);
    let dy = (1 - ease.back(p)) * -L.size * .95, rot = (hash(seed + g.i * 1.7) - .5) * .7 * (1 - ease.out(p)), a = clamp(p * 2.5), s = 1, dx = 0, q = 0;
    if (o.exitAt !== undefined && t > o.exitAt) {
      q = prog(t, o.exitAt, o.exitDur ?? .3); const vx = (hash(seed + g.i * 3.1) - .5) * 1100, vy = -(250 + hash(seed + g.i * 5.3) * 700);
      dx += vx * q; dy += vy * q + 1900 * q * q; rot += (hash(seed + g.i * 7.7) - .5) * 5 * q; a *= 1 - q; s += .35 * q;
    }
    const key = g.row + ':' + (g.acc ? 1 : 0); let sg = seg.get(key);
    if (!sg) { sg = { text: '', x0: 1e9, x1: -1e9, y: g.y, row: g.row, a: 0, n: 0, moving: false, acc: g.acc }; seg.set(key, sg); }
    sg.text += (g.sp && sg.text ? ' ' : '') + g.ch; sg.x0 = Math.min(sg.x0, g.il ?? g.x - g.w / 2); sg.x1 = Math.max(sg.x1, g.ir ?? g.x + g.w / 2); sg.a += Math.max(0, a); sg.n++; sg.moving ||= p < 1 || q > 0;
    if (p <= 0 || a <= 0 || suppressed()) continue;
    ctx.globalAlpha = base * a * (o.alpha ?? 1);
    ctx.fillStyle = g.acc ? (o.accent || c.accentText) : (o.color || c.ink);
    ctx.save(); ctx.translate(g.x + dx, g.y + dy); if (rot) ctx.rotate(rot); if (s !== 1) ctx.scale(s, s);
    if (o.halo !== false) { XMS.type.haloStyle(ctx, L.size, o.halo); ctx.strokeText(g.ch, 0, 0); }
    ctx.fillText(g.ch, 0, 0); ctx.restore();
  }
  ctx.globalAlpha = base;
  const gid = XMS.qa && XMS.qa.on ? 'g' + (XMS.qa.gid = (XMS.qa.gid || 0) + 1) : null;
  if (XMS.logText) for (const sg of seg.values()) XMS.logText(ctx, { group: gid && gid + ':' + Math.round(sg.y), text: sg.text, x0: sg.x0, x1: sg.x1, y0: sg.y - L.size * .56, y1: sg.y + L.size * .56,
    color: sg.acc ? (o.accent || c.accentText) : (o.color || c.ink), size: L.size, halo: o.halo !== false, align: o.align || 'center',
    cx: (o.align || 'center') === 'center' && !(o.skipAcc && L.glyphs.some(g => g.acc && g.row === sg.row)) ? (o.cx ?? W() / 2) : null,
    alpha: (sg.a / sg.n) * (o.alpha ?? 1), role: o.role || 'title', moving: sg.moving });
  ctx.restore();
}
/** title(ctx, lines, t, o) → layout. Big headline with cascade-in and optional explode-out.
 * o: { cy, size=112, weight=700, maxW, maxLines, cx, lh, ...glyphs options } */
function title(ctx, lines, t, o = {}) {
  const L = XMS.type.layout(ctx, lines, { size: o.size || 112, weight: o.weight ?? 700, cy: o.cy, maxW: o.maxW, cx: o.cx, lh: o.lh, maxLines: o.maxLines });
  glyphs(ctx, L, t, { ...o, cx: o.cx }); return L;
}
/** sub(ctx, text, t, start, cy, o): support line(s) that slide/fade in at `start`; o: { size=54, weight=400, maxW=900, exitAt, color=support } */
function sub(ctx, text, t, start, cy, o = {}) {
  if (!text || t < start) return null;
  const L = XMS.type.layout(ctx, String(text).split('\n'), { size: o.size || 54, weight: o.weight ?? 400, cy, maxW: o.maxW || 900, lh: 1.42 });
  const p = ease.out(prog(t, start, .4)), q = o.exitAt !== undefined ? prog(t, o.exitAt, .3) : 0;
  ctx.save(); ctx.globalAlpha *= p * (1 - q); ctx.translate(0, (1 - p) * 24);
  glyphs(ctx, L, t, { static: true, color: o.color || C().support, accent: o.accent || C().accentText, role: 'sub', halo: o.halo });
  ctx.restore(); return L;
}

/* ---------- hit effects ---------- */
/** shock(ctx, x, y, k, color=accent, maxR=460, rings=2): expanding ring(s); k = seconds since the hit */
function shock(ctx, x, y, k, color, maxR = 460, rings = 2) {
  if (k < 0 || k > .8) return; const c = C();
  ctx.save();
  for (let j = 0; j < rings; j++) {
    const kk = k - j * .09; if (kk <= 0) continue; const q = kk / .65; if (q >= 1) continue;
    ctx.globalAlpha = (1 - q) * .75; ctx.strokeStyle = j ? c.second : (color || c.accent); ctx.lineWidth = 22 * (1 - q) + 2;
    ctx.beginPath(); ctx.arc(x, y, maxR * ease.out(q) * (1 - j * .18), 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}
/** confetti(ctx, x, y, k, seed=1, n=64, { palette, speed=1 }): analytic burst with drag + gravity */
function confetti(ctx, x, y, k, seed = 1, n = 64, o = {}) {
  if (k < 0 || k > 1.7) return; const c = C();
  const pal = o.palette || o.pal || [c.accent, c.second, c.third, c.accent, c.warm], spd = o.speed || 1;
  ctx.save();
  for (let i = 0; i < n; i++) {
    const a = hash(seed * 13 + i * 1.37) * Math.PI * 2, sp = (380 + hash(seed * 7 + i * 2.11) * 980) * spd, D = 3.2;
    const disp = sp * (1 - Math.exp(-D * k)) / D, life = 1 - k / (.75 + hash(seed + i * 3.3) * .8); if (life <= 0) continue;
    const px = x + Math.cos(a) * disp, py = y + Math.sin(a) * disp * .9 + 520 * k * k, sz = 8 + hash(seed + i * 9.1) * 12;
    ctx.globalAlpha = clamp(life * 1.4); ctx.fillStyle = pal[i % pal.length];
    ctx.save(); ctx.translate(px, py); ctx.rotate(k * (hash(i + seed) - .5) * 14);
    if (i % 3 === 0) { ctx.beginPath(); ctx.arc(0, 0, sz * .45, 0, Math.PI * 2); ctx.fill(); } else ctx.fillRect(-sz / 2, -sz * .22, sz, sz * .44);
    ctx.restore();
  }
  ctx.restore();
}
/** counter(ctx, t, o): counter-explosion — eased count, overshoot pop on landing + shockwave + confetti.
 * o: { start, land, from, to, cx, base, parts(v, landed) → [{text,size,color}], h=120, r=470, seed=7, n=70, ring=true } */
function counter(ctx, t, o) {
  if (t < o.start) return null;
  const p = prog(t, o.start, o.land - o.start), v = t >= o.land ? o.to : o.from + (o.to - o.from) * ease.out(p);
  let s = .88 + .12 * p; if (t >= o.land) { const k = t - o.land; s = 1 + .32 * Math.exp(-k * 6) * Math.cos(k * 15); }
  const cy = o.base - (o.h || 120) * .36;
  if (t >= o.land && o.ring !== false) shock(ctx, o.cx, cy, t - o.land, C().accent, o.r || 470);
  ctx.save(); ctx.globalAlpha *= clamp((t - o.start) / .15);
  const r = XMS.type.rich(ctx, o.parts(v, t >= o.land), o.cx, o.base, s, { role: 'counter', moving: t < o.land + .35 }); ctx.restore();
  if (t >= o.land) confetti(ctx, o.cx, cy, t - o.land, o.seed || 7, o.n || 70);
  return r;
}
/** particles(text, { size, weight=700, cx, cy, step=8, inkCenter=false }) → prepared point set for assemble() */
function particles(text, o) {
  const cnv = document.createElement('canvas'), g = cnv.getContext('2d', { willReadFrequently: true }), font = XMS.font(o.weight ?? 700, o.size);
  g.font = font; const w = Math.ceil(g.measureText(text).width) + 40, h = Math.ceil(o.size * 1.5);
  cnv.width = w; cnv.height = h; g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#000'; g.fillText(text, w / 2, h / 2);
  const d = g.getImageData(0, 0, w, h).data, pts = [], step = o.step || 8, m = g.measureText(text);
  const dx = o.inkCenter ? -(m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2 : 0;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (d[(y * w + x) * 4 + 3] > 150) pts.push({ x: o.cx + dx - w / 2 + x, y: o.cy - h / 2 + y });
  return { pts, text, size: o.size, weight: o.weight ?? 700, cx: o.cx + dx, cy: o.cy };
}
/** assemble(ctx, P, t, { start, land, seed, color=accentText, dot=6, alpha=1 }): scattered dots fly into the text, then it solidifies */
function assemble(ctx, P, t, o) {
  const D = o.land - o.start; if (t < o.start) return; const c = C();
  const fade = clamp((t - o.land) / .28), sz = o.dot || 6;
  if (fade < 1) {
    ctx.save();
    P.pts.forEach((pt, i) => {
      const a = hash(o.seed + i * 1.31) * Math.PI * 2, r = 650 + hash(o.seed + i * 2.17) * 650;
      const sx = P.cx + Math.cos(a) * r * .8, sy = P.cy + Math.sin(a) * r, dl = hash(o.seed + i * 3.7) * .45, p = ease.inOut(prog(t, o.start + dl * D, D * (1 - dl)));
      const wob = (1 - p) * 34, x = lerp(sx, pt.x, p) + Math.sin(t * 4 + i) * wob, y = lerp(sy, pt.y, p) + Math.cos(t * 3.3 + i * 1.7) * wob;
      ctx.globalAlpha = clamp((t - o.start) / .2) * (1 - fade); ctx.fillStyle = i % 4 === 0 ? c.second : c.accent; ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
    });
    ctx.restore();
  }
  if (t >= o.land - .05) {
    const a = clamp((t - o.land + .05) / .22), k = t - o.land, s = k > 0 ? 1 + .12 * Math.exp(-k * 7) * Math.cos(k * 16) : 1;
    ctx.save(); ctx.globalAlpha *= a * (o.alpha ?? 1); ctx.font = XMS.font(P.weight, P.size); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.translate(P.cx, P.cy); ctx.scale(s, s);
    const m = XMS.type.measure(ctx, XMS.font(P.weight, P.size), P.text);
    XMS.logText && XMS.logText(ctx, { text: P.text, x0: -m.w / 2, x1: m.w / 2, y0: -P.size * .56, y1: P.size * .56, color: o.color || c.accentText, size: P.size,
      halo: true, align: 'center', cx: P.cx, role: 'title', moving: k < .35 });
    if (!suppressed()) { ctx.fillStyle = o.color || c.accentText; ctx.lineJoin = 'round'; ctx.lineWidth = P.size * .1; ctx.strokeStyle = c.halo; ctx.strokeText(P.text, 0, 0); ctx.fillText(P.text, 0, 0); }
    ctx.restore();
  }
}

/* ---------- network motif ---------- */
const net = {
  /** make(seed, n, cx, cy, rx, ry) → golden-angle node cloud with nearest-neighbour edges and a hub at (cx, cy) */
  make(seed, n, cx, cy, rx, ry) {
    const nodes = [];
    for (let i = 0; i < n; i++) { const a = i * 2.39996 + hash(seed + i) * .5, r = Math.sqrt((i + .6) / n);
      nodes.push({ x: cx + Math.cos(a) * rx * r, y: cy + Math.sin(a) * ry * r, r: 9 + hash(seed + i * 2) * 9, d: r, i }); }
    const edges = [];
    nodes.forEach((a, i) => {
      nodes.map((b, j) => ({ j, d: Math.hypot(a.x - b.x, a.y - b.y) })).filter(e => e.j !== i).sort((p, q) => p.d - q.d).slice(0, 2)
        .forEach(e => { if (!edges.some(x => x[0] === e.j && x[1] === i)) edges.push([i, e.j]); });
      if (i < 10 && i > 0) edges.push([0, i]);
    });
    nodes[0] = { ...nodes[0], x: cx, y: cy, r: 0, d: 0 };
    return { nodes, edges, cx, cy };
  },
  /** draw(ctx, N, t, { reveal=1 (0→1 grows outward), alpha, pulses=true, edge, node, lw=3, pr=6 }) */
  draw(ctx, N, t, o = {}) {
    const reveal = o.reveal ?? 1, c = C();
    ctx.save(); ctx.globalAlpha *= o.alpha ?? 1;
    N.edges.forEach(([a, b], k) => {
      const A = N.nodes[a], B = N.nodes[b], vis = clamp((reveal - Math.max(A.d, B.d)) * 5); if (vis <= 0) return;
      ctx.strokeStyle = o.edge || 'rgba(36,50,74,0.28)'; ctx.lineWidth = o.lw || 3; ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(lerp(A.x, B.x, vis), lerp(A.y, B.y, vis)); ctx.stroke();
      if (vis >= 1 && o.pulses !== false) { const ph = (t * (.45 + hash(k) * .5) + hash(k * 3.3)) % 1;
        ctx.fillStyle = k % 3 ? c.accent : c.second; ctx.beginPath(); ctx.arc(lerp(A.x, B.x, ph), lerp(A.y, B.y, ph), o.pr || 6, 0, Math.PI * 2); ctx.fill(); }
    });
    N.nodes.forEach((n, i) => { if (i === 0) return; const vis = clamp((reveal - n.d) * 5); if (vis <= 0) return;
      ctx.fillStyle = i % 5 === 0 ? c.second : (o.node || c.third); ctx.beginPath(); ctx.arc(n.x, n.y, n.r * ease.back(vis) * (o.nodeScale || 1), 0, Math.PI * 2); ctx.fill(); });
    ctx.restore();
  },
};

/* ---------- UI pieces ---------- */
/** pill(ctx, label, t, { y=160, enter=true, filled=auto(/^[①-⑳]/), size=42 }): section header chip */
function pill(ctx, label, t, o = {}) {
  const c = C(), size = o.size || 42, p = o.enter !== false ? ease.out(prog(t, -.12, .4)) : 1, filled = o.filled ?? /^[①-⑳]/.test(label);
  ctx.save(); const w = XMS.type.measure(ctx, XMS.font(700, size), label).w + 76, h = size * 1.95, y = (o.y ?? 160) + (1 - p) * -50; ctx.globalAlpha *= p;
  rr(ctx, W() / 2 - w / 2, y - h / 2, w, h, h / 2);
  if (filled) { ctx.fillStyle = c.second; ctx.fill(); } else { ctx.fillStyle = 'rgba(251,249,244,0.85)'; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = c.ink; ctx.stroke(); }
  XMS.type.text(ctx, label, W() / 2, y + 2, { size, color: filled ? c.onDark : c.ink, role: 'pill', moving: p < 1 }); ctx.restore();
}
/** chip(ctx, t, { at, x, y, label, icon, w=460, h=132, size=52, fill=card, color=ink }): badge that pops in at `at` with a small ring */
function chip(ctx, t, o) {
  const p = pop(t, o.at); if (p <= 0) return; const c = C(), w = o.w || 460, h = o.h || 132;
  at(ctx, o.x, o.y, p, 0, () => {
    card(ctx, -w / 2, -h / 2, w, h, { r: h / 2, fill: o.fill || c.card });
    const hasIcon = o.icon && icon[o.icon]; if (hasIcon) icon[o.icon](ctx, -w / 2 + 80, 0, h * .53);
    XMS.type.text(ctx, o.label, hasIcon ? 40 : 0, 2, { size: o.size || 52, color: o.color || c.ink, role: 'chip', moving: p !== 1 && t - o.at < .45 });
  });
  if (o.ring !== false) shock(ctx, o.x, o.y, t - o.at, c.accent, (o.w || 460) * .56, 1);
}
/** flip(ctx, t, { at, dur=.5, cx, cy, front(ctx), back(ctx) }): card flip around the vertical axis, centred on `at` */
function flip(ctx, t, o) {
  const d = o.dur ?? .5, fl = prog(t, o.at - d / 2, d), sx = Math.abs(Math.cos(Math.PI * fl)), front = fl < .5;
  ctx.save(); ctx.translate(o.cx, o.cy); ctx.scale(Math.max(.02, sx), 1); ctx.translate(-o.cx, -o.cy);
  (front ? o.front : o.back)(ctx); ctx.restore();
  return front;
}
/** stamp(ctx, t, { at, x, y, w=540, h=190, label, size=112, rot=-.1, color=accent, textColor=accentText, fill }): slam-in stamp */
function stamp(ctx, t, o) {
  const ps = prog(t, o.at - .15, .2); if (ps <= 0) return; const c = C(), w = o.w || 540, h = o.h || 190;
  at(ctx, o.x, o.y, lerp(o.from ?? 2.4, 1, ease.out(ps)), o.rot ?? -.1, () => {
    ctx.globalAlpha *= clamp(ps * 2); ctx.strokeStyle = o.color || c.accent; ctx.lineWidth = o.lw || 12; rr(ctx, -w / 2, -h / 2, w, h, o.r ?? 26);
    ctx.fillStyle = o.fill || 'rgba(251,249,244,0.9)'; ctx.fill(); ctx.stroke();
    XMS.type.text(ctx, o.label, 0, 4, { size: o.size || 112, color: o.textColor || c.accentText, role: 'stamp', moving: ps < 1 });
  });
}
/** chart(ctx, t, { points:[[x,y]...], start=.4, dur=1.8, color=second, width=8, dashed=true, endLabel, labelSize=80 }): line that draws left→right */
function chart(ctx, t, o) {
  const c = C(), pts = o.points, k = ease.out(prog(t, o.start ?? .4, o.dur ?? 1.8)), x0 = pts[0][0], x1 = pts[pts.length - 1][0], xe = lerp(x0, x1, k);
  ctx.save(); ctx.globalAlpha *= o.alpha ?? .9; ctx.strokeStyle = o.color || c.second; ctx.lineWidth = o.width || 8; ctx.lineCap = 'round';
  if (o.dashed !== false) ctx.setLineDash([22, 18]);
  ctx.beginPath(); pts.forEach(([x, y], i) => { if (x <= xe) i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); ctx.restore();
  if (o.endLabel && k > .95) { const [lx, ly] = pts[pts.length - 1]; XMS.type.text(ctx, o.endLabel, lx + (o.labelDx ?? 40), ly + (o.labelDy ?? -40), { size: o.labelSize || 80, color: o.color || c.second, halo: true, role: 'label' }); }
  return k;
}

/* ---------- paper background: low-res domain-warped noise + fixed grain tile ---------- */
function ih(x, y) { let h = (x * 374761393 + y * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h & 0xffff) / 65535; }
function vn(x, y) { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = ih(xi, yi), b = ih(xi + 1, yi), c = ih(xi, yi + 1), d = ih(xi + 1, yi + 1); return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v; }
function fbm(x, y) { let s = 0, a = .5; for (let i = 0; i < 4; i++) { s += a * vn(x, y); const nx = .8 * x + .6 * y, ny = -.6 * x + .8 * y; x = nx * 2.02 + 3.1; y = ny * 2.02 + 1.7; a *= .5; } return s; }
const paper = {
  bg: null, grainTile: null,
  /** prepare(seed, { res=[120,214], tile=512, ink=.07, white=.07 }): build the low-res field canvas and the grain tile once */
  prepare(seed, o = {}) {
    const res = o.res || [Math.round(W() / 9), Math.round(H() / 9)], T = o.tile || 512;
    this.bg = document.createElement('canvas'); this.bg.width = res[0]; this.bg.height = res[1];
    const tile = document.createElement('canvas'); tile.width = tile.height = T; const g = tile.getContext('2d'), img = g.createImageData(T, T), d = img.data, r = rng(seed);
    const ink = o.ink ?? .07, white = o.white ?? .07, ic = rgb(C().ink);
    for (let i = 0; i < T * T; i++) { const v = r(); if (v < ink) { d[i * 4] = ic[0]; d[i * 4 + 1] = ic[1]; d[i * 4 + 2] = ic[2]; d[i * 4 + 3] = 10 + r() * 18; }
      else if (v < ink + white) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255; d[i * 4 + 3] = 20 + r() * 30; } }
    g.putImageData(img, 0, 0); this.grainTile = tile; this.seedShift = (seed % 997) * .013;
  },
  /** draw(ctx, T, { tint=accent, flow=1, glow=.45 }): flowing paper field (computed at low res, upscaled) */
  draw(ctx, T, o = {}) {
    const c = C(), cv = this.bg, g = cv.getContext('2d'), w = cv.width, h = cv.height, img = g.createImageData(w, h), d = img.data;
    const p0 = rgb(c.paper2), p1 = rgb(c.paper), tc = rgb(o.tint || c.accent), hi = [255, 253, 248], fl = (o.flow ?? 1), glow = o.glow ?? .45, sh = this.seedShift || 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const px = x / w * 1.5 + sh, py = y / h * 2.6;
      const q1 = fbm(px + T * .05 * fl, py + T * .03 * fl), q2 = fbm(px + 5.2 - T * .04 * fl, py + 1.3 + T * .05 * fl);
      const f = clamp((fbm(px * 1.2 + q1 * 1.7, py * 1.2 + q2 * 1.7) - .28) / .44), m = clamp((q1 - .5) * 2.2) * .07;
      const rx = (x / w - .5) * W(), ry = (y / h - .45) * H(), hl = glow * clamp(1 - Math.hypot(rx, ry) / (H() * .62)), i = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) d[i + k] = lerp(lerp(lerp(p0[k], p1[k], f), tc[k], m), hi[k], hl);
      d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'low'; ctx.drawImage(cv, 0, 0, W(), H()); ctx.restore();
  },
  /** grain(ctx): overlay the fixed-seed tile (locked to the canvas, never re-randomised) */
  grain(ctx) { ctx.save(); ctx.fillStyle = ctx.createPattern(this.grainTile, 'repeat'); ctx.fillRect(0, 0, W(), H()); ctx.restore(); },
};

/* ---------- icons (vector, theme-coloured) ---------- */
const icon = {
  sun(ctx, x, y, r, t = 0, col) { col = col || C().accent; ctx.save(); ctx.translate(x, y); ctx.rotate(t * .4); ctx.fillStyle = col; ctx.beginPath(); ctx.arc(0, 0, r * .5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = r * .12; ctx.lineCap = 'round'; for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; ctx.beginPath(); ctx.moveTo(Math.cos(a) * r * .68, Math.sin(a) * r * .68); ctx.lineTo(Math.cos(a) * r * .95, Math.sin(a) * r * .95); ctx.stroke(); } ctx.restore(); },
  moon(ctx, x, y, r, col, bg) { col = col || C().second; bg = bg || C().panel; ctx.save(); ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r * .7, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(x + r * .32, y - r * .22, r * .6, 0, Math.PI * 2); ctx.fill(); ctx.restore(); },
  monitor(ctx, x, y, s, col) { col = col || C().third; ctx.save(); ctx.translate(x, y); ctx.strokeStyle = col; ctx.lineWidth = s * .09; ctx.lineJoin = 'round'; rr(ctx, -s * .55, -s * .42, s * 1.1, s * .7, s * .08); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, s * .28); ctx.lineTo(0, s * .45); ctx.moveTo(-s * .25, s * .47); ctx.lineTo(s * .25, s * .47); ctx.stroke(); ctx.fillStyle = C().accent; ctx.fillRect(-s * .3, -s * .2, s * .6, s * .08); ctx.fillRect(-s * .3, -s * .02, s * .38, s * .08); ctx.restore(); },
  browser(ctx, x, y, s, col) { col = col || C().third; ctx.save(); ctx.translate(x, y); ctx.strokeStyle = col; ctx.lineWidth = s * .09; rr(ctx, -s * .55, -s * .42, s * 1.1, s * .84, s * .08); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-s * .55, -s * .18); ctx.lineTo(s * .55, -s * .18); ctx.stroke(); ctx.fillStyle = C().accent; [0, 1, 2].forEach(i => { ctx.beginPath(); ctx.arc(-s * .4 + i * s * .14, -s * .3, s * .045, 0, Math.PI * 2); ctx.fill(); });
    ctx.strokeStyle = C().second; ctx.lineWidth = s * .07; ctx.beginPath(); ctx.arc(0, s * .12, s * .17, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); },
  robot(ctx, x, y, s, col) { col = col || C().third; ctx.save(); ctx.translate(x, y); ctx.fillStyle = col; rr(ctx, -s * .42, -s * .3, s * .84, s * .62, s * .14); ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = s * .07; ctx.beginPath(); ctx.moveTo(0, -s * .3); ctx.lineTo(0, -s * .48); ctx.stroke(); ctx.beginPath(); ctx.arc(0, -s * .52, s * .06, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C().panel; [-1, 1].forEach(d => { ctx.beginPath(); ctx.arc(d * s * .17, -s * .05, s * .08, 0, Math.PI * 2); ctx.fill(); }); ctx.fillRect(-s * .16, s * .13, s * .32, s * .05); ctx.restore(); },
  check(ctx, x, y, s, col, p = 1) { col = col || C().second; const pts = [[-s * .35, 0], [-s * .08, s * .28], [s * .4, -s * .3]];
    ctx.save(); ctx.translate(x, y); ctx.strokeStyle = col; ctx.lineWidth = s * .16; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath(); ctx.moveTo(...pts[0]);
    if (p < .4) ctx.lineTo(lerp(pts[0][0], pts[1][0], p / .4), lerp(pts[0][1], pts[1][1], p / .4)); else { ctx.lineTo(...pts[1]); const q = (p - .4) / .6; ctx.lineTo(lerp(pts[1][0], pts[2][0], q), lerp(pts[1][1], pts[2][1], q)); }
    ctx.stroke(); ctx.restore(); },
  bubble(ctx, x, y, w, h, fill, tailRight) { ctx.save(); ctx.fillStyle = fill; rr(ctx, x, y, w, h, 30); ctx.fill(); ctx.beginPath();
    if (tailRight) { ctx.moveTo(x + w - 40, y + h - 4); ctx.lineTo(x + w + 14, y + h + 12); ctx.lineTo(x + w - 8, y + h - 34); } else { ctx.moveTo(x + 40, y + h - 4); ctx.lineTo(x - 14, y + h + 12); ctx.lineTo(x + 8, y + h - 34); }
    ctx.fill(); ctx.restore(); },
  star(ctx, x, y, r, col) { ctx.save(); ctx.fillStyle = col || C().third; ctx.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r2 = i % 2 ? r * .45 : r; ctx.lineTo(x + Math.cos(a) * r2, y + Math.sin(a) * r2); } ctx.closePath(); ctx.fill(); ctx.restore(); },
  warn(ctx, x, y, s, col) { col = col || C().ink; ctx.save(); ctx.translate(x, y); ctx.strokeStyle = col; ctx.lineWidth = s * .1; ctx.lineJoin = 'round'; ctx.beginPath(); ctx.moveTo(0, -s * .45); ctx.lineTo(s * .5, s * .4); ctx.lineTo(-s * .5, s * .4); ctx.closePath(); ctx.stroke();
    ctx.fillStyle = col; ctx.fillRect(-s * .05, -s * .18, s * .1, s * .32); ctx.beginPath(); ctx.arc(0, s * .27, s * .06, 0, Math.PI * 2); ctx.fill(); ctx.restore(); },
};

/* ---------- faint background motifs: pick one per scene (motif.draw(name, ctx, T, opts)) ---------- */
const motifs = {
  chat(ctx, T) { const c = C(); ctx.save(); ctx.globalAlpha = .08; ctx.strokeStyle = c.third; ctx.lineWidth = 5;
    for (let i = 0; i < 9; i++) { const x = (hash(i) * 1.2 - .1) * W(), y = ((hash(i * 3.1) + T * .025) % 1.15 - .08) * H(), w = 160 + hash(i * 7) * 180;
      rr(ctx, x, y, w, 90, 40); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x + 30, y + 90); ctx.lineTo(x + 16, y + 118); ctx.lineTo(x + 62, y + 90); ctx.stroke(); } ctx.restore(); },
  lines(ctx, T) { ctx.save(); ctx.globalAlpha = .08; ctx.fillStyle = C().third;
    for (let r = 0; r < Math.ceil(H() / 72) + 1; r++) { const y = 80 + r * 72 + ((T * 12) % 72); let x = 40; while (x < W() - 40) { const w = 40 + hash(r * 13 + x) * 140; ctx.fillRect(x, y, Math.min(w, W() - 40 - x), 14); x += w + 22; } } ctx.restore(); },
  dots(ctx, T) { ctx.save(); ctx.globalAlpha = .12; ctx.fillStyle = C().third; for (let y = 60; y < H(); y += 56) for (let x = 40; x < W(); x += 56) { const s = 2.5 + 2 * Math.sin(T * 1.4 + x * .01 + y * .007); ctx.beginPath(); ctx.arc(x, y, Math.max(1, s), 0, 7); ctx.fill(); } ctx.restore(); },
  tags(ctx, T, o = {}) { const c = C(); ctx.save(); ctx.globalAlpha = .08; ctx.strokeStyle = c.third; ctx.fillStyle = c.third; ctx.lineWidth = 5;
    for (let i = 0; i < 8; i++) { const x = hash(i * 2.3) * W(), y = ((hash(i * 5.7) + T * .02) % 1.1 - .05) * H();
      at(ctx, x, y, 1, hash(i) - .5, () => { rr(ctx, -80, -44, 160, 88, 14); ctx.stroke(); ctx.beginPath(); ctx.arc(-50, 0, 10, 0, 7); ctx.fill();
        XMS.type.text(ctx, o.symbol ?? '$', 20, 2, { size: 52, color: c.third, role: 'decor' }); }); } ctx.restore(); },
  speed(ctx, T, o = {}) { const k = o.k ?? 1; ctx.save(); ctx.globalAlpha = .1; ctx.strokeStyle = C().third; ctx.lineCap = 'round';
    for (let i = 0; i < 26; i++) { const y = hash(i * 1.9) * H(), len = 120 + hash(i * 4.1) * 300, x = W() + 300 - ((T * (400 + 900 * k) * (.6 + hash(i))) + hash(i * 8) * 3000) % (W() + 700);
      ctx.lineWidth = 4 + hash(i * 3) * 6; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len, y); ctx.stroke(); } ctx.restore(); },
  blocks(ctx, T) { ctx.save(); ctx.globalAlpha = .07; ctx.fillStyle = C().third; for (let i = 0; i < 14; i++) { const x = hash(i * 3.3) * W(), y = ((hash(i * 1.1) + T * .015) % 1.1 - .05) * H(); rr(ctx, x - 90, y, 180, 36, 10); ctx.fill(); rr(ctx, x - 70, y + 50, 140, 36, 10); ctx.fill(); } ctx.restore(); },
  flow(ctx, T) { ctx.save(); ctx.globalAlpha = .1; ctx.strokeStyle = C().second; ctx.lineWidth = 5; ctx.setLineDash([18, 22]); ctx.lineDashOffset = -T * 80;
    for (let i = 0; i < 7; i++) { const x = 80 + i * 150; ctx.beginPath(); ctx.moveTo(x, 0); ctx.bezierCurveTo(x + 120, H() * .3, x - 120, H() * .6, x + 60, H()); ctx.stroke(); } ctx.restore(); },
  notebook(ctx) { ctx.save(); ctx.globalAlpha = .16; ctx.strokeStyle = '#7C93A8'; ctx.lineWidth = 2; for (let y = 120; y < H(); y += 64) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W(), y); ctx.stroke(); }
    ctx.strokeStyle = C().accent; ctx.globalAlpha = .18; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(110, 0); ctx.lineTo(110, H()); ctx.stroke(); ctx.restore(); },
  /** glyphs: drifting strings; o: { strings[], count=10, headerFade=[250,420], dim=[560,1280,.45] } */
  glyphs(ctx, T, o = {}) { const S = o.strings || ['a² + b² = c²', '∑ 1/n²', 'f(x) ≤ C', '∀ ε > 0'], n = o.count ?? 10, hf = o.headerFade || [250, 420], dm = o.dim || [560, 1280, .45];
    for (let i = 0; i < n; i++) { const x = 100 + hash(i * 2.7) * (W() - 200), y = ((hash(i * 6.1) + 1 - T * .02 * (.6 + hash(i))) % 1.1 + 1.1) % 1.1 * H() - 40;
      const fy = clamp((y - hf[0]) / (hf[1] - hf[0])), mid = (y > dm[0] && y < dm[1]) ? dm[2] : 1, a = .11 * fy * mid; if (a < .005) continue;
      ctx.save(); ctx.globalAlpha *= a; XMS.type.text(ctx, S[i % S.length], x, y, { size: Math.round(40 + hash(i * 9) * 22), weight: 400, color: C().third, role: 'decor' }); ctx.restore(); } },
  stars(ctx, T, o = {}) { ctx.save(); ctx.globalAlpha = .1; for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6 + T * .05; icon.star(ctx, W() / 2 + Math.cos(a) * 420, (o.cy ?? 1000) + Math.sin(a) * 420, 34, C().third); } ctx.restore(); },
  coins(ctx, T) { ctx.save(); ctx.globalAlpha = .1; ctx.strokeStyle = C().accentText; ctx.lineWidth = 6;
    for (let i = 0; i < 11; i++) { const x = hash(i * 4.4) * W(), y = ((hash(i * 2.2) + T * .03 * (.5 + hash(i))) % 1.1 - .05) * H(), r = 34 + hash(i * 6) * 30;
      ctx.beginPath(); ctx.ellipse(x, y, r, r * .9, 0, 0, 7); ctx.stroke(); ctx.beginPath(); ctx.ellipse(x, y, r * .6, r * .54, 0, 0, 7); ctx.stroke(); } ctx.restore(); },
  grid(ctx) { ctx.save(); ctx.globalAlpha = .1; ctx.strokeStyle = C().third; ctx.lineWidth = 2; for (let x = 60; x < W(); x += 120) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H()); ctx.stroke(); } for (let y = 60; y < H(); y += 120) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W(), y); ctx.stroke(); } ctx.restore(); },
};
const motif = {
  names: () => Object.keys(motifs),
  /** draw(name, ctx, T, opts) */
  draw(name, ctx, T, o) { const f = motifs[name]; if (!f) throw Error('unknown motif: ' + name); f(ctx, T, o || {}); },
  /** register(name, fn(ctx, T, opts)) — add a project-specific motif */
  register(name, fn) { motifs[name] = fn; },
};

XMS.fx = { clamp, lerp, prog, ease, hash, rng, rr, card, pop, at, exitGroup, shake, glyphs, title, sub, shock, confetti, counter, particles, assemble,
  net, pill, chip, flip, stamp, chart, paper, icon, motif };
})();
