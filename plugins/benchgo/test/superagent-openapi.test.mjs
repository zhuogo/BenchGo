import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createWorkerCheckpointStore } from '../../superagent/src/worker-checkpoint-store.mjs';
import { mountVault } from '../src/vault.mjs';
import { createAssistantOrchestrationStore } from '../../superagent/src/orchestration-store.mjs';
import { createEvaluationDisposition } from '../../superagent/src/eval-disposition.mjs';
import { createAssistantRuntimeStore } from '../../superagent/src/runtime-store.mjs';
import { createAssistantStore, validateAssistantModels, validateAssistantAuxiliary } from '../../superagent/src/store.mjs';
import { roleModels, auxiliaryModels } from '../../superagent/src/routing.mjs';
import { scheduleLifecyclePublication } from '../../superagent/src/schedule-lifecycle.mjs';
import { systemStateDelivery } from '../../superagent/src/result-delivery.mjs';

const hostRequire = createRequire(new URL('../../../deepseek-harness/packages/boot/app-boot/package.json', import.meta.url));
const { default: Ajv } = hostRequire('ajv/dist/2020.js');
const document = JSON.parse(await readFile(new URL('../openapi.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema({ $id: 'benchgo-contract', components: document.components });
const compile = schema => ajv.compile({ ...schema, components: document.components });
const request = compile({ $ref: '#/components/schemas/AssistantRequest' });
const vaultRequest = compile({ $ref: '#/components/schemas/VaultRequest' });
const response = (path, action) => compile(document.paths[path].post.responses['200']['x-action-schemas'][action]);
const valid = (validator, value) => assert.equal(validator(value), true, JSON.stringify(validator.errors));
const hash = 'a'.repeat(64);
const path = '/api/commander/assistant';

test('P0 inbox reconciliation and quota-free continuation keep the public contract', () => {
  valid(request, { action: 'requestState', threadId: 'side' });
  valid(response(path, 'requestState'), [{ requestId: 'r', status: 'processing' }]);
  valid(request, { action: 'ticketPause', ticketId: 't' });
  valid(request, { action: 'ticketResume', ticketId: 't', expectedResultVersion: 0 });
  assert.equal(request({ action: 'ticketResume', ticketId: 't', expectedResultVersion: -1 }), false);
  // Budget gates were removed on 2026-11-06: no added-time field or Goal quota actions remain in the contract.
  assert.doesNotMatch(JSON.stringify(document), /additionalExecutionMs|goalBudgetUpdate|goalBudgetResume/);
  valid(response(path, 'ticketResume'), { queued: false, code: 'EXECUTION_EFFECTS_UNKNOWN' });
  assert.equal(request({ action: 'ticketRetryReview', ticketId: 't' }), false);
  assert.equal(document.paths[path].post.responses['200']['x-action-schemas'].ticketRetryReview, undefined);
});

test('history exposes only optional structured active reply identity', () => {
  const validate = response(path, 'history');
  valid(validate, { activeReply: null, messages: [] });
  valid(validate, { activeReply: { requestId: 'u', turn: 2 }, messages: [] });
  assert.equal(validate({ activeReply: { requestId: 'u' } }), false);
  assert.equal(validate({ activeReply: { requestId: 'u', turn: 2, reasoning: 'private' } }), false);
});

test('memory writes are immediate and keep revision and legacy compatibility contracts', () => {
  valid(request, { action: 'memorySave', memory: { content: '偏好简洁中文' } });
  valid(request, { action: 'memorySave', revision: 2, memory: { id: 'saved', content: '偏好完整说明' } });
  valid(request, { action: 'memoryDelete', id: 'saved', revision: 3 });
  for (const input of [{ action: 'memorySave' }, { action: 'memorySave', memory: {} }, { action: 'memoryDelete' }, { action: 'memoryForget', id: '' }]) assert.equal(request(input), false);
  const entry = { id: 'saved', content: '偏好简洁中文', source: { kind: 'user' }, revision: 1, document: 'MEMORY.md' };
  valid(response(path, 'memorySave'), entry);
  valid(response(path, 'memorySearch'), { memories: [entry] });
  valid(response(path, 'memoryDelete'), { removed: true });
  assert.equal(response(path, 'memorySave')({ ...entry, revision: 0 }), false);
  for (const action of ['memoryCandidates', 'memoryCandidateAccept', 'memoryCandidateReject']) {
    assert.equal(document.paths[path].post.responses['200']['x-action-schemas'][action].deprecated, true);
    valid(request, { action, id: 'legacy' });
  }
});

test('notification options require a source-bound event and return ordinary send receipt', () => {
  valid(request, { action: 'notificationOption', eventId: 'event', threadId: 'side', text: '就这么办' });
  for (const field of ['eventId', 'threadId', 'text']) {
    const input = { action: 'notificationOption', eventId: 'event', threadId: 'side', text: '就这么办' };
    delete input[field]; assert.equal(request(input), false);
  }
  valid(response(path, 'notificationOption'), { threadId: 'side', sessionId: 'session', messageId: 'message', duplicate: true });
});

test('OpenAPI descriptions retain UTF-8 and channel actions require scoped writes', () => {
  assert.doesNotMatch(JSON.stringify(document), /\?{3}|\uFFFD/u);
  assert.match(document.paths['/api/benchgo/vault'].post.summary, /.+/u);
  valid(request, { action: 'connectionConfigure', channel: 'telegram', revision: 0, patch: { botTokenRef: 'Opaque:Ref' } });
  valid(request, { action: 'connectionCredential', channel: 'discord', field: 'botTokenRef', secret: 'example' });
  valid(request, { action: 'connectionAction', channel: 'api', operation: 'submit', requestId: '1', conversationId: 'room', text: 'hello' });
  for (const invalid of [
    { action: 'connectionConfigure', patch: {} },
    { action: 'connectionCredential', channel: 'discord', field: 'botTokenRef' },
    { action: 'connectionAction', channel: 'api', operation: 'submit', text: 'hello' },
    { action: 'connectionStatus', channel: 'unknown' },
  ]) assert.equal(request(invalid), false, JSON.stringify(invalid));
});

test('new documented actions exist in production and require their actual CAS fields', async () => {
  const service = await readFile(new URL('../../superagent/src/service.mjs', import.meta.url), 'utf8');
  for (const action of ['taskCancel', 'taskResult', 'taskTakeover', 'taskVerify']) {
    assert.doesNotMatch(service, new RegExp(`case '${action}':`));
    assert.equal(document.components.schemas.AssistantRequest.properties.action.enum.includes(action), false);
    assert.equal(document.paths[path].post.responses['200']['x-action-schemas'][action], undefined);
  }
  const inputs = [
    { action: 'ticketChange', id: 'ticket', operation: 'adjustment', expectedInstructionRevision: 2, requestId: 'r', reason: 'continue' },
    { action: 'evaluations', after: 0, limit: 50 }, { action: 'evaluationHistory', candidateId: 'candidate' },
    { action: 'evaluationDispose', candidateId: 'candidate', disposition: 'retry', expectedRevision: 0, expectedUpdatedAt: '2026-11-02T00:00:00.000Z' },
    { action: 'summarize', text: 'summarize this' }, { action: 'analyzeImage', file: 'image.png', question: 'read this image' },
    { action: 'checkpointList', ticketId: 'ticket' }, { action: 'checkpointPreview', ticketId: 'ticket', runId: 'run' },
    { action: 'checkpointRestore', ticketId: 'ticket', runId: 'run', token: hash },
  ];
  for (const input of inputs) { assert.ok(service.includes(`case '${input.action}':`), input.action); valid(request, input); }
  for (const input of [
    { action: 'ticketChange', id: 'ticket', operation: 'reopen', requestId: 'r', reason: '缂哄皯瑕佹眰鐗堟湰' },
    { action: 'evaluationDispose', candidateId: 'candidate', disposition: 'retry', expectedRevision: 0 },
    { action: 'checkpointRestore', ticketId: 'ticket', runId: 'run' },
    { action: 'summarize', text: '' }, { action: 'analyzeImage', file: 'image.png' },
    { action: 'evaluationDispose', candidateId: 'candidate', disposition: 'approve', expectedRevision: 0, expectedUpdatedAt: 'date' },
  ]) assert.equal(request(input), false, JSON.stringify(input));
});

test('vault contract matches owner HTTP responses and excludes plaintext or execution', async () => {
  let record;
  const records = new Map();
  const ctx = { credentials: { readRecord: async key => structuredClone(records.get(key)), modifyRecord: async (key, change) => { const next = await change(structuredClone(records.get(key))); records.set(key, structuredClone(next)); } }, provide() {}, effect() {} };
  const { service, fetch } = mountVault(ctx);
  const call = async input => { valid(vaultRequest, input); const result = await fetch(new Request('https://benchgo.test/api/benchgo/vault', { method: 'POST', body: JSON.stringify(input), headers: { 'content-type': 'application/json' } })); assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store'); const value = await result.json(); valid(response('/api/benchgo/vault', input.action), value); return value; };
  try {
    await call({ action: 'status' });
    const value = await call({ action: 'save', label: '鍑嵁', secret: 'private-value', target: 'https://api.example.test/auth', method: 'POST', placement: 'header', field: 'Authorization' });
    assert.equal(value.entry.secret, undefined); await call({ action: 'list' });
    assert.equal(vaultRequest({ action: 'execute', handle: value.entry.handle, revision: 1 }), false);
    assert.equal(vaultRequest({ action: 'save', handle: value.entry.handle, label: '鍑嵁', secret: 'private', target: 'https://api.example.test/auth', method: 'POST', placement: 'header', field: 'Authorization' }), false);
  } finally { service.dispose(); }
});

test('checkpoint response contract matches real file restoration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-contract-checkpoint-')), workspace = join(root, 'workspace');
  try {
    await mkdir(workspace); await writeFile(join(workspace, 'file.txt'), 'before');
    const checkpoints = createWorkerCheckpointStore({ directory: join(root, 'backups') });
    await checkpoints.protect({ runId: 'run', ticketId: 'ticket', assignmentId: 'assignment', directory: workspace, callId: 'call' }, () => writeFile(join(workspace, 'file.txt'), 'after'));
    valid(response(path, 'checkpointList'), { checkpoints: await checkpoints.list({ ticketId: 'ticket' }) });
    const preview = await checkpoints.preview('run'); valid(response(path, 'checkpointPreview'), preview);
    valid(response(path, 'checkpointRestore'), await checkpoints.restore('run', { token: preview.token }));
    assert.equal(await readFile(join(workspace, 'file.txt'), 'utf8'), 'before');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Eval response contracts accept real persistent records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-contract-records-'));
  const database = createAssistantOrchestrationStore({ directory: root });
  const tasks = createAssistantRuntimeStore({ filename: join(root, 'tasks.db') });
  try {
    database.ingest({ dedupeKey: 'event', thread: { id: 'thread', source: { type: 'feishu', id: 'chat' } }, source: { eventId: 'event' }, actor: { id: 'owner' }, content: '鍘熸枃', gate: { allowed: true, strength: 'explicit' }, policyVersion: 'p' });
    for (let index = 0; index < 3; index++) { database.claimEval('thread', { owner: 'old', policyVersion: 'p', now: index * 20, timeoutMs: 10 }); database.requeueExpiredEvals(index * 20 + 11); }
    const evaluations = createEvaluationDisposition({ database, readPolicy: async () => ({ version: 'p' }) });
    const list = evaluations.list(); valid(response(path, 'evaluations'), list);
    const candidate = list.candidates[0];
    valid(response(path, 'evaluationDispose'), await evaluations.dispose({ candidateId: candidate.id, expectedRevision: candidate.dispositionRevision, expectedUpdatedAt: candidate.updatedAt, action: 'ignore' }, { kind: 'human' }));
    valid(response(path, 'evaluationHistory'), evaluations.history(candidate.id));
  } finally { database.close(); tasks.close(); await rm(root, { recursive: true, force: true }); }
});

test('Feishu lightweight configuration and paginated chat list have explicit contracts', () => {
  valid(request, { action: 'connectionConfigure', channel: 'feishu', revision: 0, patch: { accessMode: 'platform', directMessages: true, groups: [{ chatId: 'oc_exact', name: '无敌大队', mode: 'mentions' }], otherGroups: 'disabled' } });
  valid(request, { action: 'connectionConfigure', channel: 'feishu', revision: 1, patch: { groups: null, chatIds: ['oc_legacy'] } });
  valid(request, { action: 'connectionAction', channel: 'feishu', operation: 'listChats', pageToken: 'Opaque/+Token' });
  for (const patch of [{ accessMode: 'everyone' }, { directMessages: 'true' }, { groups: [{ chatId: 'oc_1', mode: 'auto' }] }, { groups: [{ mode: 'mentions' }] }, { otherGroups: 'all' }]) {
    assert.equal(request({ action: 'connectionConfigure', channel: 'feishu', revision: 0, patch }), false, JSON.stringify(patch));
  }
  const chatList = compile(document.paths[path].post.responses['200']['x-action-schemas'].connectionAction['x-operation-schemas']['feishu.listChats']);
  valid(chatList, { chats: [{ chatId: 'oc_exact', name: '无敌大队' }], nextPageToken: 'Opaque/+Token' });
  valid(chatList, { chats: [] });
  assert.equal(chatList({ chats: [{ name: 'Missing ID' }] }), false);
});

test('three model queues match persisted configuration and real role routing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-contract-models-'));
  let store = await createAssistantStore({ dataDirectory: root });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const router = { providerId: 'Opaque/@Provider', modelId: 'Router Model:07', options: { reasoningEffort: 'opaque-effort', maxTokens: 1000 } };
  const worker = { providerId: 'Other/Provider', modelId: 'Worker:02' };
  const auxiliary = { models: [{ providerId: 'Aux', modelId: 'Exact/Aux' }], capabilities: ['review'] };
  const patch = { models: [router], workerModels: [worker], auxiliary };
  valid(request, { action: 'config', patch });
  const saved = await store.updateConfig(patch);
  valid(response(path, 'config'), saved);
  const edited = await store.updateConfig({ workerModels: [] }, { revision: saved.revision });
  assert.deepEqual(edited.models, patch.models); assert.deepEqual(edited.auxiliary, auxiliary);
  store.close(); store = await createAssistantStore({ dataDirectory: root });
  const loaded = await store.getConfig();
  valid(response(path, 'config'), loaded);
  assert.deepEqual(roleModels(undefined, loaded, 'worker'), [router]);
  assert.deepEqual(roleModels(worker, loaded, 'worker'), [worker, router]);
  assert.deepEqual(auxiliaryModels(undefined, loaded, 'review'), [...auxiliary.models, router]);
  assert.deepEqual(auxiliaryModels(undefined, loaded, 'summary'), [router]);
  for (const models of [[{ ...router, providerId: ' padded' }], [{ ...router, modelId: 'bad\nID' }],
    [{ ...router, options: { maxTokens: 0 } }], [{ ...router, credentialRef: 'legacy' }], Array(33).fill(router)]) {
    assert.equal(request({ action: 'config', patch: { workerModels: models } }), false);
    assert.throws(() => validateAssistantModels(models));
  }
  for (const auxiliary of [{ models: [], capabilities: [] }, { models: [worker], capabilities: ['unknown'] }]) {
    assert.equal(request({ action: 'config', patch: { auxiliary } }), false);
    assert.throws(() => validateAssistantAuxiliary(auxiliary));
  }
  assert.equal(request({ action: 'config', patch: { keyPools: [{ providerId: 'legacy' }] } }), false);
});

