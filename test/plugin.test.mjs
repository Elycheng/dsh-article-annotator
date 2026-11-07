/** Plugin entry: config schema, route/tool/prompt wiring, degradation paths. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, apply, renderStyleSection } from '../lib/index.js'
import { addStyleRule } from '../lib/store.js'

async function tempHome() {
  const dir = await mkdtemp(join(tmpdir(), 'article-annotator-plugin-'))
  process.env.DSH_HOME = dir
  return dir
}

test('Config is a Standard Schema with documented defaults', () => {
  assert.equal(Config['~standard'].version, 1)
  const result = Config['~standard'].validate({})
  assert.ok(result.value !== undefined)
  assert.equal(result.value.injectStyle, true)
  assert.equal(result.value.enableTools, true)
  assert.equal(result.value.maxStyleRules, 12)
  assert.equal(result.value.maxArticleBytes, 41943040)
  const bad = Config['~standard'].validate({ maxStyleRules: 'many' })
  assert.ok(Array.isArray(bad.issues))
})

test('apply wires the web route and the style prompt section', async () => {
  await tempHome()
  process.env.DSH_HOME = await tempHome()
  const seen = { routes: [], sections: [], effects: 0, logs: [] }
  const webCtx = {
    effect(fn) {
      seen.effects += 1
      return fn()
    },
    webServer: {
      register(options) {
        seen.routes.push(options)
        return () => {}
      },
    },
  }
  const promptCtx = {
    effect(fn) {
      seen.effects += 1
      return fn()
    },
    systemPrompt: {
      section(section) {
        seen.sections.push(section)
        return () => {}
      },
    },
  }
  const ctx = {
    logger: { info: (message) => seen.logs.push(String(message)), warn: () => {} },
    inject(services, callback) {
      if (services.includes('webServer')) callback(webCtx)
      if (services.includes('systemPrompt')) callback(promptCtx)
      // No `tools` callback: the tools half must degrade silently.
    },
    get() {
      return undefined
    },
  }
  apply(ctx, { maxStyleRules: 5 })
  assert.equal(seen.routes.length, 1)
  assert.equal(seen.routes[0].kind, 'prefix')
  assert.equal(seen.routes[0].path, '/article-annotator/api')
  assert.equal(typeof seen.routes[0].handler, 'function')
  assert.equal(seen.sections.length, 1)
  assert.equal(seen.sections[0].name, 'article-annotator:writing-style')
  assert.equal(seen.sections[0].order, 260)
  assert.ok(seen.logs.some((line) => line.includes('文稿批注已加载')))
})

test('style section is empty without rules and lists them afterwards', async () => {
  await tempHome()
  assert.equal(renderStyleSection(12), '')
  await addStyleRule({ rule: '少用四字成语堆叠' })
  await addStyleRule({ rule: '结尾不要总结式拔高' })
  const text = renderStyleSection(12)
  assert.match(text, /我的写作风格偏好/u)
  assert.match(text, /少用四字成语堆叠/u)
  assert.match(text, /结尾不要总结式拔高/u)
  const limited = renderStyleSection(1)
  assert.match(limited, /结尾不要总结式拔高/u)
  assert.match(limited, /另有 1 条/u)
})

test('apply survives a host with no optional services', () => {
  const ctx = {
    logger: { info() {}, warn() {} },
    inject() {
      // Services never appear; inject must not throw.
    },
  }
  assert.doesNotThrow(() => apply(ctx, {}))
})
