/**
 * dsh-fdehub — 持久化状态。
 *
 * 一个 JSON 文件（$DATA/fdehub/store.json）装全部：案例、场景、元信息。
 * 媒体文件单独放在 uploads/ 下（体积大，不进 JSON）。
 *
 * 三条约束：
 *  - 写盘走 tmp + rename，半个文件比没有文件更糟；
 *  - 写盘防抖 200ms，面板连续操作不会把磁盘打满；
 *  - 读盘失败降级成空库并留一条告警，不让插件起不来。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const STORE_VERSION = 1
const SAVE_DEBOUNCE_MS = 200

const emptyState = () => ({ version: STORE_VERSION, cases: [], scenes: [], meta: { installedAt: new Date().toISOString() } })

export function createStore(ctx, config) {
  const dir = config.dataDir
  const file = path.join(dir, 'store.json')
  const uploadDir = path.join(dir, 'uploads')

  let state = emptyState()
  let timer
  let disposed = false
  let writing = Promise.resolve()

  const ready = (async () => {
    try {
      await fsp.mkdir(uploadDir, { recursive: true })
      const raw = await fsp.readFile(file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.cases)) {
        state = {
          version: STORE_VERSION,
          cases: parsed.cases,
          scenes: Array.isArray(parsed.scenes) ? parsed.scenes : [],
          meta: parsed.meta ?? {},
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        ctx?.logger?.warn?.('dsh-fdehub: store read failed, starting empty: %o', error)
      }
    }
    // 种子场景：每次都对齐一遍（只补不删），用户改过的保留。
    await seedScenes(ctx)
  })()

  /** 把仓库自带的场景种子并进本地库：同 id 已存在就不动。 */
  async function seedScenes(loggerCtx) {
    try {
      const seedFile = new URL('../scenes/seed.json', import.meta.url)
      const raw = await fsp.readFile(seedFile, 'utf8')
      const seed = JSON.parse(raw)
      const list = Array.isArray(seed?.scenes) ? seed.scenes : []
      const known = new Set(state.scenes.map((scene) => scene.id))
      let added = 0
      for (const scene of list) {
        if (typeof scene?.id !== 'string' || known.has(scene.id)) continue
        state.scenes.push({ ...scene, origin: 'seed' })
        added += 1
      }
      if (added > 0) schedule()
    } catch (error) {
      loggerCtx?.logger?.debug?.('dsh-fdehub: seed scenes unavailable: %o', error)
    }
  }

  function schedule() {
    if (disposed) return
    clearTimeout(timer)
    timer = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
    timer?.unref?.()
  }

  async function flush() {
    clearTimeout(timer)
    if (disposed) return
    const payload = JSON.stringify(state, null, 2)
    writing = writing.then(async () => {
      const tmp = `${file}.${process.pid}.tmp`
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(tmp, payload, 'utf8')
      await fsp.rename(tmp, file)
    })
    try {
      await writing
    } catch (error) {
      ctx?.logger?.warn?.('dsh-fdehub: store write failed: %o', error)
    }
  }

  const id = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

  const store = {
    ready,
    dir,
    uploadDir,
    id,

    cases() {
      return state.cases.slice().sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    },

    caseById(caseId) {
      return state.cases.find((entry) => entry.id === caseId)
    },

    createCase(fields = {}) {
      const now = new Date().toISOString()
      const record = {
        id: id(),
        createdAt: now,
        updatedAt: now,
        title: String(fields.title ?? '').trim() || '未命名梳理',
        org: String(fields.org ?? '').trim(),
        industry: String(fields.industry ?? '').trim(),
        domain: String(fields.domain ?? '未分类').trim() || '未分类',
        status: 'draft',
        sources: [],
        transcript: null,
        analysis: null,
        sceneId: '',
      }
      state.cases.unshift(record)
      schedule()
      return record
    },

    updateCase(caseId, patch = {}) {
      const record = store.caseById(caseId)
      if (record === undefined) return undefined
      Object.assign(record, patch, { updatedAt: new Date().toISOString() })
      schedule()
      return record
    },

    removeCase(caseId) {
      const index = state.cases.findIndex((entry) => entry.id === caseId)
      if (index === -1) return false
      const [removed] = state.cases.splice(index, 1)
      schedule()
      // 媒体文件随后台清理，失败不影响删除结果。
      for (const source of removed.sources ?? []) {
        if (typeof source?.path === 'string' && source.path.startsWith(uploadDir)) {
          void fsp.rm(source.path, { force: true }).catch(() => {})
        }
      }
      return true
    },

    addSource(caseId, source) {
      const record = store.caseById(caseId)
      if (record === undefined) return undefined
      record.sources.push(source)
      record.updatedAt = new Date().toISOString()
      schedule()
      return source
    },

    scenes() {
      return state.scenes.slice()
    },

    upsertScene(scene) {
      const index = state.scenes.findIndex((entry) => entry.id === scene.id)
      if (index === -1) state.scenes.push(scene)
      else state.scenes[index] = { ...state.scenes[index], ...scene }
      schedule()
      return scene
    },

    removeScene(sceneId) {
      const index = state.scenes.findIndex((entry) => entry.id === sceneId)
      if (index === -1) return false
      state.scenes.splice(index, 1)
      schedule()
      return true
    },

    stats() {
      const cases = state.cases
      return {
        cases: cases.length,
        analyzed: cases.filter((entry) => entry.analysis !== null).length,
        published: cases.filter((entry) => typeof entry.sceneId === 'string' && entry.sceneId !== '').length,
        scenes: state.scenes.length,
        localScenes: state.scenes.filter((entry) => entry.origin === 'local').length,
        installedAt: state.meta.installedAt ?? '',
        dataDir: dir,
      }
    },

    snapshot() {
      return { stats: store.stats(), cases: store.cases(), scenes: store.scenes() }
    },

    save: flush,

    async dispose() {
      await flush()
      disposed = true
    },
  }

  return store
}

export { emptyState, STORE_VERSION }
