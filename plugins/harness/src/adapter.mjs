import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import { singleRequestUsage } from './usage.mjs';
import { decodeRouteModelId } from '../../base/src/picker-catalog.mjs';
import { nativeModelConfig, nativeReasoningEffort } from '../../base/shared/runtime-setting-fields.mjs';
import { mediaResultFile, NATIVE_MEDIA_RESULT } from '../../media/shared/generation-result.mjs';

const providers = { codex: 'Codex', claude: 'Claude Code', pi: 'Pi', opencode: 'OpenCode', gemini: 'Gemini CLI', grok: 'Grok Build', mcode: 'MiniMax Code' };
const route = provider => `commander-${provider}`;
const inputPrefix = 'harness-user:';

/** Native agents remain the tool executor; Harness owns the conversation UI and journal. */
export function mountHarnessAdapter(ctx, commander, { bindOwner } = {}) {
  const active = new Set();
  const metadata = new Map();
  const jobs = new Set();
  let disposed = false;
  class CommanderAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: providers[provider.slice('commander-'.length)] }; }
    providerRetryPolicy() { return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }; }
    async listModels(provider) {
      const native = provider.slice('commander-'.length);
      if (!commander.pickerCatalog) throw new Error('Harness API model catalog is unavailable');
      const models = await commander.pickerCatalog.models(native);
      for (const model of models) metadata.set(`${provider}/${model.id}`, model);
      return models;
    }
    async resolveModel(provider, model) {
      // Exact metadata includes native reasoning choices and supplier identity.
      // A historical route can still resolve its identity after directory removal.
      const binding = decodeRouteModelId(model);
      if (binding) {
        if (!metadata.has(`${provider}/${model}`) && commander.pickerCatalog) await this.listModels(provider);
        const result = metadata.get(`${provider}/${model}`);
        if (!result) throw new Error('所选供应商或模型已不可用');
        return result;
      }
      throw new Error('请从 API 模型目录选择供应商和模型');
    }
    async *stream(options) {
      if (disposed) throw new Error('BenchGo adapter is disposed');
      if (options.purpose) throw new Error(`BenchGo native agents do not support auxiliary ${options.purpose} requests`);
      options.signal?.throwIfAborted();
      const agent = ctx.agents.requireInitiator();
      const owner = String(agent.session.id);
      if (!options.sessionId || String(options.sessionId) !== owner) throw new Error('BenchGo requires the initiating Harness session identity');
      const directory = agent.session.header.cwd;
      if (!directory) throw new Error('BenchGo requires a project working directory');
      const native = options.provider.slice('commander-'.length);
      if (!Object.hasOwn(providers, native)) throw new Error('Unknown BenchGo provider');
      const binding = decodeRouteModelId(options.model);
      if (!binding) throw new Error('请从 API 模型目录选择供应商和模型');
      const nativeModel = binding.model;
      const human = options.messages.filter(message => message.role === 'user' && message.source?.kind === 'user');
      if (!human.length) throw new Error('BenchGo requires a durable human message');
      for (const message of human) {
        if (!message.id) throw new Error('BenchGo requires stable human message identities');
        if (message.content.some(block => block.type !== 'text')) throw new Error('BenchGo currently supports text messages only; attachments are not supported');
      }
      const key = owner;
      if (active.has(key)) throw new Error('A BenchGo request is already active for this conversation and model');
      active.add(key);
      const controller = new AbortController();
      let done;
      const settled = new Promise(resolve => { done = resolve; });
      const job = { controller, settled }; jobs.add(job);
      const abort = () => controller.abort(options.signal.reason);
      options.signal?.addEventListener('abort', abort, { once: true });
      let id, wake, version = 0, finished = false;
      const notify = event => { if (event.sessionId === id) { version++; wake?.(); } };
      let interrupting;
      const cancelled = () => {
        version++; wake?.();
        if (id && ['running', 'waiting'].includes(commander.snapshot(id).status)) {
          interrupting = commander.interrupt(id);
          interrupting.catch(error => { ctx.logger?.warn?.(`BenchGo interrupt failed: ${error.message}`); });
        }
      };
      controller.signal.addEventListener('abort', cancelled);
      commander.on('event', notify);
      try {
        const ownedSessions = commander.list().filter(session => !session.archived && (!session.parentId || session.harnessAdopted) && session.ownerSessionId === owner);
        const existing = ownedSessions.find(session => session.provider === native && session.cwd === directory && session.route?.providerId === binding.providerId);
        if (!existing && ownedSessions.length) throw new Error('此对话已绑定其他工具或供应商模型；请新建聊天，已有记录与运行配置不会被修改');
        const modelChanged = existing && (existing.route?.model !== nativeModel || existing.model !== nativeModel);
        const previousEffort = nativeReasoningEffort(native, existing?.route?.advancedConfig);
        const mustCheckRoute = !existing || modelChanged || options.reasoningEffort !== previousEffort;
        let advancedConfig = existing?.route?.advancedConfig;
        if (mustCheckRoute) {
          const available = await commander.pickerCatalog.models(native, { fresh: true });
          const route = available.find(model => model.id === options.model);
          if (!route) throw new Error('工具供应商或模型已变更，请重新选择模型');
          const defaults = !existing || modelChanged ? await commander.routeService.defaultConfig?.(native, binding.providerId, nativeModel) : undefined;
          advancedConfig = nativeModelConfig(native, defaults ?? advancedConfig, route.reasoning, { reasoningEffort: options.reasoningEffort });
        }
        const effortChanged = nativeReasoningEffort(native, advancedConfig) !== previousEffort;
        if (existing && (modelChanged || effortChanged)) {
          if (['running', 'waiting', 'connecting'].includes(existing.status)) throw new Error('请等待当前轮次完成后再切换模型');
          const driver = commander.drivers.get(existing.id);
          const previousRoute = existing.route, previousModel = existing.model;
          const nextRoute = await commander.routeService.capture({ tool: native, ...binding, advancedConfig });
          if (existing.route?.version && !nextRoute.version) throw new Error('会话绑定服务不可用，无法保存模型变更');
          if (existing.route?.version && ['mode', 'baseURL', 'protocol', 'sourceProtocol', 'credentialRef'].some(key => existing.route[key] !== nextRoute[key])) throw new Error('绑定供应商的地址、协议或凭据引用已更改，请新建会话或恢复原配置。');
          if (driver && (effortChanged || !driver.setModel || JSON.stringify(existing.route?.advancedConfig) !== JSON.stringify(nextRoute.advancedConfig))) await commander.disconnect(existing.id);
          else if (modelChanged) await driver?.setModel(nativeModel);
          const record = commander.get(existing.id);
          record.model = nativeModel;
          record.route = nextRoute;
          try { await commander.persist(); }
          catch (error) {
            record.model = previousModel;
            record.route = previousRoute;
            if (commander.drivers.has(existing.id)) await commander.disconnect(existing.id).catch(() => {});
            throw error;
          }
          commander.event(existing.id, 'model.changed', { providerId: binding.providerId, model: binding.model, nativeModel, reasoningEffort: nativeReasoningEffort(native, advancedConfig) });
        }
        const session = existing ?? await commander.create({ provider: native, cwd: directory, route: { ...binding, ...(Object.keys(advancedConfig ?? {}).length ? { advancedConfig } : {}) }, ownerSessionId: owner, title: human.at(-1).content.map(block => block.text).join('\n').slice(0, 120) });
        id = session.id;
        bindOwner?.(id, agent);
        controller.signal.throwIfAborted();
        if (['disconnected', 'closed', 'failed'].includes(commander.snapshot(id).status)) await commander.connect(id);
        const record = commander.get(id);
        const receipts = record.receipts;
        // The terminal message id keys the whole admitted batch; preceding human messages
        // are context only when entering this native route for the first time.
        const latest = human.at(-1);
        const requestId = `${inputPrefix}${latest.id}`;
        let lastDelivered = -1;
        human.forEach((message, index) => { if (Object.hasOwn(receipts, `${inputPrefix}${message.id}`)) lastDelivered = index; });
        const pending = Object.hasOwn(receipts, requestId) ? [] : human.slice(lastDelivered + 1);
        const text = pending.map(message => message.content.map(block => block.text).join('\n')).join('\n\n');
        const prior = receipts[requestId];
        if (prior?.receipt.status === 'uncertain') throw new Error('Native input acceptance is uncertain; inspect the native session before retrying');
        let cursor = prior ? 0 : record.cursor;
        const receipt = prior?.receipt ?? await commander.submit(id, text, { requestId });
        const usageSamples = new Map();
        let result = '', index = 0, started = false, completed = false;
        while (!completed) {
          controller.signal.throwIfAborted();
          const observed = version;
          const batch = commander.events(id, cursor, 500);
          if (batch.truncated) throw new Error('BenchGo event history was truncated; refusing to replay an incomplete native response');
          cursor = batch.cursor;
          for (const event of batch.events) {
            if (event.turnId !== receipt.turnId) continue;
            if (event.type === 'usage') {
              const sampleId = event.data.id;
              // An unkeyed sample cannot prove that an update is the same request.
              usageSamples.set(sampleId ?? 'unidentified:' + event.seq, event.data);
            } else if (native === 'claude' && event.type === 'message' && event.data.type === 'assistant' && event.data.message?.usage) {
              const message = event.data.message;
              usageSamples.set(message.id ?? 'unidentified:' + event.seq, { usage: message.usage });
            } else if (event.type === 'media.result') {
              const file = mediaResultFile(event.data);
              if (file) {
                const groupId = `native-turn:${JSON.stringify([id, receipt.turnId])}`;
                const duplicate = agent.session.snapshotEvents().some(row => row.type === NATIVE_MEDIA_RESULT
                  && row.data?.groupId === groupId && row.data.url === file.url);
                if (!duplicate) appendPluginRecord(agent.session, NATIVE_MEDIA_RESULT, {
                  groupId, url: file.url, mimeType: file.mimeType,
                  ...(file.external ? { externalUrl: file.url } : { filename: file.name }),
                  ...(typeof event.data.requestId === 'string' ? { requestId: event.data.requestId } : {}),
                });
              }
            } else if (event.type === 'text.delta') {
              if (!started) { started = true; yield { type: 'block-start', index, blockType: 'text' }; }
              result += event.data.text;
              yield { type: 'text-delta', index, text: event.data.text };
            } else if (event.type === 'turn.completed') {
              if (event.data.status !== 'completed') throw new Error(`Native ${native} turn ${event.data.status}: ${JSON.stringify(event.data.error ?? event.data.errors ?? '')}`);
              if (!result && event.data.result) {
                result = String(event.data.result); started = true;
                yield { type: 'block-start', index, blockType: 'text' };
                yield { type: 'text-delta', index, text: result };
              }
              completed = true; finished = true; break;
            } else if (['session.error', 'provider.error', 'input.uncertain'].includes(event.type)) throw new Error(event.data.message ?? JSON.stringify(event.data));
          }
          if (!completed && cursor >= batch.latest) {
            if (['failed', 'closed', 'disconnected'].includes(commander.snapshot(id).status)) throw new Error('Native session disconnected before completing its response');
            await new Promise(resolve => { wake = resolve; if (version !== observed || controller.signal.aborted) resolve(); });
            wake = undefined;
          }
        }
        if (!started) throw new Error('Native agent completed without a text response');
        yield { type: 'block-end', index, block: { type: 'text', text: result } };
        // Let Harness stamp stream timing and fold tokenUsage/contextPressure.
        // A replay has no live decode interval; multiple native requests are not
        // one model context and remain available in the separate billing ledger.
        const usage = prior ? undefined : singleRequestUsage(native, usageSamples);
        if (usage) yield { type: 'usage', usage };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } finally {
        commander.off('event', notify);
        controller.signal.removeEventListener('abort', cancelled);
        options.signal?.removeEventListener('abort', abort);
        try {
          if (interrupting) await interrupting;
          else if (!finished && id && ['running', 'waiting'].includes(commander.snapshot(id).status)) await commander.interrupt(id);
        } finally { active.delete(key); jobs.delete(job); done(); }
      }
    }
  }
  const adapter = new CommanderAdapter();
  const unregister = ctx.llm.registerAdapter(Object.keys(providers).map(route), adapter);
  // Inspect original attachments before LlmRuntime converts unsupported modalities
  // to text placeholders or projects durable file handles into text.
  ctx.on('llm/stream', async function* (options, next) {
    if (Object.keys(providers).some(provider => route(provider) === options.provider)
      && options.messages.some(message => message.role === 'user' && message.source?.kind === 'user'
        && message.content.some(block => block.type !== 'text'))) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_ATTACHMENT', message: 'BenchGo currently supports text messages only; attachments are not supported' } } };
      return;
    }
    yield* next();
  });
  ctx.effect(() => async () => {
    disposed = true;
    unregister();
    for (const job of jobs) job.controller.abort(new Error('BenchGo adapter disposed'));
    await Promise.allSettled([...jobs].map(job => job.settled));
  });
  return adapter;
}
