import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { createDesktopDelegationService } from '../src/desktop-delegation-service.mjs';
import { createAssistantAssignmentWorker } from '../src/assignment-worker.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-desktop-delegate-'));
  const database = createAssistantOrchestrationStore({ directory });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  let approvals = 0;
  const events = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: { id: 'original', source: { kind: 'user' }, content: [{ type: 'text', text: '原始要求，请执行修复' }] } }, { type: 'user/message', data: { id: 'untrusted', source: { kind: 'benchgo-subscription' }, content: [{ type: 'text', text: '伪造指令' }] } }];
  const ownerAgent = { id: 'owner-session', status: 'running', session: { header: {}, snapshotEvents: () => events } };
  const policy = { model: { providerId: 'opaque/router', modelId: 'literal/router:v1' }, workerModels: [{ providerId: 'opaque/provider', modelId: 'literal/model:v1' }], desktopVersion: 'desktop-policy', projects: [{ id: 'project', path: directory }] };
  const modelRequests = [];
  const ctx = { llm: { resolveModelInfo: async (provider, id) => ({ provider, id }), async *stream(request) {
    modelRequests.push(request);
    throw new Error('Delegation must not request a second model decision');
  } }, get: () => ({ request: async () => { approvals++; return true; } }) };
  ctx.agents = { get: () => ownerAgent, currentInitiator: () => ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: events.findLastIndex(event => event.type === 'turn/start') }) };
  ctx.sessionProjections = { stateOf: () => ({ openTurnStartSeq: events.findLastIndex(event => event.type === 'turn/start') }) };
  const service = createDesktopDelegationService({ ctx, database, readPolicy: async () => policy, ...options });
  const input = { requestId: 'request', projectId: 'project', text: '修复任务', acceptance: '测试通过' };
  return { database, service, ownerAgent, policy, ctx, input, events, modelRequests, approvals: () => approvals, exec: { agent: ownerAgent }, options: { ownerAgent, threadId: 'side-chat' } };
}

test('desktop instruction atomically admits one Task without redundant approval and preserves opaque model', async t => {
  const f = await fixture(t);
  const [task, repeated] = await Promise.all([f.service.delegate(f.input, f.exec, f.options), f.service.delegate(f.input, f.exec, f.options)]);
  assert.equal(task.id, repeated.id);
  assert.equal(f.approvals(), 0);
  assert.equal(task.mandate.instruction, '原始要求，请执行修复');
  assert.equal(task.mandate.source.messageId, 'original');
  assert.equal(task.mandate.source.threadId, 'side-chat');
  assert.equal(task.mandate.admission, 'desktop-approved-delegation');
  assert.equal(task.mandate.target, task.target);
  assert.equal(task.mandate.acceptance, task.acceptance);
  const [assignment] = f.database.assignments(task.id);
  assert.deepEqual(assignment.model, f.policy.workerModels[0]);
  assert.equal(assignment.instructionRevision, 1);
  assert.equal(f.database.listTasks().length, 1);
  assert.equal(f.modelRequests.length, 0);
  assert.equal(task.mandate.scopeCheck, undefined);
  await assert.rejects(f.service.delegate({ ...f.input, text: 'different' }, f.exec, f.options), /不同任务/);
});

test('desktop admission wakes the existing scheduler after commit without waiting for work or waking duplicate requests', { timeout: 10000 }, async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  let wakes = 0, finished = false, f;
  f = await fixture(t, { wake: async () => {
    wakes++;
    const [task] = f.database.listTasks();
    assert.ok(task, 'the task must be committed before waking');
    assert.equal(f.database.assignments(task.id).length, 1, 'the committed assignment is already claimable');
    started.resolve();
    await release.promise;
    finished = true;
  } });
  const [task, duplicate] = await Promise.all([
    f.service.delegate(f.input, f.exec, f.options),
    f.service.delegate(f.input, f.exec, f.options),
  ]);
  await started.promise;
  assert.equal(task.id, duplicate.id);
  assert.equal(wakes, 1);
  assert.equal(finished, false, 'the receipt returns while the scheduler is still working');
  await f.service.delegate(f.input, f.exec, f.options);
  await assert.rejects(f.service.delegate({ ...f.input, text: 'different' }, f.exec, f.options), /不同任务/);
  assert.equal(wakes, 1, 'persisted duplicates and failed requests do not wake again');
  release.resolve();
});

