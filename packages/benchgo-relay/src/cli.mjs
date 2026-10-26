import { access, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const VERSION = '0.0.1';
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configDefault = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'benchgo', 'relay.json');

export function usage() {
  return `BenchGo relay ${VERSION}

用法:
  benchgo-relay run --config /path/to/relay.json
  benchgo-relay status
  benchgo-relay <start|stop|restart|logs|renew|renew-status|diagnose|uninstall>

说明:
  run 复用 Link 的 TLS 中继运行时。
  install 使用已准备的 relay.json 创建 systemd 系统单元。
  工作台使用 benchgo，不携带本服务。`;
}

export function parseArgs(argv) {
  const options = { root: process.env.BENCHGO_ROOT || repositoryRoot, config: process.env.BENCHGO_RELAY_CONFIG || configDefault, json: false };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--root') options.root = argv[++index] ?? '';
    else if (arg.startsWith('--root=')) options.root = arg.slice(7);
    else if (arg === '--config') options.config = argv[++index] ?? '';
    else if (arg.startsWith('--config=')) options.config = arg.slice(9);
    else positionals.push(arg);
  }
  return { options, positionals };
}

const exists = async path => { try { await access(path); return true; } catch { return false; } };

function spawnCommand(command, args, { capture = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' } });
    let stdout = '', stderr = '';
    if (capture) {
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
    }
    child.once('error', reject);
    child.once('exit', code => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

async function systemd(operation) {
  const names = operation === 'status' ? ['benchgo-relay.service', 'dsh-link-relay.service'] : ['benchgo-relay.service'];
  for (const name of names) {
    const result = await spawnCommand('systemctl', [operation === 'status' ? 'is-active' : operation, name], { capture: true });
    if (result.code === 0 || operation !== 'status') {
      if (result.code !== 0) throw new Error(result.stderr.trim() || `中继服务 ${operation} 失败`);
      return result.stdout.trim() || `${name} ${operation} 完成`;
    }
  }
  return 'inactive';
}

async function manage(action, json) {
  const units = ['benchgo-relay.service', 'dsh-link-relay.service'];
  const activeUnit = async () => {
    for (const name of units) {
      const probe = await spawnCommand('systemctl', ['is-active', name], { capture: true });
      if (probe.code === 0) return name;
    }
    return units[0];
  };
  const unit = await activeUnit();
  if (action === 'logs') {
    const r = await spawnCommand('journalctl', ['-u', unit, '-n', '100', '--no-pager', '-o', 'cat'], { capture: true });
    return json ? { service: unit, logs: r.stdout } : r.stdout || '暂无中继日志';
  }
  if (action === 'renew' || action === 'renew-status') {
    const timer = 'benchgo-relay-cert-renew.timer';
    const op = action === 'renew' ? 'start' : 'is-active';
    const r = await spawnCommand('systemctl', [op, timer], { capture: true });
    if (r.code !== 0 && action === 'renew') throw new Error(r.stderr.trim() || '证书续期失败');
    const value = r.stdout.trim() || (r.code === 0 ? 'active' : 'inactive');
    return json ? { timer, operation: action, ok: r.code === 0, status: value } : `证书续期：${value}`;
  }
  if (action === 'diagnose') {
    const service = await systemd('status');
    const configured = await exists(configDefault);
    const ports = await spawnCommand('ss', ['-ltn'], { capture: true });
    const value = { configured, configPath: configDefault, service, listening: ports.stdout.split('\n').filter(Boolean).slice(0, 20) };
    return json ? value : `中继服务：${service}\n配置：${configured ? configDefault : '未找到'}\n监听：${value.listening.join('\n')}`;
  }
  if (action === 'uninstall') {
    for (const name of units) {
      await spawnCommand('systemctl', ['disable', '--now', name], { capture: true });
      await spawnCommand('rm', ['-f', '/etc/systemd/system/' + name], { capture: true });
    }
    await spawnCommand('systemctl', ['daemon-reload'], { capture: true });
    return json ? { ok: true, service: unit } : '中继服务已卸载';
  }
  return systemd(action);
}

async function status(configPath, json) {
  const configured = await exists(configPath);
  const service = await systemd('status');
  const value = { configured, configPath, service };
  return json ? value : `中继配置：${configured ? configPath : '未找到'}\n服务：${service}`;
}

async function install(configPath, json) {
  if (process.platform !== 'linux') throw new Error('中继服务安装当前仅支持 Linux');
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new Error('中继服务安装需要 root 权限');
  const resolvedConfig = resolve(configPath);
  const config = JSON.parse(await readFile(resolvedConfig, 'utf8'));
  const owner = (await stat(resolvedConfig)).uid;
  if (!Number.isInteger(config.port) || config.port < 20000 || config.port > 49151 || !config.publicUrl || !config.keyFile || !config.certFile || !config.token || !config.keyFile.startsWith('/') || !config.certFile.startsWith('/')) throw new Error('中继配置必须包含 port、publicUrl、token、绝对路径 keyFile 和 certFile');
  const runner = resolve(packageRoot, 'resources/run-relay-server.mjs');
  const unit = `[Unit]\nDescription=BenchGo Relay\nAfter=network-online.target\n[Service]\nExecStart=${process.execPath} ${runner} --config ${resolvedConfig}\nRestart=on-failure\nRestartSec=5\nUser=${owner}\n[Install]\nWantedBy=multi-user.target\n`;
  await mkdir('/etc/systemd/system', { recursive: true });
  await writeFile('/etc/systemd/system/benchgo-relay.service', unit, { mode: 0o644 });
  const reload = await spawnCommand('systemctl', ['daemon-reload'], { capture: true });
  if (reload.code !== 0) throw new Error(reload.stderr.trim() || 'systemd reload 失败');
  const started = await spawnCommand('systemctl', ['enable', '--now', 'benchgo-relay.service'], { capture: true });
  if (started.code !== 0) throw new Error(started.stderr.trim() || '中继服务启用失败');
  return json ? { ok: true, service: 'benchgo-relay.service', configPath: resolvedConfig } : `中继服务已安装并启动\n${started.stdout.trim()}`;
}

export async function runCommand(action, options) {
  if (action === 'status') return status(options.config, options.json);
  if (['start', 'stop', 'restart'].includes(action)) return systemd(action);
  if (['logs', 'renew', 'renew-status', 'diagnose', 'uninstall'].includes(action)) return manage(action, options.json);
  if (action === 'install') return install(options.config, options.json);
  if (action !== 'run') throw new Error(`不支持的中继操作：${action || '(空)'}`);
  const runner = await exists(resolve(options.root, 'plugins/link/scripts/run-relay-server.mjs'))
    ? resolve(options.root, 'plugins/link/scripts/run-relay-server.mjs')
    : resolve(packageRoot, 'resources/run-relay-server.mjs');
  if (!await exists(runner)) throw new Error('未找到中继运行器，请设置 BENCHGO_ROOT');
  if (!options.config) throw new Error('请使用 --config 指定中继配置');
  return spawnCommand(process.execPath, [runner, '--config', resolve(options.config)]);
}

export async function run(argv) {
  const { options, positionals } = parseArgs(argv);
  if (options.version) return VERSION;
  if (options.help || positionals.length === 0) return usage();
  return runCommand(positionals[0], options);
}

export async function main(argv = process.argv.slice(2)) {
  const { options } = parseArgs(argv);
  try {
    const result = await run(argv);
    if (options.json) process.stdout.write(JSON.stringify(result) + '\n');
    else if (result !== undefined) process.stdout.write(String(result) + (String(result).endsWith('\n') ? '' : '\n'));
  } catch (error) {
    if (options.json) process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
    else process.stderr.write(`错误：${error.message}\n`);
    process.exitCode = 1;
  }
}
