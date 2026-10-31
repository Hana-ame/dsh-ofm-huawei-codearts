/**
 * 华为云 CodeArts 渠道插件（独立于 dsh-our-free-model）。
 *
 * ## 为什么需要这个插件
 *
 * 上游 `dsh-our-free-model` 从 2.5.9 起删除了华为云 CodeArts 渠道。本插件
 * 不修改上游包的任何字节，而是在 DSH 组合层重新注册一个 provider：
 *
 *     provider id : codearts
 *     显示名      : CodeArts Agent
 *     模型        : GLM、DeepSeek、openPangu 等华为云 CodeArts 目录
 *
 * ## 数据从哪来
 *
 * 账号索引和凭据都是上游 channel-pack 留下的，本插件只读不重建：
 *
 *     $DSH_HOME/channel-pack/state.json   -> 账号 id / enabled / credentialRef
 *     $DSH_HOME/.credentials.yaml         -> CODEARTS_ACCOUNT_* 凭据
 *
 * 不直接使用上游的 AccountPool，是因为上游 2.7.2 的 provider 白名单已经
 * 不含 codearts；它下次保存 state.json 时可能把这条账号过滤掉。直接按 ref
 * 读取凭据，账号索引被重写也不影响本插件。
 *
 * ## 加载顺序
 *
 * 必须排在 `dsh-our-free-model` 之后加载：账号与凭据由它遗留的数据提供。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { CodeArtsAuth } from './service.js'
import { registerCodeArtsLlm, type ImageAttachmentStore } from './llm-adapter.js'
import { createDirectFetch, attachDirectFetch } from './direct-fetch.js'
import { signRequestHuawei } from './sign.js'
import { isCredentialExpiredMessage } from './balance-route.js'
import { createAdminRoute } from './admin-route.js'
import { modelsSettingsPath } from './model-settings.js'
import { fetchCodeArtsRemoteModels, MODEL_REFRESH_INTERVAL_MS } from './models.js'
import {
  claimCodeArtsDailyCheckin,
  createAutoCheckin,
  createFileAutoCheckinStore,
  fetchCodeArtsCreditBalance,
  resolveAutoCheckinHome,
} from './auto-checkin.js'
import type { CodeArtsCredential } from './types.js'

export const name = 'dsh-ofm-huawei-codearts'
export const inject = ['llm', 'credentials']

/** DSH 数据目录；测试或隔离运行时可用 DSH_HOME 覆盖。 */
const DSH_HOME_DIR = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

/** channel-pack 的账号索引文件。 */
const CHANNEL_STATE_FILE = path.join(DSH_HOME_DIR, 'channel-pack', 'state.json')

/** DSH 凭据存储文件（只读取其中的 ref 名字，不读取密钥值）。 */
const CREDENTIAL_STORE_FILE = path.join(DSH_HOME_DIR, '.credentials.yaml')

/** 上游早期使用过的固定凭据 ref，作为最后兜底。 */
const LEGACY_CREDENTIAL_REF = 'CODEARTS_ACCESS_TOKEN'

/** 目录刷新失败后的最小重试间隔：避免设置页每次打开都打一次网络。 */
const CATALOG_MIN_RETRY_MS = 5 * 60_000

/**
 * 从 channel-pack 的 state.json 读取 CodeArts 账号的 credentialRef。
 *
 * 只认 `provider === 'codearts'` 且未停用的账号。文件缺失、JSON 损坏都
 * 只当作“没有”，不影响插件启动。
 */
function credentialRefsFromChannelState(): string[] {
  try {
    const state = JSON.parse(fs.readFileSync(CHANNEL_STATE_FILE, 'utf8')) as {
      accounts?: Array<{ provider?: string; enabled?: boolean; credentialRef?: string }>
    }
    return (state.accounts ?? [])
      .filter(account => account.provider === 'codearts' && account.enabled !== false)
      .map(account => String(account.credentialRef ?? ''))
      .filter(ref => ref.length > 0)
  } catch {
    return []
  }
}

/**
 * 从凭据存储文件里扫描 `CODEARTS_ACCOUNT_*` 形式的 ref。
 *
 * 这是 state.json 被上游重写后的兜底：凭据本身仍然在，只是账号索引没了。
 */
