/**
 * dsh-fdehub — 给 agent 用的工具。
 *
 * 面板是给人用的，工具是给模型用的：现场回来直接在对话里说「把 fde 案例 xxx
 * 梳理一下」「找找有没有类似的营销场景」，比手点面板快。
 *
 * 注册契约与社区插件一致：
 *   ctx.inject(['tools'], (sctx) => sctx.effect(() => sctx.tools.register(tool)))
 * 不 import @deepseek-ai/dsh-tools 的 defineTool —— 少一个运行时依赖，
 * 对象形状保持同样字段即可（name / description / parameters / output / execute）。
 */
import { analyze, renderMaterial, toSceneCard } from './analyze.js'
import { asrStatus } from './asr.js'
import { listScenes, normalizeScene, sceneById, toPublishPayload } from './registry.js'

const text = (value) => (typeof value === 'string' ? value : '')

const ok = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

export function registerFdeHubTools(ctx, store, config, deps) {
  if (typeof ctx?.inject !== 'function') return
  ctx.inject(['tools'], (sctx) => {
    const listenCtx = sctx.root ?? sctx
    sctx.effect(() => {
      const disposers = [
        sctx.tools.register(toolCaseList(store)),
        sctx.tools.register(toolCaseRead(store)),
        sctx.tools.register(toolAnalyze(store, config, deps)),
        sctx.tools.register(toolSceneSearch(store, config)),
        sctx.tools.register(toolScenePublish(store, config)),
        sctx.tools.register(toolStatus(store, config, deps)),
      ]
      return () => {
        for (const dispose of disposers) {
          try {
            if (typeof dispose === 'function') dispose()
            else dispose?.dispose?.()
          } catch {
            /* 单个工具卸载失败不影响其它 */
          }
        }
      }
    }, 'dsh-fdehub: tools')
    void listenCtx
  })
}

function toolCaseList(store) {
  return {
    name: 'fde_case_list',
    description:
      'List FDE cases (site recordings / uploaded business documents collected for a business+AI analysis). Returns id, title, domain, status and source counts. Use this to find the case the user is talking about.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', description: 'Optional filter: draft | collected | analyzed | published.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => ok(value.cases.map((entry) => `${entry.id} · ${entry.title} · ${entry.domain} · ${entry.status} · ${entry.sources.length} 份材料`).join('\n') || '（还没有案例）'),
    },
    async execute(args) {
      const status = text(args?.status)
      const cases = store.cases().filter((entry) => status === '' || entry.status === status)
      return {
        cases: cases.map((entry) => ({
          id: entry.id,
          title: entry.title,
          domain: entry.domain,
          status: entry.status,
          sources: (entry.sources ?? []).length,
          updatedAt: entry.updatedAt,
        })),
      }
    },
  }
}

function toolCaseRead(store) {
  return {
    name: 'fde_case_read',
    description:
      'Read one FDE case: collected materials (transcripts / extracted document text) and the structured business+AI blueprint if it has been analyzed. Use before editing or summarizing a case.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Case id from fde_case_list.' },
        includeText: { type: 'boolean', description: 'Include raw material text (default false; can be very long).' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => ok(value.summary),
    },
    async execute(args) {
      const record = store.caseById(text(args?.id))
      if (record === undefined) return { error: 'case not found', summary: '案例不存在' }
      const includeText = args?.includeText === true
      const summary = [
        `# ${record.title}`,
        `状态：${record.status}　领域：${record.domain}　客户：${record.org || '—'}`,
        record.brief ? `背景：${record.brief}` : '',
        '',
        '## 材料',
        ...(record.sources ?? []).map((source) => `- ${source.name}（${source.kind}/${source.status}${source.chars ? ` ${source.chars} 字` : ''}）${source.note ? ` ⚠️ ${source.note}` : ''}`),
        record.analysis === null ? '\n还没做分析。' : '',
        record.analysis === null ? '' : `\n## 蓝图\n${JSON.stringify(record.analysis, null, 2)}`,
      ]
        .filter(Boolean)
        .join('\n')
      return {
        summary,
        case: {
          ...record,
          sources: (record.sources ?? []).map((source) => ({ ...source, text: includeText ? source.text : undefined })),
          transcript: includeText ? record.transcript : record.transcript === null ? null : { ...record.transcript, text: undefined },
        },
      }
    },
  }
}

