/**
 * dsh-fdehub — 录音转写（ASR）。
 *
 * 引擎链，永远不假装成功：
 *   1. 宿主语音服务（若这个宿主版本提供 speech/asr/stt 服务）——零配置、音频不出本机；
 *   2. 本地命令（asrCommand 模板，mlx-whisper / whisper.cpp 等）——需要用户自己装模型；
 *   3. 都没有 → 返回 ok:false + 原因，面板标「未转写」，允许手动粘文稿。
 *
 * 第三条是设计而不是缺陷：编一段假转写比没有转写危险得多，
 * 下游的「业务+AI 逻辑」会建在空气上。
 */
import { execFile, exec } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const runShell = promisify(exec)

/** 机会性取宿主的语音服务（不同版本可能叫不同名字）。 */
function findHostSpeech(ctx) {
  for (const name of ['speech', 'asr', 'stt', 'transcription']) {
    if (typeof ctx?.get !== 'function') break
    try {
      const service = ctx.get(name, false)
      if (service === undefined || service === null) continue
      if (typeof service.transcribe === 'function' || typeof service.recognize === 'function') {
        return { name, service }
      }
    } catch {
      /* 未注入的服务读取会抛，忽略 */
    }
  }
  return undefined
}

/** 从各种可能的返回形状里抠出文本。 */
function textOf(result) {
  if (typeof result === 'string') return result.trim()
  if (result === null || typeof result !== 'object') return ''
  for (const key of ['text', 'transcript', 'result', 'content']) {
    if (typeof result[key] === 'string' && result[key].trim() !== '') return result[key].trim()
  }
  if (Array.isArray(result.segments)) {
    return result.segments
      .map((segment) => (typeof segment === 'string' ? segment : segment?.text ?? ''))
      .join('\n')
      .trim()
  }
  return ''
}

/** 用 ffmpeg 统一成 16k 单声道 wav；失败就返回原文件（宿主服务也许自己能解）。 */
export async function toWav(config, inputPath, outDir) {
  const base = path.basename(inputPath).replace(/\.[^.]+$/, '')
  const target = path.join(outDir, `${base}.16k.wav`)
  try {
    await runFile(
      config.ffmpegPath,
      ['-y', '-i', inputPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', target],
      { timeout: 300000, maxBuffer: 8 * 1024 * 1024 },
    )
    const stat = await fsp.stat(target)
    if (stat.size > 44) return target
  } catch {
    /* ffmpeg 缺失或解码失败，退回原文件 */
  }
  return inputPath
}

/** 宿主服务：签名随版本变化，逐个试，成功即止。 */
async function viaHostSpeech(ctx, wavPath) {
  const found = findHostSpeech(ctx)
  if (found === undefined) return { ok: false, reason: 'host-service-missing' }
  const { name, service } = found
  const call = typeof service.transcribe === 'function' ? service.transcribe.bind(service) : service.recognize.bind(service)
  const attempts = [
    () => call({ audio: wavPath, path: wavPath, language: 'zh' }),
    () => call({ file: wavPath, language: 'zh' }),
    () => call(wavPath, { language: 'zh' }),
  ]
  for (const attempt of attempts) {
    try {
      const result = await attempt()
      const text = textOf(result)
      if (text !== '') return { ok: true, text, engine: `host:${name}` }
    } catch {
      /* 换下一种签名 */
    }
  }
  return { ok: false, reason: 'host-service-failed' }
}

/** 本地命令：模板占位符替换后交给 sh -c，输出优先读产物文件再读 stdout。 */
async function viaLocalCommand(config, wavPath, outDir) {
  const template = config.asrCommand
  if (template === '') return { ok: false, reason: 'local-command-missing' }
  const basename = 'transcript'
  const command = template
    .replaceAll('{input}', JSON.stringify(wavPath))
    .replaceAll('{outdir}', JSON.stringify(outDir))
    .replaceAll('{basename}', basename)
  const started = Date.now()
  try {
    const { stdout, stderr } = await runShell(command, {
      timeout: config.asrTimeoutSec * 1000,
      maxBuffer: 32 * 1024 * 1024,
      shell: '/bin/sh',
    })
    // 常见约定：<outdir>/<basename>.txt
    for (const candidate of [`${basename}.txt`, `${path.basename(wavPath, '.wav')}.txt`]) {
      try {
        const text = await fsp.readFile(path.join(outDir, candidate), 'utf8')
        if (text.trim() !== '') {
          return { ok: true, text: text.trim(), engine: 'local', durationMs: Date.now() - started }
        }
      } catch {
        /* 试下一个 */
      }
    }
    const fromStdout = String(stdout ?? '').trim()
    if (fromStdout !== '') return { ok: true, text: fromStdout, engine: 'local', durationMs: Date.now() - started }
    return { ok: false, reason: 'empty', note: String(stderr ?? '').slice(0, 400) }
  } catch (error) {
    return { ok: false, reason: 'command-failed', note: String(error?.stderr ?? error?.message ?? error).slice(0, 400) }
  }
}

/**
 * 转写一个音频文件。
 * @returns {Promise<{ok:boolean, text?:string, engine?:string, reason?:string, note?:string, durationMs?:number}>}
 */
export async function transcribe(ctx, config, audioPath, outDir) {
  if (config.asrMode === 'off') return { ok: false, reason: 'asr-off' }
  const wavPath = await toWav(config, audioPath, outDir)
  if (config.asrMode === 'local') return viaLocalCommand(config, wavPath, outDir)
  if (config.asrMode === 'host') return viaHostSpeech(ctx, wavPath)
  // auto：宿主优先，退本地
  const host = await viaHostSpeech(ctx, wavPath)
  if (host.ok) return host
  const local = await viaLocalCommand(config, wavPath, outDir)
  if (local.ok) return local
  return {
    ok: false,
    reason: host.reason === 'host-service-missing' ? local.reason ?? 'no-engine' : host.reason,
    note: local.note ?? '',
  }
}

/** 面板/自检用：现在到底有没有转写能力，为什么没有。 */
export async function asrStatus(ctx, config) {
  if (config.asrMode === 'off') return { available: false, engine: 'off', reason: '转写已关闭（asrMode: off），只归档音频' }
  const found = findHostSpeech(ctx)
  if (config.asrMode !== 'local' && found !== undefined) {
    return { available: true, engine: `host:${found.name}`, reason: '' }
  }
  if (config.asrCommand !== '') {
    return { available: true, engine: 'local', reason: '' }
  }
  // ffmpeg 是否存在只影响格式统一，不影响「有没有引擎」的判断
  const ffmpeg = await runFile(config.ffmpegPath, ['-version'], { timeout: 10000 }).then(
    () => true,
    () => false,
  )
  return {
    available: false,
    engine: 'none',
    reason: ffmpeg
      ? '没有可用的转写引擎：宿主未提供语音服务，也未配置 asrCommand'
      : '没有可用的转写引擎，且未找到 ffmpeg（音频格式无法统一）',
  }
}
