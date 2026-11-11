/**
 * CodeArts 积分「到期明细」本地账本。
 *
 * ## 为什么必须有它（远端没有任何明细 API）
 *
 * 华为云 `statistics/plugin` **只给汇总**：`amount / used / remain` 加一个
 * `package_credit_expiring_amount`（＝最早到期那一组的**剩余**）。它不给
 * 「哪几笔积分、各自何时到期、每笔还剩多少」，也没有任何逐笔/按天/按模型的
 * 明细端点——2026-11-11 逐条探测 118 条候选路径，只有 4 条存在
 * （见 KB 节点 `facts-codearts-quota-source-2026-11-11`）。
 *
 * 设置页要回答的「最近 N 笔即将过期的积分 + 截止日期 + 已用」在远端取不到，
 * 只能在本地**观测并留存**，再用官方扣减顺序反解。
 *
 * ## 两个聚合桶（在 2026-10、2026-11 两个真实周期上都分毫吻合）
 *
 * 官方规则：优先消耗**剩余有效期最短**的积分；有效期相同时先扣福利积分，
 * 再扣席位套餐，最后扣积分包。`expiring` 是「最早到期那一组」的剩余。于是
 * 任一观测点满足（`A`=amount, `R`=remain, `U`=used, `E`=expiring）：
 *
 *     早到期组初始 = U + E          （因为扣减从它开始，used 全部记在它身上）
 *     周期末组初始 = A − (U + E)
 *     早到期组剩余 = E
 *     周期末组剩余 = R − E
 *
 * 实测校验：2026-10 周期 `A=20600, U=1261.71, E=4838.29` ⇒ 早组 6100、末组
 * 14500；2026-11 周期 `A=11600, U=3823.69, E=1276.31` ⇒ 早组 5100、末组 6500。
 * 两组之和恒等于 `A`，两组剩余之和恒等于 `R`。
 *
 * ## 「一笔」是什么
 *
 * 本模块把「一笔」定义为**一个可被单独追溯的发放/到期单位**：
 *
 * - **周期发放**：每期开始时 `amount` 从上一期跳变到新值 ⇒ 记为期初发放，
 *   到期日 = `end_date`（**精确**，官方「未使用额度不结转」）。
 * - **期内增发**：`amount` 中途变大（另购积分包等）⇒ 记为新增发放。
 * - **早到期增发**：`expiring` 变大（签到/活动进账，有效期短于周期末）⇒
 *   记为早到期发放。它的**精确到期日远端不给**，只能标「早于 `end_date`」，
 *   在 UI 上显示为「约」，绝不伪装成精确日期。
 * - **期初存量兜底**：账本还没有历史时（第一次打开设置页），按当前读数
 *   直接构造两个聚合桶，保证一开始就有内容可看，同时标注「推算」。
 *
 * ## 已用怎么分摊到每一笔
 *
 * 用官方扣减顺序做 **FIFO 分摊**：把当前周期的发放按到期日升序排成队列，
 * 用 API 给的 `used` 从队首依次扣减，得到每笔的已用/剩余。这与「优先扣
 * 最早到期」的规则同构，且总额与 API 完全对得上（末笔吃掉差额）。
 *
 * ## 落盘
 *
 * `$DSH_HOME/dsh-ofm-huawei-codearts/quota-buckets.json`（`CODEARTS_QUOTA_FILE`
 * 可覆盖），原子写 0600。文件缺失/损坏一律按「还没有历史」处理，不影响任何
 * 查询——账本是增强信息，绝不能反噬余额查询。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME_DIR = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

/** 默认落盘位置。 */
export const DEFAULT_QUOTA_FILE = path.join(DSH_HOME_DIR, 'dsh-ofm-huawei-codearts', 'quota-buckets.json')

/** 文档 schema。 */
export const QUOTA_BUCKETS_SCHEMA = 'dsh-ofm-huawei-codearts/quota-buckets/v1'

