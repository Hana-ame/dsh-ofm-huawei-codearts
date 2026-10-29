/**
 * CodeArts 每日自动签到（重新实现自 channel-pack 的 codearts-credits 与
 * auto-checkin 模块；本插件独立后上游已不再覆盖 codearts 渠道，故在此恢复）。
 *
 * ## 它做什么
 *
 * 插件启动后延迟一小段（默认 30 秒，可用 `DSH_CHANNEL_PACK_AUTO_CHECKIN_DELAY_MS`
 * 覆盖，`0` 合法），若开关开着且**今天（UTC+8）还没跑过**，就串行遍历 codearts
 * 账号，逐个执行「查询账号信息 → 查询活动列表 → 领取每日登录积分 → 确认」，
 * 跑完把日期与结果写回 `$DSH_HOME/channel-pack/auto-checkin.json` ⇒ 当天不再触发。
 *
 * ## 为什么延迟 30 秒
 *
 * 与上游 channel-pack 相同：不跟 DSH 启动抢资源；并等凭据续期先跑一轮，
 * 避免拿过期 AK/SK 去签到导致整轮失败。
 *
 * ## 什么算「今天已被处理」
 *
 * 只有 claimed / already-claimed 计数 > 0 才写 lastDate。全部失败（如代理抖动、
 * 凭据过期）**不记账**，下次启动会重试——这与上游 `shouldMarkToday` 一致。
 *
 * ## 文件格式
 *
 * 与 `$DSH_HOME/channel-pack/auto-checkin.json` 既有文档完全兼容（schema
 * `dsh-codearts-auth/auto-checkin/v1`）。上游 our-free-model 的频道面板读同一份
 * 文件来展示「每日自动签到」状态，所以本插件写的结果会直接出现在那里。
 *
 * 开关判断：**只有显式 `false` 才算关闭**（缺字段/旧文档一律按打开处理）。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 独立文档的文件名（与 state.json 同目录）。 */
export const AUTO_CHECKIN_FILE = 'auto-checkin.json'

/** 文档 schema（与 jet-hub/channel-pack 既有文档兼容）。 */
export const AUTO_CHECKIN_SCHEMA = 'dsh-codearts-auth/auto-checkin/v1'

/** 延迟环境变量（与上游 channel-pack 同名，便于迁移）。 */
export const AUTO_CHECKIN_DELAY_ENV = 'DSH_CHANNEL_PACK_AUTO_CHECKIN_DELAY_MS'

/** 默认延迟：30 秒。 */
export const DEFAULT_AUTO_CHECKIN_DELAY_MS = 30_000

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_CHANNEL_ENTRIES = 24

/** UTC+8 的日期字符串（签到活动按 UTC+8 自然日结算）。 */
export function utc8DateString(nowMs = Date.now()) {
  return new Date(nowMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** 延迟毫秒：环境变量非法或缺失时用默认值；`0` 合法（立即执行）。 */
export function autoCheckinDelayMs(env = process.env) {
  const raw = env[AUTO_CHECKIN_DELAY_ENV]
  if (typeof raw !== 'string' || raw.trim().length === 0) return DEFAULT_AUTO_CHECKIN_DELAY_MS
  const parsed = Number(raw.trim())
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_AUTO_CHECKIN_DELAY_MS
}

function sanitizeChannels(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    if (typeof item.provider !== 'string' || item.provider.length === 0) continue
    if (typeof item.text !== 'string') continue
    out.push({ provider: item.provider, text: item.text.slice(0, 120) })
    if (out.length >= MAX_CHANNEL_ENTRIES) break
  }
  return out
}

/** 清洗读到的文档；任何脏数据都退回默认（开关打开）。 */
export function sanitizeAutoCheckin(raw) {
  const ms = value => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { enabled: true, lastDate: '', lastResult: '', lastAt: 0, channels: [], dismissedRunAt: 0 }
  }
  return {
    // ⚠️ 只有显式 false 才算关闭，缺字段/旧文档保持打开。
    enabled: raw.enabled !== false,
    lastDate: typeof raw.lastDate === 'string' && DATE_RE.test(raw.lastDate) ? raw.lastDate : '',
    lastResult: typeof raw.lastResult === 'string' ? raw.lastResult : '',
    lastAt: ms(raw.lastAt),
    channels: sanitizeChannels(raw.channels),
    dismissedRunAt: ms(raw.dismissedRunAt),
  }
}

