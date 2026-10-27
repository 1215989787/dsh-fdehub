/**
 * dsh-fdehub — 场景市场。
 *
 * 市场的本质是「可复用的 AI+业务场景资产」，不是插件商店：
 * 一条场景卡要说清楚插在流程哪一步、吃什么、产出什么、人怎么兜底、用什么指标
 * 证明有效。说不清这五件事的，进不了市场。
 *
 * 三个来源合并成一张列表：
 *   seed   仓库自带的种子场景（scenes/seed.json，离线可用）
 *   local  本机发布的场景（存进 store.json，可导出成 PR 用的 JSON）
 *   remote 远端索引（config.indexUrl，指向 GitHub 上的 scenes/index.json）
 *
 * 远端只是索引：拿得到就用，拿不到就退回本地，不因为网络问题让市场空掉。
 */
const REMOTE_TTL_MS = 10 * 60 * 1000

const remoteCache = { url: '', at: 0, scenes: [], error: '', loading: undefined }

const text = (value) => (typeof value === 'string' ? value.trim() : '')

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
    author: text(raw.author),
    org: text(raw.org),
    version: text(raw.version) || '0.1.0',
    license: text(raw.license) || 'CC-BY-4.0',
    createdAt: text(raw.createdAt),
    repo: text(raw.repo),
    url: text(raw.url),
    origin: origin ?? (text(raw.origin) || 'remote'),
  }
}

/** 拉远端索引。失败不抛：把错误留在状态里，面板能显示「为什么只有本地场景」。 */
export async function refreshRemote(config, { force = false } = {}) {
  const url = text(config.indexUrl)
  if (url === '') return { scenes: [], error: '', skipped: 'no-index-url' }
  const fresh = Date.now() - remoteCache.at < REMOTE_TTL_MS
  if (!force && fresh && remoteCache.url === url) return { scenes: remoteCache.scenes, error: remoteCache.error }
  if (remoteCache.loading !== undefined && remoteCache.url === url) return remoteCache.loading

  const task = (async () => {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      const list = Array.isArray(payload) ? payload : Array.isArray(payload?.scenes) ? payload.scenes : []
      const scenes = list.map((item) => normalizeScene(item, text(item?.origin) || 'remote')).filter(Boolean)
      Object.assign(remoteCache, { url, at: Date.now(), scenes, error: '', loading: undefined })
      return { scenes, error: '' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      Object.assign(remoteCache, { url, at: Date.now(), scenes: [], error: message, loading: undefined })
      return { scenes: [], error: message }
    }
  })()
  remoteCache.loading = task
  return task
}

/** 合并三源 + 过滤。 */
export async function listScenes(store, config, { query = '', domain = '', industry = '', includeRemote = true } = {}) {
  const local = store.scenes().map((scene) => normalizeScene(scene, scene.origin ?? 'local')).filter(Boolean)
  let remote = []
  let remoteError = ''
  if (includeRemote) {
    const result = await refreshRemote(config)
    remote = result.scenes
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
    const haystack = [scene.title, scene.summary, scene.pain, scene.aiPattern, scene.injection, scene.domain, scene.industry]
      .join(' ')
      .toLowerCase()
    return haystack.includes(needle)
  }
  const scenes = merged.filter(match)
  const domains = [...new Set(merged.map((scene) => scene.domain).filter((item) => item !== ''))].sort()
  return { scenes, domains, remoteError, total: merged.length }
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
    '请把上面的参考场景当作起点，但只保留与本次客户现场吻合的部分，其余按现场事实重写。',
  ]
    .filter((line) => line !== '')
    .join('\n')
  return { title: scene.title, domain: scene.domain, industry: scene.industry, brief }
}

/** 生成可直接提 PR 的场景 JSON 与说明片段。 */
export function toPublishPayload(scene, config) {
  const card = {
    ...scene,
    author: scene.author || config.author,
    org: scene.org || config.org,
    version: scene.version || '0.1.0',
    license: scene.license || 'CC-BY-4.0',
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
    `\`\`\`json\n${JSON.stringify(card, null, 2)}\n\`\`\``,
    '',
    '> 把上面这段 JSON 追加到 `scenes/seed.json` 的 `scenes` 数组，或放进 `scenes/<id>.json`，',
    '> 然后在 `scenes/index.json` 里加一行索引，提 PR 即可。',
  ]
    .filter((line) => line !== '')
    .join('\n')
  return { json: card, markdown }
}
