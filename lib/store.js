/**
 * Durable store for review comments, the long-term writing-style memory and
 * the recent-file list.
 *
 * Everything lives under `$DSH_HOME/article-annotator` (not in the workspace) so
 * review state never pollutes the article folder and survives across sessions:
 *
 *   annotations/<sha1(path)>.json   one file per reviewed article
 *   style.json                     accumulated writing-style rules
 *   recent.json                    recently opened articles
 *   sessions.json                  last article per session (tool default)
 *
 * Reads and writes are atomic; every entry is bounded so a runaway document
 * cannot grow the store without limit.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ReviewError,
  clip,
  dataRoot,
  oneLine,
  readJson,
  readJsonSync,
  sha1,
  toPosix,
  writeJson,
  writeText,
} from './util.js'

const MAX_COMMENTS_PER_ARTICLE = 500
const MAX_COMMENT_CHARS = 4000
const MAX_SENTENCE_CHARS = 600
const MAX_STYLE_RULES = 200
const MAX_STYLE_RULE_CHARS = 400
const MAX_RECENT = 30
const MAX_SESSION_MAP = 500
const MAX_REVISION_BYTES = 4 * 1024 * 1024
const MAX_REVISION_NAME = 120

/** Stable store key for an article path (case-insensitive on Windows). */
export function articleKey(absolutePath) {
  const normal = toPosix(absolutePath)
  return sha1(process.platform === 'win32' ? normal.toLowerCase() : normal)
}

/** `$DSH_HOME/article-annotator/annotations/<key>.json` */
export function annotationFile(absolutePath) {
  return join(dataRoot(), 'annotations', articleKey(absolutePath) + '.json')
}

/** Default shape of one article's annotation file. */
function emptyAnnotations(absolutePath) {
  return { version: 1, absolutePath, comments: [], updatedAt: 0 }
}

/**
 * Read one article's annotations.
 * @param {string} absolutePath - article path.
 * @returns {Promise<{version: number, absolutePath: string, comments: object[], updatedAt: number}>}
 */
export async function loadAnnotations(absolutePath) {
  const state = await readJson(annotationFile(absolutePath), null)
  if (state === null || typeof state !== 'object' || !Array.isArray(state.comments)) {
    return emptyAnnotations(absolutePath)
  }
  return {
    version: 1,
    absolutePath,
    comments: state.comments.filter(isComment),
    updatedAt: Number.isFinite(state.updatedAt) ? state.updatedAt : 0,
  }
}

/**
 * Persist one article's annotations.
 * @param {string} absolutePath - article path.
 * @param {object[]} comments - comment list already validated.
 */
export async function saveAnnotations(absolutePath, comments) {
  const state = {
    version: 1,
    absolutePath,
    comments: comments.slice(0, MAX_COMMENTS_PER_ARTICLE),
    updatedAt: Date.now(),
  }
  await writeJson(annotationFile(absolutePath), state)
  return state
}

function isComment(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.blockId === 'string' &&
    Number.isInteger(value.sentenceIndex) &&
    typeof value.comment === 'string' &&
    typeof value.sentence === 'string'
  )
}

/**
 * Create or update one comment.
 * @param {string} absolutePath - article path.
 * @param {object} payload - `{ id?, blockId, sentenceIndex, sentence, comment, blockKind?, page?, slide? }`.
 * @returns {Promise<{comment: object, state: object}>}
 */
