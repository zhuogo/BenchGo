/** A finite Linux payload: published plugin files and production dependencies only. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, lstat, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stagePluginBundle } from '../desktop/plugin-bundle.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const tar = createRequire(join(root, 'plugins/benchgo/package.json'))('tar');
export const linuxWorkerArchivePath = 'node_modules/benchgo-plugin/node_modules/dsh-ops/runtime/linux-x64/dsh-ops-worker';

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
  if (bytesRead !== 20 || header.subarray(0, 4).toString('hex') !== '7f454c46' || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62)
    throw new Error('Linux server worker must be an ELF x86-64 executable');
  await tar.c({ file: payload, cwd: seed, gzip: true, portable: true, noMtime: true,
    filter: path => !path.includes('/lib/server/') && !path.endsWith('.node'),
    onWriteEntry(entry) { if (entry.path === linuxWorkerArchivePath) entry.stat.mode = (entry.stat.mode & ~0o7777) | 0o755; },
  }, ['release.json', 'node_modules']);
}

export async function packageServerSeed({ output = join(root, 'plugins/link/dist/server') } = {}) {
  const plugin = join(root, 'plugins/benchgo');
  const metadata = JSON.parse(await readFile(join(plugin, 'package.json')));
  const upstream = JSON.parse(await readFile(join(root, 'upstream.json')));
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-server-seed-'));
  try {
    const clean = join(temporary, 'plugin');
    const packed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: plugin, encoding: 'utf8', shell: process.platform === 'win32' });
    if (packed.status !== 0) throw new Error('无法读取 BenchGo 插件打包清单');
    for (const { path } of JSON.parse(packed.stdout)[0].files) {
      if (path.startsWith('lib/server/') || path.includes('..') || path.startsWith('/')) continue;
      await mkdir(dirname(join(clean, path)), { recursive: true });
      await cp(join(plugin, path), join(clean, path));
    }
    await symlink(join(plugin, 'node_modules'), join(clean, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const seed = join(temporary, 'seed');
    const staged = stagePluginBundle({ plugin: clean, output: seed, platform: 'linux', arch: 'x64' });
    await rm(join(seed, 'node_modules/benchgo-plugin/node_modules/@anthropic-ai'), { recursive: true, force: true });
    // The optional native SDK is installed separately when needed.
    await mkdir(output, { recursive: true });
    const payload = join(output, 'server-seed.tar.gz');
    await writeServerSeedArchive({ seed, payload });
    const sha256 = createHash('sha256').update(await readFile(payload)).digest('hex');
    const manifest = { schemaVersion: 1, harnessVersion: upstream.version, harnessCommit: upstream.commit, pluginVersion: metadata.version, bundle: staged.bundle, sha256 };
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    for (const file of ['bootstrap.sh', 'bootstrap.mjs']) await cp(new URL(file, import.meta.url), join(output, file));
    return { output: resolve(output), ...manifest };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  process.stdout.write(JSON.stringify(await packageServerSeed({ output: values.out })) + '\n');
}
