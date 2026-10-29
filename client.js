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
        accountTitle: '账号凭据',
        relogin: '重新登录 CodeArts',
        loginPending: '等待浏览器授权…',
        loginWait: '已打开 CodeArts 登录页，请完成授权后返回本页。',
        loginSucceeded: '登录成功，凭据已更新。',
        loginFailed: '登录失败',
        loginTimeout: '登录超时（3 分钟），请重试。',
        loginHint: '刷新令牌是一次性的：失效后点这里重新授权即可，无需重装插件。',
        openLogin: '打开登录页',
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
        accountTitle: 'Account credential',
        relogin: 'Re-login CodeArts',
        loginPending: 'Waiting for browser authorization…',
        loginWait: 'CodeArts login page opened — finish authorization and come back.',
        loginSucceeded: 'Logged in; credential updated.',
        loginFailed: 'Login failed',
        loginTimeout: 'Login timed out (3 minutes), please retry.',
        loginHint: 'The refresh token is single-use: re-authorize here when it expires.',
        openLogin: 'Open login page',
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
    }

    const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })

    function credit(value) {
      const num = Number(value)
      return Number.isFinite(num) ? numberFormat.format(num) : '—'
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
      const [loginBusy, setLoginBusy] = useState(false)
      const [loginMessage, setLoginMessage] = useState('')
      const [loginUrl, setLoginUrl] = useState('')

      const load = async () => {
        setLoading(true)
        setError('')
        try {
          const response = await fetch(`${API}/balance`, { headers: { accept: 'application/json' } })
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
      }, [])

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
                    ),
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
