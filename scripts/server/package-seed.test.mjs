import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { linuxWorkerArchivePath, writeServerSeedArchive } from './package-seed.mjs';
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
    'node_modules/benchgo-plugin/optional.node': 'Excluded native addon' };
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
    filter: path => !path.endsWith('.node') }, ['release.json', 'node_modules']);
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
  assert(!after.has('node_modules/benchgo-plugin/optional.node'));
});

test('archive permission repair refuses non-ELF or wrong-architecture payloads at the privileged worker path', async t => {
  const { seed, worker, payload } = await fixture(t);
  await writeFile(worker, 'MZ-not-a-linux-worker');
  await assert.rejects(writeServerSeedArchive({ seed, payload }), /ELF x86-64/);
  const arm = Buffer.alloc(64); arm.write('7f454c460201', 0, 'hex'); arm.writeUInt16LE(183, 18);
  await writeFile(worker, arm);
  await assert.rejects(writeServerSeedArchive({ seed, payload }), /ELF x86-64/);
});

test('server archive refuses an omitted or inaccurate architecture declaration', async t => {
  const { seed, payload } = await fixture(t);
  for (const value of [{ platform: 'linux' }, { platform: 'linux', arch: 'arm64' }, { platform: 'win32', arch: 'x64' }]) {
    await writeFile(join(seed, 'release.json'), JSON.stringify(value));
    await assert.rejects(writeServerSeedArchive({ seed, payload }), /platform linux and arch x64/);
  }
});
