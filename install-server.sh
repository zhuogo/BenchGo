#!/usr/bin/env bash
set -euo pipefail
umask 077

version=${BENCHGO_VERSION:-0.1.4}
release_version=${BENCHGO_RELEASE_VERSION:-0.1.5}
source_name=${1:-github}
operation=${2:-connect}
local_archive=${3:-}
fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail '安装版本无效'
[[ "$release_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail '发行版本无效'
case "$source_name" in github|mirror) ;; *) fail '无效下载源';; esac
case "$operation" in connect|update) ;; *) fail '无效安装操作';; esac
[ "$#" -le 3 ] || fail '安装参数过多'
[ "$(uname -s)" = Linux ] || fail '仅支持 Linux 服务器'
[ "$(uname -m)" = x86_64 ] || fail '当前服务器包仅支持 x64'
for command in curl tar sha256sum awk mktemp wc chmod mv; do
  command -v "$command" >/dev/null || fail "缺少 $command，请通过系统包管理器安装后重试"
done

name="benchgo-$version-linux-server"
archive="$name.tar.gz"
official_url="https://github.com/zhuogo/BenchGo/releases/download/v$release_version"
url="$official_url"
if [ "$source_name" = mirror ]; then url="https://ghfast.top/$url"; fi
work=$(mktemp -d)
response=''
trap 'rm -rf -- "$work"; if [ -n "$response" ]; then rm -f -- "$response"; fi' EXIT
download() {
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --connect-timeout 15 --max-time 600 --max-filesize "$2" "${3:-$url}/$1" -o "$work/$1" || fail '下载失败，请重试或选择其他下载源'
}
printf '%s\n' '准备安装…' >&2
archive_file="$work/$archive"
if [ -n "$local_archive" ]; then
  [ -f "$local_archive" ] && [ "${local_archive##*/}" = "$archive" ] && [ -f "$local_archive.sha256" ] || fail '找不到匹配版本的安装包和校验文件'
  [ "$(wc -c < "$local_archive")" -le 536870912 ] && [ "$(wc -c < "$local_archive.sha256")" -le 4096 ] || fail '安装包或校验文件过大'
  cp -- "$local_archive" "$archive_file"
  cp -- "$local_archive.sha256" "$archive_file.sha256"
else
  download "$archive" 536870912
  download "$archive.sha256" 4096 "$official_url"
fi
read -r checksum filename extra < "$archive_file.sha256" || fail '下载包校验文件无效'
[[ "$checksum" =~ ^[a-fA-F0-9]{64}$ ]] && [ "${filename#\*}" = "$archive" ] && [ -z "${extra:-}" ] || fail '下载包校验文件无效'
[ "$(wc -l < "$work/$archive.sha256")" -le 1 ] || fail '下载包校验文件无效'
actual=$(sha256sum "$work/$archive")
[ "${actual%% *}" = "${checksum,,}" ] || fail '下载包校验失败'

# The published wrapper contains one directory and a finite flat file set.
tar -tzf "$work/$archive" > "$work/entries" || fail '安装包无效'
awk -v root="$name" '
  BEGIN { split("bootstrap.sh bootstrap.mjs manifest.json server-seed.tar.gz install.sh README.md LICENSE DEEPSEEK-LICENSE release-source.json SHA256SUMS.txt resources.json update-public-key.pem", names, " "); for (i in names) allowed[names[i]]=1 }
  { path=$0; sub(/\/$/, "", path); if (seen[path]++ || ++count>13) exit 1; if (path==root) next; if (index(path,root "/")!=1) exit 1; file=substr(path,length(root)+2); if (!(file in allowed)) exit 1; found[file]=1 }
  END { split("bootstrap.sh bootstrap.mjs manifest.json server-seed.tar.gz install.sh SHA256SUMS.txt", required, " "); for (i in required) if (!found[required[i]]) exit 1 }
' "$work/entries" || fail '安装包包含无效路径'
tar -tvzf "$work/$archive" --numeric-owner > "$work/metadata" || fail '安装包无效'
awk -v root="$name" '
  { type=substr($1,1,1); if (type!="-" && type!="d") exit 1; if (type=="d" && $NF!=root "/") exit 1; if ($3 !~ /^[0-9]+$/ || (total+=$3)>545259520) exit 1; if ($NF!=root "/server-seed.tar.gz" && $3>1048576) exit 1 }
' "$work/metadata" || fail '安装包包含无效文件'
tar -xzf "$work/$archive" -C "$work" --no-same-owner --no-same-permissions || fail '无法解压安装包'

directory="$HOME/.local/share/benchgo/server"
mkdir -p -- "$directory"
response=$(mktemp "$directory/.connection-XXXXXX")
bash "$work/$name/install.sh" "$source_name" "$operation" > "$response"
[ -s "$response" ] || fail '安装器未返回结果'
chmod 600 "$response"
mv -f -- "$response" "$directory/connection.json"
response=''
printf '%s\n' '安装完成'