export async function upsertComment(absolutePath, payload) {
  const blockId = typeof payload?.blockId === 'string' ? payload.blockId.trim() : ''
  const sentenceIndex = Number(payload?.sentenceIndex)
  const sentence = clip(String(payload?.sentence ?? '').trim(), MAX_SENTENCE_CHARS)
  const comment = String(payload?.comment ?? '').trim()
  if (blockId === '' || !Number.isInteger(sentenceIndex) || sentenceIndex < 0) {
    throw new ReviewError('bad-request', '批注缺少定位信息（blockId / sentenceIndex）。')
  }
  if (comment === '') throw new ReviewError('bad-request', '批注内容不能为空。')
  if (comment.length > MAX_COMMENT_CHARS) throw new ReviewError('bad-request', `批注不能超过 ${MAX_COMMENT_CHARS} 字。`)
  const state = await loadAnnotations(absolutePath)
  const now = Date.now()
  const id = typeof payload?.id === 'string' && payload.id !== '' ? payload.id : 'c' + now.toString(36) + Math.random().toString(36).slice(2, 6)
  const existing = state.comments.find((item) => item.id === id)
  const commentRecord = {
    id,
    blockId,
    sentenceIndex,
    sentence,
    comment,
    status: payload?.status === 'resolved' ? 'resolved' : existing?.status === 'resolved' ? 'resolved' : 'open',
    ...(typeof payload?.blockKind === 'string' ? { blockKind: payload.blockKind } : {}),
    ...(Number.isInteger(payload?.page) ? { page: payload.page } : {}),
    ...(Number.isInteger(payload?.slide) ? { slide: payload.slide } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(typeof existing?.agentReply === 'string' && existing.agentReply !== '' ? { agentReply: existing.agentReply } : {}),
  }
  const next = existing === undefined ? [...state.comments, commentRecord] : state.comments.map((item) => (item.id === id ? commentRecord : item))
  if (next.length > MAX_COMMENTS_PER_ARTICLE) throw new ReviewError('too-many', `一篇文章最多 ${MAX_COMMENTS_PER_ARTICLE} 条批注。`)
  const saved = await saveAnnotations(absolutePath, next)
  return { comment: commentRecord, state: saved }
}

/**
 * Delete one comment.
 * @param {string} absolutePath - article path.
 * @param {string} id - comment id.
 */
export async function deleteComment(absolutePath, id) {
  const state = await loadAnnotations(absolutePath)
  const next = state.comments.filter((item) => item.id !== id)
  if (next.length === state.comments.length) throw new ReviewError('not-found', '找不到这条批注。', 404)
  return saveAnnotations(absolutePath, next)
}

/**
 * Change one comment's status / agent reply.
 * @param {string} absolutePath - article path.
 * @param {string} id - comment id.
 * @param {{status?: 'open'|'resolved', agentReply?: string}} patch - fields to change.
 */
export async function patchComment(absolutePath, id, patch) {
  const state = await loadAnnotations(absolutePath)
  const existing = state.comments.find((item) => item.id === id)
  if (existing === undefined) throw new ReviewError('not-found', '找不到这条批注。', 404)
  const updated = {
    ...existing,
    ...(patch?.status === 'open' || patch?.status === 'resolved' ? { status: patch.status } : {}),
    ...(typeof patch?.agentReply === 'string' ? { agentReply: clip(patch.agentReply, MAX_COMMENT_CHARS) } : {}),
    updatedAt: Date.now(),
  }
  return saveAnnotations(absolutePath, state.comments.map((item) => (item.id === id ? updated : item)))
}

/**
 * Re-anchor comments onto the current article version.
 *
 * The stored `blockId` + `sentenceIndex` is authoritative when the sentence
 * text still matches. After an edit (the agent rewrote the article, or the
 * author changed it) the positions may shift, so the original sentence text is
 * searched within the same block first, then across the whole article. A
 * comment that cannot be found is returned as `orphaned: true` — the UI keeps
 * it visible so the opinion is never silently lost.
 * @param {object} article - extracted article.
 * @param {object[]} comments - stored comments.
 * @returns {{comments: object[], orphaned: number, reanchored: number}}
 */
export function anchorComments(article, comments) {
  let orphaned = 0
  let reanchored = 0
  const index = new Map()
  for (const block of article.blocks) {
    for (const sentence of block.sentences) index.set(normalizeKey(sentence.text), { block, sentence })
  }
  const byBlock = new Map(article.blocks.map((block) => [block.id, block]))
  const anchored = comments.map((comment) => {
    const block = byBlock.get(comment.blockId)
    if (block !== undefined) {
      const current = block.sentences[comment.sentenceIndex]
      if (current !== undefined && normalizeKey(current.text) === normalizeKey(comment.sentence)) {
        return { ...comment, orphaned: false }
      }
      const near = block.sentences.find((sentence) => normalizeKey(sentence.text) === normalizeKey(comment.sentence))
      if (near !== undefined) {
        reanchored += 1
        return { ...comment, blockId: block.id, sentenceIndex: near.index, blockKind: block.kind, page: block.page, slide: block.slide, orphaned: false }
      }
    }
    const found = index.get(normalizeKey(comment.sentence))
    if (found !== undefined) {
      reanchored += 1
      return {
        ...comment,
        blockId: found.block.id,
        sentenceIndex: found.sentence.index,
        blockKind: found.block.kind,
        page: found.block.page,
        slide: found.block.slide,
        orphaned: false,
      }
    }
    orphaned += 1
    return { ...comment, orphaned: true }
  })
  return { comments: anchored, orphaned, reanchored }
}

/**
 * Normalised comparison key: whitespace, full-width spaces and the punctuation
 * a rule may or may not carry are ignored, so "少用成语堆叠。" and
 * "少用成语堆叠" are the same rule.
 */
export function ruleKey(text) {
  return normalizeKey(text).toLowerCase().replace(/[。；;，,、！!？?…：:.\-—]/gu, '')
}
export function normalizeKey(text) {
  return String(text ?? '')
    .replace(/[\s\u3000]+/gu, '')
    .trim()
}

/* ------------------------------------------------------------------ *
 * Writing-style memory
 * ------------------------------------------------------------------ */

const styleFile = () => join(dataRoot(), 'style.json')
const recentFile = () => join(dataRoot(), 'recent.json')
const sessionsFile = () => join(dataRoot(), 'sessions.json')

/** Read the style memory (async). */
export async function loadStyle() {
  const state = await readJson(styleFile(), null)
  return normaliseStyle(state)
}

/** Read the style memory synchronously (prompt sections resolve sync). */
export function loadStyleSync() {
  return normaliseStyle(readJsonSync(styleFile(), null))
}

function normaliseStyle(state) {
  const rules = Array.isArray(state?.rules)

    ? state.rules
        .filter((rule) => rule !== null && typeof rule === 'object' && typeof rule.rule === 'string' && rule.rule.trim() !== '')
        .slice(0, MAX_STYLE_RULES)
        .map((rule, index) => ({
          id: typeof rule.id === 'string' && rule.id !== '' ? rule.id : 'r' + index,
          rule: clip(rule.rule.trim(), MAX_STYLE_RULE_CHARS),
          ...(typeof rule.evidence === 'string' && rule.evidence !== '' ? { evidence: clip(rule.evidence, 300) } : {}),
          ...(Array.isArray(rule.tags) ? { tags: rule.tags.filter((tag) => typeof tag === 'string').slice(0, 8) } : {}),
          ...(typeof rule.sourceFile === 'string' && rule.sourceFile !== '' ? { sourceFile: rule.sourceFile } : {}),
          createdAt: Number.isFinite(rule.createdAt) ? rule.createdAt : Date.now(),
        }))
    : []
  return { version: 1, rules, updatedAt: Number.isFinite(state?.updatedAt) ? state.updatedAt : 0 }
}

/**
 * Append one writing-style rule (idempotent by normalised text).
 * @param {{rule: string, evidence?: string, tags?: string[], sourceFile?: string}} input - the rule.
 * @returns {Promise<{added: boolean, rule: object, total: number}>}
 */
export async function addStyleRule(input) {
  const text = oneLine(input?.rule)
  if (text === '') throw new ReviewError('bad-request', '风格规则不能为空。')
  if (text.length > MAX_STYLE_RULE_CHARS) throw new ReviewError('bad-request', `一条风格规则不能超过 ${MAX_STYLE_RULE_CHARS} 字。`)
  const state = await loadStyle()
  const key = ruleKey(text)
  const existing = state.rules.find((rule) => ruleKey(rule.rule) === key)
  if (existing !== undefined) {
    return { added: false, rule: existing, total: state.rules.length }
  }
  const rule = {
    id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    rule: text,
    ...(typeof input?.evidence === 'string' && input.evidence.trim() !== '' ? { evidence: clip(input.evidence.trim(), 300) } : {}),
    ...(Array.isArray(input?.tags) ? { tags: input.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '').slice(0, 8) } : {}),
    ...(typeof input?.sourceFile === 'string' && input.sourceFile !== '' ? { sourceFile: clip(toPosix(input.sourceFile), 300) } : {}),
    createdAt: Date.now(),
  }
  const rules = [...state.rules, rule].slice(-MAX_STYLE_RULES)
  await writeJson(styleFile(), { version: 1, rules, updatedAt: Date.now() })
  return { added: true, rule, total: rules.length }
}

