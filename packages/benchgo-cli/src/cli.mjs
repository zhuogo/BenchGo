import { readFile } from 'node:fs/promises';
import { installWorkbench, startWorkbench, stopWorkbench, workbenchStatus, shouldOpenBrowser, openBrowser } from './installer.mjs';
import { serverCommand } from './server.mjs';
import { shared } from './shared.mjs';

const cliVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

export function usage() {
  return `BenchGo CLI ${cliVersion}

用法:
  benchgo install                     安装或复用工作台，交互终端默认打开浏览器
  benchgo update                      更新受管工作台，保留配置与会话
  benchgo <start|open|status|stop|restart>
  benchgo prefetch                    预取匹配平台的完整工作台资源
  benchgo server <install|update|status|start|stop|restart>

选项:
  --no-open       不打开浏览器；SSH/无头会话默认采用此方式
  --open          显式打开浏览器
  --json          输出机器可读 JSON
  --home PATH     指定 Harness 用户目录（默认 DSH_HOME 或 ~/.dsh）
  --root PATH     指定完整原生离线种子或发行资源目录
  --runtime PATH  复用精确兼容的官方引擎目录
  --offline       仅使用已准备的本地资源
  --source NAME   mirror 或 github，不静默更换来源
  --version       输出命令包版本
  --help          显示帮助

工作台使用 Windows x64、macOS arm64/x64、Linux x64 的真实原生资源。
首次安装需 Node.js 24.9+；已有兼容桌面载体可复用。
中继独立使用 benchgo-relay；工作台不隐式安装中继。
server 为既有 Linux/systemd SSH 服务器入口，不会另建本机副本。`;
}

export function parseArgs(argv) {
  const options = { json: false, root: process.env.BENCHGO_ROOT };
  const positionals = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--version' || argument === '-v') options.version = true;
    else if (argument === '--no-open') options.open = false;
    else if (argument === '--open') options.open = true;
    else if (argument === '--offline') options.offline = true;
    else {
      const match = argument.match(/^--(root|source|home|runtime)(?:=(.*))?$/);
      if (match) {
        const value = match[2] ?? argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`${match[1]} 需要参数`);
        options[match[1]] = value;
      } else if (argument.startsWith('-')) throw new Error(`未知选项：${argument}`);
      else positionals.push(argument);
    }
  }
  if (options.source && !['mirror', 'github'].includes(options.source)) throw new Error('下载源必须是 mirror 或 github');
  return { options, positionals };
}

export async function run(argv, dependencies = {}) {
  if (argv[0] === 'relay') throw new Error('中继独立安装，请使用 benchgo-relay');
  const { options, positionals } = parseArgs(argv);
  if (options.version) return cliVersion;
  if (options.help || positionals.length === 0) return usage();
  const [action, subcommand, ...extra] = positionals;
  if (extra.length || action !== 'server' && subcommand) throw new Error('命令参数过多');
  if (action === 'relay') throw new Error('中继独立安装，请使用 benchgo-relay');
  if (action === 'server') return (dependencies.serverCommand || serverCommand)(subcommand, options, dependencies);
  let result;
  if (['install', 'update'].includes(action)) result = await (dependencies.installWorkbench || installWorkbench)({ ...options, update: action === 'update' }, dependencies);
  else if (['start', 'open'].includes(action)) result = await (dependencies.startWorkbench || startWorkbench)(options, dependencies);
  else if (action === 'status') return (dependencies.workbenchStatus || workbenchStatus)(options);
  else if (action === 'stop') return (dependencies.stopWorkbench || stopWorkbench)(options);
  else if (action === 'restart') {
    await (dependencies.stopWorkbench || stopWorkbench)(options);
    result = await (dependencies.startWorkbench || startWorkbench)(options, dependencies);
  } else if (action === 'prefetch') {
    const { workbenchPaths } = await shared('workbench-installation.mjs');
    const { acquirePayload, loadInstallMetadata } = await import('./artifacts.mjs');
    const paths = workbenchPaths(options);
    const payload = await (dependencies.acquirePayload || acquirePayload)({ ...options, cache: paths.cache, metadata: await loadInstallMetadata(options.root) });
    return { prefetched: true, directory: payload.seed || payload.archive, origin: payload.origin };
  } else throw new Error(`未知命令：${action}`);
  if (result.url && (action === 'open' || shouldOpenBrowser(options, dependencies))) {
    try { await (dependencies.openBrowser || openBrowser)(result.url, dependencies); result.browserOpened = true; }
    catch (error) { result.browserOpened = false; result.warning = `工作台已启动，浏览器未能打开：${error.message}`; }
  }
  return result;
}

function formatResult(value) {
  if (typeof value === 'string') return value;
  const lines = [value.prefetched ? '工作台资源已准备' : value.installed === false ? '工作台未安装'
    : value.stopped ? '工作台已安全停止' : value.running === false ? '工作台已安装，当前未运行'
      : value.reused ? '已复用现有工作台' : value.kind === 'server' ? '服务器工作台操作完成' : '工作台已就绪'];
  if (value.url) lines.push(`本机连接：${value.url}`);
  if (value.directory) lines.push(`资源目录：${value.directory}`);
  if (value.warning) lines.push(value.warning);
  if (value.persistent === false) lines.push('服务器用户常驻服务尚未启用，请按服务器提示配置');
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { options } = parseArgs(argv);
    const result = await run(argv);
    if (result !== undefined) process.stdout.write((options.json && typeof result !== 'string' ? JSON.stringify(result) : formatResult(result)) + '\n');
  } catch (error) { process.stderr.write((error?.message || String(error)) + '\n'); process.exitCode = 1; }
}
