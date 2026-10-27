/**
 * dsh-fdehub — 业务 + AI 逻辑梳理（核心）。
 *
 * 输入：现场转写稿 / 上传的业务材料 / 用户补的一句话背景。
 * 输出：一份能直接拿去过会的结构化蓝图 ——
 *
 *   业务画像（角色 / 流程 / 系统 / 数据 / 指标）
 *     → 痛点（每条挂证据与影响）
 *       → AI 机会点（插在流程哪一步、输入输出、人工兜底、可行性×价值）
 *         → 落地路径（PoC / 试点 / 推广，各自的交付物与判定指标）
 *           → 待确认问题（现场没问到的，明确列出来而不是猜）
 *
 * 三条硬约束：
 *  1. 复用宿主 `ctx.llm` 通道与当前会话路由，不引入新凭据；
 *  2. 不许编：prompt 明确要求「没有依据就不写」，没覆盖到的信息进 notCovered；
 *  3. 失败可降级：模型不可用时返回 undefined，面板提示「只能存档不能分析」，
 *     不会给出一份看似完整的空气蓝图。
 */
import { MAX_CHARS } from './extract.js'

const SYSTEM_PROMPT = `你是资深 FDE（Forward Deployed Engineer，驻场交付工程师）。你的任务不是写报告，而是把一次现场沟通变成一份能让客户点头、让研发能开工的「业务 + AI 逻辑」。

工作原则：
1. 只写材料里有依据的内容。材料没说到的角色、系统、数字，一律不要补全；把「不知道什么」写进 notCovered。
2. 痛点必须挂证据：引用原话或材料里的具体说法（evidence 字段），不要写「效率低」这种没有出处的判断。
3. 机会点必须挂在具体流程步骤上（injection 字段写清插在哪一步、在谁手上）。凡是说不清插在哪里的，就不是机会点，是口号。
4. 每个机会点都要有：输入是什么、输出给谁、人工在哪一步兜底（humanInLoop）、用什么指标证明有效（proofMetric）。
5. 可行性（feasibility）与价值（value）用 1-5 打分，打分理由要能被反驳——不要一律给 5。
6. 中文，陈述句，不用「赋能 / 闭环 / 生态 / 底座 / 抓手 / 打通」这类词。术语第一次出现时用一句话解释。
7. 数字优先：材料里出现的比例、时长、人天、金额、单据量，全部抓进 metrics 或 pains 的 impact 里。

输出必须是 JSON 对象，字段如下（不要输出任何解释、不要 markdown 代码块）：
{
  "caseTitle": "16 字以内的本次梳理标题",
  "oneLine": "一句话说清这次要解决什么",
  "business": {
    "summary": "3-5 句话说清这条业务现在怎么跑的",
    "roles": [{"name": "岗位", "duty": "他负责什么", "pain": "他在哪一步卡住"}],
    "flow": ["按顺序的流程步骤，每步 8-20 字"],
    "systems": [{"name": "系统名", "role": "在流程里干什么", "data": "产生或承载什么数据"}],
    "dataAssets": ["可用的数据资产，带形态：如 工单文本 / 设备时序 / 报价单 PDF"],
    "metrics": [{"name": "指标", "current": "现状值", "target": "目标值", "note": "口径"}]
  },
  "pains": [{"title": "痛点短标题", "evidence": "材料里的原话或具体事实", "impact": "造成什么后果，尽量量化", "severity": 1}],
  "opportunities": [{
    "title": "机会点短标题",
    "pain": "对应哪条痛点",
    "aiPattern": "规则 / 检索增强 / 信息抽取 / 多模态识别 / 预测 / 生成 / Agent 编排 之一",
    "injection": "插在流程哪一步、谁来用",
    "input": "模型吃什么",
    "output": "输出什么形态、给谁看",
    "humanInLoop": "哪一步必须人确认",
    "feasibility": 3,
    "value": 4,
    "dataNeeded": ["还需要什么数据才能跑"],
    "integration": ["要对接的系统或接口"],
    "risk": "最可能翻车的地方",
    "effort": "S / M / L",
    "proofMetric": "用什么指标、在多长时间内证明它有效"
  }],
  "roadmap": {
    "poc": {"scope": "两周内能验证的最小范围", "days": 10, "deliverable": "交付物", "gate": "过不过的判定标准"},
    "pilot": {"scope": "试点范围", "days": 30, "deliverable": "交付物", "gate": "判定标准"},
    "scale": {"scope": "推广条件", "days": 90, "deliverable": "交付物", "gate": "判定标准"}
  },
  "openQuestions": ["必须回客户确认的问题，每条要具体到能一句话问出口"],
  "notCovered": ["这次材料完全没涉及、但落地前必须补齐的信息"]
}`

