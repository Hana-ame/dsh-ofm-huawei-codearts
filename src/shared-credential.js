/**
 * 跨实例共享凭据 + 跨进程互斥：让「启动多少次都只有一把 key」成为机制保证。
 *
 * ## 为什么必须有这一层（2026-11-19 真实事故）
 *
 * CodeArts 的 refresh_token 是**一次性轮换**的：每次续期服务端作废旧 token、
 * 发新的一把。而 DSH 的凭据原本存在**每个 DSH_HOME 各自的** `.credentials.yaml`
 * 里。于是只要有第二个实例从同一份凭据拷出 DSH_HOME（当天两次：`rsync
 * --link-dest` 与 `cp -a`），两个实例就各持一把「看起来都能用」的 token：
 *
 *     A（真宿主）持有 rt#7 → B 启动时用自己的副本 rt#7 续期成功 → 服务端作废 rt#7
 *     → B 拿到 rt#8 写进**自己的副本** → A 文件里仍是已作废的 rt#7
 *     → A 下次续期 = STS5.1806「the refresh token has been used」，只能重登录
 *
 * 「启动时不强制续期」只降低概率，**不解决问题**：B 只要真的需要续期（例如
 * 换机器、ST 过期），照样会换掉一把 A 不知道的新 token。
 *
 * ## 机制：把凭据的「真源」从 DSH_HOME 里搬出来
 *
 * 真源固定在**真实用户主目录**（`os.userInfo().homedir`，它**不受 `HOME`
 * 环境变量覆盖影响** —— 实测 `HOME=/tmp/fake HOME 时 userInfo().homedir 仍是
 * /home/lumin`），路径：
 *
 *     <real home>/.dsh/codearts-shared/<ref>.json     （0600）
 *     <real home>/.dsh/codearts-shared/<ref>.lock     （跨进程锁）
 *
 * 所有实例（无论 DSH_HOME 指向哪个副本）都读这同一份、写这同一份。于是：
 *
 * 1. 谁先拿到锁谁续期；**其余实例在锁内重读，看到新 token 就直接采纳、不发请求**
 *    ⇒ 启动 N 次只消耗 1 把。
 * 2. 采纳来的 token 同时**镜像回自己的 `ctx.credentials`**，设置页/账号池看到的
 *    始终是同一把。
 * 3. 锁内「先读共享 → 比新旧 → 再决定要不要真刷」，因此并发下不会出现
 *    「A 拿旧 token 撞过期 → 顺手把 B 刚换的新 token 再换一次」的双烧。
 *
 * ## 为什么不用 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock`
 *
 * 插件 bundle 只 externalize `@deepseek-ai/*`，运行时解析不可控（该包未必在每个
 * 组合层都在）；且它的 `waitMs` 默认较短。这里自实现一个语义等价、能识别
 * **持锁进程已死**并接管的锁（与 atomic-write 同思路），只用 `node:fs`。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 共享凭据目录；测试可用 env 覆盖。 */
export function sharedCredentialDir(env = process.env) {
  const override = String(env.CODEARTS_SHARED_CREDENTIAL_DIR ?? '').trim()
  if (override.length > 0) return override
  // ⚠️ 必须用 userInfo().homedir（真主目录），**不要**用 homedir()/HOME：
  //   HOME 可被测试实例覆盖（当天 /tmp/home-a 就是），那样又会各写各的。
  const realHome = os.userInfo().homedir || os.homedir()
  return path.join(realHome, '.dsh', 'codearts-shared')
}

/** ref 名转安全文件名（ref 本就只含字母数字下划线，这里只做兜底）。 */
export function safeRefName(refName) {
  return String(refName).replace(/[^A-Za-z0-9_.-]/g, '_')
}

export function sharedCredentialFile(refName, env = process.env) {
  return path.join(sharedCredentialDir(env), `${safeRefName(refName)}.json`)
}

/** 校验「像一份能用的凭据」；解析失败/字段缺失返回 undefined。 */
export function normalizeSharedCredential(value) {
  if (value === null || value === undefined) return undefined
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  if (!parsed.access_key_id || !parsed.secret_access_key) return undefined
  return parsed
}

/** 读共享凭据；文件不存在/损坏一律 undefined（绝不抛）。 */
export function readSharedCredential(refName, env = process.env) {
  try {
    const text = fs.readFileSync(sharedCredentialFile(refName, env), 'utf8')
    return normalizeSharedCredential(text)
  } catch {
    return undefined
  }
}

/** 原子写共享凭据（0600）；失败返回 false，不抛。 */
export function writeSharedCredential(refName, credential, env = process.env) {
  const file = sharedCredentialFile(refName, env)
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temporary, JSON.stringify(credential), { mode: 0o600 })
    fs.renameSync(temporary, file)
    return true
  } catch {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      /* ignore */
    }
    return false
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 进程是否还活着（EPERM = 活着但无权限发信号）。 */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * 跨进程独占锁：`<shared>.lock` 以 `wx` 创建，成年进程 pid 写入。
 *
 * - 持锁进程已死 ⇒ 接管（删锁重试），避免崩溃遗留的僵尸锁把后续启动焊死。
 * - 超时（默认 30s）抛错；调用方应把它当「这次没排上」而非「凭据坏了」。
 */