test('real memory responses retain bounded sources and correction version references', async t => {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-contract-memory-'));
  const store = await createAssistantStore({ dataDirectory: root });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const first = await store.saveMemory({ content: 'a'.repeat(6001), source: { type: 'user-edit' } }, { candidateId: 'candidate-source' });
  valid(response(path, 'memorySave'), first);
  assert.equal(first.candidateId, 'candidate-source'); assert.equal(first.source.excerpt.length, 6000);
  assert.equal(first.source.excerptTruncated, true);
  const changed = await store.saveMemory({ id: first.id, content: '保存修订事实', source: { type: 'user-edit' } }, { revision: 1 });
  valid(response(path, 'memorySave'), changed);
  assert.equal(changed.supersedes.revision, 1); assert.deepEqual(changed.versionChain, [changed.supersedes]);
  valid(response(path, 'memorySearch'), { memories: [{ ...changed, legacyIds: ['candidate-legacy'] }] });
  for (const source of [{ excerpt: 'x'.repeat(6001) }, { excerptTruncated: 'true' }]) {
    assert.equal(request({ action: 'memorySave', memory: { content: 'fact', source } }), false);
    assert.equal(response(path, 'memorySave')({ ...changed, source }), false);
    await assert.rejects(store.saveMemory({ content: 'fact', source }));
  }
  assert.equal(response(path, 'memorySave')({ ...changed, versionChain: [{ id: first.id, revision: 0, updatedAt: null }] }), false);
});

