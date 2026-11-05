import { cp, mkdir, readFile, readdir, stat, writeFile, realpath, lstat, rm, symlink } from 'node:fs/promises';
import { isAbsolute, join, dirname, relative, resolve, sep } from 'node:path';
import { releaseBundleName } from '../../plugins/benchgo/shared/plugin-install.mjs';
import { createRequire } from 'node:module';

async function findPackage(name, from) {
  for (let current = from; ; current = dirname(current)) {
    const candidate = join(current, 'node_modules', name);
    if (await stat(join(candidate, 'package.json')).catch(() => null)) return realpath(candidate);
    if (dirname(current) === current) throw new Error(`官方运行时缺少共享依赖：${name}`);
  }
}

const inside = (root, path) => {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};
const infoAt = path => lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });

async function checkedPath(root, path, allowLeafLink = false) {
  path = resolve(path);
  if (!inside(root, path)) throw new Error(`同步路径超出受管目录：${path}`);
  const parts = relative(root, path).split(sep).filter(Boolean);
  let current = root, info;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    info = await infoAt(current);
    if (!info) return null;
    if (info.isSymbolicLink() && !(allowLeafLink && index === parts.length - 1)) throw new Error(`同步路径包含符号链接：${current}`);
  }
  return info;
}

async function checkedTree(root, path) {
  const info = await checkedPath(root, path);
  if (info?.isDirectory()) for (const name of await readdir(path)) await checkedTree(root, join(path, name));
  else if (info && !info.isFile()) throw new Error(`同步路径类型无效：${path}`);
}

