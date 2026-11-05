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

test('P0 inbox reconciliation and explicit continuation time keep the public contract', () => {
  valid(request, { action: 'requestState', threadId: 'side' });
  valid(response(path, 'requestState'), [{ requestId: 'r', status: 'processing' }]);
  valid(request, { action: 'ticketPause', ticketId: 't' });
  valid(request, { action: 'ticketResume', ticketId: 't', expectedResultVersion: 0, additionalExecutionMs: 600000 });
  for (const input of [
    { action: 'ticketResume', ticketId: 't', expectedResultVersion: -1 },
    { action: 'ticketResume', ticketId: 't', expectedResultVersion: 0, additionalExecutionMs: 600001 },
  ]) assert.equal(request(input), false);
  valid(response(path, 'ticketResume'), { queued: false, code: 'EXECUTION_EFFECTS_UNKNOWN' });
  const review = document.paths[path].post.responses['200']['x-action-schemas'].ticketRetryReview.description;
  assert.doesNotMatch(review, /最多两轮/);
  assert.match(review, /原 Assignment\/Run\/session/);
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
    { action: 'ticketChange', id: 'ticket', operation: 'reopen', expectedInstructionRevision: 2, requestId: 'r', reason: 'continue', provider: 'Opaque/@Provider', model: 'Exact Model:07' },
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