test('owner delivery reconciliation requests enforce attempts, evidence and sent-only receipts', async () => {
  const service = await readFile(new URL('../../superagent/src/service.mjs', import.meta.url), 'utf8');
  const branch = service.slice(service.indexOf("case 'directReplyReconcile':"), service.indexOf("case 'checkpointList':"));
  assert.match(branch, /peer\?\.principal\?\.kind !== 'owner'/);
  assert.match(branch, /status: 403, code: 'OWNER_REQUIRED'/);
  for (const action of ['directReplyReconcile', 'outboxReconcile']) {
    const base = { action, id: 'delivery', attempts: 1, outcome: 'unknown', evidence: '平台查询记录' };
    valid(request, base); valid(request, { ...base, outcome: 'not_sent' });
    valid(request, { ...base, outcome: 'sent', evidence: 'x'.repeat(2000), receipt: { status: 'accepted', messageId: 'x'.repeat(512) } });
    for (const key of ['id', 'attempts', 'outcome', 'evidence']) { const missing = { ...base }; delete missing[key]; assert.equal(request(missing), false); }
    for (const patch of [{ id: '' }, { attempts: 0 }, { attempts: 1.5 }, { attempts: Number.MAX_SAFE_INTEGER + 1 },
      { outcome: 'pending' }, { evidence: '' }, { evidence: ' ' }, { evidence: 'x'.repeat(2001) },
      { receipt: null }, { outcome: 'not_sent', receipt: {} }, { outcome: 'sent' },
      ...[{ status: 'unknown', messageId: 'id' }, { status: 'accepted', messageId: '' },
        { status: 'accepted', messageId: ' ' }, { status: 'accepted', messageId: 'x'.repeat(513) }].map(receipt => ({ outcome: 'sent', receipt }))]) {
      assert.equal(request({ ...base, ...patch }), false, JSON.stringify(patch));
    }
  }
});