/**
 * Remove one style rule by id.
 * @param {string} id - rule id.
 */
export async function removeStyleRule(id) {
  const state = await loadStyle()
  const next = state.rules.filter((rule) => rule.id !== id)
  if (next.length === state.rules.length) throw new ReviewError('not-found', '找不到这条风格规则。', 404)
  await writeJson(styleFile(), { version: 1, rules: next, updatedAt: Date.now() })
  return { removed: true, total: next.length }
}

/* ------------------------------------------------------------------ *
 * Recent files + last article per session
 * ------------------------------------------------------------------ */

/** Read the recent-article list. */
export async function loadRecent() {
  const state = await readJson(recentFile(), null)
  const items = Array.isArray(state?.items) ? state.items.filter((item) => item !== null && typeof item === 'object' && typeof item.absolutePath === 'string') : []
  return { version: 1, items: items.slice(0, MAX_RECENT) }
}

/**
 * Record that an article was opened.
 * @param {{absolutePath: string, title?: string, format?: string, file?: string, sessionId?: string}} input - record.
 */
export async function recordRecent(input) {
  const state = await loadRecent()
  const entry = {
    absolutePath: input.absolutePath,
    file: toPosix(input.file ?? input.absolutePath),
    title: oneLine(input.title ?? '') || undefined,
    format: input.format,
    at: Date.now(),
  }
  const next = [entry, ...state.items.filter((item) => item.absolutePath !== input.absolutePath)].slice(0, MAX_RECENT)
  await writeJson(recentFile(), { version: 1, items: next })
  if (typeof input.sessionId === 'string' && input.sessionId !== '') {
    await rememberSessionArticle(input.sessionId, input.absolutePath)
  }
  return { items: next }
}

