import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_IMAGE_MAX_BYTES, imageUrlOf, userContentOf } from '../src/image-projection.js'

function attachmentStore(overrides = {}) {
  const calls = []
  return {
    calls,
    readImageRequest: async (attachment, options, signal) => {
      calls.push({ attachment, options, signal })
      return { mediaType: 'image/png', data: Buffer.from('hi') }
    },
    ...overrides,
  }
}

test('a plain string stays a string', async () => {
  assert.deepEqual(await userContentOf('hello', {}), { text: 'hello', images: [] })
})

test('text + image projects into an OpenAI parts payload when images are allowed', async () => {
  const store = attachmentStore()
  const result = await userContentOf([
    { type: 'text', text: '看图' },
    { type: 'image', attachment: { id: 'a1' } },
  ], { attachments: store, allowImages: true })
  assert.equal(result.text, '看图')
  assert.deepEqual(result.images, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } }])
  assert.equal(store.calls.length, 1)
  assert.deepEqual(store.calls[0].attachment, { id: 'a1' })
  assert.equal(store.calls[0].options.maxBytes, DEFAULT_IMAGE_MAX_BYTES)
})

test('images are dropped for a text-only model (previous behaviour preserved)', async () => {
  const store = attachmentStore()
  const result = await userContentOf([
    { type: 'text', text: '看图' },
    { type: 'image', attachment: { id: 'a1' } },
  ], { attachments: store, allowImages: false })
  assert.equal(result.text, '看图')
  assert.deepEqual(result.images, [])
  assert.equal(store.calls.length, 0)
})

test('an offloaded image becomes placeholder text', async () => {
  const store = attachmentStore()
  const result = await userContentOf([
    { type: 'image', offloaded: true, attachment: { id: 'a1' } },
  ], { attachments: store, allowImages: true })
  assert.equal(result.text, '[image omitted: offloaded]')
  assert.deepEqual(result.images, [])
  assert.equal(store.calls.length, 0)
})

test('a missing attachment service degrades to placeholder text, never throws', async () => {
  const result = await userContentOf([{ type: 'image', attachment: { id: 'a1' } }], { allowImages: true })
  assert.equal(result.text, '[image omitted: attachment service unavailable]')
  assert.deepEqual(result.images, [])
})

test('a failing readImageRequest degrades to placeholder text with the reason', async () => {
  const store = attachmentStore({
    readImageRequest: async () => { throw new Error('attachment gone') },
  })
  const result = await userContentOf([{ type: 'image', attachment: { id: 'a1' } }], { attachments: store, allowImages: true })
  assert.equal(result.text, '[image omitted: attachment gone]')
  assert.deepEqual(result.images, [])
})

test('a custom byte budget is forwarded to the attachment service', async () => {
  const store = attachmentStore()
  await imageUrlOf({ attachment: { id: 'a1' } }, { attachments: store, maxRequestImageBytes: 1024 })
  assert.equal(store.calls[0].options.maxBytes, 1024)
})

test('non-image, non-text blocks are ignored', async () => {
  const result = await userContentOf([
    { type: 'text', text: 'ok' },
    { type: 'file', name: 'x.txt' },
    null,
    'raw',
  ], { allowImages: true })
  assert.equal(result.text, 'ok')
  assert.deepEqual(result.images, [])
})