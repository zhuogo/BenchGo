import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { HttpError } from '../shared/http.mjs';
import manifest from './skill-deck-manifest.json' with { type: 'json' };

const receiptName = '.benchgo-source.json';
const maxFileBytes = 256 * 1024;
const maxDownloadBytes = 2 * 1024 * 1024;
const gitHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const sourceUrl = path => `https://raw.githubusercontent.com/mattpocock/skills/${manifest.commit}/${path}`;
const publicRow = row => ({ name: row.name, description: row.description, category: row.category,
  dependencies: row.dependencies, modelInvocable: row.modelInvocable,
  url: `${manifest.repository}/tree/${manifest.commit}/${row.directory}` });

/** Only the reviewed, immutable manifest is accepted; there is no arbitrary URL/path input. */
export function skillInstallPlan(name, catalog = manifest) {
  const byName = new Map(catalog.skills.map(row => [row.name, row])), plan = [], seen = new Set();
  function visit(id) {
    if (seen.has(id)) return;
    const row = byName.get(id);
    if (!row) throw new HttpError('工程技能不存在，请刷新目录', 404);
    seen.add(id); row.dependencies.forEach(visit); plan.push(row);
  }
  visit(name); return plan;
}

async function exists(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Resolve existing ancestors too: a symlinked skills folder must not redirect installation. */
async function safeRoot(root, create = false) {
  const absolute = resolve(root);
  let cursor = absolute;
  while (true) {
    const stat = await exists(cursor);
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new HttpError('技能目录包含链接或不是文件夹，请检查安装位置', 409);
      const canonical = await realpath(cursor);
      if (resolve(canonical).toLowerCase() !== resolve(cursor).toLowerCase()) throw new HttpError('技能目录不能通过链接重定向', 409);
      break;
    }
    const parent = dirname(cursor); if (parent === cursor) throw new HttpError('无法解析技能安装目录', 409);
    cursor = parent;
  }
  if (create) await mkdir(absolute, { recursive: true, mode: 0o700 });
  return absolute;
}

async function downloadFile(path, expected, fetchImpl, signal) {
  let response;
  try { response = await fetchImpl(sourceUrl(path), { signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(20000)]), redirect: 'error' }); }
  catch (cause) { if (signal?.aborted) throw signal.reason; throw new HttpError(`无法下载技能文件 ${path}：${cause.message}`, 502); }
  if (!response.ok) throw new HttpError(`技能源下载失败（HTTP ${response.status}）：${path}`, 502);
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxFileBytes) throw new HttpError('技能文件超出大小限制', 502);
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > maxFileBytes || size > expected.size) { await reader.cancel(); throw new HttpError('技能文件大小与固定版本不一致', 502); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== expected.size || gitHash(bytes) !== expected.sha) throw new HttpError(`技能文件校验失败：${path}`, 502);
  return bytes;
}

