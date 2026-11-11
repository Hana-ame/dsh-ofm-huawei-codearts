/**
 * 本地配额账本（quota-ledger）与 balance 路由的 expiring 字段。
 *
 * 这一层的价值全在**算术**：远端没有任何明细 API，所以「每笔之和 = amount、
 * 每笔已用之和 = used、每笔剩余之和 = remain」这三条是账本唯一可信度判据，
 * 每个场景都直接锁它们。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  allocateUsed,
  cycleEndMsOf,
  deriveGrants,
  emptyQuotaBook,
  enforceInvariants,
  isoDateOf,
  normalizeSample,
  projectExpiring,
  readQuotaBook,
  recordObservation,
  sampleOfBalance,
  sanitizeQuotaBook,
  trackExpiring,
  writeOffExpired,
  writeQuotaBook,
} from '../src/quota-ledger.js'
import { createBalanceRoute, parseExpiringLimit } from '../src/balance-route.js'

const NS = '2026-11-07'
const NE = '2026-12-08'

/** 构造一个 balance 响应（字段形状与 fetchCodeArtsCreditBalance 一致）。 */
function balanceOf({ cycle = { startDate: NS, endDate: NE }, total, basic = { amount: 500, used: 0, remain: 500 }, bonus }) {
  return {
    packageName: '体验版',
    cycle,
    total,
    basic,
    onDemand: { amount: 0, used: 0, remain: 0 },
    bonus: bonus ?? total,
  }
}

/** 2026-11-11 03:14 CST 的真实读数。 */
const REAL = balanceOf({
  total: { amount: 11600, used: 3823.69, remain: 7776.31, expiring: 1276.31 },
  bonus: { amount: 11100, used: 3823.69, remain: 7276.31 },
})
const T1 = Date.parse('2026-11-11T03:14:00+08:00')

function bookWith(balance, at = T1) {
  return recordObservation(emptyQuotaBook(), sampleOfBalance(balance, at))
}

/** 三条总额判据：每笔之和必须与接口字段逐项吻合。 */
function assertTotalsMatch(projection, balance) {
  assert.ok(projection.totals !== undefined, '缺少 totals')
  assert.equal(projection.totals.amount, balance.total.amount, 'amount 合计不等于接口 amount')
  assert.equal(projection.totals.used, balance.total.used, 'used 合计不等于接口 used')
  assert.equal(projection.totals.remain, balance.total.remain, 'remain 合计不等于接口 remain')
}

test('sampleOfBalance 提取周期与四个 metric', () => {
  const sample = sampleOfBalance(REAL, T1)
  assert.equal(sample.amount, 11600)
  assert.equal(sample.used, 3823.69)
  assert.equal(sample.remain, 7776.31)
  assert.equal(sample.expiring, 1276.31)
  assert.equal(sample.cycleStart, NS)
  assert.equal(sample.cycleEnd, NE)
  assert.equal(sample.basicAmount, 500)
  // 缺字段时返回 undefined（不记账、不报错）
  assert.equal(sampleOfBalance({ total: { amount: 1 } }, T1), undefined)
  assert.equal(sampleOfBalance(undefined, T1), undefined)
})

test('期初按「早到期组 + 周期末组」拆分，且合计等于 amount', () => {
  const book = bookWith(REAL)
  const sum = book.grants.reduce((acc, grant) => acc + grant.amount, 0)
  assert.equal(Math.round(sum * 100) / 100, 11600)

  // 早到期组初始 = used + expiring = 3823.69 + 1276.31 = 5100
  const early = book.grants.find(grant => grant.kind === 'early')
  assert.equal(early.amount, 5100)
  // 它早于周期末到期 ⇒ 只能是「推算」，绝不能标成精确
  assert.equal(early.expireSource, 'before-cycle-end')

  // 周期末组 6500 = 席位 500 + 赠送 6000
  assert.equal(book.grants.find(g => g.kind === 'cycle-base').amount, 500)
  assert.equal(book.grants.find(g => g.kind === 'cycle-bonus').amount, 6000)
  for (const grant of book.grants.filter(g => g.kind !== 'early')) {
    assert.equal(grant.expireSource, 'exact')
  }
})

test('真实读数投影出的三项合计与接口逐项相等', () => {
  const projection = projectExpiring(bookWith(REAL), { limit: 5, nowMs: T1 })
  assertTotalsMatch(projection, REAL)
  // 最早到期的那笔就是早到期组，剩余必须等于接口 expiring
  assert.equal(projection.rows[0].remain, 1276.31)
  assert.equal(projection.rows[0].expireExact, false)
  // 否则界面就不会把「即将过期」显示成紧迫的那一部分
  assert.notEqual(projection.rows[0].remain, 7776.31)
})

