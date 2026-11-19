/**
 * 测试夹具：模拟**一个 DSH 实例**的凭据续期决策。
 *
 * 由 `test/shared-credential.test.js` 用 `child_process.spawn` 拉起多个，
 * 用来证明「多个实例同时冷启动只会消耗一把 refresh_token」——这件事
 * **必须跨进程验证**（同进程 Promise 并发测不出文件锁/竞态）。
 *
 * 环境变量：
 * - `CODEARTS_LOCAL_FILE`      本实例的「本地凭据存储」（模拟它自己那份 DSH_HOME）
 * - `CODEARTS_REFRESH_LOG`     真发续期请求时追加一行（用来数总请求次数）
 * - `CODEARTS_REFRESH_DELAY_MS` 网络延迟，用来拉宽并发窗口
 *
 * 真实实现里 `networkRefresh` 是 POST 华为 STS；这里换成「造一把新 token」，
 * 因为本测试验证的是**协调机制**（谁该发请求、结果如何广播），不是华为协议。
 */
import fs from 'node:fs'
import { coordinateRefresh } from '../../src/shared-credential.js'

const refName = process.argv[2]
const localFile = process.env.CODEARTS_LOCAL_FILE
const refreshLog = process.env.CODEARTS_REFRESH_LOG
const delayMs = Number(process.env.CODEARTS_REFRESH_DELAY_MS ?? 0)

function readLocal() {
  try {
    return JSON.parse(fs.readFileSync(localFile, 'utf8'))
  } catch {
    return undefined
  }
}

async function writeLocal(credential) {
  fs.writeFileSync(localFile, JSON.stringify(credential), { mode: 0o600 })
}

async function networkRefresh(credential) {
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
  if (refreshLog) fs.appendFileSync(refreshLog, `${process.pid}\n`)
  // 模拟一次性轮换：旧 token 作废、发一把全新的（进程内唯一即可）
  return {
    ...credential,
    access_key_id: `AKNEW${process.pid}${Date.now()}`,
    secret_access_key: `SKNEW${process.pid}${Date.now()}`,
    security_token: `STNEW${process.pid}${Date.now()}`,
    refresh_token: `NEW-${process.pid}-${Date.now()}.refresh.token`,
    expires_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
  }
}

const result = await coordinateRefresh({
  refName,
  readLocal,
  writeLocal,
  networkRefresh,
  env: process.env,
})

console.log(JSON.stringify({
  pid: process.pid,
  refreshed: result.refreshed === true,
  adopted: result.adopted === true,
  credential: result.credential,
}))