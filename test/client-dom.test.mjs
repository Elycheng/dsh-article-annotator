/**
 * Real-DOM render test of the browser half.
 *
 * Loads the built bundle in a jsdom window with real React from this package's
 * own devDependencies, drives the first data load through stubbed fetch
 * responses, then clicks a sentence, writes a comment and saves it. This
 * catches the class of runtime errors a syntax/registration smoke cannot: hook
 * order, controlled inputs, the sentence-editor popover and the comment state
 * merge.
 *
 * The test is skipped (with a message) when devDependencies are not installed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
const DEPS_READY = ['jsdom', 'react', 'react-dom'].every((name) => existsSync(join(ROOT, 'node_modules', name, 'package.json')))

const ARTICLE = {
  absolutePath: 'C:/example/a.md',
  file: 'a.md',
  name: 'a.md',
  ext: '.md',
  format: 'markdown',
  title: '测试文稿',
  blocks: [
    { id: 'b0', kind: 'heading', text: '测试文稿', sentences: [{ id: 'b0s0', index: 0, text: '测试文稿' }] },
    { id: 'b1', kind: 'paragraph', text: '第一句。第二句。', sentences: [{ id: 'b1s0', index: 0, text: '第一句。' }, { id: 'b1s1', index: 1, text: '第二句。' }] },
  ],
  stats: { blocks: 2, sentences: 3, chars: 20, bytes: 128 },
  warnings: [],
}

const EXISTING = [{ id: 'c1', blockId: 'b1', sentenceIndex: 0, sentence: '第一句。', comment: '太生硬', status: 'open', createdAt: 1, updatedAt: 1 }]

/** Build the fetch stub: list -> recent article -> open -> comment save. */
function fetchStub(calls) {
  return async (url, options) => {
    const payload = options?.body ? JSON.parse(options.body) : {}
    calls.push({ url: String(url), payload })
    let value
    if (String(url).endsWith('/list')) {
      value = {
        cwd: 'C:/example',
        items: [{ path: 'a.md', absolutePath: 'C:/example/a.md', name: 'a.md', ext: '.md', size: 128, mtimeMs: Date.now() }],
        recent: [{ absolutePath: 'C:/example/a.md', file: 'a.md', title: '测试文稿', format: 'markdown', at: Date.now() }],
        styleCount: 0,
      }
    } else if (String(url).endsWith('/open')) {
      value = { cwd: 'C:/example', file: 'a.md', article: ARTICLE, comments: EXISTING, styleRules: [], orphaned: 0, reanchored: 0 }
    } else if (String(url).endsWith('/comment')) {
      value = {
        action: 'save',
        comment: { id: 'c2', blockId: 'b1', sentenceIndex: 1, sentence: '第二句。', comment: payload.comment, status: 'open', createdAt: 2, updatedAt: 2 },
        total: 2,
      }
    } else {
      throw new Error('unexpected API call: ' + url)
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
  }
}

test('client tab renders the article, then annotates a sentence end-to-end', { skip: DEPS_READY ? false : '先执行 npm install 安装 devDependencies' }, async () => {
  const { JSDOM } = createRequire(join(ROOT, 'package.json'))('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:8791/', pretendToBeVisual: true })
  const { window } = dom
  globalThis.window = window
  globalThis.document = window.document
  globalThis.HTMLElement = window.HTMLElement
  globalThis.Element = window.Element
  globalThis.Node = window.Node
  globalThis.MutationObserver = window.MutationObserver
  globalThis.getComputedStyle = window.getComputedStyle.bind(window)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // react-dom reads `window`/`document` when it is first imported, so the
  // modules are required only after the jsdom globals exist.
  const requireFromRepo = createRequire(join(ROOT, 'package.json'))
  const React = requireFromRepo('react')
  const ReactDOMClient = requireFromRepo('react-dom/client')
  const act = requireFromRepo('react-dom/test-utils').act

  const calls = []
  let loaderDefinition = null
  window.__ModuleLoader__ = {
    load(definition) {
      loaderDefinition = definition
    },
  }
  const code = await readFile(BUNDLE, 'utf8')
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    fetch: fetchStub(calls),
    navigator: window.navigator,
    Blob: window.Blob,
    URL: window.URL,
    document: window.document,
    window,
    Promise,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'client.js' })
  assert.ok(loaderDefinition !== null, 'bundle must register itself with the module loader')
  const plugin = loaderDefinition.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error('unexpected require: ' + specifier)
  })

  let component = null
  const ctx = {
    get: () => null,
    inject: (names, callback) => {
      callback({
        effect: (fn) => fn(),
        sidebarRightTabs: { register: () => () => {} },
        slots: {
          inject: (name, fn) => fn(),
          register: (descriptor, implementation) => {
            if (descriptor.name === 'sidebar.right.pane.tab') component = implementation
            return () => {}
          },
        },
      })
    },
  }
  plugin.apply(ctx)
  assert.equal(typeof component, 'function')

  const container = window.document.createElement('div')
  window.document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  await act(async () => {
    root.render(React.createElement(component, { sessionId: 'session-1' }))
    await new Promise((done) => setTimeout(done, 80))
  })
  const text = container.textContent ?? ''
  assert.match(text, /测试文稿/u, 'article title should render after the auto-open')
  assert.match(text, /待处理 1/u, 'the open comment count should be visible')
  assert.ok((container.querySelectorAll('[data-ar-sentence]') ?? []).length >= 3, 'every sentence is an anchor')
  const marked = container.querySelector('[data-ar-sentence="b1s0"]')
  assert.ok(marked.className.includes('ar-s-has'), 'the annotated sentence is highlighted')
  assert.equal(marked.querySelector('.ar-mark')?.textContent, '1')

  // Click the second sentence, write a comment, save it.
  const target = container.querySelector('[data-ar-sentence="b1s1"]')
  await act(async () => {
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  const textarea = container.querySelector('.ar-pop-input')
  assert.ok(textarea !== null, 'the sentence editor opens on click')
  await act(async () => {
    // React tracks the value property on the node; the native prototype setter
    // bypasses that tracker so the synthetic `input` event sees a real change.
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
    descriptor.set.call(textarea, '太啰嗦')
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  assert.equal(textarea.value, '太啰嗦', 'typing updates the controlled textarea')
  const saveButton = [...container.querySelectorAll('.ar-pop-actions button')].find((button) => (button.textContent ?? '').includes('保存'))
  assert.ok(saveButton !== undefined, 'the editor has a save button')
  await act(async () => {
    saveButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((done) => setTimeout(done, 120))
  })
  if (!calls.some((call) => call.url.endsWith('/comment'))) {
    console.error('DEBUG calls:', calls.map((call) => call.url + ' ' + JSON.stringify(call.payload)).join('\n'))
    console.error('DEBUG popover:', container.querySelector('.ar-pop')?.textContent, '| toast:', window.document.getElementById('ar-toast')?.textContent)
  }
  const commentCall = calls.find((call) => call.url.endsWith('/comment'))
  assert.ok(commentCall !== undefined, 'saving calls the comment API')
  assert.equal(commentCall.payload.comment, '太啰嗦')
  assert.equal(commentCall.payload.sentence, '第二句。')
  const second = container.querySelector('[data-ar-sentence="b1s1"]')
  assert.ok(second.className.includes('ar-s-has'), 'the new comment is reflected immediately')
  assert.equal(second.querySelector('.ar-mark')?.textContent, '2')
  assert.equal(container.querySelector('.ar-pop-input'), null, 'the editor closes after save')
  assert.match(container.textContent ?? '', /待处理 2/u)

  await act(async () => {
    root.unmount()
  })
  container.remove()
  delete globalThis.window
  delete globalThis.document
  delete globalThis.IS_REACT_ACT_ENVIRONMENT
})
