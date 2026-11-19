/**
 * 跨实例「单 key」机制验收：**启动多少次，都只消耗一把 refresh_token**。
 *
 * 这一层锁的是产品承诺本身，不是某个实现细节，所以测试要用**真多进程**
 * （`child_process.spawn` 3~5 个 node 子进程），而不是同进程 Promise 并发
 * ——同进程并发测不出文件锁/竞态，而这正是事故的成因。
 *
 * 判据（少一条都不算过）：
 * 1. N 个进程同时冷启动 ⇒ **恰好 1 次**真续期请求；
 * 2. 其余进程拿到的是**同一把**新 token（refresh_token 完全一致）；
 * 3. 每个进程的「本地存储」最终都被镜像成那把新 token（设置页看得见）；
 * 4. 已有共享真源时再冷启动 ⇒ **0 次**续期请求（直接采纳）；
 * 5. 持锁进程已死遗留的锁 ⇒ 能被接管（不会焊死后续启动）；
 * 6. 共享真源损坏/不存在 ⇒ 优雅退化（返回本地，不抛）。
 *
 * 独立进程脚本用 `-e` 传不进去（需要 import 我们的 ESM 模块），
 * 因此写在 `test/fixtures/` 下，子进程直接跑它。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  needsRefresh,
  normalizeSharedCredential,
  pickNewerCredential,
  readSharedCredential,
  safeRefName,
  sharedCredentialDir,
  sharedCredentialFile,
  withCredentialLock,
  writeSharedCredential,
} from '../src/shared-credential.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INSTANCE = path.join(HERE, 'fixtures', 'shared-credential-instance.mjs')

/** 建一个临时共享目录 + 临时「本地存储」目录。 */
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codearts-shared-'))
  return {
    root,
    shared: path.join(root, 'shared'),
    local: path.join(root, 'local'),
    env: { ...process.env, CODEARTS_SHARED_CREDENTIAL_DIR: path.join(root, 'shared') },
  }
}

/** 造一份「刚续过」的凭据：expires_at 12 小时后（远超出 1h lead 窗口）。 */
function freshCredential(tag, hoursAhead = 12) {
  return {
    access_key_id: `AK${tag}`,
    secret_access_key: `SK${tag}`,
    security_token: `ST${tag}`,
    expires_at: new Date(Date.now() + hoursAhead * 3_600_000).toISOString(),
    refresh_token: `${tag}.refresh.token`,
    code_verifier: `${tag}-verifier`,
    dpop_private_key_jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
  }
}

/** 跑一个实例子进程；返回它打印的 JSON 结果。 */
function runInstance(env, refName, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INSTANCE, refName], {
      env: { ...env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    // 冷启动并发窗口要够宽，确保各进程真的在争同一把锁
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.stderr.on('data', (chunk) => { err += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`instance exited ${code}: ${err.slice(0, 500)}`))
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()))
      } catch (cause) {
        reject(new Error(`bad instance output: ${out.slice(0, 400)} / ${err.slice(0, 200)}`))
      }
    })
  })
}

test('N 个实例冷启动只消耗一把 refresh_token，且都落到同一把', async () => {
  const ws = makeWorkspace()
  try {
    const refName = 'CODEARTS_ACCOUNT_C07CA597'
    const N = 5
    // 每个实例的「本地存储」先放同一把旧 token（模拟 5 份 DSH_HOME 副本）
    const stale = freshCredential('STALE', 41)   // 41h → 仍在窗口外，不会触发刷新
    for (let i = 0; i < N; i++) {
      const dir = path.join(ws.local, `home-${i}`)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'credential.json'), JSON.stringify(stale), { mode: 0o600 })
    }
    // 让旧 token 恰好「需要续期」：改成 30 分钟后就过期（< 1h lead）
    const due = { ...stale, expires_at: new Date(Date.now() + 30 * 60_000).toISOString() }
    for (let i = 0; i < N; i++) {
      fs.writeFileSync(path.join(ws.local, `home-${i}`, 'credential.json'), JSON.stringify(due), { mode: 0o600 })
    }

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        runInstance(ws.env, refName, {
          CODEARTS_LOCAL_FILE: path.join(ws.local, `home-${i}`, 'credential.json'),
          CODEARTS_REFRESH_LOG: path.join(ws.root, 'refresh.log'),
          CODEARTS_REFRESH_DELAY_MS: '120',
        }),
      ),
    )

    const refreshedCount = results.filter((r) => r.refreshed === true).length
    assert.equal(refreshedCount, 1, `应当恰好 1 个实例真续期，实际 ${refreshedCount}：${JSON.stringify(results)}`)
    const requests = fs.readFileSync(path.join(ws.root, 'refresh.log'), 'utf8').trim().split('\n').filter(Boolean)
    assert.equal(requests.length, 1, `5 个实例冷启动只应发 1 次续期请求，实际 ${requests.length} 次`)

    const tokens = new Set(results.map((r) => r.credential.refresh_token))
    assert.equal(tokens.size, 1, `所有实例应落到同一把 token，实际 ${[...tokens].join(' / ')}`)

    // 每个实例的本地文件都被镜像成那把新 token
    for (let i = 0; i < N; i++) {
      const onDisk = JSON.parse(fs.readFileSync(path.join(ws.local, `home-${i}`, 'credential.json'), 'utf8'))
      assert.ok(tokens.has(onDisk.refresh_token), `home-${i} 的本地存储没被镜像成新 token`)
    }

    // 共享真源也是那把
    const shared = readSharedCredential(refName, ws.env)
    assert.ok(tokens.has(shared.refresh_token), '共享真源不是新 token')

    // 再冷启动一批：共享已有 fresher token ⇒ 0 次续期
    const again = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        runInstance(ws.env, refName, {
          CODEARTS_LOCAL_FILE: path.join(ws.local, `home-${i}`, 'credential.json'),
          CODEARTS_REFRESH_DELAY_MS: '120',
        }),
      ),
    )
    assert.equal(again.filter((r) => r.refreshed === true).length, 0, '已有共享真源时不应再续期')
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true })
  }
})

