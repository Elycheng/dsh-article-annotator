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
const MAX_QUOTE_CHARS = 2000
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
    comments: state.comments.map((value) => normalizeComment(value)).filter((value) => value !== null),
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

/** Accept the range schema (v2) and the legacy sentence schema (v1). */
function isComment(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.blockId === 'string' &&
    typeof value.comment === 'string' &&
    (typeof value.quote === 'string' || typeof value.sentence === 'string')
  )
}

/**
 * Normalise a stored comment onto the range model.
 *
 * v2 comments anchor an arbitrary text selection with `{ start, end }`
 * character offsets into `block.text` plus the `quote` they cover. v1 comments
 * only had `{ sentenceIndex, sentence }`; their sentence fields are kept so
 * `anchorComments` can still resolve them, and they gain offsets on read.
 * @param {object} value - raw stored record.
 * @returns {object|null} the normalised record, or null when unusable.
 */
export function normalizeComment(value) {
  if (!isComment(value)) return null
  const quote = clip(String(value.quote ?? value.sentence ?? '').trim(), MAX_QUOTE_CHARS)
  if (quote === '') return null
  const hasRange = Number.isInteger(value.start) && Number.isInteger(value.end) && value.start >= 0 && value.end > value.start
  return {
    id: value.id,
    blockId: value.blockId,
    quote,
    comment: String(value.comment ?? ''),
    status: value.status === 'resolved' ? 'resolved' : 'open',
    ...(hasRange ? { start: value.start, end: value.end } : {}),
    ...(Number.isInteger(value.sentenceIndex) && value.sentenceIndex >= 0 ? { sentenceIndex: value.sentenceIndex } : {}),
    ...(typeof value.sentence === 'string' && value.sentence !== '' ? { sentence: clip(value.sentence, MAX_QUOTE_CHARS) } : {}),
    ...(typeof value.blockKind === 'string' ? { blockKind: value.blockKind } : {}),
    ...(Number.isInteger(value.page) ? { page: value.page } : {}),
    ...(Number.isInteger(value.slide) ? { slide: value.slide } : {}),
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
    ...(typeof value.agentReply === 'string' && value.agentReply !== '' ? { agentReply: value.agentReply } : {}),
  }
}

/**
 * Create or update one comment.
 * @param {string} absolutePath - article path.
 * @param {object} payload - `{ id?, blockId, start?, end?, quote, comment, blockKind?, page?, slide? }`.
 *   The legacy `{ sentenceIndex, sentence }` shape is accepted too.
 * @returns {Promise<{comment: object, state: object}>}
 */
export async function upsertComment(absolutePath, payload) {
  const blockId = typeof payload?.blockId === 'string' ? payload.blockId.trim() : ''
  const quote = clip(String(payload?.quote ?? payload?.sentence ?? '').trim(), MAX_QUOTE_CHARS)
  const comment = String(payload?.comment ?? '').trim()
  const start = Number.isInteger(payload?.start) ? Number(payload.start) : undefined
  const end = Number.isInteger(payload?.end) ? Number(payload.end) : undefined
  if (blockId === '') throw new ReviewError('bad-request', '批注缺少定位信息（blockId）。')
  if (quote === '') throw new ReviewError('bad-request', '批注缺少选中的文字（quote）。')
  if (start !== undefined || end !== undefined) {
    if (start === undefined || end === undefined || start < 0 || end <= start) {
      throw new ReviewError('bad-request', '批注范围不合法（start/end）。')
    }
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
    ...(start !== undefined && end !== undefined ? { start, end } : {}),
    ...(Number.isInteger(payload?.sentenceIndex) && payload.sentenceIndex >= 0 ? { sentenceIndex: payload.sentenceIndex } : {}),
    quote,
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

/** Punctuation ignored by the loosest text matcher. */
const LOOSE_PUNCTUATION = new Set(
  '。；;，,、！!？?…：:.—–-“”‘’""\'\'（）()《》〈〉【】[]{}'.split(''),
)

/**
 * Whitespace-normalised text plus a map from normalised index to the original
 * index, so a match position can be translated back into block offsets.
 * @param {string} text - source text.
 * @param {boolean} loose - also drop punctuation.
 * @returns {{normalized: string, map: number[]}}
 */
function normalizeWithMap(text, loose) {
  let normalized = ''
  const map = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === undefined) continue
    if (/\s/u.test(char) || char === '\u3000') continue
    if (loose && LOOSE_PUNCTUATION.has(char)) continue
    normalized += char
    map.push(index)
  }
  return { normalized, map }
}

/**
 * Find `quote` inside one block text: raw substring first, then ignoring
 * whitespace, then also ignoring punctuation. Returns block offsets.
 * @param {string} blockText - block text.
 * @param {string} quote - selected text.
 * @returns {{start: number, end: number}|null}
 */
