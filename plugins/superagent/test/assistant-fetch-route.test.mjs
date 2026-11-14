import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerAssistantFetchRoute } from '../src/assistant-fetch-route.mjs';
import { resolveApprovalOrigins } from '../src/execution-approval-origin.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { channelSessionKey } from '../src/channel-policy.mjs';
import { createAssistantDispatch } from '../src/assistant-dispatch.mjs';

const requireBenchgo = createRequire(new URL('../../benchgo/package.json', import.meta.url));
const { transformSync } = requireBenchgo('esbuild');
const connectionSource = new URL('../../../deepseek-harness/packages/client/connection/src/', import.meta.url).href;
// Compile the checked-out official module in memory. Do not mock its route/Peer
// dispatch or write generated files into the official source checkout.
const sourceHook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(connectionSource) && ['@deepseek-ai/cordis', '@deepseek-ai/dsh-scope'].includes(specifier)) {
    return { url: pathToFileURL(requireBenchgo.resolve(specifier)).href, shortCircuit: true };
  }
  return next(specifier, context);
}, load(url, context, next) {
  if (!url.startsWith(connectionSource) || !url.endsWith('.ts')) return next(url, context);
  return { format: 'module', source: transformSync(readFileSync(fileURLToPath(url), 'utf8'), {
    loader: 'ts', format: 'esm', target: 'node24', sourcefile: fileURLToPath(url),
  }).code, shortCircuit: true };
} });
const { HostConnectionService } = await import('../../../deepseek-harness/packages/client/connection/src/rpc-host.ts');
const { Context } = await import(pathToFileURL(requireBenchgo.resolve('@deepseek-ai/cordis')).href);

test('task list dispatch preserves the caller filters and forwards its pagination offset', async () => {
  const requests = [], values = [{ id: 'page-task' }];
  const dispatch = createAssistantDispatch({ shutdown: new AbortController(),
    orchestrationRuntime: { state(request) { requests.push(request); return values; } }, projectTasks: tasks => tasks,
  });
  assert.deepEqual(await dispatch({ action: 'tasks', archived: true, taskId: 'opaque-id', limit: 1000, offset: 2000 }), { tasks: values });
  assert.deepEqual(requests, [{ newestFirst: true, archived: true, taskId: 'opaque-id', limit: 1000, offset: 2000 }]);
});