test('并发累计只烧一把：10 个实例 × 3 轮', async () => {
  const ws = makeWorkspace()
  try {
    const refName = 'CODEARTS_ACCOUNT_C07CA597'
    const stale = freshCredential('STALE2', 12)
    const refreshLog = path.join(ws.root, 'refresh.log')
    let totalRefreshes = 0
    for (let round = 0; round < 3; round++) {
      // 每轮都模拟「又过了一个周期」：把共享真源与各本地都重置成同一把「需续期」的
      // token（不同轮用不同 refresh_token，避免与上一轮"同值"短路）。
      const due = {
        ...stale,
        refresh_token: `ROUND-${round}.refresh.token`,
        expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
      }
      writeSharedCredential(refName, due, ws.env)
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => {
          const file = path.join(ws.local, `r${round}-home-${i}`, 'credential.json')
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, JSON.stringify(due), { mode: 0o600 })
          return runInstance(ws.env, refName, {
            CODEARTS_LOCAL_FILE: file,
            CODEARTS_REFRESH_LOG: refreshLog,
            CODEARTS_REFRESH_DELAY_MS: '80',
          })
        }),
      )
      totalRefreshes += results.filter((r) => r.refreshed === true).length
      const tokens = new Set(results.map((r) => r.credential.refresh_token))
      assert.equal(tokens.size, 1, `第 ${round + 1} 轮出现多把 token：${[...tokens].join(' / ')}`)
    }
    assert.equal(totalRefreshes, 3, `3 轮应各续 1 次、共 3 次，实际 ${totalRefreshes}`)
    // 用子进程自己记的「真发请求」次数交叉验证（不能只信返回值）
    const lines = fs.readFileSync(refreshLog, 'utf8').trim().split('\n').filter(Boolean)
    assert.equal(lines.length, 3, `实际续期请求应为 3 次，日志记了 ${lines.length} 次`)
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true })
  }
})

test('共享真源不存在时由本地引导（首次运行）', async () => {
  const ws = makeWorkspace()
  try {
    const refName = 'CODEARTS_ACCOUNT_C07CA597'
    const local = freshCredential('BOOT', 30)   // 30h：不需要刷新
    const file = path.join(ws.local, 'home-0', 'credential.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(local), { mode: 0o600 })

    const result = await runInstance(ws.env, refName, { CODEARTS_LOCAL_FILE: file })
    assert.equal(result.refreshed, false)
    const shared = readSharedCredential(refName, ws.env)
    assert.ok(shared !== undefined, '首次运行应把本地凭据发布到共享真源')
    assert.equal(shared.refresh_token, local.refresh_token)
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true })
  }
})

test('持锁者已死：锁能被接管，不焊死后续启动', async () => {
  const ws = makeWorkspace()
  try {
    const refName = 'CODEARTS_ACCOUNT_C07CA597'
    const file = sharedCredentialFile(refName, ws.env)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // 伪造一个「已退出进程」留下的锁
    fs.writeFileSync(`${file}.lock`, '999999\n')
    const start = Date.now()
    const value = await withCredentialLock(refName, async () => 'acquired', { env: ws.env, waitMs: 5_000 })
    assert.equal(value, 'acquired')
    assert.ok(Date.now() - start < 5_000, '接管死锁不应等到超时')
    assert.ok(!fs.existsSync(`${file}.lock`), '用完后锁应被释放')
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true })
  }
})