/** Remember the last article a session opened (used as tool default). */
export async function rememberSessionArticle(sessionId, absolutePath) {
  const state = await readJson(sessionsFile(), null)
  const map = state !== null && typeof state === 'object' && state.sessions !== null && typeof state.sessions === 'object' ? { ...state.sessions } : {}
  map[sessionId] = { absolutePath, at: Date.now() }
  const keys = Object.keys(map)
  if (keys.length > MAX_SESSION_MAP) {
    keys.sort((a, b) => (map[a]?.at ?? 0) - (map[b]?.at ?? 0))
    for (const key of keys.slice(0, keys.length - MAX_SESSION_MAP)) delete map[key]
  }
  await writeJson(sessionsFile(), { version: 1, sessions: map })
}

/** The last article a session opened, or null. */
export async function lastArticleForSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const state = await readJson(sessionsFile(), null)
  const entry = state?.sessions?.[sessionId]
  return entry !== null && typeof entry?.absolutePath === 'string' ? entry.absolutePath : null
}

/* ------------------------------------------------------------------ *
 * Revision output
 * ------------------------------------------------------------------ */

/**
 * Write an agent-produced revision next to the source article.
 *
 * DOCX/PPTX/PDF cannot be edited safely in place by a text model, so the
 * revision is a sibling Markdown file the author can diff/compare, while
 * Markdown articles are normally edited directly by the agent's own tools.
 * @param {string} absolutePath - source article.
 * @param {string} content - revision Markdown.
 * @returns {Promise<string>} the path written.
 */
export async function writeRevision(absolutePath, content) {
  const text = String(content ?? '')
  if (text.trim() === '') throw new ReviewError('bad-request', '修订内容不能为空。')
  if (Buffer.byteLength(text, 'utf8') > MAX_REVISION_BYTES) throw new ReviewError('too-large', '修订内容超过 4 MB。', 413)
  const { dirname, basename, extname, join: joinPath } = await import('node:path')
  const dir = dirname(absolutePath)
  const name = basename(absolutePath)
  const ext = extname(name)
  const stem = name.slice(0, -ext.length)
  const target = joinPath(dir, (stem === '' ? name : stem).slice(0, MAX_REVISION_NAME) + '.revised.md')
  await writeText(target, text)
  return target
}

/** Count annotation files (used by the probe route). */
export async function countAnnotations() {
  try {
    const files = await readdir(join(dataRoot(), 'annotations'))
    return files.filter((name) => name.endsWith('.json')).length
  } catch {
    return 0
  }
}
