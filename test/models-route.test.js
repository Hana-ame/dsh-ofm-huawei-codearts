import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createModelsRoute } from '../src/models-route.js'
import { invalidateModelSettingsCache, readModelSettings } from '../src/model-settings.js'

const CATALOG = [
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 202752 },
  { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', contextWindow: 1000000 },
]

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codearts-models-route-')), 'models.json')
}

function invoke(handler, { method = 'GET', url = '/api/dsh-ofm-huawei-codearts/models', body, contentType = 'application/json', address = '127.0.0.1' } = {}) {
  const headers = body === undefined
    ? { accept: 'application/json' }
    : { 'content-type': contentType }
  const req = body === undefined
    ? { method, url, headers, socket: { remoteAddress: address } }
    : Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
        method,
        url,
        headers,
        socket: { remoteAddress: address },
      })
  return new Promise((resolve, reject) => {
    const res = {
      status: 0,
      headers: {},
      text: '',
      writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders },
      end(chunk) { this.text += chunk === undefined ? '' : String(chunk); resolve({ status: this.status, body: JSON.parse(this.text) }) },
    }
    handler(req, res).catch(reject)
  })
}

function routeWith(file) {
  return createModelsRoute({
    getCatalog: async () => CATALOG,
    settingsPath: () => file,
  })
}

test('GET returns the catalog with overrides applied and the file path', async () => {
  const file = tempFile()
  const response = await invoke(routeWith(file))
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.settingsPath, file)
  assert.deepEqual(response.body.models.map(m => m.id), ['glm-5.2', 'deepseek-v4.1-flash'])
  assert.deepEqual(response.body.models.map(m => m.inputModalities), [['text'], ['text']])
  assert.deepEqual(response.body.catalogIds, ['glm-5.2', 'deepseek-v4.1-flash'])
})

test('POST flips one model to image and writes only the diff', async () => {
  const file = tempFile()
  invalidateModelSettingsCache()
  const response = await invoke(routeWith(file), {
    method: 'POST',
    body: {
      models: [
        { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 202752, inputModalities: ['text', 'image'] },
        { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', contextWindow: 1000000, inputModalities: ['text'] },
      ],
    },
  })
  assert.equal(response.status, 200)
  const written = readModelSettings(file)
  assert.deepEqual(written.overrides, [{ id: 'glm-5.2', inputModalities: ['text', 'image'] }])
  assert.deepEqual(response.body.models[0].inputModalities, ['text', 'image'])
  assert.deepEqual(response.body.overridden, ['glm-5.2'])
})

test('POST can add a model that is not in the catalog and remove a catalog row', async () => {
  const file = tempFile()
  invalidateModelSettingsCache()
  const response = await invoke(routeWith(file), {
    method: 'POST',
    body: {
      models: [{ id: 'glm-4.5v', name: 'GLM-4.5V', contextWindow: 131072, inputModalities: ['text', 'image'] }],
      removed: ['deepseek-v4.1-flash'],
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.models.map(m => m.id), ['glm-5.2', 'glm-4.5v'])
  const written = readModelSettings(file)
  assert.deepEqual(written.overrides, [
    { id: 'glm-4.5v', name: 'GLM-4.5V', contextWindow: 131072, inputModalities: ['text', 'image'] },
  ])
  assert.deepEqual(written.removed, ['deepseek-v4.1-flash'])
})

test('POST reset deletes the overrides file', async () => {
  const file = tempFile()
  invalidateModelSettingsCache()
  await invoke(routeWith(file), {
    method: 'POST',
    body: { models: [{ id: 'glm-4.5v', inputModalities: ['text', 'image'] }] },
  })
  assert.equal(fs.existsSync(file), true)
  const response = await invoke(routeWith(file), { method: 'POST', body: { reset: true } })
  assert.equal(response.status, 200)
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(response.body.models.map(m => m.id), ['glm-5.2', 'deepseek-v4.1-flash'])
})

test('write path is loopback-only', async () => {
  const file = tempFile()
  const response = await invoke(routeWith(file), {
    method: 'POST',
    body: { models: [{ id: 'glm-5.2', inputModalities: ['text', 'image'] }] },
    address: '10.0.0.7',
  })
  assert.equal(response.status, 403)
})

test('route rejects a missing JSON content-type, a non-array body and unknown paths', async () => {
  const file = tempFile()
  const handler = routeWith(file)
  const badType = await invoke(handler, { method: 'POST', body: { models: [] }, contentType: 'text/plain' })
  assert.equal(badType.status, 400)
  const badBody = await invoke(handler, { method: 'POST', body: { models: 'nope' } })
  assert.equal(badBody.status, 400)
  const notFound = await invoke(handler, { url: '/api/dsh-ofm-huawei-codearts/whatever' })
  assert.equal(notFound.status, 404)
  const wrongMethod = await invoke(handler, { method: 'DELETE' })
  assert.equal(wrongMethod.status, 405)
})
test('the shared admin prefix dispatches /models to this handler', async () => {
  const { createAdminRoute } = await import('../src/admin-route.js')
  const handler = createAdminRoute({
    balanceDeps: { resolveAccount: async () => undefined, fetchBalance: async () => ({ ok: false }) },
    loginDeps: { startLogin: async () => ({ url: 'https://example.invalid' }) },
    modelsDeps: { getCatalog: async () => CATALOG, settingsPath: () => tempFile() },
  })
  const response = await invoke(handler)
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.deepEqual(response.body.models.map(m => m.id), ['glm-5.2', 'deepseek-v4.1-flash'])
})

test('POST /models/test runs a one-shot hi through the adapter', async () => {
  const file = tempFile()
  const handler = createModelsRoute({
    getCatalog: async () => CATALOG,
    settingsPath: () => file,
    testModel: async model => ({ ok: true, model, latencyMs: 7, text: '你好' }),
  })
  const response = await invoke(handler, {
    method: 'POST',
    url: '/api/dsh-ofm-huawei-codearts/models/test',
    body: { model: 'glm-5.2' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.text, '你好')
  // 测试不得改动覆盖表
  assert.equal(fs.existsSync(file), false)
})

test('POST /models/test validates the model id and stays loopback-only', async () => {
  const file = tempFile()
  const testModel = async model => ({ ok: true, model })
  const handler = createModelsRoute({ getCatalog: async () => CATALOG, settingsPath: () => file, testModel })
  const empty = await invoke(handler, {
    method: 'POST',
    url: '/api/dsh-ofm-huawei-codearts/models/test',
    body: { model: '  ' },
  })
  assert.equal(empty.status, 400)
  const remote = await invoke(handler, {
    method: 'POST',
    url: '/api/dsh-ofm-huawei-codearts/models/test',
    body: { model: 'glm-5.2' },
    address: '10.1.2.3',
  })
  assert.equal(remote.status, 403)
  const get = await invoke(handler, { url: '/api/dsh-ofm-huawei-codearts/models/test' })
  assert.equal(get.status, 405)
})
