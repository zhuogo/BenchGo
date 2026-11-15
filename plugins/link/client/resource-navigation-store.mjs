import { deviceRequest } from './resource-state.mjs';

let opener;

/** One navigation entry shared by the sidebar and owner-task execution links. */
export function installResourceOpener(open) {
  opener = open;
  return () => { if (opener === open) opener = undefined; };
}

export async function openRemoteResource({ device, resource, onReturn }, { request = deviceRequest, isCurrent = () => true } = {}) {
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error('当前聊天已切换，请回到原聊天后重试。');
  };
  assertCurrent();
  const open = opener;
  if (!open) throw new Error('跨设备工作台入口不可用，请启用 Link 后重试');
  if (![device?.id, device?.hostId, device?.authorizationId].every(value => typeof value === 'string' && value))
    throw new Error('执行设备身份不完整，请返回原任务核验');
  const result = await request('devices', {}, AbortSignal.timeout(15_000));
  const current = result.devices?.find(row => row.id === device.id);
  if (!current || current.hostId !== device.hostId || current.authorizationId !== device.authorizationId)
    throw new Error('执行设备身份或授权已变化，请返回原任务核验');
  if (current.kind === 'local') throw new Error('执行设备已变化，不能打开本机同名会话');
  if (opener !== open) throw new Error('跨设备工作台已关闭，请重试');
  assertCurrent();
  await open(current, resource, onReturn);
}
