/**
 * Minimal, dependency-free ZIP reader used to open OOXML documents
 * (.docx / .pptx are ZIP containers of XML parts).
 *
 * Only what the extractor needs: the central directory, stored (method 0) and
 * deflated (method 8) entries. Sizes come from the central directory, so
 * entries whose local header carries zeroed sizes (data-descriptor streams,
 * flag bit 3) still open correctly. ZIP64 is rejected explicitly instead of
 * silently returning garbage.
 */
import { inflateRawSync } from 'node:zlib'

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
const EOCD_MIN = 22
const MAX_COMMENT = 0xffff

/**
 * Read every entry of a ZIP buffer.
 * @param {Buffer} buffer - whole archive bytes.
 * @returns {Map<string, Buffer>} entry name -> uncompressed bytes.
 */
export function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const eocd = findEocd(buf)
  if (eocd < 0) throw new ZipError('不是有效的 ZIP 容器（找不到中央目录）。')
  const count = buf.readUInt16LE(eocd + 10)
  const directoryOffset = buf.readUInt32LE(eocd + 16)
  if (directoryOffset === 0xffffffff || count === 0xffff) {
    throw new ZipError('暂不支持 ZIP64 容器。')
  }
  const entries = new Map()
  let cursor = directoryOffset
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > buf.length) throw new ZipError('ZIP 中央目录损坏。')
    if (buf.readUInt32LE(cursor) !== SIG_CENTRAL) throw new ZipError('ZIP 中央目录条目损坏。')
    const method = buf.readUInt16LE(cursor + 10)
    const compressedSize = buf.readUInt32LE(cursor + 20)
    const uncompressedSize = buf.readUInt32LE(cursor + 24)
    const nameLength = buf.readUInt16LE(cursor + 28)
    const extraLength = buf.readUInt16LE(cursor + 30)
    const commentLength = buf.readUInt16LE(cursor + 32)
    const localOffset = buf.readUInt32LE(cursor + 42)
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    cursor += 46 + nameLength + extraLength + commentLength
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError('暂不支持 ZIP64 条目。')
    }
    entries.set(name, readEntry(buf, localOffset, method, compressedSize, uncompressedSize))
  }
  return entries
}

/**
 * Read one entry's bytes from its local header offset.
 * @param {Buffer} buf - archive.
 * @param {number} offset - local header offset.
 * @param {number} method - compression method.
 * @param {number} compressedSize - bytes after the local header data start.
 * @param {number} uncompressedSize - expected output bytes.
 */
function readEntry(buf, offset, method, compressedSize, uncompressedSize) {
  if (offset + 30 > buf.length || buf.readUInt32LE(offset) !== SIG_LOCAL) {
    throw new ZipError('ZIP 本地文件头损坏。')
  }
  const nameLength = buf.readUInt16LE(offset + 26)
  const extraLength = buf.readUInt16LE(offset + 28)
  const start = offset + 30 + nameLength + extraLength
  const end = start + compressedSize
  if (end > buf.length) throw new ZipError('ZIP 条目数据越界。')
  const raw = buf.subarray(start, end)
  if (method === 0) return Buffer.from(raw)
  if (method === 8) {
    try {
      return inflateRawSync(raw)
    } catch (error) {
      throw new ZipError('ZIP 条目解压失败：' + String(error?.message ?? error))
    }
  }
  throw new ZipError('不支持的 ZIP 压缩方法 ' + method + '。')
}

/** Locate the end-of-central-directory record. */
function findEocd(buf) {
  if (buf.length < EOCD_MIN) return -1
  const lower = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT)
  for (let i = buf.length - EOCD_MIN; i >= lower; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  return -1
}

/** A malformed container. */
export class ZipError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ZipError'
  }
}
