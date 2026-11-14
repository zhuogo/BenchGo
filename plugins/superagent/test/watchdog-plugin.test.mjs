import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createWatchdogHost, loadWatchdogPackage as load } from './watchdog-host-fixture.mjs';
import { mountWatchdog, watchdogAgentPreset, watchdogPermissionPreset } from '../src/watchdog-plugin.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-watchdog-plugin-'));
  const host = await createWatchdogHost({ directory: join(directory, 'official-host') });
  let mounted;
  t.after(async () => { await mounted?.dispose(); await host.close(); await rm(directory, { recursive: true, force: true }); });
  const { ctx } = host;
  await ctx.plugin((await load('preset/agent-preset-registry', '@deepseek-ai/cordis-plugin-loader')).default);
  ctx.loader.builtins.group = (await load('preset/agent-preset-registry', '@deepseek-ai/cordis-plugin-group')).default;
  await ctx.plugin((await load('preset/agent-preset-registry', '@deepseek-ai/dsh-agent-preset-registry')).default, { default: 'fixture-base' });
  const unregisterBase = await ctx.agentPresets.register({ id: 'fixture-base', plugins: [] });
  ctx.effect(() => unregisterBase);
  await ctx.plugin((await load('interaction/user-approval', '@deepseek-ai/dsh-user-approval')).default, { policy: 'ask' });
  await ctx.plugin((await load('sandbox/sandbox-policy', '@deepseek-ai/dsh-sandbox-policy')).default, { mode: 'read-only', workspaceRoot: directory });
  ctx.provide('shell', { sandboxMode: 'read-only',
    resolve() { assert.fail('Watchdog fixture cannot execute a shell'); },
    run() { assert.fail('Watchdog fixture cannot execute a shell'); },
    start() { assert.fail('Watchdog fixture cannot execute a shell'); },
  });
  await ctx.plugin((await load('interaction/permission-presets', '@deepseek-ai/dsh-permission-presets')).default, {
    defaultPreset: watchdogPermissionPreset,
    presets: { [watchdogPermissionPreset]: { sandbox: 'read-only', approval: 'ask' } },
  });
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'watchdog-fixture', model: 'no-remote-request' }) });
  let probes = 0;
  const config = { targetId: 'plugin-target', targetUrl: 'http://127.0.0.1:3080', tokenFile: join(directory, 'unused-token') };
  const client = {
    async readFacts() {
      probes++;
      const observedAt = new Date().toISOString();
      return { targetId: config.targetId, facts: { observedAt, bootId: 'plugin-target-boot', cursor: 1, currentCursor: 1,
        complete: true, truncated: false, executions: [], schedulerHeartbeat: { at: observedAt } } };
    },
    async sendSignal() { assert.fail('healthy fixture facts must not emit incident signals'); },
  };
  const dataDirectory = join(directory, 'watchdog-data');
  return { ...host, directory, dataDirectory, config, probes: () => probes, async mount() {
    // Match the base plugin's dependency scope rather than grant the module
    // privileged root access that a deployed Cordis plugin would not have.
    await ctx.plugin({ inject: ['agents', 'sessions', 'sessionPersistence', 'agentPresets', 'permissionPresets', 'agentDefaultModel', 'schedule'],
      async apply(scope) { mounted = await mountWatchdog(scope, { directory: dataDirectory, config, client }); } });
    return mounted;
  } };
}

const tool = (name, execute) => ({ name, description: `Untrusted late registration: ${name}`,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
  execute,
});
async function execute(ctx, agent, name, arguments_ = {}) {
  const result = await ctx.tools.execute({ agent, signal: new AbortController().signal,
    calls: [{ type: 'tool-call', id: `fixture:${name}`, name, arguments: JSON.stringify(arguments_) }] });
  assert.equal(result.results.length, 1);
  return result.results[0].result;
}
const described = async (ctx, agent) => (await ctx.systemPrompt.assemble({ scope: agent })).tools.map(row => row.name).sort();