export async function withCredentialLock(refName, operation, options = {}) {
  const env = options.env ?? process.env
  const waitMs = Number(options.waitMs ?? 30_000)
  const lockPath = `${sharedCredentialFile(refName, env)}.lock`
  const deadline = Date.now() + waitMs
  let delay = 25
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600)
      try {
        fs.writeFileSync(fd, `${process.pid}\n`)
      } finally {
        fs.closeSync(fd)
      }
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // 持锁者已死 → 接管
      try {
        const holder = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10)
        if (!processAlive(holder)) {
          fs.rmSync(lockPath, { force: true })
          continue
        }
      } catch {
        // 读不到锁内容（刚被删/正在写）→ 按争用处理
      }
      if (Date.now() >= deadline) {
        throw new Error(`codearts: 等待跨实例凭据锁超时（${lockPath}）`)
      }
      await sleep(delay)
      delay = Math.min(Math.round(delay * 1.6), 200)
    }
  }
  try {
    return await operation()
  } finally {
    try {
      fs.rmSync(lockPath, { force: true })
    } catch {
      /* ignore */
    }
  }
}

/** 凭据的 ST 过期时刻（毫秒）；解析不了返回 NaN。 */
export function expiresAtMsOf(credential) {
  const parsed = credential?.expires_at ? Date.parse(credential.expires_at) : Number.NaN
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

/**
 * 在两份凭据里选「更新的一把」。
 *
 * 判据优先级（任一成立即认为 candidate 更新）：
 * 1. 两者 refresh_token 不同，且 candidate 的 ST 过期时刻更晚 → candidate 更新；
 * 2. 当前那份已不可续期（缺 refresh_token/verifier/JWK）而 candidate 可续 → candidate；
 * 3. 当前那份根本不存在 → candidate。
 *
 * 相同的 token（同一把）→ 不采纳（避免无意义地覆盖本地）。
 */
export function pickNewerCredential(current, candidate) {
  if (candidate === undefined) return undefined
  if (current === undefined) return candidate
  const same = current.access_key_id === candidate.access_key_id
    && current.expires_at === candidate.expires_at
    && current.refresh_token === candidate.refresh_token
  if (same) return undefined
  const curExp = expiresAtMsOf(current)
  const candExp = expiresAtMsOf(candidate)
  if (Number.isFinite(candExp) && (!Number.isFinite(curExp) || candExp > curExp)) return candidate
  if (!Number.isFinite(candExp) && !Number.isFinite(curExp)
    && Boolean(candidate.refresh_token) && !current.refresh_token) return candidate
  return undefined
}

/** 距过期是否还需真刷（与 expiry-sync 的 REFRESH_LEAD_MS=1h 同口径）。 */
export function needsRefresh(credential, nowMs = Date.now(), leadMs = 3_600_000) {
  const exp = expiresAtMsOf(credential)
  if (!Number.isFinite(exp)) return true
  return exp - nowMs <= leadMs
}

/**
 * **【核心】跨实例协调续期**：锁内「采纳更新的 → 判要不要刷 → 真刷 → 双写」。
 *
 * @param {object} params
 * @param {string} params.refName 凭据 ref
 * @param {(refName: string) => Promise<object|undefined>} params.readLocal 读本地（ctx.credentials）
 * @param {(credential: object) => Promise<void>} params.writeLocal 写本地（镜像共享的那把）
 * @param {(credential: object) => Promise<object>} [params.networkRefresh] 真发续期请求；
 *   不给则只做采纳（用于「只想对齐、不想刷」的调用点）
 * @param {boolean} [params.force] 反应式路径（服务端已明确判过期）
 * @param {number} [params.nowMs]
 * @param {number} [params.leadMs]
 * @param {string[]} [params.log] 输出诊断文案
 * @returns {Promise<{ credential?: object, refreshed: boolean, adopted: boolean }>}
 */
export async function coordinateRefresh(params) {
  const {
    refName,
    readLocal,
    writeLocal,
    networkRefresh,
    force = false,
    nowMs = Date.now(),
    leadMs = 3_600_000,
    env = process.env,
    log = [],
    waitMs,
  } = params

  return await withCredentialLock(refName, async () => {
    const local = await readLocal(refName)
    const shared = readSharedCredential(refName, env)

    // ⓪ 首次引导：共享真源还没有，而本地有 ⇒ 把本地那份发布出去，
    //    这样后续启动的实例（哪怕 DSH_HOME 是副本）都能看到同一把。
    if (shared === undefined && local !== undefined) {
      writeSharedCredential(refName, local, env)
      log.push(`[codearts] 初始化共享凭据真源（${refName}）`)
    }

    // ① 采纳：共享那份更新 → 先镜像回本地（这样设置页/账号池也看到新的）
    const newer = pickNewerCredential(local, shared)
    let current = local
    let adopted = false
    if (newer !== undefined) {
      if (typeof writeLocal === 'function') await writeLocal(newer)
      current = newer
      adopted = true
      log.push(`[codearts] 采纳共享凭据（${refName}，他处已续期）`)
    }

    if (current === undefined) return { credential: undefined, refreshed: false, adopted }

    // ② 判要不要真刷：非 force 时按 1h lead 把关；force 时也先看采纳值是否已经可用
    const stillUsable = Number.isFinite(expiresAtMsOf(current)) && expiresAtMsOf(current) - nowMs > 60_000
    if (!force && !needsRefresh(current, nowMs, leadMs)) {
      return { credential: current, refreshed: false, adopted }
    }
    if (force && adopted && stillUsable) {
      // 服务端拒的是「旧的那把」，而共享里已有一把新的且未过期 → 直接用它，不刷
      log.push(`[codearts] 反应式刷新命中已采纳的新凭据，跳过请求（${refName}）`)
      return { credential: current, refreshed: false, adopted }
    }
    if (typeof networkRefresh !== 'function') {
      return { credential: current, refreshed: false, adopted }
    }

    // ③ 真刷：先落共享（真源），再镜像本地
    const refreshed = await networkRefresh(current)
    writeSharedCredential(refName, refreshed, env)
    if (typeof writeLocal === 'function') await writeLocal(refreshed)
    return { credential: refreshed, refreshed: true, adopted }
  }, { env, waitMs })
}