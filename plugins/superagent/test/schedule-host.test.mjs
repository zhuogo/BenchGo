import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createAssistantStore } from '../src/store.mjs';
import { createAssistantEngine } from '../src/engine.mjs';
import { createScheduleBridge } from '../src/schedule-bridge.mjs';
import { createAssessmentRunner } from '../src/assessment-runner.mjs';
import { authorizeAssessment, readAssessmentPolicy } from '../src/assessment-policy.mjs';

const load = (directory, name) => import(pathToFileURL(createRequire(new URL(`../../../deepseek-harness/packages/${directory}/package.json`, import.meta.url)).resolve(name)).href);
const { Context } = await load('core/agent-loop', '@deepseek-ai/cordis');
const { default: LlmRuntime, LlmAdapter } = await load('core/agent-loop', '@deepseek-ai/dsh-llm');
const core = await Promise.all(['session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop'].map(name => load('core/agent-loop', `@deepseek-ai/dsh-${name}`)));

test('official Host Schedule persists a due reminder and enters SuperAgent Eval without a Router model request', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'superagent-schedule-host-'));
  const ctx = new Context();
  let engine, bridge, store, runner;
  t.after(async () => {
    await bridge?.stop(); await runner?.stop(); await engine?.dispose(); await ctx.fiber.dispose();
    store?.close(); await rm(directory, { recursive: true, force: true });
  });
  await ctx.plugin(LlmRuntime);
  for (let i = 0; i < core.length; i++) await ctx.plugin(core[i].default, i === core.length - 1 ? { agents: [] } : undefined);
  await ctx.plugin((await load('llm/token-meter', '@deepseek-ai/dsh-token-meter')).default);
  await ctx.plugin(await load('session/session-persistence-jsonl', '@deepseek-ai/dsh-session-persistence-jsonl'), { root: join(directory, 'sessions'), compression: 'none' });
  await ctx.plugin((await load('storage/storage', '@deepseek-ai/dsh-storage')).default);
  await ctx.plugin(await load('storage/storage-json', '@deepseek-ai/dsh-storage-json'), { root: join(directory, 'host-storage') });
  await ctx.plugin(await load('storage/storage-domain', '@deepseek-ai/dsh-storage-domain'), { backend: 'json' });
  ctx.provide('sessionController', { resolveAgent: async id => {
    const agent = ctx.agents.get(id);
    if (!agent) throw new Error('Unknown schedule session');
    return { agent };
  } });
  await ctx.plugin((await load('schedule/schedule', '@deepseek-ai/dsh-schedule')).default);
  ctx.provide('sessionQuery', { listSessions: () => ctx.sessionPersistence.list() });
  let requests = 0;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id }; }
    async *stream() { requests++; yield { type: 'finish', reason: { kind: 'stop' } }; }
  }
  ctx.llm.registerAdapter(['schedule-test'], new Adapter());
  store = await createAssistantStore({ dataDirectory: join(directory, 'assistant') });
  await store.updateConfig({ models: [{ providerId: 'schedule-test', modelId: 'exact-model' }] });
  const readPolicy = () => readAssessmentPolicy(store, { list: () => [] });
  // Match the plugin's injecting scope, so optional service visibility is tested.
  let mounted;
  await ctx.plugin({ inject: ['agents', 'llm', 'sessionQuery', 'sessionProjections', 'tokenMeter'], async apply(scope) {
    bridge = createScheduleBridge({ ctx: scope, store, readPolicy });
    mounted = bridge.available();
    engine = await createAssistantEngine({ ctx: scope, store, scheduleBridge: bridge, compactionPlugin: (await load('compaction/compaction-basic', '@deepseek-ai/dsh-compaction-basic')).default });
  } });
  assert.equal(mounted, true, 'Schedule must be available from the actual scoped plugin');
  await bridge.start();
  const agent = await engine.ensureSession();
  const record = await ctx.schedule.create({ title: 'Host integration', prompt: '检查一次并交付证据', timing: { kind: 'after', after_seconds: 1 },
    target: { kind: 'session', sessionId: agent.id } }, agent.id);
  let history;
  for (const deadline = Date.now() + 6000; Date.now() < deadline;) {
    history = await ctx.schedule.history({ id: record.id, limit: 1 });
    if (history.records?.length && store.orchestration.candidates().length) break;
    await delay(20);
  }
  assert.equal(history.records.length, 1, 'official Host persisted the inbox delivery receipt');
  await agent.whenIdle();
  assert.equal(requests, 0, 'Schedule cannot execute directly in the Router conversation');
  const [candidate] = store.orchestration.candidates();
  assert.equal(candidate.status, 'queued');
  const trigger = store.orchestration.getTrigger(candidate.triggerId);
  assert.equal(trigger.source.scheduleId, record.id);
  assert.equal(trigger.source.occurrenceAt, record.scheduledAt);
  assert.equal(trigger.content, history.records[0].prompt);
  await bridge.tick();
  assert.equal(store.orchestration.candidates().length, 1, 'receipt scan deduplicates the inbox hook');
  runner = createAssessmentRunner({ database: store.orchestration, readPolicy, authorize: authorizeAssessment,
    assess: async ({ candidates }) => candidates.map(row => ({ candidateId: row.candidateId, outcome: 'accept', target: trigger.content, acceptance: '提供证据', reason: 'official due reminder' })),
  });
  await runner.tick();
  assert.equal(store.orchestration.listTickets().length, 1);
  assert.equal(store.orchestration.listTickets()[0].mandate.admission, 'desktop-schedule');
});
