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
  const action = (callback, identity = {}) => store.protect({ directory, runId: 'run', ticketId: 'ticket', assignmentId: 'assignment',
    callId: 'call', fence: 1, instructionRevision: 1, ...identity }, callback);
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

test('complete observations compare existing metadata including zero net file changes without exporting files', async t => {
  const observations = [];
  const f = await fixture(t, { onObservation: async value => { await Promise.resolve(); observations.push(value); } });
  await f.action(async () => 'empty');
  assert.equal(observations.length, 1, 'protect awaits the persisted observation callback');
  assert.deepEqual(observations[0].comparison, { beforeFiles: 0, afterFiles: 0, added: 0, modified: 0, deleted: 0, unchanged: 0, netChanged: false });
  await f.write('same.txt', 'same'); await f.write('edited.txt', 'before'); await f.write('deleted.txt', 'before');
  await f.action(async () => {
    await f.write('same.txt', 'same'); await f.write('edited.txt', 'after'); await unlink(join(f.directory, 'deleted.txt')); await f.write('created.txt', 'new');
  }, { instructionRevision: 3, fence: 2 });
  const observed = observations[1], [first, second] = await f.store.list({ runId: 'run' });
  assert.equal(observed.observationId, second.id); assert.equal(observations[0].observationId, first.id);
  assert.equal(observed.sequence, 1); assert.equal(observed.callId, 'call'); assert.equal(observed.fence, 2); assert.equal(observed.instructionRevision, 3);
  assert.equal(observed.ticketId, 'ticket'); assert.equal(observed.assignmentId, 'assignment'); assert.equal(observed.runId, 'run');
  assert.equal(observed.directory, f.directory); assert.equal(Number.isFinite(Date.parse(observed.startedAt)), true);
  assert.equal(Date.parse(observed.completedAt) >= Date.parse(observed.startedAt), true);
  assert.deepEqual(observed.coverage, { kind: 'protected-workspace-files', complete: true, truncated: false, exclusionsVersion: 1,
    externalEffects: 'not-observed', conversationOutputs: 'not-observed' });
  assert.deepEqual(observed.comparison, { beforeFiles: 3, afterFiles: 3, added: 1, modified: 1, deleted: 1, unchanged: 1, netChanged: true });
  assert.doesNotMatch(JSON.stringify(observations), /same\.txt|edited\.txt|deleted\.txt|created\.txt|"hash"|"blob"|"mode"/);
  await f.action(() => f.write('edited.txt', 'after'));
  assert.deepEqual(observations[2].comparison, { beforeFiles: 3, afterFiles: 3, added: 0, modified: 0, deleted: 0, unchanged: 3, netChanged: false });
});

test('dispatch errors still publish a complete after-state, but after scan failures remain pending and unobserved', async t => {
  const observations = [];
  const f = await fixture(t, { maxFileBytes: 8, onObservation: value => observations.push(value) });
  const error = new Error('official dispatch failed');
  await assert.rejects(f.action(async () => { await f.write('a', 'new'); throw error; }), value => value === error);
  assert.equal(observations.length, 1); assert.equal(observations[0].comparison.added, 1);
  assert.equal((await f.store.list({ runId: 'run' }))[0].state, 'complete');
  await assert.rejects(f.action(() => f.write('a', 'too large for snapshot')), { code: 'CHECKPOINT_LIMIT' });
  assert.equal(observations.length, 1);
  assert.equal((await f.store.list({ runId: 'run' }))[1].state, 'pending');
  await assert.rejects(f.action(() => assert.fail('unfinished action must not replay')), { code: 'CHECKPOINT_UNCERTAIN' });
});

test('observation journal and diagnostics failures cannot fail or replay an already executed action', async t => {
  let dispatches = 0; const warnings = [];
  const f = await fixture(t, { onObservation: async () => { throw new Error('journal unavailable'); },
    onObservationError: metadata => { warnings.push(metadata); throw new Error('logger unavailable'); } });
  assert.equal(await f.action(async () => { dispatches++; await f.write('a', 'done'); return 'official result'; }), 'official result');
  assert.equal(dispatches, 1); assert.equal(await f.read('a'), 'done');
  const [record] = await f.store.list({ runId: 'run' });
  assert.equal(record.state, 'complete'); assert.equal(record.observationState, 'failed');
  assert.deepEqual(f.store.observationCoverage('run'), { known: true, complete: false, firstSequence: 0, lastSequence: 0, pending: 0, failed: 1, restored: false });
  assert.deepEqual(warnings, [{ observationId: record.id, runId: 'run', code: 'CHECKPOINT_OBSERVATION_FAILED' }]);
  const failure = new Error('original dispatch failure');
  await assert.rejects(f.action(async () => { dispatches++; throw failure; }), value => value === failure);
  assert.equal(dispatches, 2);
  await f.action(async () => 'next distinct action');
  assert.equal((await f.store.list({ runId: 'run' })).length, 3, 'a missing projection is not a pending dispatch');
});

test('derived observation coverage stays unknown after restart and tracks queued and pending tails', async t => {
  const f = await fixture(t, { onObservation: async () => {} });
  assert.deepEqual(f.store.observationCoverage('run'), { known: false, complete: false, firstSequence: null, lastSequence: null, pending: 0, failed: 0, restored: false });
  let releaseFirst, releaseSecond;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise(resolve => { releaseSecond = resolve; });
  let secondStarted;
  const started = new Promise(resolve => { secondStarted = resolve; });
  const first = f.action(() => firstGate), second = f.action(async () => { secondStarted(); await secondGate; });
  assert.equal(f.store.observationCoverage('run').pending, 2, 'queued actions count immediately');
  releaseFirst(); await first; await started;
  assert.equal(f.store.observationCoverage('run').complete, false); assert.equal(f.store.observationCoverage('run').pending, 1);
  releaseSecond(); await second;
  assert.deepEqual(f.store.observationCoverage('run'), { known: true, complete: true, firstSequence: 0, lastSequence: 1, pending: 0, failed: 0, restored: false });
  const reloaded = createWorkerCheckpointStore({ directory: f.backup, onObservation: async () => {} });
  assert.equal(reloaded.observationCoverage('run').known, false);
  await reloaded.list({ runId: 'run' });
  assert.equal(reloaded.observationCoverage('run').complete, true, 'only persisted recorded observation metadata restores coverage');
  const plan = await reloaded.preview('run'); await reloaded.restore('run', { token: plan.token });
  assert.equal(reloaded.observationCoverage('run').restored, true); assert.equal(reloaded.observationCoverage('run').complete, false);
});

test('legacy complete records and incomplete after snapshots never restore complete observation coverage', async t => {
  const legacy = await fixture(t); await legacy.action(async () => {});
  assert.equal(legacy.store.observationCoverage('run').complete, false); assert.equal(legacy.store.observationCoverage('run').failed, 1);
  const reloaded = createWorkerCheckpointStore({ directory: legacy.backup }); await reloaded.list({ runId: 'run' });
  assert.equal(reloaded.observationCoverage('run').complete, false);
  const f = await fixture(t, { maxFileBytes: 1, onObservation: async () => {} });
  await assert.rejects(f.action(() => f.write('a', 'large')), { code: 'CHECKPOINT_LIMIT' });
  assert.equal(f.store.observationCoverage('run').pending, 1); assert.equal(f.store.observationCoverage('run').complete, false);
  const next = createWorkerCheckpointStore({ directory: f.backup }); await next.list({ runId: 'run' });
  assert.equal(next.observationCoverage('run').pending, 1); assert.equal(next.observationCoverage('run').complete, false);
});
