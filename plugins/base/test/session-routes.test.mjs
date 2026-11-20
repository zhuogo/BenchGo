import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSessionRoutes } from '../src/session-routes.mjs';
import { createRuntimeSettings } from '../src/runtime-settings.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-session-routes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entries = {
    responses: { baseURL: 'https://responses.example/v1', apiKey: 'secret-responses', protocol: 'openai-responses', credentialRef: 'RESPONSES_KEY' },
    messages: { baseURL: 'https://messages.example', apiKey: 'secret-messages', protocol: 'anthropic-messages', credentialRef: 'MESSAGES_KEY' },
  };
  const providers = {
    describeRoute: async id => {
      if (!entries[id]) throw Error('unconfigured');
      return { ...entries[id] };
    },
    resolve: async id => ({ ...entries[id] }),
    routerGoProtocolModels: async () => new Map([
      ['Vendor/Exact:Model', { capabilities: ['chat', 'responses'] }],
      ['chat-only', { capabilities: ['chat'] }],
      ['image-only', { capabilities: ['image-generation'] }],
    ]),
  };
  const runtimeSettings = createRuntimeSettings({ directory });
  const routes = createSessionRoutes({ directory, providers, runtimeSettings });
  return { directory, entries, runtimeSettings, routes };
}

test('Codex and Claude launches isolate config, retain exact model and inject the selected API key', async t => {
  const { directory, routes } = await fixture(t);
  const nativeConfig = join(directory, 'external-settings');
  await writeFile(nativeConfig, 'original');
  const codex = await routes.capture({ tool: 'codex', providerId: 'responses', model: 'Vendor/Exact-CODEX' });
  const claude = await routes.capture({ tool: 'claude', providerId: 'messages', model: 'Vendor/Exact-Claude' });
  const codexLaunch = await routes.launch({ tool: 'codex', route: codex, sessionId: randomUUID() });
  const claudeLaunch = await routes.launch({ tool: 'claude', route: claude, sessionId: randomUUID() });
  assert.equal(codexLaunch.env.BENCHGO_SESSION_API_KEY, 'secret-responses');
  assert(codexLaunch.commandArgs.includes('model="Vendor/Exact-CODEX"'));
  assert.equal(claudeLaunch.settings.env.ANTHROPIC_API_KEY, 'secret-messages');
  assert.equal(claudeLaunch.settings.model, 'Vendor/Exact-Claude');
  assert.deepEqual(claudeLaunch.settingSources, []);
  assert.notEqual(codexLaunch.env.CODEX_HOME, claudeLaunch.env.CLAUDE_CONFIG_DIR);
  assert.doesNotMatch(JSON.stringify([codex, claude, codexLaunch.commandArgs]), /secret-/);
  assert.equal(await readFile(nativeConfig, 'utf8'), 'original');
});

test('route mismatches and missing API config fail before native launch', async t => {
  const { routes } = await fixture(t);
  await assert.rejects(routes.capture({ tool: 'codex', providerId: 'messages', model: 'm' }), /Responses/);
  await assert.rejects(routes.capture({ tool: 'claude', providerId: 'responses', model: 'm' }), /Messages/);
  await assert.rejects(routes.capture({ tool: 'codex', providerId: 'unconfigured', model: 'm' }), /供应商/);
  await assert.rejects(routes.capture({ tool: 'pi', providerId: 'responses', model: 'm' }), /隔离 API/);
  await assert.rejects(routes.launch({ tool: 'codex', route: { tool: 'codex', mode: 'subscription' }, sessionId: randomUUID() }), /绑定无效/);
});

test('managed RouterGo shares a credential and uses each native tool URL', async t => {
  const { routes, entries } = await fixture(t);
  entries.routergo = { baseURL: 'https://routergo.cn/api/v1', apiKey: 'fixture-key', protocol: 'openai-responses', credentialRef: 'FIXTURE_KEY', managedRouterGo: true };
  const codex = await routes.capture({ tool: 'codex', providerId: 'routergo', model: 'Vendor/Exact:Model', protocol: 'responses' });
  const claude = await routes.capture({ tool: 'claude', providerId: 'routergo', model: 'Vendor/Exact:Model', protocol: 'anthropic' });
  assert.equal(codex.baseURL + '/responses', 'https://routergo.cn/api/v1/responses');
  assert.equal(claude.baseURL + '/v1/messages', 'https://routergo.cn/api/v1/messages');
  assert.equal(codex.credentialRef, claude.credentialRef);
  await assert.rejects(routes.capture({ tool: 'codex', providerId: 'routergo', model: 'chat-only' }), /未为此模型开放 Responses/);
  await assert.rejects(routes.capture({ tool: 'claude', providerId: 'routergo', model: 'image-only' }), /未启用文本能力/);
  await assert.rejects(routes.capture({ tool: 'claude', providerId: 'routergo', model: 'vendor/Exact:Model' }), /未提供此模型/);
  const launch = await routes.launch({ tool: 'claude', route: claude, sessionId: randomUUID() });
  assert.equal(launch.env.ANTHROPIC_BASE_URL, claude.baseURL);
  assert.equal(launch.env.ANTHROPIC_API_KEY, 'fixture-key');
  entries.routergo = { ...entries.routergo, managedRouterGo: false, baseURL: 'https://other.example' };
  await assert.rejects(routes.launch({ tool: 'claude', route: claude, sessionId: randomUUID() }), /Messages/);
});

test('reconnect uses saved protocol and credential identity while allowing API key rotation', async t => {
  const { routes, entries } = await fixture(t), sessionId = randomUUID();
  const route = await routes.capture({ tool: 'codex', providerId: 'responses', model: 'm' });
  entries.responses.apiKey = 'rotated';
  assert.equal((await routes.launch({ tool: 'codex', route, sessionId })).env.BENCHGO_SESSION_API_KEY, 'rotated');
  entries.responses.credentialRef = 'DIFFERENT_KEY';
  await assert.rejects(routes.launch({ tool: 'codex', route, sessionId }), /已更改/);
  entries.responses.protocol = 'anthropic-messages';
  await assert.rejects(routes.launch({ tool: 'codex', route, sessionId }), /Responses/);
});

test('saved native settings are snapshotted and applied per session', async t => {
  const { routes, runtimeSettings } = await fixture(t);
  await runtimeSettings.save('codex', { config: { agents: { max_threads: 3 } } });
  const route = await routes.capture({ tool: 'codex', providerId: 'responses', model: 'm' });
  await runtimeSettings.save('codex', { config: { agents: { max_threads: 5 } } });
  const nextRoute = await routes.capture({ tool: 'codex', providerId: 'responses', model: 'm' });
  const first = await routes.launch({ tool: 'codex', route, sessionId: randomUUID() });
  const next = await routes.launch({ tool: 'codex', route: nextRoute, sessionId: randomUUID() });
  assert(first.commandArgs.includes('agents.max_threads=3'));
  assert(next.commandArgs.includes('agents.max_threads=5'));
  await assert.rejects(routes.capture({ tool: 'codex', providerId: 'responses', model: 'm', advancedConfig: { config: { model: 'other' } } }), /不支持字段 config.model/);
});