test('早到期组用完后第二组接棒，且合计仍吻合', () => {
  const b2 = balanceOf({
    total: { amount: 11600, used: 5100, remain: 6500, expiring: 0 },
    bonus: { amount: 11100, used: 5100, remain: 6000 },
  })
  const book = recordObservation(bookWith(REAL), sampleOfBalance(b2, T1 + 3600e3))
  const projection = projectExpiring(book, { limit: 5, nowMs: T1 + 3600e3 })
  assertTotalsMatch(projection, b2)
  // 早到期组已扣空 → 不在列表里
  assert.equal(projection.rows.some(row => row.kind === 'early'), false)
  assert.equal(projection.totals.usedUp, 1)
})

test('签到同时推高 amount 与 expiring 时不得双计', () => {
  // 官方行为：签到 +100 会让 amount 与 expiring 同时 +100（那 100 属于短有效期组）。
  // 若 amountDelta 与 earlyDelta 各记一笔 → 合计 200，与接口对不上。
  const b2 = balanceOf({
    total: { amount: 11700, used: 5100, remain: 6600, expiring: 100 },
    bonus: { amount: 11200, used: 5100, remain: 6100 },
  })
  const book = recordObservation(
    bookWith(balanceOf({
      total: { amount: 11600, used: 5100, remain: 6500, expiring: 0 },
      bonus: { amount: 11100, used: 5100, remain: 6000 },
    }), T1),
    sampleOfBalance(b2, T1 + 3600e3),
  )
  const sum = Math.round(book.grants.reduce((acc, grant) => acc + grant.amount, 0) * 100) / 100
  assert.equal(sum, 11700, '签到被双计了')
  assertTotalsMatch(projectExpiring(book, { limit: 5, nowMs: T1 + 3600e3 }), b2)
})

test('周期翻页后旧周期不再出现，新周期合计吻合', () => {
  const b3 = balanceOf({
    cycle: { startDate: NE, endDate: '2027-01-08' },
    total: { amount: 11700, used: 0, remain: 11700, expiring: 0 },
    bonus: { amount: 11200, used: 0, remain: 11200 },
  })
  const at = Date.parse('2026-12-08T01:00:00+08:00')
  const book = recordObservation(bookWith(REAL), sampleOfBalance(b3, at))
  const projection = projectExpiring(book, { limit: 5, nowMs: at })
  assertTotalsMatch(projection, b3)
  assert.equal(projection.cycle.startDate, NE)
  // 旧周期的笔不能混进来
  assert.equal(projection.rows.every(row => row.cycleEnd === '2027-01-08'), true)
})

test('到期核销：remain 掉了但 used 没涨，不得记成消费', () => {
  const previous = sampleOfBalance(REAL, T1)
  // remain 从 7776.31 掉到 7276.31（-500），used 不动 ⇒ 500 是到期清零
  const current = sampleOfBalance(balanceOf({
    total: { amount: 11600, used: 3823.69, remain: 7276.31, expiring: 1276.31 },
    bonus: { amount: 11100, used: 3823.69, remain: 6776.31 },
  }), T1 + 3600e3)
  const grants = deriveGrants(previous, current)
  const adjusted = writeOffExpired(
    [{ id: 'a', amount: 1000, cycleStart: NS, cycleEnd: NE, expireAt: 1, priority: 0 },
      { id: 'b', amount: 2000, cycleStart: NS, cycleEnd: NE, expireAt: 2, priority: 2 }],
    previous,
    current,
  )
  const sum = adjusted.reduce((acc, grant) => acc + grant.amount, 0)
  assert.equal(sum, 2500, '核销额应从最早到期那笔起冲减 500')
  assert.deepEqual(grants, [], '到期清零不应产生新的发放记录')
})

