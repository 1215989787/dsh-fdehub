/**
 * dsh-fdehub — 业务文件取文。
 *
 * 现场给的材料什么格式都有，这里统一转成可分析的纯文本。策略是「本机已有的
 * 工具优先、不引入 npm 依赖」：
 *
 *   txt/md/csv/json/yaml → 直接读
 *   pdf                 → pdftotext -layout（poppler；macOS 上 homebrew 常备）
 *   doc/docx/rtf/html   → textutil -convert txt（macOS 自带）
 *   pptx/xlsx/docx      → unzip -p 抽 XML 再剥标签（zip 结构稳定）
 *
 * 取不到就如实返回 note，不编内容——分析层会把「这份材料没读到」写进待确认问题，
 * 而不是假装读过了。
 */
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.yaml', '.yml', '.xml', '.html', '.htm', '.sql',
])
const MAX_CHARS = 200000

const stripXml = (xml) =>
  xml
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<a:p[ >]/g, '\n<a:p ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const clip = (text) => {
  const value = String(text ?? '').trim()
  return value.length > MAX_CHARS ? `${value.slice(0, MAX_CHARS)}\n\n…（内容过长，已截断 ${value.length - MAX_CHARS} 字）` : value
}

async function tryExec(file, args, options = {}) {
  try {
    const { stdout } = await run(file, args, { maxBuffer: 32 * 1024 * 1024, timeout: 60000, ...options })
    return stdout
  } catch {
    return undefined
  }
}

/**
 * 取一份文件的文本。
 * @param {string} filePath 绝对路径
 * @param {string} [originalName] 原始文件名（判断扩展名用，临时文件可能改了名）
 * @returns {Promise<{text:string, method:string, note:string}>}
 */
export async function extractText(filePath, originalName) {
  const ext = path.extname(originalName ?? filePath).toLowerCase()

  if (TEXT_EXT.has(ext)) {
    try {
      const raw = await fsp.readFile(filePath, 'utf8')
      // 二进制文件误判成文本时会出现大量 NUL，直接放弃。
      if (raw.includes('\u0000')) return { text: '', method: 'none', note: '文件像是二进制，无法按文本读取' }
      return { text: clip(raw), method: 'read', note: '' }
    } catch (error) {
      return { text: '', method: 'none', note: `读取失败：${error?.message ?? error}` }
    }
  }

  if (ext === '.pdf') {
    const out = await tryExec('pdftotext', ['-layout', '-enc', 'UTF-8', filePath, '-'])
    if (out !== undefined && out.trim() !== '') return { text: clip(out), method: 'pdftotext', note: '' }
    return { text: '', method: 'none', note: '没有可用的 PDF 取文工具（需要 pdftotext），或这份 PDF 是扫描件' }
  }

  if (ext === '.doc' || ext === '.docx' || ext === '.rtf' || ext === '.odt') {
    const out = await tryExec('textutil', ['-convert', 'txt', '-stdout', filePath])
    if (out !== undefined && out.trim() !== '') return { text: clip(out), method: 'textutil', note: '' }
    if (ext === '.docx') {
      const xml = await tryExec('unzip', ['-p', filePath, 'word/document.xml'])
      if (xml !== undefined && xml.trim() !== '') return { text: clip(stripXml(xml)), method: 'unzip', note: '' }
    }
    return { text: '', method: 'none', note: '未能提取 Word 正文（textutil / unzip 都失败）' }
  }

  if (ext === '.pptx') {
    const list = await tryExec('unzip', ['-Z1', filePath])
    if (list === undefined) return { text: '', method: 'none', note: '解压失败，无法读取 PPT 正文' }
    const slides = list
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^ppt\/slides\/slide\d+\.xml$/.test(line))
      .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0))
    const parts = []
    for (const slide of slides) {
      const xml = await tryExec('unzip', ['-p', filePath, slide])
      if (xml === undefined) continue
      const text = stripXml(xml)
      if (text !== '') parts.push(`【第 ${slide.match(/\d+/)?.[0] ?? '?'} 页】\n${text}`)
    }
    if (parts.length === 0) return { text: '', method: 'none', note: 'PPT 里没读到文字（可能全是图片）' }
    return { text: clip(parts.join('\n\n')), method: 'unzip/pptx', note: slides.length > parts.length ? '部分页面读取失败' : '' }
  }

  if (ext === '.xlsx' || ext === '.xls') {
    // 只抽共享字符串表：表格的文字内容基本都在这里，够模型判断「这是什么业务表」
    const shared = await tryExec('unzip', ['-p', filePath, 'xl/sharedStrings.xml'])
    if (shared !== undefined && shared.trim() !== '') {
      const cells = [...shared.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1].trim()).filter((t) => t !== '')
      if (cells.length > 0) {
        return {
          text: clip(cells.join('\n')),
          method: 'unzip/xlsx',
          note: '表格只取文字内容，未保留行列结构与数值',
        }
      }
    }
    return { text: '', method: 'none', note: '未能提取表格文字（xls 旧格式不支持）' }
  }

  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic', '.tif', '.tiff'].includes(ext)) {
    // 图片不走文本读取：交给 lib/ocr.js 用宿主模型识图（见 routes 的兜底逻辑）。
    return { text: '', method: 'image', note: '' }
  }

  // 未知扩展名：先当文本试一次，不行就算了。
  try {
    const raw = await fsp.readFile(filePath, 'utf8')
    if (!raw.includes('\u0000') && raw.trim() !== '') return { text: clip(raw), method: 'read', note: '未知格式，按文本读取' }
  } catch {
    /* 忽略 */
  }
  return { text: '', method: 'none', note: `不支持的格式：${ext || '未知'}` }
}

export { MAX_CHARS }