/** Mirror owned source/generated directories in a stopped, enrolled development release. */
export async function syncDevelopmentPlugin({ root, enrollment }) {
  try {
    if (enrollment?.managed !== true || typeof enrollment.directory !== 'string' || !isAbsolute(enrollment.directory)) {
      throw new Error('登记结果缺少受管插件目录');
    }
    const source = await realpath(join(root, 'plugins/benchgo'));
    const releaseRoot = await realpath(enrollment.directory);
    const target = join(releaseRoot, 'node_modules/benchgo-plugin');
    if (inside(source, target) || inside(target, source)) throw new Error('开发源码与受管安装目录不得重叠');
    await checkedPath(releaseRoot, target);
    for (const directory of [source, target]) {
      await checkedPath(directory, join(directory, 'package.json'));
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (manifest.name !== 'benchgo-plugin') throw new Error(`插件包名不匹配：${directory}`);
    }
    const artifacts = ['client.js', 'link.mjs', 'link-web', 'relay', 'modules'];
    const artifactDirectories = new Set(['link-web', 'relay', 'modules']);
    const sources = ['src', 'shared', 'locale'];
    for (const name of artifacts) {
      const info = await stat(join(source, 'lib', name));
      if (artifactDirectories.has(name) ? !info.isDirectory() : !info.isFile()) throw new Error(`开发产物类型无效：${name}`);
    }
    for (const name of sources) {
      if (!(await stat(join(source, name))).isDirectory()) throw new Error(`开发源码目录无效：${name}`);
    }
    if (!(await stat(join(source, 'cordis.patch.yml'))).isFile()) throw new Error('缺少 BenchGo 插件注册配置');
    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
    const localManifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    const sharedDependencies = Object.entries(localManifest.dependencies || {}).filter(([name]) => name.startsWith('@deepseek-ai/'));
    // Shared official packages must resolve to the enrolled engine's real module,
    // never to a copied plugin seed. Existing user dependencies are preserved.
    const planned = [];
    if (sharedDependencies.length) {
      const anchor = await findPackage('@deepseek-ai/dsh-llm', target);
      const semver = createRequire(join(anchor, 'package.json'))('semver');
      for (const [name, range] of sharedDependencies) {
        const packagePath = await findPackage(name, anchor);
        const metadata = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'));
        if (metadata.name !== name || !semver.satisfies(metadata.version, range, { includePrerelease: true })) throw new Error(`官方共享依赖版本不兼容：${name}@${metadata.version}，需要 ${range}`);
        const destination = join(target, 'node_modules', name);
        const existing = await lstat(destination).catch(() => null);
        if (existing && !existing.isSymbolicLink()) throw new Error(`共享依赖目标不是链接，不覆盖用户文件：${name}`);
        planned.push({ name, version: metadata.version, packagePath, destination, existing });
      }
      // New channel SDKs are not part of the engine seed. Link missing runtime
      // dependencies to their installed development tree (including transitives).
      for (const [name, range] of Object.entries(localManifest.dependencies || {}).filter(([name]) => !name.startsWith('@deepseek-ai/'))) {
        const installed = await findPackage(name, target).catch(() => null);
        if (installed) continue;
        const packagePath = await findPackage(name, source);
        const metadata = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'));
        if (metadata.name !== name || !semver.satisfies(metadata.version, range, { includePrerelease: true })) throw new Error(`开发运行依赖版本不兼容：${name}@${metadata.version}，需要 ${range}`);
        const destination = join(target, 'node_modules', name);
        const existing = await lstat(destination).catch(() => null);
        if (existing && !existing.isSymbolicLink()) throw new Error(`运行依赖目标不是链接，不覆盖用户文件：${name}`);
        planned.push({ name, version: metadata.version, packagePath, destination, existing });
      }
    }
    manifest.dependencies = { ...manifest.dependencies, ...localManifest.dependencies };
    manifest.exports = { ...manifest.exports, ...localManifest.exports };
    // The official client registry ignores subpath entries. Retire the broken
    // base aliases while preserving unrelated user exports.
    for (const key of ['./base-plugin', './base-plugin/locale/*.json', './base-plugin/icon']) delete manifest.exports[key];
    for (const key of ['main', 'bin', 'files']) if (Object.hasOwn(localManifest, key)) manifest[key] = localManifest[key];
    if (localManifest.dsh) manifest.dsh = { ...manifest.dsh, ...localManifest.dsh };
    const wrapper = join(releaseRoot, 'node_modules', releaseBundleName(manifest.version));
    await checkedPath(releaseRoot, wrapper);
    const wrapperManifest = JSON.parse(await readFile(join(wrapper, 'package.json'), 'utf8'));
    if (wrapperManifest.name !== releaseBundleName(manifest.version)) throw new Error('受管包装器包名不匹配');
    const icon = join(source, 'assets/icon.svg');
    if (!(await stat(icon)).isFile()) throw new Error('缺少 BenchGo 插件图标');

    // Validate the complete mutation plan before touching installed files. The
    // server seed is release-only; a development reload never rebuilds or removes it.
    const generated = (await readdir(join(source, 'lib'))).filter(name => name !== 'server');
    const previousGenerated = await readdir(join(target, 'lib')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const obsolete = ['agents', 'autoagent', 'voice'];
    await checkedPath(target, join(target, 'lib'));
    for (const name of [...sources, ...generated.map(name => join('lib', name))]) await checkedTree(source, join(source, name));
    for (const name of [...sources, ...previousGenerated.filter(name => name !== 'server').map(name => join('lib', name))]) await checkedTree(target, join(target, name));
    for (const name of obsolete) {
      const path = join(target, name), info = await checkedPath(target, path, true);
      if (!info?.isSymbolicLink()) await checkedTree(target, path);
    }
    for (const path of [icon, join(source, 'cordis.patch.yml')]) await checkedPath(source, path);
    for (const path of ['package.json', 'cordis.patch.yml', 'assets/icon.svg']) await checkedPath(target, join(target, path));
    for (const path of ['package.json', 'cordis.patch.yml', 'icon.svg']) await checkedPath(releaseRoot, join(wrapper, path));
    await checkedPath(releaseRoot, join(releaseRoot, 'release.json'));
    for (const { destination } of planned) await checkedPath(target, destination, true);

    for (const { packagePath, destination, existing } of planned) {
      if (existing) { const current = await realpath(destination).catch(() => ''); if (current === packagePath) continue; await rm(destination, { force: true }); }
      await mkdir(dirname(destination), { recursive: true });
      await symlink(packagePath, destination, 'junction');
    }
    for (const name of obsolete) {
      const path = join(target, name), info = await checkedPath(target, path, true);
      if (info) await rm(path, { recursive: !info.isSymbolicLink() && info.isDirectory(), force: true });
    }
    for (const name of previousGenerated.filter(name => name !== 'server')) await rm(join(target, 'lib', name), { recursive: true, force: true });
    for (const name of generated) await cp(join(source, 'lib', name), join(target, 'lib', name), { recursive: true, force: true });
    for (const name of sources) {
      await rm(join(target, name), { recursive: true, force: true });
      await cp(join(source, name), join(target, name), { recursive: true, force: true });
    }
    // The selected development wrapper must expose new module rows on reload;
    // user overrides belong to the profile patch, which is never changed here.
    await cp(join(source, 'cordis.patch.yml'), join(target, 'cordis.patch.yml'), { force: true });
    await cp(join(source, 'cordis.patch.yml'), join(wrapper, 'cordis.patch.yml'), { force: true });
    await mkdir(join(target, 'assets'), { recursive: true });
    await cp(icon, join(target, 'assets/icon.svg'), { force: true });
    await cp(icon, join(wrapper, 'icon.svg'), { force: true });
    wrapperManifest.exports = { ...wrapperManifest.exports, './icon': './icon.svg' };
    await writeFile(join(wrapper, 'package.json'), JSON.stringify(wrapperManifest, null, 2) + '\n');
    await writeFile(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    if (planned.length) {
      const releasePath = join(releaseRoot, 'release.json');
      const release = await readFile(releasePath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (release) {
        const shared = new Map((release.shared || []).map(item => [item.name, item]));
        for (const { name, version } of planned.filter(item => item.name.startsWith('@deepseek-ai/'))) shared.set(name, { name, version });
        release.shared = [...shared.values()];
        await writeFile(releasePath, JSON.stringify(release, null, 2) + '\n');
      }
    }
    return target;
  } catch (error) {
    throw new Error(`BenchGo 开发插件同步失败，未启动桌面：${error.message}`, { cause: error });
  }
}
