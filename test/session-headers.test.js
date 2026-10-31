import test from 'node:test'
import assert from 'node:assert/strict'
import { codeartsSessionHeaderId, codeartsSessionHeaders } from '../src/session-headers.js'

test('session header id is derived per DSH session and stable', () => {
  const a = codeartsSessionHeaderId('session-aaa', 'fallback')
  const a2 = codeartsSessionHeaderId('session-aaa', 'fallback')
  const b = codeartsSessionHeaderId('session-bbb', 'fallback')
  assert.equal(a, a2, '同一会话必须稳定（会话亲和/并发计数依赖它）')
  assert.notEqual(a, b, '不同会话必须不同，否则并行会话会挤占同一并发额度')
  assert.match(a, /^[0-9a-f]{32}$/)
  assert.equal(codeartsSessionHeaderId(undefined, 'fallback'), 'fallback')
  assert.equal(codeartsSessionHeaderId('', 'fallback'), 'fallback')
})

test('session headers carry user-session-id and IDE-compatible aliases', () => {
  const id = codeartsSessionHeaderId('session-aaa', 'fallback')
  const headers = codeartsSessionHeaders(id)
  assert.equal(headers['user-session-id'], id)
  assert.equal(headers['x-ot-session-id'], id)
  assert.equal(headers['x-ot-parent-session-id'], '')
  assert.equal(headers['Chat-Id'], id)
  assert.equal(headers['Session-Id'], id)
})
