/** Cross-platform local installation built on official runtime and immutable BenchGo releases. */
import { open, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { delimiter, join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { shared } from './shared.mjs';
import { acquirePayload, command, desktopCarrier, exists, loadInstallMetadata } from './artifacts.mjs';
import { readServerInstallation } from './server.mjs';

const api = await shared('workbench-installation.mjs');
const { workbenchPaths, readWorkbenchInstallation, registerWorkbenchInstallation, readWorkbenchLease,
  requestWorkbenchControl, waitForWorkbenchStop, withWorkbenchInstallLock, inspectWorkbenchRuntime, workbenchPackageDirectory } = api;
const hostScript = fileURLToPath(new URL('./host.mjs', import.meta.url));
const delay = ms => new Promise(done => setTimeout(done, ms));

export function supportedPlatform(platform, arch) {
  return platform === 'win32' && arch === 'x64' || platform === 'darwin' && ['x64', 'arm64'].includes(arch) || platform === 'linux' && arch === 'x64';
}

/** Only actual interactive local sessions open a browser by default. */
export function shouldOpenBrowser({ open, json: asJson = false } = {}, { env = process.env, stdout = process.stdout, platform = process.platform } = {}) {
  if (open !== undefined) return open;
  return !asJson && !!stdout.isTTY && !env.SSH_CONNECTION && !env.SSH_CLIENT && !env.CI
    && (platform !== 'linux' || !!(env.DISPLAY || env.WAYLAND_DISPLAY));
}

export async function openBrowser(url, { platform = process.platform, runCommand = command } = {}) {
  api.loopbackUrl(url, { authenticated: true });
  if (platform === 'win32') {
    // Shell metacharacters never pass through cmd.exe or PowerShell interpolation.
    await runCommand('rundll32.exe', ['url.dll,FileProtocolHandler', url], { capture: true });
  } else if (platform === 'darwin') await runCommand('/usr/bin/open', [url], { capture: true });
  else await runCommand('xdg-open', [url], { capture: true });
}

/** Inspect ordinary npm installation locations; package identity, never a command name, authorizes reuse. */
export async function discoverOfficialRuntime(metadata, { env = process.env, executable = process.execPath, candidateRoots } = {}) {
  const roots = candidateRoots || [env.BENCHGO_RUNTIME, ...[dirname(executable), env.npm_config_prefix, ...(env.PATH || '').split(delimiter)]
    .filter(Boolean).flatMap(base => [base, join(base, 'lib'), resolve(base, '../lib')])];
  let incompatible;
  for (const candidate of new Set(roots.filter(Boolean).map(path => resolve(path)))) {
    if (!await exists(join(candidate, 'node_modules/@deepseek-ai/dsh/package.json'))) continue;
    try {
      const inspected = await inspectWorkbenchRuntime(candidate, { expectedEngine: metadata.engineVersion });
      return { ...inspected, ...await desktopCarrier(inspected.runtime), reusedRuntime: true };
    } catch (error) { incompatible ||= error; }
  }
  if (incompatible) throw new Error(`检测到已有官方 Harness，但其版本或依赖不兼容；未重复安装引擎。请升级原引擎，或用 --runtime 指定精确兼容的引擎。${incompatible.message}`);
  return null;
}

async function officialRuntime(metadata, paths, options, dependencies) {
  const { runCommand = command } = dependencies;
  if (options.runtime) {
    const inspected = await inspectWorkbenchRuntime(resolve(options.runtime), { expectedEngine: metadata.engineVersion });
    return { ...inspected, ...await desktopCarrier(inspected.runtime) };
  }
  const runtime = join(paths.runtimes, metadata.engineVersion);
  if (await exists(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json')))
    return inspectWorkbenchRuntime(runtime, { expectedEngine: metadata.engineVersion });
  const discovered = await discoverOfficialRuntime(metadata, dependencies);
  if (discovered) return discovered;
  if (options.offline) throw new Error('离线模式缺少兼容官方引擎；请用 --runtime 指定已安装的完整引擎');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || major === 24 && minor < 9) throw new Error('本机工作台需要 Node.js 24.9 或更新版本；已有桌面运行时可通过 --runtime 复用');
  const temporary = `${runtime}.install-${randomUUID()}`;
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  const registry = options.source === 'github' ? 'https://registry.npmjs.org' : 'https://registry.npmmirror.com';
  try {
    await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, dependencies: {
      '@deepseek-ai/dsh': metadata.engineVersion, '@deepseek-ai/dsh-atomic-write': metadata.engineVersion,
      '@deepseek-ai/dsh-llm': metadata.engineVersion,
    } }), { mode: 0o600 });
    // npm's JS entry avoids Windows shell execution and preserves argument boundaries.
    const npmJs = process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath) ? process.env.npm_execpath
      : join(dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
    if (!await exists(npmJs)) throw new Error('未找到 npm CLI，请使用包含 npm 的 Node.js 发行版');
    await runCommand(process.execPath, [npmJs, 'install', '--prefix', temporary, '--omit=dev', '--no-audit', '--no-fund', '--registry', registry], { capture: true });
    await inspectWorkbenchRuntime(temporary, { expectedEngine: metadata.engineVersion });
    await mkdir(paths.runtimes, { recursive: true, mode: 0o700 });
    await rename(temporary, runtime);
    return inspectWorkbenchRuntime(runtime, { expectedEngine: metadata.engineVersion });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function waitReady(installation, options, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let failure;
  do {
    try { return await requestWorkbenchControl(installation, { home: options.home, timeoutMs: 1500 }); }
    catch (error) { failure = error; }
    await delay(150);
  } while (Date.now() < deadline);
  throw new Error(`工作台未正常就绪，原配置已保留；请查看 ${workbenchPaths(options).log}。${failure?.message || ''}`);
}

export async function startWorkbench(options = {}, dependencies = {}) {
  const paths = workbenchPaths(options);
  const installation = await readWorkbenchInstallation({ home: paths.home });
  if (!installation) throw new Error('工作台尚未安装，请先运行 benchgo install');
  const lease = await readWorkbenchLease({ home: paths.home });
  if (lease?.active) return { installation, ...await requestWorkbenchControl(installation, { home: paths.home }) };
  if (dependencies.startHost) return dependencies.startHost(installation, { ...options, home: paths.home });
  const log = await open(paths.log, 'a', 0o600);
  let child;
  try {
    child = spawn(installation.node, ['--expose-internals', hostScript, paths.home], {
      detached: true, windowsHide: true, cwd: paths.profile,
      env: { ...process.env, DSH_HOME: paths.home, DSH_TELEMETRY_DISABLED: '1',
        ...(installation.kind === 'desktop' || installation.primaryRuntime ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
    child.unref();
  } finally { await log.close(); }
  return { installation, ...await waitReady(installation, { home: paths.home }) };
}

export async function stopWorkbench(options = {}) {
  const installation = await readWorkbenchInstallation(options);
  if (!installation) return { installed: false, running: false };
  const lease = await readWorkbenchLease(options);
  if (!lease?.active) return { installed: true, running: false };
  if (lease.kind === 'desktop') throw new Error('当前工作台由桌面客户端管理，请在客户端退出；命令行不会强制关闭它');
  const stopped = await requestWorkbenchControl(installation, { ...options, action: 'stop' });
  if (stopped.stopped !== true) throw new Error('工作台尚未确认安全关闭');
  await waitForWorkbenchStop(options);
  return { installed: true, running: false, stopped: true };
}

export async function workbenchStatus(options = {}) {
  const installation = await readWorkbenchInstallation(options);
  if (!installation) return { installed: false, running: false };
  const lease = await readWorkbenchLease(options);
  if (!lease?.active) return { installed: true, running: false, installation };
  return { installed: true, running: true, kind: lease.kind, installation,
    ...await requestWorkbenchControl(installation, options) };
}

async function bootProfile(runtime, paths) {
  const boot = await import(pathToFileURL(join(workbenchPackageDirectory(runtime, '@deepseek-ai/dsh-app-boot'), 'lib/index.js')).href);
  const official = await import(pathToFileURL(join(workbenchPackageDirectory(runtime, '@deepseek-ai/dsh-official-bundles'), 'lib/index.js')).href);
  if (!await exists(join(paths.profile, 'package.json'))) boot.initProfile(paths.profile, official.PROFILE_TEMPLATES.web.bundles);
}

export async function installWorkbench(options = {}, dependencies = {}) {
  const { platform = process.platform, arch = process.arch, payloadLoader = acquirePayload,
    runtimeInstaller = officialRuntime, initializeProfile = bootProfile } = dependencies;
  if (!supportedPlatform(platform, arch)) throw new Error(`暂无 ${platform}-${arch} 的受支持工作台资源，未尝试其他平台包`);
  const paths = workbenchPaths(options);
  let metadata = dependencies.metadata || await loadInstallMetadata(options.root);
  options = { ...options, source: options.source || 'mirror', home: paths.home };
  return withWorkbenchInstallLock(options, async () => {
    let existing = await readWorkbenchInstallation(options);
    if (existing && !options.update) return { reused: true, ...await startWorkbench(options, dependencies) };
    const updates = await shared('update-feed.mjs');
    if (options.update && !options.offline && !options.root) {
      const release = await (dependencies.releaseLoader || updates.fetchVerifiedRelease)({ config: { source: options.source } });
      if (existing && !updates.isEngineCompatible(existing.engineVersion, release.engine)) throw new Error('最新功能包需要新版引擎，请先升级原安装载体；当前环境已保留');
      metadata = { schemaVersion: 1, engineVersion: existing?.engineVersion || metadata.engineVersion,
        pluginVersion: release.version, releaseVersion: release.releaseVersion || release.version };
    }
    if (existing?.pluginVersion && updates.compareVersions(existing.pluginVersion, metadata.pluginVersion) >= 0)
      return { reused: true, updated: false, ...await startWorkbench(options, dependencies) };
    if (!existing && await readServerInstallation(options)) throw new Error('检测到已有 SSH/systemd 工作台，未再创建另一套；请使用 benchgo server status/start/update 管理原安装');
    if (!existing && await exists(join(paths.profile, 'package.json'))) throw new Error('检测到尚未登记的官方或旧版桌面工作区；请先用新版 BenchGo Desktop 登记，再由 CLI 连接，原配置已保留');
    if (!existing) await api.assertWorkbenchDataAvailable();
    if (existing && existing.engineVersion !== metadata.engineVersion) throw new Error('更新需要兼容的新版引擎，请先升级原安装载体；当前环境已保留');
    const lease = await readWorkbenchLease(options);
    if (lease?.active && lease.kind === 'desktop') throw new Error('请先在桌面客户端完成更新或退出，再更新工作台资源');
    if (lease?.active) {
      const status = await requestWorkbenchControl(existing, options);
      if (status.activeTasks || status.scheduledTasks) throw new Error('有运行、等待交互或已安排的任务，请完成后再更新');
    }
    const payload = await payloadLoader({ metadata, cache: paths.cache, ...options, platform, arch });
    const runtime = existing ? { runtime: existing.runtime, engineVersion: existing.engineVersion }
      : payload.runtime ? { ...await inspectWorkbenchRuntime(payload.runtime, { expectedEngine: metadata.engineVersion }), ...payload }
        : await runtimeInstaller(metadata, paths, options, dependencies);
    const freshProfile = !await exists(paths.profile);
    const initialFiles = new Map();
    let releaseProfile, release, previousManifest, previousRegistry, committed = false, restartPrevious = false;
    const manifestFile = join(paths.profile, 'package.json');
    try {
      if (!lease?.active) releaseProfile = await api.acquireWorkbenchProfileLock({ profile: paths.profile });
      await initializeProfile(runtime.runtime, paths);
      if (freshProfile) for (const entry of await readdir(paths.profile, { withFileTypes: true }))
        if (entry.isFile() && entry.name !== 'lock') initialFiles.set(entry.name, await readFile(join(paths.profile, entry.name)));
      const { prepareRelease, activateRelease, getInstallState } = await shared('plugin-install.mjs');
      const before = await getInstallState(paths.profile);
      if (before.managed && updates.compareVersions(before.version, metadata.pluginVersion) > 0)
        throw new Error('本机已有更新的功能包，未用较旧安装资源覆盖');
      release = await prepareRelease({ directory: payload.seed, archive: payload.archive, root: join(paths.profile, '.benchgo', 'releases'), version: metadata.pluginVersion, runtime: runtime.runtime });
      if (lease?.active) await stopWorkbench(options);
      releaseProfile ||= await api.acquireWorkbenchProfileLock({ profile: paths.profile });
      previousManifest = await readFile(manifestFile);
      previousRegistry = await exists(paths.registryFile) ? await readFile(paths.registryFile) : null;
      await activateRelease({ profile: paths.profile, runtime: runtime.runtime, release,
        enabled: before.managed ? before.enabled : true, migrateLegacy: true });
      const installation = await registerWorkbenchInstallation({ home: paths.home, installation: { ...existing,
        kind: existing?.kind || 'web', runtime: runtime.runtime, engineVersion: runtime.engineVersion,
        profile: paths.profile, node: existing?.node || runtime.node || process.execPath,
        ...(runtime.primaryRuntime ? { primaryRuntime: runtime.primaryRuntime, resources: runtime.resources } : {}),
        ...(payload.primaryRuntime ? { primaryRuntime: payload.primaryRuntime } : {}),
        ...(payload.resources ? { resources: payload.resources } : {}), launcher: hostScript, releaseVersion: metadata.releaseVersion } });
      committed = true;
      await releaseProfile(); releaseProfile = undefined;
      return { reused: !!existing, installed: true, installation, ...await startWorkbench(options, dependencies) };
    } catch (error) {
      // Once a first installation can have booted, keep its valid registration and any data it wrote.
      if (!existing && committed) throw new Error(`工作台已安装，启动尚未成功；可直接 benchgo start 重试。${error.message}`, { cause: error });
      // Only our manifest pointer is restored; user patches/data and prepared immutable releases stay intact.
      const currentLease = await readWorkbenchLease(options);
      if (currentLease?.active && previousManifest) {
        try { await stopWorkbench(options); }
        catch { throw new Error(`新工作台仍持有所有权，未覆盖运行中的配置；请检查 ${paths.log}。${error.message}`, { cause: error }); }
      }
      if (previousManifest) {
        releaseProfile ||= await api.acquireWorkbenchProfileLock({ profile: paths.profile });
        await api.assertWorkbenchDataAvailable();
      }
      const restore = async (file, value) => {
        const temporary = `${file}.${randomUUID()}.restore`;
        try { await writeFile(temporary, value, { mode: 0o600, flag: 'wx' }); await rename(temporary, file); }
        finally { await rm(temporary, { force: true }); }
      };
      if (previousManifest) {
        await restore(manifestFile, previousManifest);
        if (previousRegistry) await restore(paths.registryFile, previousRegistry);
        else await rm(paths.registryFile, { force: true });
      }
      if (freshProfile && initialFiles.size && !committed) {
        // Remove only our never-started generated release and unchanged initialization files.
        if (release) {
          const link = join(paths.profile, 'node_modules', release.bundleName);
          if ((await lstat(link).catch(() => null))?.isSymbolicLink() && await realpath(link) === await realpath(release.bundlePath)) await unlink(link);
          await rm(release.directory, { recursive: true, force: true });
        }
        for (const [name, bytes] of initialFiles) {
          const file = join(paths.profile, name), actual = await readFile(file).catch(() => null);
          if (actual?.equals(bytes)) await rm(file);
        }
        for (const directory of [join(paths.profile, '.benchgo/releases'), join(paths.profile, '.benchgo'), join(paths.profile, 'node_modules')])
          await rmdir(directory).catch(failure => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(failure.code)) throw failure; });
        await releaseProfile?.(); releaseProfile = undefined;
        await rmdir(paths.profile).catch(failure => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(failure.code)) throw failure; });
      }
      restartPrevious = !!existing && !!lease?.active && !!previousManifest;
      throw error;
    } finally {
      await releaseProfile?.();
      if (restartPrevious) await startWorkbench(options, dependencies).catch(() => {});
    }
  });
}
