import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouterTools } from '../src/router-tools.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-router-projects-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projects = [
    { id: 'recent', title: 'Renamed', path: join(directory, 'recent'), sessionIds: ['ungrouped'] },
    { id: 'named', title: 'default-workspace', path: join(directory, 'named'), sessionIds: [] },
  ];
  const tools = new Map(), calls = [], agent = { id: 'router' };
  const failures = {};
  const metrics = { catalogReads: 0 };
  const devices = [{ id: 'local', name: '开发电脑' }, { id: 'server', name: '襄阳服务器' }, { id: 'offline', name: '离线设备' }];
  const state = { mainSessionId: agent.id, threads: [] };
  const remote = { devices: [
    { deviceId: 'server', available: true, items: [{ id: 'selfgo', resourceId: 'selfgo', deviceId: 'server', title: 'SelfGo', path: '/Vibecoding/SelfGo', isDefault: false }], hasMore: true, offset: 0, limit: 1, total: 2 },
    { deviceId: 'offline', available: false, code: 'OFFLINE', items: [], freshness: 'unknown' },
  ], partial: true };
  const ctx = { get: name => name === 'benchgo' ? { directory } : undefined, workspaceRegistry: { list: () => projects } };
  createRouterTools({ ctx, commander: { list: () => [] }, store: { getState: async () => state },
    shutdown: new AbortController(), engine: { catalog: async () => { metrics.catalogReads++; return []; } },
    collaboration: { resources: async input => { calls.push(input); if (failures.resources) throw failures.resources; return remote; }, devices: async () => {
      failures.onDirectory?.();
      if (failures.directory) throw failures.directory;
      return { activeId: 'server', scope: { mode: 'current' }, devices };
    } },
  })({ tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } }, systemPrompt: { section() {}, context() {} } }, { threadId: 'main', agent });
  return { directory, projects, calls, remote, state, agent, failures, devices, metrics,
    run: (args = {}, owner = agent, signal = new AbortController().signal) => tools.get('assistant_projects').execute(args, { agent: owner, signal }) };
}

test('local catalog marks durable Recent identity without treating a matching title as Recent', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'recent-workspace.json'), JSON.stringify({ id: 'recent', path: f.projects[0].path }));
  // WorkspaceRegistry fields can be getter-backed rather than own properties.
  f.projects[0] = Object.create(f.projects[0]);
  const value = await f.run({ scope: 'local' });
  assert.equal(value.scope, 'local');
  assert.deepEqual(value.projects.map(row => [row.id, row.title, row.isDefault]), [['recent', 'Renamed', true], ['named', 'default-workspace', false]]);
  assert.equal(Object.getPrototypeOf(value.projects[0]), Object.prototype);
  assert.deepEqual(value.projects[0].sessionIds, ['ungrouped']);
  assert.deepEqual(f.calls, []);
});

test('missing Recent record never guesses by title; native identity remains a fallback', async t => {
  const f = await fixture(t);
  assert.ok((await f.run({ scope: 'local' })).projects.every(row => row.isDefault === false));
  f.projects[0].isDefault = true;
  assert.equal((await f.run({ scope: 'local' })).projects[0].isDefault, true);
});

test('default inventory actually queries every saved outgoing device and preserves local folders independently', async t => {
  const f = await fixture(t);
  f.projects.push({ id: 'notes', title: '服务器管理', path: join(f.directory, '服务器管理', '襄阳服务器') });
  const result = await f.run({ limit: 1 });
  assert.equal(result.scope, 'all');
  assert.equal(result.partial, true);
  assert.deepEqual(result.directory, { available: true });
  assert.deepEqual(f.calls.map(call => call.deviceIds), [['server', 'offline']]);
  assert.equal(result.devices[0].name, '开发电脑');
  assert.equal(result.devices[0].items[0].deviceId, 'local');
  assert.equal(result.devices[0].hasMore, true);
  assert.equal(result.devices[1].name, '襄阳服务器');
  assert.equal(result.devices[1].items[0].path, '/Vibecoding/SelfGo');
  assert.equal(result.devices[1].hasMore, true);
  assert.equal(result.devices[2].available, false);
  assert.equal(result.devices[2].code, 'OFFLINE');
  assert.equal(f.metrics.catalogReads, 0, 'project inventory does not read unrelated model configuration');
  assert.equal((await f.run({ offset: 2, limit: 1 })).devices[0].items[0].id, 'notes');
  assert.equal(f.calls[1].offset, 2);
});

