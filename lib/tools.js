/**
 * Agent tools of the article reviewer.
 *
 * These are the model's half of the loop the reader starts in the sidebar:
 *
 *   article_review            every sentence comment + the style memory
 *   article_read              the article text (docx/pptx/pdf included)
 *   article_review_resolve    mark comments done after revising
 *   article_review_save_revision  write the revised text next to the source
 *   writing_style_add / get   grow and read the long-term wording memory
 *
 * `defineTool` comes from the host installation, loaded lazily: the plugin is
 * installed as a local `link:` bundle, so a static import of a @deepseek-ai
 * package would resolve outside this package's node_modules chain. The same
 * optional-load trick dsh-style-writing proved on this machine is reused here.
 */
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import {
  ReviewError,
  clip,
  isWithin,
  oneLine,
  resolveArticlePath,
  resolveSessionCwd,
  toPosix,
} from './util.js'
import { displayPath, extractArticle, renderArticleText } from './extract.js'
import {
  addStyleRule,
  anchorComments,
  lastArticleForSession,
  loadAnnotations,
  loadStyle,
  patchComment,
  writeRevision,
} from './store.js'
import { status, warn } from './status.js'

/** Tools this plugin registers (also shown by the probe tool of the host). */
export const TOOL_NAMES = ['article_review', 'article_read', 'article_review_resolve', 'article_review_save_revision', 'writing_style_add', 'writing_style_get']

/* ------------------------------------------------------------------ *
 * defineTool loading
 * ------------------------------------------------------------------ */

let defineToolPromise

/** Candidate host application roots (Desktop / checkout / env overrides). */
function appRoots() {
  const roots = []
  const add = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return
    const normal = resolve(value.trim())
    if (!roots.includes(normal)) roots.push(normal)
  }
  add(process.env.DSH_APP_DIR)
  add(process.env.DSH_CHECKOUT_DIR)
  if (typeof process.resourcesPath === 'string') add(join(process.resourcesPath, 'app'))
  if (typeof process.execPath === 'string') add(join(dirname(process.execPath), 'resources', 'app'))
  if (typeof process.env.LOCALAPPDATA === 'string') add(join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app'))
  if (typeof process.env.PROGRAMFILES === 'string') add(join(process.env.PROGRAMFILES, 'DeepSeek Harness', 'resources', 'app'))
  return roots
}

function resolveFrom(baseDir, specifier) {
  try {
    const req = createRequire(pathToFileURL(join(baseDir, 'index.js')).href)
    return req.resolve(specifier)
  } catch {
    return null
  }
}

/**
 * Resolve + import `@deepseek-ai/dsh-tools`, returning its `defineTool`.
 * @returns {Promise<Function|null>} defineTool or null when the host is unreachable.
 */
