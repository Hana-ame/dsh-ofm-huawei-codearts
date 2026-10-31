import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyModelSettings,
  cachedModelSettings,
  diffModelSettings,
  invalidateModelSettingsCache,
  normalizeModalities,
  readModelSettings,
  writeModelSettings,
} from '../src/model-settings.js'

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codearts-models-')), 'models.json')
}

const CATALOG = [
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 202752 },
  { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', contextWindow: 1000000 },
]

test('modalities are normalized with text always present', () => {
  assert.deepEqual(normalizeModalities(undefined), ['text'])
  assert.deepEqual(normalizeModalities(['image']), ['text', 'image'])
  assert.deepEqual(normalizeModalities(['text', 'image', 'image', 'bogus']), ['text', 'image'])
  assert.deepEqual(normalizeModalities('image'), ['text', 'image'])
})

test('an override flips one model to image without touching the rest', () => {
  const settings = {
    version: 1,
    overrides: [{ id: 'glm-5.2', inputModalities: ['text', 'image'] }],
    removed: [],
    updatedAt: '',
  }
  const effective = applyModelSettings(CATALOG, settings)
  assert.deepEqual(effective.map(m => m.id), ['glm-5.2', 'deepseek-v4.1-flash'])
  assert.deepEqual(effective[0].inputModalities, ['text', 'image'])
  assert.equal(effective[0].contextWindow, 202752)
  assert.deepEqual(effective[1].inputModalities, ['text'])
})

test('catalog rows not present upstream are appended, removed rows are filtered', () => {
  const settings = {
    version: 1,
    overrides: [
      { id: 'glm-4.5v', name: 'GLM-4.5V', contextWindow: 131072, inputModalities: ['text', 'image'] },
      { id: 'glm-5.2', name: 'GLM-5.2 改名', inputModalities: ['text', 'image'] },
    ],
    removed: ['deepseek-v4.1-flash'],
    updatedAt: '',
  }
  const effective = applyModelSettings(CATALOG, settings)
  assert.deepEqual(effective.map(m => m.id), ['glm-5.2', 'glm-4.5v'])
  assert.equal(effective[0].name, 'GLM-5.2 改名')
  assert.equal(effective[1].contextWindow, 131072)
})

test('diffModelSettings stores only rows that differ from the catalog', () => {
  const submitted = [
    { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 202752, inputModalities: ['text'] },
    { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', contextWindow: 1000000, inputModalities: ['text', 'image'] },
    { id: 'glm-4.5v', name: 'GLM-4.5V', contextWindow: 131072, inputModalities: ['text', 'image'] },
  ]
  const settings = diffModelSettings(CATALOG, submitted, [])
  // 未改动的 glm-5.2 不落盘；改过的图标 image；目录里没有的整行入库
  assert.deepEqual(settings.overrides, [
    { id: 'deepseek-v4.1-flash', inputModalities: ['text', 'image'] },
    { id: 'glm-4.5v', name: 'GLM-4.5V', contextWindow: 131072, inputModalities: ['text', 'image'] },
  ])
  assert.deepEqual(settings.removed, [])
})

test('diffModelSettings keeps name/window diffs and honours explicit removals', () => {
  const settings = diffModelSettings(
    CATALOG,
    [
      { id: 'glm-5.2', name: 'GLM-5.2 视觉版', contextWindow: 262144, maxOutput: 8192, inputModalities: ['text', 'image'] },
    ],
    ['deepseek-v4.1-flash'],
  )
  assert.deepEqual(settings.overrides, [
    { id: 'glm-5.2', name: 'GLM-5.2 视觉版', contextWindow: 262144, maxOutput: 8192, inputModalities: ['text', 'image'] },
  ])
  assert.deepEqual(settings.removed, ['deepseek-v4.1-flash'])
})

test('settings round-trip through disk with 0600 and tolerate corrupt files', () => {
  const file = tempFile()
  writeModelSettings({
    version: 1,
    overrides: [{ id: 'glm-5.2', inputModalities: ['text', 'image'] }],
    removed: ['deepseek-v4.1-flash'],
    updatedAt: '2026-10-31T00:00:00.000Z',
  }, file)
  const read = readModelSettings(file)
  assert.deepEqual(read.overrides, [{ id: 'glm-5.2', inputModalities: ['text', 'image'] }])
  assert.deepEqual(read.removed, ['deepseek-v4.1-flash'])
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)

  fs.writeFileSync(file, '{ not json')
  assert.deepEqual(readModelSettings(file).overrides, [])
})

test('an id in both overrides and removed is dropped from removed', () => {
  const file = tempFile()
  fs.writeFileSync(file, JSON.stringify({
    overrides: [{ id: 'glm-5.2', inputModalities: ['text', 'image'] }],
    removed: ['glm-5.2', 'deepseek-v4.1-flash', ''],
  }))
  const read = readModelSettings(file)
  assert.deepEqual(read.removed, ['deepseek-v4.1-flash'])
})

test('cachedModelSettings follows the file mtime', () => {
  const file = tempFile()
  invalidateModelSettingsCache()
  writeModelSettings({ version: 1, overrides: [], removed: [], updatedAt: '' }, file)
  assert.deepEqual(cachedModelSettings(file).overrides, [])
  writeModelSettings({
    version: 1,
    overrides: [{ id: 'glm-5.2', inputModalities: ['text', 'image'] }],
    removed: [],
    updatedAt: '',
  }, file)
  assert.deepEqual(cachedModelSettings(file).overrides.map(o => o.id), ['glm-5.2'])
})