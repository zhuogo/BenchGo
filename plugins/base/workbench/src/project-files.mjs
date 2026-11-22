import { constants } from 'node:fs';
import { copyFile, cp, link, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertSameOrigin, HttpError, readJson } from '../../shared/http.mjs';

const route = '/api/benchgo/workbench/files';
const mutationActions = new Set(['new-file', 'new-folder', 'rename', 'delete', 'move', 'copy']);
const windows = process.platform === 'win32';
const validText = value => typeof value === 'string' && value.length > 0 && value.length <= 32768 && !/[\x00-\x1f\x7f]/.test(value);
const samePath = (left, right) => relative(left, right) === '';
const inside = (root, path) => {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child);
};

function validName(name) {
  return validText(name) && name !== '.' && name !== '..' && !name.includes('/')
    && (!windows || (!/[\\:<>"|?*]/.test(name) && !/[. ]$/.test(name)
      && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)));
}

async function entryAt(root, directory, path, { allowRoot = false } = {}) {
  if (!validText(path)) throw new HttpError('文件路径无效');
  const requested = resolve(directory, path);
  if (!inside(directory, requested)) throw new HttpError('目标不在当前项目内', 403);
  if (samePath(directory, requested)) {
    if (!allowRoot) throw new HttpError('请选择项目中的文件或文件夹');
    return { path: root, info: await lstat(root) };
  }
  // Work from the canonical root and refuse links anywhere below it.
  let current = root;
  let info;
  for (const name of relative(directory, requested).split(sep)) {
    if (!validName(name)) throw new HttpError('文件路径无效');
    current = join(current, name);
    info = await lstat(current);
    if (info.isSymbolicLink() || !samePath(current, await realpath(current)) || (!info.isFile() && !info.isDirectory())) {
      throw new HttpError('此操作仅支持项目内的普通文件和文件夹', 409);
    }
  }
  return { path: current, info };
}

async function directoryAt(root, directory, path) {
  const entry = await entryAt(root, directory, path, { allowRoot: true });
  if (!entry.info.isDirectory()) throw new HttpError('请选择目标文件夹');
  return entry.path;
}

async function moveEntry(source, destination, directory) {
  if (!directory) {
    // link publishes a regular file exclusively, including when another writer wins the name.
    await link(source, destination);
    try { await unlink(source); }
    catch { throw new HttpError('目标文件已建立，但原文件未能移除', 409); }
    return;
  }
  // Windows refuses to replace an existing directory. POSIX requires an exclusive reservation.
  if (windows) {
    try { await rename(source, destination); }
    catch (error) {
      if (await lstat(destination).catch(() => undefined)) throw new HttpError('目标已存在同名项目，原件已保留', 409);
      throw error;
    }
    return;
  }
  await mkdir(destination);
  try { await rename(source, destination); }
  catch (error) {
    await rmdir(destination).catch(() => {});
    throw error;
  }
}