test('expiring 单独变大但 amount 不变时不得凭空多出额度', () => {
  // 真实踩到的 bug：expiring 从 1267.08 涨到 2267.08，amount 仍是 11600。
  // 若把「早到期组 +1000」当成新钱，账本总额会超成 12600。
  const before = balanceOf({
    total: { amount: 11600, used: 3832.92, remain: 7767.08, expiring: 1267.08 },
    bonus: { amount: 11100, used: 3832.92, remain: 7267.08 },
  })
  const after = balanceOf({
    total: { amount: 11600, used: 3832.92, remain: 7767.08, expiring: 2267.08 },
    bonus: { amount: 11100, used: 3832.92, remain: 7267.08 },
  })
  const book = recordObservation(bookWith(before), sampleOfBalance(after, T1 + 3600e3))

  const sum = Math.round(book.grants.reduce((acc, grant) => acc + grant.amount, 0) * 100) / 100
  assert.equal(sum, 11600, '账本总额偏离了接口 amount')

  const projection = projectExpiring(book, { limit: 20, nowMs: T1 + 3600e3 })
  assertTotalsMatch(projection, after)
  // 早到期组的剩余必须等于接口 expiring
  const earlyRows = projection.rows.filter(row => row.expireExact === false)
  const earlyRemain = Math.round(earlyRows.reduce((acc, row) => acc + row.remain, 0) * 100) / 100
  assert.equal(earlyRemain, 2267.08)
})

test('不变量在任意读数列下都成立（财产性测试）', () => {
  // 遍历一批自洽的读数，逐点断言三条恒等。任何一条破了都说明反解逻辑错了。
  const cases = [
    { amount: 11600, used: 0, remain: 11600, expiring: 0 },
    { amount: 11600, used: 100, remain: 11500, expiring: 100 },
    { amount: 11600, used: 5100, remain: 6500, expiring: 0 },
    { amount: 11600, used: 3823.69, remain: 7776.31, expiring: 1276.31 },
    { amount: 11600, used: 7776.31, remain: 3823.69, expiring: 0 },
    { amount: 12600, used: 3823.69, remain: 8776.31, expiring: 1276.31 },
  ]
  let book = emptyQuotaBook()
  for (const [index, c] of cases.entries()) {
    const balance = balanceOf({
      total: { ...c },
      bonus: { amount: c.amount - 500, used: c.used, remain: c.remain - 500 },
    })
    book = recordObservation(book, sampleOfBalance(balance, T1 + index * 3600e3))
    const projection = projectExpiring(book, { limit: 20, nowMs: T1 + index * 3600e3 })
    assertTotalsMatch(projection, balance)
  }
})

test('enforceInvariants 直接修掉超额与不足两侧', () => {
  const sample = sampleOfBalance(balanceOf({
    total: { amount: 11600, used: 5100, remain: 6500, expiring: 1276.31 },
    bonus: { amount: 11100, used: 5100, remain: 5223.69 },
  }), T1)
  const cycle = { cycleStart: NS, cycleEnd: NE }
  // 故意给超额的一组
  const fixed = enforceInvariants([
    { id: 'e1', at: 1, amount: 9999, kind: 'early', ...cycle, expireAt: 1, expireSource: 'before-cycle-end', label: 'x', priority: 0 },
    { id: 'c1', at: 1, amount: 1, kind: 'cycl-end', ...cycle, expireAt: 2, expireSource: 'exact', label: 'y', priority: 2 },
  ], sample)
  const sum = Math.round(fixed.reduce((acc, grant) => acc + grant.amount, 0) * 100) / 100
  assert.equal(sum, 11600)
  const earlySum = Math.round(fixed.filter(g => g.expireSource === 'before-cycle-end').reduce((a, g) => a + g.amount, 0) * 100) / 100
  assert.equal(earlySum, Math.round((sample.used + sample.expiring) * 100) / 100)
})

test('allocateUsed 按到期日升序做 FIFO，同到期日按官方优先级', () => {
  const sample = { cycleStart: NS, cycleEnd: NE, used: 150 }
  const grants = [
    { id: 'late', amount: 500, at: 1, cycleStart: NS, cycleEnd: NE, expireAt: 2000, priority: 2 },
    { id: 'early', amount: 100, at: 2, cycleStart: NS, cycleEnd: NE, expireAt: 1000, priority: 0 },
    { id: 'same', amount: 300, at: 3, cycleStart: NS, cycleEnd: NE, expireAt: 2000, priority: 1 },
  ]
  const rows = allocateUsed(grants, sample)
  assert.deepEqual(rows.map(row => row.id), ['early', 'same', 'late'])
  assert.deepEqual(rows.map(row => row.used), [100, 50, 0])
  assert.deepEqual(rows.map(row => row.remain), [0, 250, 500])
})

test('projectExpiring 只列有剩余的笔，但合计仍含已扣空的笔', () => {
  const projection = projectExpiring(bookWith(balanceOf({
    total: { amount: 11600, used: 3823.69, remain: 7776.31, expiring: 0 },
    bonus: { amount: 11100, used: 3823.69, remain: 7276.31 },
  })), { limit: 1, nowMs: T1 })
  // limit=1 只显示 1 笔，但合计必须覆盖全部
  assert.equal(projection.rows.length, 1)
  assert.equal(projection.totals.amount, 11600)
  assert.equal(projection.totals.used, 3823.69)
  assert.equal(projection.totals.remain, 7776.31)
})

