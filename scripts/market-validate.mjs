/**
 * market:validate — 离线上架门禁（零依赖手写校验，对齐 registry/schema/scene.schema.json）。
 *
 * 市场收录的不是案例，是方法。所以门禁盯的是「能不能被别人复用」，
 * 而不是文案写得好不好看：
 *
 *   1. 五要素齐全：injection / inputs / outputs / humanInLoop / proofMetric；
 *   2. proofMetric 必须带数字或时间窗（「效率提升」不算指标）；
 *   3. id 合法且与文件名一致，全库唯一；
 *   4. effort 只能是 S/M/L，featured 不能超过三成（避免首页全是关系户）；
 *   5. 粗筛客户敏感信息：手机号、邮箱、身份证、内部 IP、疑似车型/项目代号。
 *
 *   node scripts/market-validate.mjs
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

const root = new URL('..', import.meta.url).pathname
const scenesDir = path.join(root, 'registry/scenes')

const REQUIRED = ['id', 'title', 'domain', 'summary', 'aiPattern', 'injection', 'inputs', 'outputs', 'humanInLoop', 'proofMetric']
const SENSITIVE = [
  { re: /\b1[3-9]\d{9}\b/, label: '手机号' },
  { re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/, label: '邮箱' },
  { re: /\b\d{17}[\dXx]\b/, label: '身份证' },
  { re: /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/, label: '内网 IP' },
  { re: /https?:\/\/(?:[^/\s]*\.)?(?:corp|internal|local)(?:[/:.\s]|$)/i, label: '内部地址' },
]

const files = (await fsp.readdir(scenesDir)).filter((name) => name.endsWith('.json'))
const errors = []
const warnings = []
const ids = new Set()
let published = 0
let featured = 0

for (const file of files.sort()) {
  const rel = `registry/scenes/${file}`
  let card
  try {
    card = JSON.parse(await fsp.readFile(path.join(scenesDir, file), 'utf8'))
  } catch (error) {
    errors.push(`${rel}: JSON 解析失败 —— ${error.message}`)
    continue
  }

  for (const key of REQUIRED) {
    const value = card[key]
    if (typeof value !== 'string' || value.trim() === '') errors.push(`${rel}: 缺少必填字段 ${key}`)
  }
  if (typeof card.id === 'string' && !/^[a-z0-9][a-z0-9_-]*$/.test(card.id)) {
    errors.push(`${rel}: id 只能是 [a-z0-9_-]，且不能以符号开头`)
  }
  if (card.id !== path.basename(file, '.json')) errors.push(`${rel}: id（${card.id}）与文件名不一致`)
  if (ids.has(card.id)) errors.push(`${rel}: id 重复（${card.id}）`)
  ids.add(card.id)

  if (typeof card.title === 'string' && card.title.length > 40) warnings.push(`${rel}: title 超过 40 字，面板上会被截断`)
  if (card.effort !== undefined && !['S', 'M', 'L'].includes(card.effort)) {
    errors.push(`${rel}: effort 只能是 S / M / L`)
  }
  // 判定指标要能被反驳：至少得有一个数字或时间窗
  if (typeof card.proofMetric === 'string' && !/\d/.test(card.proofMetric)) {
    errors.push(`${rel}: proofMetric 里没有任何数字，不可测量`)
  }
  if (typeof card.injection === 'string' && card.injection.length < 6) {
    warnings.push(`${rel}: injection 太短，说不清插在谁手上、什么时点`)
  }
  if (!Array.isArray(card.risks) || card.risks.length === 0) warnings.push(`${rel}: 没写 risks，只讲好处的场景卡价值为零`)

  const blob = JSON.stringify(card)
  for (const { re, label } of SENSITIVE) {
    if (re.test(blob)) errors.push(`${rel}: 疑似包含${label}，市场里不能放`)
  }

  if (card.published !== false) published += 1
  if (card.featured === true) featured += 1
}

if (published > 0 && featured / published > 0.3) {
  errors.push(`featured 占 ${featured}/${published} 超过 30%，首页会被少数条目占满`)
}
if (published === 0) errors.push('一条已发布场景都没有')

for (const message of warnings) console.warn(`⚠ ${message}`)
if (errors.length > 0) {
  for (const message of errors) console.error(`✗ ${message}`)
  console.error(`\n上架门禁未通过：${errors.length} 个错误，${warnings.length} 个警告`)
  process.exit(1)
}
console.log(`✓ 上架门禁通过：${published} 条已发布（featured ${featured}），${warnings.length} 个警告`)
