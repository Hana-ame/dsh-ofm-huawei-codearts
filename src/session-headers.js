import { createHash } from 'node:crypto'

/**
 * CodeArts 的「会话头」：后端按**会话**维度统计并发（TM.00001041
 * 「并发会话数已达上限」）。
 *
 * 实测来源：CodeArts Agent IDE 内核（vscode-codebot 26.10.2 的
 * agentkernelServer）在 `/chat/completions` 请求上发送
 * `user-session-id` / `x-ot-session-id` / `x-ot-parent-session-id`
 * 等头，值来自客户端会话身份。旧适配器只发 `Chat-Id`/`Session-Id`
 * （另一套网关方言），且**所有请求共用同一个随机 id** —— 反代场景下
 * 后端会话计数与请求对不上，几次并发就把「2 个会话」额度打满，
 * 表现为 TM.00001041 排队/限流。
 *
 * 修复：把 DSH 的 `GenerateOptions.sessionId`（loop 标记的会话身份）
 * 哈希成 32 位 hex 作为会话头，使同一 DSH 会话的请求归并到一个
 * CodeArts 会话，不同会话互不挤占。缺省（无会话上下文）时回落到
 * 适配器实例自己的随机 id。
 */
export function codeartsSessionHeaderId(sessionId, fallback) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return fallback
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32)
}

/** 会话头集合：`user-session-id` 为主，其余为 IDE 同款兼容头。 */
export function codeartsSessionHeaders(sessionHeaderId) {
  return {
    'user-session-id': sessionHeaderId,
    'x-ot-session-id': sessionHeaderId,
    // IDE 用 parent-session-id 表示子 agent 归属；单层 DSH 会话留空。
    'x-ot-parent-session-id': '',
    // 旧方言头保留：部分网关版本仍以 Chat-Id/Session-Id 做亲和。
    'Chat-Id': sessionHeaderId,
    'Session-Id': sessionHeaderId,
  }
}
