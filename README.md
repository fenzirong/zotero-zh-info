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