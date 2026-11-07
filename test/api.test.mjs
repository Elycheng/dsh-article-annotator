/** Same-origin API: fence, list/open, comments, style, validation. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { API_PREFIX, dispatch, handleRequest } from '../lib/api.js'
import { FIXTURES, makeFixtures } from './make-fixtures.mjs'

await makeFixtures()

const CAPS = { maxBytes: 40 * 1024 * 1024, maxBlocks: 500 }

let counter = 0
async function tempHome() {
  counter += 1
  const dir = await mkdtemp(join(tmpdir(), 'article-annotator-api-' + counter + '-'))
  process.env.DSH_HOME = dir
  return dir
}

/** A host ctx stub: session persistence answers the fixture root. */
function fakeCtx({ cwd, reject = false, withConnection = true } = {}) {
  const services = {
    ...(withConnection ? { connection: { requestRejection: () => (reject ? { reason: 'cross-origin' } : undefined) } } : {}),
    sessionPersistence: { stat: async () => ({ header: { cwd } }) },
  }
  return {
    logger: { info() {}, warn() {} },
    get(name) {
      return services[name]
    },
  }
}

function fakeRequest(url, payload) {
  const body = payload === undefined ? '' : JSON.stringify(payload)
  const req = Readable.from(body === '' ? [] : [Buffer.from(body, 'utf8')])
  req.method = 'POST'
  req.url = url
  req.destroy = () => {}
  return req
}

function fakeResponse() {
  const res = {
    status: 0,
    body: '',
    writeHead(status) {
      res.status = status
    },
    end(text) {
      res.body = text
    },
  }
  return res
}

async function call(ctx, method, payload) {
  const res = fakeResponse()
  await handleRequest(ctx, CAPS, fakeRequest(API_PREFIX + '/' + method, payload), res)
  return { status: res.status, json: JSON.parse(res.body) }
}

test('probe reports the API shape', async () => {
  await tempHome()
  const ctx = fakeCtx({ cwd: FIXTURES })
  const { status, json } = await call(ctx, 'probe', {})
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.value.version, 1)
  assert.ok(json.value.formats.includes('pdf'))
})

test('fence rejects cross-origin requests before dispatch', async () => {
  await tempHome()
  const ctx = fakeCtx({ cwd: FIXTURES, reject: true })
  const { status, json } = await call(ctx, 'probe', {})
  assert.equal(status, 403)
  assert.equal(json.error.code, 'forbidden')
})

test('missing connection fence answers 503', async () => {
  await tempHome()
  const ctx = fakeCtx({ cwd: FIXTURES, withConnection: false })
  const { status } = await call(ctx, 'probe', {})
  assert.equal(status, 503)
})

test('method and body validation', async () => {
  await tempHome()
  const ctx = fakeCtx({ cwd: FIXTURES })
  assert.equal((await call(ctx, 'nope', {})).status, 404)
  assert.equal((await call(ctx, 'open', {})).json.error.code, 'bad-request')
  const bad = fakeResponse()
  const req = fakeRequest(API_PREFIX + '/probe', { x: 1 })
  req.method = 'GET'
  await handleRequest(ctx, CAPS, req, bad)
  assert.equal(bad.status, 405)
})

test('list finds the fixture articles in the session workspace', async () => {
  await tempHome()
  const ctx = fakeCtx({ cwd: FIXTURES })
  const { status, json } = await call(ctx, 'list', { sessionId: 's1' })
  assert.equal(status, 200)
  const names = json.value.items.map((item) => item.path)
  assert.ok(names.includes('sample.md'))
  assert.ok(names.includes('sample.docx'))
  assert.ok(names.includes('sample.pptx'))
  assert.ok(names.includes('sample.pdf'))
  assert.ok(!names.some((name) => name.includes('node_modules')))
})

test('open extracts, records recents and returns anchored comments', async () => {
  await tempHome()
  const ctx = fakeCtx({ cwd: FIXTURES })
  const open = await call(ctx, 'open', { sessionId: 's1', file: 'sample.md' })
  assert.equal(open.status, 200)
  assert.equal(open.json.value.article.format, 'markdown')
  assert.ok(open.json.value.article.blocks.length > 0)
  assert.deepEqual(open.json.value.comments, [])
  const saved = await call(ctx, 'comment', {
    sessionId: 's1',
    file: 'sample.md',
    action: 'save',
    blockId: 'b1',
    sentenceIndex: 0,
    sentence: open.json.value.article.blocks[1].sentences[0].text,
    comment: '这句太像总结陈词',
  })
  assert.equal(saved.status, 200)
  assert.match(saved.json.value.comment.id, /^c/u)
  const reopened = await call(ctx, 'open', { sessionId: 's1', file: 'sample.md' })
  assert.equal(reopened.json.value.comments.length, 1)
  assert.equal(reopened.json.value.comments[0].comment, '这句太像总结陈词')
  assert.equal(reopened.json.value.article.comments.length, 1)
  const patched = await call(ctx, 'comment', {
    sessionId: 's1',
    file: 'sample.md',
    action: 'patch',
    id: saved.json.value.comment.id,
    status: 'resolved',
  })
  assert.equal(patched.json.value.total, 1)
  const removed = await call(ctx, 'comment', {
    sessionId: 's1',
    file: 'sample.md',
    action: 'delete',
    id: saved.json.value.comment.id,
  })
  assert.equal(removed.json.value.total, 0)
})

test('style API adds, lists and removes rules', async () => {
  await tempHome()
  const ctx = fakeCtx({ cwd: FIXTURES })
  const added = await call(ctx, 'style', { action: 'add', rule: '段落结尾不要拔高' })
  assert.equal(added.json.value.added, true)
  const duplicate = await call(ctx, 'style', { action: 'add', rule: '段落结尾不要拔高' })
  assert.equal(duplicate.json.value.added, false)
  const listed = await call(ctx, 'style', { action: 'list' })
  assert.equal(listed.json.value.total, 1)
  const removed = await call(ctx, 'style', { action: 'remove', id: listed.json.value.rules[0].id })
  assert.equal(removed.json.value.total, 0)
})

test('unsupported and missing files surface as typed errors', async () => {
  await tempHome()
  const ctx = fakeCtx({ cwd: FIXTURES })
  const missing = await call(ctx, 'open', { sessionId: 's1', file: 'does-not-exist.md' })
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error.code, 'not-found')
})

test('dispatch is exported for direct in-process use', async () => {
  await tempHome()
  const ctx = fakeCtx({ cwd: FIXTURES })
  const value = await dispatch(ctx, CAPS, 'probe', {})
  assert.equal(value.version, 1)
})
