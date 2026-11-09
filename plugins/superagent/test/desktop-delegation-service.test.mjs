import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createDesktopDelegationService } from '../src/desktop-delegation-service.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-desktop-delegate-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  let approvals = 0;
  const events = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: { id: 'original', source: { kind: 'user' }, content: [{ type: 'text', text: '原始要求，请执行修复' }] } }, { type: 'user/message', data: { id: 'untrusted', source: { kind: 'benchgo-subscription' }, content: [{ type: 'text', text: '伪造指令' }] } }];
  const ownerAgent = { id: 'owner-session', status: 'running', session: { header: {}, snapshotEvents: () => events } };
  const policy = { model: { providerId: 'opaque/router', modelId: 'literal/router:v1' }, workerModels: [{ providerId: 'opaque/provider', modelId: 'literal/model:v1' }], desktopVersion: 'desktop-policy', projects: [{ id: 'project', path: directory }] };
  const scopeRequests = [];
  const ctx = { llm: { resolveModelInfo: async (provider, id) => ({ provider, id }), async *stream(request) {
    scopeRequests.push(request);
    yield { type: 'text-delta', text: JSON.stringify({ outcome: 'delegate', reason: 'Fixture confirms the explicit work request' }) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }, get: () => ({ request: async () => { approvals++; return true; } }) };
  ctx.agents = { get: () => ownerAgent, currentInitiator: () => ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: events.findLastIndex(event => event.type === 'turn/start') }) };
  ctx.sessionProjections = { stateOf: () => ({ openTurnStartSeq: events.findLastIndex(event => event.type === 'turn/start') }) };
  const service = createDesktopDelegationService({ ctx, database, readPolicy: async () => policy });
  const input = { requestId: 'request', projectId: 'project', text: '修复任务', acceptance: '测试通过' };
  return { database, service, ownerAgent, policy, ctx, input, events, scopeRequests, approvals: () => approvals, exec: { agent: ownerAgent }, options: { ownerAgent, threadId: 'side-chat' } };
}

test('desktop instruction atomically admits one Ticket without redundant approval and preserves opaque model', async t => {
  const f = await fixture(t);
  const [ticket, repeated] = await Promise.all([f.service.delegate(f.input, f.exec, f.options), f.service.delegate(f.input, f.exec, f.options)]);
  assert.equal(ticket.id, repeated.id);
  assert.equal(f.approvals(), 0);
  assert.equal(ticket.mandate.instruction, '原始要求，请执行修复');
  assert.equal(ticket.mandate.source.messageId, 'original');
  assert.equal(ticket.mandate.source.threadId, 'side-chat');
  assert.equal(ticket.mandate.admission, 'desktop-approved-delegation');
  assert.equal(ticket.mandate.target, ticket.target);
  assert.equal(ticket.mandate.acceptance, ticket.acceptance);
  const [assignment] = f.database.assignments(ticket.id);
  assert.deepEqual(assignment.model, f.policy.workerModels[0]);
  assert.equal(assignment.instructionRevision, 1);
  assert.equal(f.database.listTickets().length, 1);
  await assert.rejects(f.service.delegate({ ...f.input, text: 'different' }, f.exec, f.options), /不同任务/);
});

test('requests use the system work role and reject every obsolete override field before admission', async t => {
  const f = await fixture(t);
  f.policy.models = [{ providerId: 'router', modelId: 'R' }];
  f.policy.workerModels = [{ providerId: 'Opaque Worker/P', modelId: 'Exact:W/v3' }];
  let resolved;
  f.ctx.llm.resolveModelInfo = async (provider, id) => { resolved = { provider, id }; return resolved; };
  const { provider, model, ...input } = f.input;
  for (const field of ['provider', 'model', 'providerId', 'modelId', 'workerModel']) {
    await assert.rejects(f.service.delegate({ ...input, [field]: field === 'workerModel' ? f.policy.workerModels[0] : 'override' }, f.exec, f.options), { code: 'MODEL_OVERRIDE_UNSUPPORTED' });
  }
  assert.equal(f.database.listTickets().length, 0);
  const ticket = await f.service.delegate(input, f.exec, f.options);
  assert.deepEqual(resolved, { provider: 'Opaque Worker/P', id: 'Exact:W/v3' });
  assert.deepEqual(f.database.assignments(ticket.id)[0].model, f.policy.workerModels[0]);
  const alias = await f.service.delegate({ ...input, requestId: 'same-trigger-other-request-id' }, f.exec, f.options);
  assert.equal(alias.id, ticket.id);
  await assert.rejects(f.service.delegate({ ...input, requestId: 'same-trigger-new-task', text: 'different operation' }, f.exec, f.options), { code: 'TRIGGER_ALREADY_ASSIGNED' });
  await assert.rejects(f.service.delegate({ ...input, requestId: 'same-trigger-new-model', provider: 'new-provider', model: 'new-model' }, f.exec, f.options), { code: 'MODEL_OVERRIDE_UNSUPPORTED' });
  assert.equal(f.database.listTickets().length, 1);
});

