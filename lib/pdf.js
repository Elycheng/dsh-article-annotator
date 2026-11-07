/**
 * PDF text extraction for the host half.
 *
 * PDF is the one article format Node cannot read with built-ins, so the
 * extractor shells out and keeps the plugin dependency-free:
 *
 *   1. `pypdf` through the machine's Python (the common case on this box),
 *   2. `pdftotext` (poppler) when Python is unavailable,
 *   3. otherwise a clean `pdf-unavailable` error — the tab then tells the
 *      reader to inspect the file in DSH's native PDF preview instead.
 *
 * The child process is spawned without a shell; the file path travels as one
 * argv element, never as a command string.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { statArticle, ReviewError } from './util.js'

const execFileAsync = promisify(execFile)

const PY_SCRIPT = [
  'import sys, json',
  'try:',
  '    from pypdf import PdfReader',
  'except Exception as exc:',
  '    print(json.dumps({"ok": False, "error": "pypdf missing: " + str(exc)}))',
  '    sys.exit(0)',
  'try:',
  '    reader = PdfReader(sys.argv[1])',
  'except Exception as exc:',
  '    print(json.dumps({"ok": False, "error": "cannot open pdf: " + str(exc)}))',
  '    sys.exit(0)',
  'pages = []',
  'try:',
  '    meta = reader.metadata or {}',
  '    title = meta.get("/Title") or ""',
  'except Exception:',
  '    title = ""',
  'for index, page in enumerate(reader.pages):',
  '    try:',
  '        text = page.extract_text() or ""',
  '    except Exception as exc:',
  '        text = ""',
  '    pages.append({"page": index + 1, "text": text})',
  'print(json.dumps({"ok": True, "title": title, "pages": pages}, ensure_ascii=False))',
].join('\n')

/** Python candidates tried in order. */
const PYTHON_COMMANDS = ['python', 'py', 'python3']
/** Cache of the first Python command that answered. */
let pythonCommand

/**
 * Extract per-page text from a PDF.
 * @param {string} absolutePath - PDF file path.
 * @param {number} maxBytes - size cap in bytes.
 * @returns {Promise<{title: string, pages: {page: number, text: string}[], tool: string}>}
 */
export async function extractPdf(absolutePath, maxBytes) {
  await statArticle(absolutePath, maxBytes)
  const available = await findPython()
  if (available !== null) {
    try {
      const { stdout } = await execFileAsync(available.command, [...available.prefix, '-c', PY_SCRIPT, absolutePath], {
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      })
      const parsed = parsePythonOutput(stdout)
      if (parsed.ok) return { title: parsed.title, pages: parsed.pages, tool: 'pypdf' }
      throw new ReviewError('pdf-unavailable', 'PDF 解析失败：' + parsed.error, 422)
    } catch (error) {
      if (error instanceof ReviewError) throw error
      // A broken Python run falls through to pdftotext.
    }
  }
  const pages = await extractWithPdftotext(absolutePath)
  if (pages !== null) return { title: '', pages, tool: 'pdftotext' }
  throw new ReviewError(
    'pdf-unavailable',
    '这台机器上没有可用的 PDF 文本提取器（需要 Python + pypdf 或 pdftotext）。可以先用 DSH 原生 PDF 预览查看原文件，或安装 pypdf 后再试。',
    503,
  )
}

/** Parse the helper script's JSON line; tolerate stray output. */
function parsePythonOutput(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue
    try {
      const value = JSON.parse(lines[i])
      if (value && typeof value === 'object' && value.ok === true && Array.isArray(value.pages)) {
        return { ok: true, title: typeof value.title === 'string' ? value.title : '', pages: normalizePages(value.pages) }
      }
      if (value && value.ok === false) return { ok: false, error: String(value.error ?? 'unknown error') }
    } catch {
      // Keep scanning.
    }
  }
  return { ok: false, error: 'Python 助手没有返回可解析的结果。' }
}

function normalizePages(pages) {
  return pages
    .filter((page) => page && typeof page === 'object' && typeof page.text === 'string')
    .map((page, index) => ({ page: Number.isFinite(page.page) ? Number(page.page) : index + 1, text: page.text }))
}

/** Find a Python command that can import pypdf. */
async function findPython() {
  if (pythonCommand !== undefined) return pythonCommand
  for (const command of PYTHON_COMMANDS) {
    try {
      const { stdout } = await execFileAsync(command, ['-c', 'import sys; print(sys.version_info[0])'], {
        timeout: 5_000,
        windowsHide: true,
        encoding: 'utf8',
      })
      if (String(stdout).trim().startsWith('3')) {
        const probe = await execFileAsync(command, ['-c', 'import pypdf; print(pypdf.__version__)'], {
          timeout: 10_000,
          windowsHide: true,
          encoding: 'utf8',
        })
        if (String(probe.stdout).trim() !== '') {
          pythonCommand = { command, prefix: [] }
          return pythonCommand
        }
      }
    } catch {
      // Try the next candidate.
    }
    if (command === 'py') {
      // `py -3 -c ...` is the Windows launcher form.
      try {
        const { stdout } = await execFileAsync('py', ['-3', '-c', 'import pypdf; print(pypdf.__version__)'], {
          timeout: 10_000,
          windowsHide: true,
          encoding: 'utf8',
        })
        if (String(stdout).trim() !== '') {
          pythonCommand = { command: 'py', prefix: ['-3'] }
          return pythonCommand
        }
      } catch {
        // Try the next candidate.
      }
    }
  }
  pythonCommand = { command: null, prefix: [] }
  return null
}

/** Poppler fallback: `pdftotext -layout file -`, pages separated by form feeds. */
async function extractWithPdftotext(absolutePath) {
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-layout', '-enc', 'UTF-8', absolutePath, '-'], {
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    })
    const chunks = String(stdout).split('\f')
    if (chunks.length > 0 && chunks[chunks.length - 1].trim() === '') chunks.pop()
    return chunks.map((text, index) => ({ page: index + 1, text }))
  } catch {
    return null
  }
}
