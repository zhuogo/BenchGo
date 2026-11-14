import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleLinuxServer, verifyLinuxSeed, linuxVerification } from './package-linux.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const tar = createRequire(join(root, 'plugins/benchgo/package.json'))('tar');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, extra = {}, entryTransform) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-linux-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const seed = join(directory, 'seed'), content = join(directory, 'content');
  await mkdir(seed); await mkdir(content);
  const plugin = JSON.parse(await readFile(join(root, 'plugins/benchgo/package.json')));
  const upstream = JSON.parse(await readFile(join(root, 'upstream.json')));
  const worker = Buffer.alloc(64); worker.write('7f454c460201', 0, 'hex'); worker.writeUInt16LE(62, 18);
  const files = {
    'release.json': JSON.stringify({ schemaVersion: 1, version: plugin.version, platform: 'linux' }),
    'node_modules/benchgo-plugin/package.json': JSON.stringify({ name: 'benchgo-plugin', version: plugin.version }),
    'node_modules/benchgo-plugin/src/plugin.mjs': 'export default {};',
    'node_modules/benchgo-plugin/lib/client.js': 'export {};',
    'node_modules/benchgo-plugin/lib/link-web/index.html': '<title>BenchGo</title>',
    'node_modules/benchgo-plugin/node_modules/dsh-ops/runtime/linux-x64/dsh-ops-worker': worker,
    ...extra,
  };
  for (const [name, bytes] of Object.entries(files)) { await mkdir(dirname(join(content, name)), { recursive: true }); await writeFile(join(content, name), bytes); }
  await tar.c({ file: join(seed, 'server-seed.tar.gz'), cwd: content, gzip: true,
    onWriteEntry(entry) { if (entry.path.endsWith('/dsh-ops-worker')) entry.stat.mode |= 0o111; entryTransform?.(entry); } }, ['release.json', 'node_modules']);
  await writeFile(join(seed, 'manifest.json'), JSON.stringify({ schemaVersion: 1, pluginVersion: plugin.version, harnessVersion: upstream.version,
    harnessCommit: upstream.commit, sha256: sha256(await readFile(join(seed, 'server-seed.tar.gz'))) }));
  for (const name of ['bootstrap.sh', 'bootstrap.mjs']) await cp(join(root, 'scripts/server', name), join(seed, name));
  return { directory, seed, plugin, output: join(directory, 'out') };
}

test('Linux server package carries verified current seed, real x64 identity, inventory and licenses', async t => {
  const { seed, output, plugin, directory } = await fixture(t);
  const receipt = await assembleLinuxServer({ seedDirectory: seed, output, sourceSha: 'a'.repeat(40) });
  assert.deepEqual(receipt.verified, linuxVerification);
  assert.equal(receipt.platform, 'linux'); assert.equal(receipt.arch, 'x64'); assert.equal(receipt.kind, 'server');
  assert.equal(receipt.pluginVersion, plugin.version); assert.equal(receipt.sourceSha, 'a'.repeat(40));
  const archive = receipt.files.find(row => row.name.endsWith('.tar.gz'));
  assert.equal(sha256(await readFile(join(output, archive.name))), archive.sha256);
  assert.equal(await readFile(join(output, archive.name + '.sha256'), 'utf8'), `${archive.sha256}  ${archive.name}\n`);
  const unpacked = join(directory, 'unpacked'); await mkdir(unpacked);
  await tar.x({ file: join(output, archive.name), cwd: unpacked });
  const packageRoot = join(unpacked, archive.name.slice(0, -7));
  const source = JSON.parse(await readFile(join(packageRoot, 'release-source.json')));
  assert.equal(source.runtimeIncluded, false); assert.equal(source.arch, 'x64');
  assert.match(await readFile(join(packageRoot, 'README.md'), 'utf8'), /首次安装仍需联网/);
  assert.match(await readFile(join(packageRoot, 'install.sh'), 'utf8'), /uname -m.*x86_64/);
  const checksums = (await readFile(join(packageRoot, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n');
  for (const line of checksums) { const [expected, name] = line.split('  '); assert.equal(sha256(await readFile(join(packageRoot, name))), expected); }
  assert(checksums.some(row => row.endsWith('  DEEPSEEK-LICENSE')));
  assert.equal(checksums.length, (await readdir(packageRoot)).length - 1);
});

test('Linux release rejects modified seeds and stale bootstrap before writing artifacts', async t => {
  const { seed, output } = await fixture(t);
  await writeFile(join(seed, 'bootstrap.sh'), '# stale');
  await assert.rejects(assembleLinuxServer({ seedDirectory: seed, output, sourceSha: 'a'.repeat(40) }), /stale bootstrap/);
  await writeFile(join(seed, 'server-seed.tar.gz'), 'corrupted');
  await assert.rejects(assembleLinuxServer({ seedDirectory: seed, output, sourceSha: 'a'.repeat(40) }), /checksum or identity/);
});

test('Linux seed refuses native addons and a non-x64 worker rather than labelling them universal', async t => {
  const bad = await fixture(t, { 'node_modules/benchgo-plugin/unsupported.node': 'native' });
  await assert.rejects(verifyLinuxSeed(join(bad.seed, 'server-seed.tar.gz'), { pluginVersion: bad.plugin.version }), /Non-Linux-x64/);
  const wrong = await fixture(t, { 'node_modules/benchgo-plugin/node_modules/dsh-ops/runtime/linux-x64/dsh-ops-worker': 'not ELF' });
  await assert.rejects(verifyLinuxSeed(join(wrong.seed, 'server-seed.tar.gz'), { pluginVersion: wrong.plugin.version }), /ELF x86-64/);
});

test('Linux release refuses occupied output and an invalid immutable source', async t => {
  const { seed, output } = await fixture(t);
  await assert.rejects(assembleLinuxServer({ seedDirectory: seed, output, sourceSha: 'main' }), /immutable source/);
  await mkdir(output); await writeFile(join(output, 'user-file'), 'keep');
  await assert.rejects(assembleLinuxServer({ seedDirectory: seed, output, sourceSha: 'a'.repeat(40) }), /must be empty/);
  assert.equal(await readFile(join(output, 'user-file'), 'utf8'), 'keep');
});

test('Linux seed rejects traversal and a native worker without Unix execute bits', async t => {
  const traversal = await fixture(t, {}, entry => { if (entry.path.endsWith('/src/plugin.mjs')) entry.path = '../escape.mjs'; });
  await assert.rejects(verifyLinuxSeed(join(traversal.seed, 'server-seed.tar.gz'), { pluginVersion: traversal.plugin.version }), /Unsafe seed entry/);
  const mode = await fixture(t, {}, entry => { if (entry.path.endsWith('/dsh-ops-worker')) entry.stat.mode &= ~0o111; });
  await assert.rejects(verifyLinuxSeed(join(mode.seed, 'server-seed.tar.gz'), { pluginVersion: mode.plugin.version }), /executable permissions/);
});