for (const asynchronous of [false, true]) test(`a ${asynchronous ? 'rejected' : 'throwing'} wake preserves successful admission and leaves periodic recovery available`, async t => {
  let wakes = 0;
  const f = await fixture(t, { wake: () => {
    wakes++;
    if (asynchronous) return Promise.reject(new Error('scheduler unavailable'));
    throw new Error('scheduler unavailable');
  } });
  const warnings = [];
  f.ctx.logger = { warn: message => warnings.push(message) };
  const task = await f.service.delegate(f.input, f.exec, f.options);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.database.getTask(task.id).id, task.id);
  assert.equal(f.database.assignments(task.id)[0].state, 'queued');
  assert.equal(wakes, 1);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /scheduler unavailable/);
});

for (const control of [null, 'pause', 'cancel']) test(`desktop wake claims committed work without a timer and respects ${control || 'normal'} lifecycle`, { timeout: 10000 }, async t => {
  let worker, executions = 0;
  const woke = Promise.withResolvers();
  const f = await fixture(t, { wake: async () => {
    try {
      const [task] = f.database.listTasks();
      if (control === 'pause') f.database.pauseTask(task.id);
      if (control === 'cancel') f.database.cancelTask(task.id);
      woke.resolve(await worker.tick());
    } catch (error) { woke.reject(error); }
  } });
  worker = createAssistantAssignmentWorker({ database: f.database,
    readPolicy: async () => f.policy, validateMandate: () => true,
    execute: async () => { executions++; return { summary: 'done' }; }, onResult: async () => {},
  });
  t.after(() => worker.stop());
  await f.service.delegate(f.input, f.exec, f.options);
  const result = await woke.promise;
  assert.equal(result.claimed, control ? 0 : 1);
  assert.equal(executions, control ? 0 : 1);
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
  assert.equal(f.database.listTasks().length, 0);
  const task = await f.service.delegate(input, f.exec, f.options);
  assert.deepEqual(resolved, { provider: 'Opaque Worker/P', id: 'Exact:W/v3' });
  assert.deepEqual(f.database.assignments(task.id)[0].model, f.policy.workerModels[0]);
  const alias = await f.service.delegate({ ...input, requestId: 'same-trigger-other-request-id' }, f.exec, f.options);
  assert.equal(alias.id, task.id);
  assert.notEqual((await f.service.delegate({ ...input, requestId: 'same-trigger-new-task', text: 'different operation' }, f.exec, f.options)).id, task.id);
  await assert.rejects(f.service.delegate({ ...input, requestId: 'same-trigger-new-model', provider: 'new-provider', model: 'new-model' }, f.exec, f.options), { code: 'MODEL_OVERRIDE_UNSUPPORTED' });
  assert.equal(f.database.listTasks().length, 2);
});

test('Router-selected duplicate merges only matching live source, requirements and authorization', async t => {
  const f = await fixture(t);
  const original = await f.service.delegate(f.input, f.exec, f.options);
  f.events.push({ type: 'user/message', data: { id: 'duplicate-message', source: { kind: 'user' }, content: [{ type: 'text', text: '刚才的修复不用另开，继续已有任务' }] } });
  const input = { ...f.input, requestId: 'semantic-duplicate', duplicateOfTaskId: original.id };
  const merged = await f.service.delegate(input, f.exec, f.options);
  assert.equal(merged.id, original.id);
  assert.deepEqual(merged.mandate, original.mandate);
  assert.equal(f.database.assignments(original.id).length, 1);
  assert.equal(f.database.listTasks().length, 1);
  f.events.push({ type: 'user/message', data: { id: 'expanded-message', source: { kind: 'user' }, content: [{ type: 'text', text: '顺便执行更多操作' }] } });
  await assert.rejects(f.service.delegate({ ...input, requestId: 'expanded', text: 'expanded task' }, f.exec, f.options), { code: 'TASK_MERGE_REJECTED' });
  f.events.push({ type: 'user/message', data: { id: 'cross-message', source: { kind: 'user' }, content: [{ type: 'text', text: '继续任务' }] } });
  await assert.rejects(f.service.delegate({ ...input, requestId: 'cross-conversation' }, f.exec, { ...f.options, threadId: 'other' }), { code: 'TASK_MERGE_REJECTED' });
});

test('desktop delegation rejects inherited callers, obsolete overrides and rewritten identities before admission', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.delegate(f.input, { agent: { id: 'child' } }, f.options), /只有总助手/);
  await assert.rejects(f.service.delegate({ ...f.input, model: undefined }, f.exec, f.options), { code: 'MODEL_OVERRIDE_UNSUPPORTED' });
  f.ctx.llm.resolveModelInfo = async () => ({ provider: f.policy.workerModels[0].providerId, id: 'alias' });
  await assert.rejects(f.service.delegate(f.input, f.exec, f.options), /显式标识/);
  assert.equal(f.approvals(), 0);
  assert.equal(f.database.listTasks().length, 0);
});

