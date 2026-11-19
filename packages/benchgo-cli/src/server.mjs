/** The existing SSH/systemd server remains an explicit, independently managed installation. */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, exists } from './artifacts.mjs';
import { shared } from './shared.mjs';

export const serverDirectory = ({ userHome = homedir() } = {}) => join(userHome, '.local', 'share', 'benchgo', 'server');
export async function readServerInstallation(options = {}) {
  try {
    const value = JSON.parse(await readFile(join(serverDirectory(options), 'installation.json'), 'utf8'));
    if (value.schemaVersion !== 1 || typeof value.runtime !== 'string' || typeof value.profile !== 'string') throw new Error('已有服务器安装记录无效，原环境已保留');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function serverCommand(action, options = {}, { runCommand = command, platform = process.platform } = {}) {
  if (platform !== 'linux') throw new Error('SSH/systemd 服务器入口仅用于 Linux；本机工作台请使用 benchgo install/start/status');
  const installation = await readServerInstallation(options);
  if (action === 'status') {
    const service = await runCommand('systemctl', ['--user', 'is-active', 'benchgo.service'], { capture: true, allowFailure: true });
    return { installed: !!installation, kind: 'server', service: service.stdout.trim() || 'unknown', installation };
  }
  if (['start', 'stop', 'restart'].includes(action)) {
    if (!installation) throw new Error('服务器工作台尚未安装');
    const result = await runCommand('systemctl', ['--user', action, 'benchgo.service'], { capture: true });
    return { installed: true, kind: 'server', action, ok: result.code === 0 };
  }
  if (!['install', 'update'].includes(action)) throw new Error(`不支持的服务器操作：${action || '(空)'}`);
  const { readWorkbenchInstallation, workbenchPaths } = await shared('workbench-installation.mjs');
  if (await readWorkbenchInstallation({ home: options.home })) throw new Error('已有本机工作台，未再创建一套服务器；请使用本机工作台命令');
  const roots = [options.root && join(options.root, 'plugins/base/lib/server'), options.root,
    fileURLToPath(new URL('../resources/server/', import.meta.url))].filter(Boolean);
  let assetsRoot;
  for (const root of roots) if (await exists(join(root, 'resources.json')) || await exists(join(root, 'manifest.json'))) { assetsRoot = resolve(root); break; }
  if (!assetsRoot) throw new Error('未找到服务器部署资源描述，请重新安装 BenchGo CLI');
  const { ensureServerResources } = await shared('server-resources.mjs');
  const result = await ensureServerResources({ assetsRoot, cacheRoot: join(workbenchPaths({ home: options.home }).cache, 'server'), source: options.source || 'mirror' });
  const completed = await runCommand('bash', [join(result.directory, 'bootstrap.sh'), options.source || 'mirror', action === 'update' ? 'update' : 'connect'], { capture: true });
  // Machine output is parsed as a whole; never mixed with local browser text.
  try { return { kind: 'server', ...JSON.parse(completed.stdout.trim()) }; }
  catch { throw new Error('服务器安装器未返回有效私有协议响应；请检查服务器状态'); }
}
