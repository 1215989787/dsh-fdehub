/**
 * dsh-fdehub — HTTP 小工具 + 信任围栏。
 *
 * 围栏与宿主 `/api` 网关同一契约：Host 必须是 loopback / 宿主授予的可信权威
 * / 监听地址字面量，`sec-fetch-site` 不得为 cross-site，`origin` 若存在必须同源。
 * 内联实现而不 import 宿主内部包：插件是独立发布的，少一个运行时依赖
 * 就少一条装不上的路径。
 */
import { Buffer } from 'node:buffer'

/** 单请求是否通过围栏。 */
export function isTrustedRequest(request, trustedHosts, bindHost) {
  const host = typeof request?.headers?.host === 'string' ? request.headers.host : undefined
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (
    !isLoopbackHostname(hostUrl.hostname) &&
    !isTrustedAuthority(hostUrl, trustedHosts) &&
    !isBindAddressAuthority(hostUrl, bindHost)
  ) {
    return false
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

function isBindAddressAuthority(hostUrl, bindHost) {
  if (bindHost === undefined) return false
  const zoneAt = bindHost.indexOf('%')
  const address = zoneAt === -1 ? bindHost : bindHost.slice(0, zoneAt)
  const bindUrl = parseAuthority(address.includes(':') ? `[${address}]` : address)
  return bindUrl !== undefined && bindUrl.hostname === hostUrl.hostname
}

/** Cordis Context 是代理：未 inject 的服务做属性访问会抛，一律走 get(name,false)。 */
function serviceOf(ctx, name) {
  if (typeof ctx?.get !== 'function') return undefined
  try {
    return ctx.get(name, false) ?? undefined
  } catch {
    return undefined
  }
}

function propertyOf(ctx, name) {
  if (ctx === null || ctx === undefined || typeof ctx !== 'object') return undefined
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

function trustedHostsOf(ctx) {
  const out = []
  for (const source of [serviceOf(ctx, 'webStartup'), serviceOf(ctx, 'webRuntime'), propertyOf(ctx, 'webRuntime')]) {
    const list = source?.trustedHosts
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (typeof entry === 'string' && entry !== '' && !out.includes(entry)) out.push(entry)
    }
  }
  return out
}

function bindHostOf(ctx) {
  const direct = propertyOf(ctx, 'webServer')?.host
  if (typeof direct === 'string' && direct !== '') return direct
  const service = serviceOf(ctx, 'webServer')
  const host = service?.host
  return typeof host === 'string' && host !== '' ? host : undefined
}

/** 生成可复用的围栏函数：每次请求现读宿主服务（服务可能晚于围栏创建就绪）。 */
export function createTrustFence(ctx) {
  return (request) => isTrustedRequest(request, trustedHostsOf(ctx), bindHostOf(ctx))
}

// ── 请求 / 响应 ──────────────────────────────────────────────────────────

export function writeJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(payload)
}

export function writeError(response, error) {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error')
  const status = typeof error?.status === 'number' ? error.status : 500
  writeJson(response, status, { ok: false, error: { message } })
}

/** 读 JSON body（上限 2MB：面板只发配置和小段文本，音频走二进制接口）。 */
export async function readJsonBody(request, limitBytes = 2 * 1024 * 1024) {
  const raw = await readRawBody(request, limitBytes)
  const text = raw.toString('utf8').trim()
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    const error = new Error('invalid JSON body')
    error.status = 400
    throw error
  }
}

/** 读原始 body（音频上传用），超限直接拒绝而不是悄悄截断。 */
export async function readRawBody(request, limitBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > limitBytes) {
      const error = new Error(`body too large (> ${Math.round(limitBytes / 1024 / 1024)}MB)`)
      error.status = 413
      throw error
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/** 从 URL 查询参数里取字符串。 */
export function queryValue(url, name, fallback = '') {
  const value = url.searchParams.get(name)
  return typeof value === 'string' ? value : fallback
}
