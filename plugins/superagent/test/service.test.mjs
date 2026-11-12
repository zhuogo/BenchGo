import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { publicConfig } from '../../voice/src/config.mjs';
import { createSettingsManagement } from '../../benchgo/src/settings-management.mjs';
import { installRoleHost, loadRolePackage } from './role-host-fixture.mjs';

const requireHarness = createRequire(new URL('../../../deepseek-harness/packages/core/agent-loop/package.json', import.meta.url));
const load = name => import(pathToFileURL(requireHarness.resolve(name)).href);
const compactionRequire = createRequire(new URL('../../../deepseek-harness/packages/compaction/compaction-basic/package.json', import.meta.url));
const compactionUrl = pathToFileURL(compactionRequire.resolve('@deepseek-ai/dsh-compaction-basic')).href;
const sessionUrl = pathToFileURL(requireHarness.resolve('@deepseek-ai/dsh-session')).href;
const hook = registerHooks({ resolve(specifier, context, next) {
  const url = specifier === '@deepseek-ai/dsh-compaction-basic' ? compactionUrl : specifier === '@deepseek-ai/dsh-session' ? sessionUrl : undefined;
  return url ? { url, shortCircuit: true } : next(specifier, context);
} });
const { mountAssistant } = await import('../src/service.mjs');
const { inject: assistantInject } = await import('../src/plugin.mjs');
const { readAssessmentPolicy } = await import('../src/assessment-policy.mjs');
const { commitWorkerResult } = await import('../src/result-commit.mjs');
const { Context } = await load('@deepseek-ai/cordis');
const { default: LlmRuntime, LlmAdapter } = await load('@deepseek-ai/dsh-llm');
const modules = await Promise.all(['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop'].map(load));
const gatewayRequire = createRequire(new URL('../../../deepseek-harness/packages/api/gateway/package.json', import.meta.url));
const { default: TypertRegistry } = await import(pathToFileURL(gatewayRequire.resolve('@deepseek-ai/dsh-typert-registry')).href);
const SessionPersistence = await load('@deepseek-ai/dsh-session-persistence-jsonl');
const queryRequire = createRequire(new URL('../../../deepseek-harness/packages/session-query/session-query-sqlite/package.json', import.meta.url));
const SessionQuery = await import(pathToFileURL(queryRequire.resolve('@deepseek-ai/dsh-session-query-sqlite')).href);

