/**
 * 图片投影：把 harness 消息里的 `image` 块变成 OpenAI 的 `image_url` data URL。
 *
 * 与 `dsh-sensenova-keypool` 的 `src/messages.js` 同一口径（同一份 DSH 附件
 * 服务 API），单独成模块是为了能直接单测：这段逻辑决定"图片到底发不发出去"，
 * 而它只在设置页把模型标成「图片」后才启用。
 *
 * 降级原则：任何一步拿不到图（没有附件服务 / 附件损坏 / 读取抛错）都只把该图
 * 换成占位文字，**不让整轮请求失败**——用户宁可少一张图，也不该整个 turn 崩掉。
 */

/** 单张图片内联上限兜底（DSH 默认图片预算是 20 MiB）。 */
export const DEFAULT_IMAGE_MAX_BYTES = 20 * 1024 * 1024

/**
 * 为一张持久化图片块构建 data URL。
 *
 * @param {Record<string, unknown>} block - DSH `type:'image'` 块。
 * @param {{ attachments?: { readImageRequest?: Function }, signal?: AbortSignal, maxRequestImageBytes?: number }} deps
 * @returns {Promise<{ url?: string, placeholder?: string }>}
 */
export async function imageUrlOf(block, deps = {}) {
  const attachments = deps.attachments
  if (typeof attachments?.readImageRequest !== 'function') {
    return { placeholder: '[image omitted: attachment service unavailable]' }
  }
  try {
    const request = await attachments.readImageRequest(
      block.attachment,
      {
        width: 1024,
        height: 1024,
        maxBytes: Number(deps.maxRequestImageBytes) > 0
          ? Number(deps.maxRequestImageBytes)
          : DEFAULT_IMAGE_MAX_BYTES,
      },
      deps.signal,
    )
    if (request === undefined || request === null || typeof request.mediaType !== 'string' || request.data === undefined) {
      return { placeholder: '[image omitted: unreadable attachment]' }
    }
    return { url: `data:${request.mediaType};base64,${Buffer.from(request.data).toString('base64')}` }
  } catch (error) {
    return { placeholder: `[image omitted: ${error instanceof Error ? error.message : String(error)}]` }
  }
}

/**
 * 把一份 content 载荷投影成 `{ text, images }`：
 * - `image` 块在 `allowImages !== true` 时**整体丢弃**（文本模型的旧行为）；
 * - 被卸载（`offloaded`）的图片降级为占位文字；
 * - 其余非文本块（`file` 等）不参与。
 *
 * @param {unknown} content - 字符串或块数组。
 * @param {{ attachments?: object, signal?: AbortSignal, maxRequestImageBytes?: number, allowImages?: boolean }} deps
 * @returns {Promise<{ text: string, images: Array<Record<string, unknown>> }>}
 */
export async function userContentOf(content, deps = {}) {
  /** @type {Array<Record<string, unknown>>} */
  const images = []
  if (typeof content === 'string') return { text: content, images }
  if (!Array.isArray(content)) return { text: '', images }
  const text = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const typed = /** @type {{ type?: unknown, text?: unknown, offloaded?: unknown }} */ (block)
    if (typed.type === 'text' && typeof typed.text === 'string' && typed.text !== '') {
      text.push(typed.text)
      continue
    }
    if (typed.type !== 'image') continue
    if (deps.allowImages !== true) continue
    if (typed.offloaded === true) {
      text.push('[image omitted: offloaded]')
      continue
    }
    const resolved = await imageUrlOf(block, deps)
    if (resolved.url !== undefined) images.push({ type: 'image_url', image_url: { url: resolved.url } })
    else if (resolved.placeholder !== undefined) text.push(resolved.placeholder)
  }
  return { text: text.join('\n'), images }
}