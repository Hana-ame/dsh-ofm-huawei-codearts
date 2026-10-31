/**
 * 设置页「模型与图片能力」的数据路由。
 *
 *   GET  /api/dsh-ofm-huawei-codearts/models   → 目录 + 覆盖后的有效模型表
 *   POST /api/dsh-ofm-huawei-codearts/models   → 保存（只写差异）
 *
 * 依赖注入（真实接线见 src/index.ts）：
 *   - getCatalog(): Promise<CatalogModel[]> | CatalogModel[]  华为云目录（原始值）
 *   - settingsPath(): string                                  覆盖表落盘位置
 *
 * 写路径是**回环限定**的：模型能力会改变请求体形状（是否携带 base64 图片），
 * 不能让非本机调用方改写。GET 也一并限回环，省得把目录细节暴露给代理后面的
 * 陌生调用方。
 */
import {
  applyModelSettings,
  clearModelSettings,
  diffModelSettings,
  invalidateModelSettingsCache,
  normalizeModalities,
  readModelSettings,
  writeModelSettings,
} from './model-settings.js'

const MAX_BODY_BYTES = 1024 * 1024

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function sendError(res, status, message, code = 'BAD_REQUEST') {
  sendJson(res, status, { ok: false, error: { message, code } })
}

function isLoopback(req) {
  const address = String(req.socket?.remoteAddress ?? '')
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body exceeds 1 MiB')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed
}

/** 组装 GET/POST 共用的响应体。 */
function snapshot(catalog, settings, settingsPath) {
  const models = applyModelSettings(catalog, settings)
  return {
    ok: true,
    settingsPath,
    models,
    // 诊断用：哪些目录模型被改过、哪些被移除、有哪些是目录里没有的新增行
    overridden: settings.overrides.map(override => override.id),
    removed: [...settings.removed],
    catalogIds: catalog.map(row => String(row?.id ?? '')).filter(id => id !== ''),
  }
}

export function createModelsRoute(deps) {
  return async function handler(req, res) {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/+$/, '')
    if (!pathname.endsWith('/models')) {
      sendError(res, 404, 'not found', 'NOT_FOUND')
      return
    }
    if (!isLoopback(req)) {
      sendError(res, 403, 'models settings route is loopback-only', 'FORBIDDEN')
      return
    }

    const settingsPath = String(deps.settingsPath?.() ?? '')
    try {
      const catalog = await deps.getCatalog()

      if (req.method === 'GET') {
        sendJson(res, 200, snapshot(catalog, readModelSettings(settingsPath), settingsPath))
        return
      }

      if (req.method !== 'POST') {
        sendError(res, 405, 'method not allowed', 'METHOD_NOT_ALLOWED')
        return
      }

      const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase()
      if (!contentType.startsWith('application/json')) {
        throw new Error('content-type must be application/json')
      }
      const body = await readBody(req)

      if (body.reset === true) {
        clearModelSettings(settingsPath)
        invalidateModelSettingsCache()
        sendJson(res, 200, snapshot(catalog, readModelSettings(settingsPath), settingsPath))
        return
      }

      if (!Array.isArray(body.models)) throw new Error('models must be an array')
      if (body.models.length > 500) throw new Error('models must not exceed 500 rows')
      const removed = Array.isArray(body.removed) ? body.removed : []
      const settings = diffModelSettings(catalog, body.models, removed)
      // 兜底：提交的行里 modalities 必须已归一化（diff 已做），此处再验一次
      for (const override of settings.overrides) {
        if (override.inputModalities !== undefined) {
          override.inputModalities = normalizeModalities(override.inputModalities)
        }
      }
      writeModelSettings(settings, settingsPath)
      invalidateModelSettingsCache()
      sendJson(res, 200, snapshot(catalog, readModelSettings(settingsPath), settingsPath))
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error))
    }
  }
}