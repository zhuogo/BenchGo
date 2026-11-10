import { currentHumanInstruction } from './desktop-delegation-service.mjs';

/** A fresh, narrow projection of Link facts for the local owner's Router. */
export function createAssistantDeviceStatus({ ctx, store, now = Date.now }) {
  return async ({ agent, ownerAgent, threadId }) => {
    const observedAt = new Date(now()).toISOString();
    const unavailable = (code, reason) => ({ available: false, code, reason, observedAt, liveConnections: 'unknown' });
    const ownerRequired = () => unavailable('OWNER_REQUIRED', '设备状态仅供当前本机主人会话查询，不能向外部渠道披露。');
    if (!ownerAgent || agent !== ownerAgent || !currentHumanInstruction(ctx, ownerAgent)?.message?.id) return ownerRequired();
    const state = await store.getState();
    const thread = threadId === 'main' ? { sessionId: state.mainSessionId } : state.threads.find(row => row.id === threadId);
    if (!thread || thread.archived || thread.sourceKey || thread.source && thread.source.channel !== 'desktop'
      || thread.sessionId !== ownerAgent.id) return ownerRequired();
    try {
      // Resolve per call: Link may be enabled, replaced or removed independently.
      const link = ctx.get('benchgoLink');
      if (typeof link?.status !== 'function') return unavailable('LINK_UNAVAILABLE', 'Link 设备状态服务当前不可用，无法确认已授权设备。');
      const status = await link.status();
      if (typeof status?.enabled !== 'boolean' || !Array.isArray(status.devices) || !Array.isArray(status.pending) || status.error) {
        return unavailable('DEVICE_STATUS_UNAVAILABLE', 'Link 当前无法提供设备状态，请稍后重试。');
      }
      const devices = status.devices.map(device => {
        if (typeof device?.id !== 'string' || typeof device.name !== 'string'
          || !Number.isFinite(device.lastSeenAt) || device.lastSeenAt < 0) throw new Error('Invalid device status');
        return { id: device.id, name: device.name,
          ...(['mobile', 'computer', 'tablet', 'unknown'].includes(device.deviceType) ? { type: device.deviceType } : {}),
          lastSeenAt: device.lastSeenAt };
      });
      return { available: true, enabled: status.enabled, devices, pendingCount: status.pending.length, observedAt, liveConnections: 'unknown' };
    } catch {
      return unavailable('DEVICE_STATUS_UNAVAILABLE', 'Link 设备状态查询暂不可用，无法确认已授权设备。');
    }
  };
}