export async function loadDefineTool() {
  if (defineToolPromise !== undefined) return defineToolPromise
  defineToolPromise = (async () => {
    const candidates = []
    // Raw `node .../app/node_modules/@deepseek-ai/dsh/lib/bin.js` and the
    // Desktop carrier both resolve host packages relative to the launcher.
    if (typeof process.argv?.[1] === 'string') {
      const fromLauncher = resolveFrom(dirname(process.argv[1]), '@deepseek-ai/dsh-tools')
      if (fromLauncher !== null) candidates.push(fromLauncher)
    }
    const local = resolveFrom(dirname(process.execPath), '@deepseek-ai/dsh-tools')
    if (local !== null) candidates.push(local)
    for (const root of appRoots()) {
      const found = resolveFrom(root, '@deepseek-ai/dsh-tools')
      if (found !== null) candidates.push(found)
      const nested = resolveFrom(join(root, 'node_modules'), '@deepseek-ai/dsh-tools')
      if (nested !== null) candidates.push(nested)
    }
    for (const file of candidates) {
      try {
        const mod = await import(pathToFileURL(file).href)
        const defineTool = mod.defineTool ?? mod.default?.defineTool
        if (typeof defineTool === 'function') return defineTool
      } catch {
        // Try the next copy.
      }
    }
    return null
  })()
  return defineToolPromise
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

/**
 * Build and register the tools.
 * @param {object} pluginCtx - host plugin context (services read lazily).
 * @param {object} toolsCtx - context with the `tools` service.
 * @param {{maxBytes: number, maxBlocks: number}} caps - extraction caps.
 * @returns {Promise<{registered: string[], missing: string[]}>}
 */
export async function installTools(pluginCtx, toolsCtx, caps) {
  const defineTool = await loadDefineTool()
  if (defineTool === null) {
    const reason = '无法解析 @deepseek-ai/dsh-tools，Agent 工具未注册；批注 UI 仍然可用。'
    warn(reason)
    status.toolsMissing = [...TOOL_NAMES]
    pluginCtx.logger?.warn?.('article-annotator: ' + reason)
    return { registered: [], missing: TOOL_NAMES }
  }
  const registered = []
  for (const build of BUILDERS) {
    const tool = build(defineTool, pluginCtx, caps)
    try {
      toolsCtx.effect(() => toolsCtx.tools.register(tool), 'article-annotator: tool ' + tool.name)
      registered.push(tool.name)
    } catch (error) {
      status.toolsMissing.push(tool.name)
      warn('工具 ' + tool.name + ' 注册失败：' + String(error))
      pluginCtx.logger?.warn?.('article-annotator: 工具 ' + tool.name + ' 注册失败：' + String(error))
    }
  }
  status.tools = registered
  status.toolsMissing = TOOL_NAMES.filter((name) => !registered.includes(name))
  pluginCtx.logger?.info?.('article-annotator: Agent 工具已注册：' + registered.join(', '))
  return { registered, missing: status.toolsMissing }
}

/** Tool builders, in registration order. */
const BUILDERS = [buildArticleReview, buildArticleRead, buildArticleResolve, buildSaveRevision, buildStyleAdd, buildStyleGet]

/* ------------------------------------------------------------------ *
 * Shared resolution helpers
 * ------------------------------------------------------------------ */

function sessionIdOf(exec) {
  const agent = exec?.agent
  const id = agent?.session?.id ?? agent?.id
  return typeof id === 'string' ? id : ''
}

/**
 * Resolve the article a tool call is about.
 * @param {object} ctx - host context.
 * @param {object} args - tool arguments.
 * @param {object} exec - tool execution context.
 * @returns {Promise<{absolutePath: string, cwd: string|null, sessionId: string}>}
 */
async function resolveTarget(ctx, args, exec) {
  const sessionId = sessionIdOf(exec)
  let cwd = null
  try {
    cwd = await resolveSessionCwd(ctx, sessionId)
  } catch {
    cwd = null
  }
  const raw = typeof args?.file === 'string' && args.file.trim() !== '' ? args.file.trim() : null
  if (raw === null) {
    const remembered = await lastArticleForSession(sessionId)
    if (remembered === null) {
      throw new ReviewError('no-file', '这个会话还没有打开过文稿。请让用户在右侧栏「文稿批注」里选一篇，或在调用时传入 file 参数。')
    }
    return { absolutePath: remembered, cwd: cwd ?? dirname(remembered), sessionId }
  }
  if (cwd === null) {
    if (!isAbsolute(raw)) throw new ReviewError('no-cwd', '无法确定工作目录；请传入文稿的绝对路径。')
    return { absolutePath: resolve(raw), cwd: dirname(resolve(raw)), sessionId }
  }
  return { absolutePath: resolveArticlePath(cwd, raw), cwd, sessionId }
}

/** Relative display path for a resolved article. */
function fileLabel(cwd, absolutePath) {
  if (cwd === null) return toPosix(absolutePath)
  return isWithin(cwd, absolutePath) ? displayPath(cwd, absolutePath) : toPosix(absolutePath)
}

/** Human address of a sentence's paragraph inside the document. */
function locationOf(article, comment) {
  const index = article.blocks.findIndex((block) => block.id === comment.blockId)
  const block = index >= 0 ? article.blocks[index] : undefined
  const paragraph = index >= 0 ? '第 ' + (index + 1) + ' 段' : (comment.blockKind === 'heading' ? '标题' : '段落')
  const parts = []
  if (block?.page !== undefined) parts.push('第 ' + block.page + ' 页')
  if (block?.slide !== undefined) parts.push('第 ' + block.slide + ' 张幻灯片')
  parts.push(paragraph)
  if (block?.kind === 'heading') parts.push('（标题）')
  return parts.join('·')
}

/* ------------------------------------------------------------------ *
 * article_review
 * ------------------------------------------------------------------ */

function buildArticleReview(defineTool, ctx, caps) {
  return defineTool({
    name: 'article_review',
    description:
      '读取当前文稿上的批注（右侧栏「文稿批注」里对整句或任意选中片段写的意见），以及长期写作风格记忆。'
      + '返回每条批注所在的段落/页/幻灯片、覆盖的原文片段、意见和状态。修改文稿前先调用它；'
      + '修改完成后用 article_review_resolve 把处理过的批注标为已解决，并把可复用的表达偏好用 writing_style_add 记录。'
      + '省略 file 时默认读这个会话最近打开的一篇文稿。',
    parameters: {
      file: { type: 'string', description: '文稿路径（工作区相对路径或绝对路径）。省略时使用本会话最近打开的一篇。' },
      includeText: { type: 'boolean', description: '是否同时返回全文。Word/PPT/PDF 默认返回，Markdown/TXT 默认不返回（可用你自己的文件工具读）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          file: { type: 'string' },
          title: { type: 'string' },
          format: { type: 'string' },
          total: { type: 'integer' },
          open: { type: 'integer' },
          resolved: { type: 'integer' },
          orphaned: { type: 'integer' },
          comments: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                location: { type: 'string' },
                quote: { type: 'string' },
                comment: { type: 'string' },
                status: { type: 'string', enum: ['open', 'resolved'] },
                orphaned: { type: 'boolean' },
                agentReply: { type: 'string' },
              },
            },
          },
          styleRules: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
      presentationMeta: (_args, value) => ({ file: value.file, open: value.open, total: value.total }),
    },
    async execute(args, exec) {
      const target = await resolveTarget(ctx, args, exec)
      const article = await extractArticle(target.absolutePath, caps)
      const state = await loadAnnotations(target.absolutePath)
      const anchored = anchorComments(article, state.comments)
      const style = await loadStyle()
      const includeText = args?.includeText === true || (args?.includeText !== false && article.format !== 'markdown' && article.format !== 'text')
      const text = includeText ? renderArticleText(article, { maxChars: 24000 }) : ''
      const comments = anchored.comments.map((item) => ({
        id: item.id,
        location: locationOf(article, item),
        quote: clip(item.quote ?? item.sentence ?? '', 300),
        comment: item.comment,
        status: item.status === 'resolved' ? 'resolved' : 'open',
        orphaned: item.orphaned === true,
        ...(typeof item.agentReply === 'string' && item.agentReply !== '' ? { agentReply: item.agentReply } : {}),
      }))
      const openComments = comments.filter((item) => item.status === 'open')
      const resolvedComments = comments.filter((item) => item.status === 'resolved')
      const styleRules = style.rules.slice(-12).map((rule) => rule.rule)
      const file = fileLabel(target.cwd, target.absolutePath)
      const report = renderReviewReport({ file, article, openComments, resolvedComments, orphaned: anchored.orphaned, styleRules, text })
      return {
        ok: true,
        file,
        title: article.title,
        format: article.format,
        total: comments.length,
        open: openComments.length,
        resolved: resolvedComments.length,
        orphaned: anchored.orphaned,
        comments,
        styleRules,
        ...(text !== '' ? { text } : {}),
        report,
      }
    },
  })
}

