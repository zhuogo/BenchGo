import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { access, constants } from 'node:fs/promises';
import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import { singleRequestUsage } from './usage.mjs';
import { decodeRouteModelId } from '../../base/src/picker-catalog.mjs';
import { supportsNativeImages } from '../../base/src/provider-access.mjs';
import { nativeModelConfig, nativeReasoningEffort } from '../../base/shared/runtime-setting-fields.mjs';
import { mediaResultFile, NATIVE_MEDIA_RESULT } from '../../media/shared/generation-result.mjs';

const providers = { codex: 'Codex', claude: 'Claude Code', pi: 'Pi', opencode: 'OpenCode', gemini: 'Gemini CLI', grok: 'Grok Build', mcode: 'MiniMax Code' };
const route = provider => `commander-${provider}`;
const inputPrefix = 'harness-user:';
const humanMessages = messages => messages.filter(message => message.role === 'user' && message.source?.kind === 'user');
const imageUnsupported = '当前模型或 Harness 不支持图片输入，请切换模型或移除图片。';

async function nativeImage(store, tool, attachment, signal) {
  signal.throwIfAborted();
  try {
    const { attachmentId: id, mediaType, name } = attachment;
    if (tool === 'codex') {
      const path = store?.imageHostPath(attachment);
      if (!path) throw new Error('Image path is unavailable');
      await access(path, constants.R_OK);
      return { id, path };
    }
    const { data } = await store.readImage(attachment, signal);
    return { id, mediaType, name, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64') };
  } catch (error) {
    signal.throwIfAborted();
    throw new Error('图片附件无法读取，请移除后重新添加。', { cause: error });
  }
}

/** Native agents remain the tool executor; Harness owns the conversation UI and journal. */
export function mountHarnessAdapter(ctx, commander, { bindOwner } = {}) {
  const active = new Set();
  const jobs = new Set();
  let disposed = false;
  class CommanderAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: providers[provider.slice('commander-'.length)] }; }
    providerRetryPolicy() { return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }; }
    async listModels(provider) {
      const native = provider.slice('commander-'.length);
      if (!commander.pickerCatalog) throw new Error('Harness API model catalog is unavailable');
      return commander.pickerCatalog.models(native);
    }
    async resolveModel(provider, model) {
      // Exact metadata includes native reasoning choices and supplier identity.
      const binding = decodeRouteModelId(model);
      if (binding) {
        const result = (await this.listModels(provider)).find(row => row.id === model);
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
      if (!directory) throw new Error('会话缺少工作目录。');
      const native = options.provider.slice('commander-'.length);
      if (!Object.hasOwn(providers, native)) throw new Error('Unknown BenchGo provider');
      const binding = decodeRouteModelId(options.model);
      if (!binding) throw new Error('请从 API 模型目录选择供应商和模型');
      const nativeModel = binding.model;
      const human = humanMessages(options.messages);
      if (!human.length) throw new Error('BenchGo requires a durable human message');
      for (const message of human) {
        if (!message.id) throw new Error('BenchGo requires stable human message identities');
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
        const latest = human.at(-1);
        const requestId = `${inputPrefix}${latest.id}`;
        const receipts = existing ? commander.get(existing.id).receipts : {};
        const prior = receipts[requestId];
        let lastDelivered = -1;
        human.forEach((message, index) => { if (Object.hasOwn(receipts, `${inputPrefix}${message.id}`)) lastDelivered = index; });
        const pending = prior ? [] : human.slice(lastDelivered + 1);
        const imageRefs = pending.flatMap(message => message.content.filter(block => block.type === 'image').map(block => block.attachment));
        const mustCheckRoute = !existing || modelChanged || options.reasoningEffort !== previousEffort;
        let advancedConfig = existing?.route?.advancedConfig;
        if (mustCheckRoute || imageRefs.length) {
          const available = await commander.pickerCatalog.models(native, { fresh: mustCheckRoute });
          const route = available.find(model => model.id === options.model);
          if (!route) throw new Error('工具供应商或模型已变更，请重新选择模型');
          if (imageRefs.length && (!supportsNativeImages(native) || !route.inputModalities?.includes('image'))) throw new Error(imageUnsupported);
          if (mustCheckRoute) {
            const defaults = !existing || modelChanged ? await commander.routeService.defaultConfig?.(native, binding.providerId, nativeModel) : undefined;
            advancedConfig = nativeModelConfig(native, defaults ?? advancedConfig, route.reasoning, { reasoningEffort: options.reasoningEffort });
          }
        }
        const images = [];
        for (const ref of imageRefs) images.push(await nativeImage(ctx.get('attachments'), native, ref, controller.signal));
        const effortChanged = nativeReasoningEffort(native, advancedConfig) !== previousEffort;
        if (existing && (modelChanged || effortChanged)) {
          if (['running', 'waiting', 'connecting'].includes(existing.status)) throw new Error('请等待当前轮次完成后再切换模型');
          const driver = commander.drivers.get(existing.id);
          const previousRoute = existing.route, previousModel = existing.model;
          const nextRoute = await commander.routeService.capture({ tool: native, ...binding, advancedConfig });
          if (existing.route?.version && !nextRoute.version) throw new Error('会话绑定服务不可用，无法保存模型变更');
          if (existing.route?.version && ['mode', 'baseURL', 'protocol', 'sourceProtocol', 'credentialRef'].some(key => existing.route[key] !== nextRoute[key])) throw new Error('绑定供应商的地址、协议或凭据引用已更改，请新建会话或恢复原配置。');
          if (driver && (effortChanged || !driver.setModel || native === 'pi' || native === 'opencode' || JSON.stringify(existing.route?.advancedConfig) !== JSON.stringify(nextRoute.advancedConfig))) await commander.disconnect(existing.id);
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
        if (existing && imageRefs.length && commander.drivers.get(existing.id)?.managedVision === false) {
          await commander.disconnect(existing.id);
        }
        const title = latest.content.map(block => block.type === 'text' ? block.text : block.attachment?.name ?? '').join('\n').trim().slice(0, 120);
        const session = existing ?? await commander.create({ provider: native, cwd: directory, route: { ...binding, ...(Object.keys(advancedConfig ?? {}).length ? { advancedConfig } : {}) }, ownerSessionId: owner, title: title || '图片消息' });
        id = session.id;
        bindOwner?.(id, agent);
        controller.signal.throwIfAborted();
        if (['disconnected', 'closed', 'failed'].includes(commander.snapshot(id).status)) await commander.connect(id);
        const record = commander.get(id);
        const text = pending.map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).filter(Boolean).join('\n\n');
        if (prior?.receipt.status === 'uncertain') throw new Error('Native input acceptance is uncertain; inspect the native session before retrying');
        let cursor = prior ? 0 : record.cursor;
        const receipt = prior?.receipt ?? await commander.submit(id, images.length ? { text, images } : text, { requestId });
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
  // Validate the new prompt before the official runtime projects attachments.
  ctx.on('llm/stream', async function* (options, next) {
    const tool = Object.keys(providers).find(provider => route(provider) === options.provider);
    const latest = tool && humanMessages(options.messages).at(-1);
    if (latest?.content.some(block => block.type === 'image' || block.type === 'file')) {
      const agent = ctx.agents.requireInitiator();
      const binding = decodeRouteModelId(options.model);
      const previous = commander.list().find(session => !session.archived && (!session.parentId || session.harnessAdopted)
        && session.ownerSessionId === String(agent.session.id) && session.cwd === agent.session.header.cwd
        && session.provider === tool && session.route?.providerId === binding?.providerId);
      if (!previous || !Object.hasOwn(commander.get(previous.id).receipts, inputPrefix + latest.id)) {
        if (latest.content.some(block => block.type === 'image')
          && (!supportsNativeImages(tool) || !(await adapter.resolveModel(options.provider, options.model)).inputModalities?.includes('image'))) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_DOES_NOT_SUPPORT_IMAGES', message: imageUnsupported } } };
          return;
        }
        for (const block of latest.content.filter(block => block.type === 'file')) {
          try {
            const path = ctx.get('attachments')?.fileHostPath(block.attachment);
            if (!path || !ctx.get('fs')?.processPathFromHostPath(path)) throw new Error('File path is unavailable');
            await access(path, constants.R_OK);
          } catch {
            yield { type: 'finish', reason: { kind: 'error', failure: { code: 'ATTACHMENT_UNREADABLE', message: '文件附件无法读取，请移除后重新添加。' } } };
            return;
          }
        }
      }
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