test('共享真源损坏 / 过期 / 缺字段：优雅退化', async () => {
  const ws = makeWorkspace()
  try {
    const refName = 'CODEARTS_ACCOUNT_C07CA597'
    const file = sharedCredentialFile(refName, ws.env)
    fs.mkdirSync(path.dirname(file), { recursive: true })

    fs.writeFileSync(file, '{ not json')
    assert.equal(readSharedCredential(refName, ws.env), undefined, '损坏 JSON 应返回 undefined')

    fs.writeFileSync(file, JSON.stringify({ expires_at: new Date().toISOString() }))
    assert.equal(readSharedCredential(refName, ws.env), undefined, '缺 AK/SK 应返回 undefined')

    assert.equal(readSharedCredential('NO_SUCH_REF', ws.env), undefined, '不存在应返回 undefined')
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true })
  }
})

test('pickNewerCredential：只认「更新的一把」，同值不覆盖', () => {
  const older = freshCredential('OLD', 2)
  const newer = freshCredential('NEW', 10)

  assert.equal(pickNewerCredential(older, newer), newer, 'ST 更晚的一把应被采纳')
  assert.equal(pickNewerCredential(newer, older), undefined, '更旧的一把不应覆盖新的')
  assert.equal(pickNewerCredential(older, { ...older }), undefined, '同一把不应重复采纳')
  assert.equal(pickNewerCredential(undefined, newer), newer, '本地缺失应采纳共享')
  assert.equal(pickNewerCredential(older, undefined), undefined, '共享缺失不应覆盖本地')
  assert.equal(
    pickNewerCredential({ ...older, refresh_token: '' }, newer),
    newer,
    '本地不可续期时应采纳可续期的共享',
  )
})

test('needsRefresh：1h lead 口径', () => {
  const now = Date.now()
  assert.equal(needsRefresh({ expires_at: new Date(now + 30 * 60_000).toISOString() }, now), true)
  assert.equal(needsRefresh({ expires_at: new Date(now + 90 * 60_000).toISOString() }, now), false)
  assert.equal(needsRefresh({ expires_at: new Date(now - 60_000).toISOString() }, now), true)
  assert.equal(needsRefresh({}, now), true, '读不到过期时间一律视为需要续期')
})

test('共享目录锚定真实主目录，不受 HOME / DSH_HOME 影响', () => {
  const dir = sharedCredentialDir({ HOME: '/tmp/fake-home', DSH_HOME: '/tmp/fake-dsh' })
  assert.ok(dir.startsWith(os.userInfo().homedir), `共享目录必须锚在 ${os.userInfo().homedir}，实际 ${dir}`)
  assert.ok(!dir.includes('/tmp/fake-home'), '不能被 HOME 覆盖影响')
  assert.ok(!dir.includes('/tmp/fake-dsh'), '不能被 DSH_HOME 覆盖影响')

  // 显式 env 覆盖仍然生效（给测试/特殊部署用）
  const overridden = sharedCredentialDir({ CODEARTS_SHARED_CREDENTIAL_DIR: '/tmp/explicit-shared' })
  assert.equal(overridden, '/tmp/explicit-shared')
})

test('文件名转义：ref 不会逃出共享目录', () => {
  assert.equal(safeRefName('CODEARTS_ACCOUNT_C07CA597'), 'CODEARTS_ACCOUNT_C07CA597')
  assert.equal(safeRefName('../../etc/passwd'), '.._.._etc_passwd')
  assert.ok(!safeRefName('a/b').includes('/'))
})

test('normalizeSharedCredential：字符串 / 对象两种入参', () => {
  const cred = freshCredential('NORM')
  assert.deepEqual(normalizeSharedCredential(JSON.stringify(cred)), cred)
  assert.deepEqual(normalizeSharedCredential(cred), cred)
  assert.equal(normalizeSharedCredential('garbage'), undefined)
  assert.equal(normalizeSharedCredential(null), undefined)
  assert.equal(normalizeSharedCredential({ access_key_id: 'x' }), undefined)
})

test('writeSharedCredential 落盘为 0600', () => {
  const ws = makeWorkspace()
  try {
    const refName = 'CODEARTS_ACCOUNT_C07CA597'
    assert.equal(writeSharedCredential(refName, freshCredential('MODE'), ws.env), true)
    const file = sharedCredentialFile(refName, ws.env)
    const mode = fs.statSync(file).mode & 0o777
    assert.equal(mode, 0o600, `共享凭据必须是 0600，实际 ${mode.toString(8)}`)
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true })
  }
})