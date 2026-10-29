import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCreditBalanceMetrics } from '../src/auto-checkin.js'
import { createBalanceRoute, isCredentialExpiredMessage } from '../src/balance-route.js'

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body
    },
  }
}

function fakeReq(method, url) {
  return { method, url }
}

test('parseCreditBalanceMetrics parses total and per-package metrics', () => {
  const metrics = [
    { name: 'usageTotalPackageCredit', package_credit_amount: 20600, package_credit_used: 1192.88, package_credit_remain: 19407.12, package_credit_expiring_amount: 46.71 },
    { name: 'usageBasicPackageCredit', package_credit_amount: 500, package_credit_used: 0, package_credit_remain: 500 },
    { name: 'usageOnDemandPackageCredit', package_credit_amount: 0, package_credit_used: 0, package_credit_remain: 0 },
    { name: 'usageBonusPackageCredit', package_credit_amount: 20100, package_credit_used: 1192.88, package_credit_remain: 18907.12 },
    { name: 'usageDataChatMessages', value: -1 },
  ]
  const parsed = parseCreditBalanceMetrics(metrics)
  assert.deepEqual(parsed.total, { amount: 20600, used: 1192.88, remain: 19407.12, expiring: 46.71 })
  assert.equal(parsed.basic.remain, 500)
  assert.equal(parsed.bonus.remain, 18907.12)
  assert.equal(parsed.onDemand.remain, 0)
  assert.equal(parseCreditBalanceMetrics(undefined), undefined)
  assert.equal(parseCreditBalanceMetrics([]), undefined)
})

test('balance route returns balance and checkin state', async () => {
  const res = fakeResponse()
  const handler = createBalanceRoute({
    resolveAccount: async () => ({ ref: 'CODEARTS_ACCOUNT_AAA111', credential: { access_key_id: 'ak', secret_access_key: 'sk' } }),
    fetchBalance: async () => ({
      ok: true,
      balance: {
        packageName: '体验版',
        packageStatus: 'normal',
        isCreditPackage: true,
        isTokenPackage: false,
        total: { amount: 20600, used: 1192.88, remain: 19407.12, expiring: 46.71 },
        basic: { amount: 500, used: 0, remain: 500, expiring: 0 },
        bonus: { amount: 20100, used: 1192.88, remain: 18907.12, expiring: 46.71 },
      },
    }),
    readCheckin: () => ({
      enabled: true,
      lastDate: '2026-10-30',
      lastResult: '1 个渠道：1 个账号领取成功（+100积分）',
      lastAt: 1793289670243,
      channels: [{ provider: 'codearts', text: '1 个 +100积分' }],
    }),
  })
  await handler(fakeReq('GET', '/api/dsh-ofm-huawei-codearts/balance'), res)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.balance.total.remain, 19407.12)
  assert.equal(payload.checkin.lastDate, '2026-10-30')
  assert.equal(payload.checkin.lastResult, '1 个渠道：1 个账号领取成功（+100积分）')
  assert.equal(typeof payload.today, 'string')
})

