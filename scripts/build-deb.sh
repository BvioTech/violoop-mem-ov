#!/usr/bin/env bash
# build-deb.sh — build the violoop-mem Debian package for aarch64.
#
# 部署方式承袭 violoop-qmd:在 aarch64 主机(如 .44 盒子)上原生构建,
# `npm ci --omit=dev --include=optional` 装生产依赖(better-sqlite3 预编译经
# npmmirror 镜像;node-llama-cpp 的 @node-llama-cpp/linux-arm64 平台包来自
# npm registry,GFW 盒不需要 GitHub),然后交给 nfpm。产物在 ./dist/。
#
# better-sqlite3 装的是**预编译**原生模块,拿哪一份由构建机的 Node ABI
# (process.versions.modules)决定,而不是由本仓的任何配置决定。所以构建机
# 的 Node 大版本必须和设备镜像一致 —— 否则包照样打得出来、apt 照样装得上,
# 到盒子上才 ERR_DLOPEN_FAILED,服务起不来。0.11.1 就是这么出的事:在一台
# Node 22 的机器上打包,刷了 Node 24 镜像的盒子上记忆服务从头到尾没起来过
# (0.11.0 之前在 Node 24 上打,同样的设备就是好的)。
# 下面把这条约束从"打包的人记得"变成脚本自己拦。
set -euo pipefail

# 设备镜像的 Node 大版本。换镜像时改这里,并同步 package.json 的 engines。
TARGET_NODE_MAJOR="${TARGET_NODE_MAJOR:-24}"

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

ARCH="$(uname -m)"
if [[ "$ARCH" != "aarch64" && "$ARCH" != "arm64" ]]; then
  echo "Error: expected aarch64/arm64 host, got '$ARCH'. Build on the target platform." >&2
  exit 1
fi
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Error: expected Linux host (deb target), got '$(uname -s)'." >&2
  exit 1
fi

for bin in node npm nfpm dpkg-deb; do
  command -v "$bin" >/dev/null 2>&1 || { echo "Error: '$bin' not found on PATH." >&2; exit 1; }
done
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" != "$TARGET_NODE_MAJOR" ]]; then
  cat >&2 <<EOF
Error: 构建机 Node 是 v$(node -p 'process.versions.node'),设备镜像要的是 Node ${TARGET_NODE_MAJOR}.x。

  预编译的 better-sqlite3 会绑死构建机的 Node ABI,大版本对不上就装得上、起不来。
  换一台 Node ${TARGET_NODE_MAJOR}.x 的 aarch64 盒子构建;设备镜像确实换了 Node 版本的话,
  改本脚本顶部的 TARGET_NODE_MAJOR(并同步 package.json 的 engines)。
EOF
  exit 1
fi
# deb 的 Depends 跟着实际构建环境走,让 apt 在装的时候就挡住错配的包。
NODE_DEP_MIN="nodejs (>= ${TARGET_NODE_MAJOR})"
NODE_DEP_MAX="nodejs (<< $((TARGET_NODE_MAJOR + 1)))"
export NODE_DEP_MIN NODE_DEP_MAX

# Python dependencies also contain ABI-specific wheels. Match the package's
# Debian 12 Python dependency before assembling a runtime.
if [ ! -x .venv/bin/python ] || [ "$(.venv/bin/python -c 'import sys; print("%s.%s" % sys.version_info[:2])')" != "3.11" ]; then
  echo 'Error: device packages require a local Python 3.11 environment. Run npm run setup -- --python 3.11 in a clean build checkout.' >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
OUT_DEB="dist/violoop-mem_${VERSION}_arm64.deb"
echo ">> Building $OUT_DEB"

echo ">> npm ci (production deps + platform-native optionals)"
# npmmirror 双保险:CN 网络下 registry 与 better-sqlite3 预编译都不走 GitHub。
# CI 跑在墙外,走官方源 —— 权威、没有镜像同步延迟(这个包的内容就是原生
# 二进制,拿错版本的代价见 TARGET_NODE_MAJOR 那段注释)。显式设了环境变量
# 的话两种场景都以它为准。
if [[ -z "${CI:-}" ]]; then
  export npm_config_registry="${npm_config_registry:-https://registry.npmmirror.com}"
  export npm_config_better_sqlite3_binary_host_mirror="${npm_config_better_sqlite3_binary_host_mirror:-https://npmmirror.com/mirrors/better-sqlite3}"
fi
npm ci --omit=dev --include=optional

# 版本号相等还不够 —— npm 缓存里留着别的 ABI 的 prebuild、镜像站发错包,
# 都能让 node_modules 里躺着一个加载不了的 .node。这里真的 require 一次,
# 拿打包机自己的 node 验,失败就别打包了。
echo ">> 自检:原生模块能否在 Node ${TARGET_NODE_MAJOR}.x 下加载"
node -e '
const Database = require("better-sqlite3")
const db = new Database(":memory:")
db.exec("CREATE TABLE t(x)")
db.close()
console.log(`   better-sqlite3 OK (Node v${process.versions.node}, ABI ${process.versions.modules})`)
' || {
  echo "Error: better-sqlite3 原生模块加载失败 —— 打出来的包在设备上也起不来。" >&2
  echo "  清一下 npm 缓存(npm cache clean --force)再 npm ci 重试。" >&2
  exit 1
}

# node-llama-cpp 会带上全平台的可选包;裁掉非 linux-arm64 的,包体小一半以上。
echo ">> pruning non-linux-arm64 platform packages"
find node_modules/@node-llama-cpp -maxdepth 1 -mindepth 1 -type d \
  ! -name 'linux-arm64*' -exec rm -rf {} + 2>/dev/null || true

# Always build current source. Reusing a directory left by an older build would
# silently ship an old engine while packaging the current JavaScript adapter.
python3 scripts/build.py
python3 scripts/build-openviking-runtime.py --replace
mkdir -p dist
echo ">> nfpm package"
VERSION="$VERSION" nfpm package --config scripts/nfpm.yaml --packager deb --target "$OUT_DEB"
echo ">> smoke test: extracted package runtime"
bash "$SCRIPT_DIR/check-deb.sh" "$OUT_DEB"
echo ">> done: $OUT_DEB"
ls -lh "$OUT_DEB"
