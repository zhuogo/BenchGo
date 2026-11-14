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
  const state = { mainSessionId: agent.id, threads: [] };
  const remote = { devices: [
    { deviceId: 'server', available: true, items: [{ id: 'selfgo', resourceId: 'selfgo', deviceId: 'server', title: 'SelfGo', path: '/Vibecoding/SelfGo', isDefault: false }], hasMore: true, offset: 0, limit: 1, total: 2 },
    { deviceId: 'offline', available: false, code: 'OFFLINE', items: [], freshness: 'unknown' },
  ], partial: true };
  const ctx = { get: name => name === 'benchgo' ? { directory } : undefined, workspaceRegistry: { list: () => projects } };
  createRouterTools({ ctx, commander: { list: () => [] }, store: { getState: async () => state },
    shutdown: new AbortController(), engine: { catalog: async () => [] },
    collaboration: { resources: async input => { calls.push(input); return remote; }, devices: async () => ({ devices: [{ id: 'server', name: '襄阳服务器' }] }) },
  })({ tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } }, systemPrompt: { section() {}, context() {} } }, { threadId: 'main', agent });
  return { directory, projects, calls, remote, state, agent,
    run: (args = {}, owner = agent) => tools.get('assistant_projects').execute(args, { agent: owner, signal: new AbortController().signal }) };
}

test('local catalog marks durable Recent identity without treating a matching title as Recent', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'recent-workspace.json'), JSON.stringify({ id: 'recent', path: f.projects[0].path }));
  // WorkspaceRegistry fields can be getter-backed rather than own properties.
  f.projects[0] = Object.create(f.projects[0]);
  const value = await f.run();
  assert.equal(value.scope, 'local');
  assert.deepEqual(value.projects.map(row => [row.id, row.title, row.isDefault]), [['recent', 'Renamed', true], ['named', 'default-workspace', false]]);
  assert.equal(Object.getPrototypeOf(value.projects[0]), Object.prototype);
  assert.deepEqual(value.projects[0].sessionIds, ['ungrouped']);
  assert.deepEqual(f.calls, []);
});

test('missing Recent record never guesses by title; native identity remains a fallback', async t => {
  const f = await fixture(t);
  assert.ok((await f.run()).projects.every(row => row.isDefault === false));
  f.projects[0].isDefault = true;
  assert.equal((await f.run()).projects[0].isDefault, true);
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