test('balance route errors are JSON with status codes', async () => {
  const missingCred = fakeResponse()
  await createBalanceRoute({
    resolveAccount: async () => undefined,
    fetchBalance: async () => ({ ok: true, balance: {} }),
    readCheckin: () => ({ enabled: true, lastDate: '', lastResult: '', lastAt: 0, channels: [] }),
  })(fakeReq('GET', '/api/dsh-ofm-huawei-codearts/balance'), missingCred)
  assert.equal(missingCred.status, 503)
  assert.equal(JSON.parse(missingCred.body).ok, false)

  const upstreamFail = fakeResponse()
  await createBalanceRoute({
    resolveAccount: async () => ({ ref: 'CODEARTS_ACCOUNT_AAA111', credential: { access_key_id: 'ak', secret_access_key: 'sk' } }),
    fetchBalance: async () => ({ ok: false, message: 'HTTP 401' }),
    readCheckin: () => ({ enabled: true, lastDate: '', lastResult: '', lastAt: 0, channels: [] }),
  })(fakeReq('GET', '/api/dsh-ofm-huawei-codearts/balance'), upstreamFail)
  assert.equal(upstreamFail.status, 502)
  assert.match(JSON.parse(upstreamFail.body).error.message, /401/)

  const wrongMethod = fakeResponse()
  await createBalanceRoute({
    resolveAccount: async () => ({ ref: 'CODEARTS_ACCOUNT_AAA111', credential: { access_key_id: 'ak', secret_access_key: 'sk' } }),
    fetchBalance: async () => ({ ok: true, balance: {} }),
    readCheckin: () => ({ enabled: true, lastDate: '', lastResult: '', lastAt: 0, channels: [] }),
  })(fakeReq('POST', '/api/dsh-ofm-huawei-codearts/balance'), wrongMethod)
  assert.equal(wrongMethod.status, 405)
})

test('isCredentialExpiredMessage detects expired-token failures only', () => {
  assert.equal(isCredentialExpiredMessage('HTTP 400：APIG.0602 Bad request: the security token has expired'), true)
  assert.equal(isCredentialExpiredMessage('HTTP 401'), true)
  assert.equal(isCredentialExpiredMessage('credential has expired'), true)
  assert.equal(isCredentialExpiredMessage('HTTP 500：internal error'), false)
  assert.equal(isCredentialExpiredMessage('账户信息查询失败：HTTP 400：APIG.0602'), true)
  assert.equal(isCredentialExpiredMessage(undefined), false)
})

test('balance route refreshes the credential once when the token expired', async () => {
  let refreshes = 0
  const attempts = []
  const res = fakeResponse()
  const handler = createBalanceRoute({
    resolveAccount: async () => ({ ref: 'r1', credential: { access_key_id: 'old' } }),
    refreshAccount: async account => {
      refreshes += 1
      assert.equal(account.ref, 'r1')
      return { ref: 'r1', credential: { access_key_id: 'new' } }
    },
    fetchBalance: async credential => {
      attempts.push(credential.access_key_id)
      if (credential.access_key_id === 'old') {
        return { ok: false, message: 'HTTP 400：APIG.0602 the security token has expired' }
      }
      return { ok: true, balance: { total: { amount: 1, used: 0, remain: 1, expiring: 0 } } }
    },
    readCheckin: () => ({ enabled: true, lastDate: '2026-10-30', lastResult: 'x', lastAt: 1, channels: [] }),
  })
  await handler(fakeReq('GET', '/api/dsh-ofm-huawei-codearts/balance'), res)
  assert.equal(res.status, 200)
  assert.equal(refreshes, 1)
  assert.deepEqual(attempts, ['old', 'new'])
  assert.equal(JSON.parse(res.body).balance.total.remain, 1)
})

test('fetchCodeArtsCreditBalance exposes the package cycle dates', async () => {
  const { fetchCodeArtsCreditBalance } = await import('../src/auto-checkin.js')
  const fetcher = async () => new Response(JSON.stringify({
    metrics: [
      { name: 'usageTotalPackageCredit', package_credit_amount: 20600, package_credit_used: 1, package_credit_remain: 20599, package_credit_expiring_amount: 0 },
    ],
    package: { is_credit_package: true, is_token_package: false, package_name_cn: '体验版', status: 'normal' },
    start_date: '2026-10-07',
    end_date: '2026-11-08',
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const result = await fetchCodeArtsCreditBalance(
    { access_key_id: 'ak', secret_access_key: 'sk', security_token: 'st' },
    { sign: async () => new Map(), fetcher },
  )
  assert.equal(result.ok, true)
  assert.equal(result.balance.cycle.startDate, '2026-10-07')
  assert.equal(result.balance.cycle.endDate, '2026-11-08')
  assert.equal(result.balance.total.remain, 20599)
  assert.equal(result.balance.packageName, '体验版')
})
