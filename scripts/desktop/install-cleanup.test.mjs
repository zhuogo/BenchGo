import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, access, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cleanupRetiredInstalls, queueRetiredInstall } from './install-cleanup.mjs';

const id = number => `{00000000-0000-0000-0000-${String(number).padStart(12, '0')}}`;
const exists = path => access(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'benchgo-cleanup-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const installRoot = join(parent, 'BenchGo');
  const resources = join(installRoot, 'resources');
  await mkdir(resources, { recursive: true });
  await writeFile(join(installRoot, 'keep.txt'), 'current');
  const retire = async (number = 1) => {
    const retiredDirectory = `${installRoot}.old-${id(number)}`;
    await mkdir(join(retiredDirectory, 'nested'), { recursive: true });
    await writeFile(join(retiredDirectory, 'nested', 'old.txt'), 'retired');
    return retiredDirectory;
  };
  const receipt = path => `${path}.benchgo-cleanup.json`;
  return { parent, installRoot, resources, retire, receipt };
}

test('queue atomically persists one exact receipt; cleanup removes only the authorized retired tree', async t => {
  const f = await fixture(t), retiredDirectory = await f.retire();
  const queued = await queueRetiredInstall({ resources: f.resources, retiredDirectory });
  assert.equal(queued.queued, true);
  assert.deepEqual(JSON.parse(await readFile(queued.receipt, 'utf8')), { schemaVersion: 1, installRoot: f.installRoot, retiredDirectory });
  assert.deepEqual(await queueRetiredInstall({ resources: f.resources, retiredDirectory }), queued);
  assert.equal((await readdir(f.parent)).some(name => name.includes('.tmp-')), false);
  assert.equal((await cleanupRetiredInstalls(f))[0].status, 'removed');
  assert.equal(await exists(retiredDirectory), false);
  assert.equal(await exists(queued.receipt), false);
  assert.equal(await readFile(join(f.installRoot, 'keep.txt'), 'utf8'), 'current');
});

test('read-only retired files can be cleaned without touching current files', async t => {
  const f = await fixture(t), retiredDirectory = await f.retire();
  await chmod(join(retiredDirectory, 'nested/old.txt'), 0o444);
  await queueRetiredInstall({ resources: f.resources, retiredDirectory });
  const results = await cleanupRetiredInstalls(f);
  assert.equal(results[0].status, 'removed', results[0].error);
  assert.equal(await readFile(join(f.installRoot, 'keep.txt'), 'utf8'), 'current');
});

test('workspace can become visible without waiting for a slow asynchronous removal', async t => {
  const f = await fixture(t), retiredDirectory = await f.retire();
  await queueRetiredInstall({ resources: f.resources, retiredDirectory });
  const entered = deferred(), release = deferred();
  let completed = false;
  const cleanup = cleanupRetiredInstalls(f, { remove: async (...args) => { entered.resolve(); await release.promise; return rm(...args); } }).then(value => { completed = true; return value; });
  t.after(() => release.resolve());
  let workspaceVisible = false;
  workspaceVisible = true;
  await entered.promise;
  assert.equal(workspaceVisible, true);
  assert.equal(completed, false);
  assert.equal(await exists(retiredDirectory), true);
  release.resolve();
  assert.equal((await cleanup)[0].status, 'removed');
});

test('a failed removal keeps its receipt for retry and does not block later receipts', async t => {
  const f = await fixture(t), first = await f.retire(1), second = await f.retire(2);
  for (const retiredDirectory of [first, second]) await queueRetiredInstall({ resources: f.resources, retiredDirectory });
  const visited = [];
  const result = await cleanupRetiredInstalls(f, { remove: async (path, options) => {
    visited.push(path);
    if (path === first) throw new Error('simulated sharing violation');
    return rm(path, options);
  } });
  assert.deepEqual(visited, [first, second]);
  assert.deepEqual(result.map(item => item.status), ['failed', 'removed']);
  assert.equal(await exists(f.receipt(first)), true);
  assert.equal(await exists(first), true);
  assert.equal(await exists(f.receipt(second)), false);
  assert.equal((await cleanupRetiredInstalls(f))[0].status, 'removed');
});

test('receipts whose old directory is already absent are safely removed', async t => {
  const f = await fixture(t), retiredDirectory = await f.retire();
  await queueRetiredInstall({ resources: f.resources, retiredDirectory });
  await rm(retiredDirectory, { recursive: true });
  let calls = 0;
  assert.equal((await cleanupRetiredInstalls(f, { remove: async () => { calls += 1; } }))[0].status, 'missing');
  assert.equal(calls, 0);
  assert.equal(await exists(f.receipt(retiredDirectory)), false);
  assert.equal((await queueRetiredInstall({ resources: f.resources, retiredDirectory })).queued, false);
});

test('old trees without receipts and unrelated marker filenames are preserved', async t => {
  const f = await fixture(t), retiredDirectory = await f.retire();
  const unknown = join(f.parent, 'BenchGo.old-unknown.benchgo-cleanup.json');
  await writeFile(unknown, '{}');
  assert.deepEqual(await cleanupRetiredInstalls(f), []);
  assert.equal(await exists(retiredDirectory), true);
  assert.equal(await exists(unknown), true);
});

