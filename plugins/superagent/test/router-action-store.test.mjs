import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';

const sessionId = 'root-session', messageId = 'human-message', callId = 'tool-call-1', owner = 'router-owner';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'router-action-store-'));
  const filename = join(directory, 'assistant.db');
  let db = createAssistantOrchestrationStore({ filename });
  t.after(async () => { db?.close(); await rm(directory, { recursive: true, force: true }); });
  const source = { channel: 'desktop', sessionId, messageId, threadId: 'main' };
  const instruction = 'Generate a dog picture.';
  const { trigger } = db.ingest({ dedupeKey: 'router-action-trigger', thread: { id: 'desktop:root-session', source: { type: 'desktop', id: sessionId } }, source,
    actor: { kind: 'human', id: 'desktop-owner' }, content: instruction, mode: 'direct' });
  const argsHash = hash({ prompt: 'dog' });
  const action = { toolName: 'generate_image', callId, argsHash, threadId: 'main' };
  const mandate = { actorId: 'desktop-owner', source, instruction, policyVersion: 'policy-v1', admission: 'desktop-model-action', controlledActions: 'model-persistent-action', action };
  const input = { sessionId, messageId, callId, ...action, triggerId: trigger.id, mandate, owner, leaseMs: 60000,
    validateMandate: value => value.policyVersion === 'policy-v1' };
  return { get db() { return db; }, input, filename, threadId: trigger.threadId,
    reopen(before) { db.close(); db = null; before?.(); db = createAssistantOrchestrationStore({ filename }); } };
}

test('Router action reserves a call without creating a task or assignment', async t => {
  const f = await fixture(t), now = Date.now();
  const reserved = f.db.reserveRouterAction({ ...f.input, now });
  assert.equal(reserved.duplicate, false);
  assert.equal(reserved.state, 'reserved');
  assert.equal(reserved.action.sessionId, sessionId);
  assert.equal(reserved.action.callId, callId);
  assert.equal(reserved.action.messageId, messageId);
  assert.deepEqual(f.db.listTasks(), []);
  assert.deepEqual(f.db.claimAssignments('worker', { validateMandate: () => true }), []);
  assert.deepEqual(f.db.reserveRouterAction({ ...f.input, now }), { ...reserved, duplicate: true });
  assert.throws(() => f.db.reserveRouterAction({ ...f.input, argsHash: hash({ prompt: 'cat' }), now }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('verified receipt survives reopen without enqueuing a Worker result notification', async t => {
  const f = await fixture(t), now = Date.now();
  f.db.reserveRouterAction({ ...f.input, now });
  const receipt = { value: { filename: 'dog.png' } }, readback = { filename: 'dog.png' };
  const input = { ...f.input, receipt, readback, verified: true, now: now + 1 };
  const settled = f.db.settleRouterAction(input);
  assert.equal(settled.state, 'completed');
  f.reopen();
  assert.deepEqual(f.db.getRouterAction(sessionId, callId).receipt, receipt);
  assert.deepEqual(f.db.getRouterAction(sessionId, callId).readback, readback);
  assert.equal(f.db.settleRouterAction(input).duplicate, true);
  assert.deepEqual(f.db.pendingResultNotifications(), []);
  assert.throws(() => f.db.settleRouterAction({ ...input, receipt: {} }), { code: 'ROUTER_ACTION_RECEIPT_CONFLICT' });
});

test('expired Router action can never be claimed or replayed', async t => {
  const f = await fixture(t), now = Date.now();
  f.db.reserveRouterAction({ ...f.input, now, leaseMs: 1000 });
  assert.throws(() => f.db.settleRouterAction({ ...f.input, owner: 'other', now: now + 1, receipt: { poison: true } }), { code: 'FENCING_CONFLICT' });
  const duplicate = f.db.reserveRouterAction({ ...f.input, now: now + 1002 });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.state, 'uncertain');
  const settled = f.db.settleRouterAction({ ...f.input, now: now + 1003, receipt: {}, readback: {}, verified: true });
  assert.equal(settled.state, 'uncertain');
  assert.equal(settled.receipt, null);
});

test('policy revocation at settle preserves observed receipt but refuses false completion', async t => {
  const f = await fixture(t), now = Date.now();
  f.db.reserveRouterAction({ ...f.input, now });
  const receipt = { value: { revision: 2 } };
  const result = f.db.settleRouterAction({ ...f.input, receipt, readback: {}, verified: true, now: now + 1, validateMandate: () => false });
  assert.equal(result.state, 'uncertain');
  assert.deepEqual(f.db.getRouterAction(sessionId, callId).receipt, receipt);
  assert.deepEqual(f.db.listTasks(), []);
});

test('legacy Router task is deleted while its receipt, source and nearby Worker task survive', async t => {
  const f = await fixture(t);
  const task = f.db.createTask({ threadId: f.threadId, target: 'Model action: generate_image', mandate: f.input.mandate,
    sourceTriggerIds: [f.input.triggerId] });
  const worker = f.db.createTask({ threadId: f.threadId, target: 'Worker task', mandate: {} });
  const { id: assignmentId } = f.db.createAssignment(task.id, { executor: 'router-action' });
  const actionKey = JSON.stringify([sessionId, callId]);
  const now = new Date().toISOString();
  const receipt = { error: { code: 'MEDIA_SUBMISSION_UNCERTAIN', message: 'Unknown' } };
  f.reopen(() => {
    const legacy = new DatabaseSync(f.filename);
    try {
      legacy.exec(`CREATE TABLE sa_router_actions(
        action_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE REFERENCES sa_tasks(id),
        assignment_id TEXT NOT NULL UNIQUE REFERENCES sa_assignments(id), run_id TEXT NOT NULL UNIQUE REFERENCES sa_runs(id),
        session_id TEXT NOT NULL, call_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(session_id,call_id));`);
      legacy.prepare("UPDATE sa_assignments SET state='uncertain' WHERE id=?").run(assignmentId);
      legacy.prepare('INSERT INTO sa_runs VALUES (?,?,?,?,?,?,?,?)').run('legacy-run', assignmentId, 1, owner, 'uncertain',
        JSON.stringify({ sessionId, routerAction: { ...f.input.mandate.action, sessionId, messageId, triggerId: f.input.triggerId },
          evidence: { receipt, readback: { verified: false } } }), now, now);
      legacy.prepare('INSERT INTO sa_router_actions VALUES (?,?,?,?,?,?,?,?)')
        .run(actionKey, 'legacy-fingerprint', task.id, assignmentId, 'legacy-run', sessionId, callId, now);
    } finally { legacy.close(); }
  });
  assert.equal(f.db.getTask(task.id), undefined);
  assert.equal(f.db.getAssignment(assignmentId), undefined);
  assert.equal(f.db.getTask(worker.id).target, 'Worker task');
  assert.equal(f.db.getTrigger(f.input.triggerId).source.messageId, messageId);
  const saved = f.db.getRouterAction(sessionId, callId);
  assert.equal(saved.state, 'uncertain');
  assert.equal(saved.actionKey, actionKey);
  assert.deepEqual(saved.receipt, receipt);
  f.reopen();
  assert.deepEqual(f.db.reserveRouterAction(f.input), { ...saved, duplicate: true });
});