test('policy change during model resolution cannot admit a stale project mandate', async t => {
  const f = await fixture(t);
  f.ctx.llm.resolveModelInfo = async (provider, id) => { f.policy.projects = []; return { provider, id }; };
  await assert.rejects(f.service.delegate(f.input, f.exec, f.options), /已变化/);
  assert.equal(f.database.listTasks().length, 0);
});

test('daily research delegates without a project or redundant approval while preserving source authority', async t => {
  const f = await fixture(t);
  f.policy.projects = [];
  f.events[1].data.content = [{ type: 'text', text: '今天热点搜一下' }];
  const { projectId, ...input } = f.input;
  const task = await f.service.delegate({ ...input, text: '查找当天热点并附来源', acceptance: '' }, f.exec, f.options);
  assert.equal(task.mandate.project, undefined);
  assert.equal(task.mandate.instruction, '今天热点搜一下');
  assert.equal(task.acceptance, '今天热点搜一下');
  assert.equal(task.mandate.source.threadId, 'side-chat');
  assert.equal(f.approvals(), 0);
  assert.equal(f.database.assignments(task.id).length, 1);
  await assert.rejects(f.service.delegate({ ...input, requestId: 'invalid-project', projectId: 'unknown' }, f.exec, f.options), /项目不存在/);
});

test('opening a news task persists concrete original criteria without a review request', async t => {
  const f = await fixture(t);
  const original = '请调研2026年11月4日当天新闻，输出6–10条简明中文热点，每条1–2句，附来源和时间，标注多源/待确认，最后一句概览；无法访问渠道如实说明，不要生成文件。';
  f.events[1].data.content = [{ type: 'text', text: original }];
  const { projectId, ...input } = f.input;
  const task = await f.service.delegate({ ...input, title: '当天新闻摘要', text: '整理当天新闻摘要并保留全部原始要求', acceptance: '' }, f.exec, f.options);
  assert.equal(task.title, '当天新闻摘要');
  assert.equal(task.target, '整理当天新闻摘要并保留全部原始要求');
  assert.equal(task.acceptance, original);
  assert.equal(task.mandate.acceptance, original);
  assert.equal(task.mandate.instruction, original);
  assert.match(f.database.assignments(task.id)[0].acceptance, /6–10条/);
  assert.equal(f.database.results(task.id).length, 0);
});

test('placeholder admission labels fail before creating a Trigger or resolving a work model', async t => {
  const f = await fixture(t);
  let resolutions = 0;
  f.ctx.llm.resolveModelInfo = async () => { resolutions++; throw Error('must not resolve placeholder work'); };
  for (const patch of [{ title: '执行任务' }, { title: 'process request' }, { text: '处理请求' }]) {
    await assert.rejects(f.service.delegate({ ...f.input, ...patch }, f.exec, f.options), { code: 'TASK_DESCRIPTION_GENERIC' });
  }
  assert.equal(resolutions, 0);
  assert.equal(f.database.listTasks().length, 0);
  assert.equal(f.approvals(), 0);
});

test('a concrete user title and business summary remain unchanged at admission', async t => {
  const f = await fixture(t);
  const title = '请求日志修复报告', text = '为用户修复请求日志页面，并提供原因、改动和验证结果';
  const task = await f.service.delegate({ ...f.input, title, text }, f.exec, f.options);
  assert.equal(task.title, title);
  assert.equal(task.target, text);
  assert.equal(task.mandate.instruction, '原始要求，请执行修复');
});

