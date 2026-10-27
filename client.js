/**
 * dsh-fdehub — client half（浏览器）。
 *
 * 左侧栏两个原生入口，和「插件市场」「定时任务」是同一套面板行组件：
 *   · FDE 工坊（order 21）：录音 / 上传 / 粘贴 → 转写取文 → 结构化蓝图
 *   · 场景市场（order 22）：检索 AI+业务场景卡，一键起案例，发布自己的场景
 *
 * 两条设计取舍：
 *  1. 录音在浏览器里做（MediaRecorder），音频 16k 单声道统一交给 Host 端 ffmpeg，
 *     宿主的 Node 进程不需要碰音频解码；
 *  2. 面板轮询而不是 WebSocket：分析一次几十秒，4 秒轮询足够，少一条长连接
 *     就少一类「连不上」的故障。
 *
 * 样式走 DSH 语义 token（--dsw-*），随 activation 注入、teardown 卸载，
 * HMR / 禁用不留残渣。
 */
window.__ModuleLoader__.load({
  id: 'dsh-fdehub',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = require('react')

    const PANEL_WORK = 'dsh-fdehub'
    const PANEL_MARKET = 'dsh-fdehub-market'
    const POLL_MS = 4000
    const API = '/fdehub/api'

    // ── 文案 ──────────────────────────────────────────────────────────────
    const STRINGS = {
      zh: {
        workTitle: 'FDE 工坊',
        workSub: '现场录音与业务文件，一次梳理成能落地的方案',
        marketTitle: '场景市场',
        marketSub: '可复用的 AI+业务场景资产',
        cases: '案例',
        newCase: '新建案例',
        noCases: '还没有案例。新建一个，然后录音或上传现场材料。',
        title: '标题',
        org: '客户/单位',
        domain: '域',
        industry: '行业',
        brief: '补充背景',
        briefPlaceholder: '这次沟通想解决什么？谁在场？有什么前提…',
        save: '保存',
        saved: '已保存',
        delete: '删除',
        confirmDelete: '删除这个案例？材料和音频会一起清掉。',
        materials: '材料',
        emptyMaterials: '还没有材料。可以直接录音，或上传音频/文档。',
        record: '现场录音',
        recording: '录音中',
        stop: '停止并上传',
        uploadAudio: '上传音频',
        uploadDoc: '上传业务文件',
        paste: '粘贴文字',
        pastePlaceholder: '把会议纪要、需求描述或现场记录贴进来…',
        pasteName: '材料名称（可选）',
        add: '加入',
        cancel: '取消',
        analyze: '梳理业务 + AI 逻辑',
        analyzing: '梳理中…',
        exportMd: '导出 Markdown',
        status: '状态',
        transcript: '转写稿',
        untranscribed: '未转写',
        retryAsr: '重试转写',
        asrOff: '没有可用的转写引擎',
        asrHint: '没有可用转写引擎：可以在设置里配 asrCommand（mlx-whisper / whisper.cpp），或直接从「粘贴文字」补文稿。',
        noAnalysis: '还没有梳理结果。补齐材料后点「梳理业务 + AI 逻辑」。',
        business: '业务现状',
        pains: '痛点',
        opportunities: 'AI 机会点',
        roadmap: '落地路径',
        questions: '必须回客户确认',
        notCovered: '材料没覆盖的',
        roles: '角色与卡点',
        flow: '流程',
        systems: '系统与数据',
        metrics: '指标',
        evidence: '依据',
        impact: '影响',
        injection: '插入点',
        input: '输入',
        output: '输出',
        human: '人工兜底',
        proof: '判定指标',
        effort: '工作量',
        dataNeeded: '还缺数据',
        integration: '要对接',
        risk: '风险',
        value: '价值',
        feasibility: '可行性',
        stage: { poc: 'PoC', pilot: '试点', scale: '推广' },
        days: '天',
        deliverable: '交付物',
        gate: '判定标准',
        scope: '范围',
        publish: '发布成场景',
        published: '已发布',
        publishHint: '把这次梳理沉淀成场景卡，进本地市场；同时给出可提 PR 的 JSON。',
        publishDone: '已发布到本地场景市场',
        copyJson: '复制 JSON',
        copied: '已复制',
        search: '搜索场景、痛点、AI 形态…',
        allDomains: '全部',
        refresh: '刷新远端索引',
        remoteErr: '远端索引拉取失败（只用本地场景）',
        localEmpty: '没有匹配的场景',
        useScene: '用这个场景起案例',
        sceneCreated: '已新建案例，去「FDE 工坊」补齐现场事实',
        seed: '内置',
        local: '本机',
        remote: '远端',
        removeScene: '删除',
        loading: '读取中…',
        error: '出错了',
        llmOff: '模型通道不可用',
        llmOffHint: '宿主没有提供模型服务，或还没拿到路由：先聊一轮，或在设置里指定 provider/model。',
        chars: '字',
        truncated: '材料超长，已截断',
        emptyBrief: '（无）',
      },
      en: {
        workTitle: 'FDE Workshop',
        workSub: 'Turn site recordings and business files into a deliverable plan',
        marketTitle: 'Scenario Market',
        marketSub: 'Reusable AI + business scenario cards',
        cases: 'Cases',
        newCase: 'New case',
        noCases: 'No cases yet. Create one, then record or upload site material.',
        title: 'Title',
        org: 'Client',
        domain: 'Domain',
        industry: 'Industry',
        brief: 'Context',
        briefPlaceholder: 'What should this session solve? Who is in the room?',
        save: 'Save',
        saved: 'Saved',
        delete: 'Delete',
        confirmDelete: 'Delete this case? Materials and audio will be removed.',
        materials: 'Materials',
        emptyMaterials: 'No material yet. Record, or upload audio/documents.',
        record: 'Record',
        recording: 'Recording',
        stop: 'Stop & upload',
        uploadAudio: 'Upload audio',
        uploadDoc: 'Upload file',
        paste: 'Paste text',
        pastePlaceholder: 'Paste meeting notes, requirement notes or site records…',
        pasteName: 'Material name (optional)',
        add: 'Add',
        cancel: 'Cancel',
        analyze: 'Analyze business + AI logic',
        analyzing: 'Analyzing…',
        exportMd: 'Export Markdown',
        status: 'Status',
        transcript: 'Transcript',
        untranscribed: 'Not transcribed',
        retryAsr: 'Retry',
        asrOff: 'No transcription engine',
        asrHint: 'No engine available: set asrCommand (mlx-whisper / whisper.cpp) or paste the transcript manually.',
        noAnalysis: 'No analysis yet. Add material, then run the analysis.',
        business: 'Business today',
        pains: 'Pains',
        opportunities: 'AI opportunities',
        roadmap: 'Roadmap',
        questions: 'Open questions',
        notCovered: 'Not covered',
        roles: 'Roles & blockers',
        flow: 'Flow',
        systems: 'Systems & data',
        metrics: 'Metrics',
        evidence: 'Evidence',
        impact: 'Impact',
        injection: 'Injection point',
        input: 'Input',
        output: 'Output',
        human: 'Human in the loop',
        proof: 'Proof metric',
        effort: 'Effort',
        dataNeeded: 'Missing data',
        integration: 'Integrations',
        risk: 'Risk',
        value: 'Value',
        feasibility: 'Feasibility',
        stage: { poc: 'PoC', pilot: 'Pilot', scale: 'Scale' },
        days: 'd',
        deliverable: 'Deliverable',
        gate: 'Gate',
        scope: 'Scope',
        publish: 'Publish as scenario',
        published: 'Published',
        publishHint: 'Turn this analysis into a scenario card for the local market, plus a PR-ready JSON.',
        publishDone: 'Published to local market',
        copyJson: 'Copy JSON',
        copied: 'Copied',
        search: 'Search scenario, pain, AI pattern…',
        allDomains: 'All',
        refresh: 'Refresh remote index',
        remoteErr: 'Remote index failed (local scenes only)',
        localEmpty: 'No matching scenario',
        useScene: 'Start a case with this scenario',
        sceneCreated: 'Case created — finish it in the workshop',
        seed: 'bundled',
        local: 'local',
        remote: 'remote',
        removeScene: 'Delete',
        loading: 'Loading…',
        error: 'Error',
        llmOff: 'Model channel unavailable',
        llmOffHint: 'No model service, or no route yet: chat once, or pin provider/model in settings.',
        chars: 'chars',
        truncated: 'material truncated',
        emptyBrief: '(none)',
      },
    }

    let LANG = 'zh'
    let hostCtx

    function detectLang(ctx) {
      try {
        const pref = ctx?.get?.('settings', false)
        void pref
      } catch {
        /* 忽略 */
      }
      const htmlLang = typeof document !== 'undefined' ? document.documentElement.lang || '' : ''
      const nav = typeof navigator !== 'undefined' ? (navigator.languages?.[0] ?? navigator.language ?? '') : ''
      const value = (htmlLang || nav).toLowerCase()
      return value.startsWith('zh') ? 'zh' : value === '' ? 'zh' : 'en'
    }

    function applyLang(ctx) {
      LANG = detectLang(ctx)
    }

    const t = (key) => (STRINGS[LANG] ?? STRINGS.zh)[key] ?? STRINGS.zh[key] ?? key

    // ── API ───────────────────────────────────────────────────────────────
    async function api(method, path, body) {
      const init = { method, headers: {} }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      const response = await fetch(`${API}/${path}`, init)
      const payload = await response.json().catch(() => ({}))
      if (payload?.ok === false) throw new Error(payload?.error?.message ?? 'request failed')
      return payload?.value
    }

    async function uploadFile(caseId, file) {
      const response = await fetch(`${API}/upload?id=${encodeURIComponent(caseId)}`, {
        method: 'POST',
        headers: { 'x-fdehub-name': encodeURIComponent(file.name) },
        body: file,
      })
      const payload = await response.json().catch(() => ({}))
      if (payload?.ok === false) throw new Error(payload?.error?.message ?? 'upload failed')
      return payload?.value
    }

    // ── 通用小件 ──────────────────────────────────────────────────────────
    function Section(props) {
      return h(
        'section',
        { className: 'fde-section' },
        h('h3', { className: 'fde-h3' }, props.title, props.aside ? h('span', { className: 'fde-aside' }, props.aside) : null),
        props.children,
      )
    }

    function Field(props) {
      if (!props.value) return null
      return h(
        'div',
        { className: 'fde-field' },
        h('span', { className: 'fde-field-k' }, props.label),
        h('span', { className: 'fde-field-v' }, props.value),
      )
    }

    function Pill(props) {
      return h('span', { className: `fde-pill${props.tone ? ` fde-pill-${props.tone}` : ''}` }, props.children)
    }

    function Score(props) {
      const n = Math.max(1, Math.min(5, Number(props.value) || 1))
      return h(
        'span',
        { className: 'fde-score', title: `${props.label} ${n}/5` },
        Array.from({ length: 5 }, (_, index) => h('i', { key: index, className: index < n ? 'on' : '' })),
      )
    }

    // ── 案例详情 ──────────────────────────────────────────────────────────
    function SourceRow(props) {
      const { source, onRetry } = props
      const tone = source.status === 'ok' ? 'ok' : source.status === 'untranscribed' ? 'warn' : 'bad'
      return h(
        'div',
        { className: 'fde-source' },
        h('div', { className: 'fde-source-main' },
          h('span', { className: 'fde-source-name' }, source.name),
          h(Pill, { tone }, source.status === 'ok' ? `${source.chars ?? 0} ${t('chars')}` : source.status === 'untranscribed' ? t('untranscribed') : t('error')),
          source.engine ? h('span', { className: 'fde-muted' }, source.engine) : null,
        ),
        source.note ? h('div', { className: 'fde-note' }, source.note) : null,
        source.kind === 'audio' && source.status !== 'ok'
          ? h('button', { className: 'fde-btn fde-btn-s', onClick: () => onRetry(source.id) }, t('retryAsr'))
          : null,
      )
    }

    function AnalysisView(props) {
      const a = props.analysis
      if (!a) return null
      const b = a.business ?? {}
      return h('div', { className: 'fde-analysis' },
        h('div', { className: 'fde-hero' },
          h('div', { className: 'fde-hero-t' }, a.caseTitle || props.title),
          h('div', { className: 'fde-hero-s' }, a.oneLine),
          h('div', { className: 'fde-hero-m' },
            a._meta?.route ? h(Pill, null, a._meta.route) : null,
            a._meta?.truncated ? h(Pill, { tone: 'warn' }, t('truncated')) : null,
          ),
        ),

        h(Section, { title: t('business') },
          b.summary ? h('p', { className: 'fde-p' }, b.summary) : null,
          b.roles?.length
            ? h('div', { className: 'fde-sub' }, t('roles'), h('ul', { className: 'fde-list' },
                b.roles.map((role, index) => h('li', { key: index },
                  h('b', null, role.name), role.duty ? `　${role.duty}` : '', role.pain ? h('em', null, `　卡点：${role.pain}`) : null))))
            : null,
          b.flow?.length
            ? h('div', { className: 'fde-sub' }, t('flow'), h('ol', { className: 'fde-steps' },
                b.flow.map((step, index) => h('li', { key: index }, step))))
            : null,
          b.systems?.length
            ? h('div', { className: 'fde-sub' }, t('systems'), h('ul', { className: 'fde-list' },
                b.systems.map((sys, index) => h('li', { key: index }, h('b', null, sys.name), sys.role ? `　${sys.role}` : '', sys.data ? h('span', { className: 'fde-muted' }, `　${sys.data}`) : null))))
            : null,
          b.metrics?.length
            ? h('div', { className: 'fde-sub' }, t('metrics'), h('table', { className: 'fde-table' },
                h('thead', null, h('tr', null, h('th', null, t('metrics')), h('th', null, '现状'), h('th', null, '目标'), h('th', null, '口径'))),
                h('tbody', null, b.metrics.map((m, index) => h('tr', { key: index },
                  h('td', null, m.name), h('td', null, m.current), h('td', null, m.target), h('td', { className: 'fde-muted' }, m.note))))))
            : null,
          !b.summary && !b.roles?.length && !b.flow?.length ? h('div', { className: 'fde-muted' }, '—') : null,
        ),

        h(Section, { title: t('pains'), aside: `${a.pains?.length ?? 0}` },
          (a.pains ?? []).map((pain, index) => h('div', { key: index, className: 'fde-card' },
            h('div', { className: 'fde-card-h' }, pain.title, h(Score, { value: pain.severity, label: t('impact') })),
            h(Field, { label: t('evidence'), value: pain.evidence }),
            h(Field, { label: t('impact'), value: pain.impact }),
          )),
          (a.pains ?? []).length === 0 ? h('div', { className: 'fde-muted' }, '—') : null,
        ),

        h(Section, { title: t('opportunities'), aside: `${a.opportunities?.length ?? 0}` },
          (a.opportunities ?? []).map((item, index) => h('div', { key: index, className: 'fde-card fde-card-opp' },
            h('div', { className: 'fde-card-h' },
              h('span', { className: 'fde-idx' }, index + 1),
              item.title,
              h('span', { className: 'fde-card-h-r' },
                h(Pill, null, item.aiPattern),
                h(Pill, null, `${item.effort}`)),
            ),
            h('div', { className: 'fde-scores' },
              h('span', null, t('value'), h(Score, { value: item.value, label: t('value') })),
              h('span', null, t('feasibility'), h(Score, { value: item.feasibility, label: t('feasibility') })),
            ),
            h(Field, { label: t('injection'), value: item.injection }),
            h(Field, { label: t('input'), value: item.input }),
            h(Field, { label: t('output'), value: item.output }),
            h(Field, { label: t('human'), value: item.humanInLoop }),
            h(Field, { label: t('proof'), value: item.proofMetric }),
            item.dataNeeded?.length ? h(Field, { label: t('dataNeeded'), value: item.dataNeeded.join('；') }) : null,
            item.integration?.length ? h(Field, { label: t('integration'), value: item.integration.join('；') }) : null,
            h(Field, { label: t('risk'), value: item.risk }),
          )),
          (a.opportunities ?? []).length === 0 ? h('div', { className: 'fde-muted' }, '—') : null,
        ),

        h(Section, { title: t('roadmap') },
          ['poc', 'pilot', 'scale'].map((key) => {
            const stage = a.roadmap?.[key] ?? {}
            return h('div', { key, className: 'fde-stage' },
              h('div', { className: 'fde-stage-h' }, t('stage')[key], stage.days ? h('span', { className: 'fde-muted' }, `${stage.days} ${t('days')}`) : null),
              h(Field, { label: t('scope'), value: stage.scope }),
              h(Field, { label: t('deliverable'), value: stage.deliverable }),
              h(Field, { label: t('gate'), value: stage.gate }),
            )
          }),
        ),

        h(Section, { title: t('questions'), aside: `${a.openQuestions?.length ?? 0}` },
          h('ul', { className: 'fde-list' }, (a.openQuestions ?? []).map((q, index) => h('li', { key: index }, q))),
        ),
        h(Section, { title: t('notCovered'), aside: `${a.notCovered?.length ?? 0}` },
          h('ul', { className: 'fde-list fde-list-warn' }, (a.notCovered ?? []).map((q, index) => h('li', { key: index }, q))),
        ),
      )
    }

    function CaseDetail(props) {
      const { record, snapshot, onChanged, notify } = props
      const [busy, setBusy] = useState('')
      const [pasteOpen, setPasteOpen] = useState(false)
      const [pasteText, setPasteText] = useState('')
      const [pasteName, setPasteName] = useState('')
      const [recording, setRecording] = useState(false)
      const [elapsed, setElapsed] = useState(0)
      const [draft, setDraft] = useState({
        title: record.title,
        org: record.org ?? '',
        domain: record.domain ?? '',
        industry: record.industry ?? '',
        brief: record.brief ?? '',
      })
      const recorderRef = useRef(null)
      const chunksRef = useRef([])
      const tickRef = useRef(null)
      const fileAudioRef = useRef(null)
      const fileDocRef = useRef(null)

      useEffect(() => {
        setDraft({
          title: record.title,
          org: record.org ?? '',
          domain: record.domain ?? '',
          industry: record.industry ?? '',
          brief: record.brief ?? '',
        })
      }, [record.id, record.title, record.org, record.domain, record.industry, record.brief])

      useEffect(() => () => {
        if (tickRef.current) clearInterval(tickRef.current)
        const recorder = recorderRef.current
        if (recorder && recorder.state !== 'inactive') recorder.stop()
      }, [])

      const save = async () => {
        setBusy('save')
        try {
          await api('POST', 'case/update', { id: record.id, ...draft })
          notify(t('saved'))
          onChanged()
        } catch (error) {
          notify(error.message, 'bad')
        } finally {
          setBusy('')
        }
      }

      const runAnalyze = async () => {
        setBusy('analyze')
        try {
          await api('POST', 'analyze', { id: record.id, brief: draft.brief })
          onChanged()
        } catch (error) {
          notify(error.message, 'bad')
        } finally {
          setBusy('')
        }
      }

      const addText = async () => {
        if (pasteText.trim() === '') return
        setBusy('text')
        try {
          await api('POST', 'text', { id: record.id, name: pasteName.trim(), text: pasteText })
          setPasteText('')
          setPasteName('')
          setPasteOpen(false)
          onChanged()
        } catch (error) {
          notify(error.message, 'bad')
        } finally {
          setBusy('')
        }
      }

      const doUpload = async (file) => {
        if (!file) return
        setBusy('upload')
        try {
          await uploadFile(record.id, file)
          onChanged()
        } catch (error) {
          notify(error.message, 'bad')
        } finally {
          setBusy('')
        }
      }

      const startRecording = async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : ''
          const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
          chunksRef.current = []
          recorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) chunksRef.current.push(event.data)
          }
          recorder.onstop = async () => {
            stream.getTracks().forEach((track) => track.stop())
            const blob = new Blob(chunksRef.current, { type: mime || 'audio/webm' })
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
            const file = new File([blob], `现场录音-${stamp}.webm`, { type: blob.type })
            await doUpload(file)
          }
          recorder.start(1000)
          recorderRef.current = recorder
          setRecording(true)
          setElapsed(0)
          tickRef.current = setInterval(() => setElapsed((value) => value + 1), 1000)
        } catch (error) {
          notify(`${t('record')}: ${error.message}`, 'bad')
        }
      }

      const stopRecording = () => {
        if (tickRef.current) clearInterval(tickRef.current)
        setRecording(false)
        const recorder = recorderRef.current
        if (recorder && recorder.state !== 'inactive') recorder.stop()
        setBusy('upload')
      }

      const retryAsr = async (sourceId) => {
        setBusy('asr')
        try {
          await api('POST', 'asr/retry', { id: record.id, sourceId })
          onChanged()
        } catch (error) {
          notify(error.message, 'bad')
        } finally {
          setBusy('')
        }
      }

      const publish = async () => {
        setBusy('publish')
        try {
          const value = await api('POST', 'scene/publish', { id: record.id })
          notify(t('publishDone'))
          if (value?.publish?.json) {
            try {
              await navigator.clipboard.writeText(JSON.stringify(value.publish.json, null, 2))
              notify(`${t('publishDone')} · ${t('copied')}`)
            } catch {
              /* 剪贴板不可用不影响发布 */
            }
          }
          onChanged()
        } catch (error) {
          notify(error.message, 'bad')
        } finally {
          setBusy('')
        }
      }

      const asr = snapshot?.asr ?? { available: false, reason: '' }
      const llm = snapshot?.llm ?? { available: false }
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
      const ss = String(elapsed % 60).padStart(2, '0')

      return h('div', { className: 'fde-detail' },
        h('div', { className: 'fde-detail-h' },
          h('input', {
            className: 'fde-input fde-input-title',
            value: draft.title,
            onChange: (event) => setDraft({ ...draft, title: event.target.value }),
            onBlur: save,
          }),
          h('button', { className: 'fde-btn fde-btn-ghost', onClick: () => {
            if (!window.confirm(t('confirmDelete'))) return
            void api('POST', 'case/delete', { id: record.id }).then(onChanged)
          } }, t('delete')),
        ),

        h('div', { className: 'fde-grid2' },
          h('label', { className: 'fde-label' }, t('org'),
            h('input', { className: 'fde-input', value: draft.org, onChange: (e) => setDraft({ ...draft, org: e.target.value }), onBlur: save })),
          h('label', { className: 'fde-label' }, t('domain'),
            h('input', { className: 'fde-input', value: draft.domain, onChange: (e) => setDraft({ ...draft, domain: e.target.value }), onBlur: save })),
          h('label', { className: 'fde-label' }, t('industry'),
            h('input', { className: 'fde-input', value: draft.industry, onChange: (e) => setDraft({ ...draft, industry: e.target.value }), onBlur: save })),
        ),

        h('label', { className: 'fde-label' }, t('brief'),
          h('textarea', {
            className: 'fde-input fde-textarea',
            rows: 3,
            placeholder: t('briefPlaceholder'),
            value: draft.brief,
            onChange: (e) => setDraft({ ...draft, brief: e.target.value }),
            onBlur: save,
          })),

        h(Section, { title: t('materials'), aside: `${(record.sources ?? []).length}` },
          h('div', { className: 'fde-actions' },
            recording
              ? h('button', { className: 'fde-btn fde-btn-rec', onClick: stopRecording }, `● ${t('recording')} ${mm}:${ss}　${t('stop')}`)
              : h('button', { className: 'fde-btn', onClick: startRecording, disabled: busy !== '' }, `● ${t('record')}`),
            h('button', { className: 'fde-btn', onClick: () => fileAudioRef.current?.click(), disabled: busy !== '' }, t('uploadAudio')),
            h('button', { className: 'fde-btn', onClick: () => fileDocRef.current?.click(), disabled: busy !== '' }, t('uploadDoc')),
            h('button', { className: 'fde-btn fde-btn-ghost', onClick: () => setPasteOpen(!pasteOpen) }, t('paste')),
            h('input', {
              ref: fileAudioRef, type: 'file', accept: 'audio/*,video/mp4', style: { display: 'none' },
              onChange: (e) => { const f = e.target.files?.[0]; e.target.value = ''; void doUpload(f) },
            }),
            h('input', {
              ref: fileDocRef, type: 'file',
              accept: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.json,.yaml,.yml',
              style: { display: 'none' },
              onChange: (e) => { const f = e.target.files?.[0]; e.target.value = ''; void doUpload(f) },
            }),
          ),
          busy === 'upload' ? h('div', { className: 'fde-muted' }, `${t('loading')}…`) : null,

          pasteOpen
            ? h('div', { className: 'fde-paste' },
                h('input', { className: 'fde-input', placeholder: t('pasteName'), value: pasteName, onChange: (e) => setPasteName(e.target.value) }),
                h('textarea', { className: 'fde-input fde-textarea', rows: 6, placeholder: t('pastePlaceholder'), value: pasteText, onChange: (e) => setPasteText(e.target.value) }),
                h('div', { className: 'fde-actions' },
                  h('button', { className: 'fde-btn', onClick: addText, disabled: busy !== '' }, t('add')),
                  h('button', { className: 'fde-btn fde-btn-ghost', onClick: () => setPasteOpen(false) }, t('cancel')),
                ))
            : null,

          (record.sources ?? []).length === 0
            ? h('div', { className: 'fde-muted' }, t('emptyMaterials'))
            : (record.sources ?? []).map((source) => h(SourceRow, { key: source.id, source, onRetry: retryAsr })),

          !asr.available ? h('div', { className: 'fde-hint fde-hint-warn' }, t('asrHint')) : null,
        ),

        record.transcript?.text
          ? h(Section, { title: t('transcript'), aside: record.transcript.engine ?? '' },
              h('pre', { className: 'fde-pre' }, record.transcript.text.slice(0, 4000)),
              record.transcript.text.length > 4000 ? h('div', { className: 'fde-muted' }, '…') : null)
          : null,

        h('div', { className: 'fde-run' },
          h('button', { className: 'fde-btn fde-btn-primary', onClick: runAnalyze, disabled: busy !== '' || !llm.available },
            busy === 'analyze' ? t('analyzing') : t('analyze')),
          record.analysis
            ? h('button', { className: 'fde-btn fde-btn-ghost', onClick: publish, disabled: busy !== '' }, record.sceneId ? t('published') : t('publish'))
            : null,
          record.analysis
            ? h('a', { className: 'fde-btn fde-btn-ghost', href: `${API}/export?id=${encodeURIComponent(record.id)}` }, t('exportMd'))
            : null,
        ),
        !llm.available ? h('div', { className: 'fde-hint fde-hint-warn' }, `${t('llmOff')} — ${t('llmOffHint')}`) : null,

        record.analysis ? h(AnalysisView, { analysis: record.analysis, title: record.title }) : h('div', { className: 'fde-muted' }, t('noAnalysis')),
      )
    }

    // ── 工坊整页 ──────────────────────────────────────────────────────────
    function WorkPage() {
      const [snapshot, setSnapshot] = useState(null)
      const [selected, setSelected] = useState('')
      const [toast, setToast] = useState({ text: '', tone: 'ok' })
      const [error, setError] = useState('')
      const alive = useRef(true)

      const notify = useCallback((text, tone = 'ok') => {
        setToast({ text, tone })
        window.setTimeout(() => setToast({ text: '', tone: 'ok' }), 2600)
      }, [])

      const load = useCallback(async () => {
        try {
          const value = await api('GET', 'snapshot')
          if (!alive.current) return
          setSnapshot(value)
          setError('')
        } catch (err) {
          if (alive.current) setError(err.message)
        }
      }, [])

      useEffect(() => {
        alive.current = true
        void load()
        const timer = setInterval(() => void load(), POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [load])

      const record = useMemo(() => {
        if (snapshot === null) return undefined
        const list = snapshot.cases ?? []
        return list.find((entry) => entry.id === selected) ?? list[0]
      }, [snapshot, selected])

      const createCase = async () => {
        try {
          const value = await api('POST', 'cases', { title: '未命名梳理', domain: '未分类' })
          setSelected(value.id)
          await load()
        } catch (err) {
          notify(err.message, 'bad')
        }
      }

      if (snapshot === null) return h('div', { className: 'fde-page' }, h('div', { className: 'fde-muted' }, `${t('loading')}…`))
      if (error !== '') return h('div', { className: 'fde-page' }, h('div', { className: 'fde-hint fde-hint-warn' }, `${t('error')}: ${error}`))

      return h('div', { className: 'fde-page' },
        h('header', { className: 'fde-top' },
          h('div', null,
            h('div', { className: 'fde-title' }, t('workTitle')),
            h('div', { className: 'fde-sub' }, t('workSub')),
          ),
          h('div', { className: 'fde-top-r' },
            h(Pill, null, `${snapshot.stats.cases} ${t('cases')}`),
            h(Pill, null, `${snapshot.stats.analyzed} ✓`),
            snapshot.asr?.available ? h(Pill, { tone: 'ok' }, snapshot.asr.engine) : h(Pill, { tone: 'warn' }, t('asrOff')),
            h('button', { className: 'fde-btn fde-btn-primary', onClick: createCase }, `+ ${t('newCase')}`),
          ),
        ),
        h('div', { className: 'fde-body' },
          h('aside', { className: 'fde-side' },
            (snapshot.cases ?? []).length === 0
              ? h('div', { className: 'fde-muted fde-side-empty' }, t('noCases'))
              : (snapshot.cases ?? []).map((entry) => h('button', {
                  key: entry.id,
                  className: `fde-case-row${record?.id === entry.id ? ' on' : ''}`,
                  onClick: () => setSelected(entry.id),
                },
                h('div', { className: 'fde-case-t' }, entry.title),
                h('div', { className: 'fde-case-m' },
                  h('span', null, entry.domain || '—'),
                  h('span', null, `${(entry.sources ?? []).length}`),
                  entry.analysis ? h('span', { className: 'fde-ok' }, '✓') : null,
                ),
              )),
          ),
          h('main', { className: 'fde-main' },
            record === undefined
              ? h('div', { className: 'fde-muted' }, t('noCases'))
              : h(CaseDetail, { key: record.id, record, snapshot, onChanged: load, notify }),
          ),
        ),
        toast.text !== '' ? h('div', { className: `fde-toast${toast.tone === 'bad' ? ' bad' : ''}` }, toast.text) : null,
      )
    }

    // ── 场景市场 ──────────────────────────────────────────────────────────
    function MarketPage() {
      const [data, setData] = useState(null)
      const [query, setQuery] = useState('')
      const [domain, setDomain] = useState('')
      const [detail, setDetail] = useState(null)
      const [toast, setToast] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async (options = {}) => {
        try {
          const value = await api('POST', 'scene/list', {
            query: options.query ?? query,
            domain: options.domain ?? domain,
            remote: true,
            refresh: options.refresh === true,
          })
          setData(value)
        } catch (error) {
          setData({ scenes: [], domains: [], remoteError: error.message })
        }
      }, [query, domain])

      useEffect(() => {
        void load({ query: '', domain: '' })
        // 只在挂载时拉一次；筛选走下面的按钮与输入防抖
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      useEffect(() => {
        const timer = setTimeout(() => void load({}), 300)
        return () => clearTimeout(timer)
      }, [query, domain, load])

      const useScene = async (scene) => {
        setBusy(true)
        try {
          await api('POST', 'scene/use', { sceneId: scene.id })
          setToast(t('sceneCreated'))
        } catch (error) {
          setToast(error.message)
        } finally {
          setBusy(false)
          window.setTimeout(() => setToast(''), 2600)
        }
      }

      const removeScene = async (scene) => {
        setBusy(true)
        try {
          await api('POST', 'scene/delete', { sceneId: scene.id })
          setDetail(null)
          await load({})
        } catch (error) {
          setToast(error.message)
        } finally {
          setBusy(false)
        }
      }

      const scenes = data?.scenes ?? []

      return h('div', { className: 'fde-page' },
        h('header', { className: 'fde-top' },
          h('div', null,
            h('div', { className: 'fde-title' }, t('marketTitle')),
            h('div', { className: 'fde-sub' }, t('marketSub')),
          ),
          h('div', { className: 'fde-top-r' },
            h(Pill, null, `${scenes.length} / ${data?.total ?? 0}`),
            h('button', { className: 'fde-btn fde-btn-ghost', onClick: () => void load({ refresh: true }) }, t('refresh')),
          ),
        ),

        h('div', { className: 'fde-filters' },
          h('input', {
            className: 'fde-input fde-search',
            placeholder: t('search'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h('div', { className: 'fde-chips' },
            h('button', { className: `fde-chip${domain === '' ? ' on' : ''}`, onClick: () => setDomain('') }, t('allDomains')),
            ...(data?.domains ?? []).map((item) => h('button', {
              key: item,
              className: `fde-chip${domain === item ? ' on' : ''}`,
              onClick: () => setDomain(domain === item ? '' : item),
            }, item)),
          ),
        ),

        data?.remoteError ? h('div', { className: 'fde-hint fde-hint-warn' }, `${t('remoteErr')}：${data.remoteError}`) : null,

        scenes.length === 0
          ? h('div', { className: 'fde-muted fde-side-empty' }, t('localEmpty'))
          : h('div', { className: 'fde-cards' },
              scenes.map((scene) => h('article', {
                key: scene.id,
                className: 'fde-scene',
                onClick: () => setDetail(detail?.id === scene.id ? null : scene),
              },
                h('div', { className: 'fde-scene-h' },
                  h('span', { className: 'fde-scene-t' }, scene.title),
                  h(Pill, { tone: scene.origin === 'local' ? 'ok' : null }, t(scene.origin === 'local' ? 'local' : scene.origin === 'seed' ? 'seed' : 'remote')),
                ),
                h('div', { className: 'fde-scene-s' }, scene.summary),
                h('div', { className: 'fde-scene-m' },
                  h(Pill, null, scene.domain),
                  scene.industry ? h(Pill, null, scene.industry) : null,
                  scene.aiPattern ? h(Pill, null, scene.aiPattern) : null,
                  h(Pill, null, scene.effort),
                ),
                detail?.id === scene.id
                  ? h('div', { className: 'fde-scene-d' },
                      h(Field, { label: '痛点', value: scene.pain }),
                      h(Field, { label: t('injection'), value: scene.injection }),
                      h(Field, { label: t('input'), value: scene.inputs }),
                      h(Field, { label: t('output'), value: scene.outputs }),
                      h(Field, { label: t('human'), value: scene.humanInLoop }),
                      h(Field, { label: t('proof'), value: scene.proofMetric }),
                      scene.metrics?.length ? h(Field, { label: t('metrics'), value: scene.metrics.join('；') }) : null,
                      scene.risks?.length ? h(Field, { label: t('risk'), value: scene.risks.join('；') }) : null,
                      h('div', { className: 'fde-actions', onClick: (event) => event.stopPropagation() },
                        h('button', { className: 'fde-btn fde-btn-primary', disabled: busy, onClick: () => void useScene(scene) }, t('useScene')),
                        scene.origin === 'local'
                          ? h('button', { className: 'fde-btn fde-btn-ghost', disabled: busy, onClick: () => void removeScene(scene) }, t('removeScene'))
                          : null,
                      ))
                  : null,
              )),
            ),
        toast !== '' ? h('div', { className: 'fde-toast' }, toast) : null,
      )
    }

    // ── 图标 ──────────────────────────────────────────────────────────────
    function WorkIcon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z' }),
        h('path', { d: 'M5 11a7 7 0 0 0 14 0' }),
        h('path', { d: 'M12 18v3' }),
        h('path', { d: 'M8.5 21h7' }),
      )
    }

    function MarketIcon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }),
        h('rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }),
        h('rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }),
        h('path', { d: 'M17.5 14v7M14 17.5h7' }),
      )
    }

    // ── 样式 ──────────────────────────────────────────────────────────────
    const STYLES = `
.fde-page { display:flex; flex-direction:column; height:100%; min-height:0; padding:20px 24px 0; gap:14px;
  color:var(--dsw-alias-label-primary,#1b1b1b); font-size:13px; }
.fde-top { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; }
.fde-title { font-size:18px; font-weight:600; letter-spacing:.2px; }
.fde-sub { margin-top:2px; font-size:12px; color:var(--dsw-alias-label-tertiary,#8a8a8a); }
.fde-top-r { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.fde-body { display:grid; grid-template-columns:236px minmax(0,1fr); gap:16px; flex:1; min-height:0; padding-bottom:20px; }
.fde-side { overflow:auto; display:flex; flex-direction:column; gap:6px; padding-right:4px; }
.fde-side-empty { padding:14px; line-height:1.7; }
.fde-case-row { text-align:left; border:1px solid transparent; background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));
  border-radius:10px; padding:9px 11px; cursor:pointer; color:inherit; font:inherit; display:flex; flex-direction:column; gap:4px; }
.fde-case-row:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06)); }
.fde-case-row.on { border-color:var(--dsw-alias-interactive-primary,#3b6ef6); background:var(--dsw-alias-bg-layer-1,#fff); }
.fde-case-t { font-weight:600; font-size:12.5px; line-height:1.35; word-break:break-word; }
.fde-case-m { display:flex; gap:8px; font-size:11px; color:var(--dsw-alias-label-tertiary,#8a8a8a); }
.fde-main { overflow:auto; padding-right:6px; display:flex; flex-direction:column; gap:12px; }
.fde-detail { display:flex; flex-direction:column; gap:12px; }
.fde-detail-h { display:flex; gap:10px; align-items:center; }
.fde-input { width:100%; box-sizing:border-box; border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12)); border-radius:8px;
  padding:7px 10px; font:inherit; font-size:13px; background:var(--dsw-alias-bg-layer-1,#fff); color:inherit; outline:none; }
.fde-input:focus { border-color:var(--dsw-alias-interactive-primary,#3b6ef6); }
.fde-input-title { font-size:16px; font-weight:600; padding:6px 10px; }
.fde-textarea { resize:vertical; line-height:1.6; }
.fde-grid2 { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
.fde-label { display:flex; flex-direction:column; gap:4px; font-size:11px; color:var(--dsw-alias-label-tertiary,#8a8a8a); }
.fde-btn { border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12)); background:var(--dsw-alias-bg-layer-1,#fff);
  color:inherit; border-radius:8px; padding:7px 13px; font:inherit; font-size:12.5px; cursor:pointer; white-space:nowrap; text-decoration:none; }
.fde-btn:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05)); }
.fde-btn:disabled { opacity:.5; cursor:not-allowed; }
.fde-btn-primary { background:var(--dsw-alias-interactive-primary,#3b6ef6); border-color:transparent; color:#fff; }
.fde-btn-primary:hover:not(:disabled) { filter:brightness(1.06); background:var(--dsw-alias-interactive-primary,#3b6ef6); }
.fde-btn-ghost { background:transparent; }
.fde-btn-s { padding:3px 9px; font-size:11.5px; }
.fde-btn-rec { border-color:var(--dsw-alias-state-error-primary,#d33); color:var(--dsw-alias-state-error-primary,#d33); }
.fde-actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.fde-section { border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1)); border-radius:12px; padding:12px 14px;
  background:var(--dsw-alias-bg-layer-1,#fff); display:flex; flex-direction:column; gap:8px; }
.fde-h3 { margin:0; font-size:13px; font-weight:600; display:flex; align-items:baseline; gap:8px; }
.fde-aside { font-size:11px; font-weight:400; color:var(--dsw-alias-label-tertiary,#8a8a8a); }
.fde-pill { display:inline-flex; align-items:center; border-radius:999px; padding:2px 8px; font-size:11px;
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05)); color:var(--dsw-alias-label-secondary,#555); white-space:nowrap; }
.fde-pill-ok { background:rgba(28,155,90,.12); color:var(--dsw-alias-state-success-primary,#1c9b5a); }
.fde-pill-warn { background:rgba(200,120,0,.12); color:var(--dsw-alias-state-warn-primary,#b8730a); }
.fde-pill-bad { background:rgba(200,50,50,.12); color:var(--dsw-alias-state-error-primary,#c33); }
.fde-p-card { }
.fde-card { border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.09)); border-radius:10px; padding:10px 12px; display:flex; flex-direction:column; gap:5px; }
.fde-card-opp { background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02)); }
.fde-card-h { display:flex; align-items:center; gap:8px; font-weight:600; font-size:12.5px; flex-wrap:wrap; }
.fde-card-h-r { margin-left:auto; display:flex; gap:6px; align-items:center; }
.fde-idx { width:18px; height:18px; border-radius:6px; display:inline-flex; align-items:center; justify-content:center;
  background:var(--dsw-alias-interactive-primary,#3b6ef6); color:#fff; font-size:11px; }
.fde-scores { display:flex; gap:16px; font-size:11px; color:var(--dsw-alias-label-tertiary,#8a8a8a); }
.fde-scores > span { display:inline-flex; align-items:center; gap:6px; }
.fde-score { display:inline-flex; gap:2px; }
.fde-score i { width:5px; height:10px; border-radius:2px; background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.12)); display:inline-block; }
.fde-score i.on { background:var(--dsw-alias-interactive-primary,#3b6ef6); }
.fde-field { display:grid; grid-template-columns:76px minmax(0,1fr); gap:8px; font-size:12px; line-height:1.6; }
.fde-field-k { color:var(--dsw-alias-label-tertiary,#8a8a8a); }
.fde-field-v { color:var(--dsw-alias-label-secondary,#444); word-break:break-word; }
.fde-sub { font-size:12px; display:flex; flex-direction:column; gap:4px; }
.fde-sub > b, .fde-sub { font-weight:500; }
.fde-list { margin:0; padding-left:18px; line-height:1.85; }
.fde-list-warn li { color:var(--dsw-alias-state-warn-primary,#b8730a); }
.fde-steps { margin:0; padding-left:20px; line-height:1.9; }
.fde-table { width:100%; border-collapse:collapse; font-size:12px; }
.fde-table th, .fde-table td { text-align:left; padding:5px 8px; border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08)); }
.fde-table th { font-weight:500; color:var(--dsw-alias-label-tertiary,#8a8a8a); }
.fde-hero { border-radius:12px; padding:14px 16px; background:linear-gradient(135deg,rgba(59,110,246,.10),rgba(59,110,246,.02));
  border:1px solid rgba(59,110,246,.18); display:flex; flex-direction:column; gap:6px; }
.fde-hero-t { font-size:16px; font-weight:600; }
.fde-hero-s { font-size:12.5px; color:var(--dsw-alias-label-secondary,#555); line-height:1.6; }
.fde-hero-m { display:flex; gap:6px; }
.fde-stage { border-left:2px solid var(--dsw-alias-interactive-primary,#3b6ef6); padding-left:10px; display:flex; flex-direction:column; gap:3px; }
.fde-stage-h { font-weight:600; font-size:12.5px; display:flex; gap:8px; align-items:baseline; }
.fde-p { margin:0; line-height:1.75; font-size:12.5px; color:var(--dsw-alias-label-secondary,#444); }
.fde-pre { margin:0; max-height:220px; overflow:auto; white-space:pre-wrap; font-size:11.5px; line-height:1.7;
  font-family:var(--dsw-font-family-mono,ui-monospace,monospace); color:var(--dsw-alias-label-secondary,#555);
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03)); border-radius:8px; padding:10px; }
.fde-muted { color:var(--dsw-alias-label-tertiary,#8a8a8a); font-size:12px; line-height:1.7; }
.fde-ok { color:var(--dsw-alias-state-success-primary,#1c9b5a); }
.fde-note { font-size:11px; color:var(--dsw-alias-state-warn-primary,#b8730a); line-height:1.6; }
.fde-source { border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08)); border-radius:9px; padding:8px 10px; display:flex; flex-direction:column; gap:4px; }
.fde-source-main { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.fde-source-name { font-size:12.5px; word-break:break-all; }
.fde-run { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.fde-hint { font-size:11.5px; line-height:1.7; border-radius:9px; padding:9px 11px; }
.fde-hint-warn { background:rgba(200,120,0,.10); color:var(--dsw-alias-state-warn-primary,#8a5800); }
.fde-paste { display:flex; flex-direction:column; gap:8px; padding:10px; border-radius:10px;
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02)); }
.fde-toast { position:sticky; bottom:12px; align-self:center; background:rgba(20,20,20,.9); color:#fff;
  padding:8px 16px; border-radius:999px; font-size:12px; }
.fde-toast.bad { background:rgba(180,40,40,.94); }
.fde-filters { display:flex; flex-direction:column; gap:10px; }
.fde-search { max-width:420px; }
.fde-chips { display:flex; gap:6px; flex-wrap:wrap; }
.fde-chip { border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12)); background:transparent; color:inherit;
  border-radius:999px; padding:4px 12px; font:inherit; font-size:12px; cursor:pointer; }
.fde-chip.on { background:var(--dsw-alias-interactive-primary,#3b6ef6); border-color:transparent; color:#fff; }
.fde-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; overflow:auto; padding-bottom:24px; }
.fde-scene { border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1)); border-radius:12px; padding:12px 14px;
  background:var(--dsw-alias-bg-layer-1,#fff); display:flex; flex-direction:column; gap:7px; cursor:pointer; }
.fde-scene:hover { border-color:var(--dsw-alias-interactive-primary,#3b6ef6); }
.fde-scene-h { display:flex; align-items:flex-start; gap:8px; }
.fde-scene-t { font-weight:600; font-size:13px; line-height:1.4; flex:1; }
.fde-scene-s { font-size:12px; line-height:1.65; color:var(--dsw-alias-label-secondary,#555); }
.fde-scene-m { display:flex; gap:6px; flex-wrap:wrap; }
.fde-scene-d { margin-top:6px; padding-top:10px; border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));
  display:flex; flex-direction:column; gap:6px; }
@media (max-width:820px) {
  .fde-body { grid-template-columns:1fr; }
  .fde-side { flex-direction:row; overflow-x:auto; }
  .fde-case-row { min-width:170px; }
  .fde-grid2 { grid-template-columns:1fr; }
}
`

    function injectStyles() {
      const existing = document.getElementById('dsh-fdehub-styles')
      if (existing !== null) existing.remove()
      const style = document.createElement('style')
      style.id = 'dsh-fdehub-styles'
      style.textContent = STYLES
      document.head.appendChild(style)
      return () => style.remove()
    }

    // ── 插件体 ────────────────────────────────────────────────────────────
    exports.inject = ['slots']

    const warn = (stage, error) => {
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn(`[dsh-fdehub] ${stage} failed:`, error)
      }
    }

    exports.apply = function apply(ctx) {
      hostCtx = ctx
      applyLang(ctx)
      ctx.effect(() => injectStyles(), 'dsh-fdehub: styles')

      const attempt = (stage, run) => {
        try {
          run()
        } catch (error) {
          warn(stage, error)
        }
      }

      attempt('work panel', () => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_WORK }, WorkPage)))
      attempt('work entry', () =>
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_WORK, order: 21, label: () => t('workTitle') }, WorkIcon),
        ),
      )
      attempt('market panel', () => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_MARKET }, MarketPage)))
      attempt('market entry', () =>
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_MARKET, order: 22, label: () => t('marketTitle') }, MarketIcon),
        ),
      )
    }

    void hostCtx
    return module.exports
  },
})
