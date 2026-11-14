import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { deliverySuppression } from '../src/result-delivery.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'router-action-store-'));
  const db = createAssistantOrchestrationStore({ directory });
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const sessionId = 'root-session', messageId = 'human-message', callId = 'tool-call-1', owner = 'router-owner';
  const source = { channel: 'desktop', sessionId, messageId, threadId: 'main' };
  const instruction = '请将助手名称改为 Delta';
  const { trigger } = db.ingest({ dedupeKey: 'router-action-trigger', thread: { id: 'desktop:root-session', source: { type: 'desktop', id: sessionId } }, source,
    actor: { kind: 'human', id: 'desktop-owner' }, content: instruction, mode: 'direct' });
  const argsHash = hash({ name: 'Delta' });
  const mandate = { actorId: 'desktop-owner', source, instruction, policyVersion: 'policy-v1', admission: 'desktop-model-action', controlledActions: 'model-persistent-action', action: { toolName: 'assistant_config', callId, argsHash, threadId: 'main' } };
  const input = { sessionId, messageId, callId, toolName: 'assistant_config', argsHash, triggerId: trigger.id, mandate,
    target: 'Update assistant config', acceptance: 'Persist and verify config revision', owner, leaseMs: 60000,
    validateMandate: value => value.policyVersion === 'policy-v1' };
  return { db, input, sessionId, callId, owner };
}

