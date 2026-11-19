/** Verified Linux deployment resources, shared by Link and the installation CLI. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { compareVersions, fetchReleaseArtifact, fetchVerifiedDownloadCatalog, validateDownloadCatalog, verifySignedJson, UpdateFeedError } from './update-feed.mjs';

export const SERVER_RESOURCE_FILES = Object.freeze(['bootstrap.sh', 'bootstrap.mjs', 'manifest.json', 'server-seed.tar.gz']);
const stable = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const digestPattern = /^[a-f0-9]{64}$/;
const requiredFile = async path => {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('服务器部署资源必须为普通文件');
  return info;
};
const readSmallFile = async (path, maximum = 1024 * 1024) => {
  if ((await requiredFile(path)).size > maximum) throw new Error('服务器部署资源元数据超过大小限制');
  return readFile(path);
};
const readJson = async path => JSON.parse((await readSmallFile(path)).toString('utf8'));
const present = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const digest = async (path, signal) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest('hex');
};
const cancelled = signal => { if (signal?.aborted) throw new UpdateFeedError('UPDATE_CANCELLED', '部署资源获取已取消'); };
const report = (onProgress, stage, fields = {}) => onProgress?.({ stage, ...fields, updatedAt: new Date().toISOString() });

export function validateServerResourceDescriptor(value) {
  if (!value || value.schemaVersion !== 1 || !stable.test(value.releaseVersion) || !stable.test(value.pluginVersion)
    || !['full', 'online'].includes(value.delivery)
    || typeof value.harnessVersion !== 'string' || !/^[a-f0-9]{40}$/.test(value.harnessCommit)
    || !digestPattern.test(value.sourceDigest)) throw new Error('服务器部署资源描述无效，请重新构建完整安装资源');
  compareVersions(value.harnessVersion, value.harnessVersion);
  return value;
}

function selectServerArtifact(catalog) {
  const matches = catalog.files.filter(item => item.target === 'linux-server');
  if (matches.length !== 1) throw new Error('匹配发行未提供唯一 Linux 服务器部署包');
  const artifact = matches[0];
  if (artifact.kind !== 'server' || artifact.arch !== 'x64' || !stable.test(artifact.version)
    || !artifact.url.endsWith(`/benchgo-${artifact.version}-linux-server.tar.gz`)) throw new Error('服务器部署包平台或文件名无效');
  return artifact;
}

async function inspectResources(directory, expected, { local = false, hashes, signal } = {}) {
  cancelled(signal);
  for (const name of SERVER_RESOURCE_FILES) {
    const info = await requiredFile(join(directory, name));
    if (!info.size || info.size > (name === 'server-seed.tar.gz' ? 512 * 1024 * 1024 : 1024 * 1024)) throw new Error('服务器部署资源大小无效');
  }
  const manifest = await readJson(join(directory, 'manifest.json'));
  if (manifest.schemaVersion !== 1 || manifest.pluginVersion !== expected.pluginVersion
    || manifest.harnessVersion !== expected.harnessVersion || manifest.harnessCommit !== expected.harnessCommit
    || !digestPattern.test(manifest.sha256) || local && manifest.sourceDigest !== expected.sourceDigest)
    throw new Error('服务器部署资源版本、引擎或来源不匹配，原资源已保留');
  if ((hashes?.['server-seed.tar.gz'] ?? await digest(join(directory, 'server-seed.tar.gz'), signal)) !== manifest.sha256)
    throw new Error('服务器部署种子校验失败，原资源已保留');
  return manifest;
}

async function cacheReceipt(directory, expected, publicKey, signal) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('服务器部署缓存路径不是有效目录');
  for (const name of ['downloads.json', 'downloads.json.sig', 'distribution.tar.gz']) await requiredFile(join(directory, name));
  const catalog = validateDownloadCatalog(verifySignedJson(await readSmallFile(join(directory, 'downloads.json'), 256 * 1024), await readSmallFile(join(directory, 'downloads.json.sig'), 4096), publicKey), expected.releaseVersion);
  const artifact = selectServerArtifact(catalog);
  if (catalog.files.find(file => file.target === 'plugin')?.version !== expected.pluginVersion
    || (await lstat(join(directory, 'distribution.tar.gz'))).size !== artifact.size
    || await digest(join(directory, 'distribution.tar.gz'), signal) !== artifact.sha256) throw new Error('服务器资源缓存归档与签名清单不一致');
  // Derive file hashes from the signed archive each time, never from a writable local receipt.
  const signedFiles = await inspectArchive(join(directory, 'distribution.tar.gz'), artifact, expected, signal);
  const hashes = {};
  for (const name of [...SERVER_RESOURCE_FILES, 'release-source.json']) {
    await requiredFile(join(directory, name));
    if ((hashes[name] = await digest(join(directory, name), signal)) !== signedFiles.hashes[name]) throw new Error('服务器资源缓存文件与已签名归档不一致');
  }
  return { directory, manifest: await inspectResources(directory, expected, { hashes, signal }), origin: 'cache' };
}

async function inspectArchive(archive, artifact, expected, signal) {
  const root = `benchgo-${artifact.version}-linux-server`;
  const allowed = new Set([...SERVER_RESOURCE_FILES, 'README.md', 'LICENSE', 'DEEPSEEK-LICENSE', 'install.sh', 'release-source.json', 'SHA256SUMS.txt', 'resources.json', 'update-public-key.pem']);
  const seen = new Set(), errors = [], hashes = {}, captures = new Map();
  let unpacked = 0;
  const parser = tar.t({ strict: true, onReadEntry(entry) {
    const name = entry.path.replace(/\/$/, ''), parts = name.split('/');
    if (!name || entry.path.includes('\\') || parts[0] !== root || parts.length > 2 || parts.some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]/.test(part))
      || !['File', 'Directory'].includes(entry.type) || name === root && entry.type !== 'Directory' || entry.type === 'Directory' && name !== root
      || name !== root && (!allowed.has(parts[1]) || entry.type !== 'File') || seen.has(name.toLowerCase())) errors.push('服务器部署归档包含不安全或重复路径');
    seen.add(name.toLowerCase());
    unpacked += entry.size;
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || seen.size > 32 || unpacked > 520 * 1024 * 1024
      || name !== `${root}/server-seed.tar.gz` && entry.size > 1024 * 1024) errors.push('服务器部署归档超出解压限制');
    if (entry.type === 'File' && [...SERVER_RESOURCE_FILES, 'release-source.json'].includes(parts[1])) {
      const hash = createHash('sha256'), chunks = [];
      const capture = ['manifest.json', 'release-source.json'].includes(parts[1]);
      entry.on('data', chunk => { hash.update(chunk); if (capture && entry.size <= 1024 * 1024) chunks.push(chunk); });
      entry.on('end', () => { hashes[parts[1]] = hash.digest('hex'); if (capture) captures.set(parts[1], Buffer.concat(chunks)); });
    }
  } });
  await pipeline(createReadStream(archive), parser, { signal });
  if (errors.length) throw new Error(errors[0]);
  for (const name of [...SERVER_RESOURCE_FILES, 'release-source.json']) if (!seen.has(`${root}/${name}`.toLowerCase())) throw new Error(`服务器部署归档缺少 ${name}`);
  cancelled(signal);
  const source = JSON.parse(captures.get('release-source.json'));
  if (source.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(source.sourceSha) || source.version !== artifact.version
    || source.platform !== 'linux' || source.arch !== 'x64' || source.kind !== 'server' || source.pluginVersion !== expected.pluginVersion
    || source.engine?.version !== expected.harnessVersion || source.engine?.commit !== expected.harnessCommit)
    throw new Error('已签名服务器归档与当前插件或引擎不兼容');
  const manifest = JSON.parse(captures.get('manifest.json'));
  if (manifest.schemaVersion !== 1 || manifest.pluginVersion !== expected.pluginVersion || manifest.harnessVersion !== expected.harnessVersion
    || manifest.harnessCommit !== expected.harnessCommit || manifest.sha256 !== hashes['server-seed.tar.gz']) throw new Error('已签名服务器部署种子身份或校验值不一致');
  return { hashes, manifest };
}

async function safeExtract(archive, directory, artifact, expected, signal) {
  const signed = await inspectArchive(archive, artifact, expected, signal);
  await mkdir(directory, { mode: 0o700 });
  await pipeline(createReadStream(archive), tar.x({ cwd: directory, strict: true, strip: 1, preservePaths: false, noMtime: true, noChmod: true }), { signal });
  return signed.manifest;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}

async function removeEmptyRecovery(path) {
  try { await rmdir(path); }
  catch (error) {
    // Windows can report a concurrent directory removal as EPERM while deletion is pending.
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code) && !(process.platform === 'win32' && error.code === 'EPERM')) throw error;
  }
}

const recoveryDisappeared = error => error.code === 'ENOENT' || process.platform === 'win32' && error.code === 'EPERM';

async function removeRecoveryMarker(path) {
  for (let attempt = 0; ; attempt++) {
    try { await unlink(path); return; }
    catch (error) {
      if (error.code === 'ENOENT') return;
      if (process.platform !== 'win32' || error.code !== 'EPERM' || attempt >= 9) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

async function tryRecoveryLock(path) {
  const marker = `owner-${process.pid}-${randomUUID()}.json`, own = join(path, marker);
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
    // PID and token live in the immutable filename, so an interrupted write is recoverable.
    await writeFile(own, '', { mode: 0o600, flag: 'wx' });
    const entries = await readdir(path);
    // An ownerless directory may have been reclaimed between mkdir and marker creation.
    // Only a sole marker holder may enter; cleanup never deletes another holder's marker.
    if (entries.length === 1 && entries[0] === marker) return async () => {
      await removeRecoveryMarker(own);
      await removeEmptyRecovery(path);
    };
  } catch (error) {
    if (created && !recoveryDisappeared(error)) {
      await removeRecoveryMarker(own);
      await removeEmptyRecovery(path);
      throw error;
    }
    if (!created && error.code !== 'EEXIST') {
      if (recoveryDisappeared(error)) return null;
      throw error;
    }
    if (!created) {
      try {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('服务器部署缓存恢复锁不是有效目录');
        const entries = await readdir(path);
        let removed = false;
        for (const entry of entries) {
          const match = /^owner-([1-9]\d*)-[a-f0-9-]{36}\.json$/.exec(entry);
          if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error('服务器部署缓存恢复锁持有者无效');
          if (!processAlive(Number(match[1]))) {
            try { await unlink(join(path, entry)); removed = true; }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
        }
        if (removed || !entries.length && Date.now() - info.mtimeMs > 5000) await removeEmptyRecovery(path);
      } catch (error) { if (!recoveryDisappeared(error)) throw error; }
      return null;
    }
  }
  await removeRecoveryMarker(own);
  await removeEmptyRecovery(path);
  return null;
}

async function acquireLock(path, signal, timeoutMs) {
  const nonce = randomUUID(), started = Date.now();
  for (;;) {
    cancelled(signal);
    const releaseRecovery = await tryRecoveryLock(`${path}.recovery`);
    if (releaseRecovery) {
      let created = false;
      try {
        await mkdir(path, { mode: 0o700 });
        created = true;
        const ownerTemporary = join(path, `owner-${nonce}.tmp`);
        await writeFile(ownerTemporary, JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600, flag: 'wx' });
        await rename(ownerTemporary, join(path, 'owner.json'));
        return async () => {
          try { if ((await readJson(join(path, 'owner.json'))).nonce === nonce) await rm(path, { recursive: true }); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        };
      } catch (error) {
        if (created) { await rm(path, { recursive: true, force: true }); throw error; }
        if (error.code !== 'EEXIST') throw error;
        try {
          // Re-read the current generation only while holding the recovery mutex.
          const info = await lstat(path);
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('服务器部署缓存锁不是有效目录');
          let owner;
          try { owner = await readJson(join(path, 'owner.json')); }
          catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
          if (Number.isSafeInteger(owner?.pid) && owner.pid > 0
            ? !processAlive(owner.pid) : Date.now() - info.mtimeMs > 5000) await rm(path, { recursive: true });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      } finally { await releaseRecovery(); }
    }
    if (Date.now() - started >= timeoutMs) throw new Error('其他进程正在准备服务器部署资源，请稍后重试');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** Full offline assets win; an incomplete or corrupt offline payload never silently turns into a download. */
