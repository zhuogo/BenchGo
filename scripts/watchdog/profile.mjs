#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveWatchdogConfig, readWatchdogToken } from '../../plugins/superagent/src/watchdog-config.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const { parse: parseYaml } = createRequire(new URL('../../plugins/benchgo/package.json', import.meta.url))('yaml');
export const WATCHDOG_PROFILE = 'benchgo-watchdog';
const failure = (code, message) => Object.assign(new Error(message), { code });
const absolute = (value, name) => {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw failure('WATCHDOG_PATH', `${name} 必须为绝对路径`);
  return resolve(value);
};

async function regularFile(path, name, maxBytes) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxBytes)
    throw failure('WATCHDOG_FILE', `${name} 必须是有效的普通文件`);
}

/** Create one isolated, new deployment; existing profiles and credentials are never replaced. */
export async function initializeWatchdogProfile({ directory, targetId, targetUrl, tokenFile,
  pluginDirectory = join(repository, 'plugins/benchgo'), config = {} }) {
  directory = absolute(directory, 'directory');
  tokenFile = absolute(tokenFile, 'tokenFile');
  pluginDirectory = await realpath(absolute(pluginDirectory, 'pluginDirectory'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw failure('WATCHDOG_CONFIG_INVALID', '监督配置必须为对象');
  const watchdog = resolveWatchdogConfig({ ...config, enabled: true, targetId, targetUrl, tokenFile });
  await readWatchdogToken(tokenFile);
  const plugin = JSON.parse(await readFile(join(pluginDirectory, 'package.json'), 'utf8'));
  if (plugin.name !== 'benchgo-plugin' || !plugin.dsh?.bundle?.patch) throw failure('WATCHDOG_PLUGIN', '必须使用 benchgo-plugin 安装包');
  // Creating the deployment itself exclusively keeps init from overwriting any existing archive.
  try { await mkdir(directory, { recursive: false, mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw failure('WATCHDOG_EXISTS', '目录已存在；初始化不会覆盖已有档案，请选择新的目录');
    throw error;
  }
  const home = join(directory, 'home'), dataDir = join(directory, 'data'), profile = join(home, 'profiles', WATCHDOG_PROFILE);
  await mkdir(join(profile, 'node_modules'), { recursive: true, mode: 0o700 });
  await mkdir(dataDir, { mode: 0o700 });
  const manifest = { private: true, dependencies: { 'benchgo-plugin': `link:${pluginDirectory.replaceAll('\\', '/')}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'benchgo-plugin'] } } };
  const patches = [
    { id: 'commander', config: { dataDir, watchdog } },
    ...['commander-harness', 'commander-superagent', 'commander-voice', 'commander-link', 'tool-schedule'].map(id => ({ id, disabled: true })),
    { id: 'permission', config: { presets: { 'benchgo-watchdog-read-only': { sandbox: 'read-only', approval: 'ask' } },
      defaultPreset: 'benchgo-watchdog-read-only' } },
    { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'session-telemetry-otel', disabled: true },
  ];
  await writeFile(join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(join(profile, 'cordis.yml'), '[]\n', { flag: 'wx', mode: 0o600 });
  // JSON is a YAML subset. Keeping the overlay literal prevents executable config from user fields.
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify(patches, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await symlink(pluginDirectory, join(profile, 'node_modules', 'benchgo-plugin'), process.platform === 'win32' ? 'junction' : 'dir');
  const installation = { schemaVersion: 1, profileName: WATCHDOG_PROFILE, home, dataDir, profile, pluginDirectory, targetId };
  await writeFile(join(directory, 'installation.json'), JSON.stringify(installation, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return installation;
}

async function readInstallation(directory) {
  directory = absolute(directory, 'directory');
  const file = join(directory, 'installation.json');
  await regularFile(file, 'installation.json', 16384);
  const record = JSON.parse(await readFile(file, 'utf8'));
  if (record.schemaVersion !== 1 || record.profileName !== WATCHDOG_PROFILE || record.home !== join(directory, 'home')
    || record.dataDir !== join(directory, 'data') || record.profile !== join(directory, 'home', 'profiles', WATCHDOG_PROFILE))
    throw failure('WATCHDOG_INSTALLATION', '监督档案目录与安装记录不匹配');
  for (const path of [directory, record.home, record.dataDir, record.profile]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('WATCHDOG_INSTALLATION', '监督数据目录不能是链接');
  }
  return record;
}

/** Build the official CLI invocation without launching or embedding credentials. */
export async function watchdogLaunchSpec({ directory, cli, node = process.execPath, env = process.env, dumpConfig = false }) {
  const installation = await readInstallation(directory);
  const built = join(repository, 'deepseek-harness/apps/cli/lib/bin.js');
  cli = cli === undefined ? existsSync(built) ? built : join(repository, 'deepseek-harness/apps/cli/src/bin.ts') : absolute(cli, 'cli');
  await regularFile(cli, '官方 dsh CLI', 4 * 1024 * 1024);
  const prefix = [], launchEnv = { ...env, DSH_HOME: installation.home, DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'read-only' };
  if (cli.endsWith('.ts')) {
    const loader = join(repository, 'deepseek-harness/node_modules/tsx/dist/esm/index.mjs');
    await regularFile(loader, 'tsx runtime', 4 * 1024 * 1024);
    prefix.push('--import', pathToFileURL(loader).href, '--import', new URL('../source-host-loader.mjs', import.meta.url).href);
    launchEnv.TSX_TSCONFIG_PATH = join(repository, 'deepseek-harness/tsconfig.json');
  }
  const args = [...prefix, cli, '--profile', WATCHDOG_PROFILE,
    ...(dumpConfig ? ['--dump-config'] : ['--host', '127.0.0.1', '--port', '0', '--no-open'])];
  return { command: absolute(node, 'node'), args, options: { cwd: resolve(directory), env: launchEnv,
    windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] } };
}

const parseState = async path => {
  try { await regularFile(path, '监督状态', 8 * 1024 * 1024); return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

/** Read bounded operational facts only; a PID or scheduled delivery never means a completed check. */
export async function watchdogProfileStatus({ directory }) {
  const installation = await readInstallation(directory);
  const state = await parseState(join(installation.dataDir, 'watchdog/state.json'));
  if (state && (state.schemaVersion !== 1 || state.targetId !== installation.targetId || !Array.isArray(state.checks) || !Array.isArray(state.signals)))
    throw failure('WATCHDOG_STATE', '监督状态与目标身份不匹配或格式无效');
  const launch = await parseState(join(resolve(directory), 'launch.json'));
  const checks = Array.isArray(state?.checks) ? state.checks : [];
  const current = checks.findLast(check => !check.completedAt && ['running', 'started'].includes(check.status));
  const last = checks.findLast(check => check.completedAt);
  const signals = Array.isArray(state?.signals) ? state.signals : [];
  const degraded = last?.degraded ?? state?.degraded;
  return { initialized: true, profileName: WATCHDOG_PROFILE, targetId: installation.targetId,
    stateAvailable: state !== null, lastCheckAt: iso(state?.lastCheckAt),
    currentCheck: current ? { id: typeof current.id === 'string' ? current.id.slice(0, 200) : null, startedAt: iso(current.startedAt) } : null,
    incomplete: checks.filter(check => !check.completedAt).length,
    degraded: Array.isArray(degraded) ? degraded.filter(code => typeof code === 'string' && /^[A-Z0-9_:-]{1,80}$/u.test(code)).slice(0, 20)
      : state === null ? ['NOT_OBSERVED'] : [],
    pendingSignals: signals.filter(signal => signal.state === 'pending').length,
    process: launch ? { pid: Number.isSafeInteger(launch.pid) ? launch.pid : null, startedAt: iso(launch.startedAt),
      exitedAt: iso(launch.exitedAt), state: launch.exitedAt ? 'exited' : 'unknown' } : null };
}

function redactLine(line, secret) {
  return line.replaceAll(secret, '[redacted]').replace(/([?&]token=)[^\s&]+/giu, '$1[redacted]')
    .replace(/(authorization:\s*(?:bearer|basic)\s+)[^\s]+/giu, '$1[redacted]');
}

function forwardRedacted(stream, writer, secret) {
  let pending = '', oversized = false;
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      writer(oversized || line.length > 65536 ? '[omitted long host output]\n' : redactLine(line, secret) + '\n'); oversized = false;
    }
    if (pending.length > 65536) { pending = ''; oversized = true; }
  });
  stream.on('end', () => { if (pending || oversized) writer(oversized ? '[omitted long host output]\n' : redactLine(pending, secret)); });
}

async function writeLaunch(directory, record) {
  const temporary = join(directory, 'launch.json.tmp');
  await writeFile(temporary, JSON.stringify(record) + '\n', { mode: 0o600 });
  await rename(temporary, join(directory, 'launch.json'));
}

/** Start only the isolated supervisor. Lifecycle stays attached; there is no automatic restart policy. */
export async function startWatchdogProfile(options, { stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text) } = {}) {
  const directory = absolute(options.directory, 'directory'), installation = await readInstallation(directory);
  const patches = parseYaml(await readFile(join(installation.profile, 'cordis.patch.yml'), 'utf8'));
  if (!Array.isArray(patches)) throw failure('WATCHDOG_CONFIG', '监督档案配置必须是 patch 列表');
  const ids = patches.map(row => row?.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw failure('WATCHDOG_CONFIG', '监督档案不得重复覆盖同一入口');
  const base = patches.find(row => row.id === 'commander')?.config;
  const config = resolveWatchdogConfig(base?.watchdog);
  const permission = patches.find(row => row.id === 'permission')?.config;
  if (!config.enabled || config.targetId !== installation.targetId || base.dataDir !== installation.dataDir
    || ['commander-harness', 'commander-superagent', 'commander-voice', 'commander-link'].some(id => patches.find(row => row.id === id)?.disabled !== true)
    || permission?.defaultPreset !== 'benchgo-watchdog-read-only' || permission.presets?.['benchgo-watchdog-read-only']?.sandbox !== 'read-only'
    || permission.presets['benchgo-watchdog-read-only'].approval !== 'ask'
    || existsSync(join(installation.home, 'cordis.patch.yml')))
    throw failure('WATCHDOG_CONFIG', '监督目标、独立数据目录或禁用模块配置已变化');
  const secret = await readWatchdogToken(config.tokenFile);
  const spec = await watchdogLaunchSpec(options);
  const lockPath = join(directory, 'launch.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw failure('WATCHDOG_RUNNING', '监督启动锁已存在；先确认原监督已退出，不能重复启动');
    throw error;
  }
  let child, closed;
  const record = { schemaVersion: 1, startedAt: new Date().toISOString() };
  try {
    child = spawn(spec.command, spec.args, spec.options);
    closed = new Promise(done => {
      child.once('error', error => done({ error }));
      child.once('close', (code, signal) => done({ code, signal }));
    });
    await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
    record.pid = child.pid;
    await lock.writeFile(JSON.stringify(record) + '\n');
    await writeLaunch(directory, record);
  } catch (error) {
    // Only this invocation owns this lock; never remove an earlier launch's lock.
    if (child?.pid && child.exitCode === null) child.kill('SIGTERM');
    await lock.close(); await rm(lockPath); throw error;
  }
  forwardRedacted(child.stdout, stdout, secret);
  forwardRedacted(child.stderr, stderr, secret);
  const completion = closed.then(async ({ code, signal, error }) => {
    await writeLaunch(directory, { ...record, exitedAt: new Date().toISOString(), code, signal });
    await lock.close(); await rm(lockPath);
    if (error) throw error;
    return { code, signal };
  });
  return { child, completion };
}

async function main() {
  const { values, positionals } = parseArgs({ options: {
    directory: { type: 'string' }, 'target-id': { type: 'string' }, 'target-url': { type: 'string' },
    'token-file': { type: 'string' }, plugin: { type: 'string' }, config: { type: 'string' }, cli: { type: 'string' }, node: { type: 'string' },
    help: { type: 'boolean' },
  }, allowPositionals: true });
  if (values.help) {
    process.stdout.write('node scripts/watchdog/profile.mjs init|start|status --directory ABSOLUTE_PATH\n'
      + 'init: --target-id ID --target-url HTTP_ORIGIN --token-file ABSOLUTE_PATH [--plugin ABSOLUTE_PATH] [--config JSON_FILE]\n'
      + 'start: [--cli OFFICIAL_DSH_BIN_JS] [--node NODE_EXECUTABLE]\n');
    return;
  }
  if (positionals.length !== 1 || !['init', 'start', 'status'].includes(positionals[0])) throw failure('WATCHDOG_USAGE', '仅支持 init、start、status；使用 --help 查看参数');
  if (positionals[0] === 'init') {
    const config = values.config ? JSON.parse(await readFile(absolute(values.config, 'config'), 'utf8')) : {};
    const result = await initializeWatchdogProfile({ directory: values.directory, targetId: values['target-id'], targetUrl: values['target-url'],
      tokenFile: values['token-file'], pluginDirectory: values.plugin, config });
    process.stdout.write(JSON.stringify({ initialized: true, profileName: result.profileName, directory: resolve(values.directory), targetId: result.targetId }) + '\n');
  } else if (positionals[0] === 'status') {
    process.stdout.write(JSON.stringify(await watchdogProfileStatus({ directory: values.directory })) + '\n');
  } else {
    const { child, completion } = await startWatchdogProfile({ directory: values.directory, cli: values.cli, node: values.node });
    const interrupt = () => { if (child.exitCode === null) child.kill('SIGINT'); };
    const terminate = () => { if (child.exitCode === null) child.kill('SIGTERM'); };
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    try { const result = await completion; process.exitCode = result.code ?? (result.signal === 'SIGINT' ? 130 : 1); }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
  }
}

if (import.meta.main) await main().catch(error => {
  process.stderr.write(`${error.code || 'WATCHDOG_FAILED'}: ${error.message}\n`); process.exitCode = 1;
});
