import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertReleaseVersion, getInstallState, releaseBundleName } from '../../plugins/benchgo/shared/plugin-install.mjs';
import { writeArtifact } from '../../plugins/benchgo/scripts/write-artifact.mjs';

const directories = ['lib/preview', 'lib/link-web', 'assets/channel-brands', 'assets/fonts'];
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
  const plan = [];
  const visit = async (name, destination = target) => {
    const from = join(source, name), to = join(destination, name);
    const entry = await checked(source, from, true), existing = await checked(destination, to);
    if (existing && entry.isDirectory() !== existing.isDirectory()) throw new Error(`浏览器产物目标类型冲突：${to}`);
    if (entry.isDirectory()) for (const child of await readdir(from)) await visit(join(name, child), destination);
    else plan.push({ from, to, destination });
  };
  // Validate the complete plan before publishing anything. Do not remove old
  // files: an already-open preview may still request its previous assets.
  for (const name of [...directories, ...files, 'locale']) await visit(name);
  // The plugin manager names the enrolled wrapper, not its implementation package.
  await visit('locale', wrapper);
  await visit('lib/client.js');
  for (const { from, to, destination } of plan) {
    await checked(destination, to);
    await write(to, await readFile(from));
  }
  return { synced: true, target, profile, files: plan.length };
}