/** 最多保留多少个观测点（一天一个，约一年）。 */
export const MAX_SAMPLES = 400

/** 最多保留多少条发放记录。 */
export const MAX_GRANTS = 200

/** 「最近 N 笔」的默认条数。 */
export const DEFAULT_EXPIRING_LIMIT = 5

/** 早到期组在排序上的占位：比周期末早 1 毫秒（只用于排序，不当作真实日期展示）。 */
const BEFORE_CYCLE_END_OFFSET_MS = 1

/** 当前生效的落盘路径（`CODEARTS_QUOTA_FILE` 优先）。 */
export function quotaBucketsPath() {
  const fromEnv = String(process.env.CODEARTS_QUOTA_FILE ?? '').trim()
  return fromEnv.length > 0 ? fromEnv : DEFAULT_QUOTA_FILE
}

const round2 = value => (Number.isFinite(value) ? Math.round(value * 100) / 100 : 0)

function num(source, key) {
  const value = source?.[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function str(source, key) {
  const value = source?.[key]
  return typeof value === 'string' ? value : ''
}

/** 毫秒 → UTC+8 的 `YYYY-MM-DD`。 */
export function isoDateOf(ms) {
  return new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** UTC+8 当日 24:00（次日 00:00）的毫秒值。 */
export function utc8DayEndMs(ms) {
  return (Math.floor((ms + 8 * 60 * 60 * 1000) / 86_400_000) + 1) * 86_400_000 - 8 * 60 * 60 * 1000
}

/** 周期结束日（`YYYY-MM-DD`）→ 当日 24:00（次日 00:00）UTC+8 的毫秒值。 */
export function cycleEndMsOf(dateString) {
  if (typeof dateString !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return 0
  const ms = Date.parse(`${dateString}T00:00:00+08:00`)
  return Number.isFinite(ms) ? ms + 86_400_000 : 0
}

// ---------------------------------------------------------------------------
// 观测点
// ---------------------------------------------------------------------------

/**
 * 把一次余额响应压成一个观测点。
 *
 * 返回 undefined 表示响应缺少必要字段（此时不记账、不报错）。
 */
export function sampleOfBalance(balance, nowMs = Date.now()) {
  const total = balance?.total
  const amount = num(total, 'amount')
  const used = num(total, 'used')
  const remain = num(total, 'remain')
  if (amount === undefined || used === undefined || remain === undefined) return undefined
  const basic = balance?.basic
  const bonus = balance?.bonus
  return {
    at: nowMs,
    amount: round2(amount),
    used: round2(used),
    remain: round2(remain),
    expiring: round2(num(total, 'expiring') ?? 0),
    cycleStart: str(balance?.cycle, 'startDate'),
    cycleEnd: str(balance?.cycle, 'endDate'),
    basicAmount: round2(num(basic, 'amount') ?? 0),
    basicRemain: round2(num(basic, 'remain') ?? 0),
    bonusAmount: round2(num(bonus, 'amount') ?? 0),
    bonusRemain: round2(num(bonus, 'remain') ?? 0),
  }
}

/** 归一化观测点。 */
export function normalizeSample(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const at = num(raw, 'at')
  const amount = num(raw, 'amount')
  const used = num(raw, 'used')
  const remain = num(raw, 'remain')
  if (at === undefined || at <= 0) return undefined
  if (amount === undefined || used === undefined || remain === undefined) return undefined
  return {
    at,
    amount: round2(amount),
    used: round2(used),
    remain: round2(remain),
    expiring: round2(num(raw, 'expiring') ?? 0),
    cycleStart: str(raw, 'cycleStart'),
    cycleEnd: str(raw, 'cycleEnd'),
    basicAmount: round2(num(raw, 'basicAmount') ?? 0),
    basicRemain: round2(num(raw, 'basicRemain') ?? 0),
    bonusAmount: round2(num(raw, 'bonusAmount') ?? 0),
    bonusRemain: round2(num(raw, 'bonusRemain') ?? 0),
  }
}

// ---------------------------------------------------------------------------
// 发放记录
// ---------------------------------------------------------------------------

/** 发放来源类型。 */
export const GRANT_KINDS = Object.freeze({
  /** 周期期初的席位积分（basic metric）。 */
  CYCLE_BASE: 'cycle-base',
  /** 周期期初的赠送/活动积分（bonus metric）。 */
  CYCLE_BONUS: 'cycle-bonus',
  /** 期内 amount 增加（另购积分包等）。 */
  IN_CYCLE: 'in-cycle',
  /** 期内 expiring 增加（签到/活动，有效期短于周期末）。 */
  EARLY: 'early',
  /** 账本无历史时按当前读数构造的兜底存量。 */
  SYNTHETIC: 'synthetic',
})

/** 归一化一条发放记录。 */
export function normalizeGrant(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const amount = num(raw, 'amount')
  const at = num(raw, 'at')
  if (amount === undefined || amount <= 0) return undefined
  if (at === undefined || at <= 0) return undefined
  const kind = Object.values(GRANT_KINDS).includes(str(raw, 'kind')) ? str(raw, 'kind') : GRANT_KINDS.SYNTHETIC
  const expireAt = num(raw, 'expireAt') ?? 0
  const expireSource = str(raw, 'expireSource')
  return {
    id: str(raw, 'id') || `${kind}:${at}:${round2(amount).toFixed(2)}`,
    at,
    amount: round2(amount),
    kind,
    cycleStart: str(raw, 'cycleStart'),
    cycleEnd: str(raw, 'cycleEnd'),
    expireAt: expireAt > 0 ? expireAt : 0,
    // `exact` = 官方 end_date；`before-cycle-end` = 只知道早于周期末；
    // `unknown` = 连界都没有（极少见）。
    expireSource: ['exact', 'before-cycle-end', 'unknown'].includes(expireSource) ? expireSource : 'unknown',
    label: str(raw, 'label'),
    // 同一到期日内的扣减顺序：0=早到期组，1=福利/赠送，2=席位套餐，3=其他。
    // 官方规则「有效期相同时先扣福利积分，再扣席位套餐」。
    priority: Number.isFinite(num(raw, 'priority')) ? num(raw, 'priority') : 3,
  }
}

/** 空账本。 */
export function emptyQuotaBook() {
  return { schema: QUOTA_BUCKETS_SCHEMA, samples: [], grants: [], updatedAt: '' }
}

/** 清洗读到的账本；任何脏数据都退回空账本。 */
export function sanitizeQuotaBook(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return emptyQuotaBook()
  const samples = []
  for (const item of Array.isArray(raw.samples) ? raw.samples : []) {
    const normalized = normalizeSample(item)
    if (normalized !== undefined) samples.push(normalized)
    if (samples.length >= MAX_SAMPLES) break
  }
  const grants = []
  const seen = new Set()
  for (const item of Array.isArray(raw.grants) ? raw.grants : []) {
    const normalized = normalizeGrant(item)
    if (normalized === undefined || seen.has(normalized.id)) continue
    seen.add(normalized.id)
    grants.push(normalized)
    if (grants.length >= MAX_GRANTS) break
  }
  return {
    schema: QUOTA_BUCKETS_SCHEMA,
    samples,
    grants,
    updatedAt: str(raw, 'updatedAt'),
  }
}

/**
 * 依据「上一点 → 本点」的差值，产出新增发放记录。
 *
 * 这是把汇总读数拆成「笔」的唯一入口。纯度刻意做高（不读写文件），
 * 差值规则集中在这里，便于单测逐条锁定。
 *
 * @returns {Array} 新增的发放记录（可能为空）
 */
export function deriveGrants(previous, current) {
  if (current === undefined) return []
  const grants = []
  const cycleEndAt = cycleEndMsOf(current.cycleEnd)
  const cycleKey = `${current.cycleStart}~${current.cycleEnd}`

  const cycleChanged = previous === undefined
    || previous.cycleStart !== current.cycleStart
    || previous.cycleEnd !== current.cycleEnd

  if (cycleChanged) {
    // 新周期：按「到期日」拆成最多三笔。
    //
    // 关键约束（实测双周期都成立）：
    //   早到期组初始 = used + expiring        ← 扣减从最早到期组开始
    //   其余（周期末组）= amount − 早到期组初始
    //
    // 为什么要这么拆：`expiring` 是「最早到期那一组的剩余」，如果只用
    // basic/bonus 拆，`expiring` 这条信息就被丢掉了 —— 表现为「即将过期」
    // 那一栏永远等于总剩余，用户看不出真正紧迫的是哪一部分。
    const earlyInitial = round2(Math.min(current.amount, Math.max(0, current.used + current.expiring)))
    const hasSecondBucket = earlyInitial < current.amount - 0.01
    // 只有一个桶时，它本身就是周期末到期 ⇒ 精确；有两个桶时，最早那组的
    // 精确到期日接口不给 ⇒ 只能标「早于 period 末」。
    const earlyExpireAt = earlyInitial <= 0
      ? 0
      : (hasSecondBucket ? (cycleEndAt > 0 ? cycleEndAt - BEFORE_CYCLE_END_OFFSET_MS : 0) : cycleEndAt)
    const earlySource = earlyInitial <= 0
      ? 'unknown'
      : (hasSecondBucket ? 'before-cycle-end' : 'exact')

    if (earlyInitial > 0) {
      grants.push({
        id: `early:${cycleKey}`,
        at: current.at,
        amount: earlyInitial,
        kind: GRANT_KINDS.EARLY,
        cycleStart: current.cycleStart,
        cycleEnd: current.cycleEnd,
        expireAt: earlyExpireAt,
        expireSource: earlySource,
        label: '即将到期积分',
        priority: 0,
      })
    }

    // 周期末组内部再按 metric 拆：席位套餐（basic）与赠送（bonus）分开列，
    // 这样「已用」能落到正确的类别上。扣减顺序：福利 → 席位 → 积分包。
    const rest = round2(current.amount - earlyInitial)
    if (rest > 0) {
      const base = round2(Math.min(rest, Math.max(0, current.basicAmount)))
      const bonus = round2(rest - base)
      if (bonus > 0) {
        grants.push({
          id: `bonus:${cycleKey}`,
          at: current.at,
          amount: bonus,
          kind: GRANT_KINDS.CYCLE_BONUS,
          cycleStart: current.cycleStart,
          cycleEnd: current.cycleEnd,
          expireAt: cycleEndAt,
          expireSource: cycleEndAt > 0 ? 'exact' : 'unknown',
          label: '赠送/活动积分',
          priority: 1,
        })
      }
      if (base > 0) {
        grants.push({
          id: `base:${cycleKey}`,
          at: current.at,
          amount: base,
          kind: GRANT_KINDS.CYCLE_BASE,
          cycleStart: current.cycleStart,
          cycleEnd: current.cycleEnd,
          expireAt: cycleEndAt,
          expireSource: cycleEndAt > 0 ? 'exact' : 'unknown',
          label: '席位套餐积分',
          priority: 2,
        })
      }
    }
    return grants
  }

  // ── 同一周期内的增量 ────────────────────────────────────────────────
  //
  // ⚠️ **不能把 amountDelta 与 earlyDelta 各记一笔**：签到发 100 积分时，
  // `amount` 和 `expiring` **同时** +100（那 100 属于最早到期组）。若各记一笔
  // 就会变成 200、与接口的 amount 对不上——这是实测踩到的重复计数。
  //
  // 正确口径：新增额度先进「早到期组」，吃满 earlyDelta 后剩下的才算周期末组。
  const amountDelta = round2(current.amount - (previous?.amount ?? 0))
  const earlyDelta = round2(current.expiring - (previous?.expiring ?? 0))

  if (amountDelta > 0.005) {
    const toEarly = round2(Math.min(amountDelta, Math.max(0, earlyDelta)))
    if (toEarly > 0.005) {
      grants.push({
        id: `early:${current.at}:${toEarly.toFixed(2)}`,
        at: current.at,
        amount: toEarly,
        kind: GRANT_KINDS.EARLY,
        cycleStart: current.cycleStart,
        cycleEnd: current.cycleEnd,
        // 排序占位：比周期末略早；UI 显示「早于 <end_date>」而非这个毫秒值。
        expireAt: cycleEndAt > 0 ? cycleEndAt - BEFORE_CYCLE_END_OFFSET_MS : 0,
        expireSource: cycleEndAt > 0 ? 'before-cycle-end' : 'unknown',
        label: '签到/活动积分',
        priority: 0,
      })
    }
    const toCycleEnd = round2(amountDelta - toEarly)
    if (toCycleEnd > 0.005) {
      grants.push({
        id: `in:${current.at}:${toCycleEnd.toFixed(2)}`,
        at: current.at,
        amount: toCycleEnd,
        kind: GRANT_KINDS.IN_CYCLE,
        cycleStart: current.cycleStart,
        cycleEnd: current.cycleEnd,
        expireAt: cycleEndAt,
        expireSource: cycleEndAt > 0 ? 'exact' : 'unknown',
        label: '期内增发',
        priority: 2,
      })
    }
  } else if (earlyDelta > 0.005) {
    // amount 没涨但早到期组变多：库里积分被挪进短有效期组（少见）。
    grants.push({
      id: `early-move:${current.at}:${earlyDelta.toFixed(2)}`,
      at: current.at,
      amount: earlyDelta,
      kind: GRANT_KINDS.EARLY,
      cycleStart: current.cycleStart,
      cycleEnd: current.cycleEnd,
      expireAt: cycleEndAt > 0 ? cycleEndAt - BEFORE_CYCLE_END_OFFSET_MS : 0,
      expireSource: cycleEndAt > 0 ? 'before-cycle-end' : 'unknown',
      label: '转入早到期组',
      priority: 0,
    })
  }
  return grants
}

/**
 * 处理「到期核销」：剩余掉了、但已用没涨。
 *
 * ## 为什么必须单独处理
 *
 * 正常情况下 `remain` 减少一定伴随 `used` 增加（消费）。但积分**到期清零**
 * 是另一条路径：额度直接消失，`used` 不变。若不处理，账本会一直认为那部分
 * 还在（FIFO 分摊也不会扣它），导致「每笔之和 ≠ 接口 remain」。
 *
 * 判据：`Δremain < −Δused` 的部分即核销额。按官方顺序从**最早到期**的笔开始
 * 冲减（与消费同向），把它记成一条负向调整，而不是伪造一次消费。
 *
 * @returns {Array} 调整后的发放列表
 */
export function writeOffExpired(grants, previous, current) {
  if (current === undefined || previous === undefined) return grants
  if (previous.cycleStart !== current.cycleStart || previous.cycleEnd !== current.cycleEnd) return grants
  const remainDrop = round2(previous.remain - current.remain)
  const usedGain = round2(current.used - previous.used)
  const writeOff = round2(remainDrop - usedGain)
  if (writeOff <= 0.005) return grants

  const cycleKey = `${current.cycleStart}~${current.cycleEnd}`
  let remaining = writeOff
  const next = []
  const cycle = grants
    .filter(grant => grant.cycleStart === current.cycleStart && grant.cycleEnd === current.cycleEnd)
    .sort((a, b) => (a.expireAt || Number.MAX_SAFE_INTEGER) - (b.expireAt || Number.MAX_SAFE_INTEGER))
  const touched = new Set()
  for (const grant of cycle) {
    if (remaining <= 0.005) break
    const cut = Math.min(grant.amount, remaining)
    remaining = round2(remaining - cut)
    touched.add(grant.id)
    next.push({ ...grant, amount: round2(grant.amount - cut) })
  }
  const untouched = grants.filter(grant => !touched.has(grant.id))
  return [...untouched, ...next.filter(grant => grant.amount > 0.005)]
}

/**
 * **强制三条不变量**（本模块唯一的正确性定义）。
 *
 * 增量记账（{@link deriveGrants}）只能看到「变化了多少」，看不到「从哪个桶
 * 挪过来的」：签到/结转/后台调整都可能让 `expiring` 单独变大而不动 `amount`。
 * 若把这种增量当成「新钱」，账本总额就会超过接口的 `amount` —— 实测踩到过
 * （expiring +1000 而 amount 不变，账本凭空多出 1000）。
 *
 * 因此每次观测后都按当前读数**重算**两组的应有总额，再把差额用合成记录补齐
 * 或裁掉，保证恒等：
 *
 *     早到期组初始之和 = used + expiring     （截断到 amount）
 *     全部初始之和     = amount
 *
 * 这不是「猜测」：两式直接由「扣减从最早到期组开始」+「两组剩余之和 = remain」
 * 推出，且在两个真实周期上分毫吻合。凡是违反它的增量，都是观测不足造成的
 * 假象，必须被修正。
 *
 * @returns {Array} 修正后的发放列表（可能修改/删除已有记录）
 */
export function enforceInvariants(grants, sample) {
  if (sample === undefined) return grants
  const inCycle = grant => grant.cycleStart === sample.cycleStart && grant.cycleEnd === sample.cycleEnd
  const isEarly = grant => grant.expireSource === 'before-cycle-end'

  const others = grants.filter(grant => !inCycle(grant))
  const cycle = grants.filter(inCycle)

  // 目标：早到期组 = used + expiring（不能超过 amount 或低于 0）
  const earlyTarget = round2(Math.min(sample.amount, Math.max(0, sample.used + sample.expiring)))
  const cycleEndTarget = round2(sample.amount - earlyTarget)

  const early = cycle.filter(isEarly)
  const cycleEnd = cycle.filter(grant => !isEarly(grant))

  const adjust = (list, target, prototype) => {
    let sum = round2(list.reduce((acc, grant) => acc + grant.amount, 0))
    let out = [...list]
    if (sum > target + 0.005) {
      // 多了：从最新获得的开始裁（保留最早的历史，裁掉后加进来的假象）。
      let excess = round2(sum - target)
      out = [...out].sort((a, b) => b.at - a.at)
      const kept = []
      for (const grant of out) {
        if (excess <= 0.005) { kept.push(grant); continue }
        const cut = Math.min(grant.amount, excess)
        excess = round2(excess - cut)
        const left = round2(grant.amount - cut)
        if (left > 0.005) kept.push({ ...grant, amount: left })
      }
      out = kept.sort((a, b) => a.at - b.at)
    } else if (sum < target - 0.005) {
      // 少了：补一条合成记录（标 estimated，UI 上不伪装成精确发放）。
      out.push({
        ...prototype,
        id: `${prototype.id}:fill:${round2(target - sum).toFixed(2)}`,
        amount: round2(target - sum),
      })
    }
    return out
  }

  const cycleEndAt = cycleEndMsOf(sample.cycleEnd)
  const earlyFixed = adjust(early, earlyTarget, {
    at: sample.at,
    kind: GRANT_KINDS.SYNTHETIC,
    cycleStart: sample.cycleStart,
    cycleEnd: sample.cycleEnd,
    expireAt: cycleEndAt > 0 ? cycleEndAt - BEFORE_CYCLE_END_OFFSET_MS : 0,
    expireSource: cycleEndAt > 0 ? 'before-cycle-end' : 'unknown',
    label: '未观测到的早到期积分',
    priority: 0,
  })
  const cycleEndFixed = adjust(cycleEnd, cycleEndTarget, {
    at: sample.at,
    kind: GRANT_KINDS.SYNTHETIC,
    cycleStart: sample.cycleStart,
    cycleEnd: sample.cycleEnd,
    expireAt: cycleEndAt,
    expireSource: cycleEndAt > 0 ? 'exact' : 'unknown',
    label: '未观测到的周期积分',
    priority: 2,
  })

  let next = [...others, ...earlyFixed, ...cycleEndFixed]
  // 上限保护：只淘汰**非当前周期**的最旧记录，绝不裁当前周期（裁了会破坏不变量）。
  while (next.length > MAX_GRANTS) {
    const candidates = next.filter(grant => !inCycle(grant))
    if (candidates.length === 0) break
    const oldest = candidates.reduce((min, grant) => (grant.at < min.at ? grant : min), candidates[0])
    next = next.filter(grant => grant !== oldest)
  }
  return next
}

/** 追加观测点：同一天只保留最新一条（避免把账本灌满）。 */
export function appendSample(samples, sample) {
  const dayKey = isoDateOf(sample.at)
  const next = samples.filter(existing => isoDateOf(existing.at) !== dayKey)
  next.push(sample)
  next.sort((a, b) => a.at - b.at)
  while (next.length > MAX_SAMPLES) next.shift()
  return next
}

/**
 * 记录一次观测（纯函数）：追加点 + 派生发放 + 对账。
 *
 * 不写盘；写盘由 {@link trackExpiring} 负责。
 */
export function recordObservation(book, sample) {
  if (sample === undefined) return book
  const last = book.samples.length > 0 ? book.samples[book.samples.length - 1] : undefined
  const samples = appendSample(book.samples, sample)
  const previous = last !== undefined && last.at <= sample.at ? last : undefined
  let grants = [...book.grants, ...deriveGrants(previous, sample)]
  grants = writeOffExpired(grants, previous, sample)
  grants = enforceInvariants(grants, sample)
  return {
    schema: QUOTA_BUCKETS_SCHEMA,
    samples,
    grants,
    updatedAt: new Date(sample.at).toISOString(),
  }
}

// ---------------------------------------------------------------------------
// 投影：FIFO 分摊 + 到期列表
// ---------------------------------------------------------------------------

/**
 * 把当前周期的发放按到期日升序排成扣减队列，用 API 的 `used` 做 FIFO 分摊。
 *
 * @param grants 全量发放记录
 * @param sample 当前观测点（提供 used 与周期）
 * @returns 每笔 `{...grant, used, remain, expireDate, expireLabel, expireExact}`
 */
export function allocateUsed(grants, sample) {
  if (sample === undefined) return []
  const cycle = grants
    .filter(grant => grant.cycleStart === sample.cycleStart && grant.cycleEnd === sample.cycleEnd)
    .sort((a, b) => {
      // expireAt=0 视为「到期日未知」，恒排最后（最不该先扣）。
      if (a.expireAt === 0 || b.expireAt === 0) {
        if (a.expireAt === b.expireAt) return (a.priority ?? 3) - (b.priority ?? 3)
        return a.expireAt === 0 ? 1 : -1
      }
      if (a.expireAt !== b.expireAt) return a.expireAt - b.expireAt
      // 同一到期日：按官方扣减顺序（福利 → 席位 → 其他），再按获得时间。
      const byPriority = (a.priority ?? 3) - (b.priority ?? 3)
      return byPriority !== 0 ? byPriority : a.at - b.at
    })

  let remainingUsed = Math.max(0, sample.used)
  const rows = []
  for (const grant of cycle) {
    const consumed = Math.min(grant.amount, remainingUsed)
    remainingUsed = round2(remainingUsed - consumed)
    const remain = round2(grant.amount - consumed)
    rows.push({
      ...grant,
      used: round2(consumed),
      remain,
      expireDate: grant.expireAt > 0 ? isoDateOf(grant.expireAt) : '',
      expireExact: grant.expireSource === 'exact',
      expireLabel: grant.expireSource === 'exact'
        ? (grant.expireAt > 0 ? isoDateOf(grant.expireAt) : '—')
        : (grant.expireSource === 'before-cycle-end'
          ? `< ${sample.cycleEnd || '?'}`
          : '—'),
    })
  }
  return rows
}

/**
 * 从账本投影出「最近 N 笔即将过期的积分」。
 *
 * 排序：到期日升序（早到期的在前）；到期日相同按获得时间升序。
 * 只列还剩额度（`remain > 0`）的笔——已扣空的对用户没有意义。
 * 已过期的笔也不列（周期末清零后它们不该继续占据列表）。
 *
 * @param book 账本
 * @param options.limit 最多几条（默认 {@link DEFAULT_EXPIRING_LIMIT}）
 * @param options.nowMs 当前时刻
 */
export function projectExpiring(book, { limit = DEFAULT_EXPIRING_LIMIT, nowMs = Date.now() } = {}) {
  const last = book.samples.length > 0 ? book.samples[book.samples.length - 1] : undefined
  if (last === undefined) return { cycle: undefined, rows: [], totals: undefined }
  const all = allocateUsed(book.grants, last)
  // ⚠️ 合计必须按**全量**行算：已扣空（remain=0）的笔不该出现在列表里，
  // 但它的 used 已经真实发生，必须计入合计，否则 totals.used 会小于接口 used。
  const live = all.filter(row => row.remain > 0.005)
  const capped = Math.max(1, Math.min(Number(limit) || DEFAULT_EXPIRING_LIMIT, 20))
  const visible = live.slice(0, capped)
  return {
    cycle: { startDate: last.cycleStart, endDate: last.cycleEnd },
    rows: visible,
    totals: {
      amount: round2(all.reduce((sum, row) => sum + row.amount, 0)),
      used: round2(all.reduce((sum, row) => sum + row.used, 0)),
      remain: round2(all.reduce((sum, row) => sum + row.remain, 0)),
      count: live.length,
      usedUp: Math.max(0, all.length - live.length),
      hidden: Math.max(0, live.length - visible.length),
    },
  }
}

/**
 * 记录一次余额观测并返回投影结果。
 *
 * 路由层唯一入口：读账本 → 记录 → 写回 → 投影。**任何一步失败都不抛**，
 * 最坏情况是 `rows` 为空（UI 显示「暂无」），余额本身照常返回。
 */
export function trackExpiring(balance, { nowMs = Date.now(), limit = DEFAULT_EXPIRING_LIMIT, file } = {}) {
  const sample = sampleOfBalance(balance, nowMs)
  if (sample === undefined) return { cycle: undefined, rows: [], totals: undefined, recorded: false }
  try {
    const book = readQuotaBook(file)
    const next = recordObservation(book, sample)
    const recorded = writeQuotaBook(next, file)
    const projection = projectExpiring(next, { limit, nowMs })
    return { ...projection, recorded }
  } catch {
    // 账本自身异常绝不影响余额查询：退回空列表。
    return { cycle: undefined, rows: [], totals: undefined, recorded: false }
  }
}

/** 读账本（任何异常都退回空账本）。 */
export function readQuotaBook(file = quotaBucketsPath()) {
  try {
    return sanitizeQuotaBook(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return emptyQuotaBook()
  }
}

/** 原子写账本（0600）；失败返回 false，不抛。 */
export function writeQuotaBook(book, file = quotaBucketsPath()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.tmp-${process.pid}`
    fs.writeFileSync(temporary, `${JSON.stringify(book, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, file)
    return true
  } catch {
    return false
  }
}