export async function ensureServerResources({ assetsRoot, cacheRoot, source = 'mirror', config, signal, onProgress, publicKey, fetcher = globalThis.fetch, lockTimeoutMs = 60 * 60_000 } = {}) {
  if (typeof assetsRoot !== 'string' || !assetsRoot || typeof cacheRoot !== 'string' || !cacheRoot) throw new Error('服务器部署资源路径未配置');
  cancelled(signal);
  let descriptor;
  try { descriptor = await readJson(join(assetsRoot, 'resources.json')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('部署资源缺失，请更新 BenchGo 后重试', { cause: error });
    throw error;
  }
  const expected = validateServerResourceDescriptor(descriptor);
  const existing = await Promise.all(SERVER_RESOURCE_FILES.map(name => present(join(assetsRoot, name))));
  if (expected.delivery === 'full' || existing.some(Boolean)) {
    if (!existing.every(Boolean)) throw new Error('完整离线部署资源不完整，请修复安装包；不会自动转为联网下载');
    report(onProgress, 'verifying-offline');
    return { directory: assetsRoot, manifest: await inspectResources(assetsRoot, expected, { local: true, signal }), origin: 'offline' };
  }
  const trustedKey = publicKey ?? await readSmallFile(join(assetsRoot, 'update-public-key.pem'), 4096);
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(cacheRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('服务器部署缓存路径无效');
  const identity = createHash('sha256').update(JSON.stringify([expected.releaseVersion, expected.pluginVersion, expected.harnessVersion, expected.harnessCommit])).digest('hex').slice(0, 24);
  const destination = join(cacheRoot, identity);
  if (await present(destination)) {
    report(onProgress, 'verifying-cache');
    try {
      const result = await cacheReceipt(destination, expected, trustedKey, signal);
      report(onProgress, 'ready', { origin: result.origin });
      return result;
    } catch (error) { cancelled(signal); }
  }
  const release = await acquireLock(join(cacheRoot, `${identity}.lock`), signal, lockTimeoutMs);
  const temporary = join(cacheRoot, `.prepare-${identity}-${randomUUID()}`);
  try {
    if (await present(destination)) {
      try { return await cacheReceipt(destination, expected, trustedKey, signal); }
      catch (error) {
        cancelled(signal);
        const info = await lstat(destination);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('服务器部署缓存路径无效，已阻止自动清理');
        report(onProgress, 'repairing-cache');
        await rm(destination, { recursive: true });
      }
    }
    await mkdir(temporary, { mode: 0o700 });
    report(onProgress, 'checking');
    const signed = await fetchVerifiedDownloadCatalog({ releaseVersion: expected.releaseVersion, config: config ?? { source }, publicKey: trustedKey, fetcher, signal });
    const artifact = selectServerArtifact(signed.catalog);
    const declaredPlugin = signed.catalog.files.find(file => file.target === 'plugin');
    if (!declaredPlugin || declaredPlugin.version !== expected.pluginVersion) throw new Error('匹配发行的功能包版本与当前部署要求不一致');
    const archive = join(temporary, 'distribution.tar.gz');
    await fetchReleaseArtifact(artifact, { file: archive, config: config ?? { source }, fetcher, signal, onProgress, maxBytes: 512 * 1024 * 1024 });
    report(onProgress, 'extracting');
    const unpacked = join(temporary, 'resources');
    const manifest = await safeExtract(archive, unpacked, artifact, expected, signal);
    await writeFile(join(unpacked, 'downloads.json'), signed.bytes, { mode: 0o600 });
    await writeFile(join(unpacked, 'downloads.json.sig'), signed.signatureBytes, { mode: 0o600 });
    await rename(archive, join(unpacked, 'distribution.tar.gz'));
    cancelled(signal);
    await rename(unpacked, destination);
    report(onProgress, 'ready', { origin: 'download' });
    return { directory: destination, manifest, origin: 'download' };
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await release();
  }
}

/** Explicit prefetch uses exactly the same validation and cache as an eventual SSH deployment. */
export const prefetchServerResources = ensureServerResources;