/**
 * 解析 channel-pack 状态目录。优先级与上游一致：
 * `DSH_CHANNEL_PACK_STATE_DIR` → `profileContext.home` → `$DSH_HOME` → `~/.dsh`。
 *
 * ⚠️ `profileContext` 不在本插件的 inject 列表里，直接 `ctx.profileContext`
 * 会触发 cordis 的「cannot get property without inject」；必须用
 * `ctx.get('profileContext')`（免注入读取），并对外层做 try/catch 兜底。
 */
function readProfileHome(ctx) {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined
    if (service !== undefined && service !== null && typeof service.home === 'string' && service.home.length > 0) {
      return service.home
    }
  } catch {
    // 服务未注册或读取失败：继续走环境变量
  }
  return undefined
}

export function resolveAutoCheckinHome(ctx, env = process.env) {
  const override = env.DSH_CHANNEL_PACK_STATE_DIR
  if (typeof override === 'string' && override.trim().length > 0) return override.trim()
  const profileHome = readProfileHome(ctx)
  if (profileHome !== undefined) return profileHome
  const envHome = env.DSH_HOME
  if (typeof envHome === 'string' && envHome.trim().length > 0) return envHome.trim()
  return path.join(process.env.HOME ?? '', '.dsh')
}

/** 文件存储（原子写：临时文件 + rename）。 */
export function createFileAutoCheckinStore({ home, warn } = {}) {
  const file = path.join(home, 'channel-pack', AUTO_CHECKIN_FILE)
  return {
    file,
    load() {
      try {
        if (!fs.existsSync(file)) return sanitizeAutoCheckin(undefined)
        return sanitizeAutoCheckin(JSON.parse(fs.readFileSync(file, 'utf8')))
      } catch (error) {
        warn?.(`[auto-checkin] 读取 ${file} 失败，按默认设置（打开）处理: ${String(error)}`)
        return sanitizeAutoCheckin(undefined)
      }
    },
    async save(doc) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({
        schema: AUTO_CHECKIN_SCHEMA,
        enabled: doc.enabled,
        lastDate: doc.lastDate,
        lastResult: doc.lastResult,
        lastAt: doc.lastAt,
        channels: doc.channels,
        dismissedRunAt: doc.dismissedRunAt,
      }, null, 2), 'utf8')
      fs.renameSync(tmp, file)
    },
  }
}

// ---------------------------------------------------------------------------
// CodeArts 每日签到领取（华为云 Snap 引擎签名请求）
// ---------------------------------------------------------------------------

const SNAP_ENGINE_URL = 'https://snap-access.cn-north-4.myhuaweicloud.com'
const PACKAGE_INFO_PATH = '/snap-manager/v1/statistics/plugin'
const OPS_DELIVERY_PATH = '/v1/ops/delivery'
const OPS_CLAIM_PATH = '/v1/ops/claim'
const OPS_CONFIRM_PATH = '/v1/ops/confirm'
const OPS_CHANNEL = 'IDE'
const DAILY_LOGIN_TYPE = 'USER_LOGIN'
const CLAIMED_STATUSES = ['CLAIMED', 'CONFIRMED', 'CONSUMED']
const REQUEST_TIMEOUT_MS = 30_000
const SNAP_EXTRA_HEADERS = Object.freeze({ 'Agent-Type': 'PromptCenter', 'X-Language': 'zh-cn' })