test('delivery response contracts accept persisted reconciliation records without changing outbox payload', t => {
  const db = createAssistantOrchestrationStore({ filename: ':memory:' }); t.after(() => db.close());
  const source = { channel: 'feishu', chatId: 'original', messageId: 'message' };
  const actor = { kind: 'human', id: 'owner' }, gate = { allowed: true, strength: 'explicit' };
  const { candidate } = db.ingest({ dedupeKey: 'message', thread: { id: 'thread', source: { type: 'feishu', id: 'original' } }, source, actor, gate, content: 'hello', policyVersion: 'p1' });
  const evaluation = db.claimEval('thread', { owner: 'router', policyVersion: 'p1', now: 0 });
  db.decide(candidate.id, { evalId: evaluation.id, owner: 'router', outcome: 'answer', assessment: {}, policyVersion: 'p1', now: 1,
    reply: { text: '你好', source, actor, gate, policyVersion: 'p1' } });
  const [reply] = db.claimDirectReplies({ owner: 'sender', now: 2 });
  db.finishDirectReply(reply.id, { owner: 'sender', uncertain: true, now: 3 });
  const ticket = db.createTicket({ threadId: 'thread', target: 'saved task', mandate: {} });
  const commit = { result: { text: 'done' }, uniqueKey: 'result', outboxPayload: { text: 'done' }, now: 10 };
  db.commitResult(ticket.id, commit);
  const [delivery] = db.claimOutbox('sender', { now: 11 });
  db.finishOutbox(delivery.id, { owner: 'sender', uncertain: true, now: 12 });
  for (const [action, id, reconcile] of [['directReplyReconcile', reply.id, db.reconcileDirectReply], ['outboxReconcile', delivery.id, db.reconcileOutbox]]) {
    const unknown = reconcile(id, { attempts: 1, outcome: 'unknown', evidence: 'pending lookup', now: 20 });
    valid(response(path, action), unknown);
    const sent = reconcile(id, { attempts: 1, outcome: 'sent', evidence: 'found original', receipt: { status: 'accepted', messageId: 'Opaque/receipt:1' }, now: 30 });
    valid(response(path, action), sent);
    assert.equal(sent.reconciliations.length, 2);
    if (action === 'outboxReconcile') {
      assert.deepEqual(sent.payload, commit.outboxPayload); assert.equal(sent.payload.reconciliations, undefined);
      assert.equal(db.commitResult(ticket.id, commit).duplicate, true);
      const { reconciliations, ...missing } = sent; assert.equal(response(path, action)(missing), false);
    }
  }
});

