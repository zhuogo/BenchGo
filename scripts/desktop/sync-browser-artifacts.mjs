import { lstat, readFile, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertReleaseVersion, getInstallState, releaseBundleName } from '../../plugins/benchgo/shared/plugin-install.mjs';
import { writeArtifact } from '../../plugins/benchgo/scripts/write-artifact.mjs';

const directories = ['lib/preview', 'lib/link-web', 'assets/channel-brands', 'assets/fonts'];
const runtimeDirectories = ['shared', 'lib/modules', 'src'];
const runtimeFiles = ['lib/link.mjs'];
const files = ['lib/UI-LICENSES.txt', 'lib/LINK-THIRD-PARTY-LICENSES.txt', 'assets/icon.svg'];
const inside = (root, path) => { const child = relative(root, path); return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child); };
const info = path => lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const json = async path => JSON.parse(await readFile(path, 'utf8'));

export const desktopProfile = (environment = process.env) => join(environment.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'desktop');

/** Reject links in owned trees, including existing destination ancestors and leaves. */
async function checked(root, path, required = false) {
  if (!inside(root, path)) throw new Error(`浏览器产物路径越界：${path}`);
  let current = root, entry;
  for (const name of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, name);
    entry = await info(current);
    if (!entry) { if (required) throw new Error(`浏览器产物缺失：${current}`); return null; }
    if (entry.isSymbolicLink()) throw new Error(`浏览器产物路径不允许符号链接：${current}`);
    if (!entry.isDirectory() && !entry.isFile()) throw new Error(`浏览器产物类型无效：${current}`);
    if (current !== path && !entry.isDirectory()) throw new Error(`浏览器产物父路径不是目录：${current}`);
  }
  return entry;
}

/** Publish browser resources and plugin display locales into the managed Desktop release. */
export async function syncDesktopBrowserArtifacts({ root, profile = desktopProfile(), write = writeArtifact }) {
  return syncDesktopArtifacts({ root, profile, write, runtime: false });
}

/** Publish runtime sources alongside browser artifacts; package/dependency changes still require dev enrollment. */
export async function syncDesktopArtifacts({ root, profile = desktopProfile(), write = writeArtifact, runtime = true }) {
  profile = resolve(profile);
  const state = await getInstallState(profile);
  if (!state.managed || !state.enabled) return { synced: false, reason: state.managed ? 'disabled' : 'unmanaged', profile };
  profile = await realpath(profile);
  assertReleaseVersion(state.version);
  const releaseRoot = join(profile, '.benchgo', 'releases');
  const directory = join(releaseRoot, state.version);
  if (typeof state.root !== 'string' || typeof state.directory !== 'string' || resolve(state.root) !== releaseRoot || resolve(state.directory) !== directory || state.bundleName !== releaseBundleName(state.version))
    throw new Error('桌面插件受管安装路径不一致，未同步');
  await checked(profile, directory, true);
  const target = join(directory, 'node_modules', 'benchgo-plugin');
  const wrapper = join(directory, 'node_modules', state.bundleName);
  await checked(profile, join(target, 'package.json'), true);
  await checked(profile, join(wrapper, 'package.json'), true);
  const plugin = await json(join(target, 'package.json')), bundle = await json(join(wrapper, 'package.json'));
  if (plugin.name !== 'benchgo-plugin' || plugin.version !== state.version || bundle.name !== state.bundleName || bundle.version !== state.version || bundle.dependencies?.['benchgo-plugin'] !== state.version)
    throw new Error('桌面插件包身份不一致，未同步');
  // The official profile activation pointer may be a junction; it must resolve
  // to this exact validated wrapper, never a different release or checkout.
  if (await realpath(join(profile, 'node_modules', state.bundleName)) !== await realpath(wrapper)) throw new Error('桌面插件活动指向与受管安装不一致，未同步');
  const source = await realpath(join(root, 'plugins', 'benchgo'));
  if (source === target || inside(source, target) || inside(target, source)) throw new Error('源码与桌面插件目录重叠，未同步');
  if ((await json(join(source, 'package.json'))).name !== 'benchgo-plugin') throw new Error('源码插件包名无效，未同步');
  const plan = [], published = new Set(), obsolete = [];
  const visit = async (name, destination = target) => {
    const from = join(source, name), to = join(destination, name);
    const entry = await checked(source, from, true), existing = await checked(destination, to);
    if (existing && entry.isDirectory() !== existing.isDirectory()) throw new Error(`浏览器产物目标类型冲突：${to}`);
    published.add(to);
    if (entry.isDirectory()) for (const child of await readdir(from)) await visit(join(name, child), destination);
    else plan.push({ from, to, destination });
  };
  const patch = join(profile, 'cordis.patch.yml');
  // Official HMR compares the exact patch text and reconciles installed modules.
  // A trailing blank line requests that lifecycle without changing YAML settings.
  const patchEntry = runtime ? await checked(profile, patch) : null;
  if (patchEntry && !patchEntry.isFile()) throw new Error('Desktop profile patch must be a regular file');
  // Validate the complete publication and cleanup before changing anything.
  // Browser assets remain available to pages that loaded an earlier client.
  for (const name of [...(runtime ? [...runtimeDirectories, ...runtimeFiles] : []), ...directories, ...files, 'locale']) await visit(name);
  // The plugin manager names the enrolled wrapper, not its implementation package.
  await visit('locale', wrapper);
  await visit('lib/client.js');
  const inspectRuntime = async name => {
    const path = join(target, name), entry = await checked(profile, path);
    if (!entry) return;
    if (entry.isDirectory()) for (const child of await readdir(path)) await inspectRuntime(join(name, child));
    if (!published.has(path)) obsolete.push({ path, directory: entry.isDirectory() });
  };
  if (runtime) for (const name of runtimeDirectories) await inspectRuntime(name);
  for (const { from, to, destination } of plan) {
    await checked(destination, to);
    await write(to, await readFile(from));
  }
  for (const item of obsolete) {
    if (!runtimeDirectories.some(name => {
      const tree = join(target, name);
      return item.path !== tree && inside(tree, item.path);
    })) throw new Error(`运行时代码清理路径越界：${item.path}`);
    const entry = await checked(profile, item.path, true);
    if (entry.isDirectory() !== item.directory) throw new Error(`运行时代码清理目标类型已变化：${item.path}`);
    // Delete validated leaves only; never recurse through a swapped directory.
    if (item.directory) await rmdir(item.path);
    else await unlink(item.path);
  }
  if (patchEntry) {
    await checked(profile, patch, true);
    await write(patch, Buffer.concat([await readFile(patch), Buffer.from('\n')]));
  }
  return { synced: true, target, profile, files: plan.length, removed: obsolete.length, runtime, reloadRequested: !!patchEntry };
}
