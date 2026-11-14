import test from 'node:test';
import assert from 'node:assert/strict';
import { continueWorkerContext } from '../src/worker-context-continuation.mjs';

function fixture(ids = []) {
  let pending = ids.map(id => ({ id }));
  return {
    assignment: { taskId: 'task' },
    database: { pendingSubscriptionMessages(taskId) { assert.equal(taskId, 'task'); return pending; },
      pendingTaskInputs: () => [], getTask: () => ({ id: 'task', status: 'running', executionControl: {} }) },
    set(ids) { pending = ids.map(id => ({ id })); },
  };
}

test('late additions drain through actual turns, including additions arriving during continuation', async () => {
  const f = fixture(['first']); let turns = 0;
  assert.deepEqual(await continueWorkerContext({ ...f, runTurn: async () => f.set(++turns === 1 ? ['second'] : []) }), { turns: 2, waiting: false });
});

test('empty inbox does not start another turn', async () => {
  assert.deepEqual(await continueWorkerContext({ ...fixture(), runTurn: async () => assert.fail('unexpected turn') }), { turns: 0, waiting: false });
});

test('unconsumed context fails instead of inventing a receipt or spinning', async () => {
  const f = fixture(['first']); let turns = 0;
  await assert.rejects(continueWorkerContext({ ...f, runTurn: async () => turns++ }), /did not consume/);
  assert.equal(turns, 1);
  assert.deepEqual(f.database.pendingSubscriptionMessages('task'), [{ id: 'first' }]);
});

test('pause or attention keeps pending context for the resumed worker', async () => {
  const f = fixture(['first']); let waiting = false;
  assert.deepEqual(await continueWorkerContext({ ...f, isWaiting: () => waiting, runTurn: async () => { waiting = true; } }), { turns: 1, waiting: true });
  assert.deepEqual(await continueWorkerContext({ ...f, isWaiting: () => true, runTurn: async () => assert.fail('unexpected turn') }), { turns: 0, waiting: true });
});

test('continuous arrivals stop at a bounded number of turns', async () => {
  const f = fixture(['0']); let turns = 0;
  await assert.rejects(continueWorkerContext({ ...f, maxTurns: 2, runTurn: async () => f.set([String(++turns)]) }), /limit exceeded/);
  assert.equal(turns, 2);
});

test('abort and turn failures propagate without retry', async () => {
  const f = fixture(['first']); const controller = new AbortController();
  controller.abort(new Error('deadline'));
  await assert.rejects(continueWorkerContext({ ...f, signal: controller.signal, runTurn: async () => assert.fail('unexpected turn') }), /deadline/);
  await assert.rejects(continueWorkerContext({ ...f, runTurn: async () => { throw new Error('provider failed'); } }), /provider failed/);
});