test('history accepts four real schedule lifecycle facts and current ticket projections', () => {
  const at = '2026-11-05T10:00:00.000Z';
  const events = ['created', 'triggered', 'completed', 'failed'].map(phase => scheduleLifecyclePublication({ type: 'schedule.lifecycle', origin: 'system',
    schedule: { id: 'schedule', title: '定时检查', sourceSessionId: 'owner', phase, at,
      ...(phase !== 'created' ? { occurrenceAt: at } : {}), ...(['completed', 'failed'].includes(phase) ? { ticketId: 'ticket' } : {}) } }));
  assert.ok(events.every(Boolean)); valid(response(path, 'history'), { notifications: events });
  for (const action of ['notifications', 'notificationSync']) valid(response(path, action), { events, cursor: 4, hasMore: false, resyncRequired: false });
  const verified = systemStateDelivery({ state: 'action_verified', code: 'ACTION_VERIFIED', stage: 'action' });
  const result = { type: 'ticket.result', ticketId: 'ticket', text: verified.text, publication: verified, origin: 'system', systemState: verified.systemState,
    currentInstructionRevision: 2, currentResultVersion: 1, currentResult: { version: 1, instructionRevision: 2, selfCheck: { summary: '已按当前要求检查执行结果' } },
    currentAttention: null, currentPauseReason: { code: 'EXECUTION_EFFECTS_UNKNOWN' } };
  valid(response(path, 'history'), { notifications: [result] });
  valid(response(path, 'history'), { notifications: [{ ...result, currentResult: null, currentPauseReason: null }] });
  const validate = compile({ $ref: '#/components/schemas/AssistantNotification' });
  assert.equal(validate({ ...events[0], origin: 'router' }), false);
  assert.equal(validate({ ...events[1], schedule: { ...events[1].schedule, occurrenceAt: undefined } }), false);
  assert.equal(validate({ ...result, origin: 'router' }), false);
});

