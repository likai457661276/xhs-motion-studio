---
name: xhs-motion-studio
description: 用于制作中文 9:16 小红书 / 抖音 / 视频号等竖屏短视频解说片（知识速览、新闻盘点、产品功能讲解、数据解读），无旁白、纯字幕大字 + 原创节拍同步 BGM。当用户要"做一条小红书视频 / 竖屏解说动画 / 带卡点音乐的文字动效短片 / 9:16 速览视频 / 3:4 封面"时使用；不适用于需要真人配音、实拍剪辑或横屏长视频的需求。
---

# XHS Motion Studio — 中文竖屏解说短片工作流

用代码逐帧生成 1080×1920 的解说动画：每一帧都是 `(帧号, seed)` 的纯函数，浏览器画布绘制 → 并行无头渲染 → H.264/AAC 成片，
附带中文排版、效果库、原创 BGM、自动 QA。全部工具在本目录内，自包含（MIT）。

## 默认规则（除非用户明确要求，否则一律遵守）

1. **无旁白**：不做 TTS / 配音；信息全部靠屏幕大字传达，节奏靠 BGM。
2. **不要引导互动**：不出现「关注」「点赞」「评论区见」「三连」等 CTA。
3. **不提及信息搬运来源平台**：屏幕上不出现 X / Twitter / 推特、「刷到」「搬运」以及点赞数/浏览量。来源只写一手出处（官网、论文、权威媒体）。
4. **原创观点口吻**：用自己的话总结与判断（"我们看到…"、"意味着…"），不照搬原文、不做逐条翻译。未证实的信息必须标注「传闻」等字样，并用 QA 共现规则强制。
5. **明亮配色，画风由用户选**：只用明亮的画风预设（`editorial-paper` 编辑纸张 / `flat-illustration` 扁平插画 / `riso-print` 孔版印刷），**不要**暗黑底、霓虹、赛博风。正式渲染前必须先出 A/B/C 三版静帧对比图，等用户挑选（见第 4 步）。
6. **大字居中**：标题 96–124 px、正文 52–64 px，最小 40 px；以墨迹光学居中；避开小红书 UI 遮挡区（顶部 140 px、底部 260 px、右侧按钮列）。
7. **每镜头一个背景母题**：淡化（约 8–16% 不透明度）的单一纹样，呼应该镜头的内容。
8. **先定稿再生产**：先给用户看分镜脚本（每镜头：时长、段落标签、大字文案、副文案、卡点、母题）和**事实边界**，**用户确认后**再写代码、渲染。
9. **事实边界 + 示意标注**：storyboard.json 必须有 `factBoundary`（哪些是有来源的事实、哪些是示意、哪些未核实、来源列表）。不代表真实数据或真实界面的镜头/元素一律标 `illustrative: true`，运行时会自动在角落加「示意画面」半透明标签。K 线、柱状图、曲线等图表类效果要么填 `dataSource`（真实数据出处），要么标 `illustrative: true`。
10. **AI 生图只做主体插画，文字全部在代码层**：需要插画主体时（路线 B），由主 Agent 用生图工具生成白底 PNG，再用 `xms.py cutout` 抠图，最后用 `fx.image` 加代码动效。本工具包**不生成图片**。生图提示词规则见下文「AI 生图主体」。

## 工作流

```
0 需求 → 1 脚本 + 事实边界(用户确认) → 2 init 项目 → 3 storyboard.json + shots.js（可选 3b：AI 生图主体 + cutout）
→ 4 画风三选一（styles 对比图，等用户选）→ 5 bgm + beats → 6 draft 迭代 → 7 lock → 8 preview(确定性) → 9 qa
→ 10 render → 11 finish（−14 LUFS）→ 12 cover → 交付报告
```

### 1. 脚本（交给用户确认的格式）
| # | id | 秒 | 段落标签 | 大字（`{强调}`） | 副文案 | 卡点(秒) / 重拍 | 母题 | 音乐段 |
|---|---|---|---|---|---|---|---|---|

- 镜头时长取**整拍**（120 BPM 下 0.5 s 一拍；常用 4/6/8 s），切镜头落在拍上，卡点落在 1/2 拍上。
- 全片 60–120 s；开头 2 镜头内给出钩子；结尾一句观点 + 来源。
- 数字以核实过的为准；同一事实全片口径一致（如需，用 `qa.config.json → forbidden` 禁掉错误数字）。
- 脚本下方附**事实边界**四栏，与 storyboard 的 `factBoundary` 一一对应：
  `real`（有来源的事实）· `illustrative`（示意/概念表达）· `unverified`（未核实，不得当事实讲）· `sources`（`{name, url, date}`）。
  `factBoundary` 缺失 → QA 失败。

