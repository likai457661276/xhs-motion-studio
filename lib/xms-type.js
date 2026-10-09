/* xms-type.js — CJK-first typography for canvas video (XHS Motion Studio, MIT License).
 * - text is measured with the explicitly loaded face (XMS.FAMILY), never a system fallback
 * - per-character wrapping; Latin words / numbers stay whole
 * - kinsoku: closing punctuation never starts a row, opening brackets never end one
 * - automatic CJK↔Latin spacing when the source has no space
 * - optical centering on measured ink bounds (trailing ，：」 no longer push a row off-center)
 * - auto-fit: largest size within [minSize, size] that keeps every source line on maxLines rows
 * Markup: {强调} marks accent characters.  All functions are pure for a given input.
 */
(() => {
const XMS = window.XMS = window.XMS || {};
const NO_START = new Set(Array.from('，。、：；！？）」』》〉】〕”’…·%‰,.;:!?)]}～ー々'));
const NO_END = new Set(Array.from('（「『《〈【〔“‘([{'));
const LATIN = /[A-Za-z0-9.,\-+\/$%×_'&#@~^=<>]/;
const IDEO = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const mcache = new Map();
function measure(ctx, font, s) {
  const k = font + '\u0000' + s; let m = mcache.get(k);
  if (!m) { ctx.font = font; const r = ctx.measureText(s);
    m = { w: r.width, l: r.actualBoundingBoxLeft, r: r.actualBoundingBoxRight, a: r.actualBoundingBoxAscent, d: r.actualBoundingBoxDescent };
    mcache.set(k, m); }
  return m;
}
function parse(src) {
  const out = []; let acc = false;
  for (const ch of Array.from(String(src))) { if (ch === '{') { acc = true; continue; } if (ch === '}') { acc = false; continue; } out.push({ ch, acc }); }
  return out;
}
/* units: Latin runs are atomic, spaces are separate, everything else is one char */
function units(chars) {
  const u = []; let cur = null;
  for (const c of chars) {
    const kind = c.ch === ' ' ? 'space' : LATIN.test(c.ch) ? 'latin' : 'cjk';
    if (kind === 'latin' && cur && cur.kind === 'latin' && cur.acc === c.acc) { cur.chars.push(c); continue; }
    cur = { kind, acc: c.acc, chars: [c] }; u.push(cur);
  }
  u.forEach(x => { x.text = x.chars.map(c => c.ch).join(''); });
  return u;
}
function gapBetween(a, b, size, gap) {
  if (!a || !b || a.kind === 'space' || b.kind === 'space') return 0;
  const ai = a.kind === 'cjk' && IDEO.test(a.text), bi = b.kind === 'cjk' && IDEO.test(b.text);
  return (ai && b.kind === 'latin') || (bi && a.kind === 'latin') ? size * gap : 0;
}
function rowMetrics(ctx, font, row, size, gap) {
  let x = 0; const pos = [];
  row.forEach((u, i) => { x += gapBetween(row[i - 1], u, size, gap); pos.push(x); x += measure(ctx, font, u.text).w; });
  let first = row.findIndex(u => u.kind !== 'space'), last = row.length - 1; while (last >= 0 && row[last].kind === 'space') last--;
  if (first < 0) return { pos, adv: x, inkL: 0, inkR: 0 };
  const mf = measure(ctx, font, row[first].text), ml = measure(ctx, font, row[last].text);
  return { pos, adv: x, inkL: pos[first] - mf.l, inkR: pos[last] + ml.r };
}
const trim = row => { let a = 0, b = row.length; while (a < b && row[a].kind === 'space') a++; while (b > a && row[b - 1].kind === 'space') b--; return row.slice(a, b); };
function wrapUnits(ctx, font, us, maxW, size, gap) {
  const rows = []; let row = [];
  const width = r => { const m = rowMetrics(ctx, font, trim(r), size, gap); return m.inkR - Math.min(0, m.inkL); };
  for (const u of us) {
    const trial = row.concat([u]);
    if (row.length && u.kind !== 'space' && width(trial) > maxW) {
      let carry = [];
      if (u.kind === 'cjk' && NO_START.has(u.text)) { const t = trim(row); if (t.length > 1) { carry = [t[t.length - 1]]; row = t.slice(0, -1); } }
      let t = trim(row);
      while (t.length > 1 && t[t.length - 1].kind === 'cjk' && NO_END.has(t[t.length - 1].text)) { carry.unshift(t.pop()); }
      rows.push(t); row = carry.concat([u]);
    } else row = trial;
  }
  if (trim(row).length) rows.push(trim(row));
  return rows;
}
/** layout(ctx, lines, o) → { size, weight, lh, rows[], glyphs[], left, right, top, bottom }
 * o: { size, weight=700, cx=W/2, cy, maxW=W-2M, maxLines=lines.length, minSize=size*.84, lh=1.24, gap=.2, align='center', left, avoidOrphan=true } */
const lcache = new Map();
function layout(ctx, lines, o = {}) {
  lines = Array.isArray(lines) ? lines.flatMap(l => String(l).split('\n')) : String(lines).split('\n');
  const key = JSON.stringify([lines, o]); if (lcache.has(key)) return lcache.get(key);
  const W = XMS.W || 1080, M = XMS.M ?? 60;
  const weight = o.weight ?? 700, maxW = o.maxW ?? (W - 2 * M), cx = o.cx ?? W / 2, gap = o.gap ?? .2;
  const maxLines = o.maxLines ?? lines.length, top = o.size, minSize = o.minSize ?? Math.floor(top * (o.minScale ?? .84));
  const parsed = lines.map(l => units(parse(l)));
  let size = top, rows = null;
  for (;;) {
    const font = XMS.font(weight, size);
    rows = parsed.flatMap(us => wrapUnits(ctx, font, us, maxW, size, gap));
    if (rows.length <= maxLines || size <= minSize) break;
    size = Math.max(minSize, size - Math.max(1, Math.round(size * .03)));
  }
  const font = XMS.font(weight, size);
  if (o.avoidOrphan !== false && rows.length > lines.length) {           /* re-balance a lone trailing character */
    const lastLen = r => r.filter(u => u.kind !== 'space' && !NO_START.has(u.text)).length;
    if (lastLen(rows[rows.length - 1]) <= 1) for (let k = .96; k > .6; k -= .04) {
      const alt = parsed.flatMap(us => wrapUnits(ctx, font, us, maxW * k, size, gap));
      if (alt.length === rows.length && lastLen(alt[alt.length - 1]) > 1) { rows = alt; break; }
    }
  }
  const lh = size * (o.lh ?? 1.24), glyphs = []; let gi = 0;
  const outRows = rows.map((row, ri) => {
    const m = rowMetrics(ctx, font, row, size, gap);
    const x0 = o.align === 'left' ? (o.left ?? M) - m.inkL : o.align === 'right' ? (o.right ?? W - M) - m.inkR : cx - (m.inkL + m.inkR) / 2;
    const y = o.cy - (rows.length - 1) * lh / 2 + ri * lh;
    let afterSpace = false;
    row.forEach((u, k) => {
      if (u.kind === 'space') { afterSpace = true; return; }
      let pref = '', first = true;
      for (const c of u.chars) { const pw = measure(ctx, font, pref).w, gm = measure(ctx, font, c.ch), cw = gm.w; pref += c.ch;
        const gx = x0 + m.pos[k] + pw;  /* left origin of this glyph; ink spans [gx - l, gx + r] */
        glyphs.push({ ch: c.ch, x: gx + cw / 2, y, w: cw, il: gx - gm.l, ir: gx + gm.r, acc: c.acc, i: gi++, row: ri, sp: first && afterSpace }); first = false; }
      afterSpace = false;
    });
    return { y, x0, inkL: x0 + m.inkL, inkR: x0 + m.inkR, text: row.map(u => u.text).join('') };
  });
  const asc = size * .56;
  const res = { size, weight, lh, font, rows: outRows, glyphs, maxW,
    left: Math.min(...outRows.map(r => r.inkL)), right: Math.max(...outRows.map(r => r.inkR)),
    top: outRows[0].y - asc, bottom: outRows[outRows.length - 1].y + asc };
  lcache.set(key, res); return res;
}
/* halo: a paper-coloured stroke behind glyphs keeps text readable over motifs, grain and particles */
function haloStyle(ctx, size, halo) { ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(6, size * .14); ctx.strokeStyle = typeof halo === 'string' ? halo : (XMS.C ? XMS.C.halo : 'rgba(250,248,243,.92)'); }
/** text(ctx, s, x, y, o) — single line, ink-centered by default. o: { size, weight=700, color, align='center'|'left'|'right', halo=false, maxW, role } */
function text(ctx, s, x, y, o = {}) {
  s = String(s); if (!s) return null;
  let size = o.size ?? 48; const weight = o.weight ?? 700;
  if (o.maxW) { const w = measure(ctx, XMS.font(weight, size), s).w; if (w > o.maxW) size = Math.floor(size * o.maxW / w); }
  const font = XMS.font(weight, size), m = measure(ctx, font, s);
  ctx.save(); ctx.font = font; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  let left = x; const align = o.align ?? 'center';
  if (align === 'center') left = x - (m.r - m.l) / 2;   /* ink box [left-m.l, left+m.r] centered on x */
  if (align === 'right') left = x - m.w;
  const color = o.color ?? (XMS.C ? XMS.C.ink : '#000');
  XMS.logText && XMS.logText(ctx, { text: s, x0: left - m.l, x1: left + m.r, y0: y - size * .56, y1: y + size * .56, color, size, halo: !!o.halo,
    align, cx: align === 'center' ? x : null, role: o.role || 'text', moving: !!o.moving });
  if (!(XMS.qa && XMS.qa.suppressText && (o.role || 'text') !== 'decor')) {   /* QA background pass hides text but keeps decor */
    if (o.halo) { ctx.save(); haloStyle(ctx, size, o.halo); ctx.strokeText(s, left, y); ctx.restore(); }
    ctx.fillStyle = color; ctx.fillText(s, left, y);
  }
  ctx.restore();
  return { left: left - m.l, right: left + m.r, size };
}
/** rich(ctx, parts, cx, baseline, scale=1) — mixed sizes on one baseline, ink-centered on cx, haloed.
 * parts: [{ text, size, color, weight=700 }] */
function rich(ctx, parts, cx, base, scale = 1, o = {}) {
  const ms = parts.map(p => measure(ctx, XMS.font(p.weight ?? 700, p.size), p.text));
  const adv = ms.reduce((a, m) => a + m.w, 0), hmax = Math.max(...parts.map(p => p.size));
  const inkL = -ms[0].l, inkR = adv - ms[ms.length - 1].w + ms[ms.length - 1].r;
  const xl = cx - (inkL + inkR) / 2, py = base - hmax * .36;
  ctx.save(); ctx.translate(cx, py); ctx.scale(scale, scale); ctx.translate(-cx, -py);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  const gid = XMS.qa && XMS.qa.on ? 'g' + (XMS.qa.gid = (XMS.qa.gid || 0) + 1) : null;
  let x = xl;
  parts.forEach((p, i) => { XMS.logText && XMS.logText(ctx, { text: p.text, x0: x - ms[i].l, x1: x + ms[i].r, y0: base - ms[i].a, y1: base + ms[i].d,
    color: p.color, size: p.size, halo: o.halo !== false, align: 'rich', cx, role: o.role || 'rich', group: gid, moving: !!o.moving }); x += ms[i].w; });
  if (!(XMS.qa && XMS.qa.suppressText)) {
    if (o.halo !== false) { x = xl; parts.forEach((p, i) => { ctx.font = XMS.font(p.weight ?? 700, p.size); haloStyle(ctx, p.size * .86, o.halo); ctx.strokeText(p.text, x, base); x += ms[i].w; }); }
    x = xl; parts.forEach((p, i) => { ctx.font = XMS.font(p.weight ?? 700, p.size); ctx.fillStyle = p.color ?? XMS.C.ink; ctx.fillText(p.text, x, base); x += ms[i].w; });
  }
  ctx.restore();
  return { left: cx - (inkR - inkL) / 2, right: cx + (inkR - inkL) / 2, width: adv };
}
XMS.type = { layout, text, rich, measure, parse, units, haloStyle, NO_START, NO_END };
})();
