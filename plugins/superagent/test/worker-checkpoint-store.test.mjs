import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createWorkerCheckpointStore } from '../src/worker-checkpoint-store.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'workspace'), backup = join(root, 'shadow');
  await mkdir(directory);
  const store = createWorkerCheckpointStore({ directory: backup, ...options });
  const action = callback => store.protect({ directory, runId: 'run', ticketId: 'ticket', assignmentId: 'assignment' }, callback);
  return { root, directory, backup, store, action, write: (name, text) => writeFile(join(directory, name), text), read: name => readFile(join(directory, name), 'utf8') };
}

test('round restore reverses creations, deletions and edits, preserving later unrelated user work', async t => {
  const f = await fixture(t);
  await f.write('edited.txt', 'original'); await f.write('deleted.txt', 'keep');
  await f.action(async () => { await f.write('edited.txt', 'v1'); await unlink(join(f.directory, 'deleted.txt')); });
  await f.action(async () => { await f.write('edited.txt', 'v2'); await f.write('created.txt', 'new'); });
  await f.write('user.txt', 'later user work');
  const plan = await f.store.preview('run');
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.changes.map(row => row.path), ['created.txt', 'deleted.txt', 'edited.txt']);
  const restored = await f.store.restore('run', { token: plan.token });
  assert.equal(restored.externalEffectsReverted, false);
  assert.equal(await f.read('edited.txt'), 'original'); assert.equal(await f.read('deleted.txt'), 'keep'); assert.equal(await f.read('user.txt'), 'later user work');
  await assert.rejects(f.read('created.txt'), { code: 'ENOENT' });
  assert.equal((await f.store.list({ ticketId: 'ticket' })).filter(row => row.kind === 'restore').length, 1);
  await assert.rejects(f.store.preview('run'), { code: 'CHECKPOINT_RESTORED' });
  assert.equal(execFileSync('git', ['--git-dir', f.backup, 'rev-parse', '--is-bare-repository'], { encoding: 'utf8', windowsHide: true }).trim(), 'true');
});

test('same-file later edits and edits between actions prevent whole-round overwrite', async t => {
  const f = await fixture(t);
  await f.write('work.txt', 'original');
  await f.action(() => f.write('work.txt', 'agent one'));
  await f.write('work.txt', 'user middle');
  await f.action(() => f.write('work.txt', 'agent two'));
  const plan = await f.store.preview('run');
  assert.deepEqual(plan.conflicts, ['work.txt']);
  await assert.rejects(f.store.restore('run', { token: plan.token }), { code: 'CHECKPOINT_CONFLICT' });
  assert.equal(await f.read('work.txt'), 'agent two');
  await f.write('work.txt', 'user later');
  assert.deepEqual((await f.store.preview('run')).conflicts, ['work.txt']);
});

test('preview tokens bind the current workspace and survive service reload', async t => {
  const f = await fixture(t);
  await f.write('a', 'old'); await f.action(() => f.write('a', 'new'));
  const reloaded = createWorkerCheckpointStore({ directory: f.backup });
  const plan = await reloaded.preview('run');
  await f.write('other', 'user');
  await assert.rejects(reloaded.restore('run', { token: plan.token }), { code: 'CHECKPOINT_CHANGED' });
  const next = await reloaded.preview('run');
  await reloaded.restore('run', { token: next.token });
  assert.equal(await f.read('a'), 'old');
});

test('failed actions retain their changed files and same-run calls serialize', async t => {
  const f = await fixture(t);
  await f.write('a', 'old');
  await assert.rejects(f.action(async () => { await f.write('a', 'failed change'); throw new Error('tool failed'); }), /tool failed/);
  const order = [];
  await Promise.all([f.action(async () => { order.push(1); await f.write('a', 'second'); order.push(2); }), f.action(async () => { order.push(3); await f.write('a', 'third'); })]);
  assert.deepEqual(order, [1, 2, 3]);
  const plan = await f.store.preview('run'); await f.store.restore('run', { token: plan.token });
  assert.equal(await f.read('a'), 'old');
});

test('credentials and project Git metadata are excluded and limits fail before dispatch', async t => {
  const f = await fixture(t, { maxFileBytes: 5 });
  await f.write('.env', 'SECRET_VALUE'); await f.write('private.key', 'SECRET_VALUE');
  await mkdir(join(f.directory, '.git')); await writeFile(join(f.directory, '.git', 'index'), 'original index');
  await f.write('a', 'old'); await f.action(() => f.write('a', 'new'));
  const plan = await f.store.preview('run'); assert.deepEqual(plan.changes.map(row => row.path), ['a']);
  await f.store.restore('run', { token: plan.token });
  assert.equal(await f.read('.env'), 'SECRET_VALUE');
  assert.equal(await readFile(join(f.directory, '.git', 'index'), 'utf8'), 'original index');
  const second = await fixture(t, { maxFileBytes: 5 }); await second.write('huge', 'too large');
  await assert.rejects(second.action(() => assert.fail('must not dispatch')), { code: 'CHECKPOINT_LIMIT' });
});

test('symlink workspace content fails closed', async t => {
  const f = await fixture(t); const target = join(f.root, 'outside'); await mkdir(target);
  await symlink(target, join(f.directory, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.action(() => assert.fail('must not dispatch')), { code: 'CHECKPOINT_UNSAFE_PATH' });
});

test('file/directory transitions can be restored without recursive deletion', async t => {
  const f = await fixture(t);
  await f.write('a', 'original');
  await f.action(async () => { await unlink(join(f.directory, 'a')); await mkdir(join(f.directory, 'a', 'nested'), { recursive: true }); await f.write('a/nested/child', 'new'); });
  const plan = await f.store.preview('run'); await f.store.restore('run', { token: plan.token });
  assert.equal(await f.read('a'), 'original');
  const g = await fixture(t);
  await mkdir(join(g.directory, 'a')); await g.write('a/child', 'original');
  await g.action(async () => { await rm(join(g.directory, 'a'), { recursive: true }); await g.write('a', 'new'); });
  const next = await g.store.preview('run'); await g.store.restore('run', { token: next.token });
  assert.equal(await g.read('a/child'), 'original');
});

test('new user files beneath a former file conflict before any rollback writes', async t => {
  const f = await fixture(t);
  await f.write('a', 'original');
  await f.action(async () => { await unlink(join(f.directory, 'a')); await mkdir(join(f.directory, 'a')); await f.write('a/agent', 'new'); });
  await f.write('a/user', 'later');
  const plan = await f.store.preview('run');
  assert.deepEqual(plan.conflicts, ['a']);
  await assert.rejects(f.store.restore('run', { token: plan.token }), { code: 'CHECKPOINT_CONFLICT' });
  assert.equal(await f.read('a/agent'), 'new'); assert.equal(await f.read('a/user'), 'later');
});

test('crash-pending records block further actions and rollback', async t => {
  const f = await fixture(t);
  await f.write('a', 'old'); await f.action(() => f.write('a', 'new'));
  const [record] = await f.store.list({ runId: 'run' });
  const path = join(f.backup, 'records', `${record.id}.json`);
  const data = JSON.parse(await readFile(path, 'utf8')); delete data.after; data.state = 'pending';
  await writeFile(path, JSON.stringify(data));
  const reloaded = createWorkerCheckpointStore({ directory: f.backup });
  await assert.rejects(reloaded.preview('run'), { code: 'CHECKPOINT_UNCERTAIN' });
  await assert.rejects(f.action(() => assert.fail('unfinished action must not repeat')), { code: 'CHECKPOINT_UNCERTAIN' });
});