function locateQuote(blockText, quote) {
  const text = String(blockText ?? '')
  const needle = String(quote ?? '')
  if (needle === '') return null
  const exact = text.indexOf(needle)
  if (exact >= 0) return { start: exact, end: exact + needle.length }
  for (const loose of [false, true]) {
    const haystack = normalizeWithMap(text, loose)
    const target = normalizeWithMap(needle, loose)
    if (target.normalized === '') continue
    const at = haystack.normalized.indexOf(target.normalized)
    if (at < 0) continue
    const start = haystack.map[at]
    const last = haystack.map[at + target.normalized.length - 1]
    if (start === undefined || last === undefined) continue
    return { start, end: last + 1 }
  }
  return null
}

/** Same text up to whitespace differences. */
function sameText(left, right) {
  return normalizeWithMap(String(left ?? ''), false).normalized === normalizeWithMap(String(right ?? ''), false).normalized
}

/** Character range of a legacy sentence comment inside its block. */
function legacySentenceRange(block, comment) {
  const index = Number(comment.sentenceIndex)
  const text = String(comment.sentence ?? comment.quote ?? '')
  if (!Number.isInteger(index) || text === '') return null
  const sentence = block.sentences[index]
  if (sentence !== undefined && sameText(sentence.text, text)) {
    const start = Number.isInteger(sentence.start) ? sentence.start : block.text.indexOf(sentence.text)
    return start >= 0 ? { start, end: start + sentence.text.length } : null
  }
  return locateQuote(block.text, text)
}

/** Index of the sentence containing `start` (for display only). */
function sentenceIndexAt(block, start) {
  let fallback = 0
  for (const sentence of block.sentences) {
    if (Number.isInteger(sentence.start) && Number.isInteger(sentence.end)) {
      if (start >= sentence.start && start < sentence.end) return sentence.index
    } else if (typeof sentence.text === 'string' && sentence.text !== '') {
      const at = block.text.indexOf(sentence.text)
      if (at >= 0 && start >= at && start < at + sentence.text.length) return sentence.index
    }
    if (Number.isInteger(sentence.index)) fallback = sentence.index
  }
  return fallback
}

/** Attach the current block and offsets to a resolved comment. */
function finishAnchored(comment, block, start, end) {
  const slice = block.text.slice(start, end)
  return {
    ...comment,
    blockId: block.id,
    start,
    end,
    quote: slice === '' ? comment.quote : slice,
    sentenceIndex: sentenceIndexAt(block, start),
    blockKind: block.kind,
    ...(block.page === undefined ? {} : { page: block.page }),
    ...(block.slide === undefined ? {} : { slide: block.slide }),
    orphaned: false,
  }
}

/**
 * Re-anchor comments onto the current article version.
 *
 * A comment whose stored offsets still cover the same text keeps its position.
 * After an edit, the quote is searched inside the original block (raw, then
 * whitespace-insensitive, then punctuation-insensitive), then across the whole
 * article; legacy sentence comments fall back to their sentence. A comment that
 * cannot be found is returned as `orphaned: true` — the UI keeps it visible so
 * the opinion is never silently lost.
 * @param {object} article - extracted article.
 * @param {object[]} comments - stored comments.
 * @returns {{comments: object[], orphaned: number, reanchored: number}}
 */
export function anchorComments(article, comments) {
  let orphaned = 0
  let reanchored = 0
  const byBlock = new Map(article.blocks.map((block) => [block.id, block]))
  const anchored = comments.map((raw) => {
    const comment = normalizeComment(raw)
    if (comment === null) return raw
    const block = byBlock.get(comment.blockId)
    if (block !== undefined) {
      const current = Number.isInteger(comment.start) && Number.isInteger(comment.end)
      if (current && comment.end <= block.text.length && sameText(block.text.slice(comment.start, comment.end), comment.quote)) {
        return finishAnchored(comment, block, comment.start, comment.end)
      }
      const found = locateQuote(block.text, comment.quote)
      if (found !== null) {
        reanchored += 1
        return finishAnchored(comment, block, found.start, found.end)
      }
      const legacy = legacySentenceRange(block, comment)
      if (legacy !== null) {
        reanchored += 1
        return finishAnchored(comment, block, legacy.start, legacy.end)
      }
    }
    for (const candidate of article.blocks) {
      const found = locateQuote(candidate.text, comment.quote)
      if (found !== null) {
        reanchored += 1
        return finishAnchored(comment, candidate, found.start, found.end)
      }
    }
    orphaned += 1
    return { ...comment, orphaned: true }
  })
  return { comments: anchored, orphaned, reanchored }
}

/**
 * Normalised comparison key: whitespace and full-width spaces are ignored.
 * Used by the style-rule dedupe (which additionally lowercases and drops
 * punctuation).
 */
export function normalizeKey(text) {
  return normalizeWithMap(String(text ?? ''), false).normalized
}

/**
 * Normalised key for a style rule: whitespace, full-width spaces and the
 * punctuation a rule may or may not carry are ignored, so "少用成语堆叠。" and
 * "少用成语堆叠" are the same rule.
 */
export function ruleKey(text) {
  return normalizeKey(text).toLowerCase().replace(/[。；;，,、！!？?…：:.\-—]/gu, '')
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
