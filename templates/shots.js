/* shots.js — scene drawing for this project (XHS Motion Studio template).
 * Rules: draw everything from (a.t / a.T, a.scene, a.timeline.seed); no Math.random, no Date, no state across frames.
 * On-screen copy lives in storyboard.json (titleLines / sub / segment) so the QA scanner sees all of it.
 */
(() => {
const { fx, type } = XMS;
const { prog, ease, pop, at, card, exitGroup, shake } = fx;
const P = {};

/* One function per scene id. Unknown ids fall back to `default` (title + sub). */
const SC = {
  default(ctx, a) {
    fx.title(ctx, a.s.titleLines, a.t, { cy: 640, size: 112, start: -.12, exitAt: a.ex, seed: a.index * 10 + 1 });
    fx.sub(ctx, a.s.sub, a.t, 1.2, 900, { exitAt: a.ex });
  },
  's01-hook'(ctx, a) {
    const C = XMS.C, L = fx.title(ctx, a.s.titleLines, a.t, { cy: 620, size: 116, start: .05, exitAt: a.ex, seed: 11 });
    const g = L.glyphs.filter(x => x.acc), cx = g.length ? (g[0].x + g[g.length - 1].x) / 2 : XMS.W / 2, cy = g.length ? g[0].y : 620;
    fx.shock(ctx, cx, cy, a.t - a.s.hits[0], C.accent, 380); fx.confetti(ctx, cx, cy, a.t - a.s.hits[0], 3, 50);
    exitGroup(ctx, a.q, () => fx.chip(ctx, a.t, { at: 1.6, x: XMS.W / 2, y: 1100, label: '交给它就行', icon: 'robot', w: 560 }));
  },
  's02-point'(ctx, a) {
    const s = a.s;
    fx.title(ctx, s.titleLines, a.t, { cy: 430, size: 112, start: -.12, exitAt: a.ex, seed: 21 });
    exitGroup(ctx, a.q, () => {
      [['整理', 300, 820, 'browser'], ['计算', 780, 820, 'monitor'], ['汇报', 540, 1040, 'check']].forEach(([label, x, y, icon], i) =>
        fx.chip(ctx, a.t, { at: s.hits[i], x, y, label, icon, w: 400 }));
      fx.counter(ctx, a.t, { start: 3.2, land: s.hits[3], from: 0, to: 3, cx: XMS.W / 2, base: 1400, h: 140,
        parts: v => [{ text: Math.round(v) + '', size: 160, color: XMS.C.accentText }, { text: ' 步', size: 80, color: XMS.C.ink }] });
    });
    fx.sub(ctx, s.sub, a.t, 2.4, 1560, { exitAt: a.ex });
  },
  's03-ending'(ctx, a) {
    const s = a.s;
    fx.title(ctx, [s.titleLines[0]], a.t, { cy: 640, size: 104, start: -.12, seed: 31 });
    fx.title(ctx, [s.titleLines[1]], a.t, { cy: 820, size: 116, start: .5, seed: 32, skipAcc: true });
    fx.assemble(ctx, P.endWord, a.t, { start: .3, land: s.hits[0], seed: 33 });
    fx.sub(ctx, s.sub, a.t, 3.0, 1500, { size: 44 });
  },
};

XMS.onPrepare(async tl => {
  fx.paper.prepare(tl.seed);
  // particles→text needs the final glyph position of the accented word, measured once with the real layout
  const end = tl.scenes.find(s => s.id === 's03-ending');
  if (end) {
    const ctx = document.createElement('canvas').getContext('2d');
    const L = type.layout(ctx, [end.titleLines[1]], { size: 116, cy: 820 });
    const g = L.glyphs.filter(x => x.acc);
    P.endWord = fx.particles(g.map(x => x.ch).join(''), { size: L.size, cx: (g[0].x - g[0].w / 2 + g[g.length - 1].x + g[g.length - 1].w / 2) / 2, cy: 820, step: 6 });
  }
});

XMS.onFrame((ctx, a) => {
  const s = a.scene, C = XMS.C;
  fx.paper.draw(ctx, a.T, { tint: C[s.tint] || C.accent });     // bright paper field
  if (s.motif) fx.motif.draw(s.motif, ctx, a.T, s.motifOptions);  // ONE faint motif per scene
  fx.paper.grain(ctx);
  const [dx, dy] = shake(a.T, a.heavyAbs);                        // camera kick on heavy beats
  ctx.save(); ctx.translate(dx, dy);
  if (s.segment) fx.pill(ctx, s.segment, a.t, { enter: !a.prev || a.prev.segment !== s.segment });
  const ex = a.isLast ? undefined : a.dur - .3, q = a.isLast ? 0 : prog(a.t, a.dur - .3, .3);
  (SC[s.id] || SC.default)(ctx, { ...a, s, ex, q });
  ctx.restore();
});
})();
