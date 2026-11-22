import { lstat, mkdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HttpError } from '../shared/http.mjs';

const windows = process.platform === 'win32';
const samePath = (left, right) => relative(left, right) === '';
const contains = (folder, path) => {
  const child = relative(folder, path);
  return child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child);
};
const invalidText = value => typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value);

function folderPath(path) {
  if (invalidText(path) || path.length > 4096 || !isAbsolute(path)) throw new HttpError('文件夹路径无效');
  return resolve(path);
}

function folderName(name) {
  if (invalidText(name) || name.length > 255 || name.startsWith('.') || name.includes('/')
    || windows && (/[\\:<>"|?*]/.test(name) || /[. ]$/.test(name)
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i.test(name))) {
    throw new HttpError('请输入有效的文件夹名称，且名称不能以点开头');
  }
  return name;
}

async function ordinaryFolder(path) {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || !samePath(await realpath(path), path)) {
    throw new HttpError('此操作仅支持普通文件夹', 409);
  }
  return entry;
}

async function relocate(source, target) {
  // Windows refuses to replace directories. POSIX rename can replace an empty directory.
  if (windows) {
    await rename(source, target);
    return;
  }
  await mkdir(target);
  try { await rename(source, target); }
  catch (error) {
    await rmdir(target).catch(() => {});
    throw error;
  }
}

const diskErrors = {
  EEXIST: [409, '目标位置已存在同名项目'],
  ENOTEMPTY: [409, '目标位置已存在同名项目'],
  ENOENT: [404, '文件夹已变化，请刷新目录后重试'],
  ENOTDIR: [409, '文件夹已变化，请刷新目录后重试'],
  EACCES: [403, '系统拒绝了文件夹操作'],
  EPERM: [403, '系统拒绝了文件夹操作，或目标位置已存在同名项目'],
  EBUSY: [409, '文件夹正在使用'],
  EXDEV: [409, '源和目标位于不同的文件系统'],
  ENOSPC: [507, '目标设备的磁盘空间不足'],
};

export async function manageProjectFolder(ctx, { operation, directory, path, name, destination }, cloneDestination) {
  try {
    const current = folderPath(directory);
    await ordinaryFolder(current);
    if (operation === 'create') {
      const target = join(current, folderName(name));
      await mkdir(target);
      return { path: target };
    }
    if (!['rename', 'move', 'delete'].includes(operation)) throw new HttpError('不支持的文件夹操作');
    const source = folderPath(path);
    if (samePath(source, current) || !samePath(dirname(source), current)) throw new HttpError('请选择当前列表中的文件夹');
    const original = await ordinaryFolder(source);
    if (cloneDestination && contains(source, cloneDestination)) throw new HttpError('此文件夹包含正在克隆的项目', 409);
    for (const project of ctx.workspaceRegistry.list()) {
      const registered = await realpath(project.path).catch(() => project.path);
      if (contains(source, registered)) throw new HttpError('此文件夹包含已添加的项目，请先从 BenchGo 移除项目', 409);
    }
    if (operation === 'delete') {
      await rm(source, { recursive: true });
      return {};
    }
    let target;
    if (operation === 'rename') {
      target = join(current, folderName(name));
      if (source === target) return { path: source };
      if (samePath(source, target)) {
        const existing = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (existing) {
          if (original.ino !== existing.ino || original.dev !== existing.dev) throw new HttpError('目标位置已存在同名项目', 409);
          await rename(source, target);
          return { path: target };
        }
      }
    } else {
      const folder = folderPath(destination);
      if (samePath(folder, source) || samePath(folder, current)
        || !samePath(folder, dirname(current)) && !samePath(dirname(folder), current)) {
        throw new HttpError('请选择同级文件夹或上一级');
      }
      await ordinaryFolder(folder);
      target = join(folder, basename(source));
    }
    await relocate(source, target);
    return { path: target };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const [status, message] = Object.hasOwn(diskErrors, error?.code)
      ? diskErrors[error.code] : [500, '文件夹操作未完成，请刷新目录核对结果'];
    throw new HttpError(message, status);
  }
}
