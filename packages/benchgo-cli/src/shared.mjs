/** Publish the same shared contracts as Desktop; generated resources contain no second implementation. */
import { access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

let directory;
for (const candidate of [fileURLToPath(new URL('../../../plugins/benchgo/shared/', import.meta.url)), fileURLToPath(new URL('../resources/shared/', import.meta.url))]) {
  try { await access(join(candidate, 'workbench-installation.mjs')); directory = candidate; break; } catch {}
}
if (!directory) throw new Error('BenchGo CLI 缺少共享安装资源，请重新安装命令包');
export const sharedDirectory = directory;
export const shared = name => import(pathToFileURL(join(directory, name)).href);