test('reserve atomically creates one claimed router-only Assignment and prepared Run', async t => {
  const f = await fixture(t), now = Date.now();
  const reserved = f.db.reserveRouterAction({ ...f.input, now });
  assert.equal(reserved.duplicate, false);
  assert.equal(reserved.task.status, 'running');
  assert.equal(reserved.assignment.state, 'claimed');
  assert.equal(reserved.assignment.owner, f.owner);
  assert.equal(reserved.assignment.fence, 1);
  assert.equal(reserved.assignment.executor, 'router-action');
  assert.equal(reserved.run.state, 'prepared');
  assert.equal(reserved.run.sessionId, f.sessionId);
  assert.equal(reserved.run.routerAction.callId, f.callId);
  assert.equal(Object.hasOwn(reserved.assignment, 'args'), false);
  assert.equal(Object.hasOwn(reserved.run.routerAction, 'args'), false);
  assert.equal(f.db.claimAssignments('worker', { validateMandate: () => true, assignmentId: reserved.assignment.id }).length, 0);
  assert.deepEqual(f.db.reserveRouterAction({ ...f.input, now }), { ...reserved, duplicate: true });
  assert.throws(() => f.db.reserveRouterAction({ ...f.input, argsHash: hash({ name: 'Other' }), now }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('verified receipt and authoritative readback settle Run, Result and Outbox atomically and idempotently', async t => {
  const f = await fixture(t), now = Date.now();
  const reserved = f.db.reserveRouterAction({ ...f.input, now });
  const receipt = { configRevision: 8, requestId: 'call-1' }, readback = { configRevision: 8, name: 'Delta' };
  const settled = f.db.settleRouterAction({ sessionId: f.sessionId, callId: f.callId, owner: f.owner, fence: 1, argsHash: f.input.argsHash,
    receipt, readback, verified: true, summary: '设置已更新并核实', now: now + 1, validateMandate: f.input.validateMandate });
  assert.equal(settled.state, 'completed');
  assert.deepEqual(settled.receipt, receipt);
  assert.deepEqual(settled.readback, readback);
  assert.equal(settled.task.status, 'completed');
  assert.equal(settled.run.state, 'completed');
  assert.equal(f.db.results(reserved.task.id)[0].readback.name, 'Delta');
  assert.equal(f.db.deliveries(reserved.task.id)[0].state, 'queued');
  const replay = f.db.settleRouterAction({ sessionId: f.sessionId, callId: f.callId, owner: f.owner, fence: 1, argsHash: f.input.argsHash,
    receipt, readback, verified: true, now: now + 2, validateMandate: f.input.validateMandate });
  assert.equal(replay.duplicate, true);
  assert.equal(f.db.results(reserved.task.id).length, 1);
  assert.equal(f.db.deliveries(reserved.task.id).length, 1);
  const outgoing = f.db.deliveries(reserved.task.id)[0];
  assert.equal(outgoing.payload.replyState, 'suppressed');
  assert.equal(outgoing.payload.outcome, undefined, 'synchronous Router action is not a Worker completion');
  assert.equal(outgoing.payload.publication, undefined);
  assert.equal(outgoing.payload.text, undefined);
  assert.equal(outgoing.payload.instructionRevision, reserved.task.instructionRevision);
  assert.equal(outgoing.payload.resultVersion, 1);
  const [claimed] = f.db.claimOutbox('sender', { now: now + 3 });
  assert.equal(deliverySuppression(f.db, claimed), 'router-action-already-replied');
  const deliveryReceipt = { status: 'suppressed', reason: 'router-action-already-replied' };
  f.db.finishOutbox(claimed.id, { owner: 'sender', sent: true, receipt: deliveryReceipt, now: now + 4 });
  assert.deepEqual(f.db.deliveries(reserved.task.id)[0].receipt, deliveryReceipt);
  assert.throws(() => f.db.settleRouterAction({ sessionId: f.sessionId, callId: f.callId, owner: f.owner, fence: 1, argsHash: f.input.argsHash,
    receipt: { configRevision: 9 }, readback, verified: true, now: now + 2, validateMandate: f.input.validateMandate }), { code: 'ROUTER_ACTION_RECEIPT_CONFLICT' });
});

test('expired or unknown Router action is uncertain and can never be claimed or replayed', async t => {
  const f = await fixture(t), now = Date.now();
  const reserved = f.db.reserveRouterAction({ ...f.input, now, leaseMs: 1000 });
  assert.equal(f.db.claimAssignments('worker', { now: now + 1001, validateMandate: () => true }).length, 0);
  assert.equal(f.db.getAssignment(reserved.assignment.id).state, 'uncertain');
  assert.equal(f.db.runs(reserved.assignment.id)[0].state, 'uncertain');
  const duplicate = f.db.reserveRouterAction({ ...f.input, now: now + 1002 });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.assignment.state, 'uncertain');
  f.db.settleRouterAction({ sessionId: f.sessionId, callId: f.callId, owner: 'attacker', fence: 1, argsHash: f.input.argsHash,
    receipt: { poison: true }, readback: {}, verified: false, uncertain: true, now: now + 1003 });
  assert.equal(f.db.getRouterAction(f.sessionId, f.callId).receipt, null);
  const settled = f.db.settleRouterAction({ sessionId: f.sessionId, callId: f.callId, owner: f.owner, fence: 1, argsHash: f.input.argsHash,
    receipt: {}, readback: {}, verified: true, now: now + 1003, validateMandate: f.input.validateMandate });
  assert.equal(settled.state, 'uncertain');
  assert.equal(f.db.results(reserved.task.id).length, 0);
});

test('policy revocation at settle preserves observed receipt but refuses false completion', async t => {
  const f = await fixture(t), now = Date.now();
  const reserved = f.db.reserveRouterAction({ ...f.input, now });
  const result = f.db.settleRouterAction({ sessionId: f.sessionId, callId: f.callId, owner: f.owner, fence: 1, argsHash: f.input.argsHash,
    receipt: { revision: 2 }, readback: { revision: 2 }, verified: true, now: now + 1, validateMandate: () => false });
  assert.equal(result.state, 'uncertain');
  assert.deepEqual(f.db.getRouterAction(f.sessionId, f.callId).receipt, { revision: 2 });
  assert.equal(f.db.getTask(reserved.task.id).status, 'waiting');
  assert.equal(f.db.results(reserved.task.id).length, 0);
  assert.equal(f.db.deliveries(reserved.task.id).length, 0);
});
