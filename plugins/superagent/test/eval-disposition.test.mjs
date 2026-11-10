import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createEvaluationDisposition } from '../src/eval-disposition.mjs';

test('retry uses candidate thread policy and rejects legacy or revoked source scope', async () => {
  const source = { channel: 'telegram', connectionId: 'telegram', sourceType: 'direct', chatId: 'chat', conversationId: 'chat', connectionRevision: 2 };
  let candidate = { threadId: 'candidate-thread', intakeEvent: { source, actor: { kind: 'human', id: 'owner' } } };
  let config = { enabled: true, ownerIds: ['owner'], chatIds: ['chat'] }, writes = 0;
  const service = createEvaluationDisposition({ database: {
    getEvaluation: () => candidate,
    readIntakeEvent: () => candidate.intakeEvent,
    disposeUnavailableEvaluation: () => { writes++; return { status: 'queued' }; },
  }, readPolicy: async threadId => {
    assert.equal(threadId, 'candidate-thread');
    return { version: 'current', model: {}, connections: { telegram: { channel: 'telegram', revision: 2, config } } };
  } });
  const dispose = () => service.dispose({ candidateId: 'candidate', action: 'retry' }, { kind: 'human' });
  await dispose();
  assert.equal(writes, 1);
  for (const change of [{ sourceType: undefined }, { conversationId: 'other' }, { connectionId: 'other' }, { connectionRevision: 1 }]) {
    candidate = { ...candidate, intakeEvent: { ...candidate.intakeEvent, source: { ...source, ...change } } };
    await assert.rejects(dispose(), /过期|撤销/);
  }
  candidate = { ...candidate, intakeEvent: { ...candidate.intakeEvent, source } };
  config = { ...config, enabled: false };
  await assert.rejects(dispose(), /过期|撤销/);
  assert.equal(writes, 1);
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-eval-disposition-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const created = database.ingest({ dedupeKey: 'source', thread: { id: 'thread', source: { type: 'feishu', id: 'chat' } },
    source: { eventId: 'source', channel: 'feishu', sourceType: 'direct', chatId: 'chat', conversationId: 'chat', connectionId: 'feishu' }, actor: { id: 'owner' }, content: '原文', gate: { allowed: true, strength: 'explicit' }, policyVersion: 'p1' });
  const leases = [];
  for (let index = 0; index < 3; index++) {
    leases.push(database.claimEval('thread', { owner: 'old', policyVersion: 'p1', now: index * 20, timeoutMs: 10 }));
    database.requeueExpiredEvals(index * 20 + 11);
  }
  const candidate = database.unavailableEvaluations().candidates[0];
  return { database, candidate, leases, input: { candidateId: candidate.id, expectedRevision: candidate.dispositionRevision, expectedUpdatedAt: candidate.updatedAt }, created };
}

test('human retry preserves original trigger, audits current policy and fences stale model responses', async t => {
  const { database, candidate, input, leases } = await fixture(t);
  let wakes = 0;
  const service = createEvaluationDisposition({ database, readPolicy: async () => ({ version: 'p2', model: {}, connection: { enabled: true } }), wake: () => wakes++ });
  await assert.rejects(service.dispose({ ...input, action: 'retry', human: true }, { kind: 'model' }), /仅供已认证用户/);
  const result = await service.dispose({ ...input, action: 'retry' }, { kind: 'human', actorId: 'owner' });
  assert.equal(result.status, 'queued'); assert.equal(result.retryCount, 0); assert.equal(result.policyVersion, 'p2');
  assert.equal(result.intakeEvent.content, '原文'); assert.equal(wakes, 1);
  assert.equal(database.evaluationDispositionHistory(candidate.id)[0].actor, 'owner');
  assert.throws(() => database.decide(candidate.id, { evalId: leases[2].id, owner: 'old', policyVersion: 'p1', outcome: 'ignore', assessment: {} }), { code: 'CANDIDATE_NOT_ACTIVE' });
  await assert.rejects(service.dispose({ ...input, action: 'ignore' }, { kind: 'human' }), { code: 'REVISION_CONFLICT' });
  const lease = database.claimEval('thread', { owner: 'new', policyVersion: 'p2', now: 100, timeoutMs: 10 });
  assert.equal(lease.attempt, 1);
  assert.throws(() => database.decide(candidate.id, { evalId: leases[2].id, owner: 'old', policyVersion: 'p2', outcome: 'ignore', assessment: {}, now: 101 }), { code: 'EVAL_FENCING_CONFLICT' });
});

test('human ignore is durable and cannot be retried into a second decision', async t => {
  const { database, candidate, input } = await fixture(t);
  const service = createEvaluationDisposition({ database, readPolicy: async () => ({ version: 'p2' }) });
  await assert.rejects(service.dispose({ ...input, action: 'retry' }, { kind: 'human' }), /配置 Router/);
  await service.dispose({ ...input, action: 'ignore', reason: '无需跟进' }, { kind: 'human' });
  assert.equal(database.getDecision(candidate.id).outcome, 'ignore');
  assert.equal(database.getDecision(candidate.id).assessment.reason, '无需跟进');
  assert.deepEqual(database.unavailableEvaluations().candidates, []);
  const adjustmented = createAssistantOrchestrationStore({ filename: database.path });
  try {
    assert.equal(adjustmented.getDecision(candidate.id).assessment.source, 'human-disposition');
    assert.equal(adjustmented.evaluationDispositionHistory(candidate.id).length, 1);
    assert.equal(adjustmented.claimEval('thread', { owner: 'next', policyVersion: 'p2' }), null);
  } finally { adjustmented.close(); }
});

test('stale retry cannot act again after the next timeout cycle', async t => {
  const { database, input } = await fixture(t);
  const service = createEvaluationDisposition({ database, readPolicy: async () => ({ version: 'p1', model: {}, connection: { enabled: true } }) });
  await service.dispose({ ...input, action: 'retry' }, { kind: 'human' });
  for (let i = 0; i < 3; i++) {
    database.claimEval('thread', { owner: 'new', policyVersion: 'p1', now: 200 + i * 20, timeoutMs: 10 });
    database.requeueExpiredEvals(211 + i * 20);
  }
  const latest = database.unavailableEvaluations().candidates[0];
  assert.ok(latest.dispositionRevision > input.expectedRevision);
  await assert.rejects(service.dispose({ ...input, expectedUpdatedAt: latest.updatedAt, action: 'ignore' }, { kind: 'human' }), { code: 'REVISION_CONFLICT' });
});
