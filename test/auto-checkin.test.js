import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AUTO_CHECKIN_SCHEMA,
  claimCodeArtsDailyCheckin,
  computeClaimSummary,
  createAutoCheckin,
  createFileAutoCheckinStore,
  describeChannel,
  describeRun,
  sanitizeAutoCheckin,
  utc8DateString,
} from '../src/auto-checkin.js'

const SNAP = 'https://snap-access.cn-north-4.myhuaweicloud.com'

/** 按 URL 返回预设响应的 mock fetch。 */
function mockFetch(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' })
    const key = Object.keys(routes).find(suffix => String(url).includes(suffix))
    if (key === undefined) throw new Error(`unexpected url: ${url}`)
    const body = routes[key]
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return new Response(text, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  fetchImpl.calls = calls
  return fetchImpl
}

const signStub = {
  async sign() {
    return new Map([['host', 'snap-access.cn-north-4.myhuaweicloud.com']])
  },
}

test('utc8DateString crosses the date boundary at 16:00 UTC', () => {
  assert.equal(utc8DateString(Date.parse('2026-10-29T15:59:00Z')), '2026-10-29')
  assert.equal(utc8DateString(Date.parse('2026-10-29T16:00:00Z')), '2026-10-30')
})

test('sanitizeAutoCheckin keeps the switch open unless explicitly false', () => {
  assert.equal(sanitizeAutoCheckin(undefined).enabled, true)
  assert.equal(sanitizeAutoCheckin({}).enabled, true)
  assert.equal(sanitizeAutoCheckin({ enabled: 'false' }).enabled, true)
  assert.equal(sanitizeAutoCheckin({ enabled: false }).enabled, false)
})

test('file store round-trips the document', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codearts-checkin-'))
  const store = createFileAutoCheckinStore({ home })
  assert.equal(store.load().lastDate, '')
  await store.save({
    enabled: true,
    lastDate: '2026-10-29',
    lastResult: '1 个渠道：1 个账号领取成功（+1000积分）',
    lastAt: 1,
    channels: [{ provider: 'codearts', text: '1 个 +1000积分' }],
    dismissedRunAt: 0,
  })
  const loaded = store.load()
  assert.equal(loaded.lastDate, '2026-10-29')
  assert.deepEqual(loaded.channels, [{ provider: 'codearts', text: '1 个 +1000积分' }])
  const raw = JSON.parse(fs.readFileSync(store.file, 'utf8'))
  assert.equal(raw.schema, AUTO_CHECKIN_SCHEMA)
  fs.rmSync(home, { recursive: true, force: true })
})

test('claimCodeArtsDailyCheckin claims the daily login reward', async () => {
  const fetcher = mockFetch({
    '/snap-manager/v1/statistics/plugin': { code: 0, data: { package: { is_credit_package: true } } },
    '/v1/ops/delivery': { code: 0, data: { items: [{ campaignId: 1, type: 'USER_LOGIN', claimable: true, status: 'CLAIMABLE', benefitAmount: 1000 }] } },
    '/v1/ops/claim': { code: 0, data: { id: 99, benefitAmount: 1000 } },
    '/v1/ops/confirm': { code: 0, data: {} },
  })
  const outcome = await claimCodeArtsDailyCheckin(
    { access_key_id: 'ak', secret_access_key: 'sk', security_token: 'st' },
    { sign: signStub.sign, fetcher },
  )
  assert.equal(outcome.kind, 'claimed')
  assert.equal(outcome.credit, 1000)
  assert.deepEqual(fetcher.calls.map(call => call.method), ['GET', 'GET', 'POST', 'POST'])
})

test('claimCodeArtsDailyCheckin treats a claimed activity as already-claimed', async () => {
  const fetcher = mockFetch({
    '/snap-manager/v1/statistics/plugin': { code: 0, data: { package: { is_credit_package: true } } },
    '/v1/ops/delivery': { code: 0, data: { items: [{ campaignId: 1, type: 'USER_LOGIN', claimable: false, status: 'CLAIMED', benefitAmount: 1000 }] } },
  })
  const outcome = await claimCodeArtsDailyCheckin(
    { access_key_id: 'ak', secret_access_key: 'sk', security_token: 'st' },
    { sign: signStub.sign, fetcher },
  )
  assert.equal(outcome.kind, 'already-claimed')
  assert.equal(fetcher.calls.length, 2)
})

test('claimCodeArtsDailyCheckin skips non-credit packages', async () => {
  const fetcher = mockFetch({
    '/snap-manager/v1/statistics/plugin': { code: 0, data: { package: { is_credit_package: false, is_token_package: true } } },
  })
  const outcome = await claimCodeArtsDailyCheckin(
    { access_key_id: 'ak', secret_access_key: 'sk', security_token: 'st' },
    { sign: signStub.sign, fetcher },
  )
  assert.equal(outcome.kind, 'inactive')
})

test('claimCodeArtsDailyCheckin reports claim failures without throwing', async () => {
  const fetcher = async () => new Response('boom', { status: 500 })
  const outcome = await claimCodeArtsDailyCheckin(
    { access_key_id: 'ak', secret_access_key: 'sk', security_token: 'st' },
    { sign: signStub.sign, fetcher },
  )
  assert.equal(outcome.kind, 'failed')
  assert.match(outcome.message, /HTTP 500/)
})

