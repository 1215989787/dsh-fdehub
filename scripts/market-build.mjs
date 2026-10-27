/**
 * market:build — 从 registry/scenes/*.json 生成两个产物：
 *
 *   registry/catalog.json   远端索引（插件通过 indexUrl 拉这个，jsDelivr CDN 分发）
 *   scenes/seed.json        离线种子（随包发布，没网络也能用）
 *
 * 单一真源是 registry/scenes/：一条场景一个文件，PR 只动一个文件、不产生冲突，
 * 也不用为了改一条场景去撞整份大 JSON。
 *
 *   node scripts/market-build.mjs [--check]
 *
 * --check 只比对不写盘：CI 用它防止「改了 scenes/ 忘了跑 build」。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

const root = new URL('..', import.meta.url).pathname
const scenesDir = path.join(root, 'registry/scenes')
const catalogFile = path.join(root, 'registry/catalog.json')
const seedFile = path.join(root, 'scenes/seed.json')
const checkOnly = process.argv.includes('--check')

const files = (await fsp.readdir(scenesDir)).filter((name) => name.endsWith('.json')).sort()
const scenes = []
for (const file of files) {
  const raw = await fsp.readFile(path.join(scenesDir, file), 'utf8')
  let card
  try {
    card = JSON.parse(raw)
  } catch (error) {
    console.error(`✗ ${file} 不是合法 JSON：${error.message}`)
    process.exit(1)
  }
  if (card.id !== path.basename(file, '.json')) {
    console.error(`✗ ${file} 的 id（${card.id}）与文件名不一致`)
    process.exit(1)
  }
  scenes.push(card)
}

// 顺序有语义：featured 先，再按 domain 聚拢，最后按更新时间。
scenes.sort((a, b) => {
  const f = Number(b.featured === true) - Number(a.featured === true)
  if (f !== 0) return f
  const d = String(a.domain).localeCompare(String(b.domain), 'zh')
  if (d !== 0) return d
  return String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))
})

const now = new Date().toISOString()
const current = await readJson(catalogFile)
// 内容没变就不动盘：generatedAt 每次都刷新会让 --check 永远失败，
// 也会给每次提交都塞进一个无意义的 diff。
const unchanged = current !== undefined && JSON.stringify(current.scenes) === JSON.stringify(scenes)

const catalog = {
  schemaVersion: 1,
  generatedAt: unchanged ? current.generatedAt : now,
  count: scenes.length,
  featured: scenes.filter((scene) => scene.featured === true).length,
  domains: [...new Set(scenes.map((scene) => scene.domain))].sort((a, b) => a.localeCompare(b, 'zh')),
  scenes,
}
const seed = {
  version: catalog.schemaVersion,
  generatedAt: catalog.generatedAt,
  note: '由 scripts/market-build.mjs 从 registry/scenes/ 生成，不要手改。离线种子，随包发布。',
  scenes,
}

if (unchanged) {
  if (checkOnly) {
    console.log(`校验通过：${scenes.length} 条场景（featured ${catalog.featured}），catalog 与 registry/scenes/ 一致`)
    process.exit(0)
  }
  // seed 可能缺失或被手改，仍然校对一遍
  const seedOk = JSON.stringify((await readJson(seedFile))?.scenes) === JSON.stringify(scenes)
  if (seedOk) {
    console.log(`${scenes.length} 条场景（featured ${catalog.featured}）　· 无变化`)
    process.exit(0)
  }
}

const write = async (file, value) => {
  const next = `${JSON.stringify(value, null, 2)}\n`
  let old = ''
  try {
    old = await fsp.readFile(file, 'utf8')
  } catch {
    /* 首次生成 */
  }
  if (old === next) return false
  if (checkOnly) {
    console.error(`✗ ${path.relative(root, file)} 与 registry/scenes/ 不一致，请跑 npm run market:build`)
    process.exit(1)
  }
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, next, 'utf8')
  return true
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

const a = await write(catalogFile, catalog)
const b = await write(seedFile, seed)
console.log(
  `${checkOnly ? '校验' : '生成'}完成：${scenes.length} 条场景（featured ${catalog.featured}）` +
    `${a || b ? '　· registry/catalog.json / scenes/seed.json 已更新' : '　· 无变化'}`,
)
