/**
 * dsh-fdehub — host half（FDE 工坊 + 场景市场）。
 *
 * 这个插件解决一件具体的事：FDE 到了客户现场，听了两小时会、收了一堆表格，
 * 然后要在一晚上把它变成「业务怎么跑 → 卡在哪 → AI 能插哪一步 → 两周能验什么」。
 * 现在这条链路是：录音/上传 → 转写取文 → 结构化蓝图 → 沉淀成可复用场景卡。
 *
 *   采集  asr.js / extract.js   录音转写、音频与业务文件取文（引擎链，失败如实标注）
 *   梳理  analyze.js            宿主模型把材料压成蓝图（业务/痛点/机会点/路径/待确认）
 *   沉淀  store.js              案例与场景落盘（$DSH_HOME/fdehub）
 *   流通  registry.js           场景市场：种子 + 本地 + GitHub 远端索引
 *   出口  routes.js             /fdehub/api 面板与脚本共用
 *         tools.js              给 agent 的 5 个工具
 *   界面  client.js             侧栏两个入口：FDE 工坊 / 场景市场
 *
 * 三条工程底线：
 *  - 不引入新凭据：模型复用宿主 ctx.llm 与当前会话路由，转写只用本机能力；
 *  - 不编内容：转写不出来就标「未转写」，材料没覆盖就列进 notCovered；
 *  - 失败不阻断：任何一环出错只记日志/降级，面板照常可用。
 *
 * ⚠️ 宿主契约：profile 插件的 fiber 会在 apply 结束后回收，挂在插件 ctx 上的
 * 监听器与路由会静默失效。所有注册都落到常驻 root / 服务上。
 */
import { normalizeConfig } from './lib/config.js'
import { createStore } from './lib/store.js'
import { registerFdeHubRoutes } from './lib/routes.js'
import { registerFdeHubTools } from './lib/tools.js'

export const name = 'dsh-fdehub'

// 有意不声明静态 inject（如 `['webServer']`）：静态依赖不满足时 Cordis 会让
// 整个插件不启动，而采集/分析/落盘都不依赖 webServer，只有面板的 HTTP 路由依赖它。
// 降级成延迟绑定后，宿主没有 Web 服务时插件照样工作，只是面板没数据源。
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const store = createStore(ctx, config)

  /** 当前会话正在用的模型路由，供分析层复用（不要求用户再配一次 key）。 */
  const modelHint = { provider: config.llmProvider, model: config.llmModel }
  const deps = { ctx, modelHint }

  // 路由延迟绑定：服务就绪再挂；宿主没有该服务时只记一条警告。
  const bindRoutes = (target) => registerFdeHubRoutes(target, store, config, deps)
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], bindRoutes)
  } else if (ctx.webServer !== undefined) {
    bindRoutes(ctx)
  } else {
    ctx?.logger?.warn?.('dsh-fdehub: webServer unavailable — panel API not registered')
  }

  // agent 工具：独立在 tools 服务上，面板不可用也能用。
  registerFdeHubTools(ctx, store, config, deps)

  // 记录当前会话的模型路由：每次模型请求前宿主都会发这个事件。
  const listenCtx = ctx.root ?? ctx
  let disposeListener
  try {
    disposeListener = listenCtx.on(
      'session/event',
      (_session, event) => {
        if (event?.type !== 'request/context') return
        const provider = event.data?.provider
        const model = event.data?.model
        if (typeof provider === 'string' && provider !== '' && config.llmProvider === '') modelHint.provider = provider
        if (typeof model === 'string' && model !== '' && config.llmModel === '') modelHint.model = model
      },
      { global: true },
    )
  } catch (error) {
    ctx?.logger?.debug?.('dsh-fdehub: model route listener unavailable: %o', error)
  }

  const teardown = () => {
    try {
      if (typeof disposeListener === 'function') disposeListener()
    } catch {
      /* 已回收 */
    }
    void store.dispose()
  }
  listenCtx.effect(() => teardown, 'dsh-fdehub: teardown')

  // 商店就绪后打一行，配上数据目录——排障时第一个要看的就是它。
  void store.ready.then(() => {
    const stats = store.stats()
    ctx?.logger?.debug?.(
      'dsh-fdehub: ready (cases=%d, scenes=%d, data=%s)',
      stats.cases,
      stats.scenes,
      stats.dataDir,
    )
  })

  ctx?.logger?.debug?.('dsh-fdehub: applied (asrMode=%s)', config.asrMode)
}
