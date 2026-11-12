/** Format extraction assertions against the generated fixtures. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { FIXTURES, makeFixtures } from './make-fixtures.mjs'
import { extractArticle, renderArticleText } from '../lib/extract.js'

await makeFixtures()

/** All sentence texts of an article, in order. */
function allSentences(article) {
  return article.blocks.flatMap((block) => block.sentences.map((sentence) => sentence.text))
}

test('markdown: title, heading/list/code blocks and CJK-aware paragraphs', async () => {
  const article = await extractArticle(join(FIXTURES, 'sample.md'))
  assert.equal(article.format, 'markdown')
  assert.equal(article.title, '把批注变成修改')
  const kinds = new Set(article.blocks.map((block) => block.kind))
  for (const kind of ['heading', 'paragraph', 'list', 'code']) assert.ok(kinds.has(kind), 'missing block kind ' + kind)
  const first = article.blocks.find((block) => block.text.includes('这是一篇用来测试句子批注的短文'))
  assert.ok(first !== undefined)
  assert.equal(first.sentences.length, 3)
  const sentences = allSentences(article)
  assert.ok(sentences.some((text) => text === '它包含中文句号、问号与感叹号，也包含英文缩写 e.g. 和版本号 v1.2。'))
  // Soft-wrapped Markdown lines stay in one paragraph.
  const merged = article.blocks.find((block) => block.text.includes('第二行应当被合并进同一段'))
  assert.ok(merged.text.includes('也包含英文缩写'))
  // Inline syntax is stripped, words survive.
  assert.ok(!article.blocks.some((block) => block.text.includes('**')))
  assert.ok(article.blocks.some((block) => block.kind === 'list' && block.text.startsWith('第一条列表项')))
  // Every sentence carries block-text offsets so arbitrary selections can be
  // anchored on the same scale.
  for (const block of article.blocks) {
    for (const sentence of block.sentences) {
      assert.equal(block.text.slice(sentence.start, sentence.end), sentence.text)
    }
  }
})

test('markdown: long text renders with block anchors for the agent', async () => {
  const article = await extractArticle(join(FIXTURES, 'sample.md'))
  const text = renderArticleText(article)
  assert.match(text, /\[b0\] # 把批注变成修改/u)
  assert.match(text, /\[b\d+\] /u)
})

test('plain text: blank-line paragraphs', async () => {
  const article = await extractArticle(join(FIXTURES, 'sample.txt'))
  assert.equal(article.format, 'text')
  assert.equal(article.blocks.length, 2)
  assert.equal(article.blocks[0].sentences.length, 3)
  assert.equal(allSentences(article).at(-1), '第三段结束全文。')
})

test('docx: paragraphs and heading levels come out in order', async () => {
  const article = await extractArticle(join(FIXTURES, 'sample.docx'))
  assert.equal(article.format, 'docx')
  assert.equal(article.title, '文档标题')
  const texts = article.blocks.map((block) => block.text)
  assert.deepEqual(texts, ['文档标题', '这是 Word 文档的第一段。它有两个句子。', '第二段用来验证段落顺序，以及带“引号”的句子。', '第三段之后的列表项', '列表一', '列表二'])
  assert.equal(article.blocks[0].kind, 'heading')
  assert.equal(article.blocks[0].level, 1)
  assert.equal(article.blocks[3].level, 2)
  assert.equal(article.blocks[1].sentences.length, 2)
})

test('pptx: slides in presentation order with slide numbers', async () => {
  const article = await extractArticle(join(FIXTURES, 'sample.pptx'))
  assert.equal(article.format, 'pptx')
  assert.equal(article.blocks.length, 4)
  assert.deepEqual(article.blocks.map((block) => block.slide), [1, 1, 2, 2])
  assert.equal(article.blocks[0].text, '封面标题')
  assert.equal(article.blocks[2].text, '第二张幻灯片')
  assert.equal(article.title, '封面标题')
})

test('pdf: pypdf/pdftotext extraction when the machine has one', async (t) => {
  try {
    const article = await extractArticle(join(FIXTURES, 'sample.pdf'))
    assert.equal(article.format, 'pdf')
    assert.ok(article.blocks.length > 0)
    assert.ok(allSentences(article).some((text) => text.includes('Hello article review')))
  } catch (error) {
    if (String(error?.code) === 'pdf-unavailable') {
      t.skip('no PDF text extractor on this machine: ' + error.message)
      return
    }
    throw error
  }
})

test('legacy .doc is refused with a clear message', async () => {
  const fake = join(FIXTURES, 'legacy.doc')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(fake, 'not really a doc', 'utf8')
  await assert.rejects(() => extractArticle(fake), (error) => error.code === 'legacy-office')
})