test('Router-selected duplicate merges only matching live source, requirements and authorization', async t => {
  const f = await fixture(t);
  const original = await f.service.delegate(f.input, f.exec, f.options);
  f.events.push({ type: 'user/message', data: { id: 'duplicate-message', source: { kind: 'user' }, content: [{ type: 'text', text: '刚才的修复不用另开，继续已有任务' }] } });
  const input = { ...f.input, requestId: 'semantic-duplicate', duplicateOfTicketId: original.id };
  const merged = await f.service.delegate(input, f.exec, f.options);
  assert.equal(merged.id, original.id);
  assert.deepEqual(merged.mandate, original.mandate);
  assert.equal(f.database.assignments(original.id).length, 1);
  assert.equal(f.database.listTickets().length, 1);
  f.events.push({ type: 'user/message', data: { id: 'expanded-message', source: { kind: 'user' }, content: [{ type: 'text', text: '顺便执行更多操作' }] } });
  await assert.rejects(f.service.delegate({ ...input, requestId: 'expanded', text: 'expanded task' }, f.exec, f.options), { code: 'TICKET_MERGE_REJECTED' });
  f.events.push({ type: 'user/message', data: { id: 'cross-message', source: { kind: 'user' }, content: [{ type: 'text', text: '继续任务' }] } });
  await assert.rejects(f.service.delegate({ ...input, requestId: 'cross-conversation' }, f.exec, { ...f.options, threadId: 'other' }), { code: 'TICKET_MERGE_REJECTED' });
});

test('desktop delegation rejects inherited callers, obsolete overrides and rewritten identities before admission', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.delegate(f.input, { agent: { id: 'child' } }, f.options), /只有总助手/);
  await assert.rejects(f.service.delegate({ ...f.input, model: undefined }, f.exec, f.options), { code: 'MODEL_OVERRIDE_UNSUPPORTED' });
  f.ctx.llm.resolveModelInfo = async () => ({ provider: f.policy.workerModels[0].providerId, id: 'alias' });
  await assert.rejects(f.service.delegate(f.input, f.exec, f.options), /显式标识/);
  assert.equal(f.approvals(), 0);
  assert.equal(f.database.listTickets().length, 0);
});

test('policy change during model resolution cannot admit a stale project mandate', async t => {
  const f = await fixture(t);
  f.ctx.llm.resolveModelInfo = async (provider, id) => { f.policy.projects = []; return { provider, id }; };
  await assert.rejects(f.service.delegate(f.input, f.exec, f.options), /已变化/);
  assert.equal(f.database.listTickets().length, 0);
});

test('daily research delegates without a project or redundant approval while preserving source authority', async t => {
  const f = await fixture(t);
  f.policy.projects = [];
  f.events[1].data.content = [{ type: 'text', text: '今天热点搜一下' }];
  const { projectId, ...input } = f.input;
  const ticket = await f.service.delegate({ ...input, text: '查找当天热点并附来源', acceptance: '' }, f.exec, f.options);
  assert.equal(ticket.mandate.project, undefined);
  assert.equal(ticket.mandate.instruction, '今天热点搜一下');
  assert.equal(ticket.acceptance, '今天热点搜一下');
  assert.equal(ticket.mandate.source.threadId, 'side-chat');
  assert.equal(f.approvals(), 0);
  assert.equal(f.database.assignments(ticket.id).length, 1);
  await assert.rejects(f.service.delegate({ ...input, requestId: 'invalid-project', projectId: 'unknown' }, f.exec, f.options), /项目不存在/);
});

