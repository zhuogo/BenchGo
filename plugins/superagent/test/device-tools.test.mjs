import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceTools } from '../src/device-tools.mjs';
import { readRemoteExecutionCatalog, selectRemoteExecution } from '../src/execution-catalog.mjs';
import { createRouterTools } from '../src/router-tools.mjs';

function fixture() {
  const calls = [], events = [{ type: 'turn/start' }, { type: 'user/message', data: { id: 'human', source: { kind: 'user' }, content: [{ type: 'text', text: '查看服务器连接状态' }] } }];
  const ownerAgent = { id: 'A-router', status: 'running', session: { header: {}, snapshotEvents: () => events } };
  const model = { providerId: 'opaque/P', modelId: 'opaque:M', params: { maxTokens: 4096, temperature: 0.5 } };
  const catalog = { version: 2, available: true, hostId: 'sha256:B', models: [{ harness: 'official', ...model }], projects: [] };
  const link = { devices: async () => ({ devices: [{ id: 'B', hostId: 'sha256:B', authorizationId: 'paired-A' }] }),
    resources: async input => ({ input }), callDevice: async input => { calls.push(input); return catalog; },
    deviceAction: async input => { calls.push(input); return { accepted: true }; } };
  const ctx = { get: name => name === 'benchgoLink' ? link : undefined,
    agents: { get: () => ownerAgent, currentInitiator: () => ownerAgent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) } };
  return { ctx, link, calls, ownerAgent, model, catalog, events, service: createDeviceTools({ ctx }), exec: { agent: ownerAgent }, options: { ownerAgent, threadId: 'main' } };
}

test('device management retains the real human binding, stable identity and finite remote namespace', async () => {
  const f = fixture();
  const input = { operation: 'settings-read', deviceId: 'B' };
  await f.service.action(input, f.exec, f.options);
  await f.service.action(input, f.exec, f.options);
  assert.equal(f.calls[0].input.action, 'management');
  assert.equal(f.calls[0].input.namespace, 'benchgo-link-relay');
  assert.equal(f.calls[0].input.requestId, f.calls[1].input.requestId);
  await f.service.action({ operation: 'connect', deviceId: 'B' }, f.exec, f.options);
  assert.deepEqual(f.calls[2].source, { sessionId: 'A-router', messageId: 'human', threadId: 'main', instruction: '查看服务器连接状态' });
  await assert.rejects(f.service.action(input, { agent: {} }, f.options), /只有当前总助手/);
  await assert.rejects(f.service.action({ ...input, deviceId: 'local' }, f.exec, f.options), /本机配置/);
  f.events.push({ type: 'turn/end' });
  await assert.rejects(f.service.action(input, f.exec, f.options), /当前真实用户指令/);
});

test('execution catalog binds the saved target identity and preserves opaque configuration', async () => {
  const f = fixture(), catalog = await readRemoteExecutionCatalog(f.ctx, 'B');
  assert.deepEqual(f.calls[0].input, { action: 'execution', version: 2, operation: 'catalog' });
  assert.equal(catalog.deviceId, 'B');
  const result = selectRemoteExecution(catalog, { executionConfig: { harness: 'official', models: [{ ...f.model, params: { temperature: 0.5, maxTokens: 4096 } }] } });
  assert.equal(result.execution.authorizationId, 'paired-A');
  assert.equal(result.model.modelId, 'opaque:M');
  assert.throws(() => selectRemoteExecution(catalog, { executionConfig: { harness: 'official', models: [f.model, f.model] } }), { code: 'EXECUTION_CONFIG_REQUIRED' });
  f.catalog.hostId = 'sha256:other';
  await assert.rejects(readRemoteExecutionCatalog(f.ctx, 'B'), { code: 'EXECUTION_CATALOG_UNAVAILABLE' });
  await assert.rejects(readRemoteExecutionCatalog(f.ctx, 'local'), /明确目标设备/);
});

test('Router exposes one task admission and exact-device execution catalog through standard tools', async () => {
  const f = fixture(), registered = new Map(), accepted = [];
  createRouterTools({ ctx: f.ctx, shutdown: new AbortController(), deviceTools: f.service,
    store: { getState: async () => ({ mainSessionId: f.ownerAgent.id, threads: [] }) },
    desktopDelegation: { delegate: async (...args) => { accepted.push(args); return { id: 'A-task' }; } },
  })({ tools: { register(tool) { registered.set(tool.name, tool); return () => {}; } }, systemPrompt: { section() {}, context() {} } }, { agent: f.ownerAgent, threadId: 'main' });
  assert.equal(registered.has('assistant_remote_task'), false);
  const catalog = await registered.get('assistant_devices').execute({ deviceId: 'B' }, f.exec);
  assert.equal(catalog.hostId, 'sha256:B');
  const delegate = registered.get('assistant_delegate');
  assert.equal(delegate.parameters.properties.executionConfig.properties.models.maxItems, 1);
  const input = { deviceId: 'B', text: 'inspect the server', executionConfig: { harness: 'official', models: [f.model] } };
  assert.deepEqual(await delegate.execute(input, f.exec), { id: 'A-task' });
  assert.deepEqual(accepted[0][0], input);
  assert.equal(accepted[0][2].ownerAgent, f.ownerAgent);
  await assert.rejects(registered.get('assistant_devices').execute({ deviceId: 'B' }, { agent: {} }), { code: 'HISTORY_SCOPE_DENIED' });
});
