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
| `XMS.style` | 当前画风预设（`{ id, background, grain, grainInk, shadow, misregister, cardRadius, theme, label }`），fx 据此切换背景/投影/套印效果。 |
| `XMS.images[id]` | storyboard `images` 中登记的图片（启动时解码为 `ImageBitmap`），用 `fx.image` 绘制。 |
| `XMS.markIllustrative()` | 声明当前帧含示意画面 → 运行时自动画「示意画面」标签。 |
| `XMS.noteChart(kind, { illustrative, dataSource })` | 图表类效果自报（内置 `chart/candles/bars` 已自动调用），供 QA 检查来源。 |
| `XMS.labels` / `XMS.badge(...)` | 标签配置与绘制（由运行时调用，镜头代码一般无需直接使用）。 |

**示意画面标签**：每帧镜头代码执行完后，运行时在以下情况自动绘制半透明圆角标签（默认右上角、30 px、不透明度 0.92，
位于边距内、状态栏下方、底部文案栏上方，并避开右侧按钮列）：镜头 `illustrative: true` / `{from, to}` 生效中，
或本帧有元素以 `illustrative: true` 绘制、或调用了 `XMS.markIllustrative()`。配置：storyboard `illustrativeLabel { enabled, text, corner, opacity }`，
`corner ∈ top-left | top-right | bottom-left | bottom-right`。封面裁切时标签会重新放进 3:4 画面内。

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
| rising chart | `chart(ctx, t, { points: [[x,y]…], start=.4, dur=1.8, color, width=8, dashed=true, endLabel, labelSize=80, illustrative, dataSource }) → 进度` |
| K 线 | `candles(ctx, t, { x, y, w, h, data: [[开, 高, 低, 收]…], start=.3, stagger=.06, cn=true（红涨绿跌）, up, down, min, max, illustrative, dataSource })` |
| 横向柱状图 | `bars(ctx, t, { x, y, w, rowH=110, size=44, items: [{ label, value, text, color }], max, start=.3, stagger=.12, valueFmt, illustrative, dataSource })` |
| network motif | `N = net.make(seed, n, cx, cy, rx, ry)`（预计算）+ `net.draw(ctx, N, t, { reveal, pulses })` |
| 图标 | `icon.{sun, moon, monitor, browser, robot, check, bubble, star, warn}` |

```js
fx.chip(ctx, t, { at: 1.2, x: 290, y: 1340, label: '自带云电脑', icon: 'monitor' });
fx.flip(ctx, t, { at: 6, cx: 540, cy: 1000, front: () => drawFront(), back: () => drawBack() });
fx.stamp(ctx, t, { at: 3, x: 540, y: 1130, label: '全部到位' });
fx.chart(ctx, t, { points: [[130,1420],[450,1330],[760,1150],[940,1050]], endLabel: '?', illustrative: true });
fx.bars(ctx, t, { x: 120, y: 1120, w: 840, size: 52, dataSource: '官方定价页 2026-10', items: [{ label: '输入', value: 1, text: '$1' }, { label: '输出', value: 5, text: '$5' }] });
```

> 图表类效果（`chart / candles / bars`）必须二选一：`dataSource: '出处'`（真实数据）或 `illustrative: true`（示意，自动加标签）。
> 镜头级的 `dataSource` / `illustrative` 同样算数。都没有 → QA 警告 `chart-source`。

### 图像图层（AI 生图主体 + 代码动效）
`image(ctx, t, id, o) → { x, y, w, h } | null` —— 全部为 `t` 的纯函数。

| 选项 | 说明 |
|---|---|
| `x, y` | 中心点（默认画布中心） |
| `w` / `scale` | 显示宽度（高度按比例）/ 相对原图缩放 |
| `at, dur=.6` | 入场时间与时长；`enter` 设置后 `t < at` 时不绘制 |
| `enter` | `'bounce'`（落下 + 两次衰减回弹）、`'pop'`（回弹放大）、`'slide-left' / 'slide-right' / 'slide-up'`、`'fade'` |
| `float, floatHz=.35` | 上下漂浮幅度（px）与频率 |
| `drift: [dx, dy]` | 视差漂移（px/秒） |
| `rot, wobble, wobbleHz=.4` | 固定旋转（弧度）与轻微摆动幅度 |
| `shadow=true` | 投影随画风：柔和模糊 / 扁平地面椭圆 / 孔版硬投影 |
| `exitAt, exitDur=.35` | 淡出 + 微缩 |
| `flip, alpha, illustrative` | 水平镜像、不透明度、标记示意 |

```js
fx.image(ctx, a.t, 'mascot', { x: 540, y: 1140, w: 400, at: a.s.hits[0], enter: 'bounce', float: 10, wobble: .03 });
fx.image(ctx, a.t, 'mascot', { x: 840, y: 1180, w: 260, enter: 'slide-left', float: 14, drift: [-6, 0] });
```

登记（storyboard.json）：`"images": [{ "id": "mascot", "src": "assets/images/mascot.png", "prompt": "…完整提示词…", "ai": true }]`。
`ai: true` 的图片必须保留生成提示词 `prompt`（便于复现与溯源）；文件还需在 `assets.json` 声明（定稿时随素材锁校验）。

抠图：`xms.py cutout <in.png> --out assets/images/<id>.png [--threshold 238] [--soft 18] [--feather 1.0] [--trim] [--pad 12]`
—— 只把**与图像边缘连通**的白/近白区域变透明（主体内部的白色保留），2 px 抗锯齿边缘按邻近墨色估算覆盖率，
内向羽化，半透明边缘从白色中反解颜色（不留白边）。输出一行 JSON 报告；主体碰到图像边缘时给出警告。

