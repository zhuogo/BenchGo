#!/usr/bin/env bash
set -euo pipefail

# The release tag pins this script; override only when intentionally testing another version.
version=${BENCHGO_VERSION:-0.0.1}
config=${1:-${BENCHGO_RELAY_CONFIG:-}}
case "$(uname -s)" in Linux) ;; *) echo 'BenchGo Relay 安装脚本仅支持 Linux' >&2; exit 1;; esac
command -v npm >/dev/null || { echo '需要先安装 Node.js 22+ 与 npm' >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo '需要 Node.js 22+' >&2; exit 1; }
echo "安装 benchgo-relay@$version…" >&2
npm install --global "benchgo-relay@$version"
if [ -n "$config" ]; then
  exec benchgo-relay install --config "$config"
fi
cat >&2 <<'EOF'
运行包已安装。准备包含 TLS 证书、私钥和 token 的 relay.json 后执行：
  benchgo-relay install --config /path/to/relay.json
EOF