### 2–3. 项目
```bash
K=<本目录>/tools; PY=python3        # bgm/qa 需要 numpy、scipy、Pillow；fonts 需要 fontTools
$PY $K/xms.py init  my-video --title "标题"      # 模板 + lib + Noto Sans CJK SC 字体 + assets.json
```
- `storyboard.json`（`xms/storyboard-v1`）：`preset, theme, fps, seed, fonts, music{file,bpm,key,mood,energy}`，`scenes[]`：
  `id, seconds, segment, titleLines, sub, hits[], heavy[]（⊂hits）, motif, motifOptions, tint(accent|second|third), music(intro|groove|lift|drive|pulse|break|build|peak|outro)`。
- `shots.js`：`XMS.onPrepare` 预计算；`XMS.onFrame` 画背景 → 母题 → 颗粒 → 震动 → pill → 镜头函数。API 见 `docs/API.md`。
- **所有屏幕文字**走 `XMS.type.*` / `fx.title|sub|counter|chip|stamp`，这样 QA 才能看到它们。
- 素材（字体、音频、图片）必须登记在 `assets.json`（`license` + `source` 必填）。
- 示意标注：镜头级 `"illustrative": true` 或 `{"from": 秒, "to": 秒}`（可用数组）；元素级 `fx.candles/bars/chart/image(..., { illustrative: true })`
  或在代码里调用 `XMS.markIllustrative()`。标签文字/位置用 `illustrativeLabel {text, corner, opacity}` 配置（默认右上角「示意画面」，自动避开 UI 遮挡区）。

### 3b. AI 生图主体（可选，路线 B）
1. 主 Agent 用图像生成工具生成主体插画（本工具包不负责生成）。提示词必须包含：
   - **画面中不要任何文字、字母、数字、logo**（no text, no letters, no numbers, no logo）；
   - **纯白背景**（plain pure white background, no shadow on background）；
   - **配色提示与所选主题一致**（写出主题色的 hex，如 `#E85D04`、`#1F4E5F`）；
   - **同一主体在每张图里的部件颜色描述保持一致**（例如每次都写"橙色圆头、深青色身体、米色胸牌、深色粗描边"）。
   模板见 `docs/API.md` →「AI 生图提示词模板」。
2. 原图放 `assets/raw/`，抠图：`$PY $K/xms.py cutout assets/raw/x.png --out assets/images/x.png --trim`
   （白/近白背景 → 透明，边缘羽化，主体内部的白色保留）。
3. 登记：storyboard `images: [{"id": "x", "src": "assets/images/x.png", "prompt": "<完整提示词>", "ai": true}]`，并在 `assets.json` 声明该文件。
4. 动效：`fx.image(ctx, a.t, 'x', { x, y, w, at, enter: 'bounce'|'pop'|'slide-left'|'slide-right'|'slide-up'|'fade', float, drift, rot, wobble, shadow, exitAt })`。
5. **所有文字都留在代码层**（`fx.title` / `XMS.type.*`），不要让图片承载文字。

### 4. 画风三选一（正式渲染前的闸门）
```bash
$PY $K/xms.py styles my-video --shot s02-xxx [--t 2.5] [--styles editorial-paper,flat-illustration,riso-print]
# → .xms/draft/styles/styles-<shot>.png：同一关键镜头的 A/B/C 三版静帧对比图
```
- 选一个最有代表性的镜头（有标题 + 主体视觉）；默认取最后一个卡点后 0.9 s。
- **把对比图发给用户，等用户回复 A/B/C 后再继续**；把选中的预设 id 写进 storyboard 的 `"style"`。
- `style` 未设置时，所有定稿命令（timeline/preview/qa/render/finish/cover）都会拒绝执行；草稿命令不受影响。
- 选定 style 后，主题默认取该画风自带的配色（`editorial-amber` / `flat-pop` / `riso-ink`）；只有用户另有要求时才写 `theme` 覆盖。

