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
    const releasePath = join(releaseRoot, 'release.json');
    await checkedPath(releaseRoot, releasePath);
    const release = await readFile(releasePath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const owned = new Set(release?.developmentDependencies || []);
    const planned = [], copies = [], copyJobs = [];
    let anchor, semver;
    const shared = new Map();
    const assertVersion = async (metadata, name, range) => {
      anchor ??= await findPackage('@deepseek-ai/dsh-llm', target);
      semver ??= createRequire(join(anchor, 'package.json'))('semver');
      if (metadata.name !== name || !semver.satisfies(metadata.version, range, { includePrerelease: true })) throw new Error(`运行依赖版本不兼容：${name}@${metadata.version}，需要 ${range}`);
    };
    async function official(name, range, preservedFrom) {
      anchor ??= await findPackage('@deepseek-ai/dsh-llm', target);
      const packagePath = await findPackage(name, anchor);
      const metadata = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'));
      await assertVersion(metadata, name, range);
      if (preservedFrom && await findPackage(name, preservedFrom) !== packagePath) throw new Error(`用户依赖的官方服务身份与宿主不一致：${name}，位置 ${preservedFrom}`);
      if (shared.has(name)) return;
      const destination = join(target, 'node_modules', name);
      const existing = await checkedPath(target, destination, true);
      if (existing && !existing.isSymbolicLink()) throw new Error(`共享依赖目标不是链接，不覆盖用户文件：${name}`);
      const item = { name, version: metadata.version, packagePath, destination, existing };
      shared.set(name, item); planned.push(item);
    }
    // Match release staging: copy third-party closures without their private
    // node_modules; official services always resolve from the enrolled host.
    async function dependencies(packagePath, destination, ancestors = new Set(), top = false, preserve = false) {
      const metadata = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'));
      const optional = metadata.optionalDependencies || {};
      for (const [name, range] of Object.entries({ ...metadata.dependencies, ...optional })) {
        if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name) || name.split('/').some(part => part === '.' || part === '..')) throw new Error(`无效依赖名称：${name}`);
        if (metadata.name === 'ssh2' && name === 'cpu-features') continue;
        if (name.startsWith('@deepseek-ai/')) { await official(name, range, preserve ? packagePath : undefined); continue; }
        let dependency;
        try { dependency = await findPackage(name, packagePath); }
        catch (error) { if (Object.hasOwn(optional, name)) continue; throw error; }
        const info = JSON.parse(await readFile(join(dependency, 'package.json'), 'utf8'));
        await assertVersion(info, name, range);
        const supports = (values, value) => !values || (!values.includes(`!${value}`) && (values.every(item => item.startsWith('!')) || values.includes(value)));
        if (!supports(info.os, process.platform) || !supports(info.cpu, process.arch)) {
          if (Object.hasOwn(optional, name)) continue;
          throw new Error(`运行依赖平台不兼容：${name}`);
        }
        if (ancestors.has(dependency)) continue;
        const output = join(destination, 'node_modules', name);
        if (preserve) {
          await dependencies(dependency, output, new Set([...ancestors, dependency]), false, true);
          continue;
        }
        if (top) {
          const existing = await checkedPath(target, output, true);
          if (existing && !existing.isSymbolicLink() && !owned.has(name)) {
            const installed = JSON.parse(await readFile(join(output, 'package.json'), 'utf8'));
            await assertVersion(installed, name, range);
            await dependencies(output, output, new Set([await realpath(output)]), false, true);
            continue; // Preserve ordinary user-installed dependencies.
          }
          if (existing && !existing.isSymbolicLink()) await checkedTree(target, output);
          copies.push({ name, packagePath: dependency, destination: output, existing });
        }
        copyJobs.push({ packagePath: dependency, destination: output, name });
        await dependencies(dependency, output, new Set([...ancestors, dependency]));
      }
      for (const [name, range] of Object.entries(metadata.peerDependencies || {})) {
        if (name.startsWith('@deepseek-ai/') && !metadata.peerDependenciesMeta?.[name]?.optional) await official(name, range, preserve ? packagePath : undefined);
      }
    }
    await dependencies(source, target, new Set([source]), true);
    if (copies.length && !release) throw new Error('缺少受管 release.json，无法记录第三方依赖所有权');
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
    for (const { destination } of [...planned, ...copies]) await checkedPath(target, destination, true);

    for (const { destination, existing } of copies) {
      if (existing) await rm(destination, { recursive: !existing.isSymbolicLink(), force: true });
    }
    for (const { packagePath, destination, name } of copyJobs) {
      await mkdir(dirname(destination), { recursive: true });
      await cp(packagePath, destination, { recursive: true, dereference: true, filter: path => {
        const child = relative(packagePath, path);
        return !child.split(/[\\/]/u).includes('node_modules') && !(name === 'ssh2' && child.startsWith(join('lib', 'protocol', 'crypto', 'build')));
      } });
    }

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
    if (release) {
      const services = new Map((release.shared || []).map(item => [item.name, item]));
      for (const { name, version } of planned) services.set(name, { name, version });
      release.shared = [...services.values()];
      release.developmentDependencies = [...new Set([...owned, ...copies.map(item => item.name)])];
      await writeFile(releasePath, JSON.stringify(release, null, 2) + '\n');
    }
    return target;
  } catch (error) {
    throw new Error(`BenchGo 开发插件同步失败，未启动桌面：${error.message}`, { cause: error });
  }
}
