/**
 * Deterministic sentence segmentation for review anchors.
 *
 * The host assigns every sentence its stable id, so the client and the agent
 * tools always talk about the same anchor. That means the splitter must be
 * pure and stable: same text in, same boundaries out, no locale-dependent
 * break iterator.
 *
 * Chinese first: a sentence ends at 。！？…； and the closers that follow it.
 * English `.` only counts when it looks like a real full stop (followed by
 * whitespace / end, not inside numbers, file names, initials or the common
 * abbreviations), so "v1.2" and "README.md" stay whole.
 */

const HARD_TERMINATORS = new Set(['。', '！', '？', '!', '?', '…', '；', ';'])
const CLOSERS = new Set(['”', '’', '"', "'", '）', ')', '》', '】', '」', '』', '］', ']', '〉', '｝', '}'])
const SOFT_TERMINATORS = new Set(['，', ',', '、', '：', ':', '—'])
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'no', 'fig', 'eq', 'ref', 'eg', 'ie', 'etc', 'al', 'inc', 'ltd', 'co', 'corp', 'approx', 'dept', 'est', 'min', 'max', 'vol', 'pp', 'p'])

/** Very long runs (e.g. PDF paragraphs with no punctuation) are split softly. */
const MAX_SENTENCE_CHARS = 260
/** Soft punctuation only splits once a piece is reasonably long. */
const MIN_SOFT_PIECE_CHARS = 24

/**
 * Split one block of text into sentences with offsets into `text`.
 * @param {string} text - block text (may contain newlines).
 * @returns {{text: string, start: number, end: number}[]} trimmed sentences.
 */
export function splitSentences(text) {
  const src = String(text ?? '').replace(/\r\n?/gu, '\n')
  const raw = []
  let start = 0
  let i = 0

  /** Close the current raw sentence at `endExclusive` and trim its edges. */
  const push = (endExclusive) => {
    const segment = src.slice(start, endExclusive)
    const leading = segment.length - segment.trimStart().length
    const trailing = segment.length - segment.trimEnd().length
    const s = start + leading
    const e = endExclusive - trailing
    if (e > s) raw.push({ text: src.slice(s, e), start: s, end: e })
    start = endExclusive
  }

  while (i < src.length) {
    const ch = src[i]
    if (ch === '\n') {
      push(i)
      i += 1
      continue
    }
    if (HARD_TERMINATORS.has(ch)) {
      let j = i + 1
      // Repeated terminators (！？, ……, ?!) belong to the same sentence.
      while (j < src.length && (HARD_TERMINATORS.has(src[j]) || src[j] === '.')) j += 1
      while (j < src.length && CLOSERS.has(src[j])) j += 1
      push(j)
      i = j
      continue
    }
    if (ch === '.' && isSentenceDot(src, i)) {
      let j = i + 1
      while (j < src.length && (src[j] === '.' || CLOSERS.has(src[j]))) j += 1
      push(j)
      i = j
      continue
    }
    i += 1
  }
  if (start < src.length) push(src.length)

  const out = []
  for (const item of raw) {
    for (const piece of splitOverlong(item)) out.push(piece)
  }
  return out
}

/**
 * Whether the `.` at `index` terminates an English sentence.
 * @param {string} src - whole block text.
 * @param {number} index - index of the dot.
 */
export function isSentenceDot(src, index) {
  const prev = index > 0 ? src[index - 1] : ''
  const next = index + 1 < src.length ? src[index + 1] : ''
  // Ellipsis: "..." / "……"-style English runs are handled as one terminator.
  if (next === '.') {
    let j = index
    while (j < src.length && src[j] === '.') j += 1
    const after = j < src.length ? src[j] : ''
    return after === '' || /\s/u.test(after) || CLOSERS.has(after)
  }
  if (next === '') return true
  if (CLOSERS.has(next)) {
    const after = index + 2 < src.length ? src[index + 2] : ''
    return after === '' || /\s/u.test(after)
  }
  if (!/\s/u.test(next)) return false
  // Grab the word right before the dot.
  let k = index - 1
  while (k >= 0 && /[A-Za-z0-9'’\u2019]/u.test(src[k])) k -= 1
  const word = src.slice(k + 1, index)
  if (word === '') {
    // A dot after punctuation / at line start: "… ." is still a full stop,
    // but a leading ".5" or a list marker is not reached (whitespace next).
    return !/\d/u.test(prev)
  }
  if (/^\d+$/u.test(word)) {
    // "1. 引言" at a line start is a list marker, "3.14" never reaches here.
    const before = k >= 0 ? src[k] : ''
    return !(k < 0 || before === '\n' || /\s/u.test(before))
  }
  if (word.length === 1 && /[A-Z]/u.test(word)) return false
  const lower = word.toLowerCase().replace(/[.'’\u2019]/gu, '')
  if (ABBREVIATIONS.has(lower)) return false
  // "e.g" / "i.e" style leftovers.
  if (/^[a-z]$/u.test(lower) && word.length <= 2) return false
  return true
}

/**
 * Split an overlong raw sentence at soft punctuation (then hard, if needed).
 * @param {{text: string, start: number, end: number}} item - one raw sentence.
 * @returns {{text: string, start: number, end: number}[]} one or more pieces.
 */
function splitOverlong(item) {
  if (item.text.length <= MAX_SENTENCE_CHARS) return [item]
  const pieces = []
  const chars = item.text
  let segStart = 0
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]
    if (!SOFT_TERMINATORS.has(ch)) continue
    const piece = chars.slice(segStart, i + 1)
    if (piece.trim().length < MIN_SOFT_PIECE_CHARS) continue
    const offset = segStart
    pieces.push(buildPiece(chars, item.start, offset, i + 1))
    segStart = i + 1
  }
  if (segStart < chars.length) pieces.push(buildPiece(chars, item.start, segStart, chars.length))
  const out = []
  for (const piece of pieces) {
    if (piece.text.length <= MAX_SENTENCE_CHARS) {
      out.push(piece)
      continue
    }
    // No usable punctuation at all: hard-split so the UI can still anchor.
    for (let offset = 0; offset < piece.text.length; offset += MAX_SENTENCE_CHARS) {
      const text = piece.text.slice(offset, offset + MAX_SENTENCE_CHARS)
      const leading = text.length - text.trimStart().length
      out.push({ text: text.trim(), start: piece.start + offset + leading, end: piece.start + offset + text.length })
    }
  }
  return out.length > 0 ? out : [item]
}

function buildPiece(chars, baseStart, from, to) {
  const text = chars.slice(from, to)
  const leading = text.length - text.trimStart().length
  return { text: text.trim(), start: baseStart + from + leading, end: baseStart + to }
}

/**
 * Render a block's plain text into sentence entries with stable ids.
 * `start` / `end` are character offsets into the block text, so a sentence
 * annotation is just a range [start, end) — the same anchor arbitrary text
 * selections use.
 * @param {string} blockId - block id (`b0`, `b1`, ...).
 * @param {string} text - block text.
 * @returns {{id: string, index: number, text: string, start: number, end: number}[]} sentences.
 */
export function sentencesFor(blockId, text) {
  return splitSentences(text).map((sentence, index) => ({
    id: blockId + 's' + index,
    index,
    text: sentence.text,
    start: sentence.start,
    end: sentence.end,
  }))
}
