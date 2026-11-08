import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Context, Service } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import * as Base from '../src/plugin.mjs';
import * as Harness from '../../harness/src/plugin.mjs';
import * as SuperAgent from '../../superagent/src/plugin.mjs';
import * as Voice from '../../voice/src/plugin.mjs';
import { mountLink } from '../../link/src/index.mjs';
import { createSessionAdapter } from '../../link/src/session/adapter.mjs';
import { createNativeAdapter } from '../../link/src/session/native.mjs';

const pauseUntil = async (predicate, message) => {
  const deadline = Date.now() + 8000;
  while (!await predicate()) {
    assert(Date.now() < deadline, message);
    await delay(5);
  }
};

test('five real Cordis module lifetimes preserve base routes and follow current optional services', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-modules-'));
  const projectPath = join(directory, 'project'), linkPath = join(directory, 'link');
  await mkdir(projectPath); await mkdir(linkPath);
  // Ephemeral local carrier only: no relay, cloud probe or provider request.
  await writeFile(join(linkPath, 'devices.json'), JSON.stringify({ host: '127.0.0.1', port: 0 }));
  const ctx = new Context(), routes = new Map(), upgrades = new Map(), duplicateRoutes = [], peers = new Set();
  const originalFetch = globalThis.fetch;
  let networkAttempts = 0;
  globalThis.fetch = async () => { networkAttempts++; throw new Error('Lifecycle fixtures must not send network requests'); };
  t.after(async () => { try { await ctx.fiber.dispose(); } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); } });
  const register = (registry, route) => {
    if (registry.has(route.path)) duplicateRoutes.push(route.path);
    assert(!registry.has(route.path), `duplicate route ${route.path}`);
    registry.set(route.path, route);
    return () => { if (registry.get(route.path) === route) registry.delete(route.path); };
  };
  const workspace = { id: 'project', path: projectPath, title: 'Project', sessionIds: ['official-session'] };
  ctx.provide('path', { baseDir: directory });
  ctx.provide('systemPrompt', { tools() {}, section() {} });
  ctx.provide('agents', { list: () => [], get: () => undefined,
    create: async () => { throw new Error('Lifecycle fixture must not execute agents'); } });
  ctx.provide('sessionQuery', { listSessions: async () => [], readSession: async () => ({ events: [] }) });
  const projectionRegistrations = new Map();
  // Preserve the official caller-scoped registration lifetime and handle shape.
  class FixtureSessionProjections extends Service {
    constructor(context) { super(context, 'sessionProjections'); }
    async register(definition) {
      const dispose = this.ctx.effect(() => {
        assert(!projectionRegistrations.has(definition.key), `duplicate projection ${definition.key}`);
        projectionRegistrations.set(definition.key, definition);
        return () => projectionRegistrations.delete(definition.key);
      });
      const stateOf = () => definition.init();
      return { stateOf, readerFor: session => () => stateOf(session), dispose: async () => { await dispose(); } };
    }
  }
  await ctx.plugin(FixtureSessionProjections);
  ctx.provide('tokenMeter', {});
  ctx.provide('settings', { describe: () => [] });
  ctx.provide('credentials', { resolve: async () => undefined });
  ctx.provide('workspaceRegistry', { list: () => [workspace], get: id => id === workspace.id ? workspace : undefined, create: async path => ({ ...workspace, path }) });
  ctx.provide('sessionController', {});
  ctx.provide('clientModules', {});
  ctx.provide('webServer', { registerUpgrade: route => register(upgrades, route) });
  ctx.provide('connection', {
    fetch: { register: route => register(routes, route) },
    createPeer() { const peer = { dispose: async () => { peers.delete(peer); } }; peers.add(peer); return peer; },
  });
  // Mock only official wire responses; the Link adapter and its scoped context are real.
  ctx.provide('typertGateway', {
    async invoke({ method }) {
      if (method === 'list') return { items: [{ sessionId: 'official-session', running: false, projections: { values: { title: 'Official chat' } } }] };
      if (method === 'modelCatalog') return { groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: 'Opaque:Model/01', name: 'Model' }] }] };
      throw new Error(`Unexpected RPC ${method}`);
    },
    wireStream: { async *open(_name, _args, _input, _peer, signal) {
      yield { type: 'ready', clientId: 'fixture-client' };
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    } },
  });
  await ctx.plugin(LlmRuntime); await ctx.plugin(ToolRuntime);
  const base = ctx.plugin(Base, { dataDir: directory, usage: { enabled: false }, voice: { dataDir: join(directory, 'voice') } });
  await base;
  await pauseUntil(() => ctx.get('benchgoTooling') && routes.has('/api/commander/updates'), 'base services did not settle');
  // Installation detection is an external process boundary, unrelated to lifecycle ownership.
  ctx.get('benchgoTooling').installer.list = async () => [{ id: 'codex', name: 'Codex', installed: true, chatSupported: true, configSupported: true }];
  const request = async (path, body) => {
    const route = routes.get(path);
    assert(route, `missing route ${path}`);
    const response = await route.fetch(new Request('http://localhost' + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  let moduleFibers = [];
  const availability = async expected => {
    await pauseUntil(async () => {
      const result = await request('/api/benchgo/modules');
      return Object.entries(expected).every(([name, available]) => result.body.modules[name].available === available);
    }, 'module availability did not settle: ' + JSON.stringify(expected)).catch(error => {
      for (const [name, fiber] of moduleFibers) {
        const cause = fiber._error;
        console.error('module fixture diagnostic', name, 'state', fiber.state,
          cause?.stack || cause || 'no fiber error',
          'projections', [...projectionRegistrations.keys()]);
      }
      throw error;
    });
    assert.deepEqual(duplicateRoutes, []);
  };
  const basePaths = ['/api/benchgo/modules', '/api/benchgo/skills', '/api/commander', '/api/commander/tooling', '/api/commander/usage', '/api/commander/updates'];
  const baseEntries = new Map(basePaths.map(path => [path, routes.get(path)]));
  const checkBase = async () => {
    for (const [path, entry] of baseEntries) assert.equal(routes.get(path), entry, `optional lifecycle replaced ${path}`);
    const skills = await request('/api/benchgo/skills', { action: 'list' });
    assert.equal(skills.status, 200);
    assert.equal(skills.body.available, false);
    assert.equal(skills.body.projects[0].id, 'project');
    assert.equal((await request('/api/commander', { action: 'state' })).body.projects[0].id, 'project');
    assert.equal((await request('/api/commander', { action: 'ensureRecent', workspaceId: 'project' })).status, 200);
    for (const action of ['providers', 'profiles', 'catalog', 'pickerCatalog']) assert.equal((await request('/api/commander/tooling', { action })).status, 200, action);
    const usage = await request('/api/commander/usage', { start: '2026-11-01', end: '2026-11-02' });
    assert.equal(usage.status, 200, usage.body.error);
    assert.equal((await request('/api/commander/updates', { action: 'status' })).status, 200);
  };
  await availability({ base: true, harness: false, superagent: false, voice: false, link: false });
  await checkBase();
  assert.deepEqual((await request('/api/commander', { action: 'binding', harnessSessionId: 'official-session' })).body, { bound: false });
  assert.equal((await request('/api/commander', { action: 'providers' })).status, 503);

  let linkSessions, nativeSessions, linkService;
  const Link = { inject: ['benchgo', 'connection', 'workspaceRegistry', 'typertGateway', 'sessionController', 'webServer', 'clientModules'], async apply(child) {
    linkService = await mountLink(child, { directory: linkPath, env: {} });
    child.provide('benchgoLink', linkService);
    linkSessions = createSessionAdapter(child); nativeSessions = createNativeAdapter(child);
    child.effect(() => () => linkSessions.close());
  } };
  let harness = ctx.plugin(Harness), assistant = ctx.plugin(SuperAgent), voice = ctx.plugin(Voice), link = ctx.plugin(Link);
  moduleFibers = [['harness', harness], ['superagent', assistant], ['voice', voice], ['link', link]];
  await Promise.all([harness.await(), assistant.await(), voice.await(), link.await()]);
  await availability({ base: true, harness: true, superagent: true, voice: true, link: true });
  assert(projectionRegistrations.has('benchgoChannelSource'));
  await checkBase();
  assert.equal(ctx.llm.listProviders().filter(row => row.id.startsWith('commander-')).length, 8);
  assert.equal(ctx.tools.schemas().filter(row => row.name.startsWith('commander_')).length, 14);
  const oldCommander = ctx.get('commander'), oldHarness = ctx.get('benchgoHarnessWeb'), oldAssistant = ctx.get('assistant');
  oldCommander.providers.set('codex', { config: {}, constructor: { capabilities: {} }, async connect() { return { nativeId: 'fixture-native', async close() {} }; } });
  await oldCommander.create({ provider: 'codex', ownerSessionId: 'official-session', projectId: 'project', cwd: projectPath, model: 'Opaque/Native:01' });
  assert.equal((await request('/api/commander', { action: 'binding', harnessSessionId: 'official-session' })).body.bound, true);
  const direct = await oldCommander.create({ provider: 'codex', ownerSessionId: 'commander-web:fixture', projectId: 'project', cwd: projectPath, model: 'Opaque/Native:02' });
  assert.equal(nativeSessions.list().length, 1);
  const officialSessions = async () => {
    const state = await linkSessions.dispatch({ action: 'state' }, { id: 'paired-device' });
    assert.equal(state.sessions[0].id, 'official-session');
    assert.equal(state.models[0].model, 'Opaque:Model/01');
  };
  await officialSessions();

  await assistant.dispose();
  assert(!projectionRegistrations.has('benchgoChannelSource'));
  await availability({ base: true, harness: true, superagent: false, voice: true, link: true });
  await checkBase(); await officialSessions();
  assert(!routes.has('/api/commander/assistant'));
  await assert.rejects(oldAssistant.dispatch({ action: 'state' }), error => error.code === 'ASSISTANT_UNAVAILABLE');
  await assert.rejects(linkSessions.dispatch({ action: 'notifications' }, { id: 'paired-device' }), error => error.status === 503);
  assistant = ctx.plugin(SuperAgent); await assistant;
  await availability({ superagent: true });
  assert.notEqual(ctx.get('assistant'), oldAssistant);
  assert(projectionRegistrations.has('benchgoChannelSource'));

  await voice.dispose();
  await availability({ base: true, harness: true, superagent: true, voice: false, link: true });
  await checkBase(); await officialSessions();
  assert(!routes.has('/api/voice'));
  assert(!upgrades.has('/api/voice/realtime'));
  assert.equal((await request('/api/commander/assistant/voice/worklet')).status, 503);
  voice = ctx.plugin(Voice); await voice;
  await availability({ voice: true });

  await harness.dispose();
  await availability({ base: true, harness: false, superagent: false, voice: true, link: true });
  await checkBase(); await officialSessions();
  assert.equal(ctx.get('commander'), undefined);
  assert.deepEqual((await request('/api/commander', { action: 'state' })).body.sessions, []);
  assert.deepEqual((await request('/api/commander', { action: 'binding', harnessSessionId: 'official-session' })).body, { bound: false });
  assert.equal(ctx.llm.listProviders().filter(row => row.id.startsWith('commander-')).length, 0);
  assert.equal(ctx.tools.schemas().filter(row => row.name.startsWith('commander_')).length, 0);
  assert.deepEqual(nativeSessions.list(), []);
  await assert.rejects(nativeSessions.dispatch({ action: 'history', id: 'native:' + direct.id }), error => error.status === 503);
  assert(!routes.has('/api/commander/assistant'));
  await assert.rejects(oldHarness.dispatch({ action: 'providers' }), error => error.code === 'HARNESS_UNAVAILABLE');
  await assert.rejects(access(join(directory, 'owner.lock')), { code: 'ENOENT' });
  harness = ctx.plugin(Harness); await harness;
  await availability({ harness: true, superagent: true });
  assert.notEqual(ctx.get('commander'), oldCommander);
  assert.equal(ctx.llm.listProviders().filter(row => row.id.startsWith('commander-')).length, 8);

  await link.dispose();
  await availability({ base: true, harness: true, superagent: true, voice: true, link: false });
  await checkBase();
  assert.equal(peers.size, 0);
  assert(!routes.has('/api/commander-link')); assert(!routes.has('/api/commander-devices'));
  assert.equal(linkService.status().enabled, false);
  link = ctx.plugin(Link); await link;
  await availability({ link: true });
  await officialSessions(); await checkBase();

  await ctx.fiber.dispose();
  assert.equal(projectionRegistrations.size, 0);
  assert.equal(routes.size, 0); assert.equal(upgrades.size, 0); assert.equal(peers.size, 0);
  assert.deepEqual(duplicateRoutes, []);
  assert.equal(linkService.status().enabled, false);
  assert.equal(networkAttempts, 0);
  await assert.rejects(access(join(directory, 'owner.lock')), { code: 'ENOENT' });
});