test('attention resolution evidence belongs to ticket rows and accepts real host decisions', t => {
  const db = createAssistantOrchestrationStore({ filename: ':memory:' }); t.after(() => db.close());
  db.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = db.createTicket({ threadId: 'thread', target: '回答问题', mandate: { instruction: '使用简体中文', actorId: 'desktop-owner', source: { channel: 'desktop', sessionId: 'owner' } } });
  db.createAssignment(ticket.id, { model: { providerId: 'p', modelId: 'worker' } });
  const [assignment] = db.claimAssignments('worker', { validateMandate: () => true });
  const ownership = { owner: assignment.owner, fence: assignment.fence };
  const run = db.prepareRun(assignment.id, { ...ownership, sessionId: 'worker-session', directory: '/fixture' });
  db.updateRun(run.id, { ...ownership, state: 'submitted' });
  const questions = [{ id: 'language', question: '输出语言？' }, { id: 'approval', question: '是否批准执行？' }];
  const attentionResolutions = db.saveAttentionResolutions(assignment.id, { ...ownership, sessionId: run.sessionId, callId: 'call', questions,
    decisions: [{ questionId: 'language', route: 'self', basis: '原指令已说明', evidence: '简体中文' }, { questionId: 'approval', route: 'user', basis: '需要主人决定' }] });
  valid(response(path, 'tickets'), { tickets: [{ ...db.getTicket(ticket.id), attentionResolutions }] });
  assert.equal(document.paths[path].post.responses['200']['x-action-schemas'].state.properties.attentionResolutions, undefined);
  const resolution = compile({ $ref: '#/components/schemas/AssistantAttentionResolution' });
  assert.equal(resolution({ ...attentionResolutions[1], answer: { id: 'approval', selected: [], custom: '批准' } }), false);
  const [attention] = db.openAttention(assignment.id, { ...ownership, sessionId: run.sessionId, callId: 'call', questions: [questions[1]] });
  valid(response(path, 'history'), { notifications: [{ type: 'ticket.attention', text: '请确认', currentAttention: { ...attention, instructionRevision: 1 }, currentResult: null, currentPauseReason: null }] });
});

