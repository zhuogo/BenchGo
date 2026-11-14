import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resultOutbox, validateDelivery, deliverySuppression, systemStateDelivery } from '../src/result-delivery.mjs';
import { commitWorkerResult } from '../src/result-commit.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';

const task = { id: 't', title: '原任务', target: '完整要求', instructionRevision: 2, resultVersion: 0, mandate: { source: { channel: 'desktop', sessionId: 'owner' } } };
const result = { summary: '  原正文\n\n保留段落与结尾。\n', outcome: 'completed', evidenceRefs: [] };

test('only synchronous Router action audits use a suppressed result outbox', () => {
  const delivery = systemStateDelivery({ state: 'action_verified', code: 'ACTION_VERIFIED', stage: 'action' });
  const audit = resultOutbox({ task, result, delivery });
  assert.equal(audit.replyState, 'suppressed');
  assert.equal(audit.suppressionReason, 'router-action-already-replied');
  assert.throws(() => resultOutbox({ task, result }));
  assert.equal(validateDelivery({ action: 'deliver', text: 'x'.repeat(20000) }).text.length, 20000);
});

test('superseded requirements and sources are suppressed rather than delivered', () => {
  const row = { taskId: 't', payload: { type: 'task.result', taskId: 't', source: task.mandate.source, instructionRevision: 2, resultVersion: 1 } };
  const database = { getTask: () => ({ ...task, resultVersion: 1 }) };
  assert.equal(deliverySuppression(database, row), null);
  assert.equal(deliverySuppression({ getTask: () => ({ ...task, resultVersion: 1, instructionRevision: 3 }) }, row), 'superseded-instruction');
  assert.equal(deliverySuppression(database, { ...row, payload: { ...row.payload, source: { channel: 'other' } } }), 'source-mismatch');
});

async function storedResult(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-router-result-'));
  let database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.createThread({ id: 'main', source: { type: 'desktop', id: 'owner' } });
  const current = database.createTask({ threadId: 'main', target: 'original request', mandate: task.mandate });
  // Only the bound, normally completed execution is the current result.
  database.createAssignment(current.id, { id: 'work' });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  const run = database.prepareRun(assignment.id, { ...assignment, sessionId: 'session', directory: '/task' });
  database.updateRun(run.id, { ...assignment, state: 'submitted' });
  const draft = { ...result, instructionRevision: 1, runId: run.id, sessionId: run.sessionId, completion: { kind: 'completed' } };
  const committed = commitWorkerResult({ database, task: current, assignment, result: draft, uniqueKey: 'worker-result' });
  return { get database() { return database; }, task: current, committed,
    reopen() { database.close(); database = createAssistantOrchestrationStore({ directory }); } };
}

test('result notification survives restart with stable source and version identity', async t => {
  const f = await storedResult(t);
  const [notice] = f.database.pendingResultNotifications();
  assert.equal(f.committed.outbox, null);
  assert.deepEqual(f.database.deliveries(f.task.id), []);
  assert.equal(notice.uniqueKey, 'worker-result');
  f.reopen();
  assert.deepEqual(f.database.resultNotification(f.task.id, notice.uniqueKey), notice);
  f.database.finishResultNotification(f.task.id, notice.uniqueKey, { status: 'accepted', messageId: 'inbox' });
  assert.deepEqual(f.database.pendingResultNotifications(), []);
  assert.equal(f.database.results(f.task.id)[0].reply, undefined);
  f.reopen();
  assert.deepEqual(f.database.pendingResultNotifications(), []);
  assert.equal(f.database.getTask(f.task.id).status, 'completed');
});

test('public Router reply confirms delivery separately and is idempotent', async t => {
  const f = await storedResult(t);
  const [notice] = f.database.pendingResultNotifications();
  const signal = { ...notice.payload, kind: 'result', eventKey: notice.uniqueKey };
  const input = { signal, sessionId: 'router', requestId: 'reply-request', messages: [{ id: 'public', text: 'Done.' }] };
  f.database.confirmResultReply(input); f.database.confirmResultReply(input);
  assert.deepEqual(f.database.results(f.task.id)[0].reply.messageIds, ['public']);
  assert.throws(() => f.database.confirmResultReply({ ...input, messages: [{ id: 'other', text: 'changed' }] }), /identity changed/);
  assert.equal(f.database.results(f.task.id).length, 1);
});

test('interrupted execution asks for user continuation without promising effect verification', () => {
  for (const code of ['EXECUTION_UNAVAILABLE', 'EXECUTION_EFFECTS_UNKNOWN']) {
    const delivery = systemStateDelivery({ state: 'continuation_wait', code });
    assert.match(delivery.text, /执行已中断，尚未完成/);
    assert.match(delivery.text, /等待用户续接/);
    assert.doesNotMatch(delivery.text, /效果待核实|自动恢复|自动核查/);
    assert.equal(validateDelivery(delivery).systemState.code, code);
  }
});
