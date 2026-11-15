/** A finite Linux payload: published plugin files and production dependencies only. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stagePluginBundle } from '../desktop/plugin-bundle.mjs';
import { isLinuxX64Elf, packedPluginFiles, serverInputDigest, writeServerResourceDescriptor } from '../desktop/payload-policy.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const tar = createRequire(join(root, 'plugins/benchgo/package.json'))('tar');
export const linuxWorkerArchivePath = 'node_modules/benchgo-plugin/node_modules/dsh-ops/runtime/linux-x64/dsh-ops-worker';

/** Optional dependencies are not optional to an offline image when sharp uses them. */
export async function assertLinuxNativeClosure(plugin) {
  const require = createRequire(join(plugin, 'package.json'));
  for (const name of ['@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64']) {
    let metadata;
    try { metadata = require.resolve(`${name}/package`); }
    catch { throw new Error(`Linux offline dependencies omit required ${name}; install the locked Linux x64 glibc optional dependencies`); }
    const directory = dirname(metadata);
    // libvips patch filenames may change with the lock; validate the actual
    // package's sole runtime .so instead of guessing a future version.
    const files = await readdir(join(directory, 'lib'));
    const file = name.includes('libvips')
      ? files.filter(file => /^libvips-cpp\.so\.[0-9.]+$/.test(file))
      : files.filter(file => /^sharp-linux-x64(?:-[\w.+-]+)?\.node$/.test(file));
    if (file.length !== 1) throw new Error(`Linux offline dependency ${name} has no unambiguous runtime binding`);
    const path = join(directory, 'lib', file[0]);
    const info = await lstat(path), handle = await open(path, 'r'), bytes = Buffer.alloc(20);
    try { await handle.read(bytes, 0, bytes.length, 0); } finally { await handle.close(); }
    if (!info.isFile() || info.isSymbolicLink() || !isLinuxX64Elf(bytes)) throw new Error(`Linux offline dependency ${name} must be an ELF x86-64 regular file`);
  }
}

/** Prepare target dependencies away from the developer tree, with the committed lock and no scripts. */
export async function prepareLinuxDependencies({ plugin, clean, platform = process.platform, arch = process.arch, run } = {}) {
  if (platform === 'linux' && arch === 'x64') {
    try {
      await assertLinuxNativeClosure(plugin);
      await symlink(join(plugin, 'node_modules'), join(clean, 'node_modules'), 'dir');
      return { target: 'linux-x64-glibc', mode: 'native-source' };
    } catch (error) {
      if (error.code && error.code !== 'ENOENT') throw error;
      // A Linux source tree without glibc target bindings needs the same
      // isolated, locked preparation as a Windows/macOS build host.
    }
  }
  await cp(join(plugin, 'package-lock.json'), join(clean, 'package-lock.json'));
  const args = ['ci', '--os=linux', '--cpu=x64', '--libc=glibc', '--ignore-scripts', '--omit=dev', '--include=optional', '--legacy-peer-deps', '--no-audit', '--no-fund'];
  if (run) await run(args, clean);
  else await new Promise((resolveInstall, reject) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npm, args, { cwd: clean, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' } });
    let detail = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { detail = (detail + chunk.toString()).slice(-12000); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveInstall() : reject(new Error(`Target Linux dependencies failed (${code}); existing seed preserved.\n${detail}`)));
  });
  return { target: 'linux-x64-glibc', mode: 'locked-cross-platform' };
}

/** Same-volume promotion preserves the previous complete set on rename failure. */
export async function promoteServerResources({ prepared, output, backup, move = rename }) {
  let previous = false;
  try { await move(output, backup); previous = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await move(prepared, output); }
  catch (error) {
    if (previous) await move(backup, output);
    throw error;
  }
}