function renderReviewReport({ file, article, openComments, resolvedComments, orphaned, styleRules, text }) {
  const lines = []
  lines.push('文稿：' + file + '（' + formatLabel(article.format) + '，' + article.blocks.length + ' 段 / ' + article.stats.sentences + ' 句）')
  lines.push('批注：共 ' + (openComments.length + resolvedComments.length) + ' 条，待处理 ' + openComments.length + '，已解决 ' + resolvedComments.length + (orphaned > 0 ? '，其中 ' + orphaned + ' 条因原文改动暂时失去定位' : ''))
  if (openComments.length === 0) {
    lines.push('没有待处理的批注。')
  } else {
    lines.push('', '## 待处理批注')
    for (const item of openComments) {
      lines.push('- [' + item.id + '] ' + item.location + '：「' + oneLine(item.quote) + '」')
      lines.push('  意见：' + oneLine(item.comment))
      if (item.orphaned) lines.push('  注意：这段原文已改动，位置对不上，修改时请按语义自己找。')
    }
  }
  if (resolvedComments.length > 0) {
    lines.push('', '## 已解决批注（' + resolvedComments.length + ' 条，供回顾）')
    for (const item of resolvedComments.slice(0, 10)) {
      lines.push('- [' + item.id + '] ' + item.location + '：' + oneLine(item.comment))
    }
    if (resolvedComments.length > 10) lines.push('…其余 ' + (resolvedComments.length - 10) + ' 条从略。')
  }
  if (styleRules.length > 0) {
    lines.push('', '## 风格记忆（最近 ' + styleRules.length + ' 条）')
    for (const rule of styleRules) lines.push('- ' + rule)
  }
  if (text !== '') {
    lines.push('', '## 全文（带段落编号）', '', text)
  }
  lines.push('', '下一步：按批注修改文稿 → 用 article_review_resolve 提交处理过的批注 id → 从批注中归纳可复用的表达规则，用 writing_style_add 记录。')
  return lines.join('\n')
}

