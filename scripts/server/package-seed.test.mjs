import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertLinuxNativeClosure, linuxWorkerArchivePath, prepareLinuxDependencies, promoteServerResources, writeServerSeedArchive } from './package-seed.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const tar = createRequire(join(root, 'plugins/benchgo/package.json'))('tar');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-seed-mode-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const seed = join(directory, 'seed'); await mkdir(seed);
  const worker = Buffer.alloc(64); worker.write('7f454c460201', 0, 'hex'); worker.writeUInt16LE(62, 18);
  const files = { 'release.json': '{"schemaVersion":1,"platform":"linux","arch":"x64"}', [linuxWorkerArchivePath]: worker,
    'node_modules/benchgo-plugin/NOTICE': 'Third-party notices remain unchanged.\n',
    'node_modules/benchgo-plugin/node_modules/dsh-ops/LICENSE': 'Retained MIT license.\n',
    'node_modules/other-package/dsh-ops-worker': 'Unrelated file; never make executable.',
    'node_modules/benchgo-plugin/optional.node': worker };
  for (const [name, bytes] of Object.entries(files)) { await mkdir(dirname(join(seed, name)), { recursive: true }); await writeFile(join(seed, name), bytes, { mode: 0o644 }); }
  return { directory, seed, worker: join(seed, linuxWorkerArchivePath), payload: join(directory, 'seed.tar.gz') };
}

async function modes(archive) {
  const result = new Map();
  await tar.t({ file: archive, strict: true, onReadEntry(entry) { result.set(entry.path, entry.mode); } });
  return result;
}

test('real seed tar header makes only the verified Linux ELF worker 0755 even when source stat has no execute bits', async t => {
  const { directory, seed, worker, payload } = await fixture(t);
  assert.equal((await lstat(worker)).mode & 0o111, 0, 'fixture reproduces NTFS/non-executable source metadata');
  const baseline = join(directory, 'baseline.tar.gz');
  await tar.c({ file: baseline, cwd: seed, gzip: true, portable: true, noMtime: true,
  }, ['release.json', 'node_modules']);
  const before = await modes(baseline);
  await writeServerSeedArchive({ seed, payload });
  const after = await modes(payload);
  assert.equal(after.get(linuxWorkerArchivePath), 0o755);
  assert.equal((await lstat(worker)).mode & 0o111, 0, 'source file was not chmodded');
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [name, mode] of before) if (name !== linuxWorkerArchivePath) assert.equal(after.get(name), mode, `unrelated header permissions preserved: ${name}`);
  const extracted = join(directory, 'extracted'); await mkdir(extracted);
  await tar.x({ file: payload, cwd: extracted });
  assert.equal(JSON.parse(await readFile(join(extracted, 'release.json'), 'utf8')).arch, 'x64');
  for (const name of ['node_modules/benchgo-plugin/NOTICE', 'node_modules/benchgo-plugin/node_modules/dsh-ops/LICENSE', 'node_modules/other-package/dsh-ops-worker'])
    assert.deepEqual(await readFile(join(extracted, name)), await readFile(join(seed, name)));
  assert(after.has('node_modules/benchgo-plugin/optional.node'), 'compatible Linux bindings remain in the offline payload');
});

test('archive permission repair refuses non-ELF or wrong-architecture payloads at the privileged worker path', async t => {
  const { seed, worker, payload } = await fixture(t);
  await writeFile(worker, 'MZ-not-a-linux-worker');
  await assert.rejects(writeServerSeedArchive({ seed, payload }), /ELF x86-64/);
  const arm = Buffer.alloc(64); arm.write('7f454c460201', 0, 'hex'); arm.writeUInt16LE(183, 18);
  await writeFile(worker, arm);
  await assert.rejects(writeServerSeedArchive({ seed, payload }), /ELF x86-64/);
});

test('server seed preserves ELF bindings but refuses build-host Windows addons', async t => {
  const { seed, payload } = await fixture(t);
  await writeFile(join(seed, 'node_modules/benchgo-plugin/optional.node'), 'MZ-windows-binding');
  await assert.rejects(writeServerSeedArchive({ seed, payload }), /ELF x86-64/);
});

