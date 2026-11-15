/** Private lifecycle control around the official Web or Desktop Host. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { shared } from './shared.mjs';

const { workbenchPaths, readWorkbenchInstallation, acquireWorkbenchLease, acquireWorkbenchProfileLock,
  assertWorkbenchDataAvailable, workbenchPackageDirectory } = await shared('workbench-installation.mjs');
const moduleAt = (runtime, name, entry = 'lib/index.js') => import(pathToFileURL(join(workbenchPackageDirectory(runtime, name), entry)).href);
const redact = value => String(value).replace(/([?&]token=)[^\s&"']+/gi, '$1[redacted]');

export async function inspectTasks(ctx) {
  const agents = ctx.get('agents'), jobs = ctx.get('jobs');
  if (!agents || !jobs) throw new Error('工作台任务状态尚不可用，未停止工作台');
  const roster = agents.list();
  let activeTasks = roster.some(agent => agent.status === 'running' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length)
    || [undefined, ...roster].some(agent => jobs.list(agent?.id).some(job => ['running', 'stopping'].includes(job.status)));
  activeTasks ||= !!ctx.get('commander')?.list().some(session => ['running', 'connecting', 'waiting'].includes(session.status));
  let scheduledTasks = false;
  for (const agent of roster) {
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId: agent.id }, () => Promise.resolve([]));
    if (activity.some(entry => entry.kind === 'schedule')) { scheduledTasks = true; break; }
  }
  return { activeTasks, scheduledTasks };
}

/** Own the stop before awaiting; failed drains or inspections always reopen admission. */
export function createStopCoordinator(application) {
  let pending;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      let closed = false;
      try {
        await application.lock();
        const facts = await application.inspect();
        if (facts.activeTasks || facts.scheduledTasks) throw new Error('有运行、等待交互或已安排的任务，请在工作台完成后重试');
        await application.shutdown(); closed = true;
        return facts;
      } finally {
        if (!closed) { try { await application.unlock(); } finally { pending = undefined; } }
      }
    })();
    return pending;
  };
}