export function createSkillDeck({ getCatalog, root = join(resolveDshHome(), 'skills'), fetchImpl = fetch, definition = manifest } = {}) {
  let installing = false;
  const byName = new Map(definition.skills.map(row => [row.name, row]));
  const catalog = signal => getCatalog({ action: 'list' }, signal);
  const receipt = async name => {
    const target = join(root, name);
    if ((await exists(target))?.isSymbolicLink()) return null;
    try {
      const data = JSON.parse(await readFile(join(target, receiptName), 'utf8'));
      return data.repository === definition.repository && data.commit === definition.commit && data.name === name ? data : null;
    } catch { return null; }
  };
  const base = { repository: definition.repository, version: definition.version, commit: definition.commit, license: 'MIT', destination: root };
  async function list(signal) {
    const current = await catalog(signal);
    const skills = await Promise.all(definition.skills.map(async row => {
      const effective = current.skills.find(skill => skill.name === row.name);
      const owned = await receipt(row.name), target = await exists(join(root, row.name));
      const effectiveOwned = !!owned && typeof effective?.path === 'string' && resolve(effective.path).toLowerCase() === resolve(root, row.name, 'SKILL.md').toLowerCase();
      const available = effectiveOwned && (effective.invocation?.modelInvocable === true || effective.invocation?.userInvocable === true);
      return { ...publicRow(row), installed: !!owned, available,
        status: owned ? available ? 'available' : 'installed' : effective || target ? 'conflict' : 'not-installed',
        provider: effective?.provider, path: effective?.path };
    }));
    return { ...base, available: current.available, skills };
  }
  async function get(name, signal) {
    const row = byName.get(name); if (!row) throw new HttpError('工程技能不存在，请刷新目录', 404);
    const file = row.files.find(file => file.path === 'SKILL.md');
    const [content, license] = await Promise.all([
      downloadFile(`${row.directory}/SKILL.md`, file, fetchImpl, signal),
      downloadFile('LICENSE', definition.license, fetchImpl, signal),
    ]);
    return { ...base, skill: { ...publicRow(row), content: content.toString('utf8'),
      files: row.files.map(file => file.path), plan: skillInstallPlan(name, definition).map(publicRow) }, licenseText: license.toString('utf8') };
  }
  async function install(name, signal) {
    if (installing) throw new HttpError('另一个技能正在安装，请稍后重试', 409);
    installing = true;
    const created = [], operation = randomUUID();
    try {
      const plan = skillInstallPlan(name, definition), current = await catalog(signal);
      if (!current.available) throw new HttpError('官方技能服务尚未启用，暂不能安装', 503);
      const rootPath = await safeRoot(root, true), pending = [];
      for (const row of plan) {
        if (await receipt(row.name)) continue;
        if (current.skills.some(skill => skill.name === row.name) || await exists(join(rootPath, row.name))) {
          throw new HttpError(`技能 ${row.name} 已有其他来源或本地文件；为保留现有内容，本次未安装`, 409);
        }
        pending.push(row);
      }
      if (!pending.length) return { ...base, installed: [], alreadyInstalled: true };
      const license = await downloadFile('LICENSE', definition.license, fetchImpl, signal);
      const payloads = []; let total = license.length;
      // Small bounded batches; every source file is hash-verified before publishing anything.
      for (const row of pending) {
        const files = [];
        for (let index = 0; index < row.files.length; index += 4) {
          const batch = await Promise.all(row.files.slice(index, index + 4).map(async file => {
            if (!/^[a-zA-Z0-9_.\-/]+$/.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..') || !['100644', '100755'].includes(file.mode)) throw new HttpError('技能清单包含不支持的文件', 502);
            return { ...file, bytes: await downloadFile(`${row.directory}/${file.path}`, file, fetchImpl, signal) };
          }));
          for (const file of batch) { total += file.bytes.length; if (total > maxDownloadBytes) throw new HttpError('技能安装内容超出大小限制', 502); files.push(file); }
        }
        payloads.push({ row, files });
      }
      signal?.throwIfAborted();
      await safeRoot(rootPath);
      for (const { row, files } of payloads) {
        const target = join(rootPath, row.name);
        try { await mkdir(target, { mode: 0o700 }); }
        catch (cause) { if (cause.code === 'EEXIST') throw new HttpError(`技能 ${row.name} 已被其他操作创建，本次未覆盖`, 409); throw cause; }
        const published = { target, files: [], directories: new Set([target]) }; created.push(published);
        const write = async (destination, bytes, mode) => {
          await writeFile(destination, bytes, { flag: 'wx', mode });
          published.files.push({ path: destination, hash: gitHash(Buffer.from(bytes)) });
        };
        await write(join(target, receiptName), JSON.stringify({ ...base, name: row.name, operation, installedAt: new Date().toISOString() }, null, 2), 0o600);
        await write(join(target, 'LICENSE'), license, 0o600);
        // Publish SKILL.md last so filesystem discovery never sees incomplete support files.
        for (const file of files.sort((a, b) => Number(a.path === 'SKILL.md') - Number(b.path === 'SKILL.md'))) {
          signal?.throwIfAborted();
          const destination = join(target, file.path), inside = relative(target, destination);
          if (inside.startsWith('..' + sep) || inside === '..') throw new HttpError('技能文件路径无效', 502);
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          for (let path = dirname(destination); path !== target; path = dirname(path)) published.directories.add(path);
          await write(destination, file.bytes, file.mode === '100755' ? 0o700 : 0o600);
        }
      }
      return { ...base, installed: pending.map(row => row.name), alreadyInstalled: false };
    } catch (error) {
      for (const published of created.reverse()) {
        // Remove only this operation's unchanged files; concurrent user edits/files survive.
        if (relative(resolve(root), published.target) !== published.target.split(sep).at(-1)) continue;
        for (const file of published.files.reverse()) {
          try { if (!(await lstat(file.path)).isSymbolicLink() && gitHash(await readFile(file.path)) === file.hash) await unlink(file.path); } catch {}
        }
        for (const directory of [...published.directories].sort((a, b) => b.length - a.length)) {
          try { await rmdir(directory); } catch {} // An occupied directory is retained, never recursively deleted.
        }
      }
      throw error;
    } finally { installing = false; }
  }
  return { list, get, install };
}
