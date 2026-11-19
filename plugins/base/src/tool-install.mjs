import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { TOOL_CATALOG, getTool, normalizeToolId } from './tool-catalog.mjs';
const finished = new Set(['succeeded', 'failed', 'cancelled']); const clone = v => JSON.parse(JSON.stringify(v));
export function redactToolOutput(value, env = process.env) { let text = String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''); for (const [key, secret] of Object.entries(env)) if (/(?:key|token|secret|password|authorization|credential)/i.test(key) && typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[REDACTED]'); return text.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@').replace(/\b(?:sk|dg|api)[_-][A-Za-z0-9_-]{12,}\b/g, '[REDACTED]').replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[=:]\s*)(?:Bearer\s+)?[^\s,;]+/gi, '$1[REDACTED]'); }
export function executeToolCommand(command, args, { env = process.env, cwd, signal, onOutput } = {}) { return new Promise((resolvePromise, reject) => { if (signal?.aborted) return reject(new Error('Operation cancelled')); const child = spawn(command, args, { env, cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); let tail = ''; const kill = () => { try { process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGTERM'); } catch {} }; const cleanup = () => signal?.removeEventListener('abort', kill); const data = c => { const v = c.toString(); tail = (tail + v).slice(-8192); onOutput?.(v); }; child.stdout.on('data', data); child.stderr.on('data', data); signal?.addEventListener('abort', kill, { once: true }); child.once('error', e => { cleanup(); reject(e); }); child.once('close', (code, reason) => { cleanup(); if (signal?.aborted) reject(new Error('Operation cancelled')); else if (code !== 0) reject(new Error('Command exited (' + (code ?? reason) + '): ' + tail)); else resolvePromise({ code, stdout: tail }); }); }); }
export class ToolInstaller extends EventEmitter {
  constructor({ platform = process.platform, env = process.env, executor = executeToolCommand, isRunning = () => false, maxConcurrent = 2, timeoutMs = 15 * 60_000 } = {}) { super(); this.platform = platform; this.env = { ...env }; this.executor = executor; this.isRunning = isRunning; this.maxConcurrent = maxConcurrent; this.timeoutMs = timeoutMs; this.records = new Map(); this.controllers = new Map(); this.pending = []; this.active = 0; this.tasks = new Set(); this.closed = false; }
  async usable(path) { try { await access(path, this.platform === 'win32' ? constants.F_OK : constants.X_OK); return true; } catch { return false; } }
  async findExecutables(command) { if (!command) return []; const dirs = String(this.env.PATH ?? this.env.Path ?? '').split(this.platform === 'win32' ? ';' : delimiter).filter(Boolean); dirs.push(resolve(homedir(), '.local/bin'), resolve(homedir(), '.npm-global/bin')); const suffixes = this.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']; const found = []; for (const dir of dirs) for (const suffix of suffixes) { const path = resolve(dir, command + suffix); if (await this.usable(path)) { const rp = await realpath(path).catch(() => path); if (!found.some(item => item.realpath === rp)) found.push({ path, realpath: rp }); } } return found; }
  async launchFor(tool, command) {
    if (this.platform !== 'win32' || extname(command).toLowerCase() === '.exe') return { command, args: [] };
    if (!/\.(?:cmd|bat)$/iu.test(command)) return null;
    try {
      const root = await realpath(resolve(dirname(command), 'node_modules', tool.packageName));
      const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[tool.command];
      if (pkg.name !== tool.packageName || typeof bin !== 'string') return null;
      const entry = await realpath(resolve(root, bin));
      const within = relative(root, entry);
      if (!within || isAbsolute(within) || /^\.{2}(?:[\\/]|$)/u.test(within) || !(await stat(entry)).isFile()) return null;
      if (tool.id === 'codex') {
        const architecture = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
        if (!architecture) return null;
        const nativePackage = createRequire(resolve(root, 'package.json')).resolve('@openai/codex-win32-' + process.arch + '/package.json');
        const native = await realpath(resolve(dirname(nativePackage), 'vendor', architecture + '-pc-windows-msvc', 'bin/codex.exe'));
        return (await stat(native)).isFile() ? { command: native, args: [] } : null;
      }
      switch (extname(entry).toLowerCase()) {
        case '.exe': return { command: entry, args: [] };
        case '.js':
        case '.mjs':
        case '.cjs': {
          const node = (await this.findExecutables('node')).find(item => item.path.toLowerCase().endsWith('.exe'));
          return node ? { command: node.path, args: [entry] } : null;
        }
        default: return null;
      }
    } catch { return null; }
  }
  async resolveLaunch(id) {
    return (await this.installation(getTool(id)))?.launch ?? null;
  }
  async probe(tool, installation) {
    const launch = installation.launch ?? await this.launchFor(tool, installation.path);
    if (!launch) return null;
    try {
      const result = await this.executor(launch.command, [...launch.args, '--version'], { env: this.env, signal: AbortSignal.timeout(8000) });
      return result.stdout.match(/\b\d+\.\d+(?:\.\d+)?\b/u)?.[0] ?? null;
    } catch { return null; }
  }
  sourceFor(path, tool) { if (!path) return 'none'; const p = path.replaceAll('\\', '/'); if (p.includes('/homebrew/') || p.includes('/Cellar/')) return 'homebrew'; if (p.includes('/node_modules/.bin/') || p.includes('/npm/')) return 'npm'; if (tool.installer === 'uv' || p.includes('/.local/bin/')) return 'uv'; return 'unknown'; }
  async npmLaunch() {
    if (this.platform !== 'win32') return { command: 'npm', args: [] };
    const installations = await this.findExecutables('npm');
    for (const installation of installations) {
      const launch = await this.launchFor({ command: 'npm', packageName: 'npm' }, installation.path);
      if (launch) return launch;
    }
    throw new Error('未找到可运行的 npm 安装入口。');
  }
  async npmRoot() {
    try {
      const { command, args } = await this.npmLaunch();
      return (await this.executor(command, [...args, 'root', '--global'], { env: this.env, signal: AbortSignal.timeout(8000) })).stdout.trim().replace(/[\\/]+$/, '');
    } catch { return null; }
  }
  async verifiedNpm(tool, installation) {
    const root = await this.npmRoot();
    if (!root) return false;
    const target = installation.launch?.args[0] ?? installation.launch?.command ?? installation.realpath;
    const prefix = resolve(root, tool.packageName).replaceAll('\\', '/') + '/';
    const path = target.replaceAll('\\', '/');
    return this.platform === 'win32' ? path.toLowerCase().startsWith(prefix.toLowerCase()) : path.startsWith(prefix);
  }
  async list({ includeDetails = true } = {}) {
    return Promise.all(TOOL_CATALOG.map(async tool => {
      const installations = (await this.findExecutables(tool.command)).map(item => ({ ...item, source: this.sourceFor(item.realpath, tool), version: null, available: false }));
      const job = [...this.records.values()].find(value => value.toolId === tool.id && !finished.has(value.status));
      const running = await this.isRunning(tool.id);
      const locked = running ? '工具正在运行，请先结束会话。' : job ? '工具已有进行中的任务。' : null;
      for (const installation of installations) {
        installation.launch = await this.launchFor(tool, installation.path);
        installation.available = !!installation.launch;
        if (includeDetails && installation.available) {
          installation.version = await this.probe(tool, installation);
          installation.available = installation.version !== null;
        }
        if (installation.source === 'npm' && includeDetails) {
          installation.sourceVerified = await this.verifiedNpm(tool, installation);
        }
      }
      const target = installations.find(item => item.launch) ?? installations[0];
      const source = target?.source ?? 'none';
      const sourceSafe = source !== 'unknown' && (source !== 'npm' || target?.sourceVerified);
      return {
        ...tool, installations, installed: !!target, available: !!target?.available,
        availabilityReason: target && !target.available ? 'CLI 已安装，但启动或版本探测失败。' : !target ? '尚未安装 CLI。' : null,
        executable: target?.path ?? null, version: target?.version ?? null, source,
        canInstall: !!tool.installer && !target && !locked,
        canUpdate: !!target && sourceSafe && !locked,
        canUninstall: !!target && sourceSafe && !locked,
        updateReason: !sourceSafe ? '安装来源未验证，无法自动更新。' : locked,
        uninstallReason: !sourceSafe ? '安装来源未验证，无法自动卸载。' : locked,
        ...(job ? { job: clone(job) } : {}),
      };
    }));
  }
  async installation(tool) {
    for (const item of await this.findExecutables(tool.command)) {
      const launch = await this.launchFor(tool, item.path);
      if (launch) return { ...item, launch, source: this.sourceFor(item.realpath, tool) };
    }
    return null;
  }
  async previewUninstall(id) {
    const tool = getTool(id);
    const target = await this.installation(tool);
    if (!target) return { available: false, reason: '未找到系统安装。' };
    const { source } = target;
    const command = source === 'homebrew' ? 'brew uninstall' : source === 'uv' ? 'uv tool uninstall' : source === 'npm' && await this.verifiedNpm(tool, target) ? 'npm uninstall --global' : null;
    return { available: !!command, path: target.path, realpath: target.realpath, source, version: await this.probe(tool, target), command,
      description: command ? `将使用 ${command} 移除该安装` : '安装来源未知，无法自动卸载。', snapshot: target.realpath };
  }
  install(id, options) { return this.enqueue(id, 'install', options); }
  updateTool(id, options) { return this.enqueue(id, 'update', options); }
  uninstall(id, options = {}) { return this.enqueue(id, 'uninstall', options); }
  enqueue(id, action, options = {}) { id = normalizeToolId(id); if ([...this.records.values()].some(j => j.toolId === id && !finished.has(j.status))) throw new Error('工具已有进行中的任务。'); const job = { id: randomUUID(), toolId: id, action, source: options.source ?? null, snapshot: options.snapshot ?? null, status: 'queued', message: '等待执行', logs: [], error: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null }; this.records.set(job.id, job); this.pending.push(job.id); this.emit('job', clone(job)); queueMicrotask(() => this.drain()); return clone(job); }
  jobs() { return [...this.records.values()].map(clone); } job(id) { const j = this.records.get(id); if (!j) throw new Error('Unknown installation job'); return clone(j); }
  cancel(id) { const j = this.records.get(id); if (!j) throw new Error('Unknown installation job'); if (!finished.has(j.status)) { this.controllers.get(id)?.abort(); Object.assign(j, { status: 'cancelled', message: '已取消', finishedAt: new Date().toISOString() }); this.emit('job', clone(j)); } return clone(j); }
  drain() { while (!this.closed && this.active < this.maxConcurrent && this.pending.length) { const j = this.records.get(this.pending.shift()); if (!j || finished.has(j.status)) continue; this.active++; const task = this.run(j).finally(() => { this.active--; this.tasks.delete(task); this.drain(); }); this.tasks.add(task); } }
  async run(job) {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const timer = setTimeout(() => controller.abort(new Error('任务超时。')), this.timeoutMs);
    timer.unref();
    const onOutput = output => {
      job.logs = [...job.logs, ...String(output).split(/[\r\n]+/u).filter(Boolean).map(line => redactToolOutput(line, this.env).slice(0, 1000))].slice(-80);
      this.emit('job', clone(job));
    };
    try {
      Object.assign(job, { status: 'running', message: '正在执行', startedAt: new Date().toISOString() });
      const tool = getTool(job.toolId);
      if (await this.isRunning(tool.id)) throw new Error('工具正在运行，请先结束会话后重试。');
      const target = await this.installation(tool);
      if (job.action === 'install' && target) throw new Error('已找到系统安装，请使用更新。');
      if (job.action !== 'install' && !target) throw new Error('未找到用于维护的工具入口。');
      if (job.action === 'uninstall' && job.snapshot !== target.realpath) throw new Error('工具安装位置已变化，请刷新后重新确认。');
      const source = target?.source ?? 'npm';
      if (target && source !== 'homebrew' && (source !== 'npm' || !await this.verifiedNpm(tool, target))) throw new Error('安装来源未核验。');
      controller.signal.throwIfAborted();
      const command = source === 'homebrew' ? { command: 'brew', args: [] } : await this.npmLaunch();
      const operation = source === 'homebrew'
        ? [job.action === 'uninstall' ? 'uninstall' : 'upgrade', tool.command]
        : job.action === 'uninstall'
          ? ['uninstall', '--global', tool.packageName]
          : ['install', '--global', ...tool.installArgs, tool.packageName + '@latest'];
      await this.executor(command.command, [...command.args, ...operation], { env: this.env, signal: controller.signal, onOutput });
      const changed = await this.installation(tool);
      if (job.action === 'uninstall' && changed?.realpath === target.realpath) throw new Error('卸载后仍检测到原安装。');
      if (job.action !== 'uninstall' && (!changed || !await this.probe(tool, changed))) throw new Error('操作完成但没有检测到可运行的工具。');
      if (!controller.signal.aborted) Object.assign(job, { status: 'succeeded', message: '操作完成，已重新探测系统安装', finishedAt: new Date().toISOString() });
    } catch (error) {
      if (job.status !== 'cancelled') Object.assign(job, { status: 'failed', message: '操作失败', error: redactToolOutput(controller.signal.aborted ? controller.signal.reason?.message ?? '任务已中止' : error.message, this.env).slice(0, 1200), finishedAt: new Date().toISOString() });
    } finally {
      clearTimeout(timer);
      this.controllers.delete(job.id);
      this.emit('job', clone(job));
    }
  }
  async close() { this.closed = true; for (const j of this.records.values()) if (!finished.has(j.status)) this.cancel(j.id); await Promise.allSettled([...this.tasks]); }
}
