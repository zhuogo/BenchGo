import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkerCheckpointStore } from '../src/worker-checkpoint-store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'benchgo-checkpoint-race-')), directory = join(root, 'workspace');
  await fs.mkdir(directory);
  const observations = [], store = createWorkerCheckpointStore({ directory: join(root, 'checkpoints'), onObservation: value => observations.push(value) });
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }); });
  const action = dispatch => store.protect({ directory, runId: 'run', ticketId: 'ticket', assignmentId: 'assignment', callId: 'call', fence: 1, instructionRevision: 1 }, dispatch);
  return { directory, store, observations, action };
}

for (const mutation of ['add-after-listing', 'remove-before-listing', 'replace-after-listing']) test(`concurrent directory ${mutation} rejects a partial before manifest before dispatch`, async t => {
  const f = await fixture(t), nested = join(f.directory, 'nested'), changed = join(nested, 'entry.txt');
  await fs.mkdir(nested);
  if (mutation === 'remove-before-listing') await fs.writeFile(changed, 'old');
  await fs.utimes(nested, new Date('2020-01-01'), new Date('2020-01-01'));
  const readdir = fs.readdir;
  t.mock.method(fs, 'readdir', async (path, ...args) => {
    if (path !== nested) return readdir(path, ...args);
    if (mutation === 'remove-before-listing') { await fs.unlink(changed); return readdir(path, ...args); }
    const names = await readdir(path, ...args);
    if (mutation === 'replace-after-listing') { await fs.rename(path, join(f.directory, 'retired')); await fs.mkdir(path); }
    else await fs.writeFile(changed, 'new');
    return names;
  });
  syncBuiltinESMExports();
  await assert.rejects(f.action(() => assert.fail('a partial before-state must not dispatch')), { code: 'CHECKPOINT_CHANGED' });
  assert.equal(f.observations.length, 0); assert.equal((await f.store.list({ runId: 'run' })).length, 0);
});

test('a name added during the after walk leaves the dispatched checkpoint pending and unobserved', async t => {
  const f = await fixture(t), readdir = fs.readdir; let workspaceReads = 0, dispatches = 0;
  t.mock.method(fs, 'readdir', async (path, ...args) => {
    const names = await readdir(path, ...args);
    if (path === f.directory && ++workspaceReads === 2) {
      await fs.writeFile(join(f.directory, 'late.txt'), 'new');
      await fs.utimes(f.directory, new Date('2030-01-01'), new Date('2030-01-01'));
    }
    return names;
  });
  syncBuiltinESMExports();
  await assert.rejects(f.action(async () => { dispatches++; }), { code: 'CHECKPOINT_CHANGED' });
  assert.equal(dispatches, 1); assert.equal(f.observations.length, 0);
  const [record] = await f.store.list({ runId: 'run' }); assert.equal(record.state, 'pending');
  assert.equal(f.store.observationCoverage('run').complete, false); assert.equal(f.store.observationCoverage('run').pending, 1);
  await assert.rejects(f.action(() => assert.fail('pending action must not replay')), { code: 'CHECKPOINT_UNCERTAIN' });
});

test('a same-sized file changed between lstat and open rejects the inconsistent manifest', async t => {
  const f = await fixture(t), file = join(f.directory, 'entry.txt'), open = fs.open;
  await fs.writeFile(file, 'old');
  t.mock.method(fs, 'open', async (path, ...args) => {
    if (path === file) { await fs.writeFile(file, 'new'); await fs.utimes(file, new Date('2030-01-01'), new Date('2030-01-01')); }
    return open(path, ...args);
  });
  syncBuiltinESMExports();
  await assert.rejects(f.action(() => assert.fail('a changed before-state must not dispatch')), { code: 'CHECKPOINT_CHANGED' });
  assert.equal(f.observations.length, 0); assert.equal((await f.store.list({ runId: 'run' })).length, 0);
});
