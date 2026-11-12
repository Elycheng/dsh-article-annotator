/**
 * Article extraction: turn Markdown / TXT / DOCX / PPTX / PDF into the
 * normalised block + sentence model the reviewer and the agent tools share.
 *
 * The model is deliberately lossless enough for annotation and small enough
 * for the browser:
 *
 *   article = { title, format, blocks: [{ id, kind, text, level?, page?, slide?, sentences }] }
 *
 * Block ids (`b0`, `b1`, ...) and sentence ids (`b3s2`) are positional, so
 * they are stable for a given version of a document. Annotations additionally
 * store the sentence text; the store re-anchors comments when a revision
 * shifts the positions.
 */
import { readFile } from 'node:fs/promises'
import { basename, extname, relative } from 'node:path'
import { readZip } from './zip.js'
import { sentencesFor } from './sentences.js'
import { extractPdf } from './pdf.js'
import { ReviewError, decodeText, statArticle, toPosix } from './util.js'

const MAX_CODE_LINES = 400

/**
 * Extract one article file.
 * @param {string} absolutePath - absolute file path.
 * @param {object} [options] - `{ maxBytes, maxBlocks }`.
 * @returns {Promise<object>} the normalised article.
 */
export async function extractArticle(absolutePath, options = {}) {
  const ext = extname(absolutePath).toLowerCase()
  const meta = await statArticle(absolutePath, options.maxBytes)
  if (ext === '.pdf') {
    const pdf = await extractPdf(absolutePath, options.maxBytes)
    const rawBlocks = pdfPagesToBlocks(pdf.pages)
    const blocks = finalizeBlocks(rawBlocks, options)
    return buildArticle({ absolutePath, ext, format: 'pdf', title: pdf.title || titleFromName(absolutePath), blocks, warnings: [], tool: pdf.tool })
  }
  const buffer = await readFile(absolutePath)
  if (ext === '.docx') {
    const raw = extractDocx(buffer)
    const blocks = finalizeBlocks(raw.blocks, options)
    return buildArticle({ absolutePath, ext, format: 'docx', title: raw.title || titleFromName(absolutePath), blocks, warnings: raw.warnings })
  }
  if (ext === '.pptx') {
    const raw = extractPptx(buffer)
    const blocks = finalizeBlocks(raw.blocks, options)
    return buildArticle({ absolutePath, ext, format: 'pptx', title: raw.title || titleFromName(absolutePath), blocks, warnings: raw.warnings })
  }
  const text = decodeText(buffer)
  const markdown = ext === '.md' || ext === '.markdown' || ext === '.mdown'
  const raw = markdown ? extractMarkdown(text) : extractPlainText(text)
  const blocks = finalizeBlocks(raw.blocks, options)
  return buildArticle({ absolutePath, ext, format: markdown ? 'markdown' : 'text', title: raw.title || titleFromName(absolutePath), blocks, warnings: raw.warnings })
}

/** Build the wire article (path fields are added by the caller). */
function buildArticle({ absolutePath, ext, format, title, blocks, warnings, tool }) {
  let sentenceCount = 0
  let chars = 0
  for (const block of blocks) {
    sentenceCount += block.sentences.length
    chars += block.text.length
  }
  return {
    absolutePath,
    name: basename(absolutePath),
    ext,
    format,
    title: String(title ?? '').trim() || basename(absolutePath),
    blocks,
    stats: { blocks: blocks.length, sentences: sentenceCount, chars, bytes: 0 },
    warnings,
    ...(tool === undefined ? {} : { extractor: tool }),
  }
}

function titleFromName(absolutePath) {
  const name = basename(absolutePath)
  const ext = extname(name)
  return ext === '' ? name : name.slice(0, -ext.length)
}

/* ------------------------------------------------------------------ *
 * Markdown / plain text
 * ------------------------------------------------------------------ */

/**
 * Parse Markdown into paragraph-ish blocks. Rendering Markdown is not the
 * point here — a sentence anchor needs readable text with paragraph and
 * heading boundaries, not a full CommonMark AST.
 * @param {string} source - file text.
 */
