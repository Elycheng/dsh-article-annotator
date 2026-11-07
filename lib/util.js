/**
 * Small shared helpers for the host half of dsh-article-annotator.
 *
 * Zero runtime dependencies: everything here is Node built-ins only, so the
 * plugin can be installed as a local `link:` bundle whose node_modules chain
 * never has to resolve a single @deepseek-ai package (the host services are
 * reached through `ctx` instead).
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

/** File extensions the reviewer can open and annotate. */
export const ARTICLE_EXTS = new Set(['.md', '.markdown', '.mdown', '.txt', '.docx', '.pptx', '.pdf'])
/** Historical binary Office formats: previewable natively but not annotatable. */
export const LEGACY_OFFICE_EXTS = new Set(['.doc', '.ppt'])
/** Directory names never scanned when listing the workspace articles. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.dsh', '.article-annotator', 'dist', 'build', 'out', 'target', 'coverage', '.cache', '.next', '.nuxt', '.venv', 'venv', '__pycache__'])

/** A request/validation error carrying an HTTP-ish code and status. */
export class ReviewError extends Error {
  /**
   * @param {string} code - stable machine code (`bad-request`, `not-found`, ...).
   * @param {string} message - human readable Chinese message shown in the tab.
   * @param {number} [status] - HTTP status used by the route layer.
   */
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'ReviewError'
    this.code = code
    this.status = status
  }
}

/**
 * Resolve a Cordis service, tolerating both the getter face and the property
 * face. Some host versions answer `ctx.get(name)` while the property is
 * `undefined`, and a few plugins only expose the property.
 * @param {object} ctx - Cordis context (plugin or injected sub-context).
 * @param {string} name - service name.
 * @returns {any} the service, or null.
 */
export function serviceOf(ctx, name) {
  if (ctx === null || ctx === undefined) return null
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get(name)
      if (viaGet !== undefined && viaGet !== null) return viaGet
    }
  } catch {
    // Fall through to the property form.
  }
  try {
    const value = ctx[name]
    return value === undefined ? null : value
  } catch {
    return null
  }
}

/** The DSH home directory (`$DSH_HOME`, else `~/.dsh`). */
export function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return resolve(env.trim())
  return join(homedir(), '.dsh')
}

/** Root directory of this plugin's durable data. */
export function dataRoot() {
  return join(dshHome(), 'article-annotator')
}

/** `sha1` hex of a string. */
export function sha1(text) {
  return createHash('sha1').update(String(text), 'utf8').digest('hex')
}

/** Normalise a path to forward slashes for display and wire payloads. */
export function toPosix(path) {
  return String(path).replace(/\\/g, '/')
}

/** Whether `child` is inside `parent` (both absolute). */
export function isWithin(parent, child) {
  const p = normalize(resolve(parent))
  const c = normalize(resolve(child))
  const rel = relative(p, c)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

/** Read + parse a JSON file, returning `fallback` when missing or corrupt. */
export async function readJson(file, fallback) {
  try {
    const text = await readFile(file, 'utf8')
    if (text.trim() === '') return fallback
    const value = JSON.parse(text)
    return value ?? fallback
  } catch {
    return fallback
  }
}

/** Read + parse a JSON file synchronously (prompt sections must be sync). */
export function readJsonSync(file, fallback) {
  try {
    const text = readFileSync(file, 'utf8')
    if (text.trim() === '') return fallback
    const value = JSON.parse(text)
    return value ?? fallback
  } catch {
    return fallback
  }
}

/** Atomically write a JSON file (mkdir -p, tmp file, rename). */
export async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp'
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
}

/** Atomically write a text file. */
export async function writeText(file, text) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp'
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

/** Truncate a string to at most `max` characters, appending an ellipsis. */
export function clip(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return value.slice(0, Math.max(0, max - 1)) + '…'
}

/** Collapse all whitespace runs into single spaces. */
export function oneLine(text) {
  return String(text ?? '').replace(/\s+/gu, ' ').trim()
}

/** Decode a UTF-8 / UTF-16 file buffer into text (BOM aware). */
export function decodeText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8')
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le')
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2))
    swapped.swap16?.()
    return swapped.toString('utf16le')
  }
  return buf.toString('utf8')
}

/**
 * Resolve the workspace directory of a session.
 *
 * Order: the live agent's committed working directory (tracks `cd`), then the
 * session header's immutable cwd, then the cold-header read through session
 * persistence, then the caller-provided client cwd.
 * @param {object} ctx - host context.
 * @param {string} sessionId - the session asking.
 * @param {string} [clientCwd] - optional client hint.
 * @returns {Promise<string>} an absolute directory.
 */
