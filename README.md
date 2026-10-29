# 华为云 CodeArts 插件（dsh-ofm-huawei-codearts）

把上游 `dsh-our-free-model` 在 2.5.9 删除的**华为云 CodeArts** 渠道加回来。

特点：

- 用**独立插件**的方式恢复，不修改 `dsh-our-free-model` 任何一个字节；
- 在 DSH 模型选择器里注册 `codearts` provider，显示为 **CodeArts Agent**；
- 复用已有账号与凭据，不需要重新登录（刷新令牌有效期内自动续期）；
- 保留华为的签名传输（`SDK-HMAC-SHA256`、benefit 额度重试）。

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
- 结果写回 `$DSH_HOME/channel-pack/auto-checkin.json`（schema
  `dsh-codearts-auth/auto-checkin/v1`，与上游既有文档完全兼容），当天不再触发；
- 状态文件与上游频道面板共用：`our-free-model` 的「每日自动签到」开关/状态
  读同一份文档，因此在那边关掉开关也会生效（每轮判定前都会重读磁盘）；
- 只有 claimed / already-claimed 才记为「今天已处理」；全部失败（代理抖动、
  凭据过期）**不记账**，下次启动自动重试；
- 开关判断只有**显式 `false`** 才算关闭（缺字段/旧文档一律按打开处理）。

## 已知边界

- 不显示 OFM 的“白嫖模型接入”页里的华为卡片（见上）；
- 不恢复 magpie 工作台的 `huaweicloud` MaaS 预设（那是 OFM 内部策略，只有 fork 能改）；
- 凭据刷新令牌过期后没有登录页，需要重新登录（可用 CodeArts IDE 或旧 fork 的渠道页）；
- 自动签到依赖凭据 AK/SK/security_token；凭据过期时该轮记为失败、不写日期，
  刷新凭据后下次启动会自动补签。