test('mounted assistant HTTP routes execute real Harness and register scoped tools', { timeout: 120_000 }, async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url === 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal') return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
    if (url === 'https://open.feishu.cn/open-apis/bot/v3/info') return Response.json({ code: 0, bot: { open_id: 'test-bot', app_name: 'Test bot' } });
    return originalFetch(url, options);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const directory = await mkdtemp(join(tmpdir(), 'assistant-mount-')), projectRoot = await mkdtemp(join(tmpdir(), 'assistant-project-')), ctx = new Context(), routes = new Map();
  const settingsManagement = createSettingsManagement({ directory });
  ctx.provide('benchgoSettings', settingsManagement);
  t.after(async () => { await ctx.fiber.dispose(); await settingsManagement.close(); hook.deregister(); await rm(directory, { recursive: true, force: true }); await rm(projectRoot, { recursive: true, force: true }); });
  await ctx.plugin(LlmRuntime);
  for (let i = 0; i < modules.length; i++) await ctx.plugin(modules[i].default, i === modules.length - 1 ? { agents: [] } : undefined);
  await ctx.plugin(TypertRegistry);
  await installRoleHost(ctx);
  await ctx.plugin((await loadRolePackage('fs/fs-local', '@deepseek-ai/dsh-fs-local')).default);
  await ctx.plugin((await loadRolePackage('session/working-directory', '@deepseek-ai/dsh-working-directory')).default, { defaultDirectory: directory });
  await ctx.plugin((await loadRolePackage('subagent/subagent', '@deepseek-ai/dsh-subagent')).default);
  assert.ok(ctx.get('subagents'), 'the official subagent service must be ready before mounting SuperAgent');
  await ctx.plugin(SessionPersistence.default || SessionPersistence, { root: join(directory, 'official-sessions'), compression: 'none' });
  await ctx.plugin(SessionQuery.default || SessionQuery, { path: ':memory:', openAt: 'first-search' });
  const tokenRequire = createRequire(new URL('../../../deepseek-harness/packages/llm/token-meter/package.json', import.meta.url));
  await ctx.plugin((await import(pathToFileURL(tokenRequire.resolve('@deepseek-ai/dsh-token-meter')).href)).default);
  let duringStream;
  const modelRequests = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 131072 } }; }
    async *stream(request) {
      modelRequests.push(request);
      const callback = duringStream; duringStream = undefined; if (callback) await callback();
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'Mounted reply' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Mounted reply' } }; yield { type: 'finish', reason: { kind: 'stop' } };
    }
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
  const commander = Object.assign(new EventEmitter(), { store: { directory }, list: () => [], catalog: () => [], providers: new Map() });
  const voiceRoutes = new Map();
  const providers = {
    resolve: async id => { const route = voiceRoutes.get(id); if (!route) throw Error('private-provider-error'); return route; },
  };
  // A scoped plugin context enforces Cordis injections, unlike the root
  // context. The skills service is intentionally absent in this composition.
  let missingSessionsFiber;
  const missingSessionsContext = await new Promise(resolve => {
    missingSessionsFiber = ctx.inject(['agents'], resolve);
  });
  assert.throws(() => missingSessionsContext.sessions.get('saved-router-session'), { message: 'cannot get property "sessions" without inject' });
  await missingSessionsFiber.dispose();
  assert.ok(assistantInject.includes('sessions'), 'the real plugin must retain the session flush dependency');
  assert.ok(assistantInject.includes('benchgoSettings'), 'the scoped plugin must receive the real settings manager');
  let appFiber;
  let mountTimer;
  const app = await new Promise((resolve, reject) => {
    mountTimer = setTimeout(() => reject(new Error('SuperAgent fixture mount timed out after 15s; missing dependencies: ' + assistantInject.filter(name => !['benchgo', 'commander', 'settings'].includes(name) && !ctx.get(name)).join(', '))), 15_000);
    // BenchGo/Commander/settings are supplied directly by this fixture; all
    // actual service access uses the production plugin dependency declaration.
    appFiber = ctx.inject(assistantInject.filter(name => !['benchgo', 'commander', 'settings'].includes(name)), child => {
      mountAssistant(child, commander, providers).then(resolve, reject);
    });
  }).finally(() => clearTimeout(mountTimer));
  const ownerPeer = { principal: { kind: 'owner' } };
  const call = async (input, ...peers) => {
    // Official exact Fetch routes expose the authenticated peer through the
    // connection service, not a second fetch() argument.
    ctx.connection.browserPeer = peers.length ? peers[0] : ownerPeer;
    return routes.get('/api/commander/assistant').fetch(new Request('http://localhost/api/commander/assistant', { method: 'POST', body: JSON.stringify(input), headers: { 'content-type': 'application/json' } }));
  };
  for (const action of ['directReplyReconcile', 'outboxReconcile']) {
    const input = { action, id: 'missing', attempts: 1, outcome: 'unknown', evidence: '已检查上游回执' };
    assert.equal((await call(input, undefined)).status, 403);
    assert.equal((await call(input, { principal: { kind: 'device' } })).status, 403);
    assert.equal((await call(input, { principal: { kind: 'owner' } })).status, 404);
    assert.equal((await call({ ...input, attempts: 0 }, { principal: { kind: 'owner' } })).status, 400);
  }
  await assert.rejects(mountAssistant(ctx, commander, providers), { code: 'BENCHGO_DATA_LOCKED' });
  const mainBeforeGoal = (await app.store.getState()).mainSessionId;
  const sharedGoalResponse = await call({ action: 'goalCreate', goal: { objective: '长期维护知识库', requestId: 'shared-checklist' } });
  assert.equal(sharedGoalResponse.status, 200);
  let sharedGoal = await sharedGoalResponse.json();
  assert.equal(sharedGoal.status, 'active');
  assert.equal((await app.store.getState()).mainSessionId, mainBeforeGoal, 'creating a checklist does not initialize a model session');
  assert.equal((await (await call({ action: 'goalCreate', goal: { objective: '长期维护知识库', requestId: 'shared-checklist' } })).json()).id, sharedGoal.id);
  assert.equal((await call({ action: 'goalUpdate', id: sharedGoal.id, patch: { status: 'completed' } })).status, 400);
  sharedGoal = await (await call({ action: 'goalUpdate', id: sharedGoal.id, rowVersion: sharedGoal.rowVersion, patch: { objective: '长期维护产品知识库' } })).json();
  assert.equal(sharedGoal.objective, '长期维护产品知识库');
  const connectionInitial = await (await call({ action: 'connections' })).json();
  assert.equal((await (await call({ action: 'ownedSkills' })).json()).available, false);
  assert.notEqual((await call({ action: 'ownedSkillApprove', id: 'missing', revision: 1 })).status, 200);
  assert.equal(connectionInitial.config.enabled, false);
  const connectionSaved = await call({ action: 'connectionConfigure', revision: connectionInitial.revision, patch: { appId: 'opaque-feishu-app' } });
  assert.equal(connectionSaved.status, 200);
  assert.equal((await connectionSaved.json()).config.appId, 'opaque-feishu-app');
  const connectionRef = { adapterId: 'superagent-connections', namespace: 'superagent-connections:feishu' };
  const connectionReadback = await settingsManagement.read(connectionRef);
  assert.equal(connectionReadback.value.appId, 'opaque-feishu-app');
  const connectionAudit = settingsManagement.history(connectionRef);
  assert.equal(connectionAudit[0].source, 'managed');
  assert.equal(connectionAudit[0].state, 'completed');
  assert.deepEqual(connectionAudit[0].diff, [{ path: ['appId'], before: { present: true, value: connectionInitial.config.appId }, after: { present: true, value: 'opaque-feishu-app' } }]);
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
  let response = await call({ action: 'config', patch: { models: [{ providerId: 'mounted', modelId: 'exact' }], workerModels: [{ providerId: 'mounted', modelId: 'exact' }] }, revision: 0 }); assert.equal(response.status, 200);
  response = await call({ action: 'config', patch: { name: 'conflict' }, revision: 0 }); assert.equal(response.status, 409);
  response = await call({ action: 'config', patch: { cardHtml: '<b>Service card</b>' } }); assert.equal(response.status, 200); assert.equal((await response.json()).cardHtml, '<b>Service card</b>');
  response = await call({ action: 'ensure' }); const { sessionId } = await response.json(); assert.ok(sessionId);
  const agent = await app.engine.ensureSession();
  const deviceStatusTool = ctx.tools.get('assistant_device_status', agent);
  assert.ok(deviceStatusTool);
  assert.deepEqual(deviceStatusTool.parameters.properties, {});
  assert.deepEqual(deviceStatusTool.parameters.required, []);
  assert.equal(deviceStatusTool.parameters.additionalProperties, false);
  assert.equal((await deviceStatusTool.execute({}, { agent })).code, 'OWNER_REQUIRED');
  ctx.provide('benchgoLink', { status: () => ({ enabled: true, devices: [{ id: 'phone', name: '手机', deviceType: 'mobile', lastSeenAt: 123, tokenHash: 'PRIVATE' }], pending: [] }) });
  const executionTool = ctx.tools.get('assistant_execution_manage', agent);
  assert.deepEqual(executionTool.parameters.properties.operation.enum, ['resume']);
  const ticketsTool = ctx.tools.get('assistant_tickets', agent);
  assert.ok(ticketsTool);
  assert.deepEqual(await ticketsTool.execute({}, { agent }), { tickets: [], nextOffset: null });
  await assert.rejects(ticketsTool.execute({}, { agent: { id: 'child' } }), /只有总助手/);
  await assert.rejects(ticketsTool.execute({ op: 'get' }, { agent }), /需要 id/);
  app.store.orchestration.ingest({ dedupeKey: 'query-test', thread: { id: 'query-test', source: { type: 'desktop', id: 'query-test' } }, source: {}, actor: { kind: 'human', id: 'desktop-owner' }, content: 'Query proof', mode: 'direct' });
  const queryTicket = app.store.orchestration.createTicket({ threadId: 'query-test', target: 'Query proof', status: 'waiting', mandate: { source: { channel: 'desktop', sessionId: String(agent.id) }, project: { id: 'project' } } });
  const queried = await ticketsTool.execute({ projectId: 'project' }, { agent });
  assert.equal(queried.tickets[0].id, queryTicket.id);
  assert.equal((await ticketsTool.execute({ op: 'get', id: queryTicket.id }, { agent })).ticket.target, 'Query proof');
  app.store.orchestration.cancelTicket(queryTicket.id);
  for (const name of ['assistant_projects', 'assistant_settings', 'assistant_task_cleanup', 'assistant_generate_image', 'assistant_summarize', 'assistant_analyze_image']) assert.ok(ctx.tools.get(name, agent), name);
  assert.equal(ctx.tools.get('assistant_config', agent), undefined);
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
  assert.match(JSON.stringify(modelRequests.at(-1)), /persistentGoals/);
  assert.match(JSON.stringify(modelRequests.at(-1)), /长期维护产品知识库/, 'the actual model request sees current unfinished goals');
  response = await call({ action: 'send', text: 'hello', requestId: 'mounted-request' }); assert.equal((await response.json()).duplicate, true);
  // A committed Worker result must pass through this injected Router context,
  // durably flush its natural draft, then receive the original desktop receipt.
  const deliveryPolicy = await readAssessmentPolicy(app.store, ctx.workspaceRegistry);
  const sourceMessage = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data?.source?.requestId === 'mounted-request').data;
  const resultTicket = app.store.orchestration.createTicket({ threadId: `desktop:${agent.id}`, title: '完整交付验证', target: '保存并交付成果',
    mandate: { source: { channel: 'desktop', sessionId: agent.id, threadId: 'main', messageId: sourceMessage.id },
      actorId: 'desktop-owner', admission: 'desktop-approved-delegation', policyVersion: deliveryPolicy.desktopVersion,
      controlledActions: 'require-current-policy-and-harness-approval' } });
  // Reserve outbox claims only while this test prepares the draft itself.
  // Leave native timers running for the later attention and lifecycle checks.
  const outboxClaims = t.mock.method(app.store.orchestration, 'claimOutbox', () => []);
  let committed, prepared;
  try {
    app.store.orchestration.createAssignment(resultTicket.id, { id: 'scoped-worker-assignment' });
    const [resultAssignment] = app.store.orchestration.claimAssignments('test-worker', { validateMandate: () => true, assignmentId: 'scoped-worker-assignment' });
    const resultOwnership = { owner: resultAssignment.owner, fence: resultAssignment.fence };
    const resultRun = app.store.orchestration.prepareRun(resultAssignment.id, { ...resultOwnership, sessionId: 'scoped-worker-session', directory });
    app.store.orchestration.updateRun(resultRun.id, { ...resultOwnership, state: 'submitted' });
    const workerResult = { summary: '原始成果已保存', runId: resultRun.id, sessionId: resultRun.sessionId, instructionRevision: 1, completion: { kind: 'completed' } };
    app.store.orchestration.saveWorkerDraft(resultAssignment.id, { runId: resultRun.id, ...resultOwnership, result: workerResult });
    app.store.orchestration.updateRun(resultRun.id, { ...resultOwnership, state: 'verifying', evidence: workerResult });
    committed = commitWorkerResult({ database: app.store.orchestration, ticket: resultTicket, assignment: resultAssignment, uniqueKey: 'scoped-worker-result', result: workerResult });
    assert.equal(app.store.orchestration.getTicket(resultTicket.id).status, 'completed');
    for (let attempt = 0; attempt < 120; attempt++) {
      prepared = await app.engine.prepareTicketReply(committed.outbox);
      if (prepared.status === 'ready') break;
      assert.equal(prepared.status, 'pending', JSON.stringify(prepared));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(prepared.status, 'ready');
    assert.equal(prepared.text, 'Mounted reply');
    assert.deepEqual(await app.engine.prepareTicketReply(committed.outbox), prepared, 'saved Router draft is reused across outbox attempts');
    assert.equal(app.store.orchestration.deliveries(resultTicket.id)[0].state, 'queued');
  } finally {
    outboxClaims.mock.restore();
  }
  for (let attempt = 0; attempt < 100 && app.store.orchestration.deliveries(resultTicket.id)[0]?.state !== 'sent'; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
  const delivered = app.store.orchestration.deliveries(resultTicket.id);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].state, 'sent');
  assert.equal(delivered[0].receipt.status, 'accepted');
  assert.ok(delivered[0].receipt.messageId);
  assert.equal(delivered[0].payload.publication.origin, 'router');
  assert.equal(delivered[0].payload.publication.text, 'Mounted reply');
  assert.equal(app.store.orchestration.getTicket(resultTicket.id).status, 'completed');
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'plugin:benchgo-plugin/chat-publication'
    && event.data?.kind === 'ticket-reply' && event.data.ticketReplyEventKey === committed.outbox.uniqueKey).length, 1);
  assert.equal(app.database.notifications().events.filter(event => event.taskId === resultTicket.id).length, 1);
  // The empty project is not an executable fixture: reserve claims so a timer
  // cannot start unrelated work during the cleanup and lifecycle checks.
  const claimAssignments = app.store.orchestration.claimAssignments;
  app.store.orchestration.claimAssignments = () => [];
  t.after(() => { app.store.orchestration.claimAssignments = claimAssignments; });
  const stoppedTicket = app.store.orchestration.cancelTicket(app.store.orchestration.createTicket({ threadId: 'query-test', target: 'Stopped proof',
    mandate: { source: { channel: 'desktop', sessionId: String(agent.id) }, project: { id: 'project' } } }).id);
  assert.equal(stoppedTicket.executionControl.stopped, true);
  const cleanupIds = [queryTicket.id, stoppedTicket.id];
  const beforeCleanup = cleanupIds.map(id => app.store.orchestration.getTicket(id));
  const readCleanupDomain = () => {
    const db = new DatabaseSync(app.store.orchestration.path, { readOnly: true });
    try { return db.prepare('SELECT * FROM sa_tickets WHERE id IN (?,?) ORDER BY id').all(...cleanupIds); }
    finally { db.close(); }
  };
  const beforeCleanupDomain = readCleanupDomain();
  for (const action of ['taskCleanupPreview', 'taskCleanupCommit', 'taskCleanupHistory', 'taskCleanupRestorePreview', 'taskCleanupRestore']) {
    assert.equal((await call({ action, ticketIds: cleanupIds }, undefined)).status, 403, action);
    assert.equal((await call({ action, ticketIds: cleanupIds }, { principal: { kind: 'device' } })).status, 403, action);
  }
  const cleanupPreviewResponse = await call({ action: 'taskCleanupPreview', ticketIds: [...cleanupIds, 'missing-cleanup-ticket'] });
  assert.equal(cleanupPreviewResponse.status, 200, await cleanupPreviewResponse.clone().text());
  const cleanupPreview = await cleanupPreviewResponse.json();
  assert.deepEqual(cleanupPreview.items.map(row => row.id).sort(), [...cleanupIds].sort());
  assert.deepEqual(cleanupPreview.excluded.map(row => [row.id, row.code]), [['missing-cleanup-ticket', 'TICKET_NOT_FOUND']]);
  const cleanupInput = { action: 'taskCleanupCommit', previewId: cleanupPreview.previewId, manifestHash: cleanupPreview.manifestHash,
    selectedTicketIds: [queryTicket.id], requestId: 'service-cleanup-subset' };
  assert.equal((await call({ ...cleanupInput, manifestHash: 'changed-manifest' })).status, 409);
  const cleanupResponse = await call(cleanupInput);
  assert.equal(cleanupResponse.status, 200, await cleanupResponse.clone().text());
  const cleanupReceipt = await cleanupResponse.json();
  assert.equal(cleanupReceipt.operation, 'archive');
  assert.deepEqual(cleanupReceipt.items.map(row => row.id), [queryTicket.id]);
  assert.deepEqual((await (await call(cleanupInput)).json()), cleanupReceipt, 'page retries reuse the durable archive receipt');
  assert.deepEqual(cleanupIds.map(id => app.store.orchestration.getTicket(id)),
    beforeCleanup.map(row => row.id === queryTicket.id ? { ...row, archived: true } : row), 'authoritative projection reflects only the approved archive subset');
  assert.deepEqual(readCleanupDomain(), beforeCleanupDomain, 'archive preserves every stored Ticket domain column');
  assert.equal(app.store.orchestration.listTickets({ archived: true }).some(row => row.id === queryTicket.id), true);
  assert.equal(app.store.orchestration.listTickets({ archived: false }).some(row => row.id === queryTicket.id), false);
  assert.equal(app.store.orchestration.listTickets({ archived: false }).some(row => row.id === stoppedTicket.id), true);
  const cleanupHistory = await (await call({ action: 'taskCleanupHistory', ticketId: queryTicket.id })).json();
  assert.deepEqual(cleanupHistory.history, [cleanupReceipt]);
  const restorePreviewResponse = await call({ action: 'taskCleanupRestorePreview', ticketIds: [queryTicket.id] });
  assert.equal(restorePreviewResponse.status, 200, await restorePreviewResponse.clone().text());
  const restorePreview = await restorePreviewResponse.json();
  assert.equal(restorePreview.type, 'restore');
  assert.deepEqual(restorePreview.items.map(row => row.id), [queryTicket.id]);
  const restoreInput = { action: 'taskCleanupRestore', previewId: restorePreview.previewId, manifestHash: restorePreview.manifestHash,
    selectedTicketIds: [queryTicket.id], requestId: 'service-cleanup-restore' };
  const restoredResponse = await call(restoreInput);
  assert.equal(restoredResponse.status, 200, await restoredResponse.clone().text());
  const restoredReceipt = await restoredResponse.json();
  assert.equal(restoredReceipt.operation, 'restore');
  assert.deepEqual(restoredReceipt.items.map(row => row.id), [queryTicket.id]);
  assert.deepEqual((await (await call(restoreInput)).json()), restoredReceipt);
  assert.deepEqual(cleanupIds.map(id => app.store.orchestration.getTicket(id)), beforeCleanup, 'restore only changes presentation');
  assert.deepEqual(readCleanupDomain(), beforeCleanupDomain, 'restore preserves every stored Ticket domain column');
  assert.equal(app.store.orchestration.listTickets({ archived: false }).some(row => row.id === queryTicket.id), true);
  assert.equal(app.store.orchestration.listTickets({ archived: true }).some(row => row.id === queryTicket.id), false);
  assert.deepEqual((await (await call({ action: 'taskCleanupHistory', ticketId: queryTicket.id })).json()).history,
    [restoredReceipt, cleanupReceipt]);
  // Keep claims reserved through the scoped-tool contract checks below. These
  // queued tickets deliberately have no executable project/worker fixture;
  // asynchronous claiming would turn an immediate queued stop into cancelling.
  let streamFailure;
  duringStream = async () => { try {
  const deviceStatus = await deviceStatusTool.execute({}, { agent });
  assert.equal(deviceStatus.available, true);
  assert.equal(deviceStatus.liveConnections, 'unknown');
  assert.deepEqual(deviceStatus.devices, [{ id: 'phone', name: '手机', type: 'mobile', lastSeenAt: 123 }]);
  assert.doesNotMatch(JSON.stringify(deviceStatus), /PRIVATE/);
  const delegateTool = ctx.tools.get('assistant_delegate', agent);
  assert.deepEqual(delegateTool.parameters.required, ['text']);
  assert.equal(delegateTool.parameters.required.includes('provider'), false);
  assert.equal(delegateTool.parameters.required.includes('model'), false);
  assert.equal(delegateTool.parameters.properties.duplicateOfTicketId.type, 'string');
  const settingsCatalog = await ctx.tools.get('assistant_settings', agent).execute({ op: 'catalog', adapterId: 'superagent' }, { agent });
  const configSchema = settingsCatalog.entries.find(row => row.namespace === 'superagent').schema.properties;
  assert.equal(configSchema.models.maxItems, 32);
  assert.equal(configSchema.workerModels.maxItems, 32);
  assert.ok(delegateTool.parameters.properties.title);
  const goalTool = ctx.tools.get('assistant_goals', agent);
  await assert.rejects(goalTool.execute({ op: 'list' }, { agent: { id: 'child' } }), /只有总助手/);
  assert.equal((await goalTool.execute({ op: 'get', id: sharedGoal.id }, { agent })).objective, sharedGoal.objective, 'the AI sees a goal created without a session');
  sharedGoal = await goalTool.execute({ op: 'complete', id: sharedGoal.id, rowVersion: sharedGoal.rowVersion }, { agent });
  assert.equal(sharedGoal.status, 'completed');
  sharedGoal = await goalTool.execute({ op: 'reopen', id: sharedGoal.id, rowVersion: sharedGoal.rowVersion }, { agent });
  assert.equal(sharedGoal.status, 'active');
  await goalTool.execute({ op: 'delete', id: sharedGoal.id, rowVersion: sharedGoal.rowVersion }, { agent });
  assert.equal((await (await call({ action: 'goalList' })).json()).goals.some(row => row.id === sharedGoal.id), false);
  const toolChecklist = await goalTool.execute({ op: 'create', goal: { objective: '下次整理目标' } }, { agent });
  assert.equal(toolChecklist.status, 'active');
  assert.equal((await goalTool.execute({ op: 'create', goal: { objective: '下次整理目标' } }, { agent })).id, toolChecklist.id);
  await goalTool.execute({ op: 'delete', id: toolChecklist.id, rowVersion: toolChecklist.rowVersion }, { agent });
  } catch (error) { streamFailure = error; } };
  await call({ action: 'send', text: '创建项目延后工作目标', requestId: 'current-goal-authority-turn' });
  await agent.whenIdle();
  if (streamFailure) throw streamFailure;
  duringStream = async () => { try {
  const delegateTool = ctx.tools.get('assistant_delegate', agent);
  const delegation = { projectId: 'project', title: '检查项目', text: 'Inspect project', requestId: 'desktop-delegation' };
  await assert.rejects(delegateTool.execute(delegation, { agent: { id: 'child' }, authorized: true }), /只有总助手/);
  await assert.rejects(delegateTool.execute({ ...delegation, provider: 'mounted', model: 'exact' }, { agent, authorized: true }));
  const requestsBeforeDelegation = modelRequests.length;
  const ticket = await delegateTool.execute(delegation, { agent, authorized: true });
  assert.equal(ticket.mandate.instruction, 'Inspect project');
  assert.equal(ticket.acceptance, delegation.text);
  assert.equal(modelRequests.length, requestsBeforeDelegation, 'mounted admission does not request another model');
  assert.equal(ticket.mandate.scopeCheck, undefined);
  assert.equal((await delegateTool.execute(delegation, { agent, authorized: true })).id, ticket.id);
  assert.ok((await (await call({ action: 'tickets' })).json()).tickets.some(row => row.id === ticket.id));
  assert.equal((await (await call({ action: 'ticketStop', ticketId: ticket.id })).json()).executionControl.stopped, true);
  const pauseTicket = app.store.orchestration.createTicket({ threadId: ticket.threadId, target: 'Pause original investigation', mandate: ticket.mandate });
  const controlTool = ctx.tools.get('assistant_ticket_control', agent);
  assert.ok(controlTool.parameters.properties.operation.enum.includes('pause'));
  assert.ok(controlTool.parameters.properties.operation.enum.includes('resume'));
  app.store.orchestration.createThread({ id: 'foreign-source', source: { type: 'feishu', id: 'foreign-source' } });
  const globalTickets = [
    { channel: 'desktop', sessionId: 'another-desktop', threadId: 'another-side' },
    { channel: 'feishu', sourceType: 'group', conversationId: 'channel-group' },
  ].map(source => app.store.orchestration.createTicket({ threadId: 'foreign-source', target: 'Global management fixture', mandate: { ...ticket.mandate, source } }));
  for (const row of globalTickets) {
    assert.equal((await ticketsTool.execute({ op: 'get', id: row.id }, { agent })).ticket.id, row.id);
    await assert.rejects(controlTool.execute({ id: row.id, operation: 'supplement' }, { agent }), /不属于当前会话/);
    assert.equal((await controlTool.execute({ id: row.id, operation: 'pause' }, { agent })).ticket.executionControl.paused, true);
    assert.deepEqual((await controlTool.execute({ id: row.id, operation: 'resume' }, { agent })).ticket.executionControl, {});
    assert.deepEqual(app.store.orchestration.getTicket(row.id).mandate, row.mandate);
  }
  const pauseReceipt = await controlTool.execute({ id: pauseTicket.id, operation: 'pause' }, { agent });
  assert.equal(pauseReceipt.ticket.executionControl.paused, true);
  assert.equal(pauseReceipt.input.kind, 'pause'); assert.equal(pauseReceipt.input.state, 'applied');
  assert.equal(app.store.orchestration.getTrigger(pauseReceipt.triggerId).content, 'Inspect project');
  assert.equal(app.store.orchestration.getTicket(pauseTicket.id).executionControl.paused, true);
  app.store.orchestration.cancelTicket(pauseTicket.id);
  const questionTicket = app.store.orchestration.createTicket({ threadId: ticket.threadId, target: 'Question', mandate: ticket.mandate });
  app.store.orchestration.createAssignment(questionTicket.id, {});
  const [questionAssignment] = claimAssignments.call(app.store.orchestration, 'test-worker', { validateMandate: () => true });
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
  assert.match(await invalidReview.text(), /未知总助手操作/);
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
  await call({ action: 'send', text: 'Inspect project', requestId: 'current-authority-turn' });
  await agent.whenIdle();
  if (streamFailure) throw streamFailure;
  const memoryTool = ctx.tools.get('assistant_memory', agent);
  await assert.rejects(memoryTool.execute({ content: '无当前用户回合' }, { agent, callId: 'outside-turn' }), /当前原始用户消息/);
  await assert.rejects(memoryTool.execute({ content: '伪造来源' }, { agent: { id: 'child' }, callId: 'spoofed', authorized: true }), { code: 'WORKER_MEMORY_WRITE_DENIED' });
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
  const settingsTool = ctx.tools.get('assistant_settings', agent);
  assert.deepEqual(settingsTool.output.render({}, { name: 'test' }), [{ type: 'text', text: '{"name":"test"}' }]);
  assert.deepEqual(settingsTool.parameters.required, ['op']);
  assert.equal(settingsTool.parameters.properties.actor, undefined);
  assert.equal(settingsTool.parameters.properties.confirmed, undefined);
  const toolExec = { signal: new AbortController().signal, agent };
  const settingsRef = { adapterId: 'superagent', namespace: 'superagent' };
  const settingsRead = async () => {
    const result = await call({ action: 'settingsRead', ...settingsRef });
    assert.equal(result.status, 200, await result.clone().text());
    return result.json();
  };
  const settingsCatalogResponse = await call({ action: 'settingsCatalog', adapterId: 'superagent' });
  assert.equal(settingsCatalogResponse.status, 200);
  const settingsSchema = (await settingsCatalogResponse.json()).entries.find(row => row.namespace === 'superagent').schema.properties;
  assert.equal(settingsSchema.cardMotion.type, 'boolean');
  assert.equal(settingsSchema.cardHtml.maxLength, 16000);
  assert.equal(settingsSchema.models.maxItems, 32);
  assert.equal(settingsSchema.workerModels.maxItems, 32);
  for (const action of ['settingsCatalog', 'settingsRead', 'settingsPrepare', 'settingsCommit', 'settingsHistory', 'settingsRollback']) {
    assert.equal((await call({ action, ...settingsRef }, undefined)).status, 403, action);
    assert.equal((await call({ action, ...settingsRef }, { principal: { kind: 'device' } })).status, 403, action);
  }
  await assert.rejects(settingsTool.execute({ op: 'read', ...settingsRef }, toolExec), { code: 'MANAGEMENT_OWNER_REQUIRED' });
  const initialConfig = (await settingsRead()).value;
  assert.equal(initialConfig.cardHtml, '<b>Service card</b>');
  assert.equal(initialConfig.cardMotion, true);
  let toolResult, toolReceipt;
  duringStream = async () => { try {
    const discovered = await settingsTool.execute({ op: 'catalog', adapterId: 'superagent' }, toolExec);
    assert.deepEqual(discovered.entries, (await settingsManagement.catalog({ adapterId: 'superagent' })).entries);
    const current = await settingsTool.execute({ op: 'read', ...settingsRef }, toolExec);
    assert.deepEqual(current.value, initialConfig);
    const plan = await settingsTool.execute({ op: 'prepare', ...settingsRef, expectedRevision: current.revision,
      ops: [{ op: 'set', path: ['cardHtml'], value: '<i>Tool card</i>' }, { op: 'set', path: ['cardMotion'], value: false }], requestId: 'service-tool-settings' }, toolExec);
    assert.equal(plan.requiresConfirmation, false);
    toolReceipt = await settingsTool.execute({ op: 'commit', operationId: plan.operationId }, toolExec);
    assert.equal(toolReceipt.verified, true);
    assert.equal(toolReceipt.application.state, 'applied');
    const readback = await settingsTool.execute({ op: 'read', ...settingsRef }, toolExec);
    toolResult = readback.value;
    assert.equal(readback.revision, toolReceipt.revision);
    const history = await settingsTool.execute({ op: 'history', ...settingsRef }, toolExec);
    assert.equal(history.history[0].id, toolReceipt.historyId);
    assert.equal(history.history[0].actor.sessionId, agent.id);
  } catch (error) { streamFailure = error; } };
  await call({ action: 'send', text: '把卡片改为斜体 Tool card 并关闭卡片动效，保留其他设置。', requestId: 'service-settings-owner-turn' });
  await agent.whenIdle();
  if (streamFailure) throw streamFailure;
  assert.equal(toolResult.cardMotion, false);
  response = await call({ action: 'state' });
  const savedToolConfig = (await response.json()).config;
  const { schemaVersion: savedSchemaVersion, revision: savedRevision, ...savedToolValue } = savedToolConfig;
  assert.equal(typeof savedSchemaVersion, 'number');
  assert.equal(savedRevision, (await settingsRead()).backendRevision);
  assert.deepEqual(savedToolValue, toolResult);
  assert.deepEqual((await settingsRead()).value, toolResult);
  const settingsHistory = await (await call({ action: 'settingsHistory', ...settingsRef })).json();
  assert.equal(settingsHistory.history[0].id, toolReceipt.historyId);
  assert.deepEqual(settingsHistory.history, settingsManagement.history(settingsRef));
  assert.equal(toolResult.name, initialConfig.name);
  assert.deepEqual(toolResult.models, [{ providerId: 'mounted', modelId: 'exact' }]);
  for (const cardMotion of [null, 0, 'false', {}]) {
    response = await call({ action: 'config', patch: { cardMotion } }); assert.equal(response.status, 400);
    const current = await settingsRead();
    await assert.rejects(settingsManagement.prepare({ ...settingsRef, expectedRevision: current.revision,
      ops: [{ op: 'set', path: ['cardMotion'], value: cardMotion }] }, { kind: 'owner', id: 'desktop-owner' }), { code: 'SETTINGS_SCHEMA_REJECTED' });
  }
  response = await call({ action: 'config', patch: { cardMotion: true }, revision: savedToolConfig.revision });
  assert.equal(response.status, 200);
  const motionConfig = await response.json();
  assert.equal(motionConfig.cardMotion, true);
  assert.equal(motionConfig.cardHtml, toolResult.cardHtml);
  assert.equal(motionConfig.name, toolResult.name);
  assert.deepEqual(motionConfig.models, toolResult.models);
  for (const cardHtml of [{}, false, 'x'.repeat(16001)]) {
    response = await call({ action: 'config', patch: { cardHtml } }); assert.equal(response.status, 400);
    const current = await settingsRead();
    await assert.rejects(settingsManagement.prepare({ ...settingsRef, expectedRevision: current.revision,
      ops: [{ op: 'set', path: ['cardHtml'], value: cardHtml }] }, { kind: 'owner', id: 'desktop-owner' }), { code: 'SETTINGS_SCHEMA_REJECTED' });
  }
  response = await call({ action: 'config', patch: { cardHtml: '' }, revision: 1 }); assert.equal(response.status, 409);
  assert.equal((await settingsRead()).value.cardHtml, '<i>Tool card</i>');
  response = await call({ action: 'config', patch: { cardHtml: ' \n ' } }); assert.equal(response.status, 200);
  response = await call({ action: 'state' }); assert.equal((await response.json()).config.cardHtml, null);
  assert.equal((await settingsRead()).value.cardHtml, null);
  for (const keyPools of [[{ providerId: 'pool-main', candidates: ['pool-backup'] }], []]) {
    response = await call({ action: 'config', patch: { keyPools } }); assert.equal(response.status, 400);
    const current = await settingsRead();
    await assert.rejects(settingsManagement.prepare({ ...settingsRef, expectedRevision: current.revision,
      ops: [{ op: 'set', path: ['keyPools'], value: keyPools }] }, { kind: 'owner', id: 'desktop-owner' }), { code: 'SETTINGS_SCHEMA_REJECTED' });
  }
  assert.equal(Object.hasOwn((await settingsRead()).value, 'keyPools'), false);
  const opaqueModels = [{ providerId: 'mounted', modelId: 'Opaque Model:07/Exact Case' }];
  const beforeOpaque = await settingsRead();
  const opaquePlanResponse = await call({ action: 'settingsPrepare', ...settingsRef, expectedRevision: beforeOpaque.revision,
    ops: [{ op: 'set', path: ['models'], value: opaqueModels }], requestId: 'service-http-opaque-model' });
  assert.equal(opaquePlanResponse.status, 200, await opaquePlanResponse.clone().text());
  const opaquePlan = await opaquePlanResponse.json();
  assert.deepEqual(opaquePlan.diff, [{ path: ['models'], before: { present: true, value: toolResult.models }, after: { present: true, value: opaqueModels } }]);
  const opaqueCommitResponse = await call({ action: 'settingsCommit', operationId: opaquePlan.operationId, digest: opaquePlan.digest });
  assert.equal(opaqueCommitResponse.status, 200, await opaqueCommitResponse.clone().text());
  const opaqueReceipt = await opaqueCommitResponse.json();
  assert.equal(opaqueReceipt.verified, true);
  assert.equal(opaqueReceipt.application.state, 'applied');
  const opaqueReadback = await settingsRead();
  assert.deepEqual(opaqueReadback.value, { ...beforeOpaque.value, models: opaqueModels });
  const opaqueSummary = await (await call({ action: 'summarize', text: 'Check the exact configured model ID' })).json();
  assert.equal(opaqueSummary.routing.attempts[0].modelId, opaqueModels[0].modelId, 'the actual request preserves the opaque model ID');
  assert.deepEqual((await (await call({ action: 'settingsHistory', ...settingsRef })).json()).history[0].id, opaqueReceipt.historyId);
  response = await call({ action: 'config', patch: { models: toolResult.models }, revision: opaqueReadback.backendRevision });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await settingsRead()).value, beforeOpaque.value, 'page save preserves the other settings and shares authoritative readback');
  response = await call({ action: 'history' }); assert.equal((await response.json()).messages.at(-1).text, 'Mounted reply');
  response = await call({ action: 'sessionSearch', query: 'Mounted' });
  assert.equal(response.status, 200, await response.clone().text());
  const search = await response.json();
  const hit = search.results.find(row => row.text.includes('Mounted reply'));
  assert.ok(hit, 'official search returns only the public reply projection');
  assert.equal(search.source, 'official');
  response = await call({ action: 'sessionHistory', sessionId: hit.sessionId, seq: hit.seq });
  assert.equal(response.status, 200, await response.clone().text());
  const original = await response.json();
  assert.equal(original.events[0].text, 'Mounted reply');
  assert.equal(original.events[0].sessionId, hit.sessionId);
  assert.equal(original.events[0].seq, hit.seq);
  assert.equal(original.messages, undefined, 'the original body is not duplicated under another field');
  const historyExec = { agent, signal: new AbortController().signal };
  const searchTool = ctx.tools.get('assistant_session_search', agent);
  const historyTool = ctx.tools.get('assistant_history', agent);
  const sessionsTool = ctx.tools.get('assistant_sessions', agent);
  assert.deepEqual(await searchTool.execute({ query: 'Mounted' }, historyExec), search);
  assert.deepEqual(await historyTool.execute({ sessionId: hit.sessionId, seq: hit.seq }, historyExec), original);
  const sessionPage = await (await call({ action: 'sessionList', limit: 1 })).json();
  assert.equal(sessionPage.sessions.length, 1);
  assert.deepEqual(await sessionsTool.execute({ limit: 1 }, historyExec), sessionPage);
  for (const [tool, args] of [[searchTool, { query: 'Mounted' }], [historyTool, { sessionId: hit.sessionId }], [sessionsTool, {}]]) {
    await assert.rejects(tool.execute(args, { ...historyExec, agent: { id: agent.id } }), { code: 'HISTORY_SCOPE_DENIED' });
  }
  const forbiddenHistory = await call({ action: 'sessionHistory', sessionId: 'unowned-worker' });
  assert.equal((await forbiddenHistory.json()).code, 'SESSION_QUERY_FORBIDDEN');
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
  assert.equal(response.status, 200, await response.clone().text());
  const legacyVoiceConfig = await response.json();
  response = await call({ action: 'config', patch: { asr: { modelId: 'Legacy ASR:Opaque/02' } }, revision: legacyVoiceConfig.revision });
  assert.equal(response.status, 200, await response.clone().text());
  const legacyVoiceReadback = (await settingsRead()).value;
  assert.deepEqual(legacyVoiceReadback.asr, { providerId: 'legacy-asr', modelId: 'Legacy ASR:Opaque/02', protocol: 'transcriptions' });
  assert.deepEqual(legacyVoiceReadback.models, legacyVoiceConfig.models);
  assert.equal(legacyVoiceReadback.cardMotion, legacyVoiceConfig.cardMotion);
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
  const beforeSettingsRemount = await settingsRead();
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
    skillFiber = ctx.inject(assistantInject.filter(name => !['benchgo', 'commander', 'settings'].includes(name)), child => {
      mountAssistant(child, commander, providers).then(resolve, reject);
    });
  }).finally(() => clearTimeout(mountTimer));
  const afterSettingsRemount = await settingsRead();
  assert.deepEqual(afterSettingsRemount.value, beforeSettingsRemount.value, 'saved settings survive service disposal and reload');
  assert.equal(afterSettingsRemount.backendRevision, beforeSettingsRemount.backendRevision);
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
  const resetGoal = await (await call({ action: 'goalCreate', goal: { objective: '跨主会话保留', requestId: 'reset-checklist' } })).json();
  const beforeResetAgent = await withSkills.engine.ensureSession();
  await beforeResetAgent.whenIdle();
  await withSkills.engine.resetMain();
  const afterResetAgent = await withSkills.engine.ensureSession();
  assert.notEqual(afterResetAgent.id, beforeResetAgent.id);
  const afterResetGoals = await ctx.tools.get('assistant_goals', afterResetAgent).execute({ op: 'list' }, { agent: afterResetAgent });
  assert.ok(afterResetGoals.goals.some(row => row.id === resetGoal.id && row.objective === '跨主会话保留'));
  await skillFiber.dispose();
  assert.equal(await ctx.skills.get(candidate.name), undefined);
});
