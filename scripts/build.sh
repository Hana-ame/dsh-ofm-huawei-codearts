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
# - DEPS_DIR：包含 undici / jose 的 node_modules 目录；不设时尝试相邻的
#   dsh-our-free-model checkout。构建时临时软链为 ./node_modules，结束后删除。
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
