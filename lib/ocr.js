/**
 * dsh-fdehub — 图片 / 扫描件取文（走宿主模型本身，不内置 OCR）。
 *
 * 不打包 tesseract 的理由：宿主已经有一个能看图的模型，再塞一个 300MB 的
 * 识别引擎既拖慢安装，也和宿主的模型能力重复。这里只做三件事：
 *
 *   1. 把待识别的材料变成图片（PDF 用 pdftoppm 渲染前 N 页，图片直接用）；
 *   2. 用宿主 `ctx.llm` 的当前路由逐页识图，要求它只抄字不解释；
 *   3. 识不出来就如实返回原因——不支持图片输入的模型、页数超限、调用失败，
 *      三种情况在面板上要能区分开，否则用户只会觉得「这插件坏了」。
 *
 * 成本边界：只在「文本抽取拿不到内容」时才走到这里，且默认最多识别 5 页。
 */
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveRoute } from './analyze.js'

const run = promisify(execFile)

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic', '.tif', '.tiff'])

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
}

/** 单张图最大边长：整页 150dpi 的 A4 约 1240×1754，再大对识别没帮助、只烧 token。 */
const MAX_EDGE = 1600

const PROMPT = `把这张图里的文字全部抄下来，按原顺序、原段落。
要求：
1. 只抄字，不要解释、不要总结、不要补充图里没有的内容；
2. 表格用 Markdown 表格还原，保持行列对应；
3. 手写字看不清就用 □ 代替那一个字；
4. 图里没有文字就只回复：NO_TEXT`

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

/** 用 sips 把超大的图压到可识别尺寸（macOS 自带；其它平台失败就用原图）。 */
async function shrink(imagePath) {
  try {
    const { stdout } = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', imagePath], { timeout: 20000 })
    const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1] ?? 0)
    const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1] ?? 0)
    if (width === 0 || height === 0) return imagePath
    if (Math.max(width, height) <= MAX_EDGE) return imagePath
    const target = `${imagePath}.small.png`
    await run('sips', ['-Z', String(MAX_EDGE), imagePath, '--out', target], { timeout: 60000 })
    return target
  } catch {
    return imagePath
  }
}

/** PDF 渲染前 N 页成 PNG（pdftoppm，poppler 自带）。没有工具就返回空。 */
async function renderPdfPages(pdfPath, outDir, maxPages) {
  try {
    await fsp.mkdir(outDir, { recursive: true })
    const prefix = path.join(outDir, 'page')
    await run(
      'pdftoppm',
      ['-png', '-r', '150', '-f', '1', '-l', String(maxPages), pdfPath, prefix],
      { timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
    )
    const files = (await fsp.readdir(outDir))
      .filter((name) => name.startsWith('page') && name.endsWith('.png'))
      .sort()
      .map((name) => path.join(outDir, name))
    return files
  } catch {
    return []
  }
}

/**
 * 用宿主模型识图取文。
 *
 * @returns {Promise<{ok:boolean, text?:string, method?:string, pages?:number, reason?:string, note?:string}>}
 */
export async function ocrFile(ctx, config, modelHint, filePath, name) {
  if (config.ocrEnabled !== true) return { ok: false, reason: 'ocr-off' }
  const llm = getLlm(ctx)
  if (llm === undefined || typeof llm.stream !== 'function') return { ok: false, reason: 'llm-unavailable' }
  const { provider, model } = resolveRoute(config, modelHint)
  if (provider === '' || model === '') return { ok: false, reason: 'route-unknown' }

  const ext = path.extname(name ?? filePath).toLowerCase()
  let images = []
  let sourceKind = 'image'

  if (IMAGE_EXT.has(ext)) {
    images = [filePath]
  } else if (ext === '.pdf') {
    sourceKind = 'pdf'
    images = await renderPdfPages(filePath, path.join(path.dirname(filePath), 'ocr'), config.ocrMaxPages ?? 5)
    if (images.length === 0) return { ok: false, reason: 'render-failed', note: '需要 pdftoppm 才能把扫描件转成图片' }
  } else {
    return { ok: false, reason: 'unsupported' }
  }

  const parts = []
  let failure = ''
  for (const image of images.slice(0, config.ocrMaxPages ?? 5)) {
    const prepared = await shrink(image)
    let base64
    try {
      base64 = (await fsp.readFile(prepared)).toString('base64')
    } catch {
      continue
    }
    const mime = MIME[path.extname(prepared).toLowerCase()] ?? 'image/png'
    const text = await askModel(ctx, { provider, model }, mime, base64)
    if (text.ok) {
      if (text.text !== '' && !/^NO_TEXT$/i.test(text.text)) parts.push(text.text)
    } else {
      failure = text.reason
      break
    }
  }

  if (parts.length === 0) {
    return {
      ok: false,
      reason: failure || 'no-text',
      note:
        failure === 'image-unsupported'
          ? '当前模型不支持图片输入，换一个多模态模型再试'
          : failure === 'llm-error'
            ? '模型调用失败'
            : '图里没识别出文字',
    }
  }
  return {
    ok: true,
    text: parts.join(`\n\n--- 第 ${sourceKind === 'pdf' ? '页' : '张'}分隔 ---\n\n`),
    method: `model-ocr(${provider}/${model})`,
    pages: parts.length,
    note: images.length > (config.ocrMaxPages ?? 5) ? `只识别了前 ${config.ocrMaxPages ?? 5} 页` : '',
  }
}

/** 一次识图请求。图片内容块先按主流形状试，失败再换 data URL 形状。 */
async function askModel(ctx, route, mime, base64) {
  const llm = getLlm(ctx)
  const shapes = [
    { type: 'image', mediaType: mime, data: base64 },
    { type: 'image', mimeType: mime, data: base64 },
    { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
  ]
  let lastError = ''
  for (const imagePart of shapes) {
    let text = ''
    try {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        purpose: 'dsh-fdehub-ocr',
        messages: [
          {
            role: 'user',
            source: { kind: 'dsh-fdehub' },
            content: [{ type: 'text', text: PROMPT }, imagePart],
          },
        ],
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'finish') break
        if (chunk?.type === 'error') {
          lastError = 'llm-error'
          break
        }
        if (chunk?.type === 'aborted') break
        text += deltaOf(chunk)
      }
      const value = text.trim()
      if (value !== '') return { ok: true, text: value }
      // 空输出：可能是形状不被接受，换下一种
    } catch (error) {
      lastError = String(error?.message ?? error)
      // 明确「不支持图片」时不用再试其它形状，早点把原因报给用户
      if (/image|vision|modality|unsupported/i.test(lastError)) return { ok: false, reason: 'image-unsupported' }
    }
  }
  return { ok: false, reason: lastError === '' ? 'image-unsupported' : 'llm-error' }
}