export function extractMarkdown(source) {
  const warnings = []
  let text = String(source ?? '').replace(/\r\n?/gu, '\n')
  let title = ''
  const front = takeFrontmatter(text)
  if (front !== null) {
    text = front.body
    const match = /^title\s*:\s*(.+)$/imu.exec(front.yaml)
    if (match !== null) title = unquote(match[1].trim())
  }
  const lines = text.split('\n')
  const blocks = []
  let paragraph = []
  let listItem = null
  let quote = []
  let fence = null
  let code = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', text: joinSoftLines(paragraph) })
    paragraph = []
  }
  const flushList = () => {
    if (listItem !== null) {
      blocks.push({ kind: 'list', text: listItem })
      listItem = null
    }
  }
  const flushQuote = () => {
    if (quote.length === 0) return
    blocks.push({ kind: 'paragraph', text: joinSoftLines(quote) })
    quote = []
  }
  const flushAll = () => {
    flushParagraph()
    flushList()
    flushQuote()
  }

  for (const line of lines) {
    if (fence !== null) {
      const close = new RegExp('^\\s{0,3}' + fence.char + '{' + fence.length + ',}\\s*$', 'u')
      if (close.test(line)) {
        if (code.length > 0) blocks.push({ kind: 'code', text: code.join('\n') })
        code = []
        fence = null
      } else {
        code.push(line)
      }
      continue
    }
    const fenceOpen = /^\s{0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
    if (fenceOpen !== null) {
      flushAll()
      fence = { char: fenceOpen[1][0], length: fenceOpen[1].length }
      continue
    }
    if (line.trim() === '') {
      flushAll()
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/u.exec(line)
    if (heading !== null) {
      flushAll()
      blocks.push({ kind: 'heading', level: heading[1].length, text: cleanInline(heading[2]) })
      continue
    }
    const setext = /^\s{0,3}(=+|-{2,})\s*$/u.exec(line)
    if (setext !== null && paragraph.length === 1 && listItem === null && quote.length === 0) {
      const level = setext[1][0] === '=' ? 1 : 2
      blocks.push({ kind: 'heading', level, text: cleanInline(paragraph[0]) })
      paragraph = []
      continue
    }
    const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u.exec(line)
    if (list !== null) {
      flushParagraph()
      flushQuote()
      if (listItem !== null) blocks.push({ kind: 'list', text: listItem })
      listItem = cleanInline(list[3])
      continue
    }
    if (listItem !== null && /^\s{2,}\S/u.test(line)) {
      listItem = joinSoftLines([listItem, cleanInline(line.trim())])
      continue
    }
    flushList()
    const quoteLine = /^\s{0,3}>\s?(.*)$/u.exec(line)
    if (quoteLine !== null) {
      quote.push(cleanInline(quoteLine[1]))
      continue
    }
    flushQuote()
    if (/^\s*\|.*\|\s*$/u.test(line)) {
      flushParagraph()
      if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/u.test(line)) continue
      blocks.push({ kind: 'table', text: cleanInline(line.replace(/\|/gu, ' ')) })
      continue
    }
    if (/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/u.test(line)) {
      flushParagraph()
      continue
    }
    if (/^\s*<[^>]+>\s*$/u.test(line)) continue
    paragraph.push(cleanInline(line))
  }
  flushAll()
  if (fence !== null) {
    warnings.push('Markdown 代码围栏没有闭合，剩余内容按代码块处理。')
    if (code.length > 0) blocks.push({ kind: 'code', text: code.join('\n') })
  }
  return { title, blocks: blocks.filter((block) => block.text.trim() !== ''), warnings }
}

/** Plain .txt: blank-line paragraphs, no inline syntax. */
export function extractPlainText(source) {
  const text = String(source ?? '').replace(/\r\n?/gu, '\n')
  const blocks = []
  for (const chunk of text.split(/\n\s*\n/u)) {
    const body = chunk.trim()
    if (body !== '') blocks.push({ kind: 'paragraph', text: body })
  }
  return { title: '', blocks, warnings: [] }
}

/** Strip one pair of surrounding quotes from a frontmatter scalar. */
function unquote(value) {
  const text = String(value ?? '').trim()
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1)
  }
  return text
}

/** Strip frontmatter and return `{ yaml, body }`, or null when absent. */
function takeFrontmatter(text) {
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---', 3)
  if (end < 0) return null
  const after = text.slice(end + 4)
  if (after !== '' && !after.startsWith('\n')) return null
  return { yaml: text.slice(4, end), body: after.replace(/^\n/u, '') }
}

