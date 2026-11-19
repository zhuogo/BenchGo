import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { createProfileIntegrityGuard, validateProfilePatch } from '../shared/profile-integrity.mjs';

const original = Buffer.from('\uFEFF# user settings\r\n- id: llm-pi-ai\r\n  config:\r\n    enabled: true\r\n');
const updated = Buffer.from('# changed settings\n- id: llm-pi-ai\n  config:\n    enabled: false\n');

async function fixture(t, bytes = original) {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-profile-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'profile', 'cordis.patch.yml'), directory = join(root, 'integrity');
  await mkdir(dirname(path), { recursive: true });
  if (bytes !== null) await writeFile(path, bytes);
  return { root, path, paths: [path], directory };
}
const createGuard = options => createProfileIntegrityGuard({ ...options, withFileLock, writeFileAtomic });

test('accepts patch lists and inert !!js expressions without executing them', () => {
  globalThis.profileIntegrityExecuted = false;
  const result = validateProfilePatch('- insert:\n    - id: sample\n      config: !!js "globalThis.profileIntegrityExecuted = true"\n', 'sample');
  assert.equal(globalThis.profileIntegrityExecuted, false);
  assert.equal(result[0].insert[0].config, 'globalThis.profileIntegrityExecuted = true');
  delete globalThis.profileIntegrityExecuted;
  assert.deepEqual(validateProfilePatch('[]\n'), []);
});

for (const [name, bytes] of [
  ['flattened comment document', original.toString('utf8').replace(/[\r\n]/g, '')],
  ['removed comment marker', original.toString('utf8').replace('#', '')],
  ['truncated YAML', '- id: sample\n  config: [unfinished\n'],
  ['mapping document', 'config:\n  enabled: true\n'],
  ['scalar array entry', '- invalid\n'],
  ['empty document', ''],
]) test('restores ' + name + ' and preserves rejected bytes separately', async t => {
  const f = await fixture(t), guard = await createGuard(f);
  const invalid = Buffer.from(bytes);
  await writeFile(f.path, invalid);
  assert.deepEqual(await guard.check(), { recovered: [f.path] });
  assert.deepEqual(await readFile(f.path), original);
  const rejected = await readdir(join(f.directory, 'rejected'));
  assert.equal(rejected.length, 1);
  const evidence = join(f.directory, 'rejected', rejected[0]);
  assert.deepEqual(await readFile(evidence), invalid);
  if (process.platform !== 'win32') assert.equal((await stat(evidence)).mode & 0o777, 0o600);
});

test('normal valid edits become the next exact-byte checkpoint', async t => {
  const f = await fixture(t), guard = await createGuard(f);
  assert.equal(await guard.run(async () => { await writeFile(f.path, updated); return 'saved'; }), 'saved');
  assert.deepEqual(await readFile(f.path), updated);
  await writeFile(f.path, '{}');
  await guard.check();
  assert.deepEqual(await readFile(f.path), updated);
});

test('run recovers in finally when an operation throws or aborts', async t => {
  for (const error of [new Error('failed'), Object.assign(new Error('cancelled'), { name: 'AbortError' })]) {
    const f = await fixture(t), guard = await createGuard(f);
    await assert.rejects(guard.run(async () => { await writeFile(f.path, '# swallowed'); throw error; }), { code: 'PROFILE_CONFIG_RESTORED' });
    assert.deepEqual(await readFile(f.path), original);
  }
});

test('run preserves the original error when valid configuration remains intact', async t => {
  const f = await fixture(t), guard = await createGuard(f), failure = new Error('original operation failure');
  await assert.rejects(guard.run(async () => { throw failure; }), error => error === failure);
});

test('run cannot return success after writing malformed configuration', async t => {
  const f = await fixture(t), guard = await createGuard(f);
  await assert.rejects(guard.run(async () => { await writeFile(f.path, '{}'); return 'success'; }), { code: 'PROFILE_CONFIG_RESTORED' });
  assert.deepEqual(await readFile(f.path), original);
});

test('check can reject after completing a recovery', async t => {
  const f = await fixture(t), guard = await createGuard(f);
  await writeFile(f.path, '{}');
  await assert.rejects(guard.check({ source: 'test', rejectRecovered: true }), error =>
    error.code === 'PROFILE_CONFIG_RESTORED' && error.source === 'test' && error.recovered[0] === f.path);
  assert.deepEqual(await readFile(f.path), original);
});

test('cold startup restores from the persisted validated checkpoint', async t => {
  const f = await fixture(t);
  await createGuard(f);
  await writeFile(f.path, 'missing opening #\n- id: llm-pi-ai\n');
  await createGuard(f);
  assert.deepEqual(await readFile(f.path), original);
});

test('malformed startup without a trusted checkpoint preserves the input and rejects', async t => {
  const bad = Buffer.from('not:\n  an: array\n'), f = await fixture(t, bad);
  await assert.rejects(createGuard(f), { code: 'PROFILE_CONFIG_INVALID' });
  assert.deepEqual(await readFile(f.path), bad);
});

test('a corrupt checkpoint never silently replaces an invalid current file', async t => {
  const f = await fixture(t);
  await createGuard(f);
  const snapshots = await readdir(join(f.directory, 'checkpoints'));
  await writeFile(join(f.directory, 'checkpoints', snapshots[0]), '{}');
  await writeFile(f.path, '# invalid');
  await assert.rejects(createGuard(f), { code: 'PROFILE_CONFIG_INVALID' });
  assert.equal(await readFile(f.path, 'utf8'), '# invalid');
});

test('an originally absent optional home patch remains absent', async t => {
  const f = await fixture(t), optional = join(f.root, 'absent-home', 'cordis.patch.yml');
  const guard = await createGuard({ ...f, paths: [f.path, optional] });
  assert.deepEqual(await guard.check(), { recovered: [] });
  await assert.rejects(stat(optional), { code: 'ENOENT' });
  await assert.rejects(stat(dirname(optional)), { code: 'ENOENT' });
});

test('deleting a previously valid protected file restores its checkpoint', async t => {
  const f = await fixture(t), guard = await createGuard(f);
  await rm(f.path);
  assert.deepEqual(await guard.check(), { recovered: [f.path] });
  assert.deepEqual(await readFile(f.path), original);
});

test('a concurrent valid commit under the official manifest lock wins over a stale snapshot', async t => {
  const f = await fixture(t), guard = await createGuard(f);
  let release, locked;
  const started = new Promise(resolve => { locked = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const writer = withFileLock(join(dirname(f.path), 'package.json'), async () => {
    await writeFile(f.path, '# temporary invalid bytes');
    locked();
    await gate;
    await writeFile(f.path, updated);
  });
  await started;
  const inspection = guard.check();
  release();
  await writer;
  assert.deepEqual(await inspection, { recovered: [] });
  assert.deepEqual(await readFile(f.path), updated);
  await writeFile(f.path, '{}');
  await guard.check();
  assert.deepEqual(await readFile(f.path), updated);
});
