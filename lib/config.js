/**
 * dsh-fdehub — 配置归一化。
 *
 * 所有开关都有安全默认值：配置写错、字段缺失、宿主升级改了名，
 * 插件都照常启动（最多少一个能力），不会因为一个 typo 整块不加载。
 * 面板 POST /fdehub/api/config 会就地更新同一份对象，各模块共享引用。
 */
import os from 'node:os'
import path from 'node:path'

const str = (value, fallback = '') => (typeof value === 'string' ? value.trim() : fallback)

const int = (value, fallback, min, max) => {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)

/** 数据根目录：默认 $DSH_HOME/fdehub，与宿主的会话/存储同盘。 */
export function resolveDataDir(raw) {
  const explicit = str(raw)
  if (explicit !== '') return path.resolve(explicit)
  const home = str(process.env.DSH_HOME) || path.join(os.homedir(), '.dsh')
  return path.join(home, 'fdehub')
}

export function normalizeConfig(rawConfig) {
  const raw = rawConfig ?? {}
  const config = {
    enabled: bool(raw.enabled, true),
    dataDir: resolveDataDir(raw.dataDir),
    lang: oneOf(str(raw.lang, 'zh'), ['zh', 'en', 'auto'], 'zh'),
    maxUploadMB: int(raw.maxUploadMB, 200, 1, 2048),

    asrMode: oneOf(str(raw.asrMode, 'auto'), ['auto', 'host', 'local', 'off'], 'auto'),
    asrCommand: str(raw.asrCommand),
    asrTimeoutSec: int(raw.asrTimeoutSec, 1800, 30, 7200),
    ffmpegPath: str(raw.ffmpegPath, 'ffmpeg'),

    llmProvider: str(raw.llmProvider),
    llmModel: str(raw.llmModel),
    analysisMaxChars: int(raw.analysisMaxChars, 60000, 4000, 400000),
    maxOpportunities: int(raw.maxOpportunities, 5, 1, 8),

    // 图片 / 扫描件取文：走宿主模型本身，不内置 OCR 引擎。
    ocrEnabled: bool(raw.ocrEnabled, true),
    // PDF 扫描件最多识别前 N 页（每页一次模型请求，页数直接等于成本和等待时间）
    ocrMaxPages: int(raw.ocrMaxPages, 5, 1, 50),

    indexUrl: str(raw.indexUrl),
    author: str(raw.author),
    org: str(raw.org),
  }
  return config
}

/** 面板要显示的配置快照（把绝对路径带上，方便用户直接去翻文件）。 */
export function publicConfig(config) {
  return { ...config, maxUploadBytes: config.maxUploadMB * 1024 * 1024 }
}
