# 华为云 CodeArts 插件（dsh-ofm-huawei-codearts）

把上游 `dsh-our-free-model` 在 2.5.9 删除的**华为云 CodeArts** 渠道加回来。

特点：

- 用**独立插件**的方式恢复，不修改 `dsh-our-free-model` 任何一个字节；
- 在 DSH 模型选择器里注册 `codearts` provider，显示为 **CodeArts Agent**；
- 复用已有账号与凭据，不需要重新登录（刷新令牌有效期内自动续期）；
- 保留华为的签名传输（`SDK-HMAC-SHA256`、benefit 额度重试）；
- 设置页可**逐模型配置图片能力**（`inputModalities`），图片按 data URL 下发。

## 它和 dsh-our-free-model 怎么分工

```
DSH 内核
 ├─ 提供 llm / credentials 服务，负责加载插件
 │
 ├─ dsh-our-free-model（上游，原样不动）
 │    └─ 10 个免费渠道，不含华为
 │
 └─ dsh-ofm-huawei-codearts（本插件）
      └─ 只注册 codearts 一个 provider
```

本插件能加回“模型来源”，但**加不回** OFM 自己那个“白嫖模型接入”页里的华为卡片——
那张卡写死在 OFM 的 `client.js` 里，只有 fork 才能改。

## 数据从哪来

本插件不新建账号池，只读上游 channel-pack 留下的数据：

| 数据 | 位置 | 用途 |
|---|---|---|
| 账号索引 | `$DSH_HOME/channel-pack/state.json` | 找 `provider=codearts` 的 `credentialRef` |
| 凭据 | `$DSH_HOME/.credentials.yaml` | 按 `CODEARTS_ACCOUNT_*` 的 ref 解析密钥 |

为什么不用上游的 `AccountPool`：上游 2.7.2 的 provider 白名单已不含 `codearts`，
它下次保存 `state.json` 时可能把这条账号过滤掉。本插件按 ref 直读凭据，账号索引
被重写也不影响。

## 目录结构

```
dsh-ofm-huawei-codearts/
├─ package.json          插件清单：名字、描述、宿主 peer 依赖
├─ cordis.patch.yml      告诉 DSH 启动时插入本插件
├─ locale/
│  ├─ zh.json            插件列表里的中文标题/描述
│  └─ en.json            英文标题/描述
├─ index.js              构建产物（DSH 真正加载的文件）
├─ scripts/
│  └─ build.sh           用 esbuild 重新构建 index.js
├─ src/
│  ├─ index.ts           插件入口：apply()、凭据解析
│  ├─ llm-adapter.ts     CodeArts 适配器（请求/流式/错误分类）
│  ├─ service.ts         登录、续期、账号凭据管理
│  ├─ sign.ts            华为请求签名
│  ├─ models.ts          模型目录与上下文窗口
│  ├─ direct-fetch.ts    独立 undici 传输（不碰全局 fetch）
│  ├─ sse.ts / message-shape.ts / retry-after.ts  流解析与限流
│  └─ …                  其余为上述模块的共享依赖
├─ README.md
└─ LICENSE-CHANNEL-PACK / NOTICE-CHANNEL-PACK.md   上游代码来源与许可
```

`src/` 只保留 CodeArts 入口真正引用到的 29 个文件；上游 channel-pack 里其它
渠道（LobsterAI、Qoder、TRAE、Cline 等）的代码已删掉，避免读代码时被无关实现淹没。

## 构建

```bash
ESBUILD_BIN=/path/to/esbuild ./scripts/build.sh
```

不设 `ESBUILD_BIN` 时会依次尝试 PATH 里的 `esbuild`、`npx`。

**必须带 `createRequire` banner**：依赖里的 `undici` 是 CJS，会调用
`require("node:assert")`；纯 ESM 产物没有 `require`，会直接抛
`Dynamic require of "node:assert" is not supported`，DSH 只显示 `failed to import`。
上游 channel-pack 的构建脚本（`scripts/build-channel-pack.mjs:67`）用的是同一个办法。

### ⚠️ undici 版本（务必 8.x）

插件代码依赖 `undici` 的 `Dispatcher1Wrapper` 兼容桥（8.x 才有）。构建脚本会
校验 `DEPS_DIR` 里 undici 的主版本，低于 8 直接失败：

- 推荐构建依赖放在 `$HOME/.dsh/build-deps/node_modules`（undici 8.x + jose），
  `scripts/build.sh` 会优先用它；
