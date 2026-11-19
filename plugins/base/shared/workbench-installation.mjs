/** One user-owned workbench installation and one live owner shared by CLI and Desktop. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const missing = error => error.code === 'ENOENT';
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value);
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));

/** Follow Node's installation anchor, including npm's nested dependencies and pnpm links. */
export function workbenchPackageDirectory(runtime, name) {
  const anchor = join(runtime, 'node_modules/@deepseek-ai/dsh/package.json');
  return dirname(name === '@deepseek-ai/dsh' ? anchor : createRequire(anchor).resolve(`${name}/package.json`));
}

export function workbenchPaths({ home = process.env.DSH_HOME || join(homedir(), '.dsh') } = {}) {
  home = resolve(home);
  const directory = join(home, '.benchgo', 'workbench');
  return { home, profile: join(home, 'profiles', 'desktop'), directory,
    registryFile: join(directory, 'installation.json'), hostLock: join(directory, 'host.lock'),
    installLock: join(directory, 'install.lock'), ownerFile: join(directory, 'owner.json'),
    runtimes: join(directory, 'runtimes'), cache: join(directory, 'cache'), log: join(directory, 'host.log') };
}

export function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

async function safeJson(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('BenchGo 安装记录不是有效的普通文件');
  return readJson(file);
}

/** Publish a fully written ownership claim atomically; interrupted writes never become a half lock. */
async function claimFile(file, contents) {
  const temporary = `${file}.${randomUUID()}.claim`;
  try { await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 }); await link(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

/** Runtime reuse proves package identity and exact engine version, never PATH resemblance. */
export async function inspectWorkbenchRuntime(runtime, { expectedEngine, platform = process.platform, arch = process.arch, runtimeChecks } = {}) {
  if (typeof runtime !== 'string' || !isAbsolute(runtime)) throw new Error('BenchGo 引擎目录必须是绝对路径');
  runtime = await realpath(runtime);
  // Installers may reuse an inspection only within the same ownership and installation lock.
  const key = `${platform}:${arch}:${runtime}`;
  const checked = runtimeChecks?.get(key);
  if (checked) {
    if (expectedEngine && checked.engineVersion !== expectedEngine) throw new Error('已有 Harness 引擎不兼容，原环境已保留');
    return checked;
  }
  const manifest = await readJson(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  if (manifest.name !== '@deepseek-ai/dsh' || !version(manifest.version) || expectedEngine && manifest.version !== expectedEngine)
    throw new Error('已有 Harness 引擎不兼容，原环境已保留');
  for (const name of ['@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-official-bundles']) {
    const dependency = await readJson(join(workbenchPackageDirectory(runtime, name), 'package.json'));
    if (dependency.name !== name || dependency.version !== manifest.version) throw new Error('已有 Harness 引擎依赖身份不一致，原环境已保留');
  }
  let descriptor;
  try { descriptor = await readJson(join(runtime, 'desktop-runtime.json')); } catch (error) { if (!missing(error)) throw error; }
  if (descriptor && (descriptor.schemaVersion !== 1 || descriptor.platform !== platform || descriptor.arch !== arch
    || descriptor.release?.version !== manifest.version || !Array.isArray(descriptor.sharedPackages) || !Array.isArray(descriptor.files)))
    throw new Error('已有桌面运行时的平台或架构不兼容');
  if (descriptor) {
    const names = new Set();
    for (const entry of descriptor.sharedPackages) {
      if (!/^@deepseek-ai\/[a-z0-9-]+$/.test(entry.name) || names.has(entry.name) || entry.path !== `node_modules/${entry.name}` || !version(entry.version))
        throw new Error('桌面运行时共享服务描述无效');
      names.add(entry.name);
    }
    for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host'])
      if (!descriptor.sharedPackages.some(entry => entry.name === name && entry.version === manifest.version)) throw new Error('桌面运行时缺少匹配的官方宿主');
    for (let offset = 0; offset < descriptor.sharedPackages.length; offset += 16) {
      await Promise.all(descriptor.sharedPackages.slice(offset, offset + 16).map(async entry => {
        const actual = await readJson(join(runtime, entry.path, 'package.json'));
        if (actual.name !== entry.name || actual.version !== entry.version) throw new Error('桌面运行时共享服务身份不一致');
      }));
    }
  }
  const result = { runtime, engineVersion: manifest.version, ...(descriptor ? { runtimeDigest: createHash('sha256').update(JSON.stringify(descriptor)).digest('hex') } : {}) };
  runtimeChecks?.set(key, result);
  return result;
}

async function checkInstallation(value, options = {}) {
  const paths = workbenchPaths(options);
  const { platform = process.platform, arch = process.arch } = options;
  if (!value || value.schemaVersion !== 1 || !['web', 'desktop'].includes(value.kind)
    || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.id)
    || value.platform !== platform || value.arch !== arch || !version(value.engineVersion)
    || typeof value.profile !== 'string' || resolve(value.profile) !== paths.profile)
    throw new Error('BenchGo 安装记录与当前用户、平台或工作区不一致，原文件已保留');
  const runtime = await inspectWorkbenchRuntime(value.runtime, { ...options, expectedEngine: options.expectedEngine || value.engineVersion });
  const profile = await readJson(join(paths.profile, 'package.json'));
  if (!Array.isArray(profile.dsh?.profile?.bundles)) throw new Error('已有工作区配置无效，原文件已保留');
  if (typeof value.node !== 'string' || !isAbsolute(value.node) || !(await stat(value.node)).isFile()) throw new Error('BenchGo 启动程序已移动，请重新登记安装');
  for (const key of ['executable', 'resources', 'primaryRuntime', 'launcher'])
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !isAbsolute(value[key]))) throw new Error('BenchGo 安装记录包含无效资源路径');
  return { ...value, ...runtime, profile: paths.profile, ...(profile.dsh?.plusInstall?.version ? { pluginVersion: profile.dsh.plusInstall.version } : {}) };
}

