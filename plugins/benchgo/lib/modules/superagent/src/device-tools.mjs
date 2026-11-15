import { createHash } from 'node:crypto';
import { currentHumanInstruction } from './desktop-delegation-service.mjs';
import { readRemoteExecutionCatalog } from './execution-catalog.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const linkService = ctx => {
  const service = ctx.get?.('benchgoLink');
  if (!service) throw Object.assign(new Error('Link 服务不可用'), { code: 'LINK_UNAVAILABLE' });
  return service;
};

/** Product directory and finite device management; no peer Task lifecycle. */
export function createDeviceTools({ ctx }) {
  return {
    devices: options => linkService(ctx).devices(options),
    resources: input => linkService(ctx).resources(input),
    executionCatalog: (deviceId, signal) => readRemoteExecutionCatalog(ctx, deviceId, signal),
    async action(input, exec, { ownerAgent, threadId = 'main' } = {}) {
      if (!ownerAgent || exec.agent !== ownerAgent) throw new Error('只有当前总助手可管理设备');
      const message = currentHumanInstruction(ctx, ownerAgent)?.message;
      const instruction = (message?.content || []).filter(row => row.type === 'text').map(row => row.text || '').join('\n');
      if (!message?.id || !instruction.trim()) throw new Error('设备操作缺少当前真实用户指令');
      const source = { sessionId: ownerAgent.id, messageId: message.id, threadId, instruction };
      const requestId = digest([source, input]);
      if (['settings-read', 'settings-prepare', 'operation', 'status'].includes(input.operation)) {
        if (!input.deviceId || input.deviceId === 'local') throw new Error('本机配置请使用 assistant_settings；远端配置需要明确目标设备');
        return linkService(ctx).callDevice({ deviceId: input.deviceId, input: { ...input, action: 'management', requestId,
          ...(['settings-read', 'settings-prepare'].includes(input.operation) ? { namespace: 'benchgo-link-relay' } : {}) }, signal: exec.signal });
      }
      return linkService(ctx).deviceAction({ ...input, requestId, source, signal: exec.signal });
    },
  };
}