test('limit 解析与投影上限', () => {
  assert.equal(parseExpiringLimit(undefined), 5)
  assert.equal(parseExpiringLimit('3'), 3)
  assert.equal(parseExpiringLimit('0'), 5)
  assert.equal(parseExpiringLimit('abc'), 5)
  assert.equal(parseExpiringLimit('999'), 20)
  const projection = projectExpiring(bookWith(REAL), { limit: 20, nowMs: T1 })
  assert.ok(projection.rows.length <= 20)
})

test('账本落盘往返 + 脏数据兜底', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codearts-quota-'))
  const file = path.join(dir, 'quota.json')
  const book = bookWith(REAL)
  assert.equal(writeQuotaBook(book, file), true)
  const loaded = readQuotaBook(file)
  assert.equal(loaded.samples.length, 1)
  assert.equal(loaded.grants.length, book.grants.length)

  // 缺文件 / 坏 JSON 一律退回空账本，不抛
  assert.deepEqual(readQuotaBook(path.join(dir, 'missing.json')).grants, [])
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json')
  assert.deepEqual(readQuotaBook(path.join(dir, 'bad.json')).samples, [])

  // sanitize 丢掉非法条目但保留合法条目
  const cleaned = sanitizeQuotaBook({
    samples: [{ at: T1, amount: 1, used: 0, remain: 1 }, { at: -1 }],
    grants: [{ amount: 0, at: T1 }, { amount: 5, at: T1 }],
  })
  assert.equal(cleaned.samples.length, 1)
  assert.equal(cleaned.grants.length, 1)
})

test('cycleEndMsOf 把 end_date 换算成当日 24:00 UTC+8', () => {
  const ms = cycleEndMsOf(NE)
  assert.equal(isoDateOf(ms - 1000), NE, '周期末前 1 秒应仍是 end_date 当天')
  assert.equal(isoDateOf(ms), '2026-12-09', '周期末应进入次日')
  assert.equal(cycleEndMsOf('bad'), 0)
  assert.equal(cycleEndMsOf(undefined), 0)
})

test('trackExpiring 端到端：返回投影并落盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codearts-track-'))
  const file = path.join(dir, 'quota.json')
  const result = trackExpiring(REAL, { nowMs: T1, limit: 5, file })
  assert.equal(result.recorded, true)
  assert.ok(result.rows.length >= 1)
  assertTotalsMatch(result, REAL)
  assert.equal(fs.existsSync(file), true)
  // 不落盘时也不炸
  const noWrite = trackExpiring({ total: {} }, { nowMs: T1, file })
  assert.deepEqual(noWrite.rows, [])
})

test('balance 路由下发 expiring，且账本异常不影响余额', async () => {
  const invoke = async deps => {
    const res = { status: 0, body: '', writeHead(code) { this.status = code }, end(body) { this.body = body } }
    await createBalanceRoute(deps)(
      { method: 'GET', url: '/api/dsh-ofm-huawei-codearts/balance?limit=3' },
      res,
    )
    return { status: res.status, payload: JSON.parse(res.body) }
  }
  const base = {
    resolveAccount: async () => ({ ref: 'r', credential: { access_key_id: 'ak', secret_access_key: 'sk' } }),
    fetchBalance: async () => ({ ok: true, balance: REAL }),
    readCheckin: () => ({ enabled: true, lastDate: '', lastResult: '', lastAt: 0, channels: [] }),
  }

  // 有 trackExpiring：expiring 带 rows
  const withTrack = await invoke({
    ...base,
    trackExpiring: balance => trackExpiring(balance, { nowMs: T1, limit: 3, file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codearts-route-')), 'q.json') }),
  })
  assert.equal(withTrack.status, 200)
  assert.ok(Array.isArray(withTrack.payload.expiring.rows))

  // trackExpiring 抛错：余额照常返回，expiring=null
  const withThrow = await invoke({ ...base, trackExpiring: () => { throw new Error('boom') } })
  assert.equal(withThrow.status, 200)
  assert.equal(withThrow.payload.expiring, null)
  assert.equal(withThrow.payload.balance.total.amount, 11600)

  // 没注入：expiring=null（老接线兼容）
  const without = await invoke(base)
  assert.equal(without.payload.expiring, null)
})