export async function readWorkbenchInstallation(options = {}) {
  let value;
  try { value = await safeJson(workbenchPaths(options).registryFile); } catch (error) { if (missing(error)) return null; throw error; }
  return checkInstallation(value, options);
}

export async function registerWorkbenchInstallation({ installation, ...options }) {
  const paths = workbenchPaths(options);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  let previous;
  try { previous = await safeJson(paths.registryFile); } catch (error) { if (!missing(error)) throw error; }
  const next = await checkInstallation({ schemaVersion: 1, id: previous?.id || randomUUID(),
    platform: process.platform, arch: process.arch, ...installation, profile: installation.profile || paths.profile,
    updatedAt: previous?.updatedAt }, options);
  if (previous && typeof previous.updatedAt === 'string' && isDeepStrictEqual(previous, next)) return next;
  next.updatedAt = new Date().toISOString();
  const temporary = `${paths.registryFile}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); await rename(temporary, paths.registryFile); }
  finally { await rm(temporary, { force: true }); }
  return next;
}

async function readLease(file, { isAlive = processExists } = {}) {
  let value;
  try { value = await safeJson(file); } catch (error) { if (missing(error)) return null; throw error; }
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1 || !/^[a-f0-9]{64}$/.test(value.token))
    throw new Error('BenchGo 进程锁无效，未自动删除');
  return { ...value, active: isAlive(value.pid) };
}

export async function readWorkbenchLease(options = {}) {
  return readLease(workbenchPaths(options).hostLock, options);
}

async function acquireLease(file, value, options = {}) {
  await mkdir(workbenchPaths(options).directory, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await claimFile(file, `${JSON.stringify(value)}\n`);
      return async () => { const current = await readLease(file, options); if (current?.token === value.token) await rm(file); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Serialize stale-owner recovery. Two rescuers must never unlink each other's new lease.
      const recovery = `${file}.recovery`;
      try { await mkdir(recovery); }
      catch (failure) { if (failure.code === 'EEXIST') throw new Error(`BenchGo 所有权正在恢复或恢复被中断；确认所有安装操作已结束后，可移除恢复标记 ${recovery}`); throw failure; }
      try {
        const prior = await readLease(file, options);
        if (prior?.active) throw new Error('已有 BenchGo 工作台或安装操作正在运行，请先完成或关闭后重试');
        if (prior) await rm(file);
      } finally { await rm(recovery, { recursive: true }); }
    }
  }
  throw new Error('无法取得 BenchGo 工作台所有权');
}

/** A live Host lease is separate from the official profile's short package-write lock. */
export async function acquireWorkbenchLease({ kind = 'web', pid = process.pid, ...options } = {}) {
  if (!['web', 'desktop'].includes(kind) || !Number.isSafeInteger(pid) || pid < 1) throw new Error('无效工作台所有者');
  return acquireLease(workbenchPaths(options).hostLock, { schemaVersion: 1, pid, token: randomBytes(32).toString('hex'), kind }, options);
}

/** Hold Desktop's own compatibility lock while a CLI-owned Host uses its reserved profile. */
export async function acquireWorkbenchProfileLock({ profile, pid = process.pid, isAlive = processExists } = {}) {
  if (typeof profile !== 'string' || !isAbsolute(profile) || !Number.isSafeInteger(pid) || pid < 1) throw new Error('工作区锁路径无效');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const file = join(await realpath(profile), 'lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await claimFile(file, `${pid}\n`);
      return async () => {
        const info = await lstat(file).catch(error => { if (missing(error)) return null; throw error; });
        if (info?.isFile() && !info.isSymbolicLink() && (await readFile(file, 'utf8')).trim() === String(pid)) await rm(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const recovery = `${file}.benchgo-recovery`;
      try { await mkdir(recovery); } catch (failure) { if (failure.code === 'EEXIST') throw new Error(`工作区锁正在恢复或恢复被中断；确认所有安装操作已结束后，可移除恢复标记 ${recovery}`); throw failure; }
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('已有官方工作区锁无效，未删除');
        const text = (await readFile(file, 'utf8')).trim(), owner = Number(text);
        if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(owner) || isAlive(owner)) throw new Error('官方工作区正在使用中，未启动第二个工作台');
        await rm(file);
      } finally { await rm(recovery, { recursive: true }); }
    }
  }
  throw new Error('无法取得官方工作区锁');
}

/** Pre-registry installations still own their data; never bypass their product-level owner lock. */
export async function assertWorkbenchDataAvailable({ userHome = homedir(), isAlive = processExists } = {}) {
  for (const directory of [join(userHome, '.benchgo'), join(userHome, '.dowork', 'commander')]) {
    let owner;
    try { owner = await safeJson(join(directory, 'owner.lock')); } catch (error) { if (missing(error)) continue; throw error; }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.host !== 'string' || !owner.host)
      throw new Error('已有 BenchGo 数据锁无效，未改动原环境');
    if (owner.host !== hostname() || isAlive(owner.pid)) throw new Error('已有未登记或其他工作台正在使用 BenchGo 数据，请先关闭原工作台');
  }
}

export async function withWorkbenchInstallLock(options, operation) {
  const release = await acquireLease(workbenchPaths(options).installLock,
    { schemaVersion: 1, pid: process.pid, token: randomBytes(32).toString('hex'), kind: 'install' }, options);
  try { return await operation(); } finally { await release(); }
}

export function loopbackUrl(value, { authenticated = false } = {}) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.hash
    || authenticated && !url.searchParams.get('token')) throw new Error('BenchGo 本机连接地址无效');
  return url;
}

/** A private, per-Host capability controls only our launcher; it is never a public model API. */
export async function requestWorkbenchControl(installation, { action = 'status', fetcher = globalThis.fetch, timeoutMs = 15_000, ...options } = {}) {
  if (!['status', 'stop'].includes(action)) throw new Error('不支持的工作台控制操作');
  const paths = workbenchPaths(options);
  const owner = await safeJson(paths.ownerFile);
  if (owner.installationId !== installation.id || !/^[a-f0-9]{64}$/.test(owner.token) || !Number.isSafeInteger(owner.pid) || !processExists(owner.pid))
    throw new Error('BenchGo 启动凭据已失效，请检查工作台进程');
  const url = loopbackUrl(owner.controlUrl);
  if (url.pathname !== '/' || url.search) throw new Error('BenchGo 本机控制地址无效');
  const response = await fetcher(url, { method: 'POST', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action }), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.text();
  if (body.length > 64 * 1024) throw new Error('BenchGo 工作台响应超出限制');
  const value = JSON.parse(body);
  if (!response.ok) throw new Error(value.error || 'BenchGo 工作台操作失败');
  if (value.installationId !== installation.id || value.pid !== owner.pid) throw new Error('BenchGo 工作台身份验证失败');
  return value;
}

export async function waitForWorkbenchStop({ timeoutMs = 15_000, ...options } = {}) {
  const until = Date.now() + timeoutMs;
  do { const lease = await readWorkbenchLease(options); if (!lease?.active) return; await delay(100); } while (Date.now() < until);
  throw new Error('BenchGo 尚未完成安全关闭，未启动第二个工作台');
}