test('opening a news task persists concrete original criteria before any review runs', async t => {
  const f = await fixture(t);
  const original = '请调研2026年11月4日当天新闻，输出6–10条简明中文热点，每条1–2句，附来源和时间，标注多源/待确认，最后一句概览；无法访问渠道如实说明，不要生成文件。';
  f.events[1].data.content = [{ type: 'text', text: original }];
  const { projectId, ...input } = f.input;
  const ticket = await f.service.delegate({ ...input, title: '当天新闻摘要', text: '整理当天新闻摘要并保留全部原始要求', acceptance: '' }, f.exec, f.options);
  assert.equal(ticket.title, '当天新闻摘要');
  assert.equal(ticket.target, '整理当天新闻摘要并保留全部原始要求');
  assert.equal(ticket.acceptance, original);
  assert.equal(ticket.mandate.acceptance, original);
  assert.equal(ticket.mandate.instruction, original);
  assert.match(f.database.assignments(ticket.id)[0].acceptance, /6–10条/);
  assert.equal(f.database.results(ticket.id).length, 0);
});

test('placeholder admission labels fail before creating a Trigger or resolving a work model', async t => {
  const f = await fixture(t);
  let resolutions = 0;
  f.ctx.llm.resolveModelInfo = async () => { resolutions++; throw Error('must not resolve placeholder work'); };
  for (const patch of [{ title: '执行任务' }, { title: 'process request' }, { text: '处理请求' }]) {
    await assert.rejects(f.service.delegate({ ...f.input, ...patch }, f.exec, f.options), { code: 'TICKET_DESCRIPTION_GENERIC' });
  }
  assert.equal(resolutions, 0);
  assert.equal(f.database.listTickets().length, 0);
  assert.equal(f.approvals(), 0);
});

test('a concrete user title and business summary remain unchanged at admission', async t => {
  const f = await fixture(t);
  const title = '请求日志修复报告', text = '为用户修复请求日志页面，并提供原因、改动和验证结果';
  const ticket = await f.service.delegate({ ...f.input, title, text }, f.exec, f.options);
  assert.equal(ticket.title, title);
  assert.equal(ticket.target, text);
  assert.equal(ticket.mandate.instruction, '原始要求，请执行修复');
});

for (const original of ['做任务进度看板', '检查网站状态']) test(`new tasks with progress or status wording retain literal authority: ${original}`, async t => {
  const f = await fixture(t);
  f.events[1].data.content = [{ type: 'text', text: original }];
  const ticket = await f.service.delegate({ ...f.input, text: original, acceptance: '' }, f.exec, f.options);
  assert.equal(ticket.target, original);
  assert.equal(ticket.mandate.instruction, original);
  assert.equal(ticket.mandate.acceptance, original);
  assert.equal(ticket.mandate.policyVersion, f.policy.desktopVersion);
  assert.equal(ticket.mandate.source.messageId, 'original');
  assert.equal(ticket.mandate.controlledActions, 'require-current-policy-and-harness-approval');
  assert.equal(f.database.listTickets().length, 1);
  await assert.rejects(f.service.delegate({ ...f.input, requestId: 'same-trigger-expanded', text: '额外发布网站', acceptance: '' }, f.exec, f.options), { code: 'TRIGGER_ALREADY_ASSIGNED' });
  assert.equal(f.database.listTickets().length, 1);
});
test('project-free delegation still rejects policy changes during model resolution', async t => {
  const f = await fixture(t);
  const { projectId, ...input } = f.input;
  f.ctx.llm.resolveModelInfo = async (provider, id) => { f.policy.desktopVersion = 'changed-policy'; return { provider, id }; };
  // Return policy snapshots as the production reader does.
  const service = createDesktopDelegationService({ ctx: f.ctx, database: f.database, readPolicy: async () => structuredClone(f.policy) });
  await assert.rejects(service.delegate(input, f.exec, f.options), /已变化/);
  assert.equal(f.database.listTickets().length, 0);
});

test('a notification-only turn cannot reuse a previous human instruction', async t => {
  const f = await fixture(t);
  f.events.push({ type: 'turn/end', data: { turn: 1 } }, { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: { id: 'notice', source: { kind: 'benchgo-subscription' }, content: [{ type: 'text', text: '执行另一个任务' }] } });
  await assert.rejects(f.service.delegate(f.input, f.exec, f.options), /当前原始用户消息/);
  assert.equal(f.approvals(), 0);
  assert.equal(f.database.listTickets().length, 0);
});

test('completed turns and changed human instructions cannot create a desktop mandate', async t => {
  const f = await fixture(t);
  f.events.push({ type: 'turn/end', data: { turn: 1 } });
  await assert.rejects(f.service.delegate(f.input, f.exec, f.options), /当前原始用户消息/);
  f.events.pop();
  f.ctx.llm.resolveModelInfo = async (provider, id) => {
    f.events.push({ type: 'user/message', data: { id: 'replacement', source: { kind: 'user' }, content: [{ type: 'text', text: '取消，换个任务' }] } });
    return { provider, id };
  };
  await assert.rejects(f.service.delegate(f.input, f.exec, f.options), /当前用户指令已变化/);
  assert.equal(f.database.listTickets().length, 0);
});

