# XMS API 参考（lib/xms-core.js · xms-type.js · xms-fx.js）

所有效果都是 **(帧时间, seed, 参数) 的纯函数**：不用 `Math.random`、不读时钟、不在帧之间保存状态。
任何一帧都可以单独、乱序、在任意 worker 上渲染，结果逐像素一致（`xms.py preview` 会自动验证）。

约定：`t` = 镜头内秒数，`T` = 全片秒数，`k` = 距某个节拍点的秒数（`t - hit`）。坐标是 1080×1920 画布像素。
颜色默认取当前主题 `XMS.C`（见下文「主题角色」）。

---

## 1. 运行时 `XMS`（xms-core.js）

| API | 说明 |
|---|---|
| `XMS.onPrepare(async tl => …)` | 启动时执行一次（字体已加载、主题已就绪）。用来预计算粒子点、网络图、纸纹。 |
| `XMS.onFrame((ctx, a) => …)` | 每帧绘制。`a = { frame, t, T, dur, scene, index, prev, next, isFirst, isLast, hits, heavy, heavyAbs, timeline, W, H, fps }` |
| `XMS.C` | 当前主题颜色（含别名 `amber/amberT/teal/navy/sup`，方便老代码迁移）。 |
| `XMS.W / XMS.H / XMS.M / XMS.zones` | 画布尺寸、安全边距、小红书 UI 遮挡区。 |
| `XMS.font(weight, size)` | 返回显式加载的 Noto Sans CJK SC 字体串（不依赖系统 fallback）。 |
| `XMS.contrast(a, b)` / `XMS.validateTheme(theme, pairs)` | WCAG 对比度计算与主题校验。 |

帧契约（渲染器使用）：`window.__xmsMeta`、`window.xmsRenderFrame(frame)`、`window.__xmsReady`、`canvas#xms-canvas`。

```js
XMS.onPrepare(async tl => { XMS.fx.paper.prepare(tl.seed); });
XMS.onFrame((ctx, a) => {
  XMS.fx.paper.draw(ctx, a.T); XMS.fx.paper.grain(ctx);
  XMS.fx.title(ctx, a.scene.titleLines, a.t, { cy: 640 });
});
```

## 2. 中文排版 `XMS.type`（xms-type.js）

| API | 说明 |
|---|---|
| `layout(ctx, lines, o)` | 多行标题排版：逐字测量换行、避头尾、中西文自动间距、按墨迹光学居中、自动缩放。 |
| `text(ctx, s, x, y, o)` | 单行文字，默认按**墨迹**居中。`o: { size=48, weight=700, color, align='center'|'left'|'right', halo, maxW, role }` |
| `rich(ctx, parts, cx, baseline, scale, o)` | 同一基线混排不同字号（数字 + 单位），整体墨迹居中，默认带纸色描边。 |
| `measure(ctx, font, s)` | 缓存的 `{ w, l, r, a, d }` 墨迹度量。 |
| `parse(line)` / `units(line)` | `{强调}` 标记解析 / 断行单元（拉丁词整体、CJK 单字）。 |

`layout` 选项：`{ size, weight=700, cx=W/2, cy, maxW=W-2M, maxLines=lines.length, minScale=.84, lh=1.24, avoidOrphan=true }`
返回：`{ size, font, rows[{y, x0, inkL, inkR, text}], glyphs[{ch, x, y, w, acc, i, row}], left, right, top, bottom }`

规则细节：
- **避头尾**：`，。、：；！？）」』》…%` 等不出现在行首（会把上一行最后一个单元一起带下来）；`（「『《“` 等不出现在行尾。
- **中西文间距**：汉字与拉丁/数字相邻且未手动加空格时，自动插入 0.2em。
- **自动适配**：先按 3% 步长缩小到 `size × minScale`，仍放不下才换行；行数超过 `maxLines` 时继续缩小。
- **孤字处理**：最后一行只剩 1 个字时自动回调上一行。

```js
const L = XMS.type.layout(ctx, ['免费用户', '也能用 {GPT-6} 了'], { size: 116, cy: 640 });
XMS.type.text(ctx, '柱高 = 输出价（每百万 token）', 540, 1374, { size: 40, weight: 400, color: XMS.C.support, halo: true });
XMS.type.rich(ctx, [{ text: '12', size: 150, color: XMS.C.accentText }, { text: ' 亿+', size: 96, color: XMS.C.ink }], 540, 1500);
```

## 3. 效果库 `XMS.fx`（xms-fx.js）

### 基础
`clamp, lerp, prog(t, start, dur), ease.{out,in,inOut,back}, hash(n), rng(seed)`（仅用于预计算）,
`rr(ctx,x,y,w,h,r)`, `card(ctx,x,y,w,h,{r,fill,stroke,lw,shadow})`, `pop(t, at, d=.45)`（0→回弹→1）,
`at(ctx, x, y, scale, rot, fn)`（局部坐标）, `exitGroup(ctx, q, fn)`（淡出 + 微缩）, `shake(T, heavyAbs, amp=13) → [dx, dy]`。