/** Remove inline Markdown syntax while keeping the words. */
export function cleanInline(input) {
  let text = String(input ?? '')
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/gu, '〔图：$1〕')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
  text = text.replace(/\[([^\]]*)\]\[[^\]]*\]/gu, '$1')
  text = text.replace(/`([^`\n]*)`/gu, '$1')
  text = text.replace(/\*\*([^*\n]+)\*\*/gu, '$1')
  text = text.replace(/__([^_\n]+)__/gu, '$1')
  text = text.replace(/\*([^*\n]+)\*/gu, '$1')
  text = text.replace(/(^|[\s([{（【])_([^_\n]+)_(?=[\s)\]】）]|$)/gu, '$1$2')
  text = text.replace(/<[^>]+>/gu, '')
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!>])/gu, '$1')
  text = decodeEntities(text)
  return text.replace(/\s+$/u, '').replace(/^\s+/u, '')
}

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&nbsp;/gu, ' ')
    .replace(/&mdash;/gu, '—')
    .replace(/&ndash;/gu, '–')
    .replace(/&hellip;/gu, '…')
    .replace(/&#(\d+);/gu, (_, code) => safeFromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
}

function safeFromCodePoint(code) {
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** Join Markdown soft line breaks: no space between CJK, a space elsewhere. */
function joinSoftLines(lines) {
  let out = ''
  for (const line of lines) {
    const next = String(line).trim()
    if (next === '') continue
    if (out === '') {
      out = next
      continue
    }
    out += needsSpace(out, next) ? ' ' : ''
    out += next
  }
  return out
}

function needsSpace(left, right) {
  const a = left[left.length - 1] ?? ''
  const b = right[0] ?? ''
  if (isCjk(a) || isCjk(b)) return false
  if (/[([{（【“‘]/u.test(a)) return false
  if (/[.,!?;:，。！？；：、）)\]】”’]/u.test(a)) return true
  return true
}

function isCjk(ch) {
  if (ch === '') return false
  const code = ch.codePointAt(0)
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xff00 && code <= 0xffef)
  )
}

/* ------------------------------------------------------------------ *
 * DOCX
 * ------------------------------------------------------------------ */

/**
 * Extract paragraphs from a .docx container (`word/document.xml`).
 * @param {Buffer} buffer - file bytes.
 */
export function extractDocx(buffer) {
  const entries = readZip(buffer)
  const document = entries.get('word/document.xml') ?? findEntry(entries, /^word\/document\d*\.xml$/u)
  if (document === undefined) throw new ReviewError('parse-failed', '这个 docx 里找不到 word/document.xml，文件可能已损坏。', 422)
  const xml = document.toString('utf8')
  const warnings = []
  const blocks = []
  let title = ''
  const paragraphPattern = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/gu
  let match
  while ((match = paragraphPattern.exec(xml)) !== null) {
    const inner = match[1]
    const text = docxParagraphText(inner)
    if (text.trim() === '') continue
    const level = docxHeadingLevel(inner)
    const listStyle = /<w:pStyle\s+w:val="([^"]+)"/u.exec(inner)
    const kind = level > 0 ? 'heading' : /<w:numPr[\s/>]/u.test(inner) || (listStyle !== null && /list/iu.test(listStyle[1])) ? 'list' : 'paragraph'
    if (kind === 'heading' && title === '') title = text.trim()
    blocks.push({ kind, text, ...(level > 0 ? { level: Math.min(6, level) } : {}) })
  }
  if (blocks.length === 0) warnings.push('这个 docx 没有可提取的正文文字（可能整篇都是图片或文本框）。')
  return { title, blocks, warnings }
}

function findEntry(entries, pattern) {
  for (const [name, value] of entries) {
    if (pattern.test(name)) return value
  }
  return undefined
}

/** Concatenate the visible runs of one `<w:p>` element. */
function docxParagraphText(inner) {
  let out = ''
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/gu
  let match
  while ((match = pattern.exec(inner)) !== null) {
    if (match[1] !== undefined) out += decodeXmlEntities(match[1])
    else if (match[2] !== undefined) out += '\t'
    else out += '\n'
  }
  return out.replace(/[ \t]+\n/gu, '\n').trim()
}

function docxHeadingLevel(inner) {
  const style = /<w:pStyle\s+w:val="([^"]+)"/u.exec(inner)
  if (style !== null) {
    const plain = style[1].toLowerCase()
    const heading = /^heading\s*(\d+)$/u.exec(plain)
    if (heading !== null) return Number(heading[1])
    if (plain === 'title') return 1
  }
  const outline = /<w:outlineLvl\s+w:val="(\d+)"/u.exec(inner)
  if (outline !== null) return Math.min(6, Number(outline[1]) + 1)
  return 0
}

function decodeXmlEntities(text) {
  return String(text)
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_, code) => safeFromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/gu, '&')
}

/* ------------------------------------------------------------------ *
 * PPTX
 * ------------------------------------------------------------------ */

/**
 * Extract per-slide paragraphs from a .pptx container.
 * @param {Buffer} buffer - file bytes.
 */
export function extractPptx(buffer) {
  const entries = readZip(buffer)
  const warnings = []
  const slides = pptxSlideOrder(entries)
  if (slides.length === 0) throw new ReviewError('parse-failed', '这个 pptx 里找不到幻灯片 XML，文件可能已损坏。', 422)
  const blocks = []
  let title = ''
  let slideNumber = 0
  for (const slidePath of slides) {
    const slide = entries.get(slidePath)
    if (slide === undefined) continue
    slideNumber += 1
    const xml = slide.toString('utf8')
    const paragraphs = []
    const pattern = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/gu
    let match
    while ((match = pattern.exec(xml)) !== null) {
      const text = pptxParagraphText(match[1])
      if (text.trim() !== '') paragraphs.push(text)
    }
    paragraphs.forEach((text, index) => {
      const isTitle = index === 0 && text.trim().length <= 80 && paragraphs.length > 1
      if (isTitle && title === '') title = text.trim()
      blocks.push({
        kind: isTitle ? 'heading' : 'paragraph',
        ...(isTitle ? { level: 2 } : {}),
        text,
        slide: slideNumber,
      })
    })
  }
  if (blocks.length === 0) warnings.push('这个 pptx 没有可提取的文字（可能整篇都是图片）。')
  return { title, blocks, warnings }
}

/** `ppt/slides/slideN.xml` in presentation order (rels first, numeric fallback). */
function pptxSlideOrder(entries) {
  const presentation = entries.get('ppt/presentation.xml')
  const rels = entries.get('ppt/_rels/presentation.xml.rels')
  if (presentation !== undefined && rels !== undefined) {
    const relMap = new Map()
    const relPattern = /<Relationship\s+[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/gu
    let match
    const relText = rels.toString('utf8')
    while ((match = relPattern.exec(relText)) !== null) relMap.set(match[1], match[2])
    const list = /<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/u.exec(presentation.toString('utf8'))
    if (list !== null) {
      const ordered = []
      const idPattern = /<p:sldId\s+[^>]*r:id="([^"]+)"[^>]*\/?>/gu
      let idMatch
      while ((idMatch = idPattern.exec(list[1])) !== null) {
        const target = relMap.get(idMatch[1])
        if (typeof target !== 'string') continue
        const clean = target.startsWith('/') ? target.slice(1) : 'ppt/' + target.replace(/^\.\//u, '')
        if (entries.has(clean)) ordered.push(clean)
      }
      if (ordered.length > 0) return ordered
    }
  }
  return [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort((a, b) => Number(/slide(\d+)\.xml/u.exec(a)[1]) - Number(/slide(\d+)\.xml/u.exec(b)[1]))
}

function pptxParagraphText(inner) {
  const parts = []
  const pattern = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\s*\/>/gu
  let match
  while ((match = pattern.exec(inner)) !== null) {
    if (match[1] !== undefined) parts.push(decodeXmlEntities(match[1]))
    else parts.push('\n')
  }
  return parts.join('').trim()
}

/* ------------------------------------------------------------------ *
 * PDF
 * ------------------------------------------------------------------ */

/** Turn extracted PDF pages into paragraph blocks with page anchors. */
export function pdfPagesToBlocks(pages) {
  const blocks = []
  for (const page of pages) {
    const text = normalisePdfText(page.text)
    if (text === '') continue
    for (const paragraph of splitPdfParagraphs(text)) {
      blocks.push({ kind: 'paragraph', text: paragraph, page: page.page })
    }
  }
  return blocks
}

function normalisePdfText(text) {
  return String(text ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\u0000/gu, '')
    .replace(/[ \t]+/gu, ' ')
    .replace(/ ?\n ?/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/** Paragraphs by blank lines; long paragraphs by line groups. */
function splitPdfParagraphs(text) {
  const raw = text.split(/\n{2,}/u).map((chunk) => joinPdfLines(chunk.split('\n'))).filter(Boolean)
  const out = []
  for (const paragraph of raw) {
    if (paragraph.length <= 600) {
      out.push(paragraph)
      continue
    }
    const lines = paragraph.split('\n')
    let buffer = ''
    for (const line of lines) {
      if (buffer !== '' && buffer.length + line.length > 500) {
        out.push(buffer)
        buffer = line
      } else {
        buffer = buffer === '' ? line : buffer + '\n' + line
      }
    }
    if (buffer !== '') out.push(buffer)
  }
  return out
}

/** Join PDF text lines: no space between CJK, a space between Latin words. */
function joinPdfLines(lines) {
  let out = ''
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    if (out === '') {
      out = line
      continue
    }
    const prev = out[out.length - 1]
    const next = line[0]
    if (isCjk(prev) || isCjk(next)) out += ''
    else if (/[A-Za-z]-$/u.test(out) && /^[a-z]/u.test(line)) out = out.slice(0, -1)
    else out += ' '
    out += line
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Common finalisation
 * ------------------------------------------------------------------ */

/**
 * Assign block/sentence ids and cap the article size.
 * @param {{kind?: string, text: string, level?: number, page?: number, slide?: number}[]} rawBlocks - extracted blocks.
 * @param {object} options - `{ maxBlocks }`.
 */
export function finalizeBlocks(rawBlocks, options = {}) {
  const maxBlocks = Number.isInteger(options.maxBlocks) ? Math.max(1, options.maxBlocks) : 1500
  const blocks = []
  for (const raw of rawBlocks) {
    if (blocks.length >= maxBlocks) break
    const kind = typeof raw.kind === 'string' ? raw.kind : 'paragraph'
    const text = String(raw.text ?? '').trim()
    if (text === '') continue
    const id = 'b' + blocks.length
    // Code blocks are capped per line; anchor offsets must be computed against
    // the text actually stored on the block, so truncate both together.
    const effectiveText = codeAwareText(kind, text)
    const sentences = sentencesFor(id, effectiveText)
    if (sentences.length === 0) continue
    blocks.push({
      id,
      kind,
      text: effectiveText,
      sentences,
      ...(Number.isInteger(raw.level) ? { level: raw.level } : {}),
      ...(Number.isInteger(raw.page) ? { page: raw.page } : {}),
      ...(Number.isInteger(raw.slide) ? { slide: raw.slide } : {}),
    })
  }
  return blocks
}

/** Code blocks are annotated per line; cap the line count to stay bounded. */
function codeAwareText(kind, text) {
  if (kind !== 'code') return text
  return text.split('\n').slice(0, MAX_CODE_LINES).join('\n')
}

/** Render the article as plain text the agent tools can read (with anchors). */
export function renderArticleText(article, options = {}) {
  const maxChars = Number.isInteger(options.maxChars) ? options.maxChars : 40000
  const lines = []
  let currentPage
  let currentSlide
  for (const block of article.blocks) {
    const prefix = []
    if (block.page !== undefined && block.page !== currentPage) {
      currentPage = block.page
      prefix.push('〔第 ' + block.page + ' 页〕')
    }
    if (block.slide !== undefined && block.slide !== currentSlide) {
      currentSlide = block.slide
      prefix.push('〔第 ' + block.slide + ' 张幻灯片〕')
    }
    const kind = block.kind === 'heading' ? '# ' : block.kind === 'list' ? '- ' : block.kind === 'table' ? '| ' : ''
    const label = '[' + block.id + ']'
    if (prefix.length > 0) lines.push(prefix.join(' '))
    if (block.kind === 'code') {
      lines.push(label + ' ```')
      for (const sentence of block.sentences) lines.push(sentence.text)
      lines.push('```')
    } else {
      lines.push(label + ' ' + kind + block.text)
    }
  }
  let text = lines.join('\n')
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（已截断，完整内容请用 article_review 工具查看分段信息）'
  return text
}

/** Path relative to `root` when inside it, else the absolute path (posix slashes). */
export function displayPath(root, absolutePath) {
  try {
    const rel = toPosix(relative(root, absolutePath))
    return rel === '' ? toPosix(absolutePath) : rel
  } catch {
    return toPosix(absolutePath)
  }
}
