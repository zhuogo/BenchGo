/** Root-owned bridge between the official Desktop lifecycle and the shared workbench installation. */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sharedPath = existsSync(new URL('./shared/workbench-installation.mjs', import.meta.url))
  ? new URL('./shared/workbench-installation.mjs', import.meta.url)
  : new URL('../../plugins/benchgo/shared/workbench-installation.mjs', import.meta.url);
const shared = await import(sharedPath.href);
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

/** Inspect the actual bundled runtime; product and plugin versions remain independent. */
export async function desktopWorkbenchInstallation({ resources, runtime, profile, node = process.execPath, home } = {}, api = shared) {
  if (typeof resources !== 'string' || !resources) throw new Error('BenchGo: desktop application resources are required');
  resources = resolve(resources);
  const application = await readJson(join(resources, 'app.asar', 'package.json'));
  if (application.name !== 'benchgo-desktop') throw new Error('BenchGo: invalid desktop application metadata');
  runtime = resolve(runtime ?? [join(resources, 'app.asar.unpacked', 'dsh'), join(resources, 'app.asar', 'dsh')]
    .find(path => existsSync(join(path, 'node_modules/@deepseek-ai/dsh-app-boot/package.json'))) ?? join(resources, 'app.asar.unpacked', 'dsh'));
  if (home === undefined) {
    const paths = await import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/dsh-home-paths/lib/index.js')).href);
    home = paths.resolveDshHome();
  }
  const paths = api.workbenchPaths({ home });
  if (profile !== undefined && resolve(profile) !== paths.profile) throw new Error('BenchGo Desktop 只接管当前用户的共同工作区，未创建第二套工作区');
  const inspected = await api.inspectWorkbenchRuntime(runtime);
  return { paths, installation: { kind: 'desktop', runtime: inspected.runtime, engineVersion: inspected.engineVersion,
    profile: paths.profile, node: resolve(node), executable: resolve(node), resources,
    primaryRuntime: join(resources, 'runtime', 'primary-runtime') } };
}

/** Offline enrollment may update metadata only while no other Host owns this profile. */
export async function assertDesktopEnrollmentAvailable({ home } = {}, api = shared) {
  const lease = await api.readWorkbenchLease({ home });
  if (lease?.active && lease.pid !== process.pid) throw new Error('BenchGo 工作台正在运行。请先在原工作台完成任务并关闭，再安装桌面客户端；未改动现有工作区。');
}

/** Record a stopped desktop installation without changing the profile or starting a process. */
export async function registerDesktopWorkbench(options, api = shared) {
  const { paths, installation } = await desktopWorkbenchInstallation(options, api);
  return api.registerWorkbenchInstallation({ home: paths.home, installation });
}