async function copyEntry(source, destination, directory, signal) {
  if (!directory) {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    return;
  }
  const temporary = await mkdtemp(join(dirname(destination), '.benchgo-copy-'));
  const staging = join(temporary, 'content');
  try {
    await cp(source, staging, {
      recursive: true, force: false, errorOnExist: true,
      async filter(path) {
        signal.throwIfAborted();
        const info = await lstat(path);
        if (!info.isDirectory() && !info.isFile()) throw new HttpError('文件夹包含链接或特殊文件，无法复制', 409);
        return true;
      },
    });
    signal.throwIfAborted();
    await moveEntry(staging, destination, true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function listFolders(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.benchgo-copy-'))
    .map(entry => entry.name).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

async function perform(ctx, input, signal) {
  const { action, sessionId, path, name, destination, workspace } = input;
  if (!validText(sessionId) || sessionId.length > 512 || !validText(workspace) || !isAbsolute(workspace)) {
    throw new HttpError('请选择项目对话');
  }
  const scope = await ctx.workspaceFiles.scopeOf(sessionId, signal);
  if (!scope) throw new HttpError('项目对话不可用', 404);
  const directory = resolve(scope.workspaceRoot);
  if (ctx.fs.processPathFromHostPath(directory) !== directory) throw new HttpError('此文件系统暂不支持项目文件操作', 409);
  if (!samePath(directory, workspace)) throw new HttpError('工作目录已切换，请重新打开文件菜单', 409);
  const root = await realpath(directory);
  if (!(await lstat(root)).isDirectory()) throw new HttpError('项目工作目录不可用', 404);
  const displayed = path => resolve(directory, relative(root, path));
  signal.throwIfAborted();

  if (action === 'target') return { device: hostname() };
  if (action === 'folders') {
    const folder = await directoryAt(root, directory, path);
    return { folders: await listFolders(folder) };
  }
  if (action === 'new-file' || action === 'new-folder') {
    if (!validName(name)) throw new HttpError('名称无效');
    const folder = await directoryAt(root, directory, path);
    const target = join(folder, name);
    signal.throwIfAborted();
    if (action === 'new-folder') await mkdir(target);
    else await writeFile(target, '', { flag: 'wx' });
    return { path: displayed(target) };
  }

  const source = await entryAt(root, directory, path);
  const isDirectory = source.info.isDirectory();
  signal.throwIfAborted();
  if (action === 'delete') {
    if (isDirectory) await rm(source.path, { recursive: true });
    else await unlink(source.path);
    return {};
  }

  if (action === 'rename' && !validName(name)) throw new HttpError('名称无效');
  const folder = action === 'rename' ? dirname(source.path) : await directoryAt(root, directory, destination);
  const target = join(folder, action === 'rename' ? name : basename(source.path));
  if (samePath(source.path, target)) {
    if (action === 'rename' && source.path !== target) {
      await rename(source.path, target);
      return { path: displayed(target) };
    }
    if (action === 'copy') throw new HttpError('该文件夹已包含同名项目', 409);
    return { path: displayed(source.path) };
  }
  if (isDirectory && inside(source.path, target)) throw new HttpError('请选择此文件夹之外的目标位置', 409);
  signal.throwIfAborted();
  if (action === 'copy') await copyEntry(source.path, target, isDirectory, signal);
  else await moveEntry(source.path, target, isDirectory);
  return { path: displayed(target) };
}

const diskErrors = {
  EEXIST: [409, '目标已存在同名项目，原件已保留'],
  ENOTEMPTY: [409, '目标已存在同名文件夹，原件已保留'],
  ENOENT: [404, '文件或文件夹已变化，请刷新后重试'],
  ENOTDIR: [409, '路径中的文件夹已变化，请刷新后重试'],
  EACCES: [403, '系统拒绝了文件操作'],
  EPERM: [403, '系统拒绝了文件操作，文件可能正在使用'],
  EXDEV: [409, '源与目标位于不同文件系统，无法直接移动'],
  ENOSPC: [507, '目标设备的磁盘空间不足'],
};

export function mountProjectFiles(ctx) {
  let pending = Promise.resolve();
  ctx.effect(() => ctx.connection.fetch.register({
    path: route,
    methods: ['POST'],
    requestBody: 'streaming',
    async fetch(request) {
      const headers = { 'cache-control': 'no-store' };
      try {
        assertSameOrigin(request, { allowDesktopOrigin: true });
        const input = await readJson(request, 384 * 1024);
        const run = () => perform(ctx, input, request.signal);
        if (input.action === 'folders' || input.action === 'target') return Response.json(await run(), { headers });
        if (!mutationActions.has(input.action)) throw new HttpError('不支持的文件操作');
        const result = pending.then(run);
        pending = result.catch(() => {});
        return Response.json(await result, { headers });
      } catch (error) {
        const [status, message] = error instanceof HttpError ? [error.status, error.message]
          : Object.hasOwn(diskErrors, error?.code) ? diskErrors[error.code] : [500, '文件操作未完成，请刷新目录后核对结果'];
        return Response.json({ error: message }, { status, headers });
      }
    },
  }));
}
