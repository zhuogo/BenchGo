import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { publicConfig } from '../../voice/src/config.mjs';

const requireHarness = createRequire(new URL('../../../deepseek-harness/packages/core/agent-loop/package.json', import.meta.url));
const load = name => import(pathToFileURL(requireHarness.resolve(name)).href);
const compactionRequire = createRequire(new URL('../../../deepseek-harness/packages/compaction/compaction-basic/package.json', import.meta.url));
const compactionUrl = pathToFileURL(compactionRequire.resolve('@deepseek-ai/dsh-compaction-basic')).href;
const hook = registerHooks({ resolve(specifier, context, next) { return specifier === '@deepseek-ai/dsh-compaction-basic' ? { url: compactionUrl, shortCircuit: true } : next(specifier, context); } });
const { mountAssistant } = await import('../src/service.mjs');
const { Context } = await load('@deepseek-ai/cordis');
const { default: LlmRuntime, LlmAdapter } = await load('@deepseek-ai/dsh-llm');
const modules = await Promise.all(['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop'].map(load));

test('mounted assistant HTTP routes execute real Harness and register scoped tools', async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url === 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal') return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
    if (url === 'https://open.feishu.cn/open-apis/bot/v3/info') return Response.json({ code: 0, bot: { open_id: 'test-bot', app_name: 'Test bot' } });
    return originalFetch(url, options);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const directory = await mkdtemp(join(tmpdir(), 'assistant-mount-')), projectRoot = await mkdtemp(join(tmpdir(), 'assistant-project-')), ctx = new Context(), routes = new Map();
  t.after(async () => { await ctx.fiber.dispose(); hook.deregister(); await rm(directory, { recursive: true, force: true }); await rm(projectRoot, { recursive: true, force: true }); });
  await ctx.plugin(LlmRuntime);
  for (let i = 0; i < modules.length; i++) await ctx.plugin(modules[i].default, i === modules.length - 1 ? { agents: [] } : undefined);
  const tokenRequire = createRequire(new URL('../../../deepseek-harness/packages/llm/token-meter/package.json', import.meta.url));
  await ctx.plugin((await import(pathToFileURL(tokenRequire.resolve('@deepseek-ai/dsh-token-meter')).href)).default);
  let duringStream;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id }; }
    async *stream() { const callback = duringStream; duringStream = undefined; if (callback) await callback(); yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'Mounted reply' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Mounted reply' } }; yield { type: 'finish', reason: { kind: 'stop' } }; }
  }
  ctx.llm.registerAdapter(['mounted'], new Adapter());
  const scheduleEntries = [];
  ctx.provide('schedule', {
    catalog: async () => scheduleEntries,
    history: async () => ({ records: [] }),
    async create(request, actorSessionId) {
      assert.deepEqual(request.target, { kind: 'session', sessionId: actorSessionId });
      assert.deepEqual(request.timing, { kind: 'after', after_seconds: 60 });
      const entry = { ...request, id: 'schedule-service-fixture', status: 'active', createdAt: new Date().toISOString(), updatedAt: 'v1' };
      scheduleEntries.push(entry); return entry;
    },
    async edit(request, actorSessionId) {
      const entry = scheduleEntries.find(row => row.id === request.id);
      assert.equal(entry.target.sessionId, actorSessionId);
      assert.equal(request.expectedUpdatedAt, entry.updatedAt);
      if (request.action === 'delete') { scheduleEntries.splice(scheduleEntries.indexOf(entry), 1); return { id: entry.id, deleted: true }; }
      Object.assign(entry, request.patch, { updatedAt: 'v2' }); return entry;
    },
  });
  ctx.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } });
  ctx.provide('credentials', { resolve: async ref => ref === 'test-feishu-secret' ? { value: 'test-secret' } : undefined });
  ctx.provide('webServer', { register: () => () => {} });
  const workspaceEntity = Object.create({
    get id() { return 'project'; },
    get path() { return projectRoot; },
    get title() { return 'Project'; },
    get createdAt() { return '2026-01-01T00:00:00.000Z'; },
    get updatedAt() { return '2026-01-02T00:00:00.000Z'; },
    get sessionIds() { return ['session-1']; },
  });
  ctx.provide('workspaceRegistry', { list: () => [workspaceEntity], get: id => id === 'project' ? workspaceEntity : undefined });
  ctx.provide('sessionQuery', { listSessions: async () => ctx.sessions.list().map(s => ({ header: s.header })), readSession: async id => ({ events: ctx.sessions.get(id).snapshotEvents() }) });
  const commander = Object.assign(new EventEmitter(), { store: { directory }, list: () => [], catalog: () => [], providers: new Map() });
  const voiceRoutes = new Map();
  const providers = {
    resolve: async id => { const route = voiceRoutes.get(id); if (!route) throw Error('private-provider-error'); return route; },
  };
  // A scoped plugin context enforces Cordis injections, unlike the root
  // context. The skills service is intentionally absent in this composition.
  let appFiber;
  const app = await new Promise((resolve, reject) => {
    appFiber = ctx.inject(['connection', 'credentials', 'llm', 'agents', 'sessionQuery', 'sessionProjections', 'workspaceRegistry', 'tokenMeter'], child => {
      mountAssistant(child, commander, providers).then(resolve, reject);
    });
  });
  const call = async (input, peer) => routes.get('/api/commander/assistant').fetch(new Request('http://localhost/api/commander/assistant', { method: 'POST', body: JSON.stringify(input), headers: { 'content-type': 'application/json' } }), peer);
  for (const action of ['directReplyReconcile', 'outboxReconcile']) {
    const input = { action, id: 'missing', attempts: 1, outcome: 'unknown', evidence: '已检查上游回执' };
    assert.equal((await call(input)).status, 403);
    assert.equal((await call(input, { principal: { kind: 'device' } })).status, 403);
    assert.equal((await call(input, { principal: { kind: 'owner' } })).status, 404);
    assert.equal((await call({ ...input, attempts: 0 }, { principal: { kind: 'owner' } })).status, 400);
  }
  await assert.rejects(mountAssistant(ctx, commander, providers), { code: 'BENCHGO_DATA_LOCKED' });
  const connectionInitial = await (await call({ action: 'connections' })).json();
  assert.equal((await (await call({ action: 'ownedSkills' })).json()).available, false);
  assert.notEqual((await call({ action: 'ownedSkillApprove', id: 'missing', revision: 1 })).status, 200);
  assert.equal(connectionInitial.config.enabled, false);
  const connectionSaved = await call({ action: 'connectionConfigure', revision: connectionInitial.revision, patch: { appId: 'opaque-feishu-app' } });
  assert.equal(connectionSaved.status, 200);
  assert.equal((await connectionSaved.json()).config.appId, 'opaque-feishu-app');
  assert.notEqual((await call({ action: 'connectionConfigure', revision: 1, patch: { admissionMode: 'auto', enabledRuleIds: ['undefined-rule'] } })).status, 200);
  assert.equal((await (await call({ action: 'connections' })).json()).revision, 1);
  const connectionStatus = await (await call({ action: 'connectionStatus' })).json();
  assert.equal(connectionStatus.authentication, 'unverified');
  assert.equal(connectionStatus.configured, false);
  assert.notEqual((await call({ action: 'connectionVerify' })).status, 200);
  assert.notEqual((await call({ action: 'connectionConfigure', revision: connectionInitial.revision, patch: { enabled: true } })).status, 200);
  assert.equal((await call({ action: 'connectionConfigure', revision: 1, patch: { appSecretRef: 'test-feishu-secret' } })).status, 200);
  const verified = await (await call({ action: 'connectionVerify' })).json();
  assert.equal(verified.status.authentication, 'verified');
  assert.equal(verified.status.connection.state, 'stopped');
  assert.equal(verified.status.events, 'unverified');
  assert.equal(verified.status.sending, 'unverified');
  assert.equal(verified.config.botOpenId, 'test-bot');
  const verifiedAgain = await (await call({ action: 'connectionVerify' })).json();
  assert.equal(verifiedAgain.revision, verified.revision);
  assert.equal(verifiedAgain.status.connection.state, 'stopped');
  assert.equal(routes.size, 7);
  assert.ok(routes.has('/api/commander/assistant/pet-asset'));
  const systemListing = await call({ action: 'systemFiles' });
  assert.equal(systemListing.status, 200);
  assert.ok((await systemListing.json()).files.some(file => file.name === 'workspace' && file.kind === 'directory'));
  const systemFile = await routes.get('/api/commander/assistant/system-file').fetch(new Request('http://localhost/api/commander/assistant/system-file?file=missing'));
  assert.equal(systemFile.status, 404);
  let response = await call({ action: 'config', patch: { models: [{ providerId: 'mounted', modelId: 'exact' }] }, revision: 0 }); assert.equal(response.status, 200);
  response = await call({ action: 'config', patch: { name: 'conflict' }, revision: 0 }); assert.equal(response.status, 409);
  response = await call({ action: 'config', patch: { cardHtml: '<b>Service card</b>' } }); assert.equal(response.status, 200); assert.equal((await response.json()).cardHtml, '<b>Service card</b>');
  response = await call({ action: 'ensure' }); const { sessionId } = await response.json(); assert.ok(sessionId);
  const agent = await app.engine.ensureSession();
  const ticketsTool = ctx.tools.get('assistant_tickets', agent);
  assert.ok(ticketsTool);
  assert.deepEqual(await ticketsTool.execute({}, { agent }), { tickets: [], nextOffset: null });
  await assert.rejects(ticketsTool.execute({}, { agent: { id: 'child' } }), /只有总助手/);
  await assert.rejects(ticketsTool.execute({ op: 'get' }, { agent }), /需要 id/);
  app.store.orchestration.ingest({ dedupeKey: 'query-test', thread: { id: 'query-test', source: { type: 'desktop', id: 'query-test' } }, source: {}, actor: { kind: 'human', id: 'desktop-owner' }, content: 'Query proof', mode: 'direct' });
  const queryTicket = app.store.orchestration.createTicket({ threadId: 'query-test', target: 'Query proof', status: 'cancelled', mandate: { source: { channel: 'desktop', sessionId: String(agent.id) }, project: { id: 'project' } } });
  const queried = await ticketsTool.execute({ projectId: 'project' }, { agent });
  assert.equal(queried.tickets[0].id, queryTicket.id);
  assert.equal((await ticketsTool.execute({ op: 'get', id: queryTicket.id }, { agent })).ticket.target, 'Query proof');
  app.store.orchestration.cancelTicket(queryTicket.id);
  for (const name of ['assistant_projects', 'assistant_config', 'assistant_generate_image', 'assistant_summarize', 'assistant_analyze_image']) assert.ok(ctx.tools.get(name, agent), name);
  const projectsTool = ctx.tools.get('assistant_projects', agent);
  const projectsResult = await projectsTool.execute({}, { signal: new AbortController().signal, agent });
  assert.deepEqual(projectsResult.projects[0], {
    id: 'project', path: projectRoot, title: 'Project',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', sessionIds: ['session-1'],
  });
  assert.equal(Object.getPrototypeOf(projectsResult.projects[0]), Object.prototype);
  const summary = await call({ action: 'summarize', text: 'Original source text' });
  assert.equal(summary.status, 200);
  const summarized = await summary.json();
  assert.equal(summarized.text, 'Mounted reply');
  assert.equal(summarized.routing.capability, 'summary');
  assert.equal(summarized.routing.attempts[0].modelId, 'exact');
  assert.equal(summarized.source.complete, true);
  assert.equal((await call({ action: 'analyzeImage', file: 'missing.png', question: 'Describe' })).status, 503);
  assert.equal(ctx.tools.get('assistant_task_verify', agent), undefined);
  assert.equal(ctx.tools.get('assistant_task_followup', agent), undefined);
  assert.notEqual((await call({ action: 'taskFollowup', id: 'old-task', text: 'More', requestId: 'retired' })).status, 200);
  for (const name of ['assistant_files', 'assistant_search', 'assistant_triggers']) assert.equal(ctx.tools.get(name, agent), undefined, name);
  const scheduleTool = ctx.tools.get('schedule_create', agent);
  assert.ok(scheduleTool, 'assistant tools adapt the current Host Schedule service');
  const scheduleExec = { agent, signal: new AbortController().signal };
  const scheduled = await scheduleTool.execute({ title: '检查提醒', prompt: '按原要求检查', after_seconds: 60 }, scheduleExec);
  assert.equal(scheduled.target.sessionId, agent.id);
  const schedules = await ctx.tools.get('schedule_list', agent).execute({}, scheduleExec);
  assert.deepEqual(schedules.map(row => row.id), [scheduled.id]);
  const createdHistory = await (await call({ action: 'history' })).json();
  assert.equal(createdHistory.notifications.find(row => row.schedule?.id === scheduled.id).schedule.phase, 'created');
  assert.equal((await (await call({ action: 'notificationSync' })).json()).events.filter(row => row.schedule?.id === scheduled.id).length, 1);
  await ctx.tools.get('schedule_update', agent).execute({ id: scheduled.id, title: '新提醒' }, scheduleExec);
  assert.equal(scheduleEntries[0].title, '新提醒');
  await assert.rejects(scheduleTool.execute({ title: 'forged', prompt: 'forged', after_seconds: 60 }, { agent: { id: 'child' } }), /只有总助手/);
  assert.equal((await ctx.tools.get('schedule_delete', agent).execute({ id: scheduled.id }, scheduleExec)).deleted, true);
  response = await call({ action: 'send', text: 'hello', requestId: 'mounted-request' }); assert.equal(response.status, 200); await agent.whenIdle();
  response = await call({ action: 'send', text: 'hello', requestId: 'mounted-request' }); assert.equal((await response.json()).duplicate, true);
  // This section validates budget HTTP contracts against a mounted runtime.
  // Its empty project is not an executable Git/worktree fixture: reserve claims
  // while exercising queued pause/resume so a timer cannot start unrelated work.
  const claimAssignments = app.store.orchestration.claimAssignments;
  app.store.orchestration.claimAssignments = () => [];
  t.after(() => { app.store.orchestration.claimAssignments = claimAssignments; });
  const formGoal = { requestId: 'form-goal', objective: 'Resource goal', projectId: 'project', provider: 'mounted', model: 'exact', text: 'Resource task', acceptance: 'Evidence', budget: { requests: 1 } };
  const formCreatedResponse = await call({ action: 'goalCreate', goal: formGoal });
  assert.equal(formCreatedResponse.status, 200);
  const formCreated = await formCreatedResponse.json();
  assert.equal(formCreated.executionKind, 'ticket');
  assert.equal((await (await call({ action: 'goalCreate', goal: formGoal })).json()).id, formCreated.id);
  assert.equal((await call({ action: 'goalCreate', goal: { ...formGoal, text: 'Changed' } })).status, 409);
  const formTicket = app.store.orchestration.getTicket(formCreated.ticketIds[0]);
  assert.equal(formTicket.mandate.instruction, JSON.stringify(formGoal));
  assert.equal(formTicket.mandate.source.messageId, 'goal-form:form-goal');
  const initialBudget = await (await call({ action: 'goalBudgetGet', id: formCreated.id })).json();
  assert.deepEqual(initialBudget.budget, { requests: 1 });
  assert.equal(initialBudget.usage.requests, 0);
  assert.equal(app.store.orchestration.reserveGoalRequest({ ticketId: formTicket.id, requestId: 'form-budget-use' }).allowed, true);
  app.store.orchestration.pauseTicket(formTicket.id, { reason: { kind: 'budget', goalId: initialBudget.goalId, reason: 'requests' } });
  // The real runtime may have claimed the assignment while HTTP assertions ran.
  // Wait for its stop acknowledgement before asserting the stable paused state.
  for (let attempt = 0; attempt < 200 && app.store.orchestration.getTicket(formTicket.id).status === 'pausing'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const waitingGoal = await (await call({ action: 'goalAdvance', id: formCreated.id })).json();
  assert.equal(waitingGoal.waitReason, 'budget');
  assert.notEqual((await call({ action: 'goalBudgetResume', id: formCreated.id, rowVersion: waitingGoal.rowVersion })).status, 200);
  assert.ok(['paused', 'pausing'].includes(app.store.orchestration.getTicket(formTicket.id).status));
  assert.equal((await call({ action: 'goalBudgetUpdate', id: formCreated.id, budget: { requests: 2 } })).status, 400);
  assert.equal((await call({ action: 'goalBudgetUpdate', id: formCreated.id, expectedVersion: initialBudget.version, budget: { cost: 1 } })).status, 400);
  const budgetResponse = await call({ action: 'goalBudgetUpdate', id: formCreated.id, expectedVersion: initialBudget.version, budget: { requests: 2 } });
  assert.equal(budgetResponse.status, 200);
  const updatedBudget = await budgetResponse.json();
  assert.equal(updatedBudget.usage.requests, 1);
  assert.equal(updatedBudget.version, initialBudget.version + 1);
  assert.ok(['paused', 'pausing'].includes(app.store.orchestration.getTicket(formTicket.id).status), 'adjustment does not resume execution');
  assert.equal((await call({ action: 'goalBudgetUpdate', id: formCreated.id, expectedVersion: initialBudget.version, budget: { requests: 9 } })).status, 409);
  assert.equal((await call({ action: 'goalBudgetResume', id: formCreated.id, rowVersion: -1 })).status, 409);
  const currentGoal = await (await call({ action: 'goalGet', id: formCreated.id })).json();
  const budgetResumedResponse = await call({ action: 'goalBudgetResume', id: formCreated.id, rowVersion: currentGoal.rowVersion });
  assert.equal(budgetResumedResponse.status, 200, await budgetResumedResponse.clone().text());
  const budgetResumed = await budgetResumedResponse.json();
  assert.equal(app.store.orchestration.getTicket(formTicket.id).status, 'open');
  assert.equal((await (await call({ action: 'goalGet', id: formCreated.id })).json()).budgetState.usage.requests, 1);
  const cancelledForm = await call({ action: 'goalCancel', id: formCreated.id, rowVersion: budgetResumed.rowVersion });
  assert.equal(cancelledForm.status, 200);
  assert.equal((await cancelledForm.json()).status, 'cancelled');
  assert.equal(app.store.orchestration.getTicket(formTicket.id).status, 'cancelled');
  app.store.orchestration.claimAssignments = claimAssignments;
  let streamFailure;
  duringStream = async () => { try {
  const delegateTool = ctx.tools.get('assistant_delegate', agent);
  assert.ok(delegateTool.parameters.required.includes('acceptance'));
  assert.equal(delegateTool.parameters.required.includes('provider'), false);
  assert.equal(delegateTool.parameters.required.includes('model'), false);
  assert.equal(delegateTool.parameters.properties.duplicateOfTicketId.type, 'string');
  const configSchema = ctx.tools.get('assistant_config', agent).parameters.properties.patch.properties;
  assert.equal(configSchema.models.maxItems, 32);
  assert.equal(configSchema.workerModels.maxItems, 32);
  assert.ok(delegateTool.parameters.properties.title);
  const goalTool = ctx.tools.get('assistant_goals', agent);
  await assert.rejects(goalTool.execute({ op: 'list' }, { agent: { id: 'child' } }), /只有总助手/);
  const goalInput = { requestId: 'owned-goal', objective: 'Deferred work', projectId: 'project', provider: 'mounted', model: 'exact', text: 'Wait' };
  const ownedGoal = await goalTool.execute({ op: 'create', goal: goalInput }, { agent, authorized: true });
  assert.equal(ownedGoal.ownerSessionId, agent.id);
  assert.equal(ownedGoal.executionKind, 'ticket');
  assert.equal(ownedGoal.ticketIds.length, 1);
  assert.equal((await goalTool.execute({ op: 'list' }, { agent })).goals.length, 2);
  assert.equal((await goalTool.execute({ op: 'create', goal: goalInput }, { agent, authorized: true })).id, ownedGoal.id);
  const pausedGoal = await (await call({ action: 'goalPause', id: ownedGoal.id, rowVersion: ownedGoal.rowVersion })).json();
  assert.equal((await call({ action: 'goalResume', id: ownedGoal.id, rowVersion: ownedGoal.rowVersion })).status, 409);
  assert.equal((await call({ action: 'goalResume', id: ownedGoal.id, rowVersion: pausedGoal.rowVersion })).status, 200);
  app.store.orchestration.cancelTicket(ownedGoal.ticketIds[0]);
  } catch (error) { streamFailure = error; } };
  await call({ action: 'send', text: 'hello', requestId: 'current-goal-authority-turn' });
  await agent.whenIdle();
  if (streamFailure) throw streamFailure;
  duringStream = async () => { try {
  const delegateTool = ctx.tools.get('assistant_delegate', agent);
  const delegation = { projectId: 'project', provider: 'mounted', model: 'exact', title: '检查项目', text: 'Inspect project', acceptance: 'Report project findings with evidence; preserve the original human requirements.', requestId: 'desktop-delegation' };
  await assert.rejects(delegateTool.execute(delegation, { agent: { id: 'child' }, authorized: true }), /只有总助手/);
  const ticket = await delegateTool.execute(delegation, { agent, authorized: true });
  assert.equal(ticket.mandate.instruction, 'hello');
  assert.equal((await delegateTool.execute(delegation, { agent, authorized: true })).id, ticket.id);
  assert.ok((await (await call({ action: 'tickets' })).json()).tickets.some(row => row.id === ticket.id));
  assert.equal((await (await call({ action: 'ticketStop', ticketId: ticket.id })).json()).status, 'cancelled');
  const questionTicket = app.store.orchestration.createTicket({ threadId: ticket.threadId, target: 'Question', mandate: ticket.mandate });
  app.store.orchestration.createAssignment(questionTicket.id, {});
  const [questionAssignment] = app.store.orchestration.claimAssignments('test-worker', { validateMandate: () => true });
  const ownership = { owner: questionAssignment.owner, fence: questionAssignment.fence };
  const questionRun = app.store.orchestration.prepareRun(questionAssignment.id, { ...ownership, sessionId: 'question-session', directory });
  app.store.orchestration.updateRun(questionRun.id, { ...ownership, state: 'submitted' });
  const [attention] = app.store.orchestration.openAttention(questionAssignment.id, { ...ownership, sessionId: questionRun.sessionId, callId: 'ask', questions: [{ id: 'q', question: 'Which?', options: [{ label: 'Exact' }] }] });
  const answerInput = { action: 'ticketAnswer', ticketId: questionTicket.id, attentionId: attention.id, instructionRevision: 1, requestId: 'answer', answer: { selected: ['Exact'] } };
  let questionNotifications = [];
  for (let attempt = 0; attempt < 60; attempt++) {
    questionNotifications = app.database.notifications().events.filter(event => event.taskId === questionTicket.id);
    if (questionNotifications.length) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(questionNotifications.length, 1);
  assert.equal(questionNotifications[0].type, 'ticket.attention');
  assert.equal(questionNotifications[0].text, 'Which?\nExact');
  const pendingHistory = await (await call({ action: 'history' })).json();
  assert.equal(pendingHistory.notifications.find(row => row.attentionId === attention.id).currentAttention.id, attention.id);
  assert.equal((await call(answerInput)).status, 200);
  const invalidReview = await call({ action: 'ticketRetryReview', ticketId: questionTicket.id, expectedResultVersion: 1 });
  assert.equal(invalidReview.status, 400);
  assert.match(await invalidReview.text(), /工单待验收状态已变化/);
  assert.equal((await (await call(answerInput)).json()).duplicate, true);
  const crossSite = await routes.get('/api/commander/assistant').fetch(new Request('http://localhost/api/commander/assistant', { method: 'POST', body: JSON.stringify(answerInput), headers: { origin: 'https://foreign.invalid' } }));
  assert.equal(crossSite.status, 403);
  const chatHistory = await (await call({ action: 'history' })).json();
  const chatQuestion = chatHistory.notifications.find(row => row.attentionId === attention.id);
  assert.equal(chatQuestion.attention.state, 'answered');
  assert.equal(chatQuestion.attention.instructionRevision, questionAssignment.instructionRevision);
  assert.equal(chatQuestion.currentInstructionRevision, questionTicket.instructionRevision);
  assert.equal(chatQuestion.currentResultVersion, questionTicket.resultVersion);
  assert.equal(chatQuestion.currentAttention, null);
  assert.equal(chatQuestion.currentResult, null);
  assert.equal(chatQuestion.currentPauseReason, null);
  assert.ok(Array.isArray(await (await call({ action: 'requestState' })).json()));
  app.store.orchestration.cancelTicket(questionTicket.id);
  } catch (error) { streamFailure = error; } };
  await call({ action: 'send', text: 'hello', requestId: 'current-authority-turn' });
  await agent.whenIdle();
  if (streamFailure) throw streamFailure;
  const memoryTool = ctx.tools.get('assistant_memory', agent);
  await assert.rejects(memoryTool.execute({ content: '无当前用户回合' }, { agent, callId: 'outside-turn' }), /当前原始用户消息/);
  await assert.rejects(memoryTool.execute({ content: '伪造来源' }, { agent: { id: 'child' }, callId: 'spoofed', authorized: true }), /只有总助手/);
  duringStream = async () => { try {
    const before = app.store.orchestration.listTickets().length;
    const exec = { agent, callId: 'direct-memory', signal: new AbortController().signal };
    const memory = await memoryTool.execute({ content: '偏好完整说明' }, exec);
    const duplicate = await memoryTool.execute({ content: '偏好完整说明' }, exec);
    assert.equal(duplicate.id, memory.id);
    assert.equal(duplicate.revision, memory.revision);
    assert.equal(memory.source.role, 'user');
    assert.ok(memory.source.messageId);
    assert.equal(memory.source.sessionId, String(agent.id));
    assert.equal((await app.store.memory.search({ query: '完整说明' }))[0].id, memory.id);
    const corrected = await memoryTool.execute({ id: memory.id, content: '偏好简洁说明', revision: memory.revision }, { ...exec, callId: 'correct-memory' });
    assert.equal(corrected.revision, memory.revision + 1);
    await assert.rejects(memoryTool.execute({ id: memory.id, content: '过期修改', revision: memory.revision }, { ...exec, callId: 'stale-memory' }), { code: 'REVISION_CONFLICT' });
    assert.deepEqual(await memoryTool.execute({ id: memory.id, remove: true, revision: corrected.revision }, { ...exec, callId: 'forget-memory' }), { removed: true });
    assert.equal((await app.store.memory.search({ query: '简洁说明' })).length, 0);
    assert.equal(app.store.orchestration.listTickets().length, before, 'memory CRUD creates no action Ticket or approval workflow');
  } catch (error) { streamFailure = error; } };
  await call({ action: 'send', text: '请记住偏好完整说明，再纠正并遗忘这条记忆。', requestId: 'direct-memory-turn' });
  await agent.whenIdle();
  if (streamFailure) throw streamFailure;
  response = await call({ action: 'memorySave', memory: { content: 'Prefer concise answers' } }); assert.equal(response.status, 200);
  response = await call({ action: 'state' }); const snapshot = await response.json(); assert.equal(snapshot.memories[0].content, 'Prefer concise answers');
  response = await call({ action: 'skillsSearch' }); assert.equal(response.status, 400);
  for (const kind of ['image', 'asr', 'tts']) { assert.equal(snapshot.media[kind].available, false); assert.ok(snapshot.media[kind].reason); }
  response = await call({ action: 'catalog' }); const catalog = await response.json(); assert.ok(Array.isArray(catalog.providers)); assert.ok(Array.isArray(catalog.models));
  const configTool = ctx.tools.get('assistant_config', agent);
  assert.deepEqual(configTool.output.render({}, { name: 'test' }), [{ type: 'text', text: '{"name":"test"}' }]);
  assert.match(configTool.description, /cardHtml/); assert.match(configTool.description, /16000/);
  assert.equal(configTool.parameters.properties.patch.properties.cardMotion.type, 'boolean');
  assert.match(configTool.description, /asr\/tts are legacy/); assert.match(configTool.description, /设置 → 媒体 → 语音/);
  const toolExec = { signal: new AbortController().signal };
  const initialConfig = await configTool.execute({}, toolExec);
  assert.equal(initialConfig.cardHtml, '<b>Service card</b>');
  assert.equal(initialConfig.cardMotion, true);
  const toolResult = await configTool.execute({ patch: { cardHtml: '<i>Tool card</i>', cardMotion: false }, revision: initialConfig.revision }, toolExec);
  assert.equal(toolResult.cardMotion, false);
  response = await call({ action: 'state' });
  assert.deepEqual((await response.json()).config, toolResult);
  assert.equal(toolResult.name, initialConfig.name);
  assert.deepEqual(toolResult.models, [{ providerId: 'mounted', modelId: 'exact' }]);
  for (const cardMotion of [null, 0, 'false', {}]) {
    response = await call({ action: 'config', patch: { cardMotion } }); assert.equal(response.status, 400);
    await assert.rejects(configTool.execute({ patch: { cardMotion } }, toolExec), /Invalid/);
  }
  response = await call({ action: 'config', patch: { cardMotion: true }, revision: toolResult.revision });
  assert.equal(response.status, 200);
  const motionConfig = await response.json();
  assert.equal(motionConfig.cardMotion, true);
  assert.equal(motionConfig.cardHtml, toolResult.cardHtml);
  assert.equal(motionConfig.name, toolResult.name);
  assert.deepEqual(motionConfig.models, toolResult.models);
  for (const cardHtml of [{}, false, 'x'.repeat(16001)]) {
    response = await call({ action: 'config', patch: { cardHtml } }); assert.equal(response.status, 400);
    await assert.rejects(configTool.execute({ patch: { cardHtml } }, toolExec), /Invalid/);
  }
  response = await call({ action: 'config', patch: { cardHtml: '' }, revision: initialConfig.revision }); assert.equal(response.status, 409);
  assert.equal((await configTool.execute({}, toolExec)).cardHtml, '<i>Tool card</i>');
  await configTool.execute({ patch: { cardHtml: ' \n ' } }, toolExec);
  response = await call({ action: 'state' }); assert.equal((await response.json()).config.cardHtml, null);
  const keyPools = [{ providerId: 'pool-main', candidates: ['pool-backup'] }];
  response = await call({ action: 'config', patch: { keyPools } });
  assert.equal(response.status, 400);
  await assert.rejects(configTool.execute({ patch: { keyPools } }, toolExec), { code: 'KEY_POOL_REMOVED' });
  assert.equal(Object.hasOwn(await configTool.execute({}, toolExec), 'keyPools'), false);
  await configTool.execute({ patch: { keyPools: [] } }, toolExec);
  response = await call({ action: 'history' }); assert.equal((await response.json()).messages.at(-1).text, 'Mounted reply');
  response = await call({ action: 'sessionSearch', query: 'Mounted' }); assert.equal((await response.json()).results.at(-1).text, 'Mounted reply');
  response = await call({ action: 'archiveThread', threadId: 'main' }); assert.equal(response.status, 400);
  response = await call({ action: 'unknown' }); assert.equal(response.status, 400);
  const artifact = routes.get('/api/commander/assistant/artifact');
  assert.equal((await artifact.fetch(new Request('http://localhost/artifact?file=../config.json'))).status, 400);
  assert.equal((await artifact.fetch(new Request('http://localhost/artifact?file=missing.png'))).status, 404);
  const petCatalog = await (await call({ action: 'petCatalog' })).json();
  assert.ok(petCatalog.expressions.some(item => item.id === 'happy'));
  const petTool = ctx.tools.get('assistant_pet', agent);
  assert.ok(petTool, 'the Router exposes the same pet service');
  const { config: petBefore } = await (await call({ action: 'state' })).json();
  const petDraftResponse = await call({ action: 'petPreview', pet: { expression: 'happy', decorations: ['scarf'], palette: 'default' } });
  assert.equal(petDraftResponse.status, 200);
  const petDraft = await petDraftResponse.json();
  assert.ok(petDraft.draftId);
  const petApplyResponse = await call({ action: 'petApply', draftId: petDraft.draftId, revision: petBefore.revision });
  assert.equal(petApplyResponse.status, 200, await petApplyResponse.clone().text());
  const petApplied = await petApplyResponse.json();
  assert.equal(petApplied.pet.expression, 'happy');
  assert.equal(petApplied.name, petBefore.name);
  assert.equal(petApplied.cardHtml, petBefore.cardHtml);
  assert.deepEqual(petApplied.models, petBefore.models);
  assert.notEqual((await call({ action: 'config', patch: { pet: null } })).status, 200, 'plain config cannot bypass appearance validation');
  assert.equal((await call({ action: 'petRestore', revision: petApplied.revision, default: true })).status, 200);
  assert.equal((await routes.get('/api/commander/assistant/pet-asset').fetch(new Request('http://localhost/pet-asset?id=../../config.json'))).status, 404);
  const speech = routes.get('/api/commander/assistant/voice/speech');
  response = await speech.fetch(new Request('http://localhost/speech', { method: 'POST', body: JSON.stringify({ text: 'Hello' }), headers: { 'content-type': 'application/json' } }));
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'VOICE_UNAVAILABLE');
  response = await speech.fetch(new Request('http://localhost/speech', { method: 'POST', body: JSON.stringify({ text: 'Hello' }), headers: { 'content-type': 'application/json', origin: 'http://evil.example', host: 'localhost' } }));
  assert.equal(response.status, 403); await response.json();
  const capabilityTool = ctx.tools.get('assistant_capabilities', agent);
  const checkCapabilities = async expected => {
    const http = await (await call({ action: 'capabilities' })).json();
    assert.deepEqual(await capabilityTool.execute({}, toolExec), http, 'HTTP and tool expose one contract');
    for (const [name, available] of Object.entries(expected)) {
      assert.equal(http.available[name], available, name);
      assert.equal(typeof http.reasons[name] === 'string', !available, name);
    }
    assert.equal(JSON.stringify(http).includes('private-provider-error'), false);
    return http;
  };
  await checkCapabilities({ voiceInput: false, readAloud: false, realtimeVoice: false });
  const sharedVoice = { value: { dictation: true, readAloud: true, call: true, asr: { providerId: 'voice-asr', model: 'Opaque ASR:07', protocol: 'openai-websocket' }, tts: { providerId: 'voice-tts', model: 'Opaque TTS:09', protocol: 'speech' } }, snapshot() { return publicConfig(this.value); } };
  // Match plugin.mjs: shared Voice and assistant are provided by sibling injection fibers.
  ctx.inject(['connection', 'credentials', 'llm'], child => { child.provide('voice', sharedVoice); });
  await new Promise(resolve => setImmediate(resolve));
  voiceRoutes.set('voice-asr', { baseURL: 'https://voice-asr.test/v1', apiKey: 'voice-asr-secret' });
  voiceRoutes.set('voice-tts', { baseURL: 'https://voice-tts.test/v1', apiKey: 'voice-tts-secret' });
  const configured = await checkCapabilities({ voiceInput: true, readAloud: true, realtimeVoice: true });
  assert.equal(JSON.stringify(configured).includes('voice-asr-secret'), false);
  response = await call({ action: 'config', patch: { asr: { providerId: 'legacy-asr', modelId: 'legacy-model', protocol: 'transcriptions' }, tts: null } });
  assert.equal(response.status, 200);
  await checkCapabilities({ voiceInput: true, readAloud: true, realtimeVoice: true });
  voiceRoutes.delete('voice-asr');
  await checkCapabilities({ voiceInput: false, readAloud: true, realtimeVoice: false });
  voiceRoutes.set('voice-asr', { baseURL: 'https://voice-asr.test/v1', apiKey: 'voice-asr-secret' });
  sharedVoice.value.dictation = false; sharedVoice.value.call = false;
  await checkCapabilities({ voiceInput: false, readAloud: true, realtimeVoice: false });
  sharedVoice.value.dictation = true; sharedVoice.value.call = true;
  sharedVoice.value.asr.protocol = 'unsupported';
  await checkCapabilities({ voiceInput: false, readAloud: true, realtimeVoice: false });
  sharedVoice.value.readAloud = false;
  response = await speech.fetch(new Request('http://localhost/speech', { method: 'POST', body: JSON.stringify({ text: 'Hello' }), headers: { 'content-type': 'application/json' } }));
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'VOICE_UNAVAILABLE');
  assert.equal(commander.listenerCount('event'), 0);
  await appFiber.dispose();
  assert.equal(routes.size, 0, 'disabling SuperAgent releases only its own routes');
  assert.equal(commander.listenerCount('event'), 0, 'disabling SuperAgent removes its Harness event listener');
  assert.ok(ctx.llm, 'official Harness services remain available');
  assert.equal(ctx.get('voice'), sharedVoice, 'Voice stays available after SuperAgent is disabled');
  await assert.rejects(app.dispatch({ action: 'state' }), { code: 'ASSISTANT_UNAVAILABLE' });
  await app.dispose();
  const skillModule = await import('../../../deepseek-harness/packages/skill/skill/lib/index.js');
  await ctx.plugin(skillModule.default);
  let skillFiber;
  const withSkills = await new Promise((resolve, reject) => {
    skillFiber = ctx.inject(['connection', 'credentials', 'llm', 'agents', 'sessionQuery', 'sessionProjections', 'workspaceRegistry', 'tokenMeter'], child => {
      mountAssistant(child, commander, providers).then(resolve, reject);
    });
  });
  const candidate = withSkills.store.ownedSkills.propose({ name: 'service-check', description: 'Check service behavior', content: '## When to Use\nService changes\n## Procedure\nCheck behavior\n## Pitfalls\nKeep evidence\n## Verification\nRead results', source: { messageId: 'source' }, idempotencyKey: 'service-review' });
  assert.equal((await (await call({ action: 'ownedSkills' })).json()).available, true);
  assert.equal(await ctx.skills.get(candidate.name), undefined);
  const approved = await call({ action: 'ownedSkillApprove', id: candidate.id, revision: candidate.revision });
  assert.equal(approved.status, 200);
  const active = await approved.json();
  assert.equal((await ctx.skills.get(candidate.name)).content, candidate.content);
  assert.equal((await (await call({ action: 'ownedSkillAudit', id: candidate.id })).json()).events.length, 1);
  assert.equal((await call({ action: 'ownedSkillPin', id: candidate.id, revision: active.revision, pinned: true })).status, 200);
  assert.notEqual((await call({ action: 'ownedSkillPin', id: candidate.id, revision: active.revision, pinned: false })).status, 200);
  await skillFiber.dispose();
  assert.equal(await ctx.skills.get(candidate.name), undefined);
});