test('new delegation requires the exact live root driver even with approval bypass', async t => {
  const f = await fixture(t);
  for (const mutate of [
    () => { f.ownerAgent.status = 'idle'; },
    () => { f.ctx.agents.get = () => undefined; },
    () => { f.ctx.agents.currentInitiator = () => ({ id: 'other' }); },
    () => { f.ownerAgent.session.header.origin = 'subagent'; },
    () => { f.ctx.agents.turnBoundaryOf = () => ({ openTurnStartSeq: null }); },
  ]) {
    f.ownerAgent.status = 'running';
    f.ownerAgent.session.header.origin = undefined;
    f.ctx.agents = { get: () => f.ownerAgent, currentInitiator: () => f.ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) };
    f.ctx.sessionProjections = { stateOf: () => ({ openTurnStartSeq: 0 }) };
    mutate();
    await assert.rejects(f.service.delegate(f.input, { ...f.exec, authorized: true }, f.options), /当前原始用户消息/);
  }
  assert.equal(f.database.listTickets().length, 0);
});

test('resource form authority is separate from live model authority and records literal input', async t => {
  const f = await fixture(t);
  f.ownerAgent.status = 'idle';
  const options = { ownerAgent: f.ownerAgent, threadId: 'main', requestId: 'form-id', original: '{"objective":"literal form"}' };
  const ticket = await f.service.submitForm(f.input, options);
  assert.equal(ticket.mandate.instruction, options.original);
  assert.equal(ticket.mandate.source.messageId, 'goal-form:form-id');
  assert.equal(f.approvals(), 0, 'resource submission itself is the owner instruction');
  assert.equal((await f.service.submitForm(f.input, options)).id, ticket.id);
  await assert.rejects(f.service.delegate({ ...f.input, requestId: 'model-new' }, { ...f.exec, authorized: true }, f.options), /当前原始用户消息/);
  assert.throws(() => f.service.submitForm(f.input, { ...options, ownerAgent: { id: f.ownerAgent.id } }), /真实主助手/);
});

const deviceCapability = { name: 'assistant_device_status', description: 'Read authorized Link devices and recorded pairing/authentication times; live connections and complete history are unknown.' };
const scopedService = (f, options = {}) => createDesktopDelegationService({ ctx: f.ctx, database: f.database,
  readPolicy: async () => structuredClone(f.policy), readOnlyCapabilities: () => [deviceCapability], ...options });
const scopeResponse = decision => async function* () {
  yield { type: 'text-delta', text: JSON.stringify(decision) };
  yield { type: 'finish', reason: { kind: 'stop' } };
};

test('a new direct-status proposal is audited once, returned to the same Router and never resolves a Worker', async t => {
  const f = await fixture(t);
  f.events[1].data.content = [{ type: 'text', text: '有其他设备连接我们这台机器吗？' }];
  const records = [], save = f.database.recordDesktopScopeCheck;
  f.database.recordDesktopScopeCheck = record => { const saved = save(record); records.push(saved); return saved; };
  let calls = 0;
  f.ctx.llm.stream = request => {
    calls++;
    assert.equal(request.purpose, 'superagent-delegation-scope');
    assert.deepEqual(request.tools, []);
    return scopeResponse({ outcome: 'direct', reason: '只请求产品设备状态', toolNames: ['assistant_device_status'] })();
  };
  f.ctx.llm.resolveModelInfo = () => { throw Error('must not prepare a Worker for product state'); };
  const service = scopedService(f);
  const results = await Promise.allSettled([service.delegate(f.input, f.exec, f.options), service.delegate(f.input, f.exec, f.options)]);
  for (const result of results) assert.equal(result.reason?.code, 'DELEGATION_DIRECT_TOOL_REQUIRED');
  await assert.rejects(service.delegate(f.input, f.exec, f.options), { code: 'DELEGATION_DIRECT_TOOL_REQUIRED' });
  assert.equal(calls, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].binding.humanMessageId, 'original');
  assert.equal(records[0].binding.sessionId, f.ownerAgent.id);
  assert.equal(records[0].binding.payloadHash.length, 64);
  assert.equal(records[0].binding.instructionHash.length, 64);
  assert.equal(f.database.listTickets().length, 0);
  assert.equal(f.approvals(), 0);
  // A fresh service object (as after reload) reads the persisted exact-bound result.
  await assert.rejects(scopedService(f).delegate(f.input, f.exec, f.options), { code: 'DELEGATION_DIRECT_TOOL_REQUIRED' });
  assert.equal(calls, 1);
});

