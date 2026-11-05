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
  const policy = { desktopVersion: 'desktop-policy', projects: [{ id: 'project', path: directory }] };
  const ctx = { llm: { resolveModelInfo: async (provider, id) => ({ provider, id }) }, get: () => ({ request: async () => { approvals++; return true; } }) };
  ctx.agents = { get: () => ownerAgent, currentInitiator: () => ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: events.findLastIndex(event => event.type === 'turn/start') }) };
  ctx.sessionProjections = { stateOf: () => ({ openTurnStartSeq: events.findLastIndex(event => event.type === 'turn/start') }) };
  const service = createDesktopDelegationService({ ctx, database, readPolicy: async () => policy });
  const input = { requestId: 'request', projectId: 'project', provider: 'opaque/provider', model: 'literal/model:v1', text: '修复任务', acceptance: '测试通过' };
  return { database, service, ownerAgent, policy, ctx, input, events, approvals: () => approvals, exec: { agent: ownerAgent }, options: { ownerAgent, threadId: 'side-chat' } };
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
  assert.deepEqual(assignment.model, { providerId: f.input.provider, modelId: f.input.model });
  assert.equal(assignment.instructionRevision, 1);
  assert.equal(f.database.listTickets().length, 1);
  await assert.rejects(f.service.delegate({ ...f.input, text: 'different' }, f.exec, f.options), /不同任务/);
});

test('omitted model keeps Worker default routing while incomplete or rewritten pairs fail closed', async t => {
  const f = await fixture(t);
  f.policy.models = [{ providerId: 'router', modelId: 'R' }];
  f.policy.workerModels = [{ providerId: 'Opaque Worker/P', modelId: 'Exact:W/v3' }];
  let resolved;
  f.ctx.llm.resolveModelInfo = async (provider, id) => { resolved = { provider, id }; return resolved; };
  const { provider, model, ...input } = f.input;
  const ticket = await f.service.delegate(input, f.exec, f.options);
  assert.deepEqual(resolved, { provider: 'Opaque Worker/P', id: 'Exact:W/v3' });
  assert.equal(f.database.assignments(ticket.id)[0].model, undefined);
  const alias = await f.service.delegate({ ...input, requestId: 'same-trigger-other-request-id' }, f.exec, f.options);
  assert.equal(alias.id, ticket.id);
  await assert.rejects(f.service.delegate({ ...input, requestId: 'same-trigger-new-task', text: 'different operation' }, f.exec, f.options), { code: 'TRIGGER_ALREADY_ASSIGNED' });
  await assert.rejects(f.service.delegate({ ...input, requestId: 'same-trigger-new-model', provider: 'new-provider', model: 'new-model' }, f.exec, f.options), { code: 'TRIGGER_ALREADY_ASSIGNED' });
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

test('desktop delegation rejects inherited tool callers, missing model and rewritten identities before approval', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.delegate(f.input, { agent: { id: 'child' } }, f.options), /只有总助手/);
  await assert.rejects(f.service.delegate({ ...f.input, model: undefined }, f.exec, f.options), /模型标识/);
  f.ctx.llm.resolveModelInfo = async () => ({ provider: f.input.provider, id: 'alias' });
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