function formatLabel(format) {
  switch (format) {
    case 'markdown':
      return 'Markdown'
    case 'text':
      return '纯文本'
    case 'docx':
      return 'Word'
    case 'pptx':
      return 'PowerPoint'
    case 'pdf':
      return 'PDF'
    default:
      return String(format)
  }
}

/* ------------------------------------------------------------------ *
 * article_read
 * ------------------------------------------------------------------ */

function buildArticleRead(defineTool, ctx, caps) {
  return defineTool({
    name: 'article_read',
    description:
      '读取当前文稿的完整文字（支持 Markdown / TXT / Word(docx) / PowerPoint(pptx) / PDF），每段带 [bN] 编号，'
      + '第 N 页 / 第 N 张幻灯片有分隔标记。用于修改前通读全文，尤其适合模型自己的文件工具读不了的二进制文稿。',
    parameters: {
      file: { type: 'string', description: '文稿路径（工作区相对路径或绝对路径）。省略时使用本会话最近打开的一篇。' },
      maxChars: { type: 'integer', description: '最多返回多少字符，默认 40000。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          file: { type: 'string' },
          title: { type: 'string' },
          format: { type: 'string' },
          chars: { type: 'integer' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: '文稿：' + value.file + '（' + value.title + '）\n\n' + value.text }],
    },
    async execute(args, exec) {
      const target = await resolveTarget(ctx, args, exec)
      const article = await extractArticle(target.absolutePath, caps)
      const maxChars = Number.isInteger(args?.maxChars) && args.maxChars > 0 ? Math.min(args.maxChars, 120000) : 40000
      const text = renderArticleText(article, { maxChars })
      return {
        ok: true,
        file: fileLabel(target.cwd, target.absolutePath),
        title: article.title,
        format: article.format,
        chars: article.stats.chars,
        text,
      }
    },
  })
}

/* ------------------------------------------------------------------ *
 * article_review_resolve
 * ------------------------------------------------------------------ */

