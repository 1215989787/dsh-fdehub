/**
 * dsh-fdehub — `/fdehub/api` 路由（面板与外部脚本共用）。
 *
 *   GET  /status            运行状态：统计 / 配置 / 转写能力 / 模型通道 / 目录
 *   GET  /snapshot          一次性拿全（面板主轮询）
 *   GET  /cases             案例列表
 *   POST /cases             新建案例 {title, org, industry, domain, brief}
 *   GET  /case?id=          单个案例（含材料与分析结果）
 *   POST /case/update       改标题 / 领域 / 背景
 *   POST /case/delete       删除案例
 *   POST /text              粘一段文字进来当材料 {id, name, text}
 *   POST /upload            上传音频或业务文件（原始二进制，文件名走 header）
 *   POST /asr/retry         重转写某条录音 {id, sourceId}
 *   POST /analyze           跑一次业务+AI 逻辑梳理 {id, brief?}
 *   GET  /export?id=        导出 Markdown 蓝图
 *   POST /scene/list        场景市场列表 {query, domain, industry, refresh}
 *   POST /scene/use         用一条场景卡起案例 {sceneId}
 *   POST /scene/publish     把某次分析发布成场景 {id, domain?, industry?}
 *   POST /scene/delete      删除本地场景 {sceneId}
 *   GET  /scene/index       导出全部本地场景（用于生成 index.json）
 *   POST /config            更新配置（运行期生效）
 *
 * 路由注册在**常驻服务**上：挂插件 fiber 的 effect 会在 apply 结束后回收，
 * 表现为 404 且无报错。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { analyze, llmStatus, renderMaterial, toSceneCard } from './analyze.js'
import { asrStatus, transcribe } from './asr.js'
import { extractText } from './extract.js'
import { createTrustFence, queryValue, readJsonBody, readRawBody, writeError, writeJson } from './http.js'
import { ocrFile } from './ocr.js'
import { caseSeedFromScene, listScenes, normalizeScene, sceneById, toPublishPayload } from './registry.js'
import { normalizeConfig, publicConfig } from './config.js'

const rootRoutes = new WeakMap()
const PREFIX = '/fdehub/api/'
const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.webm', '.mp4', '.mov', '.amr'])

export function registerFdeHubRoutes(ctx, store, config, deps) {
  const listenCtx = ctx.root ?? ctx
  const webServer = ctx.webServer ?? listenCtx?.webServer
  if (webServer === undefined || typeof webServer.register !== 'function') return
  const existing = rootRoutes.get(listenCtx)
  if (existing !== undefined) existing()
  const fence = createTrustFence(ctx)
  const handler = createHandler(fence, store, config, deps)
  rootRoutes.set(listenCtx, webServer.register({ kind: 'prefix', path: '/fdehub/api', handler }))
}

function createHandler(fence, store, config, deps) {
  return async (request, response) => {
    if (!fence(request)) {
      writeJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      return
    }
    const url = new URL(request.url ?? '/', 'http://dsh.internal')
    const method = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : ''
    try {
      await store.ready
      const handled = await dispatch(method, request, response, url, store, config, deps)
      if (!handled) writeJson(response, 404, { ok: false, error: { message: `unknown fdehub API: ${method}` } })
    } catch (error) {
      writeError(response, error)
    }
  }
}

const is = (method, request, name, verb) => method === name && request.method === verb

async function statusPayload(ctx, store, config, deps) {
  const asr = await asrStatus(ctx, config)
  return {
    stats: store.stats(),
    config: publicConfig(config),
    asr,
    llm: llmStatus(ctx, config, deps.modelHint),
    dirs: { data: store.dir, uploads: store.uploadDir },
  }
}

async function dispatch(method, request, response, url, store, config, deps) {
  const ctx = deps.ctx

  if (is(method, request, 'status', 'GET')) {
    writeJson(response, 200, { ok: true, value: await statusPayload(ctx, store, config, deps) })
    return true
  }

  if (is(method, request, 'snapshot', 'GET')) {
    writeJson(response, 200, {
      ok: true,
      value: {
        ...store.snapshot(),
        config: publicConfig(config),
        asr: await asrStatus(ctx, config),
        llm: llmStatus(ctx, config, deps.modelHint),
      },
    })
    return true
  }

  if (is(method, request, 'cases', 'GET')) {
    writeJson(response, 200, { ok: true, value: store.cases() })
    return true
  }

  if (method === 'cases' && request.method === 'POST') {
    const body = await readJsonBody(request)
    const record = store.createCase({
      title: body.title,
      org: body.org,
      industry: body.industry,
      domain: body.domain,
    })
    if (typeof body.brief === 'string' && body.brief.trim() !== '') store.updateCase(record.id, { brief: body.brief.trim() })
    writeJson(response, 200, { ok: true, value: store.caseById(record.id) })
    return true
  }

  if (is(method, request, 'case', 'GET')) {
    const record = store.caseById(queryValue(url, 'id'))
    if (record === undefined) {
      writeJson(response, 404, { ok: false, error: { message: 'case not found' } })
      return true
    }
    writeJson(response, 200, { ok: true, value: record })
    return true
  }

  if (method === 'case/update' && request.method === 'POST') {
    const body = await readJsonBody(request)
    const patch = {}
    for (const key of ['title', 'org', 'industry', 'domain', 'brief']) {
      if (typeof body[key] === 'string') patch[key] = body[key].trim()
    }
    const record = store.updateCase(String(body.id ?? ''), patch)
    if (record === undefined) {
      writeJson(response, 404, { ok: false, error: { message: 'case not found' } })
      return true
    }
    writeJson(response, 200, { ok: true, value: record })
    return true
  }

  if (method === 'case/delete' && request.method === 'POST') {
    const body = await readJsonBody(request)
    const removed = store.removeCase(String(body.id ?? ''))
    writeJson(response, 200, { ok: true, value: { removed } })
    return true
  }

  if (method === 'text' && request.method === 'POST') {
    const body = await readJsonBody(request, 8 * 1024 * 1024)
    const record = store.caseById(String(body.id ?? ''))
    if (record === undefined) {
      writeJson(response, 404, { ok: false, error: { message: 'case not found' } })
      return true
    }
    const content = typeof body.text === 'string' ? body.text.trim() : ''
    if (content === '') {
      writeJson(response, 400, { ok: false, error: { message: 'text is empty' } })
      return true
    }
    const source = store.addSource(record.id, {
      id: store.id(),
      kind: 'text',
      name: typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : '粘贴的文字',
      status: 'ok',
      chars: content.length,
      text: content,
      at: new Date().toISOString(),
    })
    if (record.status === 'draft') store.updateCase(record.id, { status: 'collected' })
    writeJson(response, 200, { ok: true, value: { source, case: store.caseById(record.id) } })
    return true
  }

  if (method === 'upload' && request.method === 'POST') {
    return await handleUpload(request, response, url, store, config, deps)
  }

  if (method === 'asr/retry' && request.method === 'POST') {
    const body = await readJsonBody(request)
    const record = store.caseById(String(body.id ?? ''))
    const source = record?.sources?.find((entry) => entry.id === String(body.sourceId ?? ''))
    if (record === undefined || source === undefined || typeof source.path !== 'string') {
      writeJson(response, 404, { ok: false, error: { message: 'source not found' } })
      return true
    }
    const outDir = path.dirname(source.path)
    const result = await transcribe(ctx, config, source.path, outDir)
    if (result.ok) {
      source.status = 'ok'
      source.engine = result.engine ?? ''
      source.chars = result.text.length
      source.text = result.text
      source.note = ''
      rebuildTranscript(store, record)
      store.updateCase(record.id, { status: store.caseById(record.id).analysis === null ? 'collected' : 'analyzed' })
    } else {
      source.status = 'untranscribed'
      source.note = result.reason ?? ''
    }
    writeJson(response, 200, { ok: true, value: { source, case: store.caseById(record.id) } })
    return true
  }

  if (method === 'analyze' && request.method === 'POST') {
    const body = await readJsonBody(request)
    const record = store.caseById(String(body.id ?? ''))
    if (record === undefined) {
      writeJson(response, 404, { ok: false, error: { message: 'case not found' } })
      return true
    }
    const brief = typeof body.brief === 'string' ? body.brief.trim() : String(record.brief ?? '')
    if (brief !== String(record.brief ?? '')) store.updateCase(record.id, { brief })
    const transcript = String(record.transcript?.text ?? '')
    const documents = (record.sources ?? [])
      .filter((entry) => entry.kind !== 'audio' && typeof entry.text === 'string' && entry.text.trim() !== '')
      .map((entry) => ({ name: entry.name, text: entry.text }))
    const material = renderMaterial({ transcript, documents, brief, maxChars: config.analysisMaxChars })
    if (material.text.trim() === '') {
      writeJson(response, 400, {
        ok: false,
        error: { message: '没有可分析的材料：先录音转写、上传文件或粘贴文字' },
      })
      return true
    }
    const result = await analyze(ctx, config, material, deps.modelHint)
    if (!result.ok) {
      const messages = {
        'llm-unavailable': '宿主没有提供模型服务，无法分析（材料已存档）',
        'route-unknown': '还没拿到模型路由：先在对话里聊一轮，或在设置里指定 provider/model',
        'empty-material': '没有可分析的材料',
        'parse-failed': '模型输出没能解析成结构化蓝图，可以重试一次',
        'llm-error': '模型调用失败，材料已存档，稍后重试',
      }
      writeJson(response, 200, { ok: false, error: { message: messages[result.reason] ?? result.reason } })
      return true
    }
    const saved = store.updateCase(record.id, {
      status: 'analyzed',
      analysis: {
        ...result.blueprint,
        _meta: { at: new Date().toISOString(), route: result.route, truncated: result.truncated, chars: result.chars },
      },
      title: record.title === '未命名梳理' && result.blueprint.caseTitle !== '' ? result.blueprint.caseTitle : record.title,
    })
    writeJson(response, 200, { ok: true, value: { case: saved, llm: llmStatus(ctx, config, deps.modelHint) } })
    return true
  }

  if (is(method, request, 'export', 'GET')) {
    const record = store.caseById(queryValue(url, 'id'))
    if (record === undefined || record.analysis === null) {
      writeJson(response, 404, { ok: false, error: { message: 'case or analysis not found' } })
      return true
    }
    const markdown = renderMarkdown(record, config)
    const filename = `${(record.analysis.caseTitle || record.title || 'fde-blueprint').replace(/[\\/:*?"<>|\s]+/g, '_')}.md`
    response.statusCode = 200
    response.setHeader('content-type', 'text/markdown; charset=utf-8')
    response.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
    response.end(markdown)
    return true
  }

  if (method === 'scene/list' && request.method === 'POST') {
    const body = await readJsonBody(request)
    const result = await listScenes(store, config, {
      query: typeof body.query === 'string' ? body.query : '',
      domain: typeof body.domain === 'string' ? body.domain : '',
      industry: typeof body.industry === 'string' ? body.industry : '',
      includeRemote: body.remote !== false,
      // 面板点「刷新」= 无视 refreshSkewMs 强制重取（与 MCP 连接器的行为一致）
      force: body.refresh === true,
    })
    writeJson(response, 200, { ok: true, value: result })
    return true
  }

  if (method === 'scene/use' && request.method === 'POST') {
    const body = await readJsonBody(request)
    const scene = sceneById(store, String(body.sceneId ?? ''))
    if (scene === undefined) {
      writeJson(response, 404, { ok: false, error: { message: 'scene not found' } })
      return true
    }
    const seed = caseSeedFromScene(scene)
    const record = store.createCase({
      title: `${seed.title} · 现场版`,
      domain: seed.domain,
      industry: seed.industry,
    })
    store.updateCase(record.id, { brief: seed.brief, sceneId: scene.id })
    writeJson(response, 200, { ok: true, value: store.caseById(record.id) })
    return true
  }

  if (method === 'scene/publish' && request.method === 'POST') {
    const body = await readJsonBody(request)
    const record = store.caseById(String(body.id ?? ''))
    if (record === undefined || record.analysis === null) {
      writeJson(response, 400, { ok: false, error: { message: '先做一次分析才能发布场景' } })
      return true
    }
    const card = toSceneCard(
      record.analysis,
      {
        title: record.title,
        domain: typeof body.domain === 'string' && body.domain !== '' ? body.domain : record.domain,
        industry: typeof body.industry === 'string' && body.industry !== '' ? body.industry : record.industry,
      },
      config,
    )
    const scene = normalizeScene(
      { ...card, ...(typeof body.overrides === 'object' && body.overrides !== null ? body.overrides : {}) },
      'local',
    )
    if (scene === undefined) {
      writeJson(response, 400, { ok: false, error: { message: '场景卡生成失败' } })
      return true
    }
    store.upsertScene(scene)
    store.updateCase(record.id, { sceneId: scene.id, status: 'published' })
    writeJson(response, 200, { ok: true, value: { scene, publish: toPublishPayload(scene, config) } })
    return true
  }

  if (method === 'scene/delete' && request.method === 'POST') {
    const body = await readJsonBody(request)
    const scene = sceneById(store, String(body.sceneId ?? ''))
    if (scene === undefined || scene.origin === 'seed') {
      writeJson(response, 400, { ok: false, error: { message: '只能删除本机发布的场景' } })
      return true
    }
    writeJson(response, 200, { ok: true, value: { removed: store.removeScene(scene.id) } })
    return true
  }

  if (is(method, request, 'scene/index', 'GET')) {
    const scenes = store
      .scenes()
      .filter((scene) => scene.origin === 'local')
      .map((scene) => {
        const copy = { ...scene }
        delete copy.origin
        return copy
      })
    writeJson(response, 200, { ok: true, value: { version: 1, generatedAt: new Date().toISOString(), scenes } })
    return true
  }

  if (method === 'config' && request.method === 'POST') {
    const body = await readJsonBody(request)
    Object.assign(config, normalizeConfig({ ...config, ...body }))
    writeJson(response, 200, { ok: true, value: await statusPayload(ctx, store, config, deps) })
    return true
  }

  return false
}

/** 上传：原始二进制 + header 传元信息（避免 multipart 解析依赖）。 */
async function handleUpload(request, response, url, store, config, deps) {
  const ctx = deps.ctx
  const caseId = queryValue(url, 'id') || String(request.headers['x-fdehub-case'] ?? '')
  const record = store.caseById(caseId)
  if (record === undefined) {
    writeJson(response, 404, { ok: false, error: { message: 'case not found' } })
    return true
  }
  const rawName = String(request.headers['x-fdehub-name'] ?? 'upload.bin')
  const name = decodeURIComponent(rawName).replace(/[\\/]/g, '_').slice(0, 160)
  const ext = path.extname(name).toLowerCase()
  const kind = AUDIO_EXT.has(ext) ? 'audio' : 'doc'
  const limit = config.maxUploadMB * 1024 * 1024
  const body = await readRawBody(request, limit)
  if (body.length === 0) {
    writeJson(response, 400, { ok: false, error: { message: 'empty upload' } })
    return true
  }
  if (body.length > limit) {
    writeJson(response, 413, { ok: false, error: { message: `文件超过上限 ${config.maxUploadMB}MB` } })
    return true
  }

  const dir = path.join(store.uploadDir, record.id)
  await fsp.mkdir(dir, { recursive: true })
  const safeBase = `${Date.now().toString(36)}-${name.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')}`
  const filePath = path.join(dir, safeBase)
  await fsp.writeFile(filePath, body)

  const base = {
    id: store.id(),
    kind,
    name,
    path: filePath,
    bytes: body.length,
    at: new Date().toISOString(),
    status: 'ok',
    note: '',
    text: '',
    chars: 0,
  }

  if (kind === 'doc') {
    const extracted = await extractText(filePath, name)
    base.text = extracted.text
    base.chars = extracted.text.length
    base.method = extracted.method
    base.note = extracted.note
    base.status = extracted.text === '' ? 'failed' : 'ok'

    // 取不到文字时走宿主模型识图：图片、扫描版 PDF、纯图片 PPT 都落在这里。
    // 只有真的读到字才改 status —— 识不出来就保留 failed，面板会显示原因。
    if (base.text === '') {
      const ocr = await ocrFile(ctx, config, deps.modelHint, filePath, name)
      if (ocr.ok) {
        base.text = ocr.text
        base.chars = ocr.text.length
        base.method = ocr.method
        base.note = ocr.note ?? ''
        base.status = 'ok'
        base.ocrPages = ocr.pages ?? 1
      } else if (ocr.reason !== 'unsupported') {
        base.note = ocr.note || `识图取文失败：${ocr.reason}`
      }
    }
  } else {
    const result = await transcribe(ctx, config, filePath, dir)
    if (result.ok) {
      base.text = result.text
      base.chars = result.text.length
      base.engine = result.engine ?? ''
    } else {
      base.status = 'untranscribed'
      base.note = result.reason ?? ''
    }
  }

  store.addSource(record.id, base)
  if (kind === 'audio' && base.status === 'ok') rebuildTranscript(store, record)
  const fresh = store.caseById(record.id)
  if (fresh.status === 'draft') store.updateCase(record.id, { status: 'collected' })
  writeJson(response, 200, { ok: true, value: { source: base, case: store.caseById(record.id) } })
  return true
}

