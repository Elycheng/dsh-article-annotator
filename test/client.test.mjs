/** Browser-half smoke test: load the built bundle in a stubbed DOM and run its registration path. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'lib', 'client.js')

/** Load the client bundle with the loader/module/document shims. */
async function loadBundle() {
  const code = await readFile(BUNDLE, 'utf8')
  const captured = { definition: null }
  const created = { styles: [], elements: [] }
  const document = {
    querySelector: () => null,
    createElement: (tag) => {
      const element = {
        tagName: String(tag).toUpperCase(),
        dataset: {},
        style: {},
        textContent: '',
        className: '',
        attributes: {},
        setAttribute(name, value) {
          element.attributes[name] = value
        },
        appendChild() {},
        remove() {},
      }
      created.elements.push(element)
      return element
    },
    head: { appendChild: (element) => created.styles.push(element) },
    body: { appendChild() {}, removeChild() {} },
    getElementById: () => null,
  }
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (callback) => callback,
    useRef: (initial) => ({ current: initial }),
    Fragment: 'Fragment',
  }
  fakeReact.default = fakeReact
  const sandbox = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async () => {
      throw new Error('fetch not expected')
    },
    navigator: {},
    Blob: class {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    document,
    window: {
      __ModuleLoader__: {
        load(definition) {
          captured.definition = definition
        },
      },
      addEventListener() {},
      removeEventListener() {},
      innerWidth: 1200,
      innerHeight: 900,
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'client.js' })
  assert.ok(captured.definition !== null, 'bundle must call window.__ModuleLoader__.load')
  const requireShim = (specifier) => {
    if (specifier === 'react') return fakeReact
    throw new Error('unexpected require: ' + specifier)
  }
  const exports = captured.definition.factory(requireShim)
  return { definition: captured.definition, exports, document, created, sandbox }
}

test('bundle registers one factory under the package id', async () => {
  const { definition } = await loadBundle()
  assert.equal(definition.id, 'dsh-article-annotator')
})

test('apply registers a right-sidebar page type, body and title', async () => {
  const { exports, created } = await loadBundle()
  assert.equal(typeof exports.apply, 'function')
  assert.equal(JSON.stringify(exports.inject), JSON.stringify(['slots']))
  const registered = { types: [], slots: [] }
  const hostCtx = {
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    sidebarRightTabs: {
      register(descriptor) {
        registered.types.push(descriptor)
        return () => {}
      },
    },
    slots: {
      inject(name, fn) {
        return fn()
      },
      register(descriptor, component) {
        registered.slots.push({ descriptor, component })
        return () => {}
      },
    },
  }
  const ctx = {
    get: () => null,
    inject: (names, callback) => {
      callback(hostCtx)
    },
  }
  exports.apply(ctx)
  assert.equal(registered.types.length, 1)
  assert.equal(registered.types[0].id, 'dsh-article-annotator/main')
  assert.equal(registered.types[0].kind, 'article-annotator')
  assert.equal(typeof registered.types[0].title, 'function')
  assert.equal(registered.types[0].title(), '文稿批注')
  assert.equal(registered.types[0].guide.length, 1)
  assert.equal(registered.slots.length, 2)
  const body = registered.slots.find((entry) => entry.descriptor.name === 'sidebar.right.pane.tab')
  assert.ok(body !== undefined)
  assert.equal(body.descriptor.key, 'dsh-article-annotator/main')
  assert.equal(typeof body.component, 'function')
  assert.equal(JSON.stringify(body.descriptor.inject('session-x')), JSON.stringify({ sessionId: 'session-x' }))
  assert.ok(created.styles.some((element) => element.tagName === 'STYLE' && element.dataset.plugin === 'dsh-article-annotator'))
})

test('review message lists every open comment with id, location and the tool contract', async () => {
  const { exports } = await loadBundle()
  const article = {
    absolutePath: 'G:/ws/report.md',
    file: 'report.md',
    name: 'report.md',
    ext: '.md',
    format: 'markdown',
    title: '报告',
    blocks: [
      { id: 'b0', kind: 'heading', text: '标题', sentences: [{ id: 'b0s0', index: 0, text: '标题' }] },
      { id: 'b1', kind: 'paragraph', text: '第一句。第二句。', sentences: [{ id: 'b1s0', index: 0, text: '第一句。' }, { id: 'b1s1', index: 1, text: '第二句。' }] },
    ],
    stats: { blocks: 2, sentences: 3, chars: 10 },
  }
  const open = [
    { id: 'c1', blockId: 'b1', sentenceIndex: 0, sentence: '第一句。', comment: '太生硬', status: 'open' },
    { id: 'c2', blockId: 'b1', sentenceIndex: 1, sentence: '第二句。', comment: '可以删', status: 'open' },
  ]
  const done = [{ id: 'c0', blockId: 'b0', sentenceIndex: 0, sentence: '标题', comment: '换个标题', status: 'resolved' }]
  const message = exports.__testing.buildReviewMessage(article, open, [...open, ...done])
  assert.match(message, /report\.md/u)
  assert.match(message, /第 2 段/u)
  assert.match(message, /批注 id: c1/u)
  assert.match(message, /太生硬/u)
  assert.match(message, /article_review_resolve/u)
  assert.match(message, /writing_style_add/u)
  assert.match(message, /直接用编辑工具修改原文件/u)

  const markdown = exports.__testing.buildExportMarkdown(article, [...open, ...done])
  assert.match(markdown, /## 待处理（2 条）/u)
  assert.match(markdown, /## 已解决（1 条）/u)
})

test('file addresses and spacing helpers follow the host grammar', async () => {
  const { exports } = await loadBundle()
  assert.equal(
    exports.__testing.fileAddressFor('session-1', 'docs/报告.md'),
    'dsh-resource://file/session/session-1/docs/%E6%8A%A5%E5%91%8A.md',
  )
  assert.equal(exports.__testing.fileAddressFor('', 'a.md'), null)
  assert.equal(exports.__testing.needsSpaceBetween('Hello', 'world'), true)
  assert.equal(exports.__testing.needsSpaceBetween('中文。', '下一句'), false)
})

test('right-click helpers resolve preview paths and selected sentences', async () => {
  const { exports } = await loadBundle()
  const testing = exports.__testing
  assert.equal(
    testing.fileFromResourceAddress('dsh-resource://file/session/session-1/docs/%E6%8A%A5%E5%91%8A.md'),
    'docs/报告.md',
  )
  assert.equal(testing.fileFromResourceAddress('dsh-session://x'), null)
  assert.equal(testing.basenameOfPath('C:\\work\\docs\\a.md'), 'a.md')
  assert.equal(testing.normalizeForMatch(' 第一句，。 '), '第一句')
  const article = {
    blocks: [
      { id: 'b0', kind: 'paragraph', text: '这是一段。', sentences: [{ id: 'b0s0', index: 0, text: '这是一段。' }] },
      { id: 'b1', kind: 'paragraph', text: '第二段有更多字。', sentences: [{ id: 'b1s0', index: 0, text: '第二段有更多字。' }] },
    ],
  }
  const exact = testing.findSentenceByQuote(article, '“这是一段。”')
  assert.equal(exact.sentence.id, 'b0s0')
  const partial = testing.findSentenceByQuote(article, '更多字')
  assert.equal(partial.sentence.id, 'b1s0')
  assert.equal(testing.findSentenceByQuote(article, '完全不存在的句子内容'), null)
})