- **症状**：用 6.x/7.x 构建也能成功，但运行时只要走环境代理就抛
  `Dispatcher1Wrapper is not a constructor`，直连却一切正常——2026-10-30
  的实际故障就是打包时误用了 undici 6.28.0，导致 CodeArts 模型/签到/余额
  全部报「渠道网络请求失败（环境代理）」。

## 安装/启用

1. 插件目录放到 `~/.dsh/plugins/dsh-ofm-huawei-codearts`；
2. 在 profile 的 `package.json` 里加 bundle 和 link 依赖（排在
   `dsh-our-free-model` 之后）；
3. 重启 dsh。

插件需要 `ctx.llm` 和 `ctx.credentials` 两个服务。

## 验证

重启后：

- 插件列表里能看到 **华为云 CodeArts**，状态 running；
- 模型选择器里出现 **CodeArts Agent**；
- 日志里有：
  `dsh-ofm-huawei-codearts: 注册 codearts provider（磁盘上找到 N 个凭据 ref）`。

## 每日自动签到

上游 `dsh-our-free-model` 自 2.5.9 起删除 CodeArts 渠道后，随渠道一起丢失的
「每日自动签到」在本插件里重新实现（`src/auto-checkin.js`）：

- 插件启动后延迟 30 秒（可用 `DSH_CHANNEL_PACK_AUTO_CHECKIN_DELAY_MS` 覆盖，
  `0` 合法），若开关打开且**今天（UTC+8）还没跑过**，就串行遍历
  `channel-pack/state.json` 里启用的 CodeArts 账号，逐个执行
  「查询账号信息 → 查询活动列表 → 领取每日登录积分 → 确认」；
- 进程常驻时每 30 分钟复查一次（`DSH_CHANNEL_PACK_AUTO_CHECKIN_INTERVAL_MS`
  覆盖，`0` 关闭）：跨天后自动补签，不必重启 DSH；当天已签会直接跳过；
- 结果写回 `$DSH_HOME/channel-pack/auto-checkin.json`（schema
  `dsh-codearts-auth/auto-checkin/v1`，与上游既有文档完全兼容），当天不再触发；
- 状态文件与上游频道面板共用：`our-free-model` 的「每日自动签到」开关/状态
  读同一份文档，因此在那边关掉开关也会生效（每轮判定前都会重读磁盘）；
- 只有 claimed / already-claimed 才记为「今天已处理」；全部失败（代理抖动、
  凭据过期）**不记账**，下次启动自动重试；
- 开关判断只有**显式 `false`** 才算关闭（缺字段/旧文档一律按打开处理）。

## 设置页：积分余额与签到状态

插件自带一个设置页栏目「华为云 CodeArts」（`client.js`，注册到
`settings.section`，order 37），显示：

- **积分余额**：总积分包剩余 / 总额 / 已用 / 即将过期，以及基础/按需/赠送
  三个分类包的明细，另有套餐名；
- **每日签到状态**：今日是否已签、上次结果、上次签到日期/执行时间。

数据来自插件自带路由 `GET /api/dsh-ofm-huawei-codearts/balance`
（`src/balance-route.js`）：服务端用账号 AK/SK 签名查询 CodeArts 统计接口，
**AK/SK 不会下发到浏览器**。临时令牌过期（APIG.0602 `security token has
expired`）时，路由会先刷新一次凭据再重试；刷新失败才返回 502。

设置页同一栏目还有「**重新登录 CodeArts**」按钮（`src/login-route.js`）：
CodeArts 的 STS 临时令牌约 1–2 小时寿命、**refresh_token 一次性**（换新后旧
即失效），一旦续期失败就只能重新授权。点击后 `POST /login` 起两步式 OAuth，
浏览器打开 portal 授权页，完成后凭据自动回写，无需重装插件或跑脚本。

接口里与「过期」相关的只有两个字段（没有逐笔发放的到期日）：

- `start_date` / `end_date`：积分包周期（当前体验版 **2026-10-07 ~ 2026-11-08**，
  约一个月；`start_date` 与账号开通体验版积分的日期一致）；
- `package_credit_expiring_amount`：**即将过期的剩余额度**（金额，不是日期）。
  实测它随扣费等量减少（60.18 → 46.71 → 22.2 → 0，每次减少量等于已用增量），
  说明存在更早到期的小额度桶、会被优先扣费；归零只表示该桶已用完。

周期结束后（`end_date`）未使用的积分预计失效——这是根据字段语义与开通日期
推断的（`statistics/plugin` 不下发有效期规则字段，旧实现注释也明确记录过
这一点），精确到期日建议看 CodeArts 控制台「积分获取记录」页。