function credentialRefsFromStore(): string[] {
  try {
    const text = fs.readFileSync(CREDENTIAL_STORE_FILE, 'utf8')
    return [...text.matchAll(/\bCODEARTS_ACCOUNT_[0-9A-Fa-f]{6,}\b/g)].map(match => match[0])
  } catch {
    return []
  }
}

/** 按优先级列出所有可能的凭据 ref，并去重。 */
function candidateCredentialRefs(): string[] {
  return [...new Set([
    ...credentialRefsFromChannelState(),
    ...credentialRefsFromStore(),
    LEGACY_CREDENTIAL_REF,
  ])]
}

/**
 * 列出所有可签到的 CodeArts 账号（id / 昵称 / credentialRef）。
 *
 * 优先用 state.json 里的账号索引；索引为空或被上游重写后，退回扫描凭据
 * 存储里的 `CODEARTS_ACCOUNT_*` ref（与 LLM 适配器的兜底策略一致）。
 */
function codeArtsAccounts(): Array<{ id: string; nickname: string; credentialRef: string }> {
  try {
    const state = JSON.parse(fs.readFileSync(CHANNEL_STATE_FILE, 'utf8')) as {
      accounts?: Array<{ id?: string; nickname?: string; provider?: string; enabled?: boolean; credentialRef?: string }>
    }
    const accounts = (state.accounts ?? [])
      .filter(account => account.provider === 'codearts' && account.enabled !== false)
      .map((account, index) => ({
        id: String(account.id ?? `codearts-${index + 1}`),
        nickname: String(account.nickname ?? ''),
        credentialRef: String(account.credentialRef ?? ''),
      }))
      .filter(account => account.credentialRef.length > 0)
    if (accounts.length > 0) return accounts
  } catch {
    // state.json 缺失/损坏：走下面的凭据扫描兜底
  }
  // 凭据 ref 兜底：优先扫 `CODEARTS_ACCOUNT_*`；**一个都没有时**（全新克隆、从没跑过
  // `dsh-our-free-model`：设置页的登录按钮只会写入历史常量 `CODEARTS_ACCESS_TOKEN`）
  // 退回 {@link LEGACY_CREDENTIAL_REF} —— 否则「clone 下来即插即用」的机器上每日签到
  // 会静默不执行（LLM 路径不受影响：它走的 candidateCredentialRefs 本就含该常量）。
  const stored = credentialRefsFromStore()
  return (stored.length > 0 ? stored : [LEGACY_CREDENTIAL_REF]).map((ref, index) => ({
    id: `codearts-store-${index + 1}`,
    nickname: '',
    credentialRef: ref,
  }))
}

/**
 * 逐个 ref 尝试解析，返回第一份可用的 CodeArts 凭据。
 *
 * 判断“可用”的最低要求是 access_key_id + secret_access_key；security_token
 * 由适配器在请求前再校验。
 */
async function resolveCodeArtsCredential(
  ctx: any,
): Promise<{ ref: string; credential: CodeArtsCredential } | undefined> {
  for (const ref of candidateCredentialRefs()) {
    try {
      const resolved = await ctx.credentials.resolve(credentialRef(ref))
      if (!resolved?.value) continue
      const credential = JSON.parse(String(resolved.value)) as CodeArtsCredential
      if (credential.access_key_id && credential.secret_access_key) {
        return { ref, credential }
      }
    } catch {
      // 该 ref 不存在或内容损坏，继续尝试下一个
    }
  }
  return undefined
}

/** 当前首选凭据 ref（设置页「重新登录」写回的目标账号）。 */
function primaryCredentialRef(): string {
  return credentialRefsFromChannelState()[0]
    ?? credentialRefsFromStore()[0]
    ?? LEGACY_CREDENTIAL_REF
}