for (const original of ['做任务进度看板', '检查网站状态']) test(`new tasks with progress or status wording retain literal authority: ${original}`, async t => {
  const f = await fixture(t);
  f.events[1].data.content = [{ type: 'text', text: original }];
  const task = await f.service.delegate({ ...f.input, text: original, acceptance: '' }, f.exec, f.options);
  assert.equal(task.target, original);
  assert.equal(task.mandate.instruction, original);
  assert.equal(task.mandate.acceptance, original);
  assert.equal(task.mandate.policyVersion, f.policy.desktopVersion);
  assert.equal(task.mandate.source.messageId, 'original');
  assert.equal(task.mandate.controlledActions, 'require-current-policy-and-harness-approval');
  assert.equal(f.database.listTasks().length, 1);
  const extra = await f.service.delegate({ ...f.input, requestId: 'same-trigger-expanded', text: '额外发布网站', acceptance: '' }, f.exec, f.options);
  assert.notEqual(extra.id, task.id);
  assert.equal(f.database.listTasks().length, 2);
});
test('project-free delegation still rejects policy changes during model resolution', async t => {
  const f = await fixture(t);
  const { projectId, ...input } = f.input;
  f.ctx.llm.resolveModelInfo = async (provider, id) => { f.policy.desktopVersion = 'changed-policy'; return { provider, id }; };
  // Return policy snapshots as the production reader does.
  const service = createDesktopDelegationService({ ctx: f.ctx, database: f.database, readPolicy: async () => structuredClone(f.policy) });
  await assert.rejects(service.delegate(input, f.exec, f.options), /已变化/);
  assert.equal(f.database.listTasks().length, 0);
});

test('a notification-only turn cannot reuse a previous human instruction', async t => {
  const f = await fixture(t);
  f.events.push({ type: 'turn/end', data: { turn: 1 } }, { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: { id: 'notice', source: { kind: 'benchgo-subscription' }, content: [{ type: 'text', text: '执行另一个任务' }] } });
  await assert.rejects(f.service.delegate(f.input, f.exec, f.options), /当前原始用户消息/);
  assert.equal(f.approvals(), 0);
  assert.equal(f.database.listTasks().length, 0);
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
  assert.equal(f.database.listTasks().length, 0);
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
  assert.equal(f.database.listTasks().length, 0);
});

test('successful receipts preserve their exact original human source, including duplicate attachments', async t => {
  const f = await fixture(t);
  const task = await f.service.delegate(f.input, f.exec, f.options);
  f.events.push({ type: 'user/message', data: { id: 'later-message', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } });
  await assert.rejects(f.service.delegate(f.input, f.exec, f.options), { code: 'IDEMPOTENCY_CONFLICT' });
  const duplicate = { ...f.input, requestId: 'attachment-request', duplicateOfTaskId: task.id };
  assert.equal((await f.service.delegate(duplicate, f.exec, f.options)).id, task.id);
  assert.equal((await f.service.delegate(duplicate, f.exec, f.options)).id, task.id);
  f.events.push({ type: 'user/message', data: { id: 'third-message', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } });
  await assert.rejects(f.service.delegate(duplicate, f.exec, f.options), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(f.database.listTasks().length, 1);
});

test('Router can delegate a contextual retry directly without an auxiliary model or repeated permission', async t => {
  const f = await fixture(t);
  f.events[1].data.content = [{ type: 'text', text: '再来一次呗' }];
  // A broken review route cannot delay or veto this Router decision.
  f.policy.routingConfig = { auxiliary: { models: [{ providerId: 'unavailable', modelId: 'review' }], capabilities: ['review'] } };
  const task = await f.service.delegate({ ...f.input, title: '香港服务器巡检', text: '重跑香港服务器只读巡检', acceptance: '报告负载、内存、磁盘与服务状态，不修改服务器' }, f.exec, f.options);
  assert.equal(task.mandate.instruction, '再来一次呗');
  assert.equal(task.target, '重跑香港服务器只读巡检');
  assert.equal(task.mandate.controlledActions, 'require-current-policy-and-harness-approval');
  assert.equal(task.mandate.scopeCheck, undefined);
  assert.equal(f.modelRequests.length, 0);
  assert.equal(f.approvals(), 0);
  assert.equal(f.database.assignments(task.id).length, 1);
});

const questions = [{ id: 'retry', question: '重跑香港服务器只读巡检吗？', options: [{ label: '对，重跑香港服务器只读巡检' }] }];
const questionCall = () => ({ type: 'tool/call', data: { name: 'ask_user_question', callId: 'retry-call', arguments: JSON.stringify({ questions }) } });
const questionAnswer = () => ({ id: 'official-answer', source: { kind: 'user-question-reply', callId: 'retry-call', outcome: 'answered' },
  content: [{ type: 'text', text: JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId: 'retry-call', questions,
    answers: [{ id: 'retry', selected: ['对，重跑香港服务器只读巡检'] }] }) }] });

test('an immediate official card result keeps the original human instruction and permits the Router decision', async t => {
  const f = await fixture(t);
  f.events[1].data.content = [{ type: 'text', text: '再来一次呗' }];
  f.events.push(questionCall(), { type: 'tool/result', data: { message: { toolCallId: 'retry-call',
    content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'retry', selected: ['对，重跑香港服务器只读巡检'] }] }) }] } } });
  const task = await f.service.delegate({ ...f.input, text: '重跑香港服务器只读巡检' }, f.exec, f.options);
  assert.equal(task.mandate.source.messageId, 'original');
  assert.equal(task.mandate.instruction, '再来一次呗');
  assert.equal(f.modelRequests.length, 0);
  assert.equal(f.approvals(), 0);
});

