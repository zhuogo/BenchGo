import { feishuConfig, feishuIncomingEvent } from './feishu.mjs';
import { authorizeChannel } from './channels/connection-authorization.mjs';

/** Official SDK owns framing, heartbeat and reconnect; this service owns lifecycle and intake. */
export function createFeishuStream({ getConfig, credentials, ingest, authorizeConnection, allowUnboundAuthorization, loadSDK = () => import('@larksuiteoapi/node-sdk') }) {
  const authority = { authorizeConnection, allowUnboundAuthorization };
  let client, generation = 0, state = 'stopped';
  let lastEventAt = null;
  const pending = new Set();
  const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
  const stop = () => { generation++; client?.close({ force: true }); client = undefined; state = 'stopped'; };
  return {
    stop,
    async dispose() { stop(); await Promise.allSettled([...pending]); },
    status: () => ({ state, transport: 'long-connection', events: lastEventAt ? 'verified' : 'unverified', lastEventAt }),
    async start() {
      stop(); const currentGeneration = generation;
      lastEventAt = null;
      const config = feishuConfig(await getConfig());
      if (generation !== currentGeneration) return { state };
      if (!config.enabled) return { state };
      await authorizeChannel(authority, 'history');
      state = 'connecting';
      try {
        const secret = (await credentials.resolve(config.appSecretRef))?.value;
        if (!secret) throw new Error('missing credential');
        const sdk = await loadSDK();
        if (generation !== currentGeneration) return { state };
        const dispatcher = new sdk.EventDispatcher({ logger: quiet }).register({
          'im.message.receive_v1': data => {
            const handling = (async () => {
            if (generation !== currentGeneration) throw new Error('连接已停用');
            const latest = feishuConfig(await getConfig());
            if (generation !== currentGeneration) throw new Error('连接已停用');
            if (!latest.enabled || latest.appId !== config.appId || latest.appSecretRef !== config.appSecretRef) throw new Error('连接配置已更改');
            const envelope = { header: { event_id: data.event_id || data.message?.message_id, event_type: 'im.message.receive_v1', app_id: config.appId }, event: data };
            const event = feishuIncomingEvent(envelope, latest);
            if (event) {
              await authorizeChannel(authority, 'receive', event.source, event.actor);
              await ingest(event);
              if (generation === currentGeneration) lastEventAt = new Date().toISOString();
            }
            })();
            pending.add(handling);
            return handling.finally(() => pending.delete(handling));
          },
        });
        const active = new sdk.WSClient({ appId: config.appId, appSecret: secret, logger: quiet, autoReconnect: true,
          onReady: () => { if (generation === currentGeneration) state = 'connected'; },
          onError: () => { if (generation === currentGeneration) state = 'failed'; },
          onReconnecting: () => { if (generation === currentGeneration) state = 'reconnecting'; },
          onReconnected: () => { if (generation === currentGeneration) state = 'connected'; },
        });
        client = active;
        await authorizeChannel(authority, 'history');
        await active.start({ eventDispatcher: dispatcher });
        if (generation !== currentGeneration) active.close({ force: true });
        return { state };
      } catch {
        if (generation === currentGeneration) { client?.close({ force: true }); client = undefined; state = 'failed'; }
        throw new Error('飞书长连接启动失败，请检查应用凭据与事件订阅方式');
      }
    },
  };
}
