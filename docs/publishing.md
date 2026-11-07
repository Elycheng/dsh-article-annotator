# 发布与市场收录

给维护者的发布清单。所有命令在仓库根目录执行。

## 0. 发布前检查

```sh
npm install
npm run build
npm test
npm run check:privacy
git status --short           # 确认没有 .profile-backups/、node_modules/、test/fixtures/ 等未跟踪产物
```

`check:privacy` 会扫描绝对路径、邮箱、常见令牌形态等敏感片段。仓库里不应出现：个人主目录路径、机器名、profile 备份、日志、令牌、真实会话数据。

## 1. 发布 npm 包

包名：`dsh-article-annotator`（npm 上必须唯一；先跑 `npm view dsh-article-annotator version` 确认仍是 404）。

```sh
npm login                       # 一次性，浏览器/终端登录
npm publish --access public     # prepublishOnly 会自动重建 lib/client.js
npm view dsh-article-annotator version
```

发布后在干净环境验证：

```sh
dsh plugin --profile web add dsh-article-annotator
dsh web --no-open --port 8791
# 刷新页面 → 右侧栏引导页应出现「文稿批注」
```

### 通过 GitHub Actions 发布（可选）

`.github/workflows/release.yml` 在推送 `v*` 标签时发布。两种认证二选一：

- **npm Trusted Publishing（推荐）**：在 npmjs.com 的包设置里添加 Trusted Publisher，仓库填 `Elycheng/dsh-article-annotator`，workflow 填 `release.yml`；workflow 已带 `id-token: write` 与 `--provenance`，无需 secret。
- **NPM_TOKEN**：在仓库 Secrets 里添加 `NPM_TOKEN`，workflow 会把它作为 `NODE_AUTH_TOKEN` 使用。

## 2. 打版本与 GitHub Release

```sh
npm version patch|minor|major
git push origin main --follow-tags
```

（`npm version` 会生成 `vX.Y.Z` 标签；release workflow 随后发布 npm。）

## 3. 收录进 DSH 插件市场

DSH 生态有两个常见入口，发布 npm 后都可收录：

### 3.1 awesome-dsh-plugin（dsh-market / 索引来源）

- 仓库：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
- 方式：按 `contributing.md` 的格式向该仓库提 PR，在对应分类下增加一条（npm 包已发布是自动收录/索引的前提）。
- PR 描述里写清楚：插件做什么、npm 包名、`dsh plugin add` 安装命令、已验证的 DSH 版本。

建议条目文案（按对方 README 的实际列格式微调）：

```markdown
- [dsh-article-annotator](https://github.com/Elycheng/dsh-article-annotator) — 右侧栏逐句批注 Markdown/DOCX/PPTX/PDF，Agent 读取批注改稿并把反复出现的表达偏好记入长期风格记忆。`dsh plugin add dsh-article-annotator`
```

### 3.2 DSH Community Market / 其他目录

- DSH Desktop 内置 Community Market 的数据来自公开目录源（DSH 1024Store、dshfind 等）。这些目录大多直接消费 npm 包身份：
  - npm 包 `latest` 是精确稳定版本；
  - `package.json` 声明了合法的 `dsh.bundle.patch`；
  - 包名唯一。
  满足这三条即可被自动识别为「可自动安装」。无需另写提交文件。
- 若目录支持手动提交（PR / 表单），用与上面相同的条目文案即可。

## 4. 保持可升级

- 版本语义：破坏性接口变化 → major；新能力 → minor；修复 → patch。
- `CHANGELOG.md` 随每次发布更新。
- 升级 DSH 基线时同步 `package.json#engines.dsh` 与 `docs/verification.md`。
