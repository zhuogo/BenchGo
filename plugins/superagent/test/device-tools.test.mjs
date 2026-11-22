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
    resolveDeviceIdentity: async ({ deviceId }) => ({ id: deviceId, hostId: 'sha256:B', authorizationId: 'paired-A' }),
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
  const automatic = selectRemoteExecution(catalog, {});
  assert.equal(automatic.model.modelId, 'opaque:M', 'no explicit model: the target device own catalog decides');
  assert.equal(automatic.execution.config.harness, 'official');
  assert.throws(() => selectRemoteExecution(catalog, { executionConfig: { harness: 'official', models: [f.model, f.model] } }), { code: 'EXECUTION_CONFIG_REQUIRED' });
  f.catalog.hostId = 'sha256:other';
  await assert.rejects(readRemoteExecutionCatalog(f.ctx, 'B'), { code: 'EXECUTION_CATALOG_UNAVAILABLE' });
  await assert.rejects(readRemoteExecutionCatalog(f.ctx, 'local'), /明确目标设备/);
});

test('catalog reports an older peer version without adding a dispatch gate', async () => {
  const f = fixture();
  f.catalog.pluginVersion = '0.0.1';
  const catalog = await readRemoteExecutionCatalog(f.ctx, 'B');
  assert.match(catalog.versionWarning, /0\.0\.1 低于本机/);
  assert.equal(selectRemoteExecution(catalog, {}).versionWarning, catalog.versionWarning);
  f.catalog.pluginVersion = '99.0.0';
  assert.equal((await readRemoteExecutionCatalog(f.ctx, 'B')).versionWarning, undefined);
  delete f.catalog.pluginVersion;
  assert.match((await readRemoteExecutionCatalog(f.ctx, 'B')).versionWarning, /未报告可识别/);
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
  await assert.rejects(registered.get('assistant_devices').execute({ deviceId: 'B' }, { agent: {} }), { code: 'DEVICE_CATALOG_SCOPE_DENIED' });
});

test('a mounted channel Router can read the device catalog without getting desktop history access', async () => {
  const f = fixture(), registered = new Map();
  const thread = { id: 'telegram-chat', sourceKey: 'telegram:chat', source: { channel: 'telegram' }, sessionId: f.ownerAgent.id };
  createRouterTools({ ctx: f.ctx, shutdown: new AbortController(), deviceTools: f.service,
    store: { getState: async () => ({ threads: [thread] }) },
  })({ tools: { register(tool) { registered.set(tool.name, tool); return () => {}; } }, systemPrompt: { section() {}, context() {} } }, { agent: f.ownerAgent, threadId: thread.id });
  assert.equal((await registered.get('assistant_devices').execute({}, f.exec)).devices[0].id, 'B');
  assert.equal((await registered.get('assistant_devices').execute({ deviceId: 'B' }, f.exec)).hostId, 'sha256:B');
  const projects = await registered.get('assistant_projects').execute({ deviceId: 'B' }, f.exec);
  assert.equal(projects.input.kind, 'projects');
  assert.equal(projects.input.deviceId, 'B');
  await assert.rejects(registered.get('assistant_device_manage').execute({ operation: 'remove', deviceId: 'B' }, f.exec), { code: 'HISTORY_SCOPE_DENIED' });
  thread.archived = true;
  await assert.rejects(registered.get('assistant_devices').execute({}, f.exec), { code: 'DEVICE_CATALOG_SCOPE_DENIED' });
});
