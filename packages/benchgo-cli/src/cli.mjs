import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const bundledRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliVersion = '0.0.1';

function usage() {
  return `BenchGo CLI ${cliVersion}

用法:
  benchgo install
  benchgo update
  benchgo server <install|update|status|start|stop|restart>

全局选项:
  --json       输出机器可读 JSON
  --root PATH  指定源码或发行资源目录
  --source     mirror 或 github
  --version    输出版本
  --help       显示帮助

说明:
  本命令安装和管工作台。工作台可以连接外部中继，但不安装中继服务。
  中继服务器使用独立包 @benchgo/relay 的 benchgo-relay。`;
}

function parseArgs(argv) {
  const options = { json: false, root: process.env.BENCHGO_ROOT || packageRoot };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg === '--root') options.root = argv[++i] ?? '';
    else if (arg.startsWith('--root=')) options.root = arg.slice('--root='.length);
    else if (arg === '--source') options.source = argv[++i] ?? '';
    else if (arg.startsWith('--source=')) options.source = arg.slice('--source='.length);
    else positionals.push(arg);
  }
  return { options, positionals };
}

function xdgPath(kind, name) {
  const base = kind === 'data'
    ? (process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'))
    : (process.env.XDG_CONFIG_HOME || join(homedir(), '.config'));
  return join(base, 'benchgo', name);
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function command(bin, args, { capture = false, allowFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' } });
    let stdout = '', stderr = '';
    if (capture) {
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
    }
    child.once('error', error => allowFailure ? resolvePromise({ code: null, stdout, stderr, error }) : reject(error));
    child.once('exit', code => {
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && !allowFailure) reject(new Error(stderr.trim() || `${bin} 退出码 ${result.code}`));
      else resolvePromise(result);
    });
  });
}

function serviceArgs(service, operation) {
  return ['--user', operation, service];
}

async function serviceOperation(service, operation, { json }) {
  const result = await command('systemctl', serviceArgs(service, operation), { capture: true, allowFailure: true });
  if (json) return { service, operation, ok: result.code === 0, output: result.stdout.trim() || result.stderr.trim() };
  if (result.code !== 0) throw new Error(result.stderr.trim() || `服务操作失败：${operation} ${service}`);
  return result.stdout.trim() || `${service} ${operation} 完成`;
}

async function serverStatus({ json }) {
  const stateFile = xdgPath('data', 'server/installation.json');
  let installation = null;
  try { installation = JSON.parse(await readFile(stateFile, 'utf8')); } catch {}
  const service = await command('systemctl', serviceArgs('benchgo.service', 'is-active'), { capture: true, allowFailure: true });
  const result = { installed: Boolean(installation), service: service.stdout.trim() || 'unknown', installation: installation ? { ...installation } : null };
  return json ? result : `工作台：${result.installed ? '已安装' : '未安装'}\n服务：${result.service}`;
}

async function serverCommand(action, options) {
  if (action === 'status') return serverStatus(options);
  if (['start', 'stop', 'restart'].includes(action)) return serviceOperation('benchgo.service', action, options);
  if (!['install', 'update'].includes(action)) throw new Error(`不支持的工作台操作：${action || '(空)'}`);
  const script = await exists(resolve(options.root, 'scripts/server/bootstrap.sh'))
    ? resolve(options.root, 'scripts/server/bootstrap.sh')
    : resolve(bundledRoot, 'resources/server/bootstrap.sh');
  if (!await exists(script)) throw new Error('未找到工作台安装器；请设置 BENCHGO_ROOT 指向 BenchGo 资源目录');
  const source = options.source || 'mirror';
  if (!['mirror', 'github'].includes(source)) throw new Error('下载源必须是 mirror 或 github');
  const result = await command('bash', [script, source, action === 'update' ? 'update' : 'connect']);
  return options.json ? { ok: result.code === 0, action } : `工作台${action === 'update' ? '更新' : '安装'}完成`;
}

export async function run(argv) {
  const { options, positionals } = parseArgs(argv);
  if (options.version) return cliVersion;
  if (options.help || positionals.length === 0) return usage();
  const [scope, action] = positionals;
  if (scope === 'install' || scope === 'update') return serverCommand(scope, options);
  if (scope === 'server') return serverCommand(action, options);
  if (scope === 'relay') throw new Error('中继服务器不随工作台安装。请使用 npm install -g @benchgo/relay，然后运行 benchgo-relay');
  throw new Error(`未知命令：${scope}`);
}

export async function main(argv = process.argv.slice(2)) {
  const { options } = parseArgs(argv);
  try {
    const result = await run(argv);
    if (result !== undefined) process.stdout.write((options.json && typeof result !== 'string' ? JSON.stringify(result) : String(result)) + '\n');
  } catch (error) {
    process.stderr.write((error?.message || String(error)) + '\n');
    process.exitCode = 1;
  }
}

export { parseArgs, usage, xdgPath };
