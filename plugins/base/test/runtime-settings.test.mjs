import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeSettings } from '../src/runtime-settings.mjs';
import { mountTooling } from '../src/tooling.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-harness-options-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = join(directory, 'harness-settings.json');
  const codex = { config: { features: { multi_agent: false }, agents: { max_threads: 3, max_depth: 2 }, model_context_window: 32000, model_auto_compact_token_limit: 20000 } };
  const claude = { settings: { env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0' }, teammateMode: 'tmux', alwaysThinkingEnabled: false, disableAllHooks: true } };
  await writeFile(store, JSON.stringify({ version: 1, configs: { codex, claude } }));
  const providers = {
    async resolve(id) {
      return { baseURL: 'https://api.example.test', apiKey: 'fixture-secret', protocol: id };
    },
  };
  const ctx = { effect() {}, settings: { describe: () => [{ ns: 'subagent', value: { maxDepth: 3, maxActiveSubagents: 8 } }] },
    llm: { async resolveModelInfo() { return { context: { contextWindow: 131072 } }; } } };
  const { fetch, routeService } = await mountTooling(ctx, { store: { directory } }, providers, { installer: {} });
  const request = input => fetch(new Request('http://test/api/commander/tooling', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  }));
  const get = async tool => (await (await request({ action: 'toolConfig', tool })).json()).config;
  const save = (tool, config, changedFields) => request({ action: 'saveToolConfig', tool, config, changedFields });
  return { directory, store, codex, claude, routeService, get, save };
}

test('legacy options remain readable and new native bindings inherit Harness settings', async t => {
  const { directory, store, codex, claude, routeService, get, save } = await fixture(t);
  assert.deepEqual(await get('codex'), codex);
  assert.deepEqual(await get('claude'), claude);
  const codexBinding = { tool: 'codex', providerId: 'openai-responses', model: 'vendor/Codex-exact' };
  const originalRoute = await routeService.capture(codexBinding);

  const threadEdit = structuredClone(codex);
  threadEdit.config.agents.max_threads = 7;
  const depthEdit = structuredClone(codex);
  depthEdit.config.agents.max_depth = 4;
  const responses = await Promise.all([
    save('codex', threadEdit, ['config.agents.max_threads']),
    save('codex', depthEdit, ['config.agents.max_depth']),
  ]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  const nextCodex = { config: { ...codex.config, agents: { max_threads: 7, max_depth: 4 } } };
  assert.deepEqual(await get('codex'), nextCodex);

  const nextClaude = structuredClone(claude);
  nextClaude.settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
  delete nextClaude.settings.teammateMode;
  nextClaude.settings.effortLevel = 'xhigh';
  const saved = await save('claude', nextClaude, ['settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', 'settings.teammateMode', 'settings.effortLevel']);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { config: nextClaude });
  const reloaded = createRuntimeSettings({ directory });
  assert.deepEqual(await reloaded.get('codex'), nextCodex);
  assert.deepEqual(await reloaded.get('claude'), nextClaude);
  assert.deepEqual(JSON.parse(await readFile(store, 'utf8')), { version: 1, configs: { codex: nextCodex, claude: nextClaude } });

  const oldCodex = await routeService.launch({ tool: 'codex', route: originalRoute, sessionId: randomUUID() });
  const newCodex = await routeService.launch({ tool: 'codex', route: await routeService.capture(codexBinding), sessionId: randomUUID() });
  assert(oldCodex.commandArgs.includes('features.multi_agent=true'));
  for (const arg of ['features.multi_agent=true', 'agents.max_threads=8', 'agents.max_depth=3', 'model_context_window=131072']) {
    assert(oldCodex.commandArgs.includes(arg));
    assert(newCodex.commandArgs.includes(arg));
  }
  const claudeBinding = { tool: 'claude', providerId: 'anthropic-messages', model: 'vendor/Claude-exact' };
  const newClaude = await routeService.launch({ tool: 'claude', route: await routeService.capture(claudeBinding), sessionId: randomUUID() });
  assert.equal(newClaude.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1');
  assert.equal(newClaude.settings.effortLevel, undefined);
  assert.equal(newClaude.settings.alwaysThinkingEnabled, undefined);
  assert.equal(newClaude.settings.disableAllHooks, undefined);
  assert.equal(newClaude.settings.model, 'vendor/Claude-exact');
  assert(!Object.hasOwn(newClaude.settings, 'teammateMode'));
});

test('tooling rejects invalid fields and cross-field updates while keeping full saves compatible', async t => {
  const { codex, claude, get, save } = await fixture(t);
  const cases = [
    ['codex', { config: { model: 'other' } }, ['config.agents.max_threads'], /不支持字段 config.model/],
    ['codex', { config: { agents: { max_threads: 33 } } }, ['config.agents.max_threads'], /最大并发代理数/],
    ['codex', { config: { model_context_window: 10000 } }, ['config.model_context_window'], /自动压缩阈值不能超过上下文窗口/],
    ['codex', codex, ['config.agents.max_threads', 'config.agents.max_threads'], /无效的修改字段/],
    ['claude', claude, ['settings.env.ANTHROPIC_API_KEY'], /无效的修改字段/],
    ['claude', { settings: { env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: 1 } } }, ['settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'], /代理团队/],
  ];
  for (const [tool, config, fields, expected] of cases) {
    const response = await save(tool, config, fields);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, expected);
  }
  assert.deepEqual(await get('codex'), codex);
  assert.deepEqual(await get('claude'), claude);
  const response = await save('codex', {});
  assert.equal(response.status, 200);
  assert.deepEqual(await get('codex'), {});
  assert.deepEqual(await get('claude'), claude);
});
