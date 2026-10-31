#!/usr/bin/env bash
# 把本插件装进一个 DSH profile —— **clone 下来即插即用**。
#
#   ./scripts/install.sh [profile]        # profile 默认 web
#   ./scripts/install.sh web --dry-run    # 只看会做什么，不落盘
#
# 幂等三步（都不需要联网、不需要构建：index.js 是仓库里预构建好的产物）：
#   1) 在 $DSH_HOME/profiles/<profile>/node_modules 下建软链 → 本仓库目录
#   2) 在 profile package.json 的 dependencies 里登记 "link:<本仓库绝对路径>"
#   3) 把包名加进 dsh.profile.bundles（DSH 只加载 bundles 里列出的包）
#
# 装完重启 DSH（`dsh web`），模型选择器里就会出现 provider **CodeArts Agent**。
# 全新机器没有历史凭据时，去 设置 → 华为云 CodeArts → 「重新登录 CodeArts」走一次授权。
set -euo pipefail

NAME="dsh-ofm-huawei-codearts"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="web"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) PROFILE="$arg" ;;
  esac
done
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PKG="$PROFILE_DIR/package.json"

echo "插件目录 : $REPO"
echo "DSH_HOME : $DSH_HOME"
echo "profile  : $PROFILE  ($PROFILE_DIR)"

[ -f "$REPO/index.js" ] || { echo "✗ 缺 index.js（应为仓库自带的预构建产物）" >&2; exit 1; }
[ -f "$PKG" ] || { echo "✗ 找不到 $PKG —— profile 名对吗？（可选：web / tui / headless）" >&2; exit 1; }

# 1) node_modules 软链
LINK="$PROFILE_DIR/node_modules/$NAME"
if [ -L "$LINK" ]; then
  echo "• node_modules 软链已存在：$(readlink "$LINK")"
elif [ -e "$LINK" ]; then
  echo "✗ $LINK 已存在且不是软链（pnpm 装过？）——请手动处理，脚本不覆盖" >&2
  exit 1
elif [ "$DRY_RUN" = 1 ]; then
  echo "• [dry-run] 会建软链 $LINK → $REPO"
else
  mkdir -p "$PROFILE_DIR/node_modules"
  ln -sfn "$REPO" "$LINK"
  echo "• 已建软链：$LINK → $REPO"
fi

# 2)+3) 改 profile package.json（先备份）
if [ "$DRY_RUN" = 1 ]; then
  echo "• [dry-run] 会在 $PKG 里登记 dependencies[\"$NAME\"]=\"link:$REPO\" 并把 \"$NAME\" 追加到 dsh.profile.bundles"
  exit 0
fi
BACKUP="$PKG.bak-install-$(date +%Y%m%d-%H%M%S)"
cp "$PKG" "$BACKUP"
node - "$PKG" "$REPO" "$NAME" <<'NODE'
const fs = require('node:fs')
const [pkgPath, repo, name] = process.argv.slice(2)
const json = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
json.dependencies = json.dependencies ?? {}
json.dependencies[name] = `link:${repo}`
json.dsh = json.dsh ?? {}
json.dsh.profile = json.dsh.profile ?? {}
const bundles = (json.dsh.profile.bundles = json.dsh.profile.bundles ?? [])
if (!bundles.includes(name)) bundles.push(name)
fs.writeFileSync(pkgPath, JSON.stringify(json, null, 2) + '\n')
console.log(`• ${name} 已登记进 dependencies 与 dsh.profile.bundles`)
NODE
echo "• 备份：$BACKUP"

cat <<'NEXT'

装好了，接下来：
  1. 重启 DSH：              dsh web            （或你平时用的 profile 名）
  2. 首次使用要授权：        设置 → 华为云 CodeArts → 「重新登录 CodeArts」
     （本机若跑过 dsh-our-free-model，凭据会被直接复用，跳过这步）
  3. 想看目录/上下文/输出上限： 设置 → 华为云 CodeArts → 「模型与图片能力」
NEXT