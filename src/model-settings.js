/**
 * CodeArts 模型的本地覆盖表（设置页「模型与图片能力」）。
 *
 * ## 为什么需要
 *
 * 适配器对**所有**模型硬编码 `inputModalities: ['text']`（旧代码见
 * `llm-adapter.ts` 的 `listModels` / `prepareCall`），于是设置页没有入口把某个
 * 模型标成「可读图」——DSH 因此把历史里的图片投影成占位文字，图片永远发不出去。
 * 本模块给设置页提供一份可持久化的 per-model 覆盖表：名称、上下文窗口、最大
 * 输出、以及**文字/图片**两种输入模态。
 *
 * ## 与远端目录的关系（只存"差异"）
 *
 * 华为云模型目录每 2 小时刷新一次（`MODEL_REFRESH_INTERVAL_MS`）。若像 keypool
 * 插件那样把整张表写进设置文件，上游新增模型就永远看不见了。因此这里只落
 * **与目录不同的行** + **目录里没有的行** + **被显式移除的 id**：
 *
 *     models.json
 *       overrides: [ { id, name?, contextWindow?, maxOutput?, inputModalities? } ]  // 差异/新增
 *       removed:   [ id, ... ]                                                     // 显式移除
 *
 * 未改动的目录行不入库，上游改了名字/窗口就自动跟随。
 *
 * ## 落盘
 *
 * `$DSH_HOME/dsh-ofm-huawei-codearts/models.json`（可用 `CODEARTS_MODELS_FILE`
 * 覆盖），原子写 + 0600；文件缺失/损坏一律按"没有覆盖"处理，不影响启动。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * @typedef {'text' | 'image'} InputModality
 * @typedef {{ id: string, name: string, contextWindow?: number, maxOutput?: number }} CatalogModel
 * @typedef {{ id: string, name: string, contextWindow?: number, maxOutput?: number, inputModalities: InputModality[] }} EffectiveModel
 * @typedef {{ id: string, name?: string, contextWindow?: number, maxOutput?: number, inputModalities?: InputModality[] }} ModelOverride
 * @typedef {{ version: 1, overrides: ModelOverride[], removed: string[], updatedAt: string }} ModelSettings
 */

const DSH_HOME_DIR = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

/** 默认落盘位置。 */
export const DEFAULT_MODELS_FILE = path.join(DSH_HOME_DIR, 'dsh-ofm-huawei-codearts', 'models.json')

/** 当前生效的覆盖表路径（`CODEARTS_MODELS_FILE` 优先）。 */
export function modelsSettingsPath() {
  const fromEnv = String(process.env.CODEARTS_MODELS_FILE ?? '').trim()
  return fromEnv.length > 0 ? fromEnv : DEFAULT_MODELS_FILE
}

/** @returns {ModelSettings} */
export function emptyModelSettings() {
  return { version: 1, overrides: [], removed: [], updatedAt: new Date().toISOString() }
}

/**
 * 归一化模态列表：`text` 恒在，去掉重复与未知值。
 *
 * @param {unknown} value
 * @returns {InputModality[]}
 */