/** NTFS has no Unix execute bits. Set only the verified Linux worker's archive metadata. */
export async function writeServerSeedArchive({ seed, payload }) {
  const release = JSON.parse(await readFile(join(seed, 'release.json'), 'utf8'));
  if (release.platform !== 'linux' || release.arch !== 'x64') throw new Error('Linux server seed must declare platform linux and arch x64');
  const worker = join(seed, linuxWorkerArchivePath);
  const details = await lstat(worker);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('Linux server worker must be a regular file');
  const handle = await open(worker, 'r');
  const header = Buffer.alloc(20);
  let bytesRead;
  try { ({ bytesRead } = await handle.read(header, 0, header.length, 0)); } finally { await handle.close(); }
  if (bytesRead !== 20 || !isLinuxX64Elf(header))
    throw new Error('Linux server worker must be an ELF x86-64 executable');
  // Keep actual Linux bindings (for example sharp); a .node suffix alone is
  // not evidence of unused content. Cross-host build-machine binaries fail.
  const checkNative = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await checkNative(path); continue; }
      if (/\.(?:dll|exe|dylib)$/i.test(entry.name)) throw new Error(`Non-Linux-x64 native payload: ${path}`);
      if (!/\.node$|\.so(?:\.[0-9]+)*$/i.test(entry.name)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Linux native payload must be a regular file');
      const handle = await open(path, 'r'), bytes = Buffer.alloc(20);
      try { await handle.read(bytes, 0, bytes.length, 0); } finally { await handle.close(); }
      if (!isLinuxX64Elf(bytes)) throw new Error(`Linux native payload must be ELF x86-64: ${path}`);
    }
  };
  await checkNative(seed);
  await tar.c({ file: payload, cwd: seed, gzip: true, portable: true, noMtime: true,
    filter: path => !path.includes('/lib/server/'),
    onWriteEntry(entry) { if (entry.path === linuxWorkerArchivePath) entry.stat.mode = (entry.stat.mode & ~0o7777) | 0o755; },
  }, ['release.json', 'node_modules']);
}

export async function packageServerSeed({ output = join(root, 'plugins/link/dist/server') } = {}) {
  const plugin = join(root, 'plugins/benchgo');
  const metadata = JSON.parse(await readFile(join(plugin, 'package.json')));
  const upstream = JSON.parse(await readFile(join(root, 'upstream.json')));
  const files = packedPluginFiles(plugin);
  const sourceDigest = serverInputDigest({ plugin, files, root });
  output = resolve(output);
  await mkdir(dirname(output), { recursive: true });
  const temporary = await mkdtemp(join(dirname(output), '.benchgo-server-seed-'));
  try {
    const clean = join(temporary, 'plugin');
    for (const path of files) {
      if (path.startsWith('lib/server/') || path.includes('..') || path.startsWith('/')) continue;
      await mkdir(dirname(join(clean, path)), { recursive: true });
      await cp(join(plugin, path), join(clean, path));
    }
    const targetDependencies = await prepareLinuxDependencies({ plugin, clean });
    const seed = join(temporary, 'seed');
    const staged = stagePluginBundle({ plugin: clean, output: seed, platform: 'linux', arch: 'x64', includeServerResources: false });
    await assertLinuxNativeClosure(staged.destination);
    const prepared = join(temporary, 'resources');
    await mkdir(prepared);
    const payload = join(prepared, 'server-seed.tar.gz');
    await writeServerSeedArchive({ seed, payload });
    const sha256 = createHash('sha256').update(await readFile(payload)).digest('hex');
    const manifest = { schemaVersion: 1, harnessVersion: upstream.version, harnessCommit: upstream.commit, pluginVersion: metadata.version, bundle: staged.bundle, sha256, sourceDigest, targetDependencies };
    await writeFile(join(prepared, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const descriptor = writeServerResourceDescriptor({ output: prepared, plugin, files, root });
    if (descriptor.sourceDigest !== sourceDigest || serverInputDigest({ plugin, root }) !== sourceDigest)
      throw new Error('Server seed source changed during the build; existing seed preserved; rebuild from stable inputs');
    for (const file of ['bootstrap.sh', 'bootstrap.mjs']) await cp(new URL(file, import.meta.url), join(prepared, file));
    // Keep the rollback directory outside temporary: even an unexpected
    // rollback failure must not let finally cleanup destroy the previous set.
    const backup = `${temporary}-previous`;
    await promoteServerResources({ prepared, output, backup });
    await rm(backup, { recursive: true, force: true });
    return { output: resolve(output), ...manifest };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  process.stdout.write(JSON.stringify(await packageServerSeed({ output: values.out })) + '\n');
}