/** 按 ref 解析并校验一份 CodeArts 凭据（AK/SK 最低要求）。 */
async function credentialByRef(ctx: any, ref: string): Promise<CodeArtsCredential | undefined> {
  try {
    const resolved = await ctx.credentials.resolve(credentialRef(ref))
    if (!resolved?.value) return undefined
    const credential = JSON.parse(String(resolved.value)) as CodeArtsCredential
    if (!credential.access_key_id || !credential.secret_access_key) return undefined
    return credential
  } catch {
    return undefined
  }
}

/** 刷新指定账号的凭据并返回刷新后的凭据；刷新失败返回 undefined。 */
async function refreshCredentialByRef(
  ctx: any,
  codeArtsAuth: CodeArtsAuth,
  ref: string,
): Promise<CodeArtsCredential | undefined> {
  try {
    // 只在服务端已明确判令牌过期时调用，跳过本地 expires_at 预判（force）：
    // 实测本地时间未到、服务端却已吊销的过期是真实存在的。
    await codeArtsAuth.refreshAccountCredential(ref, undefined, undefined, { force: true })
  } catch (error) {
    ctx.logger?.warn?.(`dsh-ofm-huawei-codearts: 刷新凭据失败（${ref}）: ${String(error)}`)
    return undefined
  }
  return credentialByRef(ctx, ref)
}

