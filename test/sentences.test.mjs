/** Deterministic sentence segmentation assertions. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitSentences, sentencesFor } from '../lib/sentences.js'

test('Chinese terminators split and keep closers inside the sentence', () => {
  const parts = splitSentences('第一句。第二句！他说：“好。”然后走了……最后；收尾。')
  assert.deepEqual(parts.map((item) => item.text), ['第一句。', '第二句！', '他说：“好。”', '然后走了……', '最后；', '收尾。'])
})

test('English dots only count when they are real full stops', () => {
  const parts = splitSentences('Use React 18.3.1 for this. The value is v1.2. Then read README.md. It works!')
  assert.deepEqual(parts.map((item) => item.text), [
    'Use React 18.3.1 for this.',
    'The value is v1.2.',
    'Then read README.md.',
    'It works!',
  ])
})

test('newlines end sentences and empty lines produce nothing', () => {
  const parts = splitSentences('第一行没有标点\n第二行有标点。\n\n第三行')
  assert.deepEqual(parts.map((item) => item.text), ['第一行没有标点', '第二行有标点。', '第三行'])
})

test('overlong punctuation-free runs are split softly', () => {
  const long = '这是一个很长很长的句子'.repeat(40)
  const parts = splitSentences(long)
  assert.ok(parts.length > 1)
  assert.ok(parts.every((item) => item.text.length <= 260))
  assert.equal(parts.map((item) => item.text).join(''), long)
})

test('sentence ids are stable and offset into the block', () => {
  const sentences = sentencesFor('b7', '第一句。第二句。')
  assert.deepEqual(sentences.map((item) => item.id), ['b7s0', 'b7s1'])
  assert.equal(sentences[1].index, 1)
  assert.deepEqual([sentences[0].start, sentences[0].end], [0, 4])
  assert.deepEqual([sentences[1].start, sentences[1].end], [4, 8])
  assert.equal('第一句。第二句。'.slice(sentences[1].start, sentences[1].end), '第二句。')
})
