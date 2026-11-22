# dsh-article-annotator 0.2.0 发布说明

0.2.0 的主题是**批注粒度**：从「只能批注完整句子」改为「整句、词组、任意选中文字都能批注」，同时补上从原生文稿预览右键直达批注的入口，并处理 client / host 两半更新不同步时的报错体验。

代码提交：`2f7fdcf`（范围批注）、`2ae1967`（宿主版本检测）。

## 变更摘要

### 新增

- **任意范围批注**：在右侧栏「文稿批注」页面拖选文字/词组，松手后点浮出的「批注选中文字」；同一句可以有多条不同范围的意见，高亮只覆盖选中的字符。
- **右键入口**：DSH 原生文稿预览里选中文字 → 右键 →「用『文稿批注』批注选中的文字」，自动打开插件并定位到该范围；插件页面内右键选中文字也有同样入口。
- **宿主版本检测**：页面加载时读取 `probe.features.rangeAnchors`；旧宿主会显示可操作的横幅，保存时也不会再抛内部字段错误。

### 变更

- 批注锚点由 `blockId + sentenceIndex` 改为 `blockId + start/end 字符范围 + quote`；整句批注是范围的一种特例，旧版句子批注在读取时自动迁移。
- 重锚定顺序：先校验原偏移 → 再按覆盖文字匹配（忽略空白 / 标点差异）→ 最后回退旧句子位置；仍找不到的保留为「定位失效」。
- `article_review` 工具输出中的 `sentence` 字段改为 `quote`（覆盖的原文片段），「发给 Agent 修改」草稿同步显示「选中片段」。

### 修复

- 本地更新插件后只刷新页面时，新客户端 + 旧宿主会报「批注缺少定位信息（blockId / sentenceIndex）」。现在会检测宿主版本并提示：必须重启 DSH Desktop（宿主半不随页面刷新更新）。

## 升级注意

1. 更新插件文件后，先刷新页面让 client 半更新；
2. **右键系统托盘的 DSH Desktop 图标 →「重启 DSH Desktop」→「重启应用」**，让宿主半（存储 / 重锚定 / Agent 工具）加载新代码；
3. 重启后打开任意文稿，旧批注会自动迁移，不需要手工处理数据文件。

只刷新页面不会更新宿主半；跳过重启会在保存任意范围批注时看到「宿主插件仍是旧版本」提示。

## 验证

- 离线测试：`node test/run-all.mjs` → 39 项，0 失败（含任意词选区保存、范围重锚定、旧批注迁移）。
- `npm run check:privacy` → clean（10 条规则）。
- 真实 DSH 0.2.0-rc.2 临时实例启动 smoke：
  - `/article-annotator/api/probe` 返回 200，`features.rangeAnchors = true`；
  - 客户端 combo bundle 返回 200，包含范围批注 UI；
  - 插件宿主正常加载，6 个 Agent 工具注册。

## 已知限制

- 跨段落的一次选择暂不生成单条批注；请在同一段内选择，或分多条批注。
- PDF 批注依赖机器上的 Python + `pypdf`（或 poppler 的 `pdftotext`）；纯图片 PDF 没有可提取文字。
- npm 包尚未发布（`npm view dsh-article-annotator` 仍 404），当前请从本地源码安装；`docs/publishing.md` 记录了发布步骤。
- DSH 插件市场条目已合并（awesome-dsh-plugin#12835），但条目描述仍是「逐句批注」的旧文案，可另开 PR 更新为任意范围批注。

## 发布检查单

- [ ] `npm login` 后执行 `npm publish`（`prepublishOnly` 会自动构建）
- [ ] 打 tag `v0.2.0` 触发 `.github/workflows/release.yml`（需要仓库 secret `NPM_TOKEN`）
- [ ] 更新插件市场条目描述（awesome-dsh-plugin `data/plugins/Elycheng__dsh-article-annotator.yml`）
- [ ] 发布后在真实 DSH Desktop 上按「升级注意」走一遍重启 + 任意范围批注保存
