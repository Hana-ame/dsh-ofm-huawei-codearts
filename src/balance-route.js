/**
 * 设置页「华为云 CodeArts」栏目的数据路由。
 *
 * `GET /api/dsh-ofm-huawei-codearts/balance` →
 *   { ok: true, balance, checkin, today }
 *
 * 依赖注入（便于单测；真实接线见 src/index.ts）：
 *   - resolveCredential(): Promise<credential | undefined>
 *   - fetchBalance(credential): Promise<{ ok: true, balance } | { ok: false, message }>
 *   - readCheckin(): auto-checkin 文档（enabled/lastDate/lastResult/lastAt/channels）
 *
 * 只返回余额与签到状态；AK/SK 始终留在服务端。
 */

import { utc8DateString } from './auto-checkin.js'

/**
 * 判断失败是否由「临时令牌/凭据过期」引起。
 *
 * CodeArts 的 STS 临时令牌寿命约 1 小时，过期后签名请求返回
 * HTTP 400/401/403，报文含 `security token has expired`（APIG.0602）等。
 * 这类错误刷新一次凭据后通常即可成功，因此路由与签到都做一次重试。
 */
export function isCredentialExpiredMessage(message) {
  if (typeof message !== 'string') return false
  return /security token|token has expired|token expired|credential.*(expired|invalid)|APIG\.0602|HTTP (400|401|403)\b/i.test(message)
}

export function createBalanceRoute(deps) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const send = (status, body) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(body))
    }

    if (req.method !== 'GET') {
      send(405, { ok: false, error: { message: 'method not allowed' } })
      return
    }
    if (!url.pathname.replace(/\/+$/, '').endsWith('/balance')) {
      send(404, { ok: false, error: { message: 'not found' } })
      return
    }

    try {
      const account = await deps.resolveAccount()
      if (account === undefined || account === null) {
        send(503, { ok: false, error: { message: '没有可用的 CodeArts 凭据' } })
        return
      }
      let result = await deps.fetchBalance(account.credential)
      if (!result?.ok && typeof deps.refreshAccount === 'function' && isCredentialExpiredMessage(result.message)) {
        // 令牌过期：刷新一次后重试（与 LLM 适配器的 401 兜底同策略）。
        const refreshed = await deps.refreshAccount(account)
        if (refreshed !== undefined && refreshed !== null) result = await deps.fetchBalance(refreshed.credential)
      }
      if (!result?.ok) {
        send(502, { ok: false, error: { message: result?.message ?? '余额查询失败' } })
        return
      }
      const checkin = deps.readCheckin()
      send(200, {
        ok: true,
        balance: result.balance,
        checkin: {
          enabled: checkin.enabled,
          lastDate: checkin.lastDate,
          lastResult: checkin.lastResult,
          lastAt: checkin.lastAt,
          channels: checkin.channels,
        },
        today: utc8DateString(),
      })
    } catch (error) {
      send(500, { ok: false, error: { message: error instanceof Error ? error.message : String(error) } })
    }
  }
}