test('standalone Watchdog mounts real role, permission, Session and Schedule without an assistant or a model request', { timeout: 15000 }, async t => {
  const host = await fixture(t);
  assert.equal(host.ctx.get('assistant'), undefined);
  await assert.rejects(readdir(host.dataDirectory), { code: 'ENOENT' });
  const service = await host.mount();
  const agent = host.ctx.agents.get(service.sessionId);
  assert.ok(agent);
  assert.notEqual(agent.id, (await host.ensureSession()).id, 'the plugin creates its own independent observation Session');
  assert.equal(host.ctx.get('assistant'), undefined);
  assert.equal(host.ctx.get('benchgoWatchdog'), service);
  assert.equal(host.ctx.agentPresets.presetForSession(agent.session), watchdogAgentPreset);
  assert.equal(host.ctx.agentPresets.composedPreset(agent.ctx), watchdogAgentPreset);
  assert.equal(host.ctx.permissionPresets.current(agent.session), watchdogPermissionPreset);
  assert.equal(host.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'read-only');
  assert.equal(host.ctx.approval.overrideOf(agent.session) ?? host.ctx.approval.config.policy, 'ask');
  assert.deepEqual(await described(host.ctx, agent), ['benchgo_watchdog_log']);
  const catalog = await host.ctx.schedule.catalog();
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].id, service.scheduleId);
  assert.equal(catalog[0].target.sessionId, agent.id);

  const receipt = await host.ctx.schedule.run({ id: service.scheduleId });
  for (const deadline = Date.now() + 3000; Date.now() < deadline && service.readLog().checks.at(-1)?.status !== 'completed';) await delay(10);
  await agent.whenIdle();
  const [check] = service.readLog().checks;
  assert.equal(check.status, 'completed');
  assert.equal(check.messageId, receipt.lastDelivery.messageId);
  assert.ok(check.completedAt);
  assert.equal(host.probes(), 1);
  assert.equal(host.requests.length, 0);
  assert.equal(agent.session.snapshotEvents().some(event => event.type === 'request/header'), false);
  assert.equal((await execute(host.ctx, agent, 'benchgo_watchdog_log', { limit: 1 })).isError, false);
  assert.equal(host.ctx.get('assistant'), undefined);
});

test('Watchdog rejects dangerous late tools and a same-name replacement at real tool dispatch', { timeout: 15000 }, async t => {
  const host = await fixture(t);
  const service = await host.mount();
  const agent = host.ctx.agents.get(service.sessionId);
  const trusted = host.ctx.tools.get('benchgo_watchdog_log', agent);
  let effects = 0;
  const executeUntrusted = async () => { effects++; return { changed: true }; };
  // Root shadowing cannot replace the Session's own trusted implementation.
  host.ctx.tools.register(tool('benchgo_watchdog_log', executeUntrusted));
  assert.equal(host.ctx.tools.get('benchgo_watchdog_log', agent), trusted);
  assert.throws(() => agent.ctx.tools.register(tool('benchgo_watchdog_log', executeUntrusted)));
  // These local tools bypass inherited visibility restrictions. The selected
  // Native executor and execution hook must still deny their implementation.
  for (const name of ['bash', 'write', 'schedule_create', 'assistant_task_control', 'plugin_manager']) {
    agent.ctx.tools.register(tool(name, executeUntrusted));
    assert.ok(host.ctx.tools.get(name, agent), 'prove the dispatch guard is tested, not merely a missing registration');
    assert.equal((await execute(host.ctx, agent, name)).isError, true, name);
  }
  assert.deepEqual(await described(host.ctx, agent), ['benchgo_watchdog_log']);
  assert.equal((await execute(host.ctx, agent, 'benchgo_watchdog_log')).isError, false);
  assert.equal(effects, 0);
  assert.equal(host.requests.length, 0);
});
