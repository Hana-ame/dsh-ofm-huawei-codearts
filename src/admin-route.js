/**
 * 设置页管理路由的组装：同一个前缀下按路径分发给 balance / login 两个处理器。
 *
 * 必须合成**一个** `webServer.register`（而不是注册两个重叠前缀），否则
 * `/api/dsh-ofm-huawei-codearts/login` 可能先命中 balance 处理器并 404。
 */

import { createBalanceRoute } from './balance-route.js'
import { createLoginRoute } from './login-route.js'

export function createAdminRoute(deps) {
  const balance = createBalanceRoute(deps.balanceDeps)
  const login = createLoginRoute(deps.loginDeps)
  return async function handler(req, res) {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/+$/, '')
    if (pathname.endsWith('/login') || pathname.endsWith('/login/status')) {
      return login(req, res)
    }
    return balance(req, res)
  }
}
