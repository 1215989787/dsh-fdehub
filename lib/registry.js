/**
 * dsh-fdehub — 场景市场。
 *
 * 市场的本质是「可复用的 AI+业务场景资产」，不是插件商店：
 * 一条场景卡要说清楚插在流程哪一步、吃什么、产出什么、人怎么兜底、用什么指标
 * 证明有效。说不清这五件事的，进不了市场（门禁见 scripts/market-validate.mjs）。
 *
 * 分发方式对齐 dsh-mcp-connector：
 *   catalog 放仓库 registry/catalog.json → jsDelivr CDN 取 → 失败退 raw.githubusercontent
 *   单条场景一个文件（registry/scenes/<id>.json），PR 不打架
 *   缓存按 refreshSkewMs 过期，用户点「刷新」时强制重取
 *
 * 三个来源合并成一张列表：
 *   seed   随包发布的内置种子（scenes/seed.json，离线可用）
 *   local  本机发布的场景（存进 store.json，可导出成 PR 用的 JSON）
 *   remote 远端 catalog（config.indexUrl）
 *
 * 远端只是索引：拿不到就退回本地，不因为网络问题让市场空掉。
 */
import { DEFAULT_INDEX_URL, resolveDataDir } from './config.js'

const remoteCache = { key: '', at: 0, scenes: [], error: '', tried: [], loading: undefined }

const text = (value) => (typeof value === 'string' ? value.trim() : '')

