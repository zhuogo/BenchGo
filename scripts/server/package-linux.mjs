/** Linux server distribution. The current native tool dependency supports Linux x64 only. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { packageServerSeed } from './package-seed.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tar = createRequire(join(root, 'plugins/benchgo/package.json'))('tar');
const seedFiles = ['bootstrap.sh', 'bootstrap.mjs', 'manifest.json', 'server-seed.tar.gz'];
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const linuxVerification = ['server-seed-sha256', 'server-seed-safe-paths', 'linux-x64-native-worker', 'current-bootstrap', 'distribution-inventory'];

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Inspect before any extraction; do not mistake an architecture-specific executable for portable JS. */
export async function verifyLinuxSeed(archive, { pluginVersion } = {}) {
  const seen = new Set(), captures = new Map(), errors = [];
  const required = ['release.json', 'node_modules/benchgo-plugin/package.json', 'node_modules/benchgo-plugin/src/plugin.mjs',
    'node_modules/benchgo-plugin/lib/client.js', 'node_modules/benchgo-plugin/lib/link-web/index.html',
    'node_modules/benchgo-plugin/node_modules/dsh-ops/runtime/linux-x64/dsh-ops-worker'];
  let bytes = 0;
  await tar.t({ file: archive, strict: true, onReadEntry(entry) {
    const name = entry.path.replace(/\/$/, '');
    if (!name || /^[\/\\]/.test(name) || name.includes('\\') || name.includes(':') || name.split('/').some(part => part === '..' || part === '.')
      || !['release.json', 'node_modules'].includes(name.split('/')[0]) || seen.has(name)
      || !['File', 'Directory'].includes(entry.type)) errors.push(`Unsafe seed entry: ${entry.path}`);
    seen.add(name); bytes += entry.size;
    if (seen.size > 60_000 || bytes > 1024 ** 3) errors.push('Server seed exceeds unpacked limits');
    if (name.endsWith('.node') || /\/runtime\/(?:win32-|darwin-|linux-arm64(?:\/|$))/.test(name)) errors.push(`Non-Linux-x64 payload: ${name}`);
    const metadata = ['release.json', 'node_modules/benchgo-plugin/package.json'].includes(name);
    const worker = name === required.at(-1);
    if (worker && !(entry.mode & 0o111)) errors.push('Linux x64 native worker has no executable permissions; build on Linux');
    if (metadata || worker) {
      const parts = []; let length = 0;
      entry.on('data', chunk => { if (length < (metadata ? 512 * 1024 : 64)) { parts.push(chunk.subarray(0, (metadata ? 512 * 1024 : 64) - length)); length += parts.at(-1).length; } });
      entry.on('end', () => captures.set(name, Buffer.concat(parts)));
      if (metadata && entry.size > 512 * 1024) errors.push(`Oversized seed metadata: ${name}`);
    }
  } });
  if (errors.length) throw new Error(errors[0]);
  for (const name of required) if (!seen.has(name)) throw new Error(`Missing server seed entry: ${name}`);
  const release = JSON.parse(captures.get('release.json'));
  const plugin = JSON.parse(captures.get('node_modules/benchgo-plugin/package.json'));
  if (release.schemaVersion !== 1 || release.platform !== 'linux' || release.arch && release.arch !== 'x64'
    || release.version !== pluginVersion || plugin.name !== 'benchgo-plugin' || plugin.version !== pluginVersion) throw new Error('Server seed identity differs from release');
  const worker = captures.get(required.at(-1));
  if (worker.length < 20 || worker.subarray(0, 4).toString('hex') !== '7f454c46' || worker[4] !== 2 || worker[5] !== 1 || worker.readUInt16LE(18) !== 62) throw new Error('Linux x64 native worker is not an ELF x86-64 executable');
  return { entries: seen.size, unpackedBytes: bytes };
}