test('summary and text formatting match the legacy document format', () => {
  const summary = computeClaimSummary([
    { kind: 'claimed', credit: 1000 },
    { kind: 'already-claimed' },
    { kind: 'failed' },
  ])
  assert.equal(summary.claimed, 1)
  assert.equal(summary.alreadyClaimed, 1)
  assert.equal(summary.coversToday, 2)
  const totals = { providers: 1, claimed: 1, totalCredit: 1000, alreadyClaimed: 1, failed: 1, inactive: 0, coversToday: 2 }
  assert.equal(describeRun(totals), '1 个渠道：1 个账号领取成功（+1000积分），1 个今天已领，1 个失败')
  assert.equal(describeChannel(summary), '1 个 +1000积分，1 个今天已领，1 个失败')
})

test('runIfDue writes today and skips repeated runs', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codearts-checkin-'))
  const store = createFileAutoCheckinStore({ home })
  const nowMs = Date.parse('2026-10-29T10:00:00+08:00')
  let claimCalls = 0
  const checkin = createAutoCheckin({
    store,
    now: () => nowMs,
    listAccounts: async () => [{ id: 'a1', nickname: 'n', credentialRef: 'CODEARTS_ACCOUNT_AAA111' }],
    resolveCredential: async () => ({ access_key_id: 'ak', secret_access_key: 'sk' }),
    claim: async () => {
      claimCalls += 1
      return { kind: 'claimed', credit: 1000 }
    },
    warn: () => {},
  })
  await checkin.runIfDue()
  assert.equal(claimCalls, 1)
  const doc = store.load()
  assert.equal(doc.lastDate, '2026-10-29')
  assert.equal(doc.lastResult, '1 个渠道：1 个账号领取成功（+1000积分）')
  assert.deepEqual(doc.channels, [{ provider: 'codearts', text: '1 个 +1000积分' }])
  assert.equal(checkin.state().ranToday, true)

  // 同一天再跑一次：不再领取、不再写盘。
  await checkin.runIfDue()
  assert.equal(claimCalls, 1)
  fs.rmSync(home, { recursive: true, force: true })
})

test('runIfDue does not mark today when every account fails', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codearts-checkin-'))
  const store = createFileAutoCheckinStore({ home })
  const warnings = []
  const checkin = createAutoCheckin({
    store,
    now: () => Date.parse('2026-10-29T10:00:00+08:00'),
    listAccounts: async () => [{ id: 'a1', nickname: '', credentialRef: 'CODEARTS_ACCOUNT_AAA111' }],
    resolveCredential: async () => undefined,
    claim: async () => {
      throw new Error('must not be called when credential is missing')
    },
    warn: message => warnings.push(message),
  })
  await checkin.runIfDue()
  assert.equal(store.load().lastDate, '')
  assert.ok(warnings.some(message => message.includes('未记入今日')))
  fs.rmSync(home, { recursive: true, force: true })
})

test('disabled switch and already-ran-today both prevent a run', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codearts-checkin-'))
  const store = createFileAutoCheckinStore({ home })
  const today = utc8DateString()
  await store.save({ enabled: false, lastDate: '', lastResult: '', lastAt: 0, channels: [], dismissedRunAt: 0 })
  let claimCalls = 0
  const make = () => createAutoCheckin({
    store,
    listAccounts: async () => [{ id: 'a1', nickname: '', credentialRef: 'CODEARTS_ACCOUNT_AAA111' }],
    resolveCredential: async () => ({ access_key_id: 'ak', secret_access_key: 'sk' }),
    claim: async () => {
      claimCalls += 1
      return { kind: 'claimed', credit: 1000 }
    },
    warn: () => {},
  })
  await make().runIfDue()
  assert.equal(claimCalls, 0)

  await store.save({ enabled: true, lastDate: today, lastResult: 'x', lastAt: 1, channels: [], dismissedRunAt: 0 })
  await make().runIfDue()
  assert.equal(claimCalls, 0)
  fs.rmSync(home, { recursive: true, force: true })
})

test('runIfDue reloads the switch written by the upstream panel', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codearts-checkin-'))
  const store = createFileAutoCheckinStore({ home })
  await store.save({ enabled: true, lastDate: '', lastResult: '', lastAt: 0, channels: [], dismissedRunAt: 0 })
  let claimCalls = 0
  const checkin = createAutoCheckin({
    store,
    now: () => Date.parse('2026-10-29T10:00:00+08:00'),
    listAccounts: async () => [{ id: 'a1', nickname: '', credentialRef: 'CODEARTS_ACCOUNT_AAA111' }],
    resolveCredential: async () => ({ access_key_id: 'ak', secret_access_key: 'sk' }),
    claim: async () => {
      claimCalls += 1
      return { kind: 'claimed', credit: 1000 }
    },
    warn: () => {},
  })
  // 面板在控制器创建之后把开关关掉：磁盘文档为准。
  await store.save({ enabled: false, lastDate: '', lastResult: '', lastAt: 0, channels: [], dismissedRunAt: 0 })
  await checkin.runIfDue()
  assert.equal(claimCalls, 0)
  fs.rmSync(home, { recursive: true, force: true })
})
