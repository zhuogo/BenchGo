import { channelIds, channelModule, channelDefinition } from './channel-catalog.mjs';
import { createUnifiedChannelIngress } from './channel-ingress.mjs';
import { createDiscordVoice } from './channels/discord-voice.mjs';
import { channelMessageChunks } from './channels/message-chunks.mjs';
import { beforeDelivery, deliveryFailure } from './channels/delivery-outcome.mjs';

/** One lifecycle per saved connection; adapters have no scheduling authority. */
export function createChannelRuntime({ ctx, store, adapterOptions = {}, onInbound }) {
  const adapters = new Map(), failures = new Map(), queues = new Map();
  const ingress = createUnifiedChannelIngress({ store, onInbound: onInbound || adapterOptions.onInbound });
  let closed = false, callbacksAvailable = false;
  const get = channel => adapters.get(channel);
  async function restart(channel) {
    if (channel === 'feishu') return;
    const previous = queues.get(channel) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      await adapters.get(channel)?.dispose?.();
      adapters.delete(channel); failures.delete(channel);
      if (closed) return;
      const row = store.connections.read(channel), module = channelModule(channel);
      const factory = Object.entries(module || {}).find(([key, value]) => /^create.*Adapter$/.test(key) && typeof value === 'function')?.[1];
      if (!factory) throw new Error('渠道适配器不存在');
      const authorizeConnection = input => {
        if (closed || store.connections.read(channel).revision !== row.revision) throw new Error('渠道连接配置已更改');
        return ingress.authorize(channel, input, { expectedRevision: row.revision });
      };
      const options = { ...adapterOptions, authorizeConnection, getConfig: () => {
          const config = store.connections.read(channel).config, definition = module.channelDefinition;
          const keys = new Set(['enabled', 'ownerIds', 'chatIds', ...Object.keys(definition.defaults || {}), ...(definition.fields || []).map(field => field.key)]);
          return Object.fromEntries(Object.entries(config).filter(([key]) => keys.has(key)));
        }, credentials: adapterOptions.credentials || ctx.credentials,
        ingest: async event => {
          const current = store.connections.read(channel);
          if (closed || !current.config.enabled || current.revision !== row.revision) throw new Error('链接配置已变更，请等待重新连接');
          if (event.channel !== channel || event.source?.channel !== channel) throw new Error('渠道来源不匹配');
          return ingress.receive(channel, event, { expectedRevision: row.revision });
        } };
      if (channel === 'discord') options.voice = createDiscordVoice({ getConfig: options.getConfig, ingest: options.ingest, authorizeConnection, transcribe: adapterOptions.transcribe, synthesize: adapterOptions.synthesize });
      const adapter = factory(options);
      if (adapter.send && channelDefinition(channel).capabilities.externalActions.includes('external-send')) adapter.prepareExternalSend = (input, context) => ingress.prepareExternalSend(channel, input, context);
      const send = adapter.send?.bind(adapter);
      if (send) adapter.send = async input => {
        await beforeDelivery(() => authorizeConnection({ operation: 'send', source: input.source }));
        const current = store.connections.read(channel);
        if (!current.config.enabled || (input.source?.connectionRevision !== undefined && input.source.connectionRevision !== current.revision)) throw deliveryFailure('交付来源配置已撤销', 'not_sent');
        if (['api', 'webhook', 'email'].includes(channel)) return send(input);
        const parts = await beforeDelivery(() => channelMessageChunks(input.text)), receipts = [];
        for (let index = 0; index < parts.length; index++) {
          const latest = store.connections.read(channel);
          if (!latest.config.enabled || latest.revision !== current.revision) throw Object.assign(deliveryFailure('交付期间链接配置已更改', receipts.length ? 'unknown' : 'not_sent'),
            receipts.length ? { receipt: { status: 'unknown', parts: receipts } } : {});
          const source = { ...input.source };
          await beforeDelivery(() => authorizeConnection({ operation: 'send', source }));
          if (index < parts.length - 1) delete source.voiceChannelId;
          try {
            const receipt = await send({ ...input, source, text: parts[index], voiceText: input.text, idempotencyKey: parts.length > 1 ? `${input.idempotencyKey}:${index}` : input.idempotencyKey });
            if (receipt?.status !== 'accepted' || !receipt.messageId) throw deliveryFailure('渠道缺少确定发送回执');
            receipts.push(receipt);
          } catch (error) {
            // A rejected later chunk cannot prove that the entire message was unsent.
            if (receipts.length) throw Object.assign(deliveryFailure('部分正文已发送，剩余发送状态待核实'), { receipt: { status: 'unknown', parts: receipts } });
            throw error;
          }
        }
        const last = receipts.at(-1);
        return { ...last, ...(receipts.length > 1 ? { parts: receipts } : {}) };
      };
      adapters.set(channel, adapter);
      if (row.config.enabled) await adapter.start?.();
    }).catch(error => { failures.set(channel, '链接启动失败，请核对凭据和服务环境'); ctx.logger?.warn?.(`SuperAgent ${channel} 链接启动失败`); });
    queues.set(channel, operation);
    return operation;
  }
  return {
    get, restart,
    setCallbacksAvailable(value) { callbacksAvailable = value === true; },
    callbackStatus(channel) { return { available: callbacksAvailable, path: `/api/commander/assistant/channels/${channel}`, ...(callbacksAvailable ? {} : { reason: '当前载体未提供 HTTP 回调服务，请使用带 Web 服务的主机' }) }; },
    start: () => Promise.all(channelIds.slice(1).map(restart)),
    async status(channel) {
      const row = store.connections.read(channel), adapter = get(channel);
      let status;
      try { status = await adapter?.status?.(); } catch { failures.set(channel, '链接状态读取失败'); }
      if (channel === 'discord' && adapterOptions.voiceAvailability) {
        const available = await adapterOptions.voiceAvailability();
        if (!available.available?.voiceInput || !available.available?.readAloud) status = { ...status, voice: { ...status?.voice, available: false, reason: '请先在 Voice 中配置可用的语音输入和朗读服务' } };
      }
      const callback = ['webhook', 'whatsapp'].includes(channel) ? this.callbackStatus(channel) : undefined;
      return { enabled: row.config.enabled, configured: false, authentication: 'unverified', events: 'unverified', sending: 'unverified', connection: { state: row.config.enabled ? 'unavailable' : 'disabled' }, ...status, ...(callback ? { callback, ...(!callbacksAvailable && row.config.enabled ? { events: 'unavailable', error: callback.reason, connection: { state: 'unavailable' } } : {}) } : {}), ...(failures.has(channel) ? { error: failures.get(channel), connection: { state: 'error' } } : {}) };
    },
    async catalog(feishuStatus) { return { channels: await Promise.all(channelIds.map(async channel => ({ ...channelDefinition(channel), status: channel === 'feishu' ? await feishuStatus() : await this.status(channel) }))) }; },
    async dispose() { closed = true; await Promise.allSettled(queues.values()); await Promise.allSettled([...adapters.values()].map(adapter => adapter.dispose?.())); adapters.clear(); },
  };
}

/** Signed callbacks bypass browser login only at this exact transport route. */
export function mountChannelCallbacks(ctx, runtime, feishu) {
  let mounted = false;
  const mount = child => {
  const server = child.get ? child.get('webServer') : child.webServer;
  if (!server?.register) return;
  for (const channel of ['feishu', 'whatsapp', 'webhook']) child.effect(() => server.register({ kind: 'exact', path: `/api/commander/assistant/channels/${channel}`, async handler(req, res) {
    try {
      if (!['POST', 'GET'].includes(req.method)) { res.writeHead(405); res.end(); return; }
      const adapter = channel === 'feishu' ? feishu : runtime.get(channel);
      if (!adapter?.handle) { res.writeHead(503); res.end(); return; }
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
      const request = new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
      const response = await adapter.handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { if (!res.headersSent) res.writeHead(400); res.end('渠道回调失败'); }
  } }));
  runtime.setCallbacksAvailable(true);
  mounted = true;
  child.effect(() => () => runtime.setCallbacksAvailable(false));
  };
  // Cordis owns late service availability and removes routes when the carrier stops.
  if (ctx.inject) ctx.inject(['webServer'], mount);
  else mount(ctx);
  return mounted;
}
