import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';

async function fixture(t, receipt) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-outbox-reconcile-'));
  let db = createAssistantOrchestrationStore({ directory });
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  db.createThread({ id: 'main', source: { type: 'desktop', id: 'main' } });
  const task = db.createTask({ threadId: 'main', target: 'saved task', mandate: { source: { channel: 'desktop', sessionId: 'main' } } });
  // Only the bound execution's official ending decides the Task state.
  db.createAssignment(task.id, { id: 'work' });
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  const run = db.prepareRun(assignment.id, { ...assignment, sessionId: 'session', directory: '/task' });
  db.updateRun(run.id, { ...assignment, state: 'submitted' });
  const commit = now => db.commitResult(task.id, { assignment, uniqueKey: 'result', now,
    result: { summary: 'done', runId: run.id, sessionId: run.sessionId, instructionRevision: 1, completion: { kind: 'completed' } } });
  commit(10);
  // Compatibility fixture: the old release crossed an uncertain send boundary.
  const raw = new DatabaseSync(db.path), saved = db.results(task.id)[0];
  delete saved.notification;
  raw.prepare('UPDATE sa_results SET payload=? WHERE task_id=?').run(JSON.stringify(saved), task.id);
  const payload = { type: 'task.result', taskId: task.id, source: task.mandate.source,
    instructionRevision: 1, resultVersion: 1, outcome: 'completed', publication: { origin: 'router', action: 'deliver', text: 'Historical reply' } };
  raw.prepare("INSERT INTO sa_outbox(id,unique_key,task_id,payload,state,attempts,next_at,created_at,updated_at) VALUES (?,?,?,?,'uncertain',1,0,?,?)")
    .run('historical', 'result', task.id, JSON.stringify(payload), '2026-01-01', '2026-01-01');
  if (receipt) raw.prepare('INSERT INTO sa_delivery_receipts VALUES (?,?)').run('historical', JSON.stringify(receipt));
  raw.close();
  const delivery = db.deliveries(task.id)[0];
  return { get db() { return db; }, delivery, task, commit,
    reopen() { db.close(); db = createAssistantOrchestrationStore({ directory }); } };
}

test('unknown delivery remains parked across restart; verified sent never repeats execution', async t => {
  const f = await fixture(t);
  assert.equal(f.db.getTask(f.task.id).status, 'completed', 'execution completion never waits for delivery');
  assert.equal(f.db.deliveries(f.task.id)[0].state, 'uncertain');
  assert.deepEqual(f.db.claimOutbox('retry', { now: 100000 }), []);
  const request = { attempts: 1, outcome: 'unknown', evidence: '平台尚未返回查询结果', now: 20 };
  assert.equal(f.db.reconcileOutbox(f.delivery.id, request).state, 'uncertain');
  f.reopen();
  assert.equal(f.db.deliveries(f.task.id)[0].reconciliations[0].outcome, 'unknown');
  assert.equal(f.commit(25).duplicate, true);
  assert.equal(f.db.deliveries(f.task.id)[0].state, 'uncertain', 'an idempotent commit does not replace the delivery receipt');
  const completed = f.db.reconcileOutbox(f.delivery.id, { ...request, outcome: 'sent',
    evidence: '平台消息查询已找到原请求', receipt: { status: 'accepted', messageId: 'opaque/platform:1' }, now: 30 });
  assert.equal(completed.state, 'sent');
  assert.equal(completed.receipt.messageId, 'opaque/platform:1');
  assert.equal(f.db.getTask(f.task.id).status, 'completed');
  assert.equal(f.db.results(f.task.id).length, 1);
  assert.deepEqual(f.db.claimOutbox('retry', { now: 100000 }), []);
  assert.throws(() => f.db.reconcileOutbox(f.delivery.id, request), { code: 'OUTBOX_RECONCILIATION_CONFLICT' });
});

test('verified not_sent moves a legacy result into the current inbox once; stale receipts cannot overwrite it', async t => {
  const f = await fixture(t);
  assert.throws(() => f.db.reconcileOutbox(f.delivery.id, { attempts: 2, outcome: 'not_sent', evidence: 'checked' }), { code: 'OUTBOX_RECONCILIATION_CONFLICT' });
  assert.throws(() => f.db.reconcileOutbox(f.delivery.id, { attempts: 1, outcome: 'sent', evidence: 'checked' }), { code: 'INVALID_RECONCILIATION' });
  assert.throws(() => f.db.reconcileOutbox(f.delivery.id, { attempts: 1, outcome: 'not_sent', evidence: '' }), { code: 'INVALID_RECONCILIATION' });
  f.db.reconcileOutbox(f.delivery.id, { attempts: 1, outcome: 'not_sent', evidence: '供应商查询确认请求未发送', now: 20 });
  assert.deepEqual(f.db.claimOutbox('sender2', { now: 21 }), [], 'legacy result delivery is never resumed');
  const [notice] = f.db.pendingResultNotifications({ now: 21 });
  assert.equal(notice.uniqueKey, f.delivery.uniqueKey);
  assert.equal(notice.taskId, f.task.id);
  assert.equal(f.db.deliveries(f.task.id)[0].state, 'cancelled');
  assert.throws(() => f.db.reconcileOutbox(f.delivery.id, { attempts: 1, outcome: 'not_sent', evidence: 'stale' }), { code: 'OUTBOX_RECONCILIATION_CONFLICT' });
  f.db.finishResultNotification(notice.taskId, notice.uniqueKey, { status: 'accepted', messageId: 'router-request', now: 22 });
  f.reopen();
  assert.deepEqual(f.db.claimOutbox('sender3', { now: 100000 }), []);
  assert.deepEqual(f.db.pendingResultNotifications({ now: 100000 }), []);
  assert.equal(f.db.results(f.task.id).length, 1);
});

test('known delivered parts prohibit replay of the whole message and survive verification', async t => {
  const part = { status: 'accepted', messageId: 'part-1' };
  const f = await fixture(t, { status: 'unknown', parts: [part] });
  assert.throws(() => f.db.reconcileOutbox(f.delivery.id, { attempts: 1, outcome: 'not_sent', evidence: 'second part missing' }), { code: 'OUTBOX_RECONCILIATION_CONFLICT' });
  const saved = f.db.reconcileOutbox(f.delivery.id, { attempts: 1, outcome: 'sent', evidence: 'all parts found', receipt: { status: 'accepted', messageId: 'final' } });
  assert.deepEqual(saved.receipt.parts, [part]);
});
