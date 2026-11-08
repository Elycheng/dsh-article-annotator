# dsh-article-annotator（文稿批注）

在 DSH 右侧栏逐句批注 **Markdown / Word / PowerPoint / PDF** 文稿：把「这一句要改」的意见变成 Agent 能读、能执行、能勾销的批注，反复出现的意见再沉淀成长期写作风格记忆。

![license](https://img.shields.io/badge/license-MIT-blue) ![dsh](https://img.shields.io/badge/DSH-0.2.0--rc.2%2B-4d6bfe) ![runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)

## 它解决什么

现有 AI 改稿的常见问题是「意见悬空」：人在对话框里说「第二段太啰嗦」，模型得自己猜是哪一句；改完之后意见也没有落点，下一次又从头说过。

这个插件把链路钉在句子上：

1. **看**：把文稿切成可点击的句子（保留段落、页、幻灯片边界），一句话一个批注锚点。
2. **改**：`发给 Agent 修改` 把待处理批注写成一条输入框草稿（只写草稿，不自动发送）；Agent 通过工具读取每条意见、改稿、把处理过的批注标为已解决。
3. **记**：Agent 从批注里归纳可复用的表达偏好，写进风格记忆；记忆随后进入系统提示，下一篇文章直接带着偏好写。

## 功能

- 右侧栏新增页面 **「文稿批注」**（右侧栏引导页里有入口；首次加载后也会自动打开一次并给一条提示）。
- **右键入口**：在 DSH 原生文稿预览（Markdown / PDF / Office / 表格）里选中文字后右键 →「用『文稿批注』批注这句」；右键预览空白处也有「在『文稿批注』中打开本篇」。插件自己的文稿页面里右键句子同样有「批注这句 / 复制原句」。
- 顶栏：当前文稿、刷新、在原生预览中打开、批注数、风格记忆数。
- 正文：标题 / 段落 / 列表 / 代码块 / 表格 / PDF 页码 / PPT 幻灯片分隔全部保留，点任意一句弹出批注框。
- 待处理批注用琥珀色下划线 + 序号角标，已解决用绿色；同一句再次点击可修改或删除。
- 批注列表：按待处理 / 全部筛选，可定位回原句、切换状态。
- 风格记忆面板：查看规则、单条删除。
- 首次使用点标题选择文稿：搜索当前会话工作目录里的 `.md` / `.markdown` / `.txt` / `.docx` / `.pptx` / `.pdf`，并列出最近打开的文件。
- 导出批注为 Markdown。

## 安装

要求：DSH `0.2.0-rc.2` 或更新；Node.js ≥ 20。

### 从 npm（推荐）

> 首次公开发布前 npm 上还没有这个包；在此之前请用下面的「从本地源码」方式安装。

```sh
dsh plugin --profile web add dsh-article-annotator
```

装完重启一次 DSH（或等待 Profile HMR 重载），刷新页面，右侧栏引导页里即可看到「文稿批注」。

### 直接把插件加到某个 profile

```sh
dsh plugin --profile <profile> add dsh-article-annotator
```

### 从本地源码 / 开发调试

```sh
git clone https://github.com/Elycheng/dsh-article-annotator.git
cd dsh-article-annotator
npm install
npm run build

# 装进本机 profile（默认 ~/.dsh/profiles/desktop；可用 --profile web 等）
node scripts/install-local.mjs --profile-dir "$HOME/.dsh/profiles/web"
```

`install-local.mjs` 只做三件事：把当前 checkout 作为 `link:` 依赖写进 profile 的 `package.json`、在 `dsh.profile.bundles` 里选中它、运行 `pnpm install --ignore-scripts`。它不会手写 loader 行——选中 bundle 时插件自带的 `cordis.patch.yml` 会插入；重复手写会报 duplicate loader id。

卸载：

```sh
node scripts/uninstall-local.mjs --profile-dir "$HOME/.dsh/profiles/web"
```

### 手动安装

1. profile 的 `package.json` 增加依赖：`"dsh-article-annotator": "link:<checkout-path>"`，并把 `"dsh-article-annotator"` 加进 `dsh.profile.bundles`；
2. 在 profile 目录执行 `pnpm install --ignore-scripts`；
3. 重启 DSH 或等待 HMR。

## 用法

1. 刷新页面，打开右侧栏；点侧栏的「+」/ 引导页里的 **「文稿批注」**（首次安装后页面会提示并自动打开一次）。
2. 点标题选择一篇文稿；点任意一句话（或右键）写意见，`保存`。
3. 也可以直接在 DSH 原生文稿预览里读文章：选中一段文字 → 右键 →「用『文稿批注』批注这句」，会自动打开插件并定位到对应句子。
4. 点 **「发给 Agent 修改」**：会把待处理批注 + 操作指令写进当前会话的输入框草稿，你检查后自己发送。
5. Agent 按批注改稿、调用 `article_review_resolve` 勾销批注、调用 `writing_style_add` 记录风格规则。
6. 回到批注页点「刷新」即可看到状态变化；风格记忆面板里能看到沉淀下来的规则。

> Agent 工具要在**新会话**（或插件加载后的会话）里才可见；加载前已开始的会话看不到新注册的工具。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `article_review` | 读取当前文稿的逐句批注（位置、原句、意见、状态）和风格记忆；Word/PPT/PDF 默认连全文一起返回。省略 `file` 时用本会话最近打开的一篇。 |
| `article_read` | 读取全文（带 `[bN]` 段落编号、页码 / 幻灯片分隔）。适合模型自己的文件工具读不了的 docx/pptx/pdf。 |
| `article_review_resolve` | 改完后把批注 id 标为已解决。 |
| `article_review_save_revision` | 把改好的全文写成源文件旁边的 `<原名>.revised.md`（二进制文稿的交付方式）。 |
| `writing_style_add` | 记录一条可复用的表达规则（自动去重）。 |
| `writing_style_get` | 读取全部风格规则。 |

「发给 Agent 修改」生成的草稿自带完整指令：读批注 → 改稿（Markdown/TXT 直接改原文件；Word/PPT/PDF 写 `.revised.md`）→ 勾销批注 → 归纳风格规则 → 汇报改了什么。

## 数据与隐私

- **不联网、不上传、无遥测。** 插件的 host 半只在收到同源请求时读你指定的本机文稿；批注、风格记忆、最近文件全部只存在本机。
- 数据目录：`$DSH_HOME/article-annotator/`（默认 `~/.dsh/article-annotator`）：

| 路径 | 内容 |
|---|---|
| `annotations/<sha1>.json` | 每篇文稿的批注与状态（按绝对路径哈希） |
| `style.json` | 长期写作风格记忆 |
| `recent.json` | 最近打开的文稿 |
| `sessions.json` | 每个会话最近打开的一篇（工具默认目标） |

- 批注**不写进工作区**，不会污染文章目录；Agent 产出的修订稿才会写在源文件旁边。
- 本地构建/开发脚本只读写本仓库和给定 profile；发布前可用 `npm run check:privacy` 扫描绝对路径、邮箱、令牌形态等敏感片段。

## 支持的格式

| 格式 | 读取方式 | 写回方式 |
|---|---|---|
| Markdown / TXT | 纯 Node 解析（标题、段落、列表、代码块、表格；剥离行内 Markdown 语法但保留文字） | Agent 直接改原文件 |
| DOCX | 零依赖 ZIP 读取 + `word/document.xml` 段落/标题提取 | Agent 写 `.revised.md` |
| PPTX | 零依赖 ZIP 读取 + 按 `presentation.xml` 顺序提取幻灯片段落 | 同上 |
| PDF | 宿主机 Python + `pypdf` 提取（`pdftotext` 兜底） | 同上 |

- 不支持旧版二进制 `.doc` / `.ppt`（会提示改用原生预览或另存为 docx/pptx）。
- PDF 需要机器上有 Python + `pypdf` 或 poppler 的 `pdftotext`；纯图片 PDF 没有可提取文字。
- **句子切分是确定性的**：中文按 `。！？…；` 与后置引号/括号切分；英文 `.` 只在像句号时才切（`v1.2`、`README.md`、`e.g.` 不会误切）。批注同时保存原句文本，文章改过、位置漂移后按文本重新锚定；找不到的批注标记「定位失效」但不会丢。

## 配置

在 profile 的 `cordis.patch.yml` 里可以覆盖（或直接改插件 bundle patch 行）：

```yaml
- id: article-annotator
  name: dsh-article-annotator
  config:
    injectStyle: true        # 风格记忆是否进入系统提示
    maxStyleRules: 12        # 提示里最多列几条
    maxArticleBytes: 41943040
    maxBlocks: 1500
    enableTools: true        # 是否注册 Agent 工具
```

## 架构

```
lib/index.js       host 半入口：Standard Schema 配置、按需注入 webServer / tools / systemPrompt
lib/api.js         /article-annotator/api/{probe,list,open,comment,style,recent}，同源围栏 + JSON 信封
lib/tools.js       6 个 Agent 工具（defineTool 从宿主安装目录按需解析，找不到只降级工具）
lib/extract.js     Markdown/TXT/DOCX/PPTX/PDF → blocks + sentences
lib/pdf.js         Python(pypdf) / pdftotext 文本提取
lib/zip.js         最小 ZIP 读取器（central directory + raw inflate）
lib/sentences.js   确定性句子切分（中文/英文、超长软切）
lib/store.js       批注 / 风格记忆 / 最近文件 / 修订稿（原子写、容量上限）
lib/status.js      运行期状态，probe 接口原样返回，便于排障
src/client/index.tsx   右侧栏页面（一个 vendor-CJS bundle，只 require 平台基线 react）
scripts/build-client.mjs   tsc → 包进 window.__ModuleLoader__.load 工厂
```

插件不修改 DSH 源码，只作为 profile bundle 挂载；卸载即净。宿主依赖全部通过 `ctx.inject` / `ctx.get` 按需接入，缺少某项能力时对应功能降级而不是整插件加载失败。

## 兼容性

- 在 **DSH 0.2.0-rc.2**（DSH Desktop）上完整实测；接口方向与 0.2.1-rc.x 一致，但未逐版本验证。
- Node.js ≥ 20（DSH 自身要求的版本更高）。
- 浏览器半只依赖 DSH 冻结的平台模块 `react`，不引入自己的前端依赖。

## 开发与测试

```sh
npm install          # typescript + react/react-dom/jsdom（测试与构建用）
npm run build        # 生成 lib/client.js
npm test             # 37 项离线测试
npm run check:privacy
```

测试覆盖：句子切分、四种格式提取（含真实 PDF）、批注存储与重锚定、API 围栏与全流程、插件入口接线、客户端 bundle 注册，以及 jsdom + 真实 React 的完整批注流程。PDF 测试需要能启动 Python；受限环境下会跳过并说明。

## 已知限制

- 句子锚点是「位置 + 文本」双重匹配，不记录字符偏移；文章大改后个别批注可能「定位失效」（仍保留在列表里可回看）。
- Word / PPT / PDF 不做原地改写：修订稿以 `.revised.md` 交付，避免破坏二进制版式。Markdown 文稿才是真·原地修改。
- 批注 UI 需要宿主提供 `sidebarRightTabs` / `slots` 服务；缺失时页面不注册，而不是报错。
- PDF 文本提取依赖本机 Python + pypdf（或 `pdftotext`）。
- 风格记忆默认最多注入 12 条，可通过配置调整。

## English summary

`dsh-article-annotator` adds an **Article Review** page to DSH's native right sidebar: it turns Markdown / DOCX / PPTX / PDF articles into sentence-addressable text, lets you annotate any sentence, and hands the open review to the agent as a composer draft. Six agent tools let the model read every comment, revise the article (in place for Markdown, as `<name>.revised.md` for binary formats), resolve the comments, and record recurring wording preferences into a long-term style memory that is injected into later prompts. Everything stays local: no network calls, no telemetry, annotations under `$DSH_HOME/article-annotator`.

## License

MIT — see [LICENSE](./LICENSE).
