# 验证记录

本文件记录 `dsh-article-annotator` 在 **DSH 0.2.0-rc.2** 上的实测证据。所有涉及个人目录、令牌、机器名、备份路径的内容均已移除或替换为占位符。

## 1. 离线测试（37 项，0 失败）

```text
node test/run-all.mjs
ℹ tests 37  ℹ pass 37  ℹ fail 0  ℹ skipped 0
```

覆盖：

- `sentences.test.mjs`：中英文句子切分、超长软切、稳定 id。
- `extract.test.mjs`：Markdown（标题/段落/列表/代码块、软换行合并、行内语法剥离）、TXT、DOCX（真实 OOXML ZIP，标题级别）、PPTX（演示顺序、幻灯片号）、PDF（经本机 Python + pypdf 提取）、旧版 `.doc` 拒绝。
- `store.test.mjs`：批注增删改、文本重锚定与 orphan、风格规则去重、修订稿落到源文件旁且不改原文件、最近文件去重。
- `api.test.mjs`：同源围栏（403）、缺围栏（503）、方法/参数校验、list/open/comment/style/recent 全流程。
- `plugin.test.mjs`：Standard Schema 默认值、apply 接线（route + prompt section）、风格段落渲染与截断、无服务宿主下的降级。
- `client.test.mjs`：客户端 bundle 以 `window.__ModuleLoader__.load` 注册、右侧栏页类型/正文/标题三个座位注册、消息与 Markdown 导出、文件地址语法。
- `client-dom.test.mjs`：jsdom + 真实 React 18 渲染整个页面——自动打开最近文稿、句子锚点与批注角标、点击句子弹出编辑器、输入并保存后角标与计数即时更新。

## 2. 真实 DSH web 实例（scratch profile，DSH 0.2.0-rc.2）

在临时 `DSH_HOME`、独立 profile、端口 8791 启动打包运行时：

```text
dsh web: http://127.0.0.1:8791/?token=…（token 已脱敏）
```

（1）插件经 `dsh.profile.bundles` 选择后，仅靠包内 `cordis.patch.yml` 即完成挂载。探测接口（带 token cookie + 同源 Origin）：

```json
{"ok":true,"value":{"version":1,"methods":["probe","list","open","comment","style","recent"],
"formats":["markdown","text","docx","pptx","pdf"],
"features":{"sentenceAnchors":true,"agentTools":true,"styleMemory":true,"revisionFile":true},
"plugin":{"loaded":true,"routes":true,
"tools":["article_review","article_read","article_review_resolve","article_review_save_revision","writing_style_add","writing_style_get"],
"toolsMissing":[],"styleSection":true,"warnings":[]}}}
```

（2）启动页（`GET /`）的客户端启动图中出现：

```text
<script src="plugins/??…,dsh-article-annotator/client.js,…&rev=…">
```

（3）组合包响应 `GET /plugins/??…dsh-article-annotator/client.js…` 返回 200，内容含 `dsh-article-annotator — browser bundle` 与 `__ModuleLoader__.load`。

## 3. 真实 Desktop 实例（本机，热加载）

profile：`$DSH_HOME/profiles/desktop`（个人目录已脱敏）。安装后 profile 变更被 Desktop 的 HMR 捕获，host 半在**运行中的**桌面进程里直接加载，无需重启：

```text
[I] [dsh-article-annotator] article-annotator: 文稿批注已加载（右侧栏「文稿批注」）｜批注 API=开｜Agent 工具=开｜风格记忆=开
[I] [dsh-article-annotator] article-annotator: Agent 工具已注册：article_review, article_read, article_review_resolve, article_review_save_revision, writing_style_add, writing_style_get
```

## 4. 安装过程中确认的三个真实约束（已固化进脚本）

1. **不要既选 bundle 又手写 profile 行**：bundle 的 `dsh.bundle.patch` 会插入同一 id，组合期报 `duplicate loader entry id "article-annotator"`。正确做法是只选 bundle（或只手写行，二选一）。
2. **HMR 与 `pnpm install` 有竞态**：先写 profile 文件会立刻触发 HMR，如果 `node_modules/<pkg>` 链接还没建好，会报 `PackageOverlayNotFoundError`；下一次文件变更会自动重试。安装脚本因此把 pnpm 放在最后。
3. **CJK 路径不要经由 Windows PowerShell 原生命令参数传递**：PowerShell 会按 ANSI 代码页转换 argv，中文路径可能被转码。安装/构建脚本改为在 Node 内部处理路径，不做跨进程参数传递。

## 5. 未覆盖

- 真实桌面窗口里的人工点击路径（打开右侧栏引导页 → 文稿批注 → 选文件 → 批注 → 发给 Agent）尚未由自动化点击覆盖；UI 的等价路径已由 jsdom 全流程测试覆盖，host/tool 路径由 scratch 实例覆盖。
- Agent 端工具的实际调用（模型读到批注后改稿、调用 `article_review_resolve` / `writing_style_add`）需要在**新会话**里由用户触发验证；插件加载前已开始的会话不会出现新工具。