function readme(version, pluginVersion, upstream) {
  return `# BenchGo ${version} · Linux 服务端\n\n此包安装无桌面窗口的 BenchGo 工作台，由 Windows / macOS / Android 客户端通过 Link 连接；不是 Linux Desktop。\n\n## 要求\n\n- Ubuntu / Debian、x86_64 (x64)、可用的 systemd 用户服务；本包不支持 ARM64。\n- bash、tar、curl、sha256sum，能够访问所选 npm 源与 Node.js 官方校验源。\n- 普通用户安装，不使用 sudo 启动安装脚本。离线插件依赖已随包提供；首次安装仍需联网安装固定版本官方 Harness ${upstream.version} 和必要时的 Node.js 24.9+。\n- 开机/退出 SSH 后常驻需管理员为该用户启用 loginctl enable-linger。\n\n## 安装与连接\n\n1. 先用发行页 SHA256SUMS.txt 或同名 .sha256 文件校验下载的归档，再解压。\n2. 在解压目录运行以下命令（github 可替换为 mirror，下载失败不会静默切换）：\n\n\`\`\`sh\n(umask 077; bash install.sh github connect > connection.json)\n\`\`\`\n\nconnection.json 包含设备授权凭据，只应由当前用户保管；不要上传、贴入工单或公开分享。推荐通过 BenchGo「设备 → 添加 → SSH 服务器」完成完整连接路径；此脚本复用该路径的服务部署和私有连接响应。服务仅监听 127.0.0.1，通过可信 SSH 通道连接，不能把本地端口当作公网下载/管理入口。脚本失败保留已有数据。\n\n## 更新与管理\n\n升级前结束服务器上的活动任务，下载新发行包、校验、解压后运行：\n\n\`\`\`sh\n(umask 077; bash install.sh github update > update-result.json)\nsystemctl --user status benchgo.service\njournalctl --user -u benchgo.service -n 100\nsystemctl --user stop benchgo.service\n\`\`\`\n\n同引擎版本的插件可原位更新；引擎变化需维护者迁移，脚本会明确拒绝自动升级。数据位于 ~/.local/share/benchgo/server/。移除客户端设备不等于卸载服务；本包不自动删除会话和项目数据。\n\n## 版本、校验与许可\n\n应用 ${version}，功能包 ${pluginVersion}，官方引擎 ${upstream.version}（${upstream.commit}）。归档中的 release-source.json 记录源码提交；SHA256SUMS.txt 校验内部文件。顶层 LICENSE 为 BenchGo MIT，DEEPSEEK-LICENSE 为官方引擎声明；插件及依赖的第三方许可保留在 server-seed.tar.gz 内。官方 Harness 运行时按固定版本从 npm 安装，不包含在本归档中。\n`;
}