test('assistant Fetch propagates cancellation to the query execution context', async () => {
  let route, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const controller = new AbortController();
  const connection = { browserPeer: {}, fetch: { register(value) { route = value; return () => {}; } } };
  registerAssistantFetchRoute({ connection, async dispatch(_input, peer, { signal }) {
    assert.strictEqual(peer, connection.browserPeer);
    entered(signal);
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const response = route.fetch(new Request('http://localhost/api/commander/assistant', {
    method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'sessionSearch', query: 'cancelled' }), signal: controller.signal,
  }));
  const signal = await started;
  controller.abort(Object.assign(new Error('Search cancelled'), { code: 'SEARCH_CANCELLED' }));
  assert.equal(signal.aborted, true);
  assert.equal((await (await response).json()).code, 'SEARCH_CANCELLED');
});

test('official shared Fetch dispatch reaches the registered assistant route with trusted owner identity', async t => {
  const ctx = new Context(), database = createAssistantOrchestrationStore({ filename: ':memory:' });
  t.after(async () => { await ctx.fiber.dispose(); database.close(); sourceHook.deregister(); });
  const connectionFiber = ctx.plugin(child => { new HostConnectionService(child, [], {}); });
  await connectionFiber.await();
  const connection = ctx.get('connection');
  const policy = { desktopVersion: 'trusted-desktop-policy', version: 'channel-policy' };
  const state = { mainSessionId: 'router-main', threads: [{ id: 'side', sessionId: 'router-side' }] };
  database.createThread({ id: 'ledger-thread', source: { type: 'desktop', id: 'ledger-thread' } });
  const runs = {};
  for (const threadId of ['main', 'side']) {
    const sessionId = `router-${threadId}`, mandate = { source: { channel: 'desktop', threadId, sessionId, messageId: `human-${threadId}` },
      policyVersion: policy.desktopVersion, actorId: 'desktop-owner', admission: 'desktop-approved-delegation',
      controlledActions: 'require-current-policy-and-harness-approval' };
    const task = database.createTask({ threadId: 'ledger-thread', title: `${threadId} send`, target: 'send approved exact body', mandate });
    database.createAssignment(task.id, { executor: 'harness' });
    const [assignment] = database.claimAssignments(`owner-${threadId}`, { validateMandate: () => true });
    const run = database.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence,
      sessionId: `worker-${threadId}`, directory: 'workspace' });
    database.updateRun(run.id, { owner: assignment.owner, fence: assignment.fence, state: 'submitted' });
    runs[threadId] = { task, assignment, run };
  }
  const invocations = [], store = { getState: async () => state, orchestration: database };
  const engine = { taskOwnerScope: async threadId => ({ threadId, sessionIds: [`router-${threadId}`] }) };
  registerAssistantFetchRoute({ connection, async dispatch(input, peer) {
    invocations.push({ input, peer });
    if (input.action === 'approvalOrigins') return resolveApprovalOrigins({ store, engine, input, peer, readPolicy: async () => policy });
    throw Object.assign(new Error('fixture failure'), { code: input.errorCode, revision: 7, hash: 'saved-hash' });
  } });
  const shared = connection.createSharedFetchHandler('/api');
  const call = (input, peer = connection.browserPeer, headers = {}) => shared.fetch(new Request('http://localhost/api/commander/assistant', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', ...headers }, body: JSON.stringify(input),
  }), peer);
  const input = { action: 'approvalOrigins', sessionId: 'worker-main', toolName: 'assistant_external_action' };

  await t.test('owner receives only the current source chat Worker through the real registered route', async () => {
    const response = await call(input);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { origins } = await response.json();
    assert.equal(origins.length, 1);
    assert.equal(origins[0].taskId, runs.main.task.id);
    assert.equal(origins[0].runId, runs.main.run.id);
    assert.equal(origins[0].sessionId, 'worker-main');
    assert.equal(origins[0].ownerSessionId, 'router-main');
    assert.strictEqual(invocations.at(-1).peer, connection.browserPeer);
    const side = await (await call({ ...input, sessionId: 'worker-side' })).json();
    assert.deepEqual(side.origins.map(origin => origin.sessionId), ['worker-side']);
  });

  await t.test('non-owner is refused before the plugin route, including forged JSON principal/Peer', async () => {
    const guest = connection.createPeer({ principal: { kind: 'device', id: 'untrusted-device' } });
    const count = invocations.length;
    const response = await call({ ...input, principal: { kind: 'owner' }, peer: { principal: { kind: 'owner' } } }, guest);
    assert.equal(response.status, 403);
    assert.equal(await response.text(), 'forbidden');
    assert.equal(invocations.length, count);
  });

  await t.test('legacy cancelled channel records cannot turn the real profile review route into HTTP 400', async () => {
    const source = { channel: 'feishu', sourceType: 'direct', appId: 'trusted-app', chatId: 'chat', conversationId: 'chat' };
    state.threads.push({ id: 'channel', sessionId: 'router-channel', source, sourceKey: channelSessionKey(source) },
      { id: 'broken', sessionId: 'router-broken', source: { channel: 'feishu' }, sourceKey: 'old-source-key' });
    policy.connection = { enabled: true, appId: 'trusted-app', ownerOpenIds: ['channel-owner'] };
    const mandate = { policyVersion: policy.version, source, actorId: 'channel-owner',
      admission: 'explicit-owner', controlledActions: 'require-current-policy-and-harness-approval' };
    // Production retained cancelled pre-unified-source tasks outside auto-archive.
    const legacy = database.createTask({ threadId: 'ledger-thread', target: 'historical channel task',
      mandate: { ...mandate, source: { channel: 'feishu' } } });
    database.cancelTask(legacy.id);
    database.createTask({ threadId: 'ledger-thread', target: 'unverified current task', mandate: { ...mandate, source: undefined } });
    const task = database.createTask({ threadId: 'ledger-thread', target: 'valid channel task', mandate });
    database.createAssignment(task.id, { executor: 'harness' });
    const [assignment] = database.claimAssignments('channel-worker', { validateMandate: () => true });
    const run = database.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence,
      sessionId: 'worker-channel', directory: 'workspace' });
    database.updateRun(run.id, { owner: assignment.owner, fence: assignment.fence, state: 'submitted' });
    const response = await call({ action: 'approvalOrigins' });
    assert.equal(response.status, 200);
    const { origins } = await response.json();
    assert.deepEqual(origins.filter(row => row.kind === 'worker').map(row => row.sessionId),
      ['worker-main', 'worker-side', 'worker-channel']);
    assert(!origins.some(row => row.sessionId === 'router-broken'));
    const decision = await call({ action: 'approvalOrigins', sessionId: 'worker-channel', toolName: 'assistant_external_action' });
    assert.equal(decision.status, 200);
    assert.deepEqual((await decision.json()).origins.map(row => row.taskId), [task.id]);
    assert.deepEqual(database.getTask(legacy.id).mandate.source, { channel: 'feishu' });
  });

  await t.test('JSON identity and Worker ids cannot override trusted owner or server-side origin projection', async () => {
    const response = await call({ ...input, principal: { kind: 'device' }, peer: { principal: { kind: 'device' } },
      ownerSessionId: 'forged-router', ownerThreadId: 'side', runId: runs.side.run.id, taskId: runs.side.task.id });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).origins.map(origin => origin.sessionId), ['worker-main']);
    assert.strictEqual(invocations.at(-1).peer, connection.browserPeer);
    const stale = await call({ ...input, sessionId: 'forged-worker' });
    assert.deepEqual(await stale.json(), { origins: [] });
  });

  await t.test('cross-origin request fails inside the registered route before business dispatch', async () => {
    const count = invocations.length;
    for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      const response = await call(input, connection.browserPeer, headers);
      assert.equal(response.status, 403);
      assert.match((await response.json()).error, /Cross-site/);
    }
    assert.equal(invocations.length, count);
  });

  await t.test('the extracted production route retains conflict/not-found status and error metadata', async () => {
    for (const [errorCode, status] of [['REVISION_CONFLICT', 409], ['DELIVERY_RECONCILIATION_CONFLICT', 409],
      ['OUTBOX_RECONCILIATION_CONFLICT', 409], ['DIRECT_REPLY_NOT_FOUND', 404], ['OUTBOX_NOT_FOUND', 404], ['OTHER', 400]]) {
      const response = await call({ action: 'fixture-error', errorCode });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: 'fixture failure', code: errorCode, revision: 7, hash: 'saved-hash' });
    }
  });
});