test('scope cache cannot authorize changed payloads, different human messages or in-flight replacements', async t => {
  const f = await fixture(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const service = scopedService(f, { assessScope: async () => { calls++; entered(); await gate;
    return { decision: { outcome: 'direct', reason: '只读设备状态', toolNames: ['assistant_device_status'] }, routing: null }; } });
  const pending = service.delegate(f.input, f.exec, f.options);
  await started;
  await assert.rejects(service.delegate({ ...f.input, text: 'different proposed work' }, f.exec, f.options), { code: 'IDEMPOTENCY_CONFLICT' });
  release();
  await assert.rejects(pending, { code: 'DELEGATION_DIRECT_TOOL_REQUIRED' });
  await assert.rejects(service.delegate({ ...f.input, text: 'different proposed work' }, f.exec, f.options), { code: 'IDEMPOTENCY_CONFLICT' });
  f.events.push({ type: 'user/message', data: { id: 'new-human', source: { kind: 'user' }, content: [{ type: 'text', text: '请执行新的网络调查' }] } });
  await assert.rejects(service.delegate(f.input, f.exec, f.options), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(service.delegate({ ...f.input, requestId: 'different-request' }, f.exec, f.options), { code: 'DELEGATION_DIRECT_TOOL_REQUIRED' });
  assert.equal(calls, 2, 'a different request must receive its own bound decision');
  assert.equal(f.database.listTickets().length, 0);
});

test('capability or review-route changes invalidate a cached scope result instead of reusing permission', async t => {
  const f = await fixture(t);
  let capabilities = [deviceCapability], calls = 0;
  const service = scopedService(f, { readOnlyCapabilities: () => capabilities, assessScope: async ({ input }) => {
    calls++;
    return { decision: input.capabilities.length ? { outcome: 'direct', reason: '产品状态', toolNames: ['assistant_device_status'] }
      : { outcome: 'unconfirmed', reason: '设备能力已不可用' }, routing: null };
  } });
  await assert.rejects(service.delegate(f.input, f.exec, f.options), { code: 'DELEGATION_DIRECT_TOOL_REQUIRED' });
  capabilities = [];
  await assert.rejects(service.delegate(f.input, f.exec, f.options), { code: 'DELEGATION_SCOPE_UNCONFIRMED' });
  f.policy.model = { providerId: 'other-provider', modelId: 'opaque/review' };
  await assert.rejects(service.delegate(f.input, f.exec, f.options), { code: 'DELEGATION_SCOPE_UNCONFIRMED' });
  assert.equal(calls, 3);
  assert.equal(f.database.listTickets().length, 0);
});

test('changed live source or capabilities during scope checking prevents admission', async t => {
  for (const change of ['human', 'capabilities', 'policy']) {
    const f = await fixture(t);
    let capabilities = [deviceCapability];
    const service = scopedService(f, { readOnlyCapabilities: () => capabilities, assessScope: async () => {
      if (change === 'human') f.events.push({ type: 'user/message', data: { id: 'changed', source: { kind: 'user' }, content: [{ type: 'text', text: '停止' }] } });
      if (change === 'capabilities') capabilities = [];
      if (change === 'policy') f.policy.desktopVersion = 'changed';
      return { decision: { outcome: 'delegate', reason: 'Fixture allowed the original snapshot only' }, routing: null };
    } });
    await assert.rejects(service.delegate(f.input, f.exec, f.options), { code: 'DELEGATION_SCOPE_STALE' });
    assert.equal(f.database.listTickets().length, 0);
  }
});

test('invalid, invented-tool and failed model responses cannot become a successful admission', async t => {
  for (const outcome of ['invalid-json', 'unknown-tool', 'provider-failure', 'delegate-with-tools', 'unconfirmed-with-tools']) {
    const f = await fixture(t);
    f.ctx.llm.stream = async function* () {
      if (outcome === 'provider-failure') throw Object.assign(new Error('PRIVATE provider body'), { code: 'POLICY_DENIED' });
      const decision = outcome.endsWith('-with-tools')
        ? { outcome: outcome.split('-')[0], reason: 'scope conclusion', toolNames: [] }
        : { outcome: 'direct', reason: 'read', toolNames: ['unregistered_scan'] };
      yield { type: 'text-delta', text: outcome === 'invalid-json' ? 'not json' : JSON.stringify(decision) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    };
    const service = scopedService(f);
    await assert.rejects(service.delegate(f.input, f.exec, f.options), error => error.code === 'DELEGATION_SCOPE_UNCONFIRMED' && !error.message.includes('PRIVATE'));
    assert.equal(f.database.listTickets().length, 0);
  }
});

test('cancellation while final policy read is pending cannot create a Ticket after scope approval', async t => {
  const f = await fixture(t), controller = new AbortController();
  let reads = 0;
  const service = scopedService(f, { readPolicy: async () => {
    if (++reads === 3) controller.abort();
    return structuredClone(f.policy);
  } });
  await assert.rejects(service.delegate(f.input, { ...f.exec, signal: controller.signal }, f.options), { name: 'AbortError' });
  assert.equal(f.database.listTickets().length, 0);
});

test('scope checks only genuinely new model proposals; exact retries, attached work and forms reuse prior boundaries', async t => {
  const f = await fixture(t);
  const ticket = await f.service.delegate(f.input, f.exec, f.options);
  assert.equal(f.scopeRequests.length, 1);
  await f.service.delegate(f.input, f.exec, f.options);
  await f.service.delegate({ ...f.input, requestId: 'same-source-alias' }, f.exec, f.options);
  f.events.push({ type: 'user/message', data: { id: 'followup', source: { kind: 'user' }, content: [{ type: 'text', text: '继续已有任务' }] } });
  await f.service.delegate({ ...f.input, requestId: 'attach', duplicateOfTicketId: ticket.id }, f.exec, f.options);
  await f.service.submitForm({ ...f.input, requestId: 'form-proposal' }, { ownerAgent: f.ownerAgent, threadId: 'main', requestId: 'form', original: '明确提交表单任务' });
  assert.equal(f.scopeRequests.length, 1);
  assert.equal(f.database.listTickets().length, 2);
});

test('a failed scope attempt can recover on the same bound request while retaining its failure evidence', async t => {
  const f = await fixture(t);
  const saved = [], record = f.database.recordDesktopScopeCheck;
  f.database.recordDesktopScopeCheck = input => { const row = record(input); saved.push(row); return row; };
  let calls = 0;
  const service = scopedService(f, { assessScope: async () => {
    if (++calls === 1) throw Object.assign(new Error('temporarily unavailable'), { code: 'TIMEOUT' });
    return { decision: { outcome: 'delegate', reason: 'Recovered check confirms the original work' }, routing: null };
  } });
  await assert.rejects(service.delegate(f.input, f.exec, f.options), { code: 'DELEGATION_SCOPE_UNCONFIRMED' });
  const ticket = await service.delegate(f.input, f.exec, f.options);
  assert.equal(calls, 2);
  assert.equal(f.database.listTickets().length, 1);
  assert.equal(ticket.mandate.scopeCheck.bindingHash, saved[1].bindingHash);
  const attempts = f.database.desktopScopeAttempts(saved[0].requestKey, saved[0].bindingHash);
  assert.deepEqual(attempts.map(row => [row.attempt, row.decision.outcome, row.failureCode]), [[1, 'unconfirmed', 'TIMEOUT'], [2, 'delegate', undefined]]);
  assert.equal((await service.delegate(f.input, f.exec, f.options)).id, ticket.id);
  assert.equal(calls, 2);
});

test('successful receipts preserve their exact original human source, including duplicate attachments', async t => {
  const f = await fixture(t);
  const ticket = await f.service.delegate(f.input, f.exec, f.options);
  f.events.push({ type: 'user/message', data: { id: 'later-message', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } });
  await assert.rejects(f.service.delegate(f.input, f.exec, f.options), { code: 'IDEMPOTENCY_CONFLICT' });
  const duplicate = { ...f.input, requestId: 'attachment-request', duplicateOfTicketId: ticket.id };
  assert.equal((await f.service.delegate(duplicate, f.exec, f.options)).id, ticket.id);
  assert.equal((await f.service.delegate(duplicate, f.exec, f.options)).id, ticket.id);
  f.events.push({ type: 'user/message', data: { id: 'third-message', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } });
  await assert.rejects(f.service.delegate(duplicate, f.exec, f.options), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(f.database.listTickets().length, 1);
});
