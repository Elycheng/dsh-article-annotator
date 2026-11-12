/**
 * Same-origin JSON API of the article reviewer.
 *
 * One prefix (`/article-annotator/api`) with a small method dispatch, modeled on
 * the route pattern proven by dsh-client-ui-quote on this DSH version: the
 * connection fence runs first (`connection.requestRejection`), the body is
 * capped, every answer is `{ ok, value }` or `{ ok:false, error }`.
 */
import {
  ReviewError,
  listArticles,
  resolveArticlePath,
  resolveSessionCwd,
  serviceOf,
  statArticle,
  toPosix,
} from './util.js'
import { displayPath, extractArticle } from './extract.js'
import { status, statusSnapshot } from './status.js'
import {
  addStyleRule,
  anchorComments,
  deleteComment,
  loadAnnotations,
  loadRecent,
  loadStyle,
  patchComment,
  recordRecent,
  removeStyleRule,
  upsertComment,
} from './store.js'

export const API_PREFIX = '/article-annotator/api'
const BODY_LIMIT = 2 * 1024 * 1024

/**
 * Register the route with the host web server.
 * @param {object} pluginCtx - the plugin's own Cordis context.
 * @param {object} webCtx - context that has the `webServer` service.
 * @param {{maxBytes: number, maxBlocks: number}} caps - extraction caps.
 */
export function installRoutes(pluginCtx, webCtx, caps) {
  const register = () => {
    const handler = (req, res) => {
      void handleRequest(pluginCtx, caps, req, res)
    }
    return webCtx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
  }
  try {
    const dispose = webCtx.effect(register, 'article-annotator: api routes')
    status.routes = true
    return dispose
  } catch (error) {
    pluginCtx.logger?.warn?.('article-annotator: route registration failed: ' + String(error))
    return () => {}
  }
}

/**
 * Handle one API request. Exported for the offline host suite.
 * @param {object} ctx - host plugin context.
 * @param {{maxBytes: number, maxBlocks: number}} caps - extraction caps.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
export async function handleRequest(ctx, caps, req, res) {
  const connection = serviceOf(ctx, 'connection')
  if (connection === null || typeof connection.requestRejection !== 'function') {
    writeJson(res, 503, { ok: false, error: { code: 'unavailable', message: '宿主连接围栏不可用。' } })
    return
  }
  let rejection
  try {
    rejection = connection.requestRejection(req)
  } catch {
    rejection = true
  }
  if (rejection !== undefined) {
    writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
    return
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'POST only' } })
    return
  }
  let method = ''
  try {
    method = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice(API_PREFIX.length + 1)
  } catch {
    method = ''
  }
  let payload
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    const failed = failure(error)
    writeJson(res, failed.status, failed.body)
    return
  }
  try {
    const value = await dispatch(ctx, caps, method, payload)
    writeJson(res, 200, { ok: true, value })
  } catch (error) {
    const failed = failure(error)
    if (failed.status >= 500) ctx.logger?.warn?.('article-annotator: API failed: ' + String(error?.stack ?? error))
    writeJson(res, failed.status, failed.body)
  }
}

/**
 * Dispatch one API method.
 * @param {object} ctx - host plugin context.
 * @param {{maxBytes: number, maxBlocks: number}} caps - caps.
 * @param {string} method - method name.
 * @param {object} payload - parsed JSON body.
 * @returns {Promise<object>} the response value.
 */
export async function dispatch(ctx, caps, method, payload) {
  switch (method) {
    case 'probe':
      return probe()
    case 'list':
      return list(ctx, payload)
    case 'open':
      return open(ctx, caps, payload)
    case 'comment':
      return comment(ctx, caps, payload)
    case 'style':
      return style(payload)
    case 'recent':
      return recent()
    default:
      throw new ReviewError('not-found', '未知的 API 方法：' + method, 404)
  }
}

function probe() {
  return {
    version: 1,
    methods: ['probe', 'list', 'open', 'comment', 'style', 'recent'],
    formats: ['markdown', 'text', 'docx', 'pptx', 'pdf'],
    features: {
      sentenceAnchors: true,
      /** Comments anchor arbitrary `{ start, end }` character ranges (0.2.0+). */
      rangeAnchors: true,
      agentTools: true,
      styleMemory: true,
      revisionFile: true,
    },
    plugin: statusSnapshot(),
  }
}