### 5. 音乐
```bash
$PY $K/xms.py bgm   my-video [--bpm 120 --key "E minor" --mood drive|bright|chill --energy 0.9 --seed N]
$PY $K/xms.py beats my-video          # 切点/卡点是否在拍上、是否帧对齐、BGM 是否过期、音频起音是否对准（±20 ms）
```
BGM 由 `tools/bgm.py` 现场合成（鼓、贝斯、和弦、琶音、riser、impact），读取 storyboard.json 的切点与卡点，属于项目原创素材。

### 6. 草稿迭代（不锁素材）
```bash
$PY $K/xms.py preview my-video --draft     # 每镜头 3 张静帧 + 确定性检查 → .xms/draft/preview/
$PY $K/xms.py draft   my-video             # 快速成片（veryfast/crf23）→ .xms/draft/draft.mp4
$PY $K/xms.py serve   my-video --draft     # 浏览器交互预览（127.0.0.1，拖动进度条 / 带音乐播放）
$PY $K/xms.py qa      my-video --draft     # QA 报告（草稿模式不阻断）
```

### 7–12. 定稿（全量检查）
```bash
$PY $K/xms.py lock    my-video --note "定稿素材"   # 追加式锁版本 .xms/locks/v000N.json
$PY $K/xms.py preview my-video                     # 确定性：同浏览器乱序 + 跨浏览器哈希一致
$PY $K/xms.py qa      my-video                     # 失败即 exit 1
$PY $K/xms.py render  my-video --workers 4 [--resume] [--jpeg]   # 定稿默认 PNG 无损采集；--jpeg 更快（约快 30%，画质略降）
$PY $K/xms.py finish  my-video --out ./成片.mp4    # 校验 render/QA/mix 与锁、时间线绑定 → 混音 → 封装 → 技术验收
$PY $K/xms.py cover   my-video --frame 1500        # 3:4 封面 build/cover-3x4.png（1080×1440）
```
- 定稿模式下：素材与锁不一致、未登记的媒体被页面加载、QA 未通过、渲染与时间线不匹配 —— 都会拒绝出片。
- `finish` 输出 H.264 High / yuv420p / 30 fps、AAC 192k 48 kHz、`+faststart`；母带默认 **−14 LUFS 整合响度、真峰值 ≤ −1.5 dBTP**（两遍 loudnorm；混音前 16 kHz 低通）。
  验收标准：响度在目标 ±0.5 LU 内、真峰值不超过目标；若 AAC 编码后真峰值过冲，`finish` 会自动加余量重新母带（最多 2 次）。
  可在 storyboard 中配置 `"master": {"lufs": -14, "truePeak": -1.5, "lra": 11, "tolerance": 0.5}`。
- 参考耗时（8 核）：108 s 成片 `render` ≈ 2 分 30 秒（PNG 默认）/ ≈ 1 分 45 秒（`--jpeg`）；`draft` 默认 JPEG；`qa` ≈ 1 分钟；`finish` ≈ 15 秒。

### QA 覆盖（`qa.config.json` 可调）
主题对比度 · 每个文字块与真实局部背景的对比度（含描边）· 居中（版式 + 像素）· 出画/贴边 · 文字重叠 · 小红书 UI 遮挡区（警告）·
背景亮度 · 最小字号 · 违禁词（全部屏幕文字 + storyboard.json + shots.js 字符串）· 共现规则（如出现 `1\.4|万亿` 时必须同时可见 `传闻`）·
**事实边界**（缺 `factBoundary` 失败）· **示意标签**（示意镜头/元素的每一帧都必须看得到「示意画面」，且在安全区内；按日志 + 像素双重检查）·
**图表来源**（图表类效果既无 `dataSource` 也未标示意 → 警告）· **画风已选**（定稿时未设 `style` → 失败）。
输出 `build/qa/qa-report.md|json` 与 `contact-sheet.jpg`。

## 交付报告应包含
成片路径/大小/时长/规格/响度 · 画风选择（附对比图）· 事实边界与来源 · 示意画面镜头列表 · QA 结果与联系表 · 确定性与节拍检查结果 · 渲染耗时 · 2 张预览静帧 · 素材来源与许可 · 未核实信息的处理方式。

## 环境
Node 18+、`playwright-core`（项目内 `npm i playwright-core` 或设 `PLAYWRIGHT_MODULE`）、Chrome/Chromium（`CHROME_PATH`）、ffmpeg 6+、
Python 3.10+（numpy、scipy、Pillow、fontTools）。可用 `XMS_PYTHON` 指定解释器，`XMS_NOTO_DIR` 指定 Noto CJK 字体目录。