### 文字效果
| 效果 | API | 示例 |
|---|---|---|
| word-cascade（逐字落入） | `title(ctx, lines, t, { cy, size=112, start=0, stagger=.04, dur=.5, seed })` | `fx.title(ctx, s.titleLines, t, { cy: 430, start: -.12, seed: 21 })` |
| letter-explode（逐字炸出） | `title(..., { exitAt })` 或 `glyphs(ctx, L, t, { exitAt, exitDur=.3 })` | `fx.title(ctx, lines, t, { cy: 430, exitAt: dur - .3 })` |
| 副标题 | `sub(ctx, text, t, start, cy, { size=54, exitAt, color })` | `fx.sub(ctx, s.sub, t, 2.0, 1300, { exitAt })` |
| counter-explosion（数字滚动+落地爆点） | `counter(ctx, t, { start, land, from, to, cx, base, parts(v, landed), h, r, seed, n, ring })` | 见下 |
| particles→text（粒子汇聚成字） | `P = particles(text, { size, weight, cx, cy, step=8, inkCenter })` + `assemble(ctx, P, t, { start, land, seed, color, dot })` | 见下 |

```js
fx.counter(ctx, t, { start: 2.0, land: 3.0, from: 0, to: 12, cx: 540, base: 1500, h: 140, seed: 5,
  parts: v => [{ text: Math.round(v) + '', size: 150, color: C.accentText }, { text: ' 亿+', size: 96, color: C.accentText }] });

// onPrepare: P.n = fx.particles('372', { size: 330, cx: 540, cy: 700, inkCenter: true });
fx.assemble(ctx, P.n, t, { start: 0, land: 2.0, seed: 372 });
```

### 节拍点效果
| 效果 | API |
|---|---|
| shockwave（冲击环） | `shock(ctx, x, y, k, color=accent, maxR=460, rings=2)` |
| confetti（彩纸） | `confetti(ctx, x, y, k, seed=1, n=64, { palette, speed=1 })` |
| 镜头震动 | `const [dx, dy] = shake(a.T, a.heavyAbs)` → `ctx.translate(dx, dy)` |

### 组件
| 组件 | API |
|---|---|
| 段落标签 pill | `pill(ctx, label, t, { y=160, enter=true, filled=/^[①-⑳]/, size=42 })` |
| chips/badges pop | `chip(ctx, t, { at, x, y, label, icon, w=460, h=132, size=52, fill, color, ring=true })` |
| card flip | `flip(ctx, t, { at, dur=.5, cx, cy, front: () => …, back: () => … }) → 是否正面` |
| 印章 stamp | `stamp(ctx, t, { at, x, y, w=540, h=190, label, size=112, rot=-.1, lw=12, r=26 })` |
| rising chart | `chart(ctx, t, { points: [[x,y]…], start=.4, dur=1.8, color, width=8, dashed=true, endLabel, labelSize=80 }) → 进度` |
| network motif | `N = net.make(seed, n, cx, cy, rx, ry)`（预计算）+ `net.draw(ctx, N, t, { reveal, pulses })` |
| 图标 | `icon.{sun, moon, monitor, browser, robot, check, bubble, star, warn}` |

```js
fx.chip(ctx, t, { at: 1.2, x: 290, y: 1340, label: '自带云电脑', icon: 'monitor' });
fx.flip(ctx, t, { at: 6, cx: 540, cy: 1000, front: () => drawFront(), back: () => drawBack() });
fx.stamp(ctx, t, { at: 3, x: 540, y: 1130, label: '全部到位' });
fx.chart(ctx, t, { points: [[130,1420],[450,1330],[760,1150],[940,1050]], endLabel: '?' });
```

### 背景
| API | 说明 |
|---|---|
| `paper.prepare(seed, { res=[W/9,H/9], tile=512, ink=.07, white=.07 })` | 预生成低分辨率噪声画布与固定颗粒贴图（一次）。 |
| `paper.draw(ctx, T, { tint, flow=1, glow=.45 })` | 流动纸纹（低分辨率计算后放大，约 2–4 ms/帧）。 |
| `paper.grain(ctx)` | 叠加固定 seed 的颗粒贴图（平铺 pattern，不逐帧随机）。 |
| `motif.draw(name, ctx, T, opts)` | 每镜头**一个**淡背景母题：`chat, lines, dots, tags{symbol}, speed{k}, blocks, flow, notebook, glyphs{strings}, stars, coins, grid` |
| `motif.register(name, fn)` | 注册项目自定义母题。 |

## 4. 主题角色（lib/themes.json）

`paper, paper2, panel, card, ink, support, accent, accentText, accentOnDark, second, third, line, mute, onDark, onDarkSoft, halo, warm`

- 大面积填充用 `accent`，**文字**一律用 `accentText`（对比度 ≥ 4.5:1）。深色卡片上的强调字用 `accentOnDark`。
- 内置主题：`editorial-amber`（默认，暖纸 + 琥珀）、`mint-notes`（薄荷绿）、`sky-memo`（晴空蓝）。
- `themes.json → contrastPairs` 列出必须 ≥ 4.5:1 的前景/背景组合；启动时与 QA 时都会校验。
- 项目可在 `storyboard.json → themeOverrides` 覆盖单个颜色（覆盖后同样会被校验）。

## 5. QA 日志

所有文字 API 都会在 QA 模式下记录 `{ text, box, color, size, halo, alpha, role, moving, group }`。
自己用 `ctx.fillText` 画的字 QA 看不到 —— 请统一用 `type.text / rich / title / sub`。
装饰性文字传 `role: 'decor'`（只做违禁词扫描，不参与对比度/重叠检查）。