/** jsDelivr 的 gh 地址可以推出对应的 raw 地址，作为第二跳兜底。 */
export function fallbackUrls(url) {
  const out = [url]
  const match = url.match(/^https:\/\/cdn\.jsdelivr\.net\/gh\/([^/@]+)\/([^/@]+)@([^/]+)\/(.+)$/)
  if (match !== null) {
    const [, owner, repo, ref, file] = match
    out.push(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${file}`)
  }
  return out
}

/** 把任意来源的一条场景收口成面板敢直接渲染的形状。 */
export function normalizeScene(raw, origin) {
  if (raw === null || typeof raw !== 'object') return undefined
  const id = text(raw.id)
  const title = text(raw.title)
  if (id === '' || title === '') return undefined
  return {
    id,
    title,
    domain: text(raw.domain) || '未分类',
    industry: text(raw.industry),
    summary: text(raw.summary),
    pain: text(raw.pain),
    aiPattern: text(raw.aiPattern),
    injection: text(raw.injection),
    inputs: text(raw.inputs),
    outputs: text(raw.outputs),
    humanInLoop: text(raw.humanInLoop),
    proofMetric: text(raw.proofMetric),
    effort: text(raw.effort) || 'M',
    metrics: Array.isArray(raw.metrics) ? raw.metrics.map(text).filter((item) => item !== '') : [],
    risks: Array.isArray(raw.risks) ? raw.risks.map(text).filter((item) => item !== '') : [],
    tags: Array.isArray(raw.tags) ? raw.tags.map(text).filter((item) => item !== '') : [],
    author: text(raw.author),
    org: text(raw.org),
    version: text(raw.version) || '0.1.0',
    license: text(raw.license) || 'CC-BY-4.0',
    published: raw.published !== false,
    featured: raw.featured === true,
    createdAt: text(raw.createdAt),
    updatedAt: text(raw.updatedAt) || text(raw.createdAt),
    repo: text(raw.repo),
    url: text(raw.url),
    origin: origin ?? (text(raw.origin) || 'remote'),
  }
}

/**
 * 拉远端 catalog。失败不抛：把原因和试过的地址留在状态里，
 * 面板就能显示「为什么只有本地场景」，而不是干等。
 */
export async function refreshRemote(config, { force = false } = {}) {
  const url = text(config.indexUrl)
  if (url === '') return { scenes: [], error: '', skipped: 'no-index-url' }

  const skew = Number.isFinite(config.refreshSkewMs) ? config.refreshSkewMs : 300000
  const fresh = Date.now() - remoteCache.at < skew
  if (!force && fresh && remoteCache.key === url) {
    return { scenes: remoteCache.scenes, error: remoteCache.error, tried: remoteCache.tried }
  }
  if (remoteCache.loading !== undefined && remoteCache.key === url) return remoteCache.loading

  const task = (async () => {
    const tried = []
    let lastError = ''
    for (const candidate of fallbackUrls(url)) {
      tried.push(candidate)
      try {
        const response = await fetch(candidate, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(15000),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = await response.json()
        const list = Array.isArray(payload) ? payload : Array.isArray(payload?.scenes) ? payload.scenes : []
        const scenes = list.map((item) => normalizeScene(item, 'remote')).filter(Boolean)
        Object.assign(remoteCache, { key: url, at: Date.now(), scenes, error: '', tried, loading: undefined })
        return { scenes, error: '', tried }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    // 全部失败：保留上一次成功的场景（有的话），只更新错误信息
    const keep = remoteCache.key === url ? remoteCache.scenes : []
    Object.assign(remoteCache, { key: url, at: Date.now(), scenes: keep, error: lastError, tried, loading: undefined })
    return { scenes: keep, error: lastError, tried }
  })()

  remoteCache.loading = task
  return task
}

/** 合并三源 + 过滤 + 排序（featured 先、同域聚拢、新改动靠前）。 */
export async function listScenes(store, config, { query = '', domain = '', industry = '', includeRemote = true, force = false } = {}) {
  const local = store
    .scenes()
    .map((scene) => normalizeScene(scene, scene.origin ?? 'local'))
    .filter((scene) => scene !== undefined && scene.published !== false)

  let remote = []
  let remoteError = ''
  if (includeRemote) {
    const result = await refreshRemote(config, { force })
    remote = result.scenes.filter((scene) => scene.published !== false)
    remoteError = result.error ?? ''
  }

  const seen = new Set(local.map((scene) => scene.id))
  const merged = [...local]
  for (const scene of remote) if (!seen.has(scene.id)) merged.push(scene)

  const needle = query.trim().toLowerCase()
  const match = (scene) => {
    if (domain !== '' && scene.domain !== domain) return false
    if (industry !== '' && scene.industry !== industry) return false
    if (needle === '') return true
    const haystack = [
      scene.title,
      scene.summary,
      scene.pain,
      scene.aiPattern,
      scene.injection,
      scene.domain,
      scene.industry,
      ...(scene.tags ?? []),
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(needle)
  }

  const scenes = merged.filter(match).sort((a, b) => {
    const f = Number(b.featured) - Number(a.featured)
    if (f !== 0) return f
    const d = a.domain.localeCompare(b.domain, 'zh')
    if (d !== 0) return d
    return String(b.updatedAt).localeCompare(String(a.updatedAt))
  })

  const domains = [...new Set(merged.map((scene) => scene.domain).filter((item) => item !== ''))].sort((a, b) =>
    a.localeCompare(b, 'zh'),
  )
  return {
    scenes,
    domains,
    remoteError,
    total: merged.length,
    featured: merged.filter((scene) => scene.featured).length,
    indexUrl: config.indexUrl,
  }
}

export function sceneById(store, id) {
  const scene = store.scenes().find((entry) => entry.id === id)
  return scene === undefined ? undefined : normalizeScene(scene, scene.origin ?? 'local')
}

/** 用一条场景卡起一个新案例：把卡上的信息填进 brief，现场只需补客户侧事实。 */
export function caseSeedFromScene(scene) {
  const brief = [
    `参考场景：${scene.title}（${scene.domain}${scene.industry ? ` · ${scene.industry}` : ''}）`,
    scene.summary !== '' ? `场景大意：${scene.summary}` : '',
    scene.injection !== '' ? `AI 插在哪一步：${scene.injection}` : '',
    scene.inputs !== '' ? `输入：${scene.inputs}` : '',
    scene.outputs !== '' ? `输出：${scene.outputs}` : '',
    scene.humanInLoop !== '' ? `人工兜底：${scene.humanInLoop}` : '',
    '请把上面的参考场景当作起点，但只保留与本次现场吻合的部分，其余按现场事实重写。',
  ]
    .filter((line) => line !== '')
    .join('\n')
  return { title: scene.title, domain: scene.domain, industry: scene.industry, brief }
}

/**
 * 生成可直接提 PR 的两份东西：
 *   registry/scenes/<id>.json —— 单条场景文件（registry 的真源）
 *   markdown                  —— 贴进 PR 描述
 */
export function toPublishPayload(scene, config) {
  const card = {
    schemaVersion: 1,
    ...scene,
    author: scene.author || config.author,
    org: scene.org || config.org,
    version: scene.version || '0.1.0',
    license: scene.license || 'CC-BY-4.0',
    published: true,
    updatedAt: new Date().toISOString(),
  }
  delete card.origin
  const markdown = [
    `### ${card.title}`,
    '',
    `- 域：${card.domain}${card.industry ? ` · ${card.industry}` : ''}`,
    `- AI 形态：${card.aiPattern || '未标注'}`,
    `- 插入点：${card.injection || '未标注'}`,
    `- 输入 → 输出：${card.inputs || '—'} → ${card.outputs || '—'}`,
    `- 人工兜底：${card.humanInLoop || '未标注'}`,
    `- 判定指标：${card.proofMetric || '未标注'}`,
    card.metrics.length > 0 ? `- 量化：${card.metrics.join('；')}` : '',
    `- 贡献者：${card.author || '匿名'}${card.org ? ` @ ${card.org}` : ''}`,
    '',
    `新增文件：\`registry/scenes/${card.id}.json\``,
    '',
    `\`\`\`json\n${JSON.stringify(card, null, 2)}\n\`\`\``,
    '',
    '> 本地已跑：`npm run market:build && npm run market:validate`。',
  ]
    .filter((line) => line !== '')
    .join('\n')
  return { json: card, markdown, file: `registry/scenes/${card.id}.json` }
}

export { DEFAULT_INDEX_URL, resolveDataDir }
