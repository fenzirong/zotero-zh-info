# Zotero 中文标题与摘要（zhinfo）

给 Zotero 的条目信息面板加两个字段：**中文标题**、**中文摘要**，并可自动翻译填入。

## 下载安装

到 [Releases](https://github.com/fenzirong/zotero-zh-info/releases) 下载最新的 `zhinfo-x.y.z.xpi`，
Zotero → 工具 → 插件 → 齿轮 → Install Plugin From File… 安装即可。

也可以自己打包（见文末「安装」与 `build.ps1`）。
## 本地打包安装

1. 打包：`pwsh -File build.ps1` → 得到 `zhinfo-1.0.0.xpi`
2. Zotero → 工具 → 插件 → 齿轮 → Install Plugin From File… → 选 xpi
3. 设置 → 中文标题与摘要 → 选服务、填 Key → 点「测试当前配置」

## 使用

- 选中任一英文文献，右侧信息面板会出现「中文标题与摘要」分区（也可从侧栏图标直达）。
- 默认开启「自动翻译」：第一次打开条目时，缺失的中文标题/摘要会自动翻译并填入。
- 每个字段有「翻译」「清空」按钮；页脚有「一键翻译（仅填空）」与「设置」。
- 分区标题栏右侧的按钮可强制重新翻译两条。
- 批量：文献列表右键「批量翻译中文标题与摘要」（Zotero 8+），或在设置面板点「批量翻译所选条目」（任何版本）。

## 数据存在哪

译文写在条目的 **「其他（Extra）」** 字段，两行：

```
中文标题: 面向知识密集型自然语言处理的检索增强生成
中文摘要: 检索增强生成（RAG）将……（内部换行存为字面 \n）
```

好处：不动数据库结构、随 Zotero 同步、在「其他」区也能直接看到和编辑；`extra` 里其它内容不受影响，清空某个字段只会删掉对应那一行。

## 翻译服务

| provider | 需要配置 | 说明 |
|---|---|---|
| `google` | 无 | translate.googleapis.com 免费接口；**实测本机直连失败**，国内需代理 |
| `mymemory` | 可选 email | **默认**。免费免配置、国内可直连（实测 975 字摘要 3.3s）；机翻水平，学术术语容易翻错（Transformer→变压器），长摘要自动分块，单次约 500 字符 |
| `deepl` | API Key | 可选免费版端点 `api-free.deepl.com` |
| `llm` | Base URL + Key + 模型名 | 任何 OpenAI 兼容 `/chat/completions`：DeepSeek、硅基流动、Moonshot、OpenAI、Ollama 等，学术摘要质量最好 |

首选项键：`extensions.zhinfo.*`（`provider`、`targetLang`、`autoTranslate`、`skipIfChinese`、`timeout`、`mymemory.*`、`deepl.*`、`llm.*`）。

## 结构

```
manifest.json            插件清单（Zotero 7 / 8 / 10）
bootstrap.js             生命周期；注册 chrome://zhinfo/、加载模块
prefs.js                 默认首选项
content/zhinfo.js        分区注册/渲染/存写/自动翻译/批量
content/translate.js     翻译服务适配层
content/preferences.xhtml|.js|.css   设置面板
content/style.css        分区样式
content/icons/**         图标
locale/{zh-CN,en-US}/zhinfo.ftl      Fluent 字符串
build.ps1                打包脚本
```

## 开发备注

- 分区 API 为 `Zotero.ItemPaneManager.registerSection`；header 用 FTL `.label`、sidenav 用 FTL `.tooltiptext`（与 Zotero 内置 `section-abstract` 一致）。
- 抓日志：启动 Zotero 加 `-ZoteroDebugText`，筛选 `ZhInfo:`。
- 已知限制：只对常规文献条目启用（附件/笔记不显示）；Zotero 语言的 FTL 缺失时标题会用 JS 兜底，侧栏提示为空。
## 下载安装

到 [Releases](https://github.com/fenzirong/zotero-zh-info/releases) 下载最新的 `zhinfo-x.y.z.xpi`，
Zotero → 工具 → 插件 → 齿轮 → Install Plugin From File… 安装即可。

也可以自己打包（见文末「安装」与 `build.ps1`）。
## 本地打包安装失败排查（Zotero 8/9/10）

Zotero 10 的 Gecko 分支对插件 manifest 有一条**强制校验**（见 `omni.ja` 内 `Extension.sys.mjs`）：

```
if (!manifest.applications?.zotero?.id)              -> manifestError
if (!manifest.applications?.zotero?.update_url)      -> manifestError
if (!manifest.applications?.zotero?.strict_max_version) -> manifestError
```

缺 `update_url` 时安装会直接失败，UI 只给一句「它可能无法与该版本的 Zotero 兼容」。
本包已补齐三项，`update_url` 目前指向占位地址 `https://example.invalid/zotero-zh-info/updates.json`
（仅用于更新检查，404 不影响使用）；若要自建更新源，改这一行并参考随包的 `updates.json`。

版本号请用纯数字（如 `10.9.9`），不要写 `10.*`。

## 已验证的行为（Zotero 10.0.7 实机）

- 分区注册 / 侧栏图标 / FTL 标题「中文标题与摘要」/ 设置面板注册 / 右键菜单注册 均通过
- 打开条目自动翻译：标题与摘要两条都写入 `extra`，且原 `extra` 中的其它行（如 `Citation Key`）被保留
- 翻译服务返回原文（如免费接口触顶）时判定为失败并在分区内提示，不会把英文当译文写入
## PDF 双语：两条路线（v2.0 起，推荐走引擎）

### 路线 A：开源引擎（真正保留原版面，推荐）

阅读器浮条点 **「生成双语PDF」**：插件调用开源引擎 **BabelDOC**（沉浸式翻译官方开源后端）或 **PDFMathTranslate**，
由引擎解析版面 → 段落重组 → 翻译 → **按原文框重排（字号从原文中位数字号自动缩小）** → 生成新的双语 PDF，
图表、公式、表格保持不动，最后作为**子附件**挂到该文献下并自动打开。

- 页数：浮条里的「页数」下拉直接映射成引擎的 --pages（当前页 / 2 / 3 / 5 / 10 / 全部）。
- 语言与模型：复用设置里的目标语言与大模型接口（引擎走 OpenAI 兼容 API，需填 Base URL + Key）。
- 安装引擎（任选其一，需 Python/uv）：
  - `uv tool install --python 3.12 --with "bitstring<5" BabelDOC`（本插件实测可用）
  - 或按 PDFMathTranslate 官方说明安装 `pdf2zh`
  - 说明：BabelDOC 声明 `bitstring>=4.3.0`，但 bitstring 5.x 已移除 `BitStream`，所以必须钉 `bitstring<5`，否则启动即 ImportError。
- 首次运行会下载字体/模型到 `~/.cache/babeldoc`；之后按页数计费只在翻译调用上。

### 路线 B：阅读器内快速覆盖（不保证排版）

浮条点覆盖式翻译（v1.x 的行为）：把中文直接覆盖到原文段落矩形里，字号自适应缩小。
**它受限于 pdf.js 文字层是绝对定位、容器不能撑高**，因此中文放不下时会被截断，双栏/旋转页更容易错位；扫描版不可用。
适合"只想扫一眼某几段"的场景。
## PDF 双语（覆盖模式细节）

阅读器工具栏点 **「双语」**（或设置里打开总开关自动执行），插件会把中文译文**精确覆盖在每段原来的位置**：
图片、表格、分栏、页边距等版式完全不动，只把段落文字换成中文；字号按原段落行高自适应并自动缩小直到放得下。

- **每段右上角 ×**：取消该段翻译，立即恢复该段英文原文（悬停才显示，不挡视线）。
- **右下角浮条**：`已完成/总数` 进度、停止、清除、**只看原文 / 显示译文** 切换、关闭。
- 翻译进行中不遮挡原文：只有译好的段落才会被覆盖，页面始终可读。

### 浮动工具条（可拖动）

右下角浮条：`⠿` 拖动把手 · 当前页与进度 · **页数下拉（当前页 / 2 / 3 / 5 / 10 / 全部）** · 停止 · 清除 · 只看原文 · 关闭。
按住 `⠿` 可把浮条拖到任意位置，位置会记住（下次打开还在原处）。

### 边翻边译

文本几何一次性全篇抽取（本地、快），**翻译按需进行**：

- 打开时先翻译「当前页 + 下一页（预取）」；
- 之后**翻到哪页就翻哪页**，回到前面未译的页也会补译；
- 页数下拉/设置里的「翻译页数」是**上限**：从打开时所在页算起，超过上限的页不会被翻译（状态栏会显示「上限 N 页（到第 X 页）」）。
### 两种显示方式（设置 → PDF 双语 → 显示方式）

| 方式 | 效果 |
|---|---|
| `inline` 原位覆盖（默认） | 保留 PDF 原版面，译文覆盖原段落矩形；适合需要看图表/公式位置 |
| `reflow` 重排阅读视图 | 抽取文字重排成阅读视图，每段原文下方附译文；适合纯文字精读、可读性最好 |

### 为什么默认是「覆盖」而不是「原文+译文并排」

pdf.js 的文字层是绝对定位的，同一区域塞两份文字必然重叠；要在原版面上「原文下方另起一段译文」必须把后续内容整体下移，等于重排页面。
所以：想保留原版面 → 用 `inline`（覆盖 / 可逐段切回原文）；想原文与译文同时可见 → 用 `reflow`。

### 设置项

| 选项 | 说明 |
|---|---|
| 打开 PDF 时自动生成（总开关） | 默认关闭 |
| 自动翻译范围 | 仅当前页（省额度，推荐）/ 整篇文档 |
| 最短段落字符数 | 默认 20，过短的标题行/作者行会被跳过 |

实现要点：文本与坐标取自 pdf.js 文本层（旋转水印、页边碎片、页码、running head 会被过滤；先按中部空白带切双栏、再逐栏分行切段；
按行距/缩进/字号变化分段）。译文按「附件+服务+语言+原文」缓存，连续失败 3 次自动暂停。扫描版（无文本层）PDF 不可用。