/** Acquire only signed, matching native production payloads; local carriers remain valid offline. */
import { access, mkdir, mkdtemp, readFile, readlink, realpath, readdir, rename, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { shared } from './shared.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const bundled = fileURLToPath(new URL('../resources/', import.meta.url));
export const exists = async path => { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const json = async path => JSON.parse(await readFile(path, 'utf8'));

export async function loadInstallMetadata(resourceRoot) {
  const candidates = [resourceRoot && join(resourceRoot, 'install.json'), join(bundled, 'install.json')].filter(Boolean);
  for (const path of candidates) if (await exists(path)) return validateMetadata(await json(path));
  const [upstream, plugin] = await Promise.all([json(join(root, 'upstream.json')), json(join(root, 'plugins/base/package.json'))]);
  return validateMetadata({ schemaVersion: 1, engineVersion: upstream.version, pluginVersion: plugin.version,
    releaseVersion: plugin.benchgo?.releaseVersion || plugin.version });
}

export function validateMetadata(value) {
  const version = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
  if (value?.schemaVersion !== 1 || !version.test(value.engineVersion) || !version.test(value.pluginVersion)
    || !/^\d+\.\d+\.\d+$/.test(value.releaseVersion)) throw new Error('工作台安装资源版本信息无效');
  return value;
}

export function command(bin, args, { env = process.env, cwd, capture = false, allowFailure = false } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(bin, args, { cwd, env: { ...env, DSH_TELEMETRY_DISABLED: '1' },
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', windowsHide: true });
    let stdout = '', stderr = '';
    if (capture) { child.stdout.on('data', data => { stdout = (stdout + data).slice(-65536); }); child.stderr.on('data', data => { stderr = (stderr + data).slice(-65536); }); }
    child.once('error', error => allowFailure ? done({ code: null, stdout, stderr, error }) : reject(error));
    child.once('exit', code => code === 0 || allowFailure ? done({ code: code ?? 1, stdout, stderr }) : reject(new Error(stderr.trim() || `${bin} 退出码 ${code}`)));
  });
}

export function safeArchiveName(name) {
  if (typeof name !== 'string' || name.length > 2048 || name.includes('\\') || isAbsolute(name)
    || name.replace(/\/$/, '').split('/').some(part => !part || part === '.' || part === '..'
      || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
    throw new Error('发行归档包含不安全路径');
}

export async function extractTar(archive, directory) {
  const tar = await import('tar');
  let bytes = 0, count = 0, failure;
  const seen = new Set();
  await tar.t({ file: archive, strict: true, onReadEntry(entry) {
    try {
      safeArchiveName(entry.path);
      const key = entry.path.replace(/\/$/, '').toLowerCase();
      if (seen.has(key)) throw new Error('发行归档包含重复路径');
      seen.add(key);
      if (!['File', 'Directory'].includes(entry.type) || !Number.isSafeInteger(entry.size) || entry.size < 0
        || ++count > 80_000 || (bytes += entry.size) > 2 * 1024 ** 3) throw new Error('发行归档条目或体积超限');
    } catch (error) { failure ||= error; }
  } });
  if (failure) throw failure;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await tar.x({ file: archive, cwd: directory, strict: true, preservePaths: false, noMtime: true, noChmod: true });
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

async function inventory(directory, prefix = '') {
  const result = [];
  for (const item of (await readdir(join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!prefix && item.name === '.benchgo-payload.json') continue;
    const path = prefix ? `${prefix}/${item.name}` : item.name, absolute = join(directory, path);
    if (item.isSymbolicLink()) {
      const target = relative(await realpath(directory), await realpath(absolute));
      if (isAbsolute(target) || target === '..' || target.startsWith(`..${sep}`)) throw new Error('发行资源链接超出应用目录');
      result.push({ path, link: await readlink(absolute) });
    } else if (item.isDirectory()) result.push(...await inventory(directory, path));
    else if (item.isFile()) result.push({ path, size: (await stat(absolute)).size, sha256: await hashFile(absolute) });
    else throw new Error('发行缓存包含非普通资源');
  }
  return result;
}

/** Native Desktop resources remain one carrier, including its matching Node ABI and offline dependencies. */
export async function desktopCarrier(runtime) {
  const resources = dirname(dirname(runtime));
  if (!await exists(join(resources, 'runtime/primary-runtime'))) return {};
  const node = process.platform === 'win32' ? join(dirname(resources), 'BenchGo.exe') : join(dirname(resources), 'MacOS', 'BenchGo');
  if (!await exists(node)) return {};
  return { runtime, resources, primaryRuntime: join(resources, 'runtime/primary-runtime'), node, electron: true };
}

async function cachedArtifact(artifact, directory, { source, fetcher, signal, onProgress }) {
  const { fetchReleaseArtifact } = await shared('update-feed.mjs');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${artifact.sha256}-${new URL(artifact.url).pathname.split('/').at(-1)}`);
  if (await exists(file)) {
    const bytes = await stat(file);
    if (bytes.size === artifact.size && await hashFile(file) === artifact.sha256) return file;
    await rm(file);
  }
  const temporary = `${file}.${process.pid}.part`;
  try {
    await fetchReleaseArtifact(artifact, { file: temporary, config: { source }, fetcher, signal, onProgress, maxBytes: 1024 ** 3 });
    await rename(temporary, file); return file;
  } finally { await rm(temporary, { force: true }); }
}

async function findSeed(directory, depth = 0) {
  if (await exists(join(directory, 'release.json')) && await exists(join(directory, 'node_modules/benchgo-plugin/package.json'))) return { seed: directory };
  if (depth >= 5) return null;
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (!item.isDirectory() || ['node_modules', 'Frameworks', 'runtime'].includes(item.name)) continue;
    const found = await findSeed(join(directory, item.name), depth + 1);
    if (found) {
      const resources = item.name === 'Contents' ? join(directory, item.name, 'Resources') : null;
      return { ...found, ...(resources && await exists(join(resources, 'app.asar.unpacked', 'dsh')) ? {
        ...await desktopCarrier(join(resources, 'app.asar.unpacked', 'dsh')),
      } : {}) };
    }
  }
  return null;
}

export async function acquirePayload({ metadata, cache, root: resourceRoot, platform = process.platform, arch = process.arch,
  source = 'mirror', offline = false, fetcher = globalThis.fetch, signal, onProgress, runCommand = command, catalogLoader } = {}) {
  const { fetchVerifiedDownloadCatalog } = await shared('update-feed.mjs');
  for (const candidate of [resourceRoot, resourceRoot && join(resourceRoot, 'benchgo/seed'), resourceRoot && join(resourceRoot, 'Contents/Resources/benchgo/seed')].filter(Boolean)) {
    if (await exists(join(candidate, 'release.json'))) {
      const manifest = await json(join(candidate, 'release.json'));
      if (manifest.platform !== platform || manifest.arch !== arch || manifest.version !== metadata.pluginVersion) throw new Error('本地工作台种子版本、平台或架构不匹配');
      const nativeRuntime = join(dirname(dirname(candidate)), 'app.asar.unpacked', 'dsh');
      return { seed: candidate, ...await desktopCarrier(nativeRuntime), origin: 'offline' };
    }
  }
  const target = platform === 'win32' ? 'plugin' : platform === 'linux' ? 'linux-server' : `mac-${arch}`;
  if (offline) throw new Error('离线模式缺少兼容的完整工作台种子；请用 --root 指定已准备的原生资源目录');
  const { catalog } = await (catalogLoader || fetchVerifiedDownloadCatalog)({ releaseVersion: metadata.releaseVersion, config: { source }, fetcher, signal });
  const artifact = catalog.files.find(row => row.target === target && (platform !== 'darwin' || row.url.endsWith('.zip')));
  if (!artifact || platform === 'win32' && artifact.version !== metadata.pluginVersion) throw new Error('此发行没有匹配平台的完整工作台资源，未使用其他平台包替代');
  const file = await cachedArtifact(artifact, cache, { source, fetcher, signal, onProgress });
  // Reuse the established plugin installer archive policy instead of maintaining a second extractor.
  if (platform === 'win32') return { archive: file, origin: 'download', artifact };
  const extraction = join(cache, `payload-${artifact.sha256}`);
  const temporary = await mkdtemp(join(cache, '.extract-'));
  try {
    if (platform === 'darwin') await runCommand('/usr/bin/ditto', ['-x', '-k', file, temporary], { capture: true });
    else await extractTar(file, temporary);
    if (platform === 'linux') {
      let nested;
      const locate = async (base, depth = 0) => {
        if (await exists(join(base, 'server-seed.tar.gz'))) return base;
        if (depth > 2) return null;
        for (const item of await readdir(base, { withFileTypes: true })) if (item.isDirectory()) { const result = await locate(join(base, item.name), depth + 1); if (result) return result; }
        return null;
      };
      nested = await locate(temporary);
      if (!nested) throw new Error('Linux 发行缺少完整工作台种子');
      const manifest = await json(join(nested, 'manifest.json'));
      if (manifest.pluginVersion !== metadata.pluginVersion || manifest.harnessVersion !== metadata.engineVersion
        || await hashFile(join(nested, 'server-seed.tar.gz')) !== manifest.sha256) throw new Error('Linux 工作台种子身份或摘要不一致');
      await extractTar(join(nested, 'server-seed.tar.gz'), join(temporary, 'seed'));
    }
    const located = await findSeed(temporary);
    if (!located) throw new Error('原生发行中未找到完整工作台种子');
    const manifest = await json(join(located.seed, 'release.json'));
    if (manifest.platform !== platform || manifest.arch !== arch || manifest.version !== metadata.pluginVersion) throw new Error('发行种子与请求的平台、架构或插件版本不一致');
    // Re-derive expected bytes from the verified signed archive, never from a writable receipt.
    const expected = await inventory(temporary);
    if (await exists(extraction)) {
      let matches = false;
      try { matches = JSON.stringify(expected) === JSON.stringify(await inventory(extraction)); } catch {}
      if (matches) {
        await rm(join(extraction, '.benchgo-payload.json'), { force: true });
        return { ...await findSeed(extraction), origin: 'cache', artifact };
      }
      // A cached macOS app can itself be the active carrier. Never unlink its live files.
      const api = await shared('workbench-installation.mjs');
      const home = dirname(dirname(dirname(cache)));
      const lease = await api.readWorkbenchLease({ home });
      const installation = lease?.active && await api.readWorkbenchInstallation({ home });
      if (installation && relative(extraction, installation.runtime).split(sep)[0] !== '..'
        && !isAbsolute(relative(extraction, installation.runtime))) throw new Error('正在运行的应用载体缓存有损坏，请先安全停止工作台；下次安装会自动修复');
      await rm(extraction, { recursive: true, force: true });
    }
    await rename(temporary, extraction);
    return { ...await findSeed(extraction), origin: 'download', artifact };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
