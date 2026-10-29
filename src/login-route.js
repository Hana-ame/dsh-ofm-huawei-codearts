/**
 * 设置页「重新登录 CodeArts」的数据路由。
 *
 * 为什么需要它：CodeArts 的 STS 临时令牌约 1–2 小时寿命，refresh_token 是
 * **一次性的**（换新后旧的立即失效）。一旦 refresh_token 被消费/失效，
 * 凭据无法静默续期，只能重新走一遍 portal OAuth 授权。设置页给一个按钮，
 * 用户点一下就能恢复，不必重装插件或跑脚本。
 *
 * 路由（与 balance 共用前缀 `/api/dsh-ofm-huawei-codearts`）：
 *   POST /login         起一次两步式登录，返回 { state, url }
 *   GET  /login/status  查询登录状态 { state, message }
 *
 * state: 'idle' | 'pending' | 'succeeded' | 'failed'
 *
 * 前端拿到 url 后必须**立即** `window.open(url)`（浏览器 transient activation
 * 大约只有 5 秒，见 src/service.ts 的 startLogin 注释），随后轮询 status。
 */

export function createLoginRoute(deps) {
  /** 当前登录流程（进程内单例；同一时间只允许一个）。 */
  let flow = null

  async function startLogin() {
    if (flow !== null && flow.state === 'pending') return flow
    flow = { state: 'pending', url: '', message: '' }
    let started
    try {
      started = await deps.startLogin()
    } catch (error) {
      flow = { state: 'failed', url: '', message: error instanceof Error ? error.message : String(error) }
      return flow
    }
    flow.url = started.loginUrl
    const url = started.loginUrl
    started.result.then(
      () => {
        flow = { state: 'succeeded', url, message: '' }
      },
      error => {
        flow = { state: 'failed', url, message: error instanceof Error ? error.message : String(error) }
      },
    )
    return flow
  }

  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname.replace(/\/+$/, '')
    const send = (status, body) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(body))
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }

    if (req.method === 'POST' && pathname.endsWith('/login')) {
      const current = await startLogin()
      send(200, { ok: true, state: current.state, url: current.url, message: current.message })
      return
    }

    if (req.method === 'GET' && pathname.endsWith('/login/status')) {
      send(200, {
        ok: true,
        state: flow?.state ?? 'idle',
        message: flow?.message ?? '',
      })
      return
    }

    send(404, { ok: false, error: { message: 'not found' } })
  }
}