function toolAnalyze(store, config, deps) {
  return {
    name: 'fde_analyze',
    description:
      'Run the FDE business+AI analysis on a case: turns transcripts and uploaded documents into a structured blueprint (business flow, pains with evidence, AI opportunities with injection point and human-in-the-loop, PoC/pilot/scale roadmap, open questions). Requires the host model channel.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Case id from fde_case_list.' },
        brief: { type: 'string', description: 'Optional extra context to steer the analysis.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => ok(value.message),
    },
    async execute(args) {
      const record = store.caseById(text(args?.id))
      if (record === undefined) return { ok: false, message: '案例不存在' }
      const brief = text(args?.brief) || String(record.brief ?? '')
      const documents = (record.sources ?? [])
        .filter((entry) => entry.kind !== 'audio' && typeof entry.text === 'string' && entry.text.trim() !== '')
        .map((entry) => ({ name: entry.name, text: entry.text }))
      const material = renderMaterial({
        transcript: String(record.transcript?.text ?? ''),
        documents,
        brief,
        maxChars: config.analysisMaxChars,
      })
      if (material.text.trim() === '') return { ok: false, message: '案例里没有可分析的材料（先录音/上传/粘贴）' }
      const result = await analyze(deps.ctx, config, material, deps.modelHint)
      if (!result.ok) return { ok: false, message: `分析失败：${result.reason}` }
      store.updateCase(record.id, {
        status: 'analyzed',
        analysis: {
          ...result.blueprint,
          _meta: { at: new Date().toISOString(), route: result.route, truncated: result.truncated, chars: result.chars },
        },
      })
      const o = result.blueprint
      return {
        ok: true,
        message: [
          `已梳理：${o.caseTitle || record.title}`,
          o.oneLine,
          '',
          `痛点 ${o.pains.length} 条｜机会点 ${o.opportunities.length} 个｜待确认 ${o.openQuestions.length} 条`,
          ...o.opportunities.map((item, index) => `${index + 1}. ${item.title}（价值 ${item.value}/5 · 可行性 ${item.feasibility}/5 · ${item.effort}）— ${item.injection}`),
        ].join('\n'),
      }
    },
  }
}

function toolSceneSearch(store, config) {
  return {
    name: 'fde_scene_search',
    description:
      'Search the AI+business scenario marketplace (local published scenes + bundled seeds + optional remote GitHub index). Returns scenario cards with the AI pattern, injection point, inputs/outputs and proof metric.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Free text: business domain, pain, AI pattern.' },
        domain: { type: 'string', description: 'Optional exact domain filter (e.g. 营销, 制造, 供应链).' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => ok(value.scenes.map((scene) => `${scene.title}（${scene.domain}）— ${scene.summary}`).join('\n') || '没有匹配的场景'),
    },
    async execute(args) {
      const result = await listScenes(store, config, { query: text(args?.query), domain: text(args?.domain) })
      return { total: result.total, remoteError: result.remoteError, scenes: result.scenes.slice(0, 20) }
    },
  }
}

function toolScenePublish(store, config) {
  return {
    name: 'fde_scene_publish',
    description:
      'Publish an analyzed FDE case into the scenario marketplace as a reusable card (local store + PR-ready JSON for the GitHub scenes index).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Case id (must be analyzed).' },
        domain: { type: 'string', description: 'Optional domain override.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => ok(value.message),
    },
    async execute(args) {
      const record = store.caseById(text(args?.id))
      if (record === undefined || record.analysis === null) return { ok: false, message: '案例不存在或还没分析' }
      const card = toSceneCard(
        record.analysis,
        { title: record.title, domain: text(args?.domain) || record.domain, industry: record.industry },
        config,
      )
      const scene = normalizeScene(card, 'local')
      if (scene === undefined) return { ok: false, message: '场景卡生成失败' }
      store.upsertScene(scene)
      store.updateCase(record.id, { sceneId: scene.id, status: 'published' })
      const payload = toPublishPayload(scene, config)
      return { ok: true, message: `已发布场景：${scene.title}（${scene.id}）\n\n提交到 GitHub：\n${payload.markdown}` }
    },
  }
}

function toolStatus(store, config, deps) {
  return {
    name: 'fdehub_status',
    description:
      'Report dsh-fdehub readiness: case/scene counts, whether transcription is available and with which engine, whether the model channel is usable, and where data is stored.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => ok(value.message),
    },
    async execute() {
      const asr = await asrStatus(deps.ctx, config)
      const stats = store.stats()
      return {
        message: [
          `案例 ${stats.cases} 个（已分析 ${stats.analyzed}）｜场景 ${stats.scenes} 条`,
          `转写：${asr.available ? asr.engine : '不可用'}${asr.available ? '' : ` — ${asr.reason}`}`,
          `数据目录：${stats.dataDir}`,
        ].join('\n'),
      }
    },
  }
}

export { sceneById }