function readBool(source, key) {
  const value = source?.[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return false
}

function readNumber(source, key) {
  const value = source?.[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function readString(source, key) {
  const value = source?.[key]
  return typeof value === 'string' ? value : ''
}

function readIdentifier(source, key) {
  const value = source?.[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function readRecord(source, key) {
  const value = source?.[key]
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

/** 拆 Snap 引擎的 `{code, data}` 外层；没有 code 字段时整体视为 data。 */
function unwrapSnapEnvelope(raw) {
  const code = raw?.code
  if (typeof code === 'number') {
    if (code !== 0) {
      const message = readString(raw, 'message') || readString(raw, 'msg')
      return { ok: false, code, message: message.length > 0 ? message : `业务码 ${code}` }
    }
    const data = raw.data
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) return { ok: true, data }
    return { ok: false, code, message: '响应缺少 data 字段' }
  }
  return { ok: true, data: raw }
}

/**
 * 签名并发送一个 Snap 引擎请求。
 *
 * @param {object} deps 依赖：`sign(ak, sk, st, method, url, payload)` 与 `fetcher`。
 */
async function signedSnapRequest(deps, method, url, credential, body) {
  const ak = credential?.access_key_id
  const sk = credential?.secret_access_key
  const st = typeof credential?.security_token === 'string' ? credential.security_token : ''
  if (!ak || !sk) return { ok: false, code: -1, message: '凭据缺少 AK/SK' }
  try {
    const payload = body === undefined ? new Uint8Array() : new TextEncoder().encode(body)
    const signed = await deps.sign(ak, sk, st, method, url, payload)
    const headers = new Headers()
    signed.forEach((value, key) => {
      if (key !== 'host') headers.set(key, value)
    })
    for (const [key, value] of Object.entries(SNAP_EXTRA_HEADERS)) headers.set(key, value)
    const response = await deps.fetcher(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) {
      let detail = ''
      try {
        const parsed = JSON.parse(text)
        detail = [readString(parsed, 'error_code'), readString(parsed, 'error_msg')].filter(Boolean).join(' ')
      } catch {
        detail = text.trim().slice(0, 200)
      }
      return { ok: false, code: response.status, message: detail.length > 0 ? `HTTP ${response.status}：${detail}` : `HTTP ${response.status}` }
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, code: -1, message: '请求失败或响应无法解析' }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, code: -1, message: '请求失败或响应无法解析' }
    }
    return unwrapSnapEnvelope(parsed)
  } catch (error) {
    return { ok: false, code: -1, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 账号信息：判断是否积分计费账号（Token 计费账号不在积分活动范围）。 */
export async function fetchCodeArtsAccountInfo(credential, deps) {
  const url = `${SNAP_ENGINE_URL}${PACKAGE_INFO_PATH}`
  const result = await signedSnapRequest(deps, 'GET', url, credential, undefined)
  if (!result.ok) return { ok: false, message: result.message }
  const pkg = readRecord(result.data, 'package')
  return {
    ok: true,
    info: {
      isCreditPackage: readBool(pkg, 'is_credit_package'),
      isTokenPackage: readBool(pkg, 'is_token_package'),
      packageName: readString(pkg, 'package_name_cn') || readString(pkg, 'package_name_en'),
      packageStatus: readString(pkg, 'status'),
    },
  }
}

function parseActivity(item) {
  return {
    // campaignId 实测是数字 1，用 readIdentifier 兼容字符串/数字两种下发。
    campaignId: readIdentifier(item, 'campaignId'),
    type: readString(item, 'type'),
    title: readString(item, 'title'),
    claimable: readBool(item, 'claimable'),
    status: readString(item, 'status'),
    // 可领积分数：实测字段名 benefitAmount（值 1000），保留常见别名回退。
    amount: readNumber(item, 'benefitAmount') || readNumber(item, 'amount') || readNumber(item, 'creditAmount'),
  }
}

/** 活动列表（含每日登录签到活动）。 */
export async function fetchCodeArtsOpsActivities(credential, deps) {
  const url = `${SNAP_ENGINE_URL}${OPS_DELIVERY_PATH}?channel=${OPS_CHANNEL}`
  const result = await signedSnapRequest(deps, 'GET', url, credential, undefined)
  if (!result.ok) return { ok: false, message: result.message }
  const items = result.data?.items
  if (!Array.isArray(items)) return { ok: false, message: '响应缺少 items 字段' }
  return {
    ok: true,
    activities: items
      .filter(item => typeof item === 'object' && item !== null && !Array.isArray(item))
      .map(parseActivity),
  }
}

export function findDailyCheckinActivity(activities) {
  return activities.find(activity => activity.type === DAILY_LOGIN_TYPE)
}

/**
 * 领取一个 CodeArts 账号的每日登录积分。
 *
 * 返回 outcome：`claimed` / `already-claimed` / `inactive` / `failed`。
 * 与上游 codearts-credits 相同的流程：账号信息 → 活动列表 → claim → confirm。
 * `confirm` 只在 claim 返回了 benefit/id 后补发（见上游注释）。
 */
export async function claimCodeArtsDailyCheckin(credential, deps) {
  const infoResult = await fetchCodeArtsAccountInfo(credential, deps)
  if (!infoResult.ok) return { kind: 'failed', code: -1, message: `账户信息查询失败：${infoResult.message}` }
  const info = infoResult.info
  if (!info.isCreditPackage) {
    return {
      kind: 'inactive',
      message: info.isTokenPackage ? 'Token 计费账户，不在积分活动范围' : '非积分计费账户，不在积分活动范围',
    }
  }
  const activitiesResult = await fetchCodeArtsOpsActivities(credential, deps)
  if (!activitiesResult.ok) return { kind: 'failed', code: -1, message: `活动列表查询失败：${activitiesResult.message}` }
  const activity = findDailyCheckinActivity(activitiesResult.activities)
  if (activity === undefined) return { kind: 'inactive', message: '未找到每日签到活动' }
  if (!activity.claimable) {
    return CLAIMED_STATUSES.includes(activity.status)
      ? { kind: 'already-claimed', message: '今天已领取' }
      : { kind: 'inactive', message: `当前不可领取（status=${activity.status}）` }
  }
  if (activity.campaignId.length === 0) return { kind: 'failed', code: -1, message: '活动缺少 campaignId，无法领取' }
  const claimResult = await signedSnapRequest(
    deps,
    'POST',
    `${SNAP_ENGINE_URL}${OPS_CLAIM_PATH}`,
    credential,
    JSON.stringify({ campaignId: activity.campaignId, channel: OPS_CHANNEL }),
  )
  if (!claimResult.ok) return { kind: 'failed', code: claimResult.code, message: claimResult.message }
  if (claimResult.data?.id !== null && claimResult.data?.id !== undefined) {
    await signedSnapRequest(
      deps,
      'POST',
      `${SNAP_ENGINE_URL}${OPS_CONFIRM_PATH}`,
      credential,
      JSON.stringify({ campaignId: activity.campaignId }),
    )
  }
  const claimCredit = readNumber(claimResult.data, 'benefitAmount')
    || readNumber(claimResult.data, 'credit')
    || readNumber(claimResult.data, 'credits')
    || readNumber(claimResult.data, 'creditAmount')
    || readNumber(claimResult.data, 'amount')
  return {
    kind: 'claimed',
    credit: claimCredit > 0 ? claimCredit : activity.amount,
    // CodeArts 活动不下发连续签到天数概念（那是 CodeBuddy 的机制）。
    streakDays: 0,
    isStreakDay: false,
  }
}

/**
 * 读取积分余额（统计接口的 credit metric）。
 *
 * 字段命名沿用华为云 `statistics/plugin` 响应：`usageTotalPackageCredit` 是
 * 总积分包，另有基础/按需/赠送三个分类包。分别取 amount / used / remain /
 * expiring（`package_credit_expiring_amount`）。
 */
export function parseCreditBalanceMetrics(metrics) {
  if (!Array.isArray(metrics)) return undefined
  const pick = name => {
    const item = metrics.find(entry => entry !== null && typeof entry === 'object' && entry.name === name)
    if (item === undefined) return undefined
    return {
      amount: readNumber(item, 'package_credit_amount'),
      used: readNumber(item, 'package_credit_used'),
      remain: readNumber(item, 'package_credit_remain'),
      expiring: readNumber(item, 'package_credit_expiring_amount'),
    }
  }
  const total = pick('usageTotalPackageCredit')
  if (total === undefined) return undefined
  return {
    total,
    basic: pick('usageBasicPackageCredit'),
    onDemand: pick('usageOnDemandPackageCredit'),
    bonus: pick('usageBonusPackageCredit'),
  }
}

/** 查询 CodeArts 积分余额；返回 `{ ok, balance, message? }`。 */
export async function fetchCodeArtsCreditBalance(credential, deps) {
  const url = `${SNAP_ENGINE_URL}${PACKAGE_INFO_PATH}`
  const result = await signedSnapRequest(deps, 'GET', url, credential, undefined)
  if (!result.ok) return { ok: false, message: result.message }
  const data = result.data
  const pkg = readRecord(data, 'package')
  const balance = parseCreditBalanceMetrics(data.metrics)
  if (balance === undefined) return { ok: false, message: '响应缺少积分 metric' }
  return {
    ok: true,
    balance: {
      packageName: readString(pkg, 'package_name_cn') || readString(pkg, 'package_name_en'),
      packageStatus: readString(pkg, 'status'),
      isCreditPackage: readBool(pkg, 'is_credit_package'),
      isTokenPackage: readBool(pkg, 'is_token_package'),
      ...balance,
    },
  }
}

// ---------------------------------------------------------------------------
// 自动签到执行体
// ---------------------------------------------------------------------------

function formatCreditAmount(value) {
  if (!Number.isFinite(value)) return '?'
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/** 汇总一次 claim 的 outcome 列表（与上游 computeClaimSummary 同语义）。 */
export function computeClaimSummary(outcomes) {
  const summary = {
    claimed: 0,
    totalCredit: 0,
    alreadyClaimed: 0,
    inactive: 0,
    failed: 0,
    coversToday: 0,
  }
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case 'claimed':
        summary.claimed += 1
        summary.totalCredit += Number(outcome.credit) || 0
        if (outcome.coversToday !== false) summary.coversToday += 1
        break
      case 'already-claimed':
        summary.alreadyClaimed += 1
        if (outcome.coversToday !== false) summary.coversToday += 1
        break
      case 'inactive':
        summary.inactive += 1
        break
      default:
        summary.failed += 1
        break
    }
  }
  return summary
}

/** `+1000积分`；0 积分返回 null。 */
export function formatClaimGains(summary) {
  const value = Number(summary?.totalCredit)
  if (!Number.isFinite(value) || value <= 0) return null
  return `+${formatCreditAmount(value)}积分`
}

/** 一轮结果的短摘要：`1 个渠道：1 个账号领取成功（+1000积分）`。 */
export function describeRun(totals) {
  const parts = []
  const gains = formatClaimGains(totals)
  if (totals.claimed > 0) parts.push(`${totals.claimed} 个账号领取成功${gains === null ? '' : `（${gains}）`}`)
  if (totals.alreadyClaimed > 0) parts.push(`${totals.alreadyClaimed} 个今天已领`)
  if (totals.failed > 0) parts.push(`${totals.failed} 个失败`)
  if (totals.inactive > 0) parts.push(`${totals.inactive} 个未开启`)
  if (parts.length === 0) return `${totals.providers} 个渠道：没有需要领取的账号`
  return `${totals.providers} 个渠道：${parts.join('，')}`
}

/** 逐渠道状态文字：`1 个 +1000积分`。 */
export function describeChannel(summary) {
  const parts = []
  const gains = formatClaimGains(summary)
  if (summary.claimed > 0) parts.push(gains === null ? `${summary.claimed} 个领取成功` : `${summary.claimed} 个 ${gains}`)
  if (summary.alreadyClaimed > 0) parts.push(`${summary.alreadyClaimed} 个今天已领`)
  if (summary.failed > 0) parts.push(`${summary.failed} 个失败`)
  if (summary.inactive > 0) parts.push(`${summary.inactive} 个未开启`)
  if (parts.length === 0) return '无可领'
  const coversToday = summary.coversToday ?? summary.claimed + summary.alreadyClaimed
  if (coversToday === 0 && summary.claimed + summary.alreadyClaimed > 0) parts.push('非今日轮次')
  return parts.join('，')
}

function defaultSchedule(fn, ms) {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

/**
 * 创建自动签到控制器。
 *
 * deps:
 *  - store:          { load(), save(doc) }（createFileAutoCheckinStore）
 *  - listAccounts:   async () => [{ id, nickname, credentialRef }]
 *  - resolveCredential: async (ref) => credential | undefined
 *  - claim:          (credential) => Promise<outcome>
 *  - now/schedule/delayMs/warn: 可选（测试注入）
 */
export function createAutoCheckin(deps) {
  const now = deps.now ?? (() => Date.now())
  let doc = deps.store.load()
  let running = false
  let inflight = null
  let pending = null
  const today = () => utc8DateString(now())

  function state() {
    return {
      enabled: doc.enabled,
      lastDate: doc.lastDate,
      ranToday: doc.lastDate !== '' && doc.lastDate === today(),
      running,
      lastResult: doc.lastResult,
      lastAt: doc.lastAt,
      channels: doc.channels.map(entry => ({ ...entry })),
      dismissed: doc.lastAt > 0 && doc.dismissedRunAt === doc.lastAt,
    }
  }

  async function performRun() {
    let accounts = []
    try {
      accounts = await deps.listAccounts()
    } catch (error) {
      deps.warn?.(`[auto-checkin] 读取账号列表失败，本次跳过: ${String(error)}`)
      return
    }
    if (accounts.length === 0) {
      deps.warn?.('[auto-checkin] 没有可用账号，本次跳过')
      return
    }
    const outcomes = []
    for (const account of accounts) {
      let outcome
      try {
        const credential = await deps.resolveCredential(account.credentialRef)
        if (credential === undefined) {
          outcome = { kind: 'failed', code: -1, message: '凭据未配置' }
        } else {
          // 把 ref 一起传给 claim：令牌过期时调用方可以按 ref 刷新后重试。
          outcome = await deps.claim(credential, account.credentialRef)
        }
      } catch (error) {
        deps.warn?.(`[auto-checkin] 账号 ${account.id} 签到异常: ${String(error)}`)
        outcome = { kind: 'failed', code: -1, message: error instanceof Error ? error.message : String(error) }
      }
      outcomes.push(outcome)
    }
    const summary = computeClaimSummary(outcomes)
    const totals = {
      providers: 1,
      claimed: summary.claimed,
      totalCredit: summary.totalCredit,
      alreadyClaimed: summary.alreadyClaimed,
      inactive: summary.inactive,
      failed: summary.failed,
      coversToday: summary.coversToday,
    }
    if (totals.coversToday <= 0) {
      // 一轮全部失败/未开启都不算「今天已处理」，下次启动会重试。
      deps.warn?.(`[auto-checkin] 未记入今日（下次启动会重试）：${describeRun(totals)}`)
      return
    }
    doc = {
      ...doc,
      lastDate: today(),
      lastResult: describeRun(totals),
      lastAt: now(),
      channels: [{ provider: 'codearts', text: describeChannel(summary) }],
      // 新一轮结果要清掉上一次的「已关闭」标记。
      dismissedRunAt: 0,
    }
    try {
      await deps.store.save(doc)
    } catch (error) {
      deps.warn?.(`[auto-checkin] 结果写入失败（今天可能重复触发一次）: ${String(error)}`)
    }
    deps.warn?.(`[auto-checkin] 自动签到完成（${today()}）：${doc.lastResult}`)
  }

  function runIfDue() {
    if (inflight !== null) return inflight
    // 每次判定前重读文档：上游频道面板的开关/手动签到的结果也会写这份文件，
    // 重读后才能与它保持一致（否则面板里关掉自动签到要重启插件才生效）。
    doc = deps.store.load()
    if (!doc.enabled) return Promise.resolve()
    if (doc.lastDate !== '' && doc.lastDate === today()) return Promise.resolve()
    running = true
    const task = performRun()
      .catch(error => {
        deps.warn?.(`[auto-checkin] 自动签到异常: ${String(error)}`)
      })
      .finally(() => {
        running = false
        inflight = null
      })
    inflight = task
    return task
  }

  return {
    state,
    async setEnabled(enabled) {
      doc = { ...doc, enabled }
      await deps.store.save(doc)
      if (enabled) void runIfDue()
      return state()
    },
    start() {
      if (pending !== null) return
      const ms = deps.delayMs ?? autoCheckinDelayMs()
      const fire = () => {
        pending = null
        void runIfDue()
      }
      if (ms <= 0) {
        fire()
        return
      }
      pending = (deps.schedule ?? defaultSchedule)(fire, ms)
    },
    runIfDue,
    async dismiss() {
      doc = { ...doc, dismissedRunAt: doc.lastAt }
      try {
        await deps.store.save(doc)
      } catch (error) {
        deps.warn?.(`[auto-checkin] 状态文字关闭标记写入失败: ${String(error)}`)
      }
      return state()
    },
    stop() {
      pending?.cancel()
      pending = null
    },
  }
}