### AI 生图提示词模板
```
[主体]：一个 <主体描述>，<姿势/动作>，<视角>。
[部件颜色，跨图保持一致]：<部件1> 为 <颜色名 #HEX>，<部件2> 为 <颜色名 #HEX>，<描边：深色粗描边 #16181D>。
[风格]：<flat vector illustration | soft paper-cut | risograph print look>，简洁形状，少细节，适合竖屏短视频主体。
[配色提示，与所选画风主题一致]：主色 <accent #HEX>，辅色 <second #HEX>，点缀 <warm #HEX>。
[硬性要求]：画面中不要任何文字、字母、数字、标志或水印（no text, no letters, no numbers, no logo, no watermark）；
纯白背景（plain pure white background #FFFFFF），背景上无阴影、无渐变、无地面；主体完整、四周留白，不贴边。
```
各画风的配色提示：`editorial-paper` → #E85D04 / #1F4E5F / #F2B84B；`flat-illustration` → #FF6B4A / #2F5BEA / #FFB547；
`riso-print` → #FF48B0 / #005B96 / #FFE14D。同一主体的多张图，部件颜色那一行逐字复用。

### 背景
| API | 说明 |
|---|---|
| `paper.prepare(seed, { res=[W/9,H/9], tile=512, ink=.07, white=.07 })` | 预生成低分辨率噪声画布与固定颗粒贴图（一次）。 |
| `paper.draw(ctx, T, { tint, flow=1, glow=.45 })` | 背景随画风切换：`paper` 流动纸纹（约 2–4 ms/帧）· `flat` 浅底 + 缓慢漂移的大色块 · `halftone` 米色纸 + 双色网点（预渲染，轻微平移）。 |
| `paper.grain(ctx)` | 叠加固定 seed 的颗粒贴图（平铺 pattern，不逐帧随机）；`flat-illustration` 画风下不绘制。 |
| `motif.draw(name, ctx, T, opts)` | 每镜头**一个**淡背景母题：`chat, lines, dots, tags{symbol}, speed{k}, blocks, flow, notebook, glyphs{strings}, stars, coins, grid` |
| `motif.register(name, fn)` | 注册项目自定义母题。 |

## 4. 画风预设（lib/themes.json → styles）

| id | 名称 | 主题 | 背景 | 颗粒 | 卡片/图片投影 | 标题 |
|---|---|---|---|---|---|---|
| `editorial-paper` | 编辑纸张风 | `editorial-amber` | 流动纸纹 | 细 | 柔和模糊 | 常规 |
| `flat-illustration` | 扁平插画风 | `flat-pop` | 浅底 + 大色块 | 无 | 无投影 + 细描边 | 常规 |
| `riso-print` | 孔版印刷风 | `riso-ink` | 双色网点 | 粗 | 强调色硬投影 + 墨色描边 | 第二色套印错位 |

- `xms.py styles <proj> --shot <id> [--t 秒] [--styles a,b,c] [--out 路径]`：同一帧分别用各画风渲染，拼成带 A/B/C 标注的对比图
  （页面内合成，使用项目字体），并写出同名 `.json`（字母 ↔ 预设 id）。
- storyboard `"style"` 写入选中的 id。未设置时定稿命令拒绝执行；`theme` 未显式指定时取画风自带的主题。
- 预览页可用 `index.html?style=<id>` 临时查看其它画风（仅草稿用途）。

## 5. 主题角色（lib/themes.json）

`paper, paper2, panel, card, ink, support, accent, accentText, accentOnDark, second, third, line, mute, onDark, onDarkSoft, halo, warm`

- 大面积填充用 `accent`，**文字**一律用 `accentText`（对比度 ≥ 4.5:1）。深色卡片上的强调字用 `accentOnDark`。
- 内置主题：`editorial-amber`（暖纸 + 琥珀）、`mint-notes`（薄荷绿）、`sky-memo`（晴空蓝）、`flat-pop`（扁平明快）、`riso-ink`（孔版双色）。
- `themes.json → contrastPairs` 列出必须 ≥ 4.5:1 的前景/背景组合；启动时与 QA 时都会校验。
- 项目可在 `storyboard.json → themeOverrides` 覆盖单个颜色（覆盖后同样会被校验）。

## 6. QA 日志

所有文字 API 都会在 QA 模式下记录 `{ text, box, color, size, halo, alpha, role, moving, group }`。
自己用 `ctx.fillText` 画的字 QA 看不到 —— 请统一用 `type.text / rich / title / sub`。
装饰性文字传 `role: 'decor'`（只做违禁词扫描，不参与对比度/重叠检查）。
标签以 `role: 'badge-illustrative'` 记录（不受最小字号限制，但参与对比度、重叠与安全区检查）。
`runs.jsonl` 每帧还记录 `need`（本帧是否必须显示「示意画面」）与 `charts`（图表类效果及其是否有来源/示意标记）。

## 7. storyboard.json 新增字段

| 字段 | 说明 |
|---|---|
| `factBoundary` | **必填**（否则 QA 失败）：`{ real: [], illustrative: [], unverified: [], sources: [{ name, url, date }] }`，四项均为数组，`sources` 不能为空。 |
| `style` | 画风预设 id（见第 4 节），定稿必需。 |
| `images` | `[{ id, src, prompt, ai }]` 图像图层。 |
| `illustrativeLabel` | `{ enabled=true, text='示意画面', corner='top-right', opacity=.92 }`（opacity 限定 0.6–1）。 |
| `master` | `{ lufs=-14, truePeak=-1.5, lra=11, tolerance=.5 }` 母带响度目标与验收容差。 |
| `scenes[].illustrative` | `true` 或 `{ from, to }`（镜头内秒数，可为数组）。 |
| `scenes[].dataSource` | 本镜头图表的数据出处（等同于各图表的 `dataSource`）。 |