/** 多条录音按时间拼成一份转写稿，保留分段标记。 */
function rebuildTranscript(store, record) {
  const audios = (record.sources ?? []).filter((entry) => entry.kind === 'audio' && entry.status === 'ok')
  if (audios.length === 0) {
    store.updateCase(record.id, { transcript: null })
    return
  }
  const text = audios
    .map((entry) => `【${entry.name}】\n${entry.text}`)
    .join('\n\n')
    .trim()
  store.updateCase(record.id, {
    transcript: {
      text,
      engine: audios.map((entry) => entry.engine).filter(Boolean).join(', '),
      at: new Date().toISOString(),
      sources: audios.length,
    },
  })
}

const bullet = (items, empty = '（无）') =>
  items.length === 0 ? `- ${empty}` : items.map((item) => `- ${item}`).join('\n')

/** Markdown 蓝图：直接能贴进飞书/Word，不依赖插件。 */
export function renderMarkdown(record, config) {
  const a = record.analysis ?? {}
  const b = a.business ?? {}
  const lines = [
    `# ${a.caseTitle || record.title}`,
    '',
    a.oneLine ? `> ${a.oneLine}` : '',
    '',
    `- 客户：${record.org || '—'}　领域：${record.domain || '—'}${record.industry ? `　行业：${record.industry}` : ''}`,
    `- 生成时间：${a._meta?.at ?? ''}　模型：${a._meta?.route ?? '—'}`,
    a._meta?.truncated ? '- ⚠️ 材料超长已截断，结论覆盖范围有限' : '',
    '',
    '## 一、业务现状',
    '',
    b.summary ?? '',
    '',
    '### 角色与卡点',
    '',
    (b.roles ?? []).length === 0
      ? '- （材料里没有明确角色）'
      : (b.roles ?? []).map((role) => `- **${role.name}**：${role.duty}${role.pain ? `　卡点：${role.pain}` : ''}`).join('\n'),
    '',
    '### 流程',
    '',
    (b.flow ?? []).map((step, index) => `${index + 1}. ${step}`).join('\n') || '1. （材料里没有清晰流程）',
    '',
    '### 系统与数据',
    '',
    (b.systems ?? []).length === 0 ? '- （未提及系统）' : (b.systems ?? []).map((s) => `- **${s.name}**：${s.role}${s.data ? `　数据：${s.data}` : ''}`).join('\n'),
    '',
    `### 数据资产\n\n${bullet(b.dataAssets ?? [])}`,
    '',
    '### 指标',
    '',
    (b.metrics ?? []).length === 0
      ? '- （材料里没有可用数字，这是落地前必须补的）'
      : ['| 指标 | 现状 | 目标 | 口径 |', '| --- | --- | --- | --- |']
          .concat((b.metrics ?? []).map((m) => `| ${m.name} | ${m.current} | ${m.target} | ${m.note} |`))
          .join('\n'),
    '',
    '## 二、痛点',
    '',
    (a.pains ?? []).length === 0
      ? '- （未识别出明确痛点）'
      : (a.pains ?? [])
          .map((p) => `### ${p.title}（严重度 ${p.severity}/5）\n\n- 依据：${p.evidence || '—'}\n- 影响：${p.impact || '—'}`)
          .join('\n\n'),
    '',
    '## 三、AI 机会点',
    '',
    (a.opportunities ?? []).length === 0
      ? '- （未识别出机会点：材料可能不足以支撑判断）'
      : (a.opportunities ?? [])
          .map(
            (o, index) =>
              [
                `### ${index + 1}. ${o.title}`,
                '',
                `- 对应痛点：${o.pain || '—'}`,
                `- AI 形态：${o.aiPattern}　插入点：${o.injection || '—'}`,
                `- 输入：${o.input || '—'}`,
                `- 输出：${o.output || '—'}`,
                `- 人工兜底：${o.humanInLoop || '—'}`,
                `- 可行性 ${o.feasibility}/5　价值 ${o.value}/5　工作量 ${o.effort}`,
                `- 判定指标：${o.proofMetric || '—'}`,
                o.dataNeeded.length > 0 ? `- 还缺数据：${o.dataNeeded.join('；')}` : '',
                o.integration.length > 0 ? `- 要对接：${o.integration.join('；')}` : '',
                o.risk !== '' ? `- 风险：${o.risk}` : '',
              ]
                .filter((line) => line !== '')
                .join('\n'),
          )
          .join('\n\n'),
    '',
    '## 四、落地路径',
    '',
    ['poc', 'pilot', 'scale']
      .map((key) => {
        const stage = a.roadmap?.[key] ?? {}
        const label = { poc: 'PoC', pilot: '试点', scale: '推广' }[key]
        return `### ${label}${stage.days ? `（${stage.days} 天）` : ''}\n\n- 范围：${stage.scope || '—'}\n- 交付物：${stage.deliverable || '—'}\n- 判定标准：${stage.gate || '—'}`
      })
      .join('\n\n'),
    '',
    '## 五、必须回客户确认',
    '',
    bullet(a.openQuestions ?? []),
    '',
    '## 六、这次材料没覆盖的',
    '',
    bullet(a.notCovered ?? []),
    '',
    '---',
    '',
    `材料：${(record.sources ?? []).map((s) => `${s.name}（${s.status}）`).join('、') || '—'}`,
    record.transcript?.engine ? `转写引擎：${record.transcript.engine}` : '',
    `由 dsh-fdehub 生成${config.author ? `　作者：${config.author}` : ''}`,
  ]
  return lines.filter((line) => line !== undefined).join('\n')
}