/** Reuse the official Office/Python, engine resolver, package manager and task controls together. */
async function desktopApplication(installation, paths, onExit) {
  const support = dirname(installation.primaryRuntime);
  const entry = join(installation.runtime, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js');
  const child = spawn(installation.node, ['--expose-internals', entry, installation.runtime, paths.profile,
    installation.primaryRuntime, join(installation.primaryRuntime, 'dependencies/pnpm/bin/pnpm.mjs'), join(support, 'bin')], {
    cwd: paths.profile, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  // Official startup diagnostics may contain the browser credential. Never persist that credential.
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8'); let line = '';
    stream.on('data', chunk => { line += chunk; const lines = line.split('\n'); line = lines.pop(); for (const item of lines) process.stderr.write(redact(item) + '\n'); });
    stream.on('end', () => { if (line) process.stderr.write(redact(line) + '\n'); });
  }
  let nextId = 1, acknowledged = false, stopping = false;
  const requests = new Map();
  let readyResolve, readyReject;
  const ready = new Promise((done, fail) => { readyResolve = done; readyReject = fail; });
  const exited = new Promise((done, fail) => {
    child.once('error', error => { readyReject(error); fail(error); });
    child.once('close', code => {
      const error = new Error(`官方工作台已退出（${code}，安全关闭确认 ${acknowledged}）`);
      readyReject(error);
      for (const request of requests.values()) request.reject(error);
      if (code === 0 && acknowledged) done(); else fail(error);
      void onExit();
    });
  });
  exited.catch(error => process.stderr.write(redact(error.message) + '\n'));
  child.on('message', message => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready' && typeof message.url === 'string') readyResolve(message.url);
    else if (message.type === 'fatal') readyReject(new Error(redact(message.diagnostic || message.message)));
    else if (message.type === 'shutdown-complete') acknowledged = true;
    else if (requests.has(message.requestId)) {
      const request = requests.get(message.requestId);
      if (message.type !== request.type) return;
      message.error ? request.reject(new Error(redact(message.error))) : request.resolve(message);
    }
  });
  const control = (type, action) => new Promise((resolve, reject) => {
    if (!child.connected || stopping) { reject(new Error('官方工作台控制不可用')); return; }
    const requestId = nextId++;
    const clear = () => { clearTimeout(timer); requests.delete(requestId); };
    const timer = setTimeout(() => { clear(); reject(new Error('官方工作台控制超时')); }, 10_000);
    requests.set(requestId, { type, resolve: value => { clear(); resolve(value); }, reject: error => { clear(); reject(error); } });
    child.send({ type, requestId, ...(action ? { action } : {}) }, error => { if (error) requests.get(requestId)?.reject(error); });
  });
  const shutdown = async () => {
    if (!stopping) { stopping = true; if (child.connected) child.send({ type: 'shutdown' }, () => {}); }
    let timer;
    try { await Promise.race([exited, new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('官方工作台尚未确认关闭，未释放所有权')), 15_000); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    const url = await ready;
    return { url, inspect: () => control('quit-inspection'), lock: () => control('update-tasks', 'lock'),
      unlock: () => control('update-tasks', 'unlock'), shutdown };
  } catch (error) { await shutdown().catch(() => {}); throw error; }
}

async function webApplication(installation, paths) {
  const boot = await moduleAt(installation.runtime, '@deepseek-ai/dsh-app-boot');
  const { runProfile } = await moduleAt(installation.runtime, '@deepseek-ai/dsh', 'lib/profile-boot.js');
  const installAnchor = join(installation.runtime, 'node_modules/@deepseek-ai/dsh/package.json');
  const profile = boot.loadProfileDirectory('dsh', paths.profile, installAnchor);
  boot.reportSkippedBundles('dsh', profile);
  const signals = new Map(['SIGTERM', 'SIGINT'].map(signal => [signal, process.listeners(signal)]));
  const running = await runProfile({ environment: boot.loadLayeredEnv('dsh'), profile: 'desktop',
    resolvedProfile: { profile, installAnchor }, patchFiles: [], args: ['--no-open', '--host', '127.0.0.1', '--port', '0'] });
  for (const [signal, before] of signals) for (const handler of process.listeners(signal)) if (!before.includes(handler)) process.removeListener(signal, handler);
  const ctx = running.ctx, connection = ctx.get('connection'), server = ctx.get('webServer');
  if (!connection || !server) { await running.shutdown.shutdown(1); throw new Error('官方工作台未完成启动'); }
  let locked = false;
  const requests = new Set();
  ctx.on('connection/request', async (_request, response, next) => {
    if (locked) { response.writeHead(503); response.end(); return; }
    let done; const pending = new Promise(resolve => { done = resolve; }); requests.add(pending);
    try { await next(); } finally { requests.delete(pending); done(); }
  });
  return { url: connection.authenticatedUrl(`${server.protocol}//127.0.0.1:${server.port}`),
    inspect: () => inspectTasks(ctx), lock: async () => { locked = true; await Promise.all(requests); },
    unlock: async () => { locked = false; }, shutdown: () => running.shutdown.shutdown(0) };
}

export async function runHost({ home = process.argv[2] } = {}) {
  const paths = workbenchPaths({ home });
  process.env.DSH_HOME = paths.home; process.env.DSH_TELEMETRY_DISABLED = '1';
  const installation = await readWorkbenchInstallation({ home: paths.home });
  if (!installation) throw new Error('未登记工作台，不能启动第二个实例');
  process.env.DSH_CLIENT_VERSION ||= installation.releaseVersion || installation.engineVersion;
  const releaseLease = await acquireWorkbenchLease({ home: paths.home, kind: 'web' });
  let releaseProfile, application, control, cleanupPending, ownerWritten = false;
  const token = randomBytes(32).toString('hex');
  const closeControl = async () => {
    if (!control?.listening) return;
    control.closeIdleConnections();
    await new Promise(done => control.close(done));
  };
  const cleanup = () => cleanupPending ??= (async () => {
    if (ownerWritten) {
      const owner = await readFile(paths.ownerFile, 'utf8').then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (owner?.pid === process.pid && owner.token === token) await rm(paths.ownerFile, { force: true });
    }
    await releaseProfile?.(); await releaseLease();
  })();
  const exited = async () => { await cleanup(); await closeControl(); };
  const onSignal = () => { void application?.shutdown().then(exited).catch(error => process.stderr.write(redact(error.message) + '\n')); };
  try {
    await assertWorkbenchDataAvailable();
    releaseProfile = await acquireWorkbenchProfileLock({ profile: paths.profile });
    application = installation.primaryRuntime ? await desktopApplication(installation, paths, exited) : await webApplication(installation, paths);
    const stop = createStopCoordinator(application);
    let stopping = false;
    control = createServer(async (request, response) => {
      const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' }); response.end(JSON.stringify(body)); };
      const authorization = request.headers.authorization ?? '', expected = `Bearer ${token}`;
      if (request.method !== 'POST' || request.url !== '/' || request.headers.origin || authorization.length !== expected.length
        || !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) { send(403, { error: '拒绝工作台控制请求' }); return; }
      try {
        let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 1024) throw new Error('控制请求过大'); }
        const { action } = JSON.parse(body);
        if (!['status', 'stop'].includes(action)) { send(400, { error: '不支持的操作' }); return; }
        if (stopping) { send(409, { error: '工作台正在安全关闭' }); return; }
        const identity = { installationId: installation.id, pid: process.pid, url: application.url };
        if (action === 'status') { send(200, { ...identity, ...await application.inspect() }); return; }
        stopping = true;
        try { const facts = await stop(); send(200, { ...identity, ...facts, stopped: true }); await exited(); }
        catch (error) { stopping = false; throw error; }
      } catch (error) { if (!response.headersSent) send(409, { error: redact(error.message) }); }
    });
    control.requestTimeout = 5000; control.headersTimeout = 5000; control.timeout = 30_000;
    await new Promise((done, fail) => { control.once('error', fail); control.listen(0, '127.0.0.1', done); });
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    const temporary = `${paths.ownerFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ installationId: installation.id, pid: process.pid, token,
      controlUrl: `http://127.0.0.1:${control.address().port}/` }), { mode: 0o600 });
    await rename(temporary, paths.ownerFile); ownerWritten = true;
    process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
    process.stdout.write('BenchGo 工作台已就绪（仅本机访问）\n');
    return { url: application.url, control, cleanup };
  } catch (error) {
    await application?.shutdown().catch(() => {});
    await closeControl(); await cleanup(); throw error;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  runHost().catch(error => { process.stderr.write(redact(error.stack || error.message) + '\n'); process.exitCode = 1; });