export function normalizeModalities(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  /** @type {InputModality[]} */
  const out = ['text']
  for (const entry of list) {
    if (String(entry).trim().toLowerCase() === 'image' && !out.includes('image')) out.push('image')
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function positiveInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

/**
 * 归一化一行（供设置页提交与读盘共用）；无有效 id 返回 undefined。
 *
 * @param {unknown} entry
 * @returns {ModelOverride | undefined}
 */
export function normalizeModelRow(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const raw = /** @type {Record<string, unknown>} */ (entry)
  const id = String(raw.id ?? '').trim()
  if (id === '' || id.length > 200) return undefined
  /** @type {ModelOverride} */
  const override = { id }
  const name = String(raw.name ?? '').trim()
  if (name !== '') override.name = name.slice(0, 200)
  const contextWindow = positiveInteger(raw.contextWindow)
  if (contextWindow !== undefined) override.contextWindow = contextWindow
  const maxOutput = positiveInteger(raw.maxOutput)
  if (maxOutput !== undefined) override.maxOutput = maxOutput
  if (raw.inputModalities !== undefined) override.inputModalities = normalizeModalities(raw.inputModalities)
  return override
}

/**
 * 读盘并归一化；任何异常都退化为"没有覆盖"。
 *
 * @param {string} [file]
 * @returns {ModelSettings}
 */
export function readModelSettings(file = modelsSettingsPath()) {
  try {
    const parsed = /** @type {Record<string, unknown> | null} */ (JSON.parse(fs.readFileSync(file, 'utf8')))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyModelSettings()
    const seen = new Set()
    /** @type {ModelOverride[]} */
    const overrides = []
    for (const raw of Array.isArray(parsed.overrides) ? parsed.overrides : []) {
      const normalized = normalizeModelRow(raw)
      if (normalized === undefined || seen.has(normalized.id)) continue
      seen.add(normalized.id)
      overrides.push(normalized)
    }
    const removed = [
      ...new Set(
        (Array.isArray(parsed.removed) ? parsed.removed : [])
          .map(value => String(value ?? '').trim())
          .filter(value => value !== '' && !seen.has(value)),
      ),
    ]
    return {
      version: 1,
      overrides,
      removed,
      updatedAt: String(parsed.updatedAt ?? ''),
    }
  } catch {
    return emptyModelSettings()
  }
}

/**
 * 原子写（临时文件 + rename，0600）。
 *
 * @param {ModelSettings} settings
 * @param {string} [file]
 */
export function writeModelSettings(settings, file = modelsSettingsPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

/**
 * 删除覆盖表（恢复纯目录行为）。
 *
 * @param {string} [file]
 */
export function clearModelSettings(file = modelsSettingsPath()) {
  try {
    fs.rmSync(file, { force: true })
  } catch {
    // 文件不存在/无权限都不影响"回到目录默认"的语义
  }
}

/** @type {{ file: string, mtimeMs: number, settings: ModelSettings } | undefined} */
let cache

/**
 * 读缓存：适配器每次 `listModels`/`resolveModel` 都会调用，按 mtime 失效，
 * 所以设置页保存后**无需重启**即可生效。
 *
 * @param {string} [file]
 * @returns {ModelSettings}
 */
export function cachedModelSettings(file = modelsSettingsPath()) {
  let mtimeMs = -1
  try {
    mtimeMs = fs.statSync(file).mtimeMs
  } catch {
    mtimeMs = -1
  }
  if (cache !== undefined && cache.file === file && cache.mtimeMs === mtimeMs) return cache.settings
  const settings = readModelSettings(file)
  cache = { file, mtimeMs, settings }
  return settings
}

/** 测试/保存后主动失效缓存。 */
export function invalidateModelSettingsCache() {
  cache = undefined
}

/**
 * 把覆盖表应用到目录上：先按目录顺序输出（覆盖字段生效、`removed` 过滤），
 * 再追加目录里没有的覆盖行（设置页手动新增的模型，例如视觉模型）。
 *
 * @param {readonly CatalogModel[]} catalog
 * @param {ModelSettings} settings
 * @returns {EffectiveModel[]}
 */
export function applyModelSettings(catalog, settings) {
  const removed = new Set(settings.removed)
  const overrideById = new Map(settings.overrides.map(override => [override.id, override]))
  const seen = new Set()
  /** @type {EffectiveModel[]} */
  const out = []
  for (const row of catalog) {
    const id = String(row?.id ?? '').trim()
    if (id === '' || removed.has(id) || seen.has(id)) continue
    seen.add(id)
    const override = overrideById.get(id)
    const contextWindow = override?.contextWindow ?? row.contextWindow
    const maxOutput = override?.maxOutput ?? row.maxOutput
    out.push({
      id,
      name: override?.name ?? String(row.name ?? id),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutput !== undefined ? { maxOutput } : {}),
      inputModalities: override?.inputModalities ?? ['text'],
    })
  }
  for (const override of settings.overrides) {
    if (seen.has(override.id) || removed.has(override.id)) continue
    seen.add(override.id)
    out.push({
      id: override.id,
      name: override.name ?? override.id,
      ...(override.contextWindow !== undefined ? { contextWindow: override.contextWindow } : {}),
      ...(override.maxOutput !== undefined ? { maxOutput: override.maxOutput } : {}),
      inputModalities: override.inputModalities ?? ['text'],
    })
  }
  return out
}

/**
 * @param {readonly InputModality[]} left
 * @param {readonly InputModality[]} right
 */
function sameModalities(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * 由设置页提交的「完整有效表」反推覆盖表。
 *
 * 规则：与目录完全一致的行**不入库**（上游更新自动跟随）；不同的行存**差异
 * 字段**；目录里没有的 id 整行入库；`removedIds` 由客户端显式给出（它知道自己
 * 删了哪几行）——服务端不猜，避免"目录刷新后多出的模型被误删"。
 *
 * @param {readonly CatalogModel[]} catalog
 * @param {readonly unknown[]} submitted
 * @param {readonly unknown[]} [removedIds]
 * @returns {ModelSettings}
 */
export function diffModelSettings(catalog, submitted, removedIds = []) {
  /** @type {Map<string, CatalogModel>} */
  const catalogById = new Map()
  for (const row of catalog) {
    const id = String(row?.id ?? '').trim()
    if (id !== '') catalogById.set(id, row)
  }
  const removed = [
    ...new Set(
      removedIds
        .map(value => String(value ?? '').trim())
        .filter(value => value !== ''),
    ),
  ]
  /** @type {ModelOverride[]} */
  const overrides = []
  for (const raw of submitted) {
    const row = normalizeModelRow(raw)
    if (row === undefined || removed.includes(row.id)) continue
    const base = catalogById.get(row.id)
    if (base === undefined) {
      overrides.push({ ...row, inputModalities: row.inputModalities ?? ['text'] })
      continue
    }
    const baseName = String(base.name ?? base.id)
    /** @type {ModelOverride} */
    const diff = { id: row.id }
    if (row.name !== undefined && row.name !== baseName) diff.name = row.name
    if (row.contextWindow !== undefined && row.contextWindow !== base.contextWindow) {
      diff.contextWindow = row.contextWindow
    }
    if (row.maxOutput !== undefined && row.maxOutput !== base.maxOutput) diff.maxOutput = row.maxOutput
    if (row.inputModalities !== undefined && !sameModalities(row.inputModalities, ['text'])) {
      diff.inputModalities = row.inputModalities
    }
    if (Object.keys(diff).length > 1) overrides.push(diff)
  }
  return { version: 1, overrides, removed, updatedAt: new Date().toISOString() }
}