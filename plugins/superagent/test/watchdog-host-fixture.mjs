import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Worktrees can share the already-built official dependencies through node_modules.
const checkout = fileURLToPath(new URL('../../../deepseek-harness/', import.meta.url));
const official = existsSync(join(checkout, 'packages/schedule/schedule/lib/index.js'))
  ? checkout : dirname(realpathSync(join(checkout, 'node_modules')));
const load = (directory, name) => import(pathToFileURL(createRequire(join(official, `packages/${directory}/package.json`)).resolve(name)).href);
export { load as loadWatchdogPackage };
const { Context } = await load('core/agent-loop', '@deepseek-ai/cordis');
const { default: LlmRuntime, LlmAdapter } = await load('core/agent-loop', '@deepseek-ai/dsh-llm');
const core = await Promise.all(['session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop'].map(name => load('core/agent-loop', `@deepseek-ai/dsh-${name}`)));

/** Real official Schedule, JSON storage, Agent inbox and JSONL; no external model or shell. */
export async function createWatchdogHost({ directory, sessionId = 'watchdog-schedule-fixture' }) {
  const ctx = new Context();
  const requests = [];
  const deliveries = [];
  await ctx.plugin(LlmRuntime);
  for (let index = 0; index < core.length; index++) await ctx.plugin(core[index].default, index === core.length - 1 ? { agents: [] } : undefined);
  await ctx.plugin(await load('core/tool-executor-native', '@deepseek-ai/dsh-tool-executor-native'));
  await ctx.plugin(await load('session/session-persistence-jsonl', '@deepseek-ai/dsh-session-persistence-jsonl'), { root: join(directory, 'sessions'), compression: 'none' });
  await ctx.plugin((await load('storage/storage', '@deepseek-ai/dsh-storage')).default);
  await ctx.plugin(await load('storage/storage-json', '@deepseek-ai/dsh-storage-json'), { root: join(directory, 'host-storage') });
  await ctx.plugin(await load('storage/storage-domain', '@deepseek-ai/dsh-storage-domain'), { backend: 'json' });
  class NoRequestAdapter extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 131072 } }; }
    async *stream(request) {
      requests.push(request);
      throw new Error('Watchdog Schedule fixture must not request a model');
    }
  }
  ctx.llm.registerAdapter(['watchdog-fixture'], new NoRequestAdapter());
  const setup = scope => {
    scope.on('agent/pre-step', async (payload, next) => {
      if (!payload.messages.length || payload.messages.some(message => message.source?.kind !== 'schedule')) return next();
      deliveries.push(...payload.messages);
      return { kind: 'enter', messages: [] };
    }, { prepend: true });
  };
  const ensureSession = async () => {
    let agent = ctx.agents.get(sessionId);
    if (agent) return agent;
    const options = { sessionId, setup, agentOptions: { provider: 'watchdog-fixture', model: 'no-remote-request' } };
    const stored = await ctx.sessionPersistence.stat(sessionId);
    const handle = stored ? await ctx.agents.resume({ resumeSessionId: sessionId, setup, agentOptions: options.agentOptions }) : await ctx.agents.create(options);
    agent = handle.agent;
    await ctx.sessions.flush(agent.session);
    return agent;
  };
  ctx.provide('sessionController', {
    resolveAgent: async id => {
      if (id !== sessionId) throw new Error('Watchdog fixture cannot activate another session');
      return { agent: await ensureSession() };
    },
  });
  await ensureSession();
  await ctx.plugin((await load('schedule/schedule', '@deepseek-ai/dsh-schedule')).default);
  let closed = false;
  return { ctx, requests, deliveries, ensureSession, async close() {
    if (closed) return;
    closed = true;
    await ctx.fiber.dispose();
  } };
}
