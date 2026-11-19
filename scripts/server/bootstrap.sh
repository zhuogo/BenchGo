#!/usr/bin/env bash
set -euo pipefail
umask 077
source_name=${1:-mirror}
operation=${2:-connect}
case "$source_name" in mirror|github) ;; *) echo '无效下载源' >&2; exit 1;; esac
case "$operation" in connect|update|check) ;; *) echo '无效安装操作' >&2; exit 1;; esac
case "$(uname -s)" in Linux) ;; *) echo '需要 Linux 服务器' >&2; exit 1;; esac
case "$(uname -m)" in x86_64) node_arch=x64;; *) echo '当前服务器包仅支持 Linux x64，暂不支持 ARM64' >&2; exit 1;; esac
libc=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
if [[ ! "$libc" =~ ^glibc[[:space:]]+([0-9]+)\.([0-9]+)$ ]] || (( BASH_REMATCH[1] < 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] < 28) )); then
  echo '需要 glibc 2.28 或更新版本' >&2; exit 1
fi
missing=()
for command_name in tar curl sha256sum xz awk; do
  command -v "$command_name" >/dev/null || missing+=("$command_name")
done
if (( ${#missing[@]} )); then
  if command -v dnf >/dev/null; then install_command='dnf install -y tar curl coreutils xz gawk'
  elif command -v apt-get >/dev/null; then install_command='apt-get install -y tar curl coreutils xz-utils gawk'
  else install_command='安装 tar、curl、coreutils、xz 和 awk'; fi
  echo "缺少命令：${missing[*]}；请管理员执行：$install_command" >&2; exit 1
fi
command -v systemctl >/dev/null && command -v loginctl >/dev/null || { echo '需要 systemd 和 loginctl' >&2; exit 1; }
systemctl --system show-environment >/dev/null 2>&1 || { echo 'systemd 未运行，请使用已启动 systemd 的服务器' >&2; exit 1; }
user_id=$(id -u)
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$user_id}
export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}
user_ready=false
systemctl --user show-environment >/dev/null 2>&1 && user_ready=true
linger=$(loginctl show-user "$user_id" --property=Linger --value 2>/dev/null || true)
can_prepare=false
if [ "$user_ready" != true ] || [ "$linger" != yes ]; then
  if [ "$user_id" = 0 ]; then can_prepare=true
  elif command -v sudo >/dev/null && sudo -n -l -- loginctl enable-linger "$user_id" >/dev/null 2>&1 && sudo -n -l -- systemctl start "user@$user_id.service" >/dev/null 2>&1; then can_prepare=true; fi
fi
if { [ "$user_ready" != true ] || [ "$linger" != yes ]; } && [ "$can_prepare" != true ]; then
  echo "请管理员执行：loginctl enable-linger $user_id && systemctl start user@$user_id.service" >&2; exit 1
fi
if [ "$operation" = check ]; then
  service_state=ready
  if [ "$user_ready" != true ] || [ "$linger" != yes ]; then service_state=prepare; fi
  printf '{"platform":"linux","arch":"x64","service":"%s"}\n' "$service_state"
  exit 0
fi
if [ "$user_ready" != true ] || [ "$linger" != yes ]; then
  if [ "$user_id" = 0 ]; then
    loginctl enable-linger "$user_id"
    systemctl start "user@$user_id.service"
  else
    sudo -n loginctl enable-linger "$user_id"
    sudo -n systemctl start "user@$user_id.service"
  fi
fi
systemctl --user show-environment >/dev/null 2>&1 || { echo '无法启动 systemd 用户服务' >&2; exit 1; }
node_root="$HOME/.local/share/benchgo/node"
if [ -x "$node_root/bin/node" ]; then export PATH="$node_root/bin:$PATH"; fi
node_binary=$(command -v node || true)
if [ -z "$node_binary" ] || ! command -v npm >/dev/null || ! "$node_binary" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||(a===24&&b>=9)?0:1)' >/dev/null 2>&1; then
  node_version=24.22.3
  node_file="node-v$node_version-linux-$node_arch.tar.xz"
  work=$(mktemp -d)
  trap 'rm -rf -- "$work"' EXIT
  node_url="https://nodejs.org/dist/v$node_version"
  if [ "$source_name" = mirror ]; then node_url="https://npmmirror.com/mirrors/node/v$node_version"; fi
  echo '下载并校验 Node.js…' >&2
  curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 15 --max-time 300 "$node_url/$node_file" -o "$work/$node_file"
  curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 15 --max-time 60 "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
  checksum=$(awk -v name="$node_file" '$2==name { print }' "$work/SHASUMS256.txt")
  [ -n "$checksum" ] || { echo '未找到 Node.js 官方校验值' >&2; exit 1; }
  (cd "$work" && echo "$checksum" | sha256sum --check --status)
  mkdir -p -- "$node_root"
  tar -xJf "$work/$node_file" -C "$node_root" --strip-components=1
  node_binary="$node_root/bin/node"
fi
export PATH="$(dirname "$node_binary"):$PATH"
exec "$node_binary" "$(dirname "$0")/bootstrap.mjs" "$source_name" "$operation"
