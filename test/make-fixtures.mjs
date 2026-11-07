/**
 * Test fixtures: one small article per supported format, generated on the fly
 * so the repository carries no binary blobs and every fixture stays readable.
 *
 * DOCX/PPTX are real OOXML ZIP containers (deflated entries, CRC32), built by
 * the tiny writer below; the PDF is a hand-assembled one-page document with a
 * Helvetica text run, which pypdf extracts like a production PDF.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { deflateRawSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const FIXTURES = join(HERE, 'fixtures')

/* ------------------------------------------------------------------ *
 * ZIP writer (test-only)
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Write a ZIP archive (deflated entries).
 * @param {Record<string, string | Buffer>} files - name -> content.
 * @returns {Buffer} archive bytes.
 */
export function makeZip(files) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const compressed = deflateRawSync(data)
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0, 12) // date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    localParts.push(local, nameBytes, compressed)
    centralParts.push(central, nameBytes)
    offset += local.length + nameBytes.length + compressed.length
  }
  const centralBuffer = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralBuffer, eocd])
}

/* ------------------------------------------------------------------ *
 * Fixture content
 * ------------------------------------------------------------------ */

export const ARTICLE_MD = `---
title: 把批注变成修改
---

# 把批注变成修改

这是一篇用来测试句子批注的短文。它包含中文句号、问号与感叹号，也包含英文缩写 e.g. 和版本号 v1.2。
第二行应当被合并进同一段，因为 Markdown 的软换行不构成新句子。

## 一、为什么要在句子上批注

一句话改不改，取决于读者觉得哪里别扭。批注落在句子上，修改意见就落到了具体位置。
如果意见只留在对话框里，接手的模型就得自己猜是哪一句。

- 第一条列表项：批注要能定位到段落与句子。
- 第二条列表项：状态要能从待处理变成已解决。

\`\`\`js
const answer = 42
console.log(answer)
\`\`\`

## 二、风格记忆

反复出现的意见应当沉淀为风格规则。比如「少用四字成语堆叠」「结尾不要总结式拔高」。
这样下一次写作就能直接带上这些偏好。
`

export const ARTICLE_TXT = `第一段用作纯文本测试。它有两个句子。
第二段只有一句话。

第三段结束全文。
`

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

function docxParagraph(text, style) {
  const styleXml = style === undefined ? '' : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`
  return `<w:p>${styleXml}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
}

export const DOCX_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${docxParagraph('文档标题', 'Heading1')}
    ${docxParagraph('这是 Word 文档的第一段。它有两个句子。')}
    ${docxParagraph('第二段用来验证段落顺序，以及带“引号”的句子。')}
    ${docxParagraph('第三段之后的列表项', 'Heading2')}
    ${docxParagraph('列表一', 'ListParagraph')}
    ${docxParagraph('列表二', 'ListParagraph')}
  </w:body>
</w:document>`

const PPTX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`

const PPTX_ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`

const PPTX_PRESENTATION = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId1"/>
    <p:sldId id="257" r:id="rId2"/>
  </p:sldIdLst>
</p:presentation>`

const PPTX_PRESENTATION_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>`

function pptxSlide(paragraphs) {
  const body = paragraphs.map((text) => `<a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p>`).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>${body}</p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`
}

/**
 * A minimal one-page PDF with Helvetica text (ASCII only — the point is the
 * extraction path, not font embedding).
 * @param {string} text - ASCII text drawn on the page.
 * @returns {Buffer} PDF bytes.
 */
export function makePdf(text) {
  const objects = []
  const content = 'BT /F1 12 Tf 72 720 Td (' + text.replace(/[()\\]/gu, (ch) => '\\' + ch) + ') Tj ET'
  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>')
  objects.push('<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' + content + '\nendstream')
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(body))
    body += i + 1 + ' 0 obj\n' + objects[i] + '\nendobj\n'
  }
  const xrefOffset = Buffer.byteLength(body)
  body += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n'
  for (let i = 1; i <= objects.length; i += 1) {
    body += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
  }
  body += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF\n'
  return Buffer.from(body, 'utf8')
}

function escapeXml(text) {
  return String(text).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/** Regenerate every fixture under test/fixtures. */
export async function makeFixtures() {
  await mkdir(FIXTURES, { recursive: true })
  await writeFile(join(FIXTURES, 'sample.md'), ARTICLE_MD, 'utf8')
  await writeFile(join(FIXTURES, 'sample.txt'), ARTICLE_TXT, 'utf8')
  const docx = makeZip({
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': ROOT_RELS,
    'word/document.xml': DOCX_XML,
  })
  await writeFile(join(FIXTURES, 'sample.docx'), docx)
  const pptx = makeZip({
    '[Content_Types].xml': PPTX_CONTENT_TYPES,
    '_rels/.rels': PPTX_ROOT_RELS,
    'ppt/presentation.xml': PPTX_PRESENTATION,
    'ppt/_rels/presentation.xml.rels': PPTX_PRESENTATION_RELS,
    'ppt/slides/slide1.xml': pptxSlide(['封面标题', '这是第一张幻灯片的第一段。它有两个句子。']),
    'ppt/slides/slide2.xml': pptxSlide(['第二张幻灯片', '第二页的正文内容。']),
  })
  await writeFile(join(FIXTURES, 'sample.pptx'), pptx)
  await writeFile(join(FIXTURES, 'sample.pdf'), makePdf('Hello article review. This is sentence two.'))
  return FIXTURES
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = await makeFixtures()
  console.log('fixtures written to ' + dir)
}