test('server archive refuses an omitted or inaccurate architecture declaration', async t => {
  const { seed, payload } = await fixture(t);
  for (const value of [{ platform: 'linux' }, { platform: 'linux', arch: 'arm64' }, { platform: 'win32', arch: 'x64' }]) {
    await writeFile(join(seed, 'release.json'), JSON.stringify(value));
    await assert.rejects(writeServerSeedArchive({ seed, payload }), /platform linux and arch x64/);
  }
});

test('cross-host preparation uses the existing lock, exact Linux target and no lifecycle scripts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-linux-target-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plugin = join(directory, 'source'), clean = join(directory, 'clean');
  await mkdir(plugin); await mkdir(clean); await writeFile(join(plugin, 'package-lock.json'), '{"lockfileVersion":3}');
  let invocation;
  const result = await prepareLinuxDependencies({ plugin, clean, platform: 'win32', arch: 'x64', run: async (args, cwd) => { invocation = { args, cwd }; } });
  assert.equal(result.mode, 'locked-cross-platform'); assert.equal(invocation.cwd, clean);
  for (const option of ['ci', '--os=linux', '--cpu=x64', '--libc=glibc', '--ignore-scripts', '--omit=dev', '--include=optional']) assert(invocation.args.includes(option));
  assert.deepEqual(await readFile(join(clean, 'package-lock.json')), await readFile(join(plugin, 'package-lock.json')));
});

test('offline Linux native closure requires both the sharp binding and its glibc libvips runtime', async t => {
  const { directory } = await fixture(t), plugin = join(directory, 'plugin');
  await mkdir(plugin); await writeFile(join(plugin, 'package.json'), '{}');
  await assert.rejects(assertLinuxNativeClosure(plugin), /omit required @img\/sharp-linux-x64/);
  const elf = Buffer.alloc(64); elf.write('7f454c460201', 0, 'hex'); elf.writeUInt16LE(62, 18);
  for (const [name, file] of [['sharp-linux-x64', 'sharp-linux-x64-0.35.5.node'], ['sharp-libvips-linux-x64', 'libvips-cpp.so.8.18.7']]) {
    const path = join(plugin, 'node_modules/@img', name);
    await mkdir(join(path, 'lib'), { recursive: true });
    await writeFile(join(path, 'package.json'), JSON.stringify({ name: `@img/${name}`, exports: { './package': './package.json' } }));
    await writeFile(join(path, 'lib', file), elf);
    if (name === 'sharp-linux-x64') await assert.rejects(assertLinuxNativeClosure(plugin), /omit required @img\/sharp-libvips-linux-x64/);
  }
  await assertLinuxNativeClosure(plugin);
  await writeFile(join(plugin, 'node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.5.node'), 'MZ-windows');
  await assert.rejects(assertLinuxNativeClosure(plugin), /ELF x86-64/);
});

test('resource promotion rolls back the previous complete directory if final rename fails', async t => {
  const { directory } = await fixture(t);
  const output = join(directory, 'output'), prepared = join(directory, 'prepared'), backup = join(directory, 'backup');
  await mkdir(output); await mkdir(prepared);
  await writeFile(join(output, 'manifest.json'), 'previous-complete'); await writeFile(join(prepared, 'manifest.json'), 'new-complete');
  await assert.rejects(promoteServerResources({ prepared, output, backup, move: async (from, to) => {
    if (from === prepared) throw new Error('promotion denied');
    return rename(from, to);
  } }), /promotion denied/);
  assert.equal(await readFile(join(output, 'manifest.json'), 'utf8'), 'previous-complete');
  assert.equal(await readFile(join(prepared, 'manifest.json'), 'utf8'), 'new-complete');
  await promoteServerResources({ prepared, output, backup });
  assert.equal(await readFile(join(output, 'manifest.json'), 'utf8'), 'new-complete');
  assert.equal(await readFile(join(backup, 'manifest.json'), 'utf8'), 'previous-complete');
});