test('atomic receipt failure is reported and retains the old tree without temporary files', async t => {
  const f = await fixture(t), retiredDirectory = await f.retire();
  await assert.rejects(queueRetiredInstall({ resources: f.resources, retiredDirectory }, { commit: async () => { throw new Error('commit denied'); } }), /commit denied/);
  assert.equal(await exists(retiredDirectory), true);
  assert.equal(await exists(f.receipt(retiredDirectory)), false);
  assert.equal((await readdir(f.parent)).some(name => name.includes('.tmp-')), false);
});

test('queue rejects current, staging, unknown, traversal and outside paths', async t => {
  const f = await fixture(t), retiredDirectory = await f.retire();
  for (const path of [f.installRoot, `${f.installRoot}.new-${id(1)}`, `${f.installRoot}.old-unknown`, join(f.installRoot, `BenchGo.old-${id(1)}`), join(dirname(f.parent), `BenchGo.old-${id(1)}`), `${f.parent}/elsewhere/../${retiredDirectory.slice(f.parent.length + 1)}`]) {
    await assert.rejects(queueRetiredInstall({ resources: f.resources, retiredDirectory: path }), /BenchGo install cleanup/);
  }
  assert.equal(await exists(retiredDirectory), true);
  assert.equal(await exists(f.receipt(retiredDirectory)), false);
});

test('malformed or mismatched receipts never authorize deletion', async t => {
  const f = await fixture(t);
  const mutations = [
    value => ({ ...value, schemaVersion: 2 }),
    value => ({ ...value, installRoot: `${f.installRoot}-other` }),
    value => ({ ...value, retiredDirectory: f.installRoot }),
    value => ({ ...value, retiredDirectory: `${f.parent}/x/../${value.retiredDirectory.slice(f.parent.length + 1)}` }),
    value => ({ ...value, extra: true }),
    () => null,
    () => '{broken',
  ];
  const retired = [];
  for (let index = 0; index < mutations.length; index += 1) {
    const retiredDirectory = await f.retire(index + 1); retired.push(retiredDirectory);
    const value = mutations[index]({ schemaVersion: 1, installRoot: f.installRoot, retiredDirectory });
    await writeFile(f.receipt(retiredDirectory), typeof value === 'string' ? value : JSON.stringify(value));
  }
  let calls = 0;
  const result = await cleanupRetiredInstalls(f, { remove: async () => { calls += 1; } });
  assert.equal(result.length, mutations.length);
  assert.equal(result.every(item => item.status === 'failed'), true);
  assert.equal(calls, 0);
  for (const path of retired) assert.equal(await exists(path), true);
});

test('retired root and installation or ancestor junctions are rejected', async t => {
  const f = await fixture(t), target = join(f.parent, 'outside');
  await mkdir(join(target, 'resources'), { recursive: true });
  await writeFile(join(target, 'keep.txt'), 'outside');
  const linkedRetired = `${f.installRoot}.old-${id(1)}`;
  await symlink(target, linkedRetired, 'junction');
  await assert.rejects(queueRetiredInstall({ resources: f.resources, retiredDirectory: linkedRetired }), /links are not allowed/);
  await writeFile(f.receipt(linkedRetired), JSON.stringify({ schemaVersion: 1, installRoot: f.installRoot, retiredDirectory: linkedRetired }));
  assert.equal((await cleanupRetiredInstalls(f))[0].status, 'failed');
  const linkedRoot = join(f.parent, 'linked');
  await symlink(target, linkedRoot, 'junction');
  await assert.rejects(cleanupRetiredInstalls({ resources: join(linkedRoot, 'resources') }), /links are not allowed/);
  const linkedParent = join(f.parent, 'linked-parent');
  await symlink(f.parent, linkedParent, 'junction');
  await assert.rejects(cleanupRetiredInstalls({ resources: join(linkedParent, 'BenchGo', 'resources') }), /links are not allowed/);
  assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'outside');
});

test('receipt symlinks are rejected; internal directory junctions are unlinked without following their targets', async t => {
  const f = await fixture(t), first = await f.retire(1), second = await f.retire(2);
  const target = join(f.parent, 'outside');
  await mkdir(target);
  await writeFile(join(target, 'keep.txt'), 'outside');
  await symlink(target, join(second, 'nested', 'external'), 'junction');
  await queueRetiredInstall({ resources: f.resources, retiredDirectory: second });
  const actualReceipt = join(f.parent, 'external-receipt.json');
  await writeFile(actualReceipt, JSON.stringify({ schemaVersion: 1, installRoot: f.installRoot, retiredDirectory: first }));
  try { await symlink(actualReceipt, f.receipt(first), 'file'); }
  catch (error) {
    // Windows without Developer Mode may deny file symlinks. A directory
    // junction at the receipt path must still fail closed on these machines.
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    await symlink(target, f.receipt(first), 'junction');
  }
  const result = await cleanupRetiredInstalls(f);
  assert.deepEqual(result.map(item => item.status), ['failed', 'removed']);
  await assert.rejects(queueRetiredInstall({ resources: f.resources, retiredDirectory: first }), /links are not allowed/);
  assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'outside');
  assert.equal(await exists(first), true);
  assert.equal(await exists(second), false);
  assert.equal(await exists(actualReceipt), true);
});