function buildArticleResolve(defineTool, ctx, caps) {
  return defineTool({
    name: 'article_review_resolve',
    description:
      '把指定批注标记为已解决（修改完成后调用）。传入 article_review 返回的批注 id 数组；'
      + '若某条批注无法处理（例如原文已被删除），保留为待处理并在回复里说明即可。',
    parameters: {
      ids: { type: 'array', items: { type: 'string' }, required: true, description: '要标记为已解决的批注 id 列表。' },
      file: { type: 'string', description: '文稿路径；省略时使用本会话最近打开的一篇。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          resolved: { type: 'integer' },
          open: { type: 'integer' },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args, exec) {
      const target = await resolveTarget(ctx, args, exec)
      await extractArticle(target.absolutePath, caps) // validate that the file still opens
      const ids = Array.isArray(args?.ids) ? args.ids.map((id) => String(id)).filter(Boolean) : []
      if (ids.length === 0) throw new ReviewError('bad-request', 'ids 不能为空。')
      let resolved = 0
      const missing = []
      for (const id of new Set(ids)) {
        try {
          await patchComment(target.absolutePath, id, { status: 'resolved' })
          resolved += 1
        } catch {
          missing.push(id)
        }
      }
      const state = await loadAnnotations(target.absolutePath)
      const open = state.comments.filter((item) => item.status !== 'resolved').length
      const report = '已把 ' + resolved + ' 条批注标记为已解决' + (missing.length > 0 ? '；' + missing.length + ' 条没找到（' + missing.join(', ') + '）' : '') + '。当前还有 ' + open + ' 条待处理。'
      return { ok: true, resolved, open, report }
    },
  })
}

/* ------------------------------------------------------------------ *
 * article_review_save_revision
 * ------------------------------------------------------------------ */

function buildSaveRevision(defineTool, ctx, caps) {
  return defineTool({
    name: 'article_review_save_revision',
    description:
      '把改好的全文写成文稿旁边的 Markdown 修订文件（<原名>.revised.md），不覆盖原文件。'
      + 'Word / PowerPoint / PDF 这类二进制文稿用它能交付修订稿；Markdown/TXT 文稿直接用你自己的编辑工具改原文件即可。',
    parameters: {
      content: { type: 'string', required: true, description: '修订后的完整 Markdown 正文。' },
      file: { type: 'string', description: '源文稿路径；省略时使用本会话最近打开的一篇。' },
      note: { type: 'string', description: '可选说明，写在修订文件开头。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args, exec) {
      const target = await resolveTarget(ctx, args, exec)
      const content = String(args?.content ?? '')
      const header = '# 修订稿\n\n> 源文稿：' + fileLabel(target.cwd, target.absolutePath) + '\n> 修订时间：' + new Date().toISOString() + (typeof args?.note === 'string' && args.note.trim() !== '' ? '\n> 说明：' + clip(args.note.trim(), 500) : '') + '\n\n'
      const written = await writeRevision(target.absolutePath, header + content)
      return {
        ok: true,
        path: toPosix(written),
        report: '修订稿已写入：' + toPosix(written) + '\n原文件未改动。',
      }
    },
  })
}

/* ------------------------------------------------------------------ *
 * writing_style_add / writing_style_get
 * ------------------------------------------------------------------ */

function buildStyleAdd(defineTool, ctx) {
  return defineTool({
    name: 'writing_style_add',
    description:
      '把一条可复用的中文表达偏好记入长期风格记忆（例如「少用四字成语堆叠」「段落结尾不要总结式拔高」）。'
      + '每次按批注修改文稿后，把从批注中归纳出的通用规则逐条记下来；只记可复用的规则，不要记某一句的具体改法。'
      + '记忆会进入之后的系统提示，并在 article_review 中返回。重复规则会自动去重。',
    parameters: {
      rule: { type: 'string', required: true, description: '一句话规则，尽量具体可检查。' },
      evidence: { type: 'string', description: '可选：这条规则来自哪条批注 / 哪个例句。' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选标签，例如：措辞、结构、语气、标点。' },
      file: { type: 'string', description: '可选：规则来源文稿路径。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          added: { type: 'boolean' },
          total: { type: 'integer' },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const result = await addStyleRule({
        rule: args?.rule,
        evidence: args?.evidence,
        tags: args?.tags,
        sourceFile: args?.file,
      })
      return {
        ok: true,
        added: result.added,
        total: result.total,
        report: result.added ? '已记入风格记忆（共 ' + result.total + ' 条）：' + result.rule.rule : '这条规则已经在风格记忆里了（共 ' + result.total + ' 条）：' + result.rule.rule,
      }
    },
  })
}

function buildStyleGet(defineTool, ctx) {
  return defineTool({
    name: 'writing_style_get',
    description: '读取长期写作风格记忆的全部规则（来自用户在文稿批注里反复表达的表达偏好）。写中文内容前可用它对一遍。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          total: { type: 'integer' },
          rules: { type: 'array', items: { type: 'string' } },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute() {
      const state = await loadStyle()
      const rules = state.rules.map((rule) => rule.rule)
      const report = rules.length === 0 ? '风格记忆还是空的。' : '写作风格记忆（共 ' + rules.length + ' 条）：\n' + rules.map((rule, index) => index + 1 + '. ' + rule).join('\n')
      return { ok: true, total: rules.length, rules, report }
    },
  })
}
