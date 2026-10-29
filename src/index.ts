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
import { registerCodeArtsLlm } from './llm-adapter.js'
import { createDirectFetch, attachDirectFetch } from './direct-fetch.js'
import { signRequestHuawei } from './sign.js'
import {
  claimCodeArtsDailyCheckin,
  createAutoCheckin,
  createFileAutoCheckinStore,
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
  return credentialRefsFromStore().map((ref, index) => ({
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

  registerCodeArtsLlm(ctx, {
    fetchImpl: transport.fetch,
    // 适配器契约要求一个默认 ref；实际解析走下面的 resolveCredential。
    credentialRef: credentialRef(LEGACY_CREDENTIAL_REF),
    resolveCredential: async () => (await resolveCodeArtsCredential(ctx))?.credential,
    refresh: async () => {
      const found = await resolveCodeArtsCredential(ctx)
      if (found) await codeArtsAuth.refreshAccountCredential(found.ref)
    },
  })

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
    claim: (credential: CodeArtsCredential) =>
      claimCodeArtsDailyCheckin(credential, { sign: signRequestHuawei, fetcher: transport.fetch }),
    warn: (message: string) => ctx.logger?.warn?.(message),
  })
  autoCheckin.start()
  ctx.effect(() => () => autoCheckin.stop(), 'dsh-ofm-huawei-codearts: auto checkin')
}
