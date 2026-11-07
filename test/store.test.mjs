/** Durable store: comments, re-anchoring, style memory, revisions, recents. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addStyleRule,
  anchorComments,
  articleKey,
  deleteComment,
  loadAnnotations,
  loadRecent,
  loadStyle,
  patchComment,
  recordRecent,
  removeStyleRule,
  upsertComment,
  writeRevision,
} from '../lib/store.js'

let counter = 0
async function tempHome() {
  counter += 1
  const dir = await mkdtemp(join(tmpdir(), 'article-annotator-store-' + counter + '-'))
  process.env.DSH_HOME = dir
  return dir
}

function fakeArticle(blocks) {
  return { blocks }
}

test('comments round-trip and update in place', async () => {
  const home = await tempHome()
  const article = join(home, 'a.md')
  const first = await upsertComment(article, { blockId: 'b0', sentenceIndex: 0, sentence: '第一句。', comment: '太啰嗦' })
  assert.match(first.comment.id, /^c/u)
  assert.equal(first.state.comments.length, 1)
  const second = await upsertComment(article, { blockId: 'b1', sentenceIndex: 1, sentence: '第二句。', comment: '还行' })
  assert.equal(second.state.comments.length, 2)
  const updated = await upsertComment(article, { id: first.comment.id, blockId: 'b0', sentenceIndex: 0, sentence: '第一句。', comment: '换成更克制的说法' })
  assert.equal(updated.state.comments.length, 2)
  assert.equal(updated.comment.comment, '换成更克制的说法')
  const loaded = await loadAnnotations(article)
  assert.equal(loaded.comments.length, 2)
  await deleteComment(article, first.comment.id)
  assert.equal((await loadAnnotations(article)).comments.length, 1)
  assert.match(articleKey(article), /^[0-9a-f]{40}$/u)
})

test('comments reject empty / oversized input', async () => {
  const home = await tempHome()
  const article = join(home, 'b.md')
  await assert.rejects(() => upsertComment(article, { blockId: 'b0', sentenceIndex: 0, sentence: 'x', comment: '  ' }), /不能为空/u)
  await assert.rejects(() => upsertComment(article, { blockId: 'b0', sentenceIndex: 0, sentence: 'x', comment: 'x'.repeat(5000) }), /超过/u)
})

test('anchorComments keeps, re-anchors and orphans correctly', async () => {
  const article = fakeArticle([
    { id: 'b0', kind: 'paragraph', sentences: [{ id: 'b0s0', index: 0, text: '甲。' }, { id: 'b0s1', index: 1, text: '乙。' }] },
    { id: 'b1', kind: 'paragraph', sentences: [{ id: 'b1s0', index: 0, text: '丙。' }] },
  ])
  const comments = [
    { id: 'c1', blockId: 'b0', sentenceIndex: 1, sentence: '乙。', comment: 'ok' },
    // Position drifted but the sentence still exists in another block.
    { id: 'c2', blockId: 'b9', sentenceIndex: 0, sentence: '丙。', comment: 'moved' },
    { id: 'c3', blockId: 'b0', sentenceIndex: 0, sentence: '已被删掉的句子。', comment: 'lost' },
  ]
  const result = anchorComments(article, comments)
  assert.equal(result.reanchored, 1)
  assert.equal(result.orphaned, 1)
  assert.equal(result.comments[0].orphaned, false)
  assert.deepEqual([result.comments[1].blockId, result.comments[1].sentenceIndex], ['b1', 0])
  assert.equal(result.comments[2].orphaned, true)
})

test('status patch and delete work through the store', async () => {
  const home = await tempHome()
  const article = join(home, 'c.md')
  const saved = await upsertComment(article, { blockId: 'b0', sentenceIndex: 0, sentence: '句子。', comment: '改' })
  await patchComment(article, saved.comment.id, { status: 'resolved' })
  const state = await loadAnnotations(article)
  assert.equal(state.comments[0].status, 'resolved')
  await assert.rejects(() => patchComment(article, 'nope', {}), /找不到/u)
})

test('style memory dedupes normalised rules and removes by id', async () => {
  await tempHome()
  const one = await addStyleRule({ rule: '少用四字成语堆叠', tags: ['措辞'] })
  assert.equal(one.added, true)
  const duplicate = await addStyleRule({ rule: '  少用四字成语堆叠。 ' })
  assert.equal(duplicate.added, false)
  const two = await addStyleRule({ rule: '结尾不要总结式拔高。', evidence: '批注 c1' })
  assert.equal(two.total, 2)
  const state = await loadStyle()
  assert.deepEqual(state.rules.map((rule) => rule.rule), ['少用四字成语堆叠', '结尾不要总结式拔高。'])
  await removeStyleRule(state.rules[0].id)
  assert.equal((await loadStyle()).rules.length, 1)
})

test('revision is written next to the source and never overwrites it', async () => {
  const home = await tempHome()
  const source = join(home, 'report.docx')
  await writeFile(source, 'fake docx bytes', 'utf8')
  const target = await writeRevision(source, '# 修订稿\n\n新的正文。')
  assert.equal(target, join(home, 'report.revised.md'))
  assert.match(await readFile(target, 'utf8'), /新的正文/u)
  assert.equal(await readFile(source, 'utf8'), 'fake docx bytes')
})

test('recent list dedupes and records the last article per session', async () => {
  const home = await tempHome()
  const first = join(home, 'x.md')
  const second = join(home, 'y.md')
  await recordRecent({ absolutePath: first, file: 'x.md', title: 'x', format: 'markdown', sessionId: 's1' })
  await recordRecent({ absolutePath: second, file: 'y.md', title: 'y', format: 'markdown', sessionId: 's1' })
  await recordRecent({ absolutePath: first, file: 'x.md', title: 'x', format: 'markdown', sessionId: 's2' })
  const state = await loadRecent()
  assert.deepEqual(state.items.map((item) => item.absolutePath), [first, second])
})