async function list(ctx, payload) {
  const sessionId = requireString(payload, 'sessionId')
  const cwd = await resolveSessionCwd(ctx, sessionId, payload.cwd)
  const items = await listArticles(cwd)
  const recentState = await loadRecent()
  const styleState = await loadStyle()
  return {
    cwd,
    items: items.map((item) => ({ ...item, path: toPosix(item.path) })),
    recent: recentState.items,
    styleCount: styleState.rules.length,
  }
}

async function open(ctx, caps, payload) {
  const sessionId = requireString(payload, 'sessionId')
  const rawFile = requireString(payload, 'file')
  const cwd = await resolveSessionCwd(ctx, sessionId, payload.cwd)
  const absolutePath = resolveArticlePath(cwd, rawFile)
  const article = await extractArticleWithBytes(absolutePath, caps)
  const file = displayPath(cwd, absolutePath)
  const state = await loadAnnotations(absolutePath)
  const anchored = anchorComments(article, state.comments)
  const styleState = await loadStyle()
  await recordRecent({ absolutePath, file, title: article.title, format: article.format, sessionId })
  return {
    cwd,
    file,
    article: { ...article, file, comments: anchored.comments, updatedAt: state.updatedAt },
    comments: anchored.comments,
    orphaned: anchored.orphaned,
    reanchored: anchored.reanchored,
    styleRules: styleState.rules,
  }
}

async function extractArticleWithBytes(absolutePath, caps) {
  const article = await extractArticle(absolutePath, caps)
  const meta = await statArticle(absolutePath, caps.maxBytes)
  article.stats = { ...article.stats, bytes: meta.size }
  return article
}

async function comment(ctx, caps, payload) {
  const sessionId = requireString(payload, 'sessionId')
  const rawFile = requireString(payload, 'file')
  const cwd = await resolveSessionCwd(ctx, sessionId, payload.cwd)
  const absolutePath = resolveArticlePath(cwd, rawFile)
  await statArticle(absolutePath, caps.maxBytes)
  const action = typeof payload.action === 'string' ? payload.action : 'save'
  if (action === 'save') {
    const saved = await upsertComment(absolutePath, payload)
    return { action, comment: saved.comment, total: saved.state.comments.length }
  }
  if (action === 'delete') {
    const id = requireString(payload, 'id')
    const state = await deleteComment(absolutePath, id)
    return { action, total: state.comments.length }
  }
  if (action === 'patch') {
    const id = requireString(payload, 'id')
    const state = await patchComment(absolutePath, id, { status: payload.status, agentReply: payload.agentReply })
    return { action, total: state.comments.length }
  }
  throw new ReviewError('bad-request', '未知的批注操作：' + action)
}

async function style(payload) {
  const action = typeof payload.action === 'string' ? payload.action : 'list'
  if (action === 'list') {
    const state = await loadStyle()
    return { action, rules: state.rules, total: state.rules.length }
  }
  if (action === 'add') {
    const added = await addStyleRule(payload)
    const state = await loadStyle()
    return { action, added: added.added, rule: added.rule, rules: state.rules, total: state.rules.length }
  }
  if (action === 'remove') {
    const id = requireString(payload, 'id')
    const removed = await removeStyleRule(id)
    const state = await loadStyle()
    return { action, removed: removed.removed, rules: state.rules, total: state.rules.length }
  }
  throw new ReviewError('bad-request', '未知的风格操作：' + action)
}

async function recent() {
  const state = await loadRecent()
  return { items: state.items }
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

function requireString(payload, key) {
  const value = payload?.[key]
  if (typeof value !== 'string' || value.trim() === '') throw new ReviewError('bad-request', `缺少参数 "${key}"。`)
  return value.trim()
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new ReviewError('bad-request', '请求体过大。', 413))
        if (typeof req.destroy === 'function') req.destroy()
        return
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
      } catch {
        reject(new ReviewError('bad-request', '请求体不是合法 JSON。'))
      }
    })
    req.on('error', () => reject(new ReviewError('bad-request', '请求体读取失败。')))
  })
}

function writeJson(res, status, body) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  } catch {
    // Connection already gone.
  }
}

function failure(error) {
  const status = typeof error?.status === 'number' ? error.status : error instanceof ReviewError ? 400 : 500
  const code = typeof error?.code === 'string' ? error.code : 'error'
  const message = error instanceof Error ? error.message : String(error)
  return { status, body: { ok: false, error: { code, message } } }
}