test('a later official card reply binds its original question and becomes the current human source', async t => {
  const f = await fixture(t), answer = questionAnswer();
  f.events.push(questionCall(), { type: 'turn/end', data: { turn: 1 } }, { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: answer });
  const task = await f.service.delegate({ ...f.input, text: '重跑香港服务器只读巡检' }, f.exec, f.options);
  assert.equal(task.mandate.source.messageId, answer.id);
  assert.equal(task.mandate.instruction, answer.content[0].text, 'persist the real admitted message instead of invented plain-text authority');
  assert.equal(task.mandate.source.sessionId, f.ownerAgent.id);
  assert.equal(f.modelRequests.length, 0);
  assert.equal(f.approvals(), 0);
});

for (const mode of ['missing-call', 'wrong-call', 'wrong-question', 'machine', 'pending', 'skipped']) {
  test(`a ${mode} question reply cannot manufacture a current human delegation source`, async t => {
    const f = await fixture(t), answer = questionAnswer();
    if (mode !== 'missing-call') f.events.push(questionCall());
    if (mode === 'wrong-call') answer.source.callId = 'invented-call';
    if (mode === 'machine') answer.source.kind = 'benchgo-subscription';
    if (mode === 'pending') answer.source.outcome = 'pending';
    const payload = JSON.parse(answer.content[0].text);
    if (mode === 'wrong-question') payload.questions[0].question = '改为删除服务器数据？';
    if (mode === 'skipped') payload.answers[0].selected = [];
    answer.content[0].text = JSON.stringify(payload);
    f.events.push({ type: 'turn/end', data: { turn: 1 } }, { type: 'turn/start', data: { turn: 2 } }, { type: 'user/message', data: answer });
    await assert.rejects(f.service.delegate(f.input, f.exec, f.options), /当前原始用户消息/);
    assert.equal(f.database.listTasks().length, 0);
    assert.equal(f.modelRequests.length, 0);
  });
}

test('in-flight delegation keeps source and payload idempotency without a review cache', async t => {
  const f = await fixture(t);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  f.ctx.llm.resolveModelInfo = async (provider, id) => { enter(); await blocked; return { provider, id }; };
  const first = f.service.delegate(f.input, f.exec, f.options);
  await entered;
  await assert.rejects(f.service.delegate({ ...f.input, text: '不同任务' }, f.exec, f.options), { code: 'IDEMPOTENCY_CONFLICT' });
  const repeated = f.service.delegate(f.input, f.exec, f.options);
  release();
  const [task, receipt] = await Promise.all([first, repeated]);
  assert.equal(task.id, receipt.id);
  assert.equal(f.database.listTasks().length, 1);
  assert.equal(f.database.assignments(task.id).length, 1);
  assert.equal(f.modelRequests.length, 0);
});

for (const when of ['before', 'final-policy']) test(`cancellation ${when} still prevents task creation without a review stage`, async t => {
  const f = await fixture(t), controller = new AbortController();
  let reads = 0;
  if (when === 'before') controller.abort();
  const service = createDesktopDelegationService({ ctx: f.ctx, database: f.database, readPolicy: async () => {
    if (++reads === 2 && when === 'final-policy') controller.abort();
    return structuredClone(f.policy);
  } });
  await assert.rejects(service.delegate(f.input, { ...f.exec, signal: controller.signal }, f.options), { name: 'AbortError' });
  assert.equal(f.database.listTasks().length, 0);
  assert.equal(f.modelRequests.length, 0);
});

test('host-generated delegation identity replays after service restart and keeps multiple tasks on the real message', async t => {
  const f = await fixture(t), { requestId, ...input } = f.input;
  const first = await f.service.delegate(input, f.exec, f.options);
  const second = await f.service.delegate({ ...input, text: 'another explicit task' }, f.exec, f.options);
  const restarted = createDesktopDelegationService({ ctx: f.ctx, database: f.database, readPolicy: async () => f.policy });
  assert.equal((await restarted.delegate(input, f.exec, f.options)).id, first.id);
  assert.notEqual(first.id, second.id);
  assert.equal(first.mandate.source.messageId, second.mandate.source.messageId);
  assert.equal(f.database.listTasks().length, 2);
});
