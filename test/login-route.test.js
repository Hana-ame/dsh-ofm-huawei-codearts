import test from 'node:test'
import assert from 'node:assert/strict'
import { createLoginRoute } from '../src/login-route.js'
import { createAdminRoute } from '../src/admin-route.js'

function fakeResponse() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(body) { this.body = body },
  }
}

function fakeReq(method, url) {
  return { method, url }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('login route starts a two-step flow and reports status', async () => {
  const pending = deferred()
  const handler = createLoginRoute({
    startLogin: async () => ({ loginUrl: 'https://portal.example/authorize?port=12345', result: pending.promise }),
  })
  const post = fakeResponse()
  await handler(fakeReq('POST', '/api/dsh-ofm-huawei-codearts/login'), post)
  assert.equal(post.status, 200)
  const started = JSON.parse(post.body)
  assert.equal(started.state, 'pending')
  assert.match(started.url, /portal\.example\/authorize/)

  const status1 = fakeResponse()
  await handler(fakeReq('GET', '/api/dsh-ofm-huawei-codearts/login/status'), status1)
  assert.equal(JSON.parse(status1.body).state, 'pending')

  pending.resolve({ access: '{}', expires: Date.now() + 1000 })
  await new Promise(resolve => setTimeout(resolve, 0))
  const status2 = fakeResponse()
  await handler(fakeReq('GET', '/api/dsh-ofm-huawei-codearts/login/status'), status2)
  assert.equal(JSON.parse(status2.body).state, 'succeeded')
})

test('login route reports failures and reuses a pending flow', async () => {
  const pending = deferred()
  let starts = 0
  const handler = createLoginRoute({
    startLogin: async () => {
      starts += 1
      return { loginUrl: 'https://portal.example/authorize', result: pending.promise }
    },
  })
  const first = fakeResponse()
  await handler(fakeReq('POST', '/api/dsh-ofm-huawei-codearts/login'), first)
  const second = fakeResponse()
  await handler(fakeReq('POST', '/api/dsh-ofm-huawei-codearts/login'), second)
  assert.equal(starts, 1, 'pending flow must be reused')

  pending.reject(new Error('user cancelled'))
  await new Promise(resolve => setTimeout(resolve, 0))
  const status = fakeResponse()
  await handler(fakeReq('GET', '/api/dsh-ofm-huawei-codearts/login/status'), status)
  const payload = JSON.parse(status.body)
  assert.equal(payload.state, 'failed')
  assert.match(payload.message, /user cancelled/)

  const unknown = fakeResponse()
  await handler(fakeReq('DELETE', '/api/dsh-ofm-huawei-codearts/login'), unknown)
  assert.equal(unknown.status, 404)
})

test('admin route dispatches balance and login paths to the right handler', async () => {
  const handler = createAdminRoute({
    balanceDeps: {
      resolveAccount: async () => undefined,
      fetchBalance: async () => ({ ok: true, balance: {} }),
      readCheckin: () => ({ enabled: true, lastDate: '', lastResult: '', lastAt: 0, channels: [] }),
    },
    loginDeps: {
      startLogin: async () => ({ loginUrl: 'https://portal.example/authorize', result: Promise.resolve({}) }),
    },
  })
  const balance = fakeResponse()
  await handler(fakeReq('GET', '/api/dsh-ofm-huawei-codearts/balance'), balance)
  assert.equal(balance.status, 503) // 无凭据 → balance 分支

  const login = fakeResponse()
  await handler(fakeReq('POST', '/api/dsh-ofm-huawei-codearts/login'), login)
  assert.equal(login.status, 200)
  assert.equal(JSON.parse(login.body).state, 'pending')
})