export function apply(ctx: any): void {
  // 华为请求需要 DPoP/SDK-HMAC 签名，这里使用独立的 undici Agent。
  const transport = createDirectFetch({})
  const detachTransport = attachDirectFetch(transport.fetch)
  ctx.effect(() => () => {
    detachTransport()
    void transport.close()
  })

  const codeArtsAuth = new CodeArtsAuth(ctx, { fetcher: transport.fetch })
  const refCount = candidateCredentialRefs().length
  ctx.logger?.info?.(`dsh-ofm-huawei-codearts: 注册 codearts provider（磁盘上找到 ${refCount} 个凭据 ref）`)

  // 启动首轮强制续期：STS 临时令牌寿命短（约 1 小时），进程启动时磁盘上的
  // 凭据很可能已过期。上游 channel-pack 的调度器也是「启动即刷一轮」；本插件
  // 精简掉了账号池调度器，这里做等价的最小实现（失败只告警，LLM 路径仍有
  // 401 兜底，不影响 provider 注册）。
  for (const ref of candidateCredentialRefs()) {
    void refreshCredentialByRef(ctx, codeArtsAuth, ref)
  }

  const codeArtsLlm = registerCodeArtsLlm(ctx, {
    fetchImpl: transport.fetch,
    // 适配器契约要求一个默认 ref；实际解析走下面的 resolveCredential。
    credentialRef: credentialRef(LEGACY_CREDENTIAL_REF),
    resolveCredential: async () => (await resolveCodeArtsCredential(ctx))?.credential,
    refresh: async () => {
      const found = await resolveCodeArtsCredential(ctx)
      if (found) await codeArtsAuth.refreshAccountCredential(found.ref)
    },
    // 设置页把某个模型标成「图片」后，DSH 会把图片块交给适配器；这里给出
    // 持久化附件服务（web/headless 组合都有），缺失时适配器降级为占位文字。
    resolveAttachments: () => ctx.get('attachments') as ImageAttachmentStore | undefined,
    // 目录懒加载入口（实现在本调用之后：闭包只在 DSH 构建模型目录时被调用，
    // 那时它已初始化）。空数组表示本次没拿到 —— 适配器会回落到静态兜底表。
    fetchRemoteModels: () => loadRemoteModels(),
  })

  // ── 模型目录的自动更新 ────────────────────────────────────────────────
  // 需求（2026-10-31）：目录要自己跟上云端，不能「启动拉一次、重启才更新」。
  //   ① 构建模型目录时按需拉 —— 适配器 `ensureRemoteModels()`
  //      → 上面的 `fetchRemoteModels`
  //   ② 进程常驻期间每 {@link MODEL_REFRESH_INTERVAL_MS}（2h）拉一次 —— 下面的定时器
  //   ③ 设置页每次读取目录时，若已过刷新窗口再拉一次 —— `modelsDeps.getCatalog`
  // 三个入口共用同一个加载器：并发去重 + 成功窗口防抖 + 失败最小重试间隔 +
  // 失败只告警（保留旧目录）。全程只有签名 GET（拉目录不调用模型、不消耗积分）。
  //
  // ⚠️ 为什么必须有个「外部推」的入口：适配器把 provider 目录缓存住之后，
  // DSH 不会再调 `listModels()`，光靠 ① 永远等不到新模型（本轮实测：云端已有
  // `deepseek-v4.1-flash-1017`，本机列表停在首屏那一版）。
  let catalogFetchedAt = 0
  let catalogAttemptAt = 0
  let catalogInFlight: Promise<Array<{ id: string; name: string }>> | undefined

  /** 拉一次云端目录并推给适配器；并发调用共享同一个 Promise，失败返回空数组。 */
  async function loadRemoteModels(): Promise<Array<{ id: string; name: string }>> {
    if (catalogInFlight !== undefined) return catalogInFlight
    catalogAttemptAt = Date.now()
    catalogInFlight = (async () => {
      const found = await resolveCodeArtsCredential(ctx)
      if (found === undefined) return []
      try {
        const models = await fetchCodeArtsRemoteModels(found.credential, transport.fetch)
        if (models.length > 0) {
          codeArtsLlm.setRemoteModels(models)
          catalogFetchedAt = Date.now()
        }
        return models
      } catch (error) {
        ctx.logger?.warn?.(
          `dsh-ofm-huawei-codearts: 刷新模型目录失败（保留旧目录）: `
          + `${error instanceof Error ? error.message : String(error)}`,
        )
        return []
      }
    })().finally(() => { catalogInFlight = undefined })
    return catalogInFlight
  }

  /** 距上次**成功**不足 minIntervalMs、或距上次尝试不足 5 分钟时不重复打网络。 */
  async function refreshCatalogIfStale(minIntervalMs: number): Promise<void> {
    if (Date.now() - catalogFetchedAt < minIntervalMs) return
    if (Date.now() - catalogAttemptAt < CATALOG_MIN_RETRY_MS) return
    await loadRemoteModels()
  }

  const catalogTimer = setInterval(
    () => { void refreshCatalogIfStale(MODEL_REFRESH_INTERVAL_MS) },
    MODEL_REFRESH_INTERVAL_MS,
  )
  ctx.effect(() => () => clearInterval(catalogTimer), 'dsh-ofm-huawei-codearts: model catalog refresh')

  // 每日自动签到：上游 dsh-our-free-model 不再覆盖 codearts 渠道后，这条能力
  // 随渠道一起丢失；这里用同一份 auto-checkin.json 文档恢复，状态与上游
  // 频道面板展示兼容。启动后延迟 30s（避免与续期争抢），今天未签到才执行。
  const autoCheckin = createAutoCheckin({
    store: createFileAutoCheckinStore({
      home: resolveAutoCheckinHome(ctx),
      warn: (message: string) => ctx.logger?.warn?.(message),
    }),
    listAccounts: async () => codeArtsAccounts(),
    resolveCredential: async (ref: string) => {
      try {
        const resolved = await ctx.credentials.resolve(credentialRef(ref))
        if (!resolved?.value) return undefined
        const credential = JSON.parse(String(resolved.value)) as CodeArtsCredential
        if (!credential.access_key_id || !credential.secret_access_key) return undefined
        return credential
      } catch {
        return undefined
      }
    },
    claim: async (credential: CodeArtsCredential, ref: string) => {
      const deps = { sign: signRequestHuawei, fetcher: transport.fetch }
      const first = await claimCodeArtsDailyCheckin(credential, deps)
      if (first.kind !== 'failed' || !isCredentialExpiredMessage(first.message ?? '')) return first
      // 临时令牌过期：刷新一次再重试（同 LLM 适配器的 401 兜底策略）。
      const refreshed = await refreshCredentialByRef(ctx, codeArtsAuth, ref)
      return refreshed === undefined ? first : claimCodeArtsDailyCheckin(refreshed, deps)
    },
    warn: (message: string) => ctx.logger?.warn?.(message),
  })
  autoCheckin.start()
  ctx.effect(() => () => autoCheckin.stop(), 'dsh-ofm-huawei-codearts: auto checkin')

  // 设置页栏目（client.js）的数据源：GET /api/dsh-ofm-huawei-codearts/balance
  // 返回积分余额与上次签到结果。webServer 只在 web profile 存在，headless 组合
  // 少了这个路由也不影响 provider。
  ctx.inject(['webServer'], (scoped: any) => {
    const handler = createAdminRoute({
      balanceDeps: {
        resolveAccount: () => resolveCodeArtsCredential(ctx),
        refreshAccount: async (account: { ref: string }) => {
          const credential = await refreshCredentialByRef(ctx, codeArtsAuth, account.ref)
          return credential === undefined ? undefined : { ref: account.ref, credential }
        },
        fetchBalance: (credential: CodeArtsCredential) =>
          fetchCodeArtsCreditBalance(credential, { sign: signRequestHuawei, fetcher: transport.fetch }),
        readCheckin: () => createFileAutoCheckinStore({ home: resolveAutoCheckinHome(ctx) }).load(),
      },
      // refresh_token 是一次性的，失效后只能重新授权：设置页给一个按钮，
      // 点击后 POST /login 拿到 portal 授权 URL，浏览器完成授权即回写凭据。
      loginDeps: {
        startLogin: () => codeArtsAuth.startLogin({ refName: primaryCredentialRef() }),
      },
      // 模型与图片能力：GET/POST /models。只存与目录不同的行（见
      // src/model-settings.js），保存后下一次请求即生效，无需重启。
      modelsDeps: {
        // 打开设置页时若目录已过刷新窗口，先刷一次再返回（见上面的自动更新段）。
        getCatalog: async () => {
          await refreshCatalogIfStale(MODEL_REFRESH_INTERVAL_MS)
          return codeArtsLlm.catalogRows()
        },
        settingsPath: () => modelsSettingsPath(),
        // 设置页「测试」按钮：用适配器自己的 stream() 给该模型发一条 `hi`，
        // 测的是真实链路（凭据刷新、签名、SSE、限流重试），凭据不出服务端。
        testModel: async (model: string) => {
          const started = Date.now()
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 30_000)
          const outcome: {
            ok: boolean
            model: string
            key: string
            latencyMs: number
            text: string
            reasoning?: string
            usage?: unknown
            error?: { code: string; message: string }
          } = { ok: false, model, key: '', latencyMs: 0, text: '' }
          try {
            for await (const chunk of codeArtsLlm.stream({
              provider: 'codearts',
              model,
              messages: [{ role: 'user', content: 'hi' }],
              maxTokens: 512,
              signal: controller.signal,
            } as never)) {
              const typed = chunk as {
                type?: string
                text?: string
                reason?: { kind?: string; failure?: { code?: string; message?: string } }
                usage?: unknown
              }
              if (typed.type === 'text-delta') outcome.text += String(typed.text ?? '')
              else if (typed.type === 'reasoning-delta') outcome.reasoning = `${outcome.reasoning ?? ''}${String(typed.text ?? '')}`
              else if (typed.type === 'usage') outcome.usage = typed.usage
              else if (typed.type === 'finish') {
                outcome.ok = typed.reason?.kind !== 'error' && typed.reason?.kind !== 'aborted'
                if (!outcome.ok) {
                  outcome.error = {
                    code: String(typed.reason?.failure?.code ?? 'UNKNOWN'),
                    message: String(typed.reason?.failure?.message ?? 'stream failed'),
                  }
                }
              }
            }
          } catch (error) {
            outcome.ok = false
            outcome.error = {
              code: String((error as { code?: unknown })?.code ?? 'TEST_FAILED'),
              message: error instanceof Error ? error.message : String(error),
            }
          } finally {
            clearTimeout(timer)
          }
          outcome.latencyMs = Date.now() - started
          if (outcome.ok && outcome.text.trim() === '') {
            outcome.ok = false
            outcome.error = { code: 'EMPTY', message: '模型返回了空文本' }
          }
          return outcome
        },
      },
    })
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: '/api/dsh-ofm-huawei-codearts', handler }),
      'dsh-ofm-huawei-codearts: balance route',
    )
  })
}