test('successful empty local-only inventory does not invent missing devices or contact resources', async t => {
  const f = await fixture(t);
  f.devices.splice(1);
  f.projects.splice(0);
  const result = await f.run();
  assert.equal(result.partial, false);
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].available, true);
  assert.deepEqual(result.devices[0].items, []);
  assert.equal(result.devices[0].total, 0);
  assert.equal(result.devices[0].hasMore, false);
  assert.deepEqual(f.calls, []);
});

test('cancelled inventory never turns cancellation into an unavailable-device result', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const reason = new Error('cancelled by owner');
  f.failures.onDirectory = () => controller.abort(reason);
  f.failures.directory = reason;
  await assert.rejects(f.run({}, f.agent, controller.signal), error => error === reason);
  assert.deepEqual(f.calls, []);
});

test('cancellation after a successful directory read also propagates for local-only devices', async t => {
  const f = await fixture(t);
  f.devices.splice(1);
  const controller = new AbortController(), reason = new Error('cancelled during directory read');
  f.failures.onDirectory = () => controller.abort(reason);
  await assert.rejects(f.run({}, f.agent, controller.signal), error => error === reason);
  assert.deepEqual(f.calls, []);
});

test('damaged local Recent metadata cannot prevent healthy remote catalogs from being queried', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'recent-workspace.json'), 'invalid JSON');
  const result = await f.run();
  assert.equal(result.devices[0].available, false);
  assert.equal(result.devices[0].code, 'LOCAL_CATALOG_FAILED');
  assert.equal(result.devices[0].total, undefined, 'unavailable local catalog is not reported as zero projects');
  assert.equal(result.devices[1].available, true);
  assert.equal(result.devices[1].items[0].resourceId, 'selfgo');
  assert.deepEqual(f.calls[0].deviceIds, ['server', 'offline']);
  assert.equal(result.partial, true);
});

test('directory or resource failure retains local facts and explicit unknown coverage', async t => {
  const f = await fixture(t);
  f.failures.directory = new Error('private connection details');
  let result = await f.run();
  assert.equal(result.devices[0].items.length, 2);
  assert.equal(result.partial, true);
  assert.equal(result.directory.available, false);
  assert.equal(result.directory.code, 'DIRECTORY_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(result), /private connection/);
  delete f.failures.directory;
  f.failures.resources = new Error('remote secret');
  result = await f.run();
  assert.equal(result.devices[0].available, true);
  assert.equal(result.devices[1].available, false);
  assert.equal(result.devices[1].code, 'QUERY_FAILED');
  assert.equal(result.devices[2].available, false);
  assert.equal(result.partial, true);
  assert.doesNotMatch(JSON.stringify(result), /remote secret/);
});

test('all-device inventory retains owner boundaries and rejects conflicting local selectors', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({}, { id: 'worker' }), { code: 'HISTORY_SCOPE_DENIED' });
  await assert.rejects(f.run({ scope: 'local', deviceId: 'server' }), /不能同时指定设备/);
  f.state.mainSessionId = 'other';
  await assert.rejects(f.run(), { code: 'HISTORY_SCOPE_DENIED' });
  assert.equal((await f.run({ scope: 'local' })).scope, 'local');
  assert.deepEqual(f.calls, []);
});

test('remote catalogs retain owning device, pagination and partial failures without reading local state', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'recent-workspace.json'), 'invalid JSON');
  const result = await f.run({ deviceIds: ['server', 'offline'], offset: 0, limit: 1 });
  assert.equal(result, f.remote);
  assert.deepEqual(f.calls[0].deviceIds, ['server', 'offline']);
  assert.equal(f.calls[0].kind, 'projects');
  assert.equal(f.calls[0].limit, 1);
  await f.run({ deviceId: 'server', offset: 1, limit: 1 });
  assert.equal(f.calls[1].deviceId, 'server');
  assert.equal(f.calls[1].offset, 1);
  await assert.rejects(f.run({ deviceId: 'server' }, { id: 'worker' }), { code: 'HISTORY_SCOPE_DENIED' });
  f.state.mainSessionId = 'other';
  await assert.rejects(f.run({ deviceId: 'server' }), { code: 'HISTORY_SCOPE_DENIED' });
});