test('delegation rejects per-ticket model overrides and completed changes return linked new tickets', t => {
  const tool = name => compile(document.paths[path].post['x-tool-input-schemas'][name]);
  const delegate = tool('assistant_delegate'), base = { text: '检查原任务', acceptance: '保留原要求', requestId: 'request', duplicateOfTicketId: 'active-ticket' };
  valid(delegate, base); assert.equal(delegate({ ...base, provider: 'Opaque/@Provider', model: 'Exact Model:07' }), false);
  valid(delegate, { ...base, acceptance: '' });
  for (const patch of [{ provider: 'p' }, { model: 'm' }, { duplicateOfTicketId: '' }, { duplicateOfTicketId: 'x'.repeat(513) }]) assert.equal(delegate({ ...base, ...patch }), false);
  const db = createAssistantOrchestrationStore({ filename: ':memory:' }); t.after(() => db.close());
  const source = { channel: 'desktop', sessionId: 'owner', messageId: 'original' }, actor = { kind: 'human', id: 'desktop-owner' };
  const thread = { id: 'thread', source: { type: 'desktop', id: 'owner' } };
  db.ingest({ dedupeKey: 'original', thread, source, actor, content: '原任务', mode: 'direct' });
  const ticket = db.createTicket({ threadId: thread.id, target: '原任务', mandate: { source, actorId: actor.id } });
  db.commitResult(ticket.id, { result: { summary: '原成果' }, uniqueKey: 'original-result' });
  assert.equal(db.getTicket(ticket.id).status, 'waiting');
  for (const delivery of db.claimOutbox('test-delivery')) {
    db.saveOutboxReply(delivery.id, { owner: 'test-delivery', publication: { action: 'deliver', origin: 'router', text: '原任务已完成，成果已整理。' } });
    assert.equal(db.getTicket(ticket.id).status, 'waiting');
    db.finishOutbox(delivery.id, { owner: 'test-delivery', sent: true, receipt: { status: 'accepted', messageId: `sent:${delivery.id}` } });
  }
  assert.equal(db.getTicket(ticket.id).status, 'completed');
  const before = db.getTicket(ticket.id), results = db.results(ticket.id);
  const nextSource = { ...source, messageId: 'adjustment' };
  const { trigger } = db.ingest({ dedupeKey: 'adjustment', thread, source: nextSource, actor, content: '调整成果', mode: 'direct' });
  const change = { id: ticket.id, operation: 'adjustment', expectedInstructionRevision: 1, requestId: 'change', reason: '补充要求' };
  valid(request, { action: 'ticketChange', ...change }); valid(tool('assistant_ticket_change'), change);
  assert.equal(request({ action: 'ticketChange', ...change, operation: 'reopen' }), false);
  assert.equal(request({ action: 'ticketChange', ...change, provider: 'p', model: 'm' }), false);
  assert.equal(request({ action: 'ticketChange', ...change, expectedInstructionRevision: 0 }), false);
  assert.equal(request({ action: 'ticketChange', ...change, provider: 'unpaired' }), false);
  const next = db.changeTicket(ticket.id, { ...change, target: '调整成果', acceptance: '新要求', requestKey: 'change', triggerId: trigger.id,
    mandate: { source: nextSource, actorId: actor.id, instruction: '调整成果' }, model: { providerId: 'p', modelId: 'm' }, validateMandate: () => true });
  valid(response(path, 'ticketChange'), next);
  assert.equal(next.adjustmentOfTicketId, ticket.id); assert.equal(next.instructionRevision, 1); assert.equal(next.resultVersion, 0);
  assert.deepEqual(db.getTicket(ticket.id), before); assert.deepEqual(db.results(ticket.id), results);
});