export async function resolveSessionCwd(ctx, sessionId, clientCwd) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (id !== '') {
    const agents = serviceOf(ctx, 'agents')
    try {
      const agent = typeof agents?.get === 'function' ? agents.get(id) : undefined
      if (agent?.session !== undefined) {
        const working = serviceOf(ctx, 'workingDirectory')
        if (typeof working?.get === 'function') {
          const cwd = working.get(agent.session)
          if (typeof cwd === 'string' && cwd !== '') return resolve(cwd)
        }
        const headerCwd = agent.session.header?.cwd
        if (typeof headerCwd === 'string' && headerCwd !== '') return resolve(headerCwd)
      }
    } catch {
      // Continue with the other faces.
    }
    const sessions = serviceOf(ctx, 'sessions')
    try {
      const session = typeof sessions?.get === 'function' ? sessions.get(id) : undefined
      const cwd = session?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') return resolve(cwd)
    } catch {
      // Continue.
    }
    const persistence = serviceOf(ctx, 'sessionPersistence')
    try {
      if (typeof persistence?.stat === 'function') {
        const snapshot = await persistence.stat(id)
        const cwd = snapshot?.header?.cwd
        if (typeof cwd === 'string' && cwd !== '') return resolve(cwd)
      }
    } catch {
      // Fall through to the client hint.
    }
  }
  if (typeof clientCwd === 'string' && clientCwd.trim() !== '') {
    return resolve(clientCwd.trim())
  }
  throw new ReviewError('no-cwd', '无法确定这个会话的工作目录，请在右侧栏里手动打开文件。', 409)
}

/**
 * Resolve a user-supplied article path against the session workspace.
 * Absolute paths are accepted (the native preview does the same); relative
 * paths are anchored at the session cwd.
 * @param {string} cwd - session workspace directory.
 * @param {string} raw - path from the client/tool.
 * @returns {string} absolute path.
 */
export function resolveArticlePath(cwd, raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') throw new ReviewError('bad-request', '缺少文件路径。')
  if (text.includes('\0')) throw new ReviewError('bad-request', '文件路径非法。')
  const absolute = isAbsolute(text) ? resolve(text) : resolve(cwd, text)
  return absolute
}

/**
 * Validate an existing article file. Returns metadata; throws ReviewError.
 * @param {string} absolutePath - absolute file path.
 * @param {number} maxBytes - size cap.
 */
export async function statArticle(absolutePath, maxBytes) {
  let info
  try {
    info = await stat(absolutePath)
  } catch {
    throw new ReviewError('not-found', '文件不存在：' + absolutePath, 404)
  }
  if (!info.isFile()) throw new ReviewError('bad-request', '这不是一个普通文件：' + absolutePath, 400)
  const ext = extname(absolutePath).toLowerCase()
  if (LEGACY_OFFICE_EXTS.has(ext)) {
    throw new ReviewError('legacy-office', '旧版 ' + ext + ' 无法直接做句子批注。请先用 DSH 的原生预览查看，或另存为 .docx / .pptx 后再批注。', 415)
  }
  if (!ARTICLE_EXTS.has(ext)) {
    throw new ReviewError('unsupported-type', '暂不支持这种文件类型（' + ext + '）。目前支持 Markdown / TXT / Word(docx) / PowerPoint(pptx) / PDF。', 415)
  }
  if (typeof maxBytes === 'number' && info.size > maxBytes) {
    throw new ReviewError('too-large', '文件超过批注大小上限（' + Math.round(maxBytes / 1024 / 1024) + ' MB）。', 413)
  }
  return { size: info.size, mtimeMs: info.mtimeMs, ext }
}

/** Recursively collect annotatable article files under `root`. */
export async function listArticles(root, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 4
  const limit = Number.isInteger(options.limit) ? options.limit : 500
  const out = []
  const walk = async (dir, depth) => {
    if (out.length >= limit || depth > maxDepth) return
    let entries
    try {
      entries = await readdirSafe(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit) return
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
        await walk(join(dir, entry.name), depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const ext = extname(entry.name).toLowerCase()
      if (!ARTICLE_EXTS.has(ext)) continue
      const absolute = join(dir, entry.name)
      let info
      try {
        info = await stat(absolute)
      } catch {
        continue
      }
      out.push({
        path: toPosix(relative(root, absolute)) || entry.name,
        absolutePath: absolute,
        name: entry.name,
        ext,
        size: info.size,
        mtimeMs: info.mtimeMs,
      })
    }
  }
  await walk(root, 0)
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

async function readdirSafe(dir) {
  const { readdir } = await import('node:fs/promises')
  return readdir(dir, { withFileTypes: true })
}

/** Convert a millisecond timestamp to an ISO string (never throws). */
export function iso(ms) {
  try {
    return new Date(ms).toISOString()
  } catch {
    return ''
  }
}
