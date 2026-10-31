/**
 * 设置页管理路由的组装：同一个前缀下按路径分发给 balance / login / models 三个处理器。
 *
 * 必须合成**一个** `webServer.register`（而不是注册两个重叠前缀），否则
 * `/api/dsh-ofm-huawei-codearts/login` 可能先命中 balance 处理器并 404。
 */

import { createBalanceRoute } from './balance-route.js'
import { createLoginRoute } from './login-route.js'
import { createModelsRoute } from './models-route.js'

export function createAdminRoute(deps) {
  const balance = createBalanceRoute(deps.balanceDeps)
  const login = createLoginRoute(deps.loginDeps)
  const models = deps.modelsDeps === undefined ? null : createModelsRoute(deps.modelsDeps)
  return async function handler(req, res) {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/+$/, '')
    if (pathname.endsWith('/login') || pathname.endsWith('/login/status')) {
      return login(req, res)
    }
    if (models !== null && pathname.endsWith('/models')) {
      return models(req, res)
    }
    return balance(req, res)
  }
}
