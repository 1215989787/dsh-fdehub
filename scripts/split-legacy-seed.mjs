/**
 * 一次性拆分脚本：把旧的 scenes/seed.json 拆成 registry/scenes/<id>.json。
 * 跑一次就够，之后的单一真源是 registry/scenes/（market-build 会反向生成 seed.json）。
 *
 *   node scripts/split-legacy-seed.mjs
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

const root = new URL('..', import.meta.url).pathname
const legacy = JSON.parse(await fsp.readFile(path.join(root, 'scenes/seed.json'), 'utf8'))
const outDir = path.join(root, 'registry/scenes')
await fsp.mkdir(outDir, { recursive: true })

const FEATURED = new Set(['seed-meeting-actions', 'seed-ticket-triage', 'seed-quotation-compare'])

let count = 0
for (const scene of legacy.scenes) {
  const card = {
    schemaVersion: 1,
    id: scene.id,
    title: scene.title,
    domain: scene.domain,
    industry: scene.industry || '通用',
    summary: scene.summary,
    pain: scene.pain,
    aiPattern: scene.aiPattern,
    injection: scene.injection,
    inputs: scene.inputs,
    outputs: scene.outputs,
    humanInLoop: scene.humanInLoop,
    proofMetric: scene.proofMetric,
    effort: scene.effort || 'M',
    metrics: scene.metrics ?? [],
    risks: scene.risks ?? [],
    tags: [scene.domain, scene.aiPattern].filter(Boolean),
    author: scene.author || '',
    org: scene.org || '',
    version: scene.version || '0.1.0',
    license: scene.license || 'CC-BY-4.0',
    published: true,
    featured: FEATURED.has(scene.id),
    createdAt: scene.createdAt || new Date().toISOString(),
    updatedAt: scene.createdAt || new Date().toISOString(),
  }
  await fsp.writeFile(path.join(outDir, `${card.id}.json`), `${JSON.stringify(card, null, 2)}\n`, 'utf8')
  count += 1
}
console.log(`拆出 ${count} 条场景卡 → registry/scenes/`)