/** Build an inventory-bound wrapper around a freshly created, checked server seed. */
export async function assembleLinuxServer({ seedDirectory, output, sourceSha, rootDirectory = root }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Linux distribution requires immutable source SHA');
  const app = JSON.parse(await readFile(join(rootDirectory, 'package.json')));
  const plugin = JSON.parse(await readFile(join(rootDirectory, 'plugins/benchgo/package.json')));
  const upstream = JSON.parse(await readFile(join(rootDirectory, 'upstream.json')));
  if (!stableVersion.test(app.version) || !stableVersion.test(plugin.version)) throw new Error('Invalid distribution version');
  const manifest = JSON.parse(await readFile(join(seedDirectory, 'manifest.json')));
  if (manifest.schemaVersion !== 1 || manifest.pluginVersion !== plugin.version || manifest.harnessVersion !== upstream.version
    || manifest.harnessCommit !== upstream.commit || !/^[a-f0-9]{64}$/.test(manifest.sha256)
    || await digest(join(seedDirectory, 'server-seed.tar.gz')) !== manifest.sha256) throw new Error('Server seed checksum or identity mismatch');
  await verifyLinuxSeed(join(seedDirectory, 'server-seed.tar.gz'), { pluginVersion: plugin.version });
  for (const name of ['bootstrap.sh', 'bootstrap.mjs']) {
    if (!(await readFile(join(seedDirectory, name))).equals(await readFile(join(rootDirectory, 'scripts/server', name)))) throw new Error(`Server seed has stale bootstrap: ${name}`);
  }
  const destination = resolve(output);
  await mkdir(destination, { recursive: true });
  if ((await readdir(destination)).length) throw new Error('Linux distribution output must be empty');
  const temporary = await mkdtemp(join(tmpdir(), 'benchgo-linux-package-'));
  const name = `benchgo-${app.version}-linux-server`, archiveName = `${name}.tar.gz`;
  try {
    const stage = join(temporary, name); await mkdir(stage);
    for (const file of seedFiles) await cp(join(seedDirectory, file), join(stage, file));
    await cp(join(rootDirectory, 'LICENSE'), join(stage, 'LICENSE'));
    await cp(join(rootDirectory, 'deepseek-harness/LICENSE'), join(stage, 'DEEPSEEK-LICENSE'));
    await writeFile(join(stage, 'README.md'), readme(app.version, plugin.version, upstream));
    await writeFile(join(stage, 'install.sh'), '#!/usr/bin/env bash\nset -euo pipefail\numask 077\ncd -- "$(dirname -- "$0")"\n[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || { echo "此发行包仅支持 Linux x64" >&2; exit 1; }\nsha256sum --check --status SHA256SUMS.txt\nexec bash ./bootstrap.sh "${1:-mirror}" "${2:-connect}"\n', { mode: 0o755 });
    await writeFile(join(stage, 'release-source.json'), JSON.stringify({ schemaVersion: 1, sourceSha, version: app.version,
      pluginVersion: plugin.version, platform: 'linux', arch: 'x64', kind: 'server', engine: upstream,
      releaseVersion: plugin.benchgo?.releaseVersion ?? null, runtimeIncluded: false, supportedDistributions: ['ubuntu', 'debian'] }, null, 2) + '\n');
    const names = (await readdir(stage)).sort();
    const sums = [];
    for (const file of names) sums.push(`${await digest(join(stage, file))}  ${file}`);
    await writeFile(join(stage, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
    await tar.c({ file: join(destination, archiveName), cwd: temporary, gzip: true, portable: true, noMtime: true }, [name]);
    const actual = [];
    await tar.t({ file: join(destination, archiveName), strict: true, onReadEntry(entry) { actual.push(entry.path.replace(/\/$/, '')); } });
    const expected = [name, ...names.map(file => `${name}/${file}`), `${name}/SHA256SUMS.txt`].sort();
    if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)) throw new Error('Linux distribution inventory mismatch');
    const checksumName = `${archiveName}.sha256`;
    await writeFile(join(destination, checksumName), `${await digest(join(destination, archiveName))}  ${archiveName}\n`);
    const files = [];
    for (const file of [archiveName, checksumName]) files.push({ name: file, size: (await stat(join(destination, file))).size, sha256: await digest(join(destination, file)) });
    const receipt = { schemaVersion: 1, sourceSha, version: app.version, pluginVersion: plugin.version, platform: 'linux', arch: 'x64', kind: 'server', verified: linuxVerification, files };
    await writeFile(join(destination, 'build-source.json'), JSON.stringify(receipt, null, 2) + '\n');
    return receipt;
  } catch (error) {
    for (const file of [archiveName, `${archiveName}.sha256`, 'build-source.json']) await rm(join(destination, file), { force: true });
    throw error;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function packageLinuxServer({ output = join(root, 'artifacts/linux-server') } = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Build the Linux x64 server distribution on a Linux x64 runner to preserve native executable permissions');
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  for (const expected of [process.env.SOURCE_SHA, process.env.GITHUB_SHA].filter(Boolean)) if (expected !== sourceSha) throw new Error('Linux package checkout differs from workflow source');
  const temporary = await mkdtemp(join(tmpdir(), 'benchgo-linux-seed-'));
  try {
    await packageServerSeed({ output: temporary });
    return await assembleLinuxServer({ seedDirectory: temporary, output, sourceSha });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  packageLinuxServer({ output: values.out }).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