test('trusted execution-session and website-permission actions expose the current contract', () => {
  for (const action of ['executionSessions', 'actionPermissions']) valid(request, { action });
  valid(request, { action: 'actionPermissionCreate', origin: 'https://example.com', categories: ['login'], expiresAt: '2026-12-01T00:00:00Z', requestId: 'create-1' });
  valid(request, { action: 'actionPermissionRevoke', id: 'grant-1', requestId: 'revoke-1' });
  assert.equal(request({ action: 'actionPermissionCreate', origin: 'https://example.com' }), false);
  assert.equal(request({ action: 'actionPermissionRevoke', id: 'grant-1' }), false);
  valid(response(path, 'executionSessions'), { sessions: [{ sessionId: 'session', ticketId: 'ticket', title: 'Ticket', available: true }] });
  assert.equal(response(path, 'executionSessions')({ sessions: [{ sessionId: 'session', ticketId: 'ticket', title: 'Ticket', available: false }] }), false);
  const result = compile({ $ref: '#/components/schemas/AssistantCurrentResult' });
  assert.equal(result({ version: 1, instructionRevision: 1, review: { verdict: 'passed' } }), false);
  valid(request, { action: 'review' }); // Background memory review remains independent.
});

test('execution approval projection is a read-only origin link with an explicit Router session', () => {
  valid(request, { action: 'executionApprovalOrigins', ownerSessionId: 'router', threadId: 'main' });
  assert.equal(request({ action: 'executionApprovalOrigins' }), false);
  assert.equal(request({ action: 'executionApprovalOrigins', ownerSessionId: '' }), false);
  const validate = response(path, 'executionApprovalOrigins');
  valid(validate, { origins: [] });
  const origin = { ticketId: 'ticket', title: '发送准备稿', assignmentId: 'assignment', runId: 'run',
    sessionId: 'worker', ownerSessionId: 'router', ownerThreadId: 'main' };
  valid(validate, { origins: [origin] });
  assert.equal(validate({ origins: [{ ...origin, approvalToken: 'invented' }] }), false);
  const { runId, ...missing } = origin;
  assert.equal(validate({ origins: [missing] }), false);
});
