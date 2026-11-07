/**
 * dsh-article-annotator — host half.
 *
 * The client half renders the right-sidebar reviewer; this half owns the
 * durable state and the model-facing surface:
 *
 *   POST /article-annotator/api/*   list / open / comment / style / recent
 *   ctx.tools.register(...)       article_review, article_read, resolve,
 *                                 save_revision, writing_style_add/get
 *   ctx.systemPrompt.section(...) the long-term writing-style memory
 *
 * Deliberately no static @deepseek-ai import: the bundle is mounted as a local
 * `link:`, so its module resolution never reaches the host installation. Host
 * services are reached through `ctx.inject` / `ctx.get`; `defineTool` is the
 * one symbol imported lazily from the host installation (see tools.js).
 *
 * Everything degrades: without a web server there is no route, without tools
 * there are no agent tools, without a system prompt there is no memory
 * section — and none of those failures stops the plugin from loading.
 */
import { createConfigSchema } from './config.js'
import { installRoutes } from './api.js'
import { installTools } from './tools.js'
import { loadStyleSync } from './store.js'
import { status, warn } from './status.js'
import { clip } from './util.js'

export const name = 'dsh-article-annotator'

/**
 * Config must be a Standard Schema (it is validated synchronously before
 * activation), hence the hand-written zero-dependency schema.
 */
export const Config = createConfigSchema({
  injectStyle: { type: 'boolean', fallback: true },
  maxStyleRules: { type: 'integer', fallback: 12 },
  maxArticleBytes: { type: 'integer', fallback: 41943040 },
  maxBlocks: { type: 'integer', fallback: 1500 },
  enableTools: { type: 'boolean', fallback: true },
})

/** Prompt section name (unique across plugins). */
const STYLE_SECTION = 'article-annotator:writing-style'
/** Placed after the persona (0) / style-writing contract (150), before plan (500). */
const STYLE_ORDER = 260

/**
 * Render the long-term style memory for the system prompt. Empty when no rule
 * has been recorded yet, so a fresh profile pays nothing.
 * @param {number} maxRules - how many rules to include.
 * @returns {string} the prompt section text.
 */
export function renderStyleSection(maxRules) {
  let rules = []
  try {
    rules = loadStyleSync().rules
  } catch {
    return ''
  }
  if (rules.length === 0) return ''
  const limit = Number.isInteger(maxRules) && maxRules > 0 ? maxRules : 12
  const picked = rules.slice(-limit)
  const lines = [
    '## 我的写作风格偏好（长期记忆）',
    '',
    '以下规则来自我对历史文稿的逐句批注，写中文内容时优先遵守；与本轮明确要求冲突时，以本轮要求为准。',
    '',
  ]
  for (const rule of picked) lines.push('- ' + clip(rule.rule, 300))
  if (rules.length > picked.length) lines.push('（另有 ' + (rules.length - picked.length) + ' 条较早的规则未列出。）')
  return lines.join('\n')
}

/**
 * Plugin entry.
 * @param {object} ctx - Cordis plugin context.
 * @param {object} config - validated config.
 */
export function apply(ctx, config) {
  const cfg = config ?? {}
  status.loaded = true
  const caps = {
    maxBytes: Number.isInteger(cfg.maxArticleBytes) && cfg.maxArticleBytes > 0 ? cfg.maxArticleBytes : 41943040,
    maxBlocks: Number.isInteger(cfg.maxBlocks) && cfg.maxBlocks > 0 ? cfg.maxBlocks : 1500,
  }
  const hasInject = typeof ctx.inject === 'function'

  // Same-origin HTTP API used by the sidebar tab.
  const installApi = (webCtx) => {
    installRoutes(ctx, webCtx, caps)
  }
  // Agent tools (the model's half of the review loop).
  const installAgentTools = (toolsCtx) => {
    void installTools(ctx, toolsCtx, caps).catch((error) => {
      const reason = '工具注册失败：' + String(error)
      warn(reason)
      ctx.logger?.warn?.('article-annotator: ' + reason)
    })
  }
  // Long-term writing-style memory in the prompt.
  const installStyle = (promptCtx) => {
    try {
      promptCtx.effect(
        () =>
          promptCtx.systemPrompt.section({
            name: STYLE_SECTION,
            order: STYLE_ORDER,
            text: () => renderStyleSection(cfg.maxStyleRules),
          }),
        'article-annotator: writing style memory',
      )
      status.styleSection = true
    } catch (error) {
      const reason = '风格记忆段落注册失败：' + String(error)
      warn(reason)
      ctx.logger?.warn?.('article-annotator: ' + reason)
    }
  }

  if (hasInject) {
    ctx.inject(['webServer'], installApi)
    if (cfg.enableTools !== false) ctx.inject(['tools'], installAgentTools)
    if (cfg.injectStyle !== false) ctx.inject(['systemPrompt'], installStyle)
  } else {
    // Minimal hosts / the offline harness: install whatever is already there.
    if (ctx.webServer !== undefined) installApi(ctx)
    if (cfg.enableTools !== false && ctx.tools !== undefined) installAgentTools(ctx)
    if (cfg.injectStyle !== false && ctx.systemPrompt !== undefined) installStyle(ctx)
  }

  const toolState = cfg.enableTools === false ? '关' : '开'
  ctx.logger?.info?.(
    'article-annotator: 文稿批注已加载（右侧栏「文稿批注」）｜批注 API=开｜Agent 工具=' + toolState + '｜风格记忆=' + (cfg.injectStyle === false ? '关' : '开'),
  )
}

/** Exposed for the offline suite; nothing in DSH reads this. */
export const __testing = {
  renderStyleSection,
  capsOf: (cfg) => ({
    maxBytes: Number.isInteger(cfg?.maxArticleBytes) && cfg.maxArticleBytes > 0 ? cfg.maxArticleBytes : 41943040,
    maxBlocks: Number.isInteger(cfg?.maxBlocks) && cfg.maxBlocks > 0 ? cfg.maxBlocks : 1500,
  }),
}
