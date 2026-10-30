#!/usr/bin/env bash
# 构建 ofm-huawei-codearts 的单文件 ESM 产物 index.js。
#
# 必须带 createRequire banner：依赖里的 undici 是 CJS，会调用
# require("node:assert")；纯 ESM 产物没有 require 会直接抛
# "Dynamic require of ... is not supported"。上游 channel-pack 的构建脚本
# 也用了同一个办法（scripts/build-channel-pack.mjs:67）。
#
# 用法：
#   ESBUILD_BIN=/path/to/esbuild ./scripts/build.sh
#
# - ESBUILD_BIN：esbuild 可执行文件；不设时只查 PATH 里的 esbuild。
# - DEPS_DIR：包含 undici / jose 的 node_modules 目录；不设时优先
#   `$HOME/.dsh/build-deps/node_modules`，再退回 dsh-our-free-model checkout。
#   构建时临时软链为 ./node_modules，结束后删除。
#   ⚠️ undici 必须是 8.x：低版本缺 `Dispatcher1Wrapper`，代理路径运行时会
#   抛 `Dispatcher1Wrapper is not a constructor`（直连不触发，极难定位）。
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "${ESBUILD_BIN:-}" ]; then
  ESBUILD="$ESBUILD_BIN"
elif command -v esbuild >/dev/null 2>&1; then
  ESBUILD="$(command -v esbuild)"
else
  echo "build: 找不到 esbuild；设置 ESBUILD_BIN 指向 esbuild 可执行文件" >&2
  exit 1
fi

if [ -z "${DEPS_DIR:-}" ]; then
  for candidate in \
    "$HOME/.dsh/build-deps/node_modules" \
    "$HOME/forks/dsh-our-free-model/node_modules" \
    "$HOME/code/dsh-our-free-model/node_modules" \
    "$HOME/dsh-our-free-model/node_modules"; do
    if [ -d "$candidate/undici" ] && [ -d "$candidate/jose" ]; then
      DEPS_DIR="$candidate"
      break
    fi
  done
fi
if [ -z "${DEPS_DIR:-}" ]; then
  echo "build: 找不到含 undici/jose 的 node_modules；请设置 DEPS_DIR" >&2
  exit 1
fi

# ⚠️ undici 必须是 8.x（含 Dispatcher1Wrapper 兼容桥）。
# 实测用 6.x/7.x 构建也能成功，但运行时代理路径会抛
# `Dispatcher1Wrapper is not a constructor`——只在真正走环境代理时暴露
#（直连正常），极难定位。构建期直接校验并给出明确错误。
UNDICI_MAJOR="$(node -p "require('${DEPS_DIR}/undici/package.json').version.split('.')[0]" 2>/dev/null || echo 0)"
if [ "${UNDICI_MAJOR:-0}" -lt 8 ]; then
  echo "build: DEPS_DIR=${DEPS_DIR} 的 undici 版本过旧（需要 8.x，含 Dispatcher1Wrapper）；" >&2
  echo "build: 用旧版本构建出的产物在走环境代理时会抛 'Dispatcher1Wrapper is not a constructor'" >&2
  echo "build: 请改用 \$HOME/.dsh/build-deps/node_modules 或设置 DEPS_DIR 指向含 undici 8.x 的目录" >&2
  exit 1
fi

cleanup() { rm -f node_modules; }
trap cleanup EXIT
ln -sfn "$DEPS_DIR" node_modules

"$ESBUILD" src/index.ts \
  --bundle --format=esm --platform=node --target=node22 \
  --external:@deepseek-ai/* --external:node:* \
  --banner:js='import { createRequire as __ofmCreateRequire } from "node:module"
const require = __ofmCreateRequire(import.meta.url)' \
  --outfile=index.js --log-level=warning

echo "build: index.js $(wc -c < index.js) bytes（依赖：$DEPS_DIR）"