```json
{
  "ok": true,
  "balance": {
    "packageName": "体验版",
    "cycle": { "startDate": "2026-10-07", "endDate": "2026-11-08" },
    "total": { "amount": 20600, "used": 1217.39, "remain": 19382.61, "expiring": 22.2 },
    "basic": { "amount": 500, "used": 0, "remain": 500, "expiring": 0 },
    "bonus": { "amount": 20100, "used": 1217.39, "remain": 18882.61, "expiring": 22.2 }
  },
  "checkin": { "enabled": true, "lastDate": "2026-10-30", "lastResult": "1 个渠道：1 个账号领取成功（+100积分）" },
  "today": "2026-10-30"
}
```

## 设置页：模型与图片能力（2026-10-31 新增）

同一栏目的第三张卡片是「**模型与图片能力**」。适配器过去对**所有**模型硬编码
`inputModalities: ['text']`，于是 DSH 会把历史里的图片投影成占位文字，**图片
永远发不出去**；这张卡片就是那个开关。

| 接口 | 说明 |
|---|---|
| `GET /api/dsh-ofm-huawei-codearts/models` | 目录（含默认被过滤的 `-VL-` 视觉模型）+ 覆盖后的有效表 |
| `POST /api/dsh-ofm-huawei-codearts/models` | 保存 `{ models, removed }`；`{ reset: true }` 恢复目录默认 |

写路径**回环限定**（模型能力会改变请求体形状：是否携带 base64 图片）。

### 只存差异（为什么不是照抄 keypool 的整表）

华为云目录每 2 小时刷新一次。整表落盘会让上游新增模型永远看不见，所以
`$DSH_HOME/dsh-ofm-huawei-codearts/models.json`（`CODEARTS_MODELS_FILE` 可覆盖，
原子写 0600）只存 **与目录不同的行** + **目录里没有的新增行** + **显式移除的
id**；未改动的行不入库，上游改名/改窗口会自动跟随。保存后**无需重启**：
读缓存按 mtime 失效（`src/model-settings.js`）。

### 勾「图片」之后发生什么

- `listModels` / `resolveModel` / `prepareCall` 返回该模型的 `inputModalities`
  含 `image`，DSH 才会把图片块交给适配器；
- `serializeMessages` 把图片块投影成 OpenAI `image_url` 的 data URL（附件由
  `ctx.get('attachments')` 读取）；工具结果里内嵌的图片按 OpenAI 约定提升为
  紧随其后的独立 user 消息；
- 没勾的模型行为**逐字节不变**：非文本块直接丢弃（DSH 那边本就已经投影成
  占位文字）；
- 读不到图（没有附件服务/附件损坏）只把该图换成占位文字，**不让整轮请求失败**。

⚠️ **风险**：CodeArts 端点历史上**拒绝非文本块并回空流**（旧注释即为此）。
因此默认只有 `-VL-` 行需要用户主动勾选；勾错随时取消并保存即恢复。

## 并发与会话头（2026-10-31 修复）

CodeArts 后端按**会话**统计并发，超限时报 `TM.00001041`「并发会话数已达上限」。
CodeArts Agent IDE 内核（vscode-codebot 26.10.2）在 `/chat/completions` 上发送
`user-session-id` / `x-ot-session-id` / `x-ot-parent-session-id` 等会话头；
旧适配器只发 `Chat-Id`/`Session-Id` 且所有请求共用同一个随机 id，反代场景下
后端会话计数与请求对不上，几次并发就撞上限。

现在适配器把 DSH 的 `GenerateOptions.sessionId` 哈希成 32 位 hex 作为会话头
（`src/session-headers.js`）：同一 DSH 会话的请求归并到一个 CodeArts 会话，
不同会话互不挤占；队列轮询的 `task_id` 也用同一 id。无会话上下文（一次性
调用）时回落到适配器实例的随机 id。并发上限本身仍由后端决定（IDE 侧建议
最多 2 个并发对话）。

## 已知边界

- 不显示 OFM 的“白嫖模型接入”页里的华为卡片（见上）；
- 不恢复 magpie 工作台的 `huaweicloud` MaaS 预设（那是 OFM 内部策略，只有 fork 能改）；
- 凭据刷新令牌过期后没有登录页，需要重新登录（可用 CodeArts IDE 或旧 fork 的渠道页）；
- 自动签到依赖凭据 AK/SK/security_token；凭据过期时该轮记为失败、不写日期，
  刷新凭据后下次启动会自动补签。
