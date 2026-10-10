# XHS Motion Studio（xhs-motion-studio）

> 用代码生成中文 9:16 竖屏解说短视频：大字排版 + 动效 + 原创卡点 BGM + 自动 QA，一条命令出可上传的 MP4。

适合小红书 / 抖音 / 视频号的「知识速览、新闻盘点、产品功能讲解、数据解读」类短片：**无旁白、纯文字大字、节奏跟着音乐走**。
它也是一个 Agent Skill（见 `SKILL.md`），可以直接交给 AI 助手按流程执行。

## 特性

- **确定性逐帧渲染**：每一帧都是 `(帧号, seed)` 的纯函数；乱序、多进程、断点续渲结果逐像素一致，并自动校验。
- **快**：页面内 `canvas.toBlob` 采集 + 多浏览器并行 + 分段编码可续渲。108 秒 1080×1920 在 8 核机器上约 2 分 30 秒（无损 PNG 采集，默认）或 1 分 45 秒（`--jpeg`）；逐帧元素截图的做法约 30 分钟。
- **中文排版**：显式加载 Noto Sans CJK SC；逐字测量换行、避头尾、中西文自动间距、墨迹光学居中、自动缩放适配。
- **效果库**：逐字落入 / 逐字炸出、数字滚动爆点、粒子汇聚成字、冲击波、网络图、徽章弹出、翻牌、上升曲线、K 线、柱状图、彩纸、流动纸纹背景、12 种背景母题。
- **事实边界 + 示意标注**：storyboard 必须写明哪些是有来源的事实、哪些是示意、哪些未核实；示意镜头/元素自动加半透明「示意画面」角标；图表类效果没有数据来源也没标示意时 QA 报警。
- **画风三选一闸门**：`xms.py styles` 把同一关键镜头渲染成 A/B/C 三种画风（编辑纸张 / 扁平插画 / 孔版印刷）的对比图，用户选定后才允许正式渲染。
- **AI 生图主体 + 代码动效**：白底插画一键抠图（`xms.py cutout`），以图像图层加入，配合弹跳、回弹、滑入、漂浮、视差、摆动、投影等确定性动效；文字始终在代码层。
- **原创 BGM 生成器**：按 BPM / 调性 / 情绪 / 能量合成，切点与卡点直接读取分镜时间线；附节拍网格检查（含音频起音检测）。
- **主题与对比度**：5 套明亮主题（含 3 套画风预设），内置 WCAG 对比度校验。
- **自动 QA**：对比度、居中、出画、重叠、小红书 UI 遮挡区、背景亮度、违禁词、"必须同时出现"规则、事实边界、示意标签、图表来源、画风已选，输出报告与联系表。
- **平台响度**：两遍 loudnorm 母带，默认 −14 LUFS / 真峰值 ≤ −1.5 dBTP，验收容差 ±0.5 LU，可在 storyboard `master` 中配置。
- **草稿 / 定稿双模式**：草稿快速迭代；定稿强制素材锁、QA 通过、渲染与时间线绑定后才允许封装。
- **3:4 封面导出**。

## 快速开始

依赖：Node 18+、Chrome 或 Chromium、ffmpeg 6+、Python 3.10+（`pip install numpy scipy pillow fonttools`）、系统安装 Noto Sans CJK（或用 `XMS_NOTO_DIR` 指向字体目录）。

```bash
npm i playwright-core            # 在项目目录或任意上级目录安装；或设置 PLAYWRIGHT_MODULE
export CHROME_PATH=/usr/bin/google-chrome
K=path/to/xhs-motion-studio/tools

python3 $K/xms.py init  my-video --title "三步看懂一个新功能"
# 编辑 storyboard.json（含 factBoundary）与 shots.js；可选：用生图工具做白底插画后抠图
python3 $K/xms.py cutout assets/raw/mascot.png --out my-video/assets/images/mascot.png --trim
python3 $K/xms.py styles my-video --shot s02-point  # 画风 A/B/C 对比图 → 选定后写入 storyboard "style"
python3 $K/xms.py bgm   my-video                 # 生成原创 BGM（audio/bgm.wav）
python3 $K/xms.py beats my-video                 # 节拍网格检查
python3 $K/xms.py draft my-video                 # 草稿成片 .xms/draft/draft.mp4

python3 $K/xms.py lock    my-video --note "定稿"  # 锁定素材
python3 $K/xms.py preview my-video                # 静帧 + 确定性检查
python3 $K/xms.py qa      my-video                # 自动 QA
python3 $K/xms.py render  my-video --workers 4
python3 $K/xms.py finish  my-video --out my-video.mp4   # −14 LUFS / TP ≤ −1.5 dBTP 验收
python3 $K/xms.py cover   my-video --frame 300    # 3:4 封面
```

用浏览器预览：`python3 $K/xms.py serve my-video --draft`，打开输出的 127.0.0.1 地址即可拖动进度条逐帧查看、带音乐播放。

## 目录

```
SKILL.md            Agent Skill 说明（触发条件、默认规则、完整流程）
lib/
  xms-core.js       运行时：时间线/主题/字体加载、帧契约、QA 记录、采集辅助、预览播放器
  xms-type.js       中文排版
  xms-fx.js         效果库
  themes.json       预设（xhs-9x16、cover-3x4）+ 主题 + 画风预设 + 对比度组合
tools/
  xms.py            命令行入口（仅标准库）
  xms-render.cjs        并行渲染器（本地静态服务器 + 无头浏览器 + 分段 ffmpeg）
  bgm.py            原创 BGM 生成
  beatgrid.py       节拍网格检查
  qa.py             自动 QA
  cutout.py         白底抠图（numpy + scipy + Pillow）
templates/          新项目模板（index.html、storyboard.json、shots.js、qa.config.json、.gitignore）
docs/API.md         API 参考与示例
```

## 项目文件

| 文件 | 作用 |
|---|---|
| `storyboard.json` | 分镜：每镜头时长、文案、卡点、母题、音乐段；事实边界 `factBoundary`、画风 `style`、图像图层 `images`、示意标签、母带响度 `master` |
| `shots.js` | 每镜头的绘制代码 |
| `assets.json` | 素材清单（许可、来源必填） |
| `qa.config.json` | QA 阈值、违禁词、共现规则 |
| `.xms/locks/` | 追加式素材锁历史（请纳入版本管理） |
| `build/` | 定稿产物（时间线、静帧、分段、成片、报告） |

## 许可

MIT © 2026 Green Angela。字体为 SIL OFL 1.1（Noto Sans CJK，不随本仓库分发，`xms.py fonts` 会从系统字体中提取）。
`bgm.py` 生成的音乐属于使用者自己的原创素材。

---

## English

**XHS Motion Studio** renders Chinese 9:16 explainer videos (Xiaohongshu / Douyin style) entirely from code:
big centered captions, motion effects, an original beat-synced soundtrack and automated QA — no voice-over.

- Deterministic frame rendering (every frame is a pure function of frame index + seed), verified automatically.
- Fast pipeline: in-page `canvas.toBlob` JPEG capture, parallel headless browsers, resumable chunked x264 encode
  (≈2.5 min for 108 s at 1080×1920 on 8 cores with lossless PNG capture, ≈1 min 45 s with `--jpeg`).
- CJK typography: explicit Noto Sans CJK SC loading, per-glyph wrapping with kinsoku rules, CJK/Latin spacing, optical centering, auto-fit.
- Fact boundary (required `factBoundary`: real / illustrative / unverified / sources) and an automatic 「示意画面」 ("illustrative")
  corner badge on flagged shots or elements; QA fails on a missing boundary or badge and warns on charts without `dataSource` or an illustrative flag.
- Style gate: `xms.py styles --shot <id>` renders one key shot in three bright presets (editorial paper, flat illustration,
  risograph/halftone) as a labelled A/B/C sheet; final builds refuse to run until `style` is set.
- Image layers for AI-generated subject art: `xms.py cutout` (white background → alpha, feathered, interior whites kept) and deterministic
  image motion (bounce, pop, slide, float, parallax drift, wobble, style-aware shadow). All text stays in code.
- Mastering: two-pass loudnorm to −14 LUFS integrated, true peak ≤ −1.5 dBTP (configurable), delivery check ±0.5 LU.
- Effects library, procedural BGM generator driven by the storyboard, beat-grid checker, WCAG-validated themes,
  QA (contrast, centering, cut-off, overlap, safe areas, forbidden words, co-appearance rules) with a contact sheet,
  draft/final modes with an append-only asset lock, 3:4 cover export.

Quick start: see the commands above (`tools/xms.py init → styles → bgm → draft → lock → preview → qa → render → finish`).
API reference: `docs/API.md`. License: MIT © 2026 Green Angela.
