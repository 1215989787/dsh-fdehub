/**
 * dsh-fdehub — 冒烟测试（零依赖，node test/smoke.mjs 直接跑）。
 *
 * 不测 UI，只测最容易在「装完不生效」上翻车的四件事：
 *  1. apply 不抛错（配置缺失 / 服务缺失都要能起）；
 *  2. 路由注册到了常驻 webServer 上；
 *  3. tools 服务在时 5 个工具都注册成功，不在时安静跳过；
 *  4. 场景种子能读出来、能按关键词检索。
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'fdehub-smoke-'))

const registered = []
const tools = []
const listeners = []

function fakeCtx({ withWebServer = true, withTools = true } = {}) {
  const ctx = {
    logger: { debug() {}, warn() {}, info() {} },
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      return () => (typeof dispose === 'function' ? dispose() : undefined)
    },
    get(name) {
      if (name === 'llm') return { stream: async function* () {} }
      if (name === 'webServer' && withWebServer) return ctx.webServer
      if (name === 'tools' && withTools) return ctx.tools
      return undefined
    },
    inject(deps, callback) {
      if (deps.includes('webServer') && !withWebServer) return
      if (deps.includes('tools') && !withTools) return
      callback(ctx)
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    webServer: {
      host: '127.0.0.1',
      register(options) {
        registered.push(options)
        return () => {}
      },
    },
  }
  ctx.root = ctx
  return ctx
}

const { apply } = await import('../index.js')

// 1. 完整环境
apply(fakeCtx(), { dataDir: tmp, lang: 'zh' })
assert.equal(registered.length, 1, 'routes should be registered once')
assert.equal(registered[0].path, '/fdehub/api')
assert.equal(typeof registered[0].handler, 'function')
assert.equal(tools.length, 6, `expected 6 tools, got ${tools.length}`)
assert.deepEqual(
  tools.map((tool) => tool.name).sort(),
  ['fde_analyze', 'fde_case_list', 'fde_case_read', 'fde_scene_publish', 'fde_scene_search', 'fdehub_status'],
)
for (const tool of tools) {
  assert.equal(typeof tool.execute, 'function', `${tool.name} needs execute`)
  assert.equal(typeof tool.description, 'string', `${tool.name} needs description`)
}

// 2. 没有 webServer / tools 的环境：不抛，只是少能力
apply(fakeCtx({ withWebServer: false, withTools: false }), { dataDir: tmp })

// 3. 场景种子
const seed = JSON.parse(await fsp.readFile(new URL('../scenes/seed.json', import.meta.url), 'utf8'))
assert.ok(Array.isArray(seed.scenes) && seed.scenes.length >= 8, 'seed scenes missing')
for (const scene of seed.scenes) {
  for (const key of ['id', 'title', 'domain', 'aiPattern', 'injection', 'inputs', 'outputs', 'humanInLoop', 'proofMetric']) {
    assert.ok(typeof scene[key] === 'string' && scene[key] !== '', `${scene.id} missing ${key}`)
  }
}

// 4. 市场检索（local store + 种子）
const { createStore } = await import('../lib/store.js')
const { normalizeConfig } = await import('../lib/config.js')
const { listScenes } = await import('../lib/registry.js')
const config = normalizeConfig({ dataDir: path.join(tmp, 'market') })
const store = createStore({ logger: { debug() {}, warn() {} } }, config)
await store.ready
const found = await listScenes(store, config, { query: '报价', includeRemote: false })
assert.ok(found.scenes.length >= 1, 'search for 报价 should hit the quotation scene')
const all = await listScenes(store, config, { includeRemote: false })
assert.ok(all.scenes.length >= 8, 'merged scene list should include seeds')
assert.ok(all.domains.length >= 4, 'domains facet should be populated')
await store.dispose()

// 5. 市场分发：CDN → raw 的兜底推导、catalog 与 registry/scenes 一致
const { fallbackUrls } = await import('../lib/registry.js')
assert.deepEqual(fallbackUrls('https://cdn.jsdelivr.net/gh/o/r@master/registry/catalog.json'), [
  'https://cdn.jsdelivr.net/gh/o/r@master/registry/catalog.json',
  'https://raw.githubusercontent.com/o/r/master/registry/catalog.json',
])
assert.deepEqual(fallbackUrls('https://example.com/catalog.json'), ['https://example.com/catalog.json'])
const catalog = JSON.parse(await fsp.readFile(new URL('../registry/catalog.json', import.meta.url), 'utf8'))
assert.equal(catalog.schemaVersion, 1)
assert.equal(catalog.count, catalog.scenes.length)
assert.equal(catalog.scenes.length, seed.scenes.length, 'catalog 与 seed 条数应一致（都由 market:build 生成）')
assert.ok(catalog.scenes[0].featured === true, 'catalog 排序应把 featured 放前面')

// 6. 分析结果解析：带围栏 / 带废话 / 被截断
const { parseBlueprint } = await import('../lib/analyze.js')
const fenced = parseBlueprint('```json\n{"caseTitle":"测试","oneLine":"x","pains":[],"opportunities":[]}\n```')
assert.equal(fenced.caseTitle, '测试')
const noisy = parseBlueprint('好的，下面是结果：\n{"caseTitle":"A","business":{"flow":["a","b"]},"pains":[{"title":"p"}]}\n以上。')
assert.equal(noisy.business.flow.length, 2)
const truncated = parseBlueprint('{"caseTitle":"B","oneLine":"y","pains":[{"title":"t1"},{"title":"t2"}],"opportunit')
assert.ok(truncated !== undefined && truncated.caseTitle === 'B', 'truncated output should still yield a blueprint')
assert.equal(parseBlueprint('完全不是 JSON'), undefined)

// 6. 识图取文：能力缺失时要给出可区分的原因，而不是静默返回空
const { ocrFile } = await import('../lib/ocr.js')
const noLlmCtx = { get: () => undefined }
const offConfig = { ...config, ocrEnabled: false }
assert.equal((await ocrFile(noLlmCtx, offConfig, {}, '/tmp/x.png', 'x.png')).reason, 'ocr-off')
assert.equal((await ocrFile(noLlmCtx, config, {}, '/tmp/x.png', 'x.png')).reason, 'llm-unavailable')
const routed = await ocrFile(noLlmCtx, config, { provider: '', model: '' }, '/tmp/x.png', 'x.png')
assert.equal(routed.reason, 'llm-unavailable', 'service missing should win over route check')

console.log('✓ dsh-fdehub smoke: routes, tools, seeds, market, parser, ocr all ok')
// 临时目录交给系统清理：某些沙箱策略不允许 rmdir，测试不该因为这个失败。
console.log(`（临时数据：${tmp}）`)