/** 从可能带围栏 / 前后废话 / 截断的输出里抠出 JSON 对象。 */
export function parseBlueprint(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return undefined
  const cleaned = text
    .replace(/^\uFEFF/, '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim()

  const attempt = (candidate) => {
    try {
      const parsed = JSON.parse(candidate)
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  const direct = attempt(cleaned)
  if (direct !== undefined) return normalizeBlueprint(direct)

  const start = cleaned.indexOf('{')
  if (start === -1) return undefined
  const end = cleaned.lastIndexOf('}')
  if (end > start) {
    const sliced = attempt(cleaned.slice(start, end + 1))
    if (sliced !== undefined) return normalizeBlueprint(sliced)
  }
  // 流被截断：从尾部逐级回退，每档配几种闭合后缀（数组/对象/字符串三种断点）。
  // 只补一个 `}` 是修不好 `"pains":[{...}` 这种断在数组里的情况的。
  const suffixes = ['', '}', ']}', '}]}', '}}', '"}]}', '"]}}', 'null}]}', '"}]}}']
  const limit = end > start ? end + 1 : cleaned.length
  const step = Math.max(12, Math.floor((limit - start) / 16))
  for (let cut = limit; cut > start + 12; cut -= step) {
    const head = cleaned.slice(start, cut)
    for (const suffix of suffixes) {
      const parsed = attempt(head + suffix)
      if (parsed !== undefined) return normalizeBlueprint(parsed)
    }
  }
  return undefined
}

const asText = (value) => (typeof value === 'string' ? value.trim() : '')
const asArray = (value) => (Array.isArray(value) ? value : [])
const asScore = (value, fallback = 3) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : fallback
}

/** 收口：模型输出形状不稳，这里统一成面板敢直接渲染的结构。 */
export function normalizeBlueprint(raw) {
  const business = raw.business ?? {}
  return {
    caseTitle: asText(raw.caseTitle),
    oneLine: asText(raw.oneLine),
    business: {
      summary: asText(business.summary),
      roles: asArray(business.roles)
        .map((item) => ({ name: asText(item?.name), duty: asText(item?.duty), pain: asText(item?.pain) }))
        .filter((item) => item.name !== ''),
      flow: asArray(business.flow).map(asText).filter((item) => item !== ''),
      systems: asArray(business.systems)
        .map((item) => ({ name: asText(item?.name), role: asText(item?.role), data: asText(item?.data) }))
        .filter((item) => item.name !== ''),
      dataAssets: asArray(business.dataAssets).map(asText).filter((item) => item !== ''),
      metrics: asArray(business.metrics)
        .map((item) => ({
          name: asText(item?.name),
          current: asText(item?.current),
          target: asText(item?.target),
          note: asText(item?.note),
        }))
        .filter((item) => item.name !== ''),
    },
    pains: asArray(raw.pains)
      .map((item) => ({
        title: asText(item?.title),
        evidence: asText(item?.evidence),
        impact: asText(item?.impact),
        severity: asScore(item?.severity),
      }))
      .filter((item) => item.title !== ''),
    opportunities: asArray(raw.opportunities)
      .map((item) => ({
        title: asText(item?.title),
        pain: asText(item?.pain),
        aiPattern: asText(item?.aiPattern) || '未标注',
        injection: asText(item?.injection),
        input: asText(item?.input),
        output: asText(item?.output),
        humanInLoop: asText(item?.humanInLoop),
        feasibility: asScore(item?.feasibility),
        value: asScore(item?.value),
        dataNeeded: asArray(item?.dataNeeded).map(asText).filter((text) => text !== ''),
        integration: asArray(item?.integration).map(asText).filter((text) => text !== ''),
        risk: asText(item?.risk),
        effort: asText(item?.effort).toUpperCase() || 'M',
        proofMetric: asText(item?.proofMetric),
      }))
      .filter((item) => item.title !== ''),
    roadmap: {
      poc: normalizeStage(raw.roadmap?.poc),
      pilot: normalizeStage(raw.roadmap?.pilot),
      scale: normalizeStage(raw.roadmap?.scale),
    },
    openQuestions: asArray(raw.openQuestions).map(asText).filter((item) => item !== ''),
    notCovered: asArray(raw.notCovered).map(asText).filter((item) => item !== ''),
  }
}

function normalizeStage(raw) {
  return {
    scope: asText(raw?.scope),
    days: Number.isFinite(Number(raw?.days)) ? Number(raw.days) : 0,
    deliverable: asText(raw?.deliverable),
    gate: asText(raw?.gate),
  }
}

/** 把材料拼成一次请求：转写稿在前，材料按文件分段。 */
export function renderMaterial({ transcript, documents, brief, maxChars }) {
  const limit = maxChars ?? MAX_CHARS
  const parts = []
  if (brief !== '') parts.push(`## 补充背景（用户提供）\n${brief}`)
  if (transcript !== '') parts.push(`## 现场沟通转写稿\n${transcript}`)
  for (const doc of documents) {
    parts.push(`## 业务材料：${doc.name}\n${doc.text}`)
  }
  let joined = parts.join('\n\n')
  let truncated = false
  if (joined.length > limit) {
    joined = `${joined.slice(0, limit)}\n\n…（材料超长，已截断，后面的内容模型没看到）`
    truncated = true
  }
  return { text: joined, truncated, chars: joined.length }
}

function deltaOf(chunk) {
  if (chunk?.type !== 'text-delta') return ''
  if (typeof chunk.text === 'string') return chunk.text
  if (typeof chunk.delta === 'string') return chunk.delta
  return ''
}

function getLlm(ctx) {
  if (typeof ctx?.get !== 'function') return undefined
  try {
    return ctx.get('llm', false) ?? undefined
  } catch {
    return undefined
  }
}

/** 解析本次调用该用哪个路由：配置优先，其次跟随当前会话。 */
export function resolveRoute(config, modelHint) {
  const provider = config.llmProvider !== '' ? config.llmProvider : String(modelHint?.provider ?? '')
  const model = config.llmModel !== '' ? config.llmModel : String(modelHint?.model ?? '')
  return { provider, model }
}

export function llmStatus(ctx, config, modelHint) {
  const llm = getLlm(ctx)
  if (llm === undefined) return { available: false, reason: 'service-missing', route: '' }
  if (typeof llm.stream !== 'function') return { available: false, reason: 'stream-missing', route: '' }
  const { provider, model } = resolveRoute(config, modelHint)
  if (provider === '' || model === '') return { available: false, reason: 'route-unknown', route: '' }
  return { available: true, reason: '', route: `${provider}/${model}` }
}

/**
 * 跑一次分析。
 * @returns {Promise<{ok:boolean, blueprint?:object, route?:string, truncated?:boolean, reason?:string, chars?:number}>}
 */
export async function analyze(ctx, config, material, modelHint, signal) {
  const llm = getLlm(ctx)
  if (llm === undefined || typeof llm.stream !== 'function') return { ok: false, reason: 'llm-unavailable' }
  const { provider, model } = resolveRoute(config, modelHint)
  if (provider === '' || model === '') return { ok: false, reason: 'route-unknown' }
  if (material.text.trim() === '') return { ok: false, reason: 'empty-material' }

  let text = ''
  try {
    const stream = llm.stream({
      provider,
      model,
      system: SYSTEM_PROMPT,
      purpose: 'dsh-fdehub-analysis',
      messages: [
        {
          role: 'user',
          source: { kind: 'dsh-fdehub' },
          content: [
            {
              type: 'text',
              text: `下面是这次要梳理的全部材料。请输出 JSON。机会点最多 ${config.maxOpportunities} 个，按「价值×可行性」从高到低排，其余不要凑数。\n\n${material.text}`,
            },
          ],
        },
      ],
      ...(signal === undefined ? {} : { signal }),
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'finish' || chunk?.type === 'error' || chunk?.type === 'aborted') break
      text += deltaOf(chunk)
    }
  } catch (error) {
    ctx?.logger?.debug?.('dsh-fdehub: llm analysis failed: %o', error)
    return { ok: false, reason: 'llm-error' }
  }

  const blueprint = parseBlueprint(text)
  if (blueprint === undefined) return { ok: false, reason: 'parse-failed', chars: material.chars }
  return { ok: true, blueprint, route: `${provider}/${model}`, truncated: material.truncated, chars: material.chars }
}

/** 从蓝图抽一张可发布到场景市场的场景卡（不含客户敏感细节）。 */
export function toSceneCard(blueprint, meta, config) {
  const best = blueprint.opportunities.slice().sort((a, b) => b.value * b.feasibility - a.value * a.feasibility)[0]
  return {
    id: `local-${Date.now().toString(36)}`,
    title: blueprint.caseTitle || meta.title || '未命名场景',
    domain: meta.domain ?? '未分类',
    industry: meta.industry ?? '',
    summary: blueprint.oneLine,
    pain: blueprint.pains[0]?.title ?? '',
    aiPattern: best?.aiPattern ?? '',
    injection: best?.injection ?? '',
    inputs: best?.input ?? '',
    outputs: best?.output ?? '',
    humanInLoop: best?.humanInLoop ?? '',
    proofMetric: best?.proofMetric ?? '',
    effort: best?.effort ?? 'M',
    metrics: blueprint.business.metrics.slice(0, 4).map((item) => `${item.name} ${item.current}→${item.target}`),
    risks: blueprint.opportunities.map((item) => item.risk).filter((text) => text !== '').slice(0, 3),
    author: config.author,
    org: config.org,
    version: '0.1.0',
    license: 'CC-BY-4.0',
    createdAt: new Date().toISOString(),
    origin: 'local',
  }
}