function equalSecret(actual, expected) {
  const left = Buffer.from(actual || ''), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function writeOwner(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

/** The capability is local to this user and exposes status, never arbitrary Desktop commands. */
export async function createDesktopWorkbenchOwner({ paths, installation, pid = process.pid, api = shared }) {
  const token = randomBytes(32).toString('hex');
  let ready, closing = false;
  const server = createServer(async (request, response) => {
    const json = (status, value) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
    try {
      if (request.method !== 'POST' || request.url !== '/' || request.headers.origin
        || !equalSecret(request.headers.authorization, `Bearer ${token}`)) return json(403, { error: 'BenchGo 本机工作台控制请求未获授权' });
      const chunks = []; let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 4096) return json(413, { error: 'BenchGo 本机工作台请求超出限制' });
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      if (input.action === 'stop') return json(409, { error: '此工作台由桌面客户端管理，请在 BenchGo 桌面客户端中退出或重启。' });
      if (input.action !== 'status') return json(400, { error: '不支持的工作台控制操作' });
      if (!ready || closing) return json(503, { error: 'BenchGo 桌面工作台尚未就绪，请稍后重试' });
      const inspection = await ready.inspect();
      if (!inspection || typeof inspection.activeTasks !== 'boolean' || typeof inspection.scheduledTasks !== 'boolean')
        throw new Error('BenchGo 桌面工作台任务状态未知');
      return json(200, { installationId: installation.id, pid, kind: 'desktop', url: ready.url,
        activeTasks: inspection.activeTasks, scheduledTasks: inspection.scheduledTasks });
    } catch (error) { return json(503, { error: error.message || 'BenchGo 桌面工作台状态暂不可用' }); }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  server.unref();
  const controlUrl = `http://127.0.0.1:${server.address().port}/`;
  const owner = { installationId: installation.id, pid, token, controlUrl };
  return {
    async publish({ url, inspect }) {
      const checked = api.loopbackUrl(url, { authenticated: true });
      if (typeof inspect !== 'function') throw new Error('BenchGo Desktop 缺少官方任务状态检查');
      ready = { url: checked.href, inspect };
      await mkdir(paths.directory, { recursive: true, mode: 0o700 });
      await writeOwner(paths.ownerFile, owner);
    },
    async dispose() {
      closing = true; ready = undefined;
      try {
        const current = await readJson(paths.ownerFile);
        if (current.token === token && current.pid === pid) await rm(paths.ownerFile, { force: true });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      finally { server.close(); server.closeAllConnections(); }
    },
    cleanupSync() {
      try {
        const info = lstatSync(paths.ownerFile);
        if (!info.isFile() || info.isSymbolicLink()) return;
        const current = JSON.parse(readFileSync(paths.ownerFile, 'utf8'));
        if (current.token === token && current.pid === pid) unlinkSync(paths.ownerFile);
      } catch { /* Exit cleanup never masks the official shutdown result. */ }
    },
  };
}

/** Transfer only an idle managed Web Host, then enroll and start under one ownership lease. */
export async function beginDesktopWorkbench({ initialize, ...options }, api = shared) {
  if (typeof initialize !== 'function') throw new Error('BenchGo Desktop 缺少官方插件登记入口');
  const { paths, installation } = await desktopWorkbenchInstallation(options, api);
  const previous = await api.readWorkbenchInstallation({ home: paths.home, expectedEngine: installation.engineVersion });
  const lease = await api.readWorkbenchLease({ home: paths.home });
  if (lease?.active) {
    if (lease.pid === process.pid) throw new Error('BenchGo 桌面工作台已经取得所有权');
    if (!previous || lease.kind !== 'web') throw new Error('已有 BenchGo 桌面工作台或未知进程正在运行，未启动第二个工作台');
    // The Web supervisor locks admission, inspects tasks again and acknowledges graceful teardown.
    await api.requestWorkbenchControl(previous, { home: paths.home, action: 'stop' });
    await api.waitForWorkbenchStop({ home: paths.home });
  }
  const release = await api.acquireWorkbenchLease({ home: paths.home, kind: 'desktop' });
  let ownLease;
  try { ownLease = await api.readWorkbenchLease({ home: paths.home }); }
  catch (error) { await release(); throw error; }
  let owner, disposed = false;
  const cleanupSync = () => {
    owner?.cleanupSync();
    try {
      const info = lstatSync(paths.hostLock);
      if (!info.isFile() || info.isSymbolicLink()) return;
      const current = JSON.parse(readFileSync(paths.hostLock, 'utf8'));
      if (current.pid === process.pid && current.token === ownLease?.token) unlinkSync(paths.hostLock);
    } catch { /* A dead owner is reclaimed by the reviewed shared lease policy. */ }
  };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try { await owner?.dispose(); } finally { await release(); process.off('exit', cleanupSync); }
  };
  try {
    const { enrollment, registered } = await api.withWorkbenchInstallLock({ home: paths.home }, async () => {
      await api.readWorkbenchInstallation({ home: paths.home, expectedEngine: installation.engineVersion });
      const enrollment = await initialize({ ...options, resources: options.resources, runtime: installation.runtime, profile: paths.profile, registerInstallation: false });
      const registered = await api.registerWorkbenchInstallation({ home: paths.home, installation });
      return { enrollment, registered };
    });
    owner = await createDesktopWorkbenchOwner({ paths, installation: registered, api });
    process.once('exit', cleanupSync);
    return { ...enrollment, publishReady: value => owner.publish(value), dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
