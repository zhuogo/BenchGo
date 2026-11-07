import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantStore } from '../src/store.mjs';
import { createAssessmentRunner } from '../src/assessment-runner.mjs';
import { readAssessmentPolicy, authorizeAssessment } from '../src/assessment-policy.mjs';
import { ingestAssistantEvent } from '../src/intake.mjs';
import { createOrchestrationRuntime } from '../src/orchestration-runtime.mjs';
import { executionEvidence } from '../src/execution-evidence.mjs';
import { captureArtifactCheckpoint } from '../src/worker-artifact-checkpoint.mjs';

for (const failDelivery of [false, true]) test(`desktop explicit model runs without default or channel admission; local delivery failure is retryable (${failDelivery})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-desktop-runtime-'));
  const store = await createAssistantStore({ dataDirectory: directory });
  let runtime;
  t.after(async () => { await runtime?.stop(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.updateConfig({ models: failDelivery ? [{ providerId: 'different-default', modelId: 'default' }] : [] });
  const policy = await readAssessmentPolicy(store);
  const source = { channel: 'desktop', sessionId: 'owner-session', messageId: 'original', threadId: 'main' };
  const db = store.orchestration;
  db.createThread({ id: 'desktop-thread', source: { type: 'desktop', id: 'owner-session' } });
  const ticket = db.createTicket({ threadId: 'desktop-thread', target: 'desktop task', mandate: { source, actorId: 'desktop-owner', admission: 'desktop-approved-delegation', policyVersion: policy.desktopVersion, controlledActions: 'require-current-policy-and-harness-approval' } });
  const model = { providerId: 'opaque provider', modelId: 'opaque/model' };
  db.createAssignment(ticket.id, { executor: 'harness', model });
  let executions = 0, deliveries = 0;
  runtime = createOrchestrationRuntime({ ctx: {}, store,
    execute: async assignment => { executions++; assert.deepEqual(assignment.model, model); return { summary: 'done', evidenceRefs: [] }; },
    review: async input => {
      assert.deepEqual(input.model, policy.model || model, 'Configured Router reviews; explicit execution model is only the legacy fallback without a Router');
      const connection = store.connections.read();
      store.connections.update({ enabled: false }, { revision: connection.revision });
      return { verdict: 'passed', reason: 'verified', delivery: { action: 'deliver', text: 'Verified result.' } };
    },
    deliverDesktop: async delivery => {
      deliveries++;
      assert.equal(delivery.ticketId, ticket.id);
      assert.deepEqual(delivery.payload.source, source);
      assert.match(delivery.uniqueKey, /^assignment-result:/);
      if (failDelivery) throw new Error('local store unavailable');
      return { status: 'accepted', messageId: 'notification-event' };
    },
  });
  for (let i = 0; i < 100 && !deliveries; i++) { await runtime.tick(); await new Promise(resolve => setTimeout(resolve, 5)); }
  const [row] = runtime.state();
  assert.equal(row.status, 'completed');
  assert.equal(row.results.length, 1);
  assert.equal(row.deliveries[0].state, failDelivery ? 'queued' : 'sent');
  assert.equal(executions, 1);
  assert.equal(deliveries, 1);
});

async function fixture(t, { send = async () => ({ status: 'accepted', messageId: 'reply' }), execute, project, review } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-orchestration-runtime-'));
  const store = await createAssistantStore({ dataDirectory: directory });
  await store.updateConfig({ models: [{ providerId: 'provider', modelId: 'opaque/model' }] });
  store.connections.update({ enabled: true, appId: 'app', appSecretRef: 'env:SECRET', ownerOpenIds: ['owner'], chatIds: ['chat'] }, { revision: 0 });
  const workspaceRegistry = { list: () => project ? [project] : [] };
  const readPolicy = () => readAssessmentPolicy(store, workspaceRegistry);
  const policy = await readPolicy();
  const event = { channel: 'feishu', kind: 'group', text: '检查资料', sourceKey: 'event-1', threadId: 'thread', mentioned: true,
    actor: { id: 'owner', kind: 'human' }, source: { channel: 'feishu', appId: 'app', chatId: 'chat', messageId: 'message' } };
  ingestAssistantEvent(store.orchestration, event, { version: policy.version, ownerIds: ['owner'], threadIds: ['chat'] });
  const runner = createAssessmentRunner({ database: store.orchestration, readPolicy, authorize: authorizeAssessment,
    assess: async ({ candidates }) => candidates.map(row => ({ candidateId: row.candidateId, outcome: 'accept', target: '检查资料', acceptance: '提供核对证据', reason: '主人明确要求', ...(project ? { projectId: project.id } : {}) })) });
  await runner.tick();
  let executions = 0, sends = 0;
  const runtime = createOrchestrationRuntime({ ctx: { workspaceRegistry }, store,
    execute: async (assignment, context) => { executions++; return execute ? execute(store.orchestration, assignment, context) : { summary: '核对结果', evidenceRefs: [{ sessionId: 'session', eventId: 'evidence' }] }; },
    review: review || (async () => ({ verdict: 'passed', reason: '证据满足验收', delivery: { action: 'deliver', text: '资料检查已完成，核对结果已验证。' } })),
    feishu: { send: async input => { sends++; return send(input); } },
  });
  t.after(async () => { await runtime.stop(); await runner.stop(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const advance = async () => { for (let i = 0; i < 30; i++) { await runtime.tick(); if (runtime.state()[0]?.deliveries[0]?.state === 'sent' || runtime.state()[0]?.deliveries[0]?.state === 'uncertain') break; await new Promise(resolve => setTimeout(resolve, 5)); } };
  return { runtime, store, advance, counts: () => ({ executions, sends }) };
}
test('persisted Router acceptance executes once, verifies and delivers to the exact source', async t => {
  const app = await fixture(t, { send: async input => {
    assert.equal(input.source.messageId, 'message');
    assert.match(input.text, /核对结果/);
    assert.match(input.idempotencyKey, /^assignment-result:/);
    return { status: 'accepted', messageId: 'reply' };
  } });
  await app.advance();
  const [ticket] = app.runtime.state();
  assert.equal(ticket.status, 'completed');
  assert.equal(ticket.assignments[0].state, 'completed');
  assert.equal(ticket.results.length, 1);
  assert.equal(ticket.deliveries[0].state, 'sent');
  await app.advance();
  assert.deepEqual(app.counts(), { executions: 1, sends: 1 });
});
test('unknown source send retains the accepted result without blind resend or re-execution', async t => {
  const app = await fixture(t, { send: async () => { throw new Error('connection lost after submission'); } });
  await app.advance(); await app.advance();
  const [ticket] = app.runtime.state();
  assert.equal(ticket.status, 'completed');
  assert.equal(ticket.deliveries[0].state, 'uncertain');
  assert.deepEqual(app.counts(), { executions: 1, sends: 1 });
});

test('completed execution with review failure becomes visible waiting instead of uncertain', async t => {
  const app = await fixture(t, { review: async () => { throw Object.assign(new Error('private provider body'), { code: 'AUXILIARY_QUALITY' }); } });
  await app.advance(); await app.advance();
  const [ticket] = app.runtime.state();
  assert.equal(ticket.status, 'waiting');
  assert.equal(ticket.assignments[0].state, 'completed');
  assert.equal(ticket.results[0].review.retryable, true);
  assert.equal(ticket.results[0].review.diagnostic.code, 'AUXILIARY_QUALITY');
  assert.doesNotMatch(JSON.stringify(ticket.results), /private provider/);
  assert.deepEqual(app.counts(), { executions: 1, sends: 1 });
});

test('runtime reports a failed review then continues the same assignment, run and session to completion', async t => {
  let reviews = 0, original, releaseContinuation;
  const failureDelivered = new Promise(resolve => { releaseContinuation = resolve; });
  const sent = [];
  const app = await fixture(t, {
    execute: async (db, assignment) => {
      const ownership = { owner: assignment.owner, fence: assignment.fence };
      let run;
      if (assignment.reviewContinuation) {
        await failureDelivered;
        assert.equal(assignment.id, original.assignmentId);
        assert.equal(assignment.fence, original.fence + 1);
        assert.equal(assignment.reviewContinuation.runId, original.runId);
        assert.equal(assignment.reviewContinuation.sourceSessionId, original.sessionId);
        run = db.runs(assignment.id)[0];
        assert.equal(run.state, 'prepared');
        assert.equal(run.directory, original.directory);
      } else {
        const directory = join(app.store.paths.workspace, 'news-task');
        await mkdir(directory);
        run = db.prepareRun(assignment.id, { ...ownership, sessionId: 'news-session', directory });
        original = { assignmentId: assignment.id, fence: assignment.fence, runId: run.id, sessionId: run.sessionId, directory };
      }
      db.updateRun(run.id, { ...ownership, state: 'submitted' });
      const events = [{ seq: 1, type: 'turn/start', data: {} },
        { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: assignment.reviewContinuation ? '8 verified headlines' : '14 unsupported headlines' }] } } },
        { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } }];
      const result = { ...executionEvidence({ events }), runId: run.id, sessionId: run.sessionId,
        directory: run.directory, evidenceRefs: [{ sessionId: run.sessionId, runId: run.id }],
        remainingExecutionMs: 60000, checkpoint: await captureArtifactCheckpoint(run.directory) };
      db.updateRun(run.id, { ...ownership, state: 'verifying', evidence: result });
      db.confirmExecutionStopped(assignment.id, ownership);
      return result;
    },
    review: async () => ++reviews === 1
      ? { verdict: 'failed', reason: 'The draft has 14 headlines, exceeding the requested range.', instruction: 'Verify sources and condense to 8 headlines.',
        delivery: { action: 'deliver', text: '初稿有 14 条，超过要求；我会继续核对来源并精简为 8 条。' } }
      : { verdict: 'passed', reason: '8 headlines and their sources verified', delivery: { action: 'deliver', text: '已核实的 8 条新闻摘要。' } },
    send: async input => {
      sent.push(input.text);
      if (sent.length === 1) releaseContinuation();
      return { status: 'accepted', messageId: `reply-${sent.length}` };
    },
  });
  for (let index = 0; index < 100; index++) {
    await app.runtime.tick();
    const row = app.runtime.state()[0];
    if (row.status === 'completed' && row.deliveries.length === 2 && row.deliveries.every(delivery => delivery.state === 'sent')) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const [ticket] = app.runtime.state();
  assert.equal(ticket.status, 'completed');
  assert.equal(ticket.results.length, 2);
  assert.equal(ticket.assignments.length, 1);
  assert.equal(app.store.orchestration.runs(ticket.assignments[0].id).length, 1);
  assert.deepEqual(ticket.results.map(result => result.runId), [original.runId, original.runId]);
  assert.deepEqual(ticket.results.map(result => result.sessionId), [original.sessionId, original.sessionId]);
  assert.equal(ticket.results[1].checkpoint.files, 0);
  assert.deepEqual(sent, ['初稿有 14 条，超过要求；我会继续核对来源并精简为 8 条。', '已核实的 8 条新闻摘要。']);
  assert.deepEqual(app.counts(), { executions: 2, sends: 2 });
});

test('channel delivery uses reviewed text and readable options, never Worker summary', async t => {
  const app = await fixture(t, {
    execute: async () => ({ summary: 'PRIVATE_WORKER_OUTPUT', evidenceRefs: [] }),
    review: async () => ({ verdict: 'passed', reason: 'verified', userDecision: { kind: 'scope', question: '请选择下一步' }, delivery: { action: 'ask', text: '成果已备好，请选择下一步。', options: ['保存草稿', '继续修改'] } }),
    send: async input => {
      assert.match(input.text, /成果已备好/);
      assert.match(input.text, /保存草稿/);
      assert.match(input.text, /继续修改/);
      assert.doesNotMatch(input.text, /PRIVATE_WORKER_OUTPUT/);
      return { status: 'accepted', messageId: 'options-reply' };
    },
  });
  await app.advance();
  assert.equal(app.counts().sends, 1);
});

test('runtime sends pending Attention then schedules only its answered continuation and final review', async t => {
  const app = await fixture(t, { execute: async (db, assignment) => {
    const ownership = { owner: assignment.owner, fence: assignment.fence };
    const run = assignment.attentionContinuation
      ? db.runs(assignment.id)[0]
      : db.prepareRun(assignment.id, { ...ownership, sessionId: 'persisted-session', directory: 'retained-directory' });
    db.updateRun(run.id, { ...ownership, state: 'submitted' });
    let result;
    if (!assignment.attentionContinuation) {
      const [attention] = db.openAttention(assignment.id, { ...ownership, sessionId: run.sessionId, callId: 'question', questions: [{ id: 'q', question: '请提供资料' }] });
      result = { runId: run.id, sessionId: run.sessionId, summary: '', transcript: {}, checkpoint: {}, waitingAttention: { callIds: ['question'], attentionIds: [attention.id] } };
    } else result = { runId: run.id, sessionId: run.sessionId, summary: '补充后完成', evidenceRefs: [{ sessionId: run.sessionId }] };
    db.updateRun(run.id, { ...ownership, state: 'verifying', evidence: result });
    return result;
  } });
  await app.advance();
  for (let i = 0; i < 50 && app.runtime.state()[0].status !== 'waiting'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const pending = app.runtime.state()[0];
  assert.equal(pending.status, 'waiting');
  assert.equal(pending.results.length, 0);
  assert.equal(pending.assignments[0].state, 'waiting');
  await app.runtime.tick();
  assert.equal(app.counts().executions, 1);
  ingestAssistantEvent(app.store.orchestration, { channel: 'feishu', kind: 'group', text: '资料原文', sourceKey: 'attention-answer', threadId: 'answer-thread', mentioned: false,
    actor: { id: 'owner', kind: 'human' }, source: { channel: 'feishu', appId: 'app', chatId: 'chat', messageId: 'answer', parentMessageId: 'reply' } },
  { version: (await readAssessmentPolicy(app.store)).version, ownerIds: ['owner'], threadIds: ['chat'] });
  for (let i = 0; i < 50; i++) {
    await app.runtime.tick();
    if (app.runtime.state()[0].deliveries.length === 2 && app.runtime.state()[0].deliveries.every(row => row.state === 'sent')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const completed = app.runtime.state()[0];
  assert.equal(completed.status, 'completed');
  assert.equal(completed.results.length, 1);
  assert.equal(app.store.orchestration.runs(completed.assignments[0].id).length, 1);
  assert.deepEqual(app.counts(), { executions: 2, sends: 2 });
});
test('revoking channel admission before scheduling prevents execution', async t => {
  const app = await fixture(t);
  app.store.connections.update({ enabled: false }, { revision: 1 });
  await app.runtime.tick();
  assert.deepEqual(app.counts(), { executions: 0, sends: 0 });
  assert.equal(app.runtime.state()[0].assignments.length, 0);
});

for (const changed of [false, true]) test(`project results require the same artifacts before and after Router review (changed=${changed})`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-project-review-'));
  let app;
  t.after(async () => { await app?.runtime.stop(); await rm(root, { recursive: true, force: true }); });
  const source = join(root, 'source'), checkout = join(root, 'checkout');
  await mkdir(source);
  const executeGit = promisify(execFile);
  const git = async (...args) => (await executeGit('git', ['-C', source, ...args], { windowsHide: true })).stdout.trim();
  await git('init'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(source, 'output.txt'), 'original'); await git('add', '.'); await git('commit', '-m', 'base');
  const baseCommit = await git('rev-parse', 'HEAD');
  await git('worktree', 'add', '-b', 'worker', checkout);
  const environment = { path: checkout, repositoryRoot: source, branch: 'worker', baseCommit };
  let reviews = 0;
  app = await fixture(t, { project: { id: 'project', path: source },
    execute: async (db, assignment) => {
      const ownership = { owner: assignment.owner, fence: assignment.fence };
      const run = db.prepareRun(assignment.id, { ...ownership, sessionId: 'project-session', directory: checkout });
      db.setRunEnvironment(run.id, { ...ownership, environment });
      db.updateRun(run.id, { ...ownership, state: 'submitted' });
      const result = { runId: run.id, sessionId: run.sessionId, directory: checkout, environment, summary: '完成产物', evidenceRefs: [{ sessionId: run.sessionId }], checkpoint: await captureArtifactCheckpoint(environment) };
      db.updateRun(run.id, { ...ownership, state: 'verifying', evidence: result });
      return result;
    },
    review: async () => { reviews++; if (changed) await writeFile(join(checkout, 'output.txt'), 'modified during review'); return { verdict: 'passed', reason: 'model passed', delivery: { action: 'deliver', text: '产物已经核对。' } }; },
  });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await app.runtime.tick();
    const row = app.runtime.state()[0];
    if (row.status === 'completed' || row.assignments[0]?.state === 'uncertain') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const row = app.runtime.state()[0];
  assert.equal(reviews, 1);
  assert.equal(row.results.length, changed ? 0 : 1);
  assert.equal(row.assignments[0].state, changed ? 'uncertain' : 'completed');
  assert.equal(row.status, changed ? 'open' : 'completed');
  if (changed) {
    assert.equal(row.deliveries.length, 1);
    const { payload } = row.deliveries[0];
    assert.equal(payload.publication.origin, 'system');
    assert.deepEqual(payload.publication.systemState, { state: 'review_wait', code: 'UNAVAILABLE', stage: 'review' });
    assert.equal(payload.resultVersion, 0);
    assert.equal(payload.text, payload.publication.text);
    assert.doesNotMatch(payload.text, /产物已经核对|完成产物|model passed/);
    assert.equal(payload.result, undefined);
    const [run] = app.store.orchestration.runs(row.assignments[0].id);
    assert.equal(run.evidence.summary, '完成产物');
    assert.equal(run.evidence.sessionId, 'project-session');
    assert.ok(run.evidence.checkpoint.manifestHash);
    assert.equal(run.evidence.environment.path, checkout);
  }
});

test('runtime recovers a saved pause without executing or reviewing it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-pause-recovery-'));
  const store = await createAssistantStore({ dataDirectory: directory });
  let runtime;
  t.after(async () => { await runtime?.stop(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const db = store.orchestration;
  db.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = db.createTicket({ threadId: 'thread', target: 'work', mandate: {} });
  db.createAssignment(ticket.id, {});
  const [assignment] = db.claimAssignments('old-worker', { now: 0, leaseMs: 100, validateMandate: () => true });
  const identity = { owner: assignment.owner, fence: assignment.fence };
  const workspace = join(directory, 'paused-files'); await mkdir(workspace);
  const run = db.prepareRun(assignment.id, { ...identity, now: 1, sessionId: 'saved-session', directory: workspace });
  db.updateRun(run.id, { ...identity, now: 2, state: 'submitted' });
  const events = [{ seq: 1, type: 'turn/start', data: {} }, { seq: 2, type: 'turn/end', data: { reason: { kind: 'blocked' } } }];
  const result = { ...executionEvidence({ events }), runId: run.id, sessionId: run.sessionId, directory: workspace, waitingPause: true, remainingExecutionMs: 1000, checkpoint: await captureArtifactCheckpoint(workspace) };
  db.updateRun(run.id, { ...identity, now: 3, state: 'verifying', evidence: result });
  db.pauseTicket(ticket.id);
  let locked = false, reads = 0;
  const ctx = { agents: { get: () => null }, sessionPersistence: { open: async (id, access) => {
    assert.equal(locked, false); locked = true;
    return { id, access, read: async () => { reads++; return { events }; }, close: async () => { locked = false; } };
  } } };
  runtime = createOrchestrationRuntime({ ctx, store, execute: async () => assert.fail('recovery must not execute'), review: async () => assert.fail('pause is not a result') });
  for (let i = 0; i < 100 && db.getTicket(ticket.id).status !== 'paused'; i++) { await runtime.tick(); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(db.getTicket(ticket.id).status, 'paused');
  await runtime.stop();
  assert.equal(locked, false);
  assert.equal(reads, 1);
  assert.equal(db.runs(assignment.id).length, 1);
  assert.equal(db.results(ticket.id).length, 0);
});

test('runtime state projects actual database runs through preparing, executing and verifying', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-progress-runtime-'));
  const store = await createAssistantStore({ dataDirectory: directory });
  let runtime;
  t.after(async () => { await runtime?.stop(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const db = store.orchestration;
  db.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = db.createTicket({ threadId: 'thread', target: 'inspect progress', mandate: {} });
  const queued = db.createAssignment(ticket.id, {});
  const [assignment] = db.claimAssignments('progress-worker', { assignmentId: queued.id, leaseMs: 60000, validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = db.prepareRun(assignment.id, { ...ownership, sessionId: 'progress-session', directory });
  runtime = createOrchestrationRuntime({ ctx: {}, store,
    execute: async () => assert.fail('projection must not execute'), review: async () => assert.fail('projection must not review') });
  const read = () => runtime.state().find(row => row.id === ticket.id);
  let row = read();
  assert.equal(row.execution.assignmentId, assignment.id);
  assert.equal(row.execution.runId, run.id);
  assert.equal(row.execution.sessionId, run.sessionId);
  assert.equal(row.execution.instructionRevision, row.instructionRevision);
  assert.equal(row.assignments[0].fence, run.fence);
  assert.equal(row.execution.phase, 'preparing');
  db.updateRun(run.id, { ...ownership, state: 'submitted' });
  row = read();
  assert.equal(row.execution.phase, 'executing');
  assert.equal(row.execution.worker.status, 'unknown', 'database submission without observed host activity is not live success');
  db.updateRun(run.id, { ...ownership, state: 'verifying', evidence: { runId: run.id, sessionId: run.sessionId, summary: 'PRIVATE EVIDENCE' } });
  row = read();
  assert.equal(row.execution.phase, 'verifying');
  assert.equal(row.execution.worker.status, 'waiting');
  assert.equal(row.execution.worker.activity, '执行结果正在核验');
  assert.doesNotMatch(JSON.stringify(row.execution), /PRIVATE EVIDENCE/);
  assert.equal(db.getTicket(ticket.id).status, 'open', 'observing execution leaves the business lifecycle untouched');
});
