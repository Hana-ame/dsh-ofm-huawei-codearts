/**
 * dsh-ofm-huawei-codearts — 浏览器端（设置页栏目）。
 *
 * 在「设置」里加一栏「华为云 CodeArts」，显示：
 *   - 积分余额（总积分包剩余 / 总额 / 已用 / 即将过期，及基础/按需/赠送明细）
 *   - 每日签到状态（今日是否已签、上次结果、时间）
 *
 * 数据来自本插件服务端的 GET /api/dsh-ofm-huawei-codearts/balance
 * （服务端用账号 AK/SK 签名查询 CodeArts 统计接口，AK/SK 不会下发到浏览器）。
 *
 * 手写 ModuleLoader bundle：React 由 shell 提供，无构建步骤。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ofm-huawei-codearts',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useEffect, useState } = React

    const NS = 'settings.huaweiCodearts'
    const API = '/api/dsh-ofm-huawei-codearts'
    const inject = ['slots', 'locale']

    const DICT = {
      zh: {
        nav: '华为云 CodeArts',
        title: '华为云 CodeArts',
        subtitle: '体验版积分余额与每日签到状态。数据由插件服务端用账号密钥签名查询，密钥不会进入浏览器。',
        balanceTitle: '积分余额',
        total: '总积分包',
        remain: '剩余',
        amount: '总额',
        used: '已用',
        expiring: '即将过期',
        breakdown: '明细',
        basic: '基础积分包',
        onDemand: '按需积分包',
        bonus: '赠送积分包',
        checkinTitle: '每日自动签到',
        checkedInToday: '今日已签到',
        notCheckedIn: '今日尚未签到',
        lastResult: '上次结果',
        lastDate: '上次签到日期',
        lastAt: '上次执行时间',
        disabledInPanel: '开关在「频道」页',
        loading: '加载中…',
        refresh: '刷新',
        retry: '重试',
        loadFailed: '读取失败',
        noBalance: '该账号没有积分口径（可能是 Token 计费账号）',
        package: '套餐',
        updatedAt: '查询时间',
        cycle: '积分周期',
        cycleHint: '周期结束（end_date）后，未使用的积分预计失效。接口不提供逐笔到期日。',
        // ── 即将过期明细（本地账本反解，远端无明细 API）──
        expiringTitle: '即将过期的积分',
        expiringHint: '华为接口只给「最早到期组的剩余」，不提供逐笔发放/到期明细。下表由本插件在本地记录读数并按官方扣减顺序反解得出；标「推算」的到期日不是接口字段。',
        expiringHintShort: '按到期日排序，最近到期的在前',
        expiringShowMore: '显示更多',
        expiringDaysUnit: '天',
        expiringEmpty: '暂无到期明细：本地还没有足够的历史读数。多刷新几次（每次查余额都会记一个点），明细会逐步出现。',
        expiringFailed: '到期明细不可用',
        expiringColGrant: '积分来源',
        expiringColAmount: '获得',
        expiringColUsed: '已用',
        expiringColRemain: '剩余',
        expiringColExpire: '截止日期',
        expiringColDays: '剩余天数',
        expiringTotal: '合计',
        expiringPrecise: '精确',
        expiringEstimated: '推算',
        expiringHidden: '还有 {n} 笔未列出',
        expiringExactHint: '「精确」= 官方 end_date 周期末清零；「推算」= 接口不提供逐笔到期日，按已知规则推算。',
        noCycle: '—',
        accountTitle: '账号凭据',
        relogin: '重新登录 CodeArts',
        loginPending: '等待浏览器授权…',
        loginWait: '已打开 CodeArts 登录页，请完成授权后返回本页。',
        loginSucceeded: '登录成功，凭据已更新。',
        loginFailed: '登录失败',
        loginTimeout: '登录超时（3 分钟），请重试。',
        loginHint: '刷新令牌是一次性的：失效后点这里重新授权即可，无需重装插件。',
        openLogin: '打开登录页',
        modelsTitle: '模型与图片能力',
        modelsHint: '华为云目录每 2 小时刷新一次：这里只保存你改过的行（与目录相同的行不落盘），目录更新会自动跟随。勾选「图片」的模型，DSH 才会把图片按 data URL 发给它；不勾的模型照旧只收文字。',
        modelId: '模型 id',
        modelName: '名称',
        contextWindow: '上下文窗口',
        maxOutput: '最大输出',
        modalityText: '文字',
        modalityImage: '图片',
        addModel: '添加模型',
        remove: '移除',
        test: '测试',
        testing: '发送 hi…',
        testOk: '✓ 通',
        testFailed: '✗ 失败',
        testHint: '给这个模型发一条 hi，验证账号与模型是否真的可用。',
        saveModels: '保存模型设置',
        resetModels: '恢复目录默认',
        saving: '保存中…',
        modelsLoading: '正在读取模型目录…',
        modelsSaved: '已保存；下一次请求即生效（无需重启）。',
        modelsReset: '已恢复为目录默认。',
        modelsLoadFailed: '模型目录读取失败',
        modelInvalid: '至少要有一个模型，且每行的 id 不能为空。',
        modelPath: '覆盖表文件',
        imageRisk: '注意：CodeArts 端点历史上会拒绝非文本块。只有确实支持视觉的模型才勾「图片」，否则该模型的请求可能被上游回以空流；勾错随时取消并保存。',
      },
      en: {
        nav: 'Huawei CodeArts',
        title: 'Huawei CodeArts',
        subtitle: 'Trial credit balance and daily check-in status. The plugin server signs the query with account keys; secrets never reach the browser.',
        balanceTitle: 'Credit balance',
        total: 'Total credit package',
        remain: 'Remaining',
        amount: 'Amount',
        used: 'Used',
        expiring: 'Expiring soon',
        breakdown: 'Breakdown',
        basic: 'Basic package',
        onDemand: 'On-demand package',
        bonus: 'Bonus package',
        checkinTitle: 'Daily auto check-in',
        checkedInToday: 'Checked in today',
        notCheckedIn: 'Not checked in yet',
        lastResult: 'Last result',
        lastDate: 'Last check-in date',
        lastAt: 'Last run',
        disabledInPanel: 'Toggle on the Channels page',
        loading: 'Loading…',
        refresh: 'Refresh',
        retry: 'Retry',
        loadFailed: 'Failed to load',
        noBalance: 'This account has no credit metric (token-billed account?)',
        package: 'Plan',
        updatedAt: 'Queried at',
        cycle: 'Credit period',
        cycleHint: 'Unused credits are expected to expire when the period ends (end_date). The API exposes no per-grant expiry date.',
        expiringTitle: 'Credits expiring soon',
        expiringHint: 'The Huawei API only exposes the remaining amount of the earliest-expiring bucket — no per-grant or per-expiry detail. The rows below are reconstructed locally from recorded readings plus the official deduction order; dates marked “estimated” are not API fields.',
        expiringHintShort: 'Sorted by expiry, soonest first',
        expiringShowMore: 'Show more',
        expiringDaysUnit: 'd',
        expiringEmpty: 'No expiry detail yet: not enough local history. Refresh a few times (each balance query records one sample) and the rows will appear.',
        expiringFailed: 'Expiry detail unavailable',
        expiringColGrant: 'Source',
        expiringColAmount: 'Granted',
        expiringColUsed: 'Used',
        expiringColRemain: 'Remaining',
        expiringColExpire: 'Expires on',
        expiringColDays: 'Days left',
        expiringTotal: 'Total',
        expiringPrecise: 'exact',
        expiringEstimated: 'estimated',
        expiringHidden: '{n} more not shown',
        expiringExactHint: '“exact” = official end_date cycle reset; “estimated” = the API exposes no per-grant expiry date, so it is derived from known rules.',
        noCycle: '—',
        accountTitle: 'Account credential',
        relogin: 'Re-login CodeArts',
        loginPending: 'Waiting for browser authorization…',
        loginWait: 'CodeArts login page opened — finish authorization and come back.',
        loginSucceeded: 'Logged in; credential updated.',
        loginFailed: 'Login failed',
        loginTimeout: 'Login timed out (3 minutes), please retry.',
        loginHint: 'The refresh token is single-use: re-authorize here when it expires.',
        openLogin: 'Open login page',
        modelsTitle: 'Models & image capability',
        modelsHint: 'The Huawei catalog refreshes every 2 hours; only edited rows are stored, so untouched rows follow upstream automatically. A model with “Image” ticked is the only kind DSH sends images to (as data URLs); the rest stay text-only.',
        modelId: 'Model id',
        modelName: 'Name',
        contextWindow: 'Context window',
        maxOutput: 'Max output',
        modalityText: 'Text',
        modalityImage: 'Image',
        addModel: 'Add model',
        remove: 'Remove',
        test: 'Test',
        testing: 'Sending hi…',
        testOk: '✓ OK',
        testFailed: '✗ Failed',
        testHint: 'Send one "hi" to this model to verify the credential and model actually work.',
        saveModels: 'Save model settings',
        resetModels: 'Restore catalog defaults',
        saving: 'Saving…',
        modelsLoading: 'Loading model catalog…',
        modelsSaved: 'Saved; effective on the next request (no restart).',
        modelsReset: 'Restored to catalog defaults.',
        modelsLoadFailed: 'Could not load the model catalog',
        modelInvalid: 'Keep at least one model and give every row a non-empty id.',
        modelPath: 'Overrides file',
        imageRisk: 'Note: the CodeArts endpoint historically rejected non-text blocks. Tick “Image” only for models that really are vision-capable, otherwise that model may answer with an empty stream; untick and save to revert.',
      },
    }

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        maxWidth: '860px',
        fontSize: '13px',
        lineHeight: '1.55',
        color: 'var(--dsw-alias-label-primary, #e8e8e8)',
      },
      hero: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '18px 20px',
        border: '1px solid var(--dsw-alias-border-l2, #3a3a3a)',
        borderRadius: '16px',
        background: 'var(--dsw-alias-bg-layer-3, #242424)',
      },
      h2: { margin: 0, fontSize: '20px', fontWeight: 700, letterSpacing: '-0.3px' },
      subtitle: { margin: 0, color: 'var(--dsw-alias-label-secondary, #a8a8a8)' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '16px',
        border: '1px solid var(--dsw-alias-border-l2, #3a3a3a)',
        borderRadius: '14px',
        background: 'var(--dsw-alias-bg-layer-3, #242424)',
      },
      sectionTitle: { margin: 0, fontSize: '14px', fontWeight: 650 },
      big: { fontSize: '32px', fontWeight: 700, letterSpacing: '-0.5px' },
      row: { display: 'flex', gap: '24px', flexWrap: 'wrap' },
      field: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '120px' },
      label: { color: 'var(--dsw-alias-label-secondary, #a8a8a8)', fontSize: '12px' },
      value: { fontSize: '14px', fontWeight: 600 },
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '2px 10px',
        borderRadius: '999px',
        fontSize: '12px',
        border: '1px solid var(--dsw-alias-border-l2, #3a3a3a)',
      },
      ok: { color: '#5ad17a' },
      warn: { color: '#e0b34a' },
      err: { color: '#e06a6a' },
      table: { display: 'flex', flexDirection: 'column', gap: '6px' },
      tableRow: {
        display: 'grid',
        gridTemplateColumns: '120px 1fr 1fr 1fr',
        gap: '12px',
        alignItems: 'center',
        padding: '6px 0',
        borderTop: '1px solid var(--dsw-alias-border-l2, #3a3a3a)',
      },
      head: { color: 'var(--dsw-alias-label-secondary, #a8a8a8)', fontSize: '12px' },
      actions: { display: 'flex', gap: '10px', alignItems: 'center' },
      button: {
        padding: '6px 14px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, #3a3a3a)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '13px',
      },
      note: { margin: 0, color: 'var(--dsw-alias-label-secondary, #a8a8a8)', fontSize: '12px' },
      // ── 模型与图片能力卡片 ──────────────────────────────────────────────
      // 版面口径与 keypool 插件一致：行内控件顶部对齐（alignItems:start），
      // 勾选框用 labelSpacer(14px) + checkTall(38px) 与输入框同高同底，
      // 否则勾选框会吊在数字字段下方 30 多像素（2026-10-31 实测修复过同类问题）。
      modelItem: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '9px 0',
        borderTop: '1px solid var(--dsw-alias-border-l2, #3a3a3a)',
      },
      modelRow: {
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr) auto auto',
        gap: '8px',
        alignItems: 'end',
      },
      modelRow2: {
        display: 'grid',
        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        gap: '8px',
        alignItems: 'end',
      },
      modelField: {
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
        minWidth: 0,
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary, #a8a8a8)',
      },
      labelSpacer: { display: 'block', height: '14px', lineHeight: '14px', fontSize: '11px' },
      checkTall: {
        display: 'flex',
        alignItems: 'center',
        gap: '7px',
        minHeight: '38px',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary, #a8a8a8)',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, #3a3a3a)',
        background: 'var(--dsw-alias-bg-layer-1, #1a1a1a)',
        color: 'var(--dsw-alias-label-primary, #e8e8e8)',
        font: 'inherit',
      },
      danger: { color: 'var(--dsw-alias-state-error-primary, #ff6b6b)' },
      testResult: {
        display: 'flex',
        gap: '8px',
        alignItems: 'baseline',
        fontSize: '11px',
        lineHeight: '1.5',
        wordBreak: 'break-word',
      },
      testText: { color: 'var(--dsw-alias-label-secondary, #a8a8a8)' },
      // ── 即将过期明细（列表式）────────────────────────────────────────
      // 设置弹窗内容区只有 ~390px，六列表格在任何字号下都挤不下（实测两次
      // 都被「截止日期」列裁切）。改成「每笔一张小卡」：主行 = 来源 + 剩余，
      // 副行 = 获得 / 已用 / 截止日期。窄容器下自动换行，永不横向裁切。
      expireList: { display: 'flex', flexDirection: 'column', gap: '6px' },
      expireItem: {
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
        padding: '8px 10px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l2, #3a3a3a)',
        background: 'var(--dsw-alias-bg-layer-1, #1a1a1a)',
      },
      expireHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px' },
      grantName: { fontSize: '12px', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      remainWrap: { display: 'flex', alignItems: 'baseline', gap: '5px', flexShrink: 0 },
      remainMark: { fontSize: '15px', fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
      expireMeta: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px 12px',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary, #a8a8a8)',
      },
      metaNum: { color: 'var(--dsw-alias-label-primary, #c8c8c8)', fontVariantNumeric: 'tabular-nums' },
      expireCell: { display: 'inline-flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' },
      expireTotal: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px 12px',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        marginTop: '2px',
        paddingTop: '7px',
        borderTop: '1px solid var(--dsw-alias-border-l2, #3a3a3a)',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary, #a8a8a8)',
      },
      totalNums: { fontVariantNumeric: 'tabular-nums' },
      daysHint: { color: 'var(--dsw-alias-label-secondary, #a8a8a8)', fontSize: '10px', fontVariantNumeric: 'tabular-nums' },
      tag: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '0 5px',
        borderRadius: '999px',
        fontSize: '10px',
        lineHeight: '15px',
        border: '1px solid currentColor',
        whiteSpace: 'nowrap',
      },
      tagOk: { color: '#5ad17a' },
      tagWarn: { color: '#e0b34a' },
    }

    /** 模型行的稳定身份：React key 绝不能取自可编辑的 model.id（会逐字符丢焦点）。 */
    let modelSeq = 0
    function nextModelUid() {
      modelSeq += 1
      return `codearts-model-${modelSeq}`
    }

    /** 把服务端返回的模型行折成 UI 行（补 uid + 归一化模态）。 */
    function toModelRows(models) {
      return (Array.isArray(models) ? models : []).map(model => ({
        uid: nextModelUid(),
        id: String(model?.id ?? ''),
        name: String(model?.name ?? ''),
        contextWindow: Number(model?.contextWindow) > 0 ? Number(model.contextWindow) : 0,
        maxOutput: Number(model?.maxOutput) > 0 ? Number(model.maxOutput) : 0,
        inputModalities: Array.isArray(model?.inputModalities) && model.inputModalities.includes('image')
          ? ['text', 'image']
          : ['text'],
      }))
    }

    const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })

    function credit(value) {
      const num = Number(value)
      return Number.isFinite(num) ? numberFormat.format(num) : '—'
    }

    /** 距今天数（向上取整；0 = 今天到期）。用于明细表的「剩余天数」列。 */
    function daysLeftOf(expireAtMs) {
      const ms = Number(expireAtMs)
      if (!Number.isFinite(ms) || ms <= 0) return 0
      return Math.max(0, Math.ceil((ms - Date.now()) / 86400000))
    }

    function timeText(ms, t) {
      const num = Number(ms)
      if (!Number.isFinite(num) || num <= 0) return '—'
      return new Date(num).toLocaleString('zh-CN', { hour12: false })
    }

    function Page(props) {
      const t = props.t ?? (x => x)
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(true)
      const [queriedAt, setQueriedAt] = useState(0)
      // 「即将过期」明细显示条数（点按钮 +5，到 20 回落到 5）。
      const [expiringLimit, setExpiringLimit] = useState(5)
      const [loginBusy, setLoginBusy] = useState(false)
      const [loginMessage, setLoginMessage] = useState('')
      const [loginUrl, setLoginUrl] = useState('')
      // 模型与图片能力（GET/POST /models）
      const [models, setModels] = useState([])
      const [modelsRemoved, setModelsRemoved] = useState([])
      const [modelsPath, setModelsPath] = useState('')
      // Per-model "test" results, keyed by row uid: { busy, ok, latencyMs, text, error }
      const [tests, setTests] = useState({})
      const [modelsBusy, setModelsBusy] = useState(false)
      const [modelsMessage, setModelsMessage] = useState('')
      const [modelsError, setModelsError] = useState('')
      const [modelsLoaded, setModelsLoaded] = useState(false)

      const load = async () => {
        setLoading(true)
        setError('')
        try {
          const response = await fetch(`${API}/balance?limit=${expiringLimit}`, { headers: { accept: 'application/json' } })
          const payload = await response.json().catch(() => null)
          if (!response.ok || !payload?.ok) {
            throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
          }
          setData(payload)
          setQueriedAt(Date.now())
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setLoading(false)
        }
      }

      useEffect(() => {
        void load()
        void loadModels()
      }, [])

      const applyModelsPayload = payload => {
        setModels(toModelRows(payload?.models))
        setModelsRemoved(Array.isArray(payload?.removed) ? payload.removed : [])
        setModelsPath(String(payload?.settingsPath ?? ''))
        setModelsLoaded(true)
      }

      const loadModels = async () => {
        setModelsError('')
        try {
          const response = await fetch(`${API}/models`, { headers: { accept: 'application/json' } })
          const payload = await response.json().catch(() => null)
          if (!response.ok || !payload?.ok) {
            throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
          }
          applyModelsPayload(payload)
        } catch (cause) {
          setModelsError(String(cause?.message ?? cause))
          setModelsLoaded(true)
        }
      }

      const updateModel = (index, patch) => {
        setModels(current => current.map((model, i) => (i === index ? { ...model, ...patch } : model)))
      }

      const toggleModelModality = (index, modality) => {
        setModels(current => current.map((model, i) => {
          if (i !== index) return model
          const has = model.inputModalities.includes(modality)
          const next = has
            ? model.inputModalities.filter(entry => entry !== modality)
            : [...model.inputModalities, modality]
          return { ...model, inputModalities: next.includes('text') ? next : ['text', ...next] }
        }))
      }

      const addModel = () => {
        setModels(current => [...current, {
          uid: nextModelUid(),
          id: '',
          name: '',
          contextWindow: 0,
          maxOutput: 0,
          inputModalities: ['text'],
        }])
      }

      const removeModel = index => {
        setModels(current => {
          const row = current[index]
          if (row !== undefined && row.id !== '') {
            // 目录行必须登记到 removed，否则下次 GET 又会长回来。
            setModelsRemoved(previous => previous.includes(row.id) ? previous : [...previous, row.id])
          }
          return current.filter((_, i) => i !== index)
        })
      }

      /** 「测试」按钮：给这一行的模型发一条 `hi`（POST /models/test）。 */
      const runTest = async model => {
        const uid = model.uid
        setTests(current => ({ ...current, [uid]: { busy: true } }))
        try {
          const response = await fetch(`${API}/models/test`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: String(model.id ?? '').trim() }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
          setTests(current => ({ ...current, [uid]: payload }))
        } catch (cause) {
          setTests(current => ({
            ...current,
            [uid]: { ok: false, error: { message: String(cause?.message ?? cause) } },
          }))
        }
      }

      /** Render the last test result for one model row. */
      const testLine = model => {
        const result = tests[model.uid]
        if (result === undefined) return null
        const ok = result.ok === true
        const status = result.busy === true
          ? t('testing')
          : ok
            ? `${t('testOk')} ${(Number(result.latencyMs) / 1000).toFixed(1)}s`
            : `${t('testFailed')}${result.error?.code ? ` [${result.error.code}]` : ''}: ${result.error?.message ?? ''}`
        return h('div', { style: styles.testResult },
          h('span', { style: result.busy === true ? styles.testText : (ok ? styles.ok : styles.err) }, status),
          ok && result.text
            ? h('span', { style: styles.testText }, `“${String(result.text).trim().slice(0, 160)}”`)
            : null,
        )
      }

      const saveModels = async () => {
        setModelsBusy(true)
        setModelsMessage('')
        setModelsError('')
        try {
          const rows = models
            .map(model => ({
              id: String(model.id ?? '').trim(),
              name: String(model.name ?? '').trim(),
              ...(Number(model.contextWindow) > 0 ? { contextWindow: Number(model.contextWindow) } : {}),
              ...(Number(model.maxOutput) > 0 ? { maxOutput: Number(model.maxOutput) } : {}),
              inputModalities: Array.isArray(model.inputModalities) ? model.inputModalities : ['text'],
            }))
            .filter(model => model.id !== '')
          if (rows.length === 0) throw new Error(t('modelInvalid'))
          const response = await fetch(`${API}/models`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ models: rows, removed: modelsRemoved }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || !payload?.ok) {
            throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
          }
          applyModelsPayload(payload)
          setModelsMessage(t('modelsSaved'))
        } catch (cause) {
          setModelsError(String(cause?.message ?? cause))
        } finally {
          setModelsBusy(false)
        }
      }

      const resetModels = async () => {
        setModelsBusy(true)
        setModelsMessage('')
        setModelsError('')
        try {
          const response = await fetch(`${API}/models`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reset: true }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || !payload?.ok) {
            throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
          }
          applyModelsPayload(payload)
          setModelsMessage(t('modelsReset'))
        } catch (cause) {
          setModelsError(String(cause?.message ?? cause))
        } finally {
          setModelsBusy(false)
        }
      }

      const watchLogin = async () => {
        for (let i = 0; i < 100; i += 1) {
          await new Promise(resolve => setTimeout(resolve, 2000))
          try {
            const response = await fetch(`${API}/login/status`, { headers: { accept: 'application/json' } })
            const payload = await response.json().catch(() => null)
            if (payload?.state === 'succeeded') {
              setLoginMessage(t('loginSucceeded'))
              await load()
              return
            }
            if (payload?.state === 'failed') {
              setLoginMessage(`${t('loginFailed')}: ${payload.message ?? ''}`)
              return
            }
          } catch {
            // 轮询单次失败忽略，继续等
          }
        }
        setLoginMessage(t('loginTimeout'))
      }

      const onLogin = async () => {
        setLoginBusy(true)
        setLoginMessage('')
        try {
          const response = await fetch(`${API}/login`, { method: 'POST', headers: { accept: 'application/json' } })
          const payload = await response.json().catch(() => null)
          if (!response.ok || !payload?.url) {
            throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
          }
          setLoginUrl(payload.url)
          // 必须在点击后的手势窗口内同步打开，否则会被弹窗拦截。
          window.open(payload.url, '_blank', 'noopener,noreferrer')
          setLoginMessage(t('loginWait'))
          await watchLogin()
        } catch (cause) {
          setLoginMessage(`${t('loginFailed')}: ${cause?.message ?? cause}`)
        } finally {
          setLoginBusy(false)
        }
      }

      const balance = data?.balance
      const checkin = data?.checkin
      const ranToday = checkin?.lastDate === data?.today

      const breakdown = balance == null ? [] : [
        [t('basic'), balance.basic],
        [t('onDemand'), balance.onDemand],
        [t('bonus'), balance.bonus],
      ].filter(([, item]) => item !== undefined && item !== null)

      return h('div', { style: styles.root },
        h('div', { style: styles.hero },
          h('h2', { style: styles.h2 }, t('title')),
          h('p', { style: styles.subtitle }, t('subtitle')),
        ),

        h('div', { style: styles.card },
          h('div', { style: styles.actions },
            h('h3', { style: styles.sectionTitle }, t('balanceTitle')),
            h('button', { type: 'button', style: styles.button, onClick: () => void load(), disabled: loading },
              loading ? t('loading') : t('refresh')),
          ),
          loading && data == null
            ? h('p', { style: styles.note }, t('loading'))
            : error !== ''
              ? h('div', null,
                  h('p', { style: { ...styles.note, ...styles.err } }, `${t('loadFailed')}: ${error}`),
                  h('button', { type: 'button', style: styles.button, onClick: () => void load() }, t('retry')),
                )
              : balance == null
                ? h('p', { style: styles.note }, t('noBalance'))
                : h('div', null,
                    h('div', { style: styles.row },
                      h('div', { style: styles.field },
                        h('span', { style: styles.label }, `${t('total')} · ${t('remain')}`),
                        h('span', { style: { ...styles.big, ...styles.ok } }, credit(balance.total?.remain)),
                      ),
                      h('div', { style: styles.field },
                        h('span', { style: styles.label }, t('amount')),
                        h('span', { style: styles.value }, credit(balance.total?.amount)),
                      ),
                      h('div', { style: styles.field },
                        h('span', { style: styles.label }, t('used')),
                        h('span', { style: styles.value }, credit(balance.total?.used)),
                      ),
                      h('div', { style: styles.field },
                        h('span', { style: styles.label }, t('expiring')),
                        h('span', { style: { ...styles.value, ...styles.warn } }, credit(balance.total?.expiring)),
                      ),
                      h('div', { style: styles.field },
                        h('span', { style: styles.label }, t('package')),
                        h('span', { style: styles.value }, balance.packageName === '' ? '—' : balance.packageName),
                      ),
                      h('div', { style: styles.field },
                        h('span', { style: styles.label }, t('cycle')),
                        h('span', { style: styles.value },
                          balance.cycle?.startDate || balance.cycle?.endDate
                            ? `${balance.cycle?.startDate ?? '?'} ~ ${balance.cycle?.endDate ?? '?'}`
                            : t('noCycle')),
                      ),
                    ),
                    balance.cycle?.endDate ? h('p', { style: styles.note }, t('cycleHint')) : null,
                    breakdown.length === 0 ? null : h('div', { style: styles.table },
                      h('div', { style: { ...styles.tableRow, ...styles.head, borderTop: 'none' } },
                        h('span', null, t('breakdown')),
                        h('span', null, t('remain')),
                        h('span', null, t('amount')),
                        h('span', null, t('used')),
                      ),
                      breakdown.map(([label, item]) => h('div', { key: label, style: styles.tableRow },
                        h('span', null, label),
                        h('span', null, credit(item.remain)),
                        h('span', null, credit(item.amount)),
                        h('span', null, credit(item.used)),
                      )),
                    ),
                    queriedAt === 0 ? null : h('p', { style: styles.note },
                      `${t('updatedAt')}: ${new Date(queriedAt).toLocaleString('zh-CN', { hour12: false })}`),
                  ),
        ),

        // ── 即将过期的积分（最近 N 笔）────────────────────────────────
        // 数据来自 /balance 的 expiring 字段（服务端本地账本反解，见
        // src/quota-ledger.js）。接口本身没有明细，所以这一栏必须让用户
        // 一眼看出哪些是「精确」、哪些是「推算」。
        (() => {
          const expiring = data?.expiring
          const rows = Array.isArray(expiring?.rows) ? expiring.rows : []
          const totals = expiring?.totals
          const shownLimit = expiringLimit
          return h('div', { style: styles.card },
            h('div', { style: styles.actions },
              h('h3', { style: styles.sectionTitle }, t('expiringTitle')),
              h('span', { style: styles.note }, t('expiringHintShort')),
              h('button', {
                type: 'button',
                style: styles.button,
                onClick: () => { setExpiringLimit(prev => (prev >= 20 ? 5 : prev + 5)) },
              }, `${t('expiringShowMore')} (${shownLimit})`),
            ),
            expiring === null || expiring === undefined
              ? h('p', { style: styles.note }, t('expiringEmpty'))
              : rows.length === 0
                ? h('p', { style: styles.note }, t('expiringEmpty'))
                : h('div', { style: styles.expireList },
                    rows.map(row => h('div', { key: `${row.id}:${row.expireAt}`, style: styles.expireItem },
                      // 第一行：来源 + 剩余（剩余是用户最关心的数字，放右侧放大）
                      h('div', { style: styles.expireHead },
                        h('span', { style: styles.grantName }, row.label || t('expiringColGrant')),
                        h('span', { style: styles.remainWrap },
                          h('span', { style: styles.remainMark }, credit(row.remain)),
                          row.expireAt > 0
                            ? h('span', { style: styles.daysHint },
                                `${row.expireExact === true ? '' : '≈'}${daysLeftOf(row.expireAt)}${t('expiringDaysUnit')}`)
                            : null,
                        ),
                      ),
                      // 第二行：获得 / 已用 / 截止日期 + 精确性徽章
                      h('div', { style: styles.expireMeta },
                        h('span', null, `${t('expiringColAmount')} `, h('b', { style: styles.metaNum }, credit(row.amount))),
                        h('span', null, `${t('expiringColUsed')} `, h('b', { style: styles.metaNum }, credit(row.used))),
                        h('span', { style: styles.expireCell },
                          h('span', null, `${t('expiringColExpire')} `, h('b', { style: styles.metaNum }, row.expireLabel || '—')),
                          h('span', {
                            style: { ...styles.tag, ...(row.expireExact === true ? styles.tagOk : styles.tagWarn) },
                          }, row.expireExact === true ? t('expiringPrecise') : t('expiringEstimated')),
                        ),
                      ),
                    )),
                    totals === undefined ? null : h('div', { style: styles.expireTotal },
                      h('span', null, t('expiringTotal'),
                        totals.hidden > 0 ? ` · ${t('expiringHidden').replace('{n}', String(totals.hidden))}` : ''),
                      h('span', { style: styles.totalNums },
                        `${t('expiringColAmount')} ${credit(totals.amount)} · ${t('expiringColUsed')} ${credit(totals.used)} · ${t('expiringColRemain')} `,
                        h('b', null, credit(totals.remain)),
                      ),
                    ),
                  ),
            h('p', { style: styles.note }, t('expiringExactHint')),
          )
        })(),

        h('div', { style: styles.card },
          h('div', { style: styles.actions },
            h('h3', { style: styles.sectionTitle }, t('checkinTitle')),
            checkin == null ? null : h('span', {
              style: {
                ...styles.pill,
                ...(ranToday === true ? styles.ok : styles.warn),
              },
            }, ranToday === true ? t('checkedInToday') : t('notCheckedIn')),
          ),
          checkin == null ? null : h('div', { style: styles.row },
            h('div', { style: styles.field },
              h('span', { style: styles.label }, t('lastDate')),
              h('span', { style: styles.value }, checkin.lastDate === '' ? '—' : checkin.lastDate),
            ),
            h('div', { style: styles.field },
              h('span', { style: styles.label }, t('lastAt')),
              h('span', { style: styles.value }, timeText(checkin.lastAt)),
            ),
            h('div', { style: styles.field, flex: 1 },
              h('span', { style: styles.label }, t('lastResult')),
              h('span', { style: styles.value }, checkin.lastResult === '' ? '—' : checkin.lastResult),
            ),
          ),
          h('p', { style: styles.note }, t('disabledInPanel')),
        ),

        h('div', { style: styles.card },
          h('div', { style: styles.actions },
            h('h3', { style: styles.sectionTitle }, t('accountTitle')),
            h('button', { type: 'button', style: styles.button, disabled: loginBusy, onClick: () => void onLogin() },
              loginBusy ? t('loginPending') : t('relogin')),
          ),
          loginMessage === '' ? null : h('p', { style: styles.note }, loginMessage),
          loginUrl !== '' && loginBusy
            ? h('p', { style: styles.note },
                h('a', { href: loginUrl, target: '_blank', rel: 'noopener noreferrer', style: { color: '#6aa9ff' } },
                  `${t('openLogin')}: ${loginUrl}`),
              )
            : null,
          h('p', { style: styles.note }, t('loginHint')),
        ),

        // ── 模型与图片能力 ─────────────────────────────────────────────────
        h('div', { style: styles.card },
          h('div', { style: styles.actions },
            h('h3', { style: styles.sectionTitle }, t('modelsTitle')),
            h('button', { type: 'button', style: styles.button, disabled: modelsBusy, onClick: () => void saveModels() },
              modelsBusy ? t('saving') : t('saveModels')),
            h('button', { type: 'button', style: styles.button, disabled: modelsBusy, onClick: () => void resetModels() },
              t('resetModels')),
          ),
          h('p', { style: styles.note }, t('modelsHint')),
          modelsError === '' ? null : h('p', { style: { ...styles.note, ...styles.err } }, `${t('modelsLoadFailed')}: ${modelsError}`),
          modelsMessage === '' ? null : h('p', { style: { ...styles.note, ...styles.ok } }, modelsMessage),
          modelsLoaded && models.length === 0
            ? h('p', { style: styles.note }, t('modelsLoading'))
            : models.map((model, index) => h('div', { key: model.uid, style: styles.modelItem },
                h('div', { style: styles.modelRow },
                  h('label', { style: styles.modelField },
                    h('span', null, t('modelId')),
                    h('input', {
                      style: styles.input,
                      value: model.id,
                      placeholder: t('modelId'),
                      onChange: event => updateModel(index, { id: event.target.value }),
                    }),
                  ),
                  h('label', { style: styles.modelField },
                    h('span', null, t('modelName')),
                    h('input', {
                      style: styles.input,
                      value: model.name,
                      placeholder: t('modelName'),
                      onChange: event => updateModel(index, { name: event.target.value }),
                    }),
                  ),
                  h('label', { style: styles.modelField },
                    h('span', { style: styles.labelSpacer }, '\u00a0'),
                    h('button', {
                      type: 'button',
                      style: styles.button,
                      disabled: modelsBusy || tests[model.uid]?.busy === true,
                      title: t('testHint'),
                      onClick: () => void runTest(model),
                    }, tests[model.uid]?.busy === true ? t('testing') : t('test')),
                  ),
                  h('label', { style: styles.modelField },
                    h('span', { style: styles.labelSpacer }, '\u00a0'),
                    h('button', {
                      type: 'button',
                      style: { ...styles.button, ...styles.danger },
                      disabled: modelsBusy,
                      onClick: () => removeModel(index),
                    }, t('remove')),
                  ),
                ),
                h('div', { style: styles.modelRow2 },
                  h('label', { style: styles.modelField },
                    h('span', null, t('contextWindow')),
                    h('input', {
                      style: styles.input,
                      type: 'number',
                      min: 0,
                      value: model.contextWindow === 0 ? '' : model.contextWindow,
                      onChange: event => updateModel(index, { contextWindow: Number(event.target.value) }),
                    }),
                  ),
                  h('label', { style: styles.modelField },
                    h('span', null, t('maxOutput')),
                    h('input', {
                      style: styles.input,
                      type: 'number',
                      min: 0,
                      value: model.maxOutput === 0 ? '' : model.maxOutput,
                      onChange: event => updateModel(index, { maxOutput: Number(event.target.value) }),
                    }),
                  ),
                  h('label', { style: styles.modelField },
                    h('span', { style: styles.labelSpacer }, '\u00a0'),
                    h('span', { style: styles.checkTall },
                      h('input', {
                        type: 'checkbox',
                        checked: model.inputModalities.includes('text'),
                        onChange: () => toggleModelModality(index, 'text'),
                      }),
                      t('modalityText'),
                    ),
                  ),
                  h('label', { style: styles.modelField },
                    h('span', { style: styles.labelSpacer }, '\u00a0'),
                    h('span', { style: styles.checkTall },
                      h('input', {
                        type: 'checkbox',
                        checked: model.inputModalities.includes('image'),
                        onChange: () => toggleModelModality(index, 'image'),
                      }),
                      t('modalityImage'),
                    ),
                  ),
                ),
                testLine(model),
              )),
          h('div', { style: styles.actions },
            h('button', { type: 'button', style: styles.button, disabled: modelsBusy, onClick: addModel }, t('addModel')),
          ),
          h('p', { style: styles.note }, t('imageRisk')),
          modelsPath === '' ? null : h('p', { style: styles.note }, `${t('modelPath')}: ${modelsPath}`),
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), 'huawei-codearts: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'huawei-codearts',
        order: 37,
        label: () => t('nav'),
        locale: NS,
      }, props => h(Page, { ...props, t: props.t ?? t })))
    }

    exports.name = 'huawei-codearts'
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
