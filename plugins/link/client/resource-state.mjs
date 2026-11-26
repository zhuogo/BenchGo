import { readJsonResponse } from '../../base/client/http-response.mjs';
export const resourceKey = row => JSON.stringify([row.deviceId, row.kind, row.resourceId ?? row.id]);
/** A target advertises management separately for official and native sessions. */
export function sessionActionAccess(navigation, row, operation) {
  const device = navigation.remote?.find(device => device.id === row.deviceId);
  if (!device || device.hostId !== row.device?.hostId || device.authorizationId !== row.device?.authorizationId) return { available: false, reason: '设备授权已变化，请重新选择会话' };
  const page = navigation.pages?.[row.deviceId + '\0capabilities'];
  if (!page || page.loading) return { available: false, reason: '正在读取所属设备的会话操作能力…' };
  if (!page.available) return { available: false, reason: page.reason || '无法读取所属设备的会话操作能力，请重试' };
  const capability = page.items?.find(item => (item.resourceId ?? item.id) === (row.native ? 'nativeSessionActions' : 'sessionActions'));
  if (!capability) return { available: false, reason: '所属设备版本未提供会话管理，请升级目标设备' };
  if (!capability.available || !capability.operations?.includes(operation)) return { available: false, reason: capability.reason || '所属设备不支持此会话操作' };
  return { available: true, reason: '' };
}
export function normalizeScope(value) { return { mode: ['current','all','selected'].includes(value?.mode) ? value.mode : 'current', deviceIds: [...new Set((value?.deviceIds || []).filter(id => typeof id === 'string'))] }; }
export function scopeDevices(scope, devices, activeId) { return devices.filter(device => scope.mode === 'all' || (scope.mode === 'selected' ? scope.deviceIds.includes(device.id) : device.id === activeId)); }
export function resourceTime(row) { const value = Number(row.updatedAt) || Date.parse(row.updatedAt); return Number.isFinite(value) && value > 0 && value < Date.now() + 86400000 ? value : 0; }
export function sortResourceRecents(rows) {
  const now = Date.now() + 86400000;
  return rows.map((row, index) => { const value = Number(row.updatedAt) || Date.parse(row.updatedAt); return { row, index, key: resourceKey(row), time: Number.isFinite(value) && value > 0 && value < now ? value : 0 }; })
    .sort((a,b) => Number(!!b.row.pinned)-Number(!!a.row.pinned) || b.time-a.time || (a.row.deviceId === b.row.deviceId ? a.index-b.index : a.key.localeCompare(b.key))).map(({row})=>row);
}
/** Refresh the already loaded coverage without collapsing a paginated list. */
export async function readResourcePages(request, input, count, signal) {
  const items = [], seen = new Set();
  const coverage = Math.max(30, count || 0);
  let page, offset = 0;
  do {
    signal?.throwIfAborted();
    const result = await request('resources', { ...input, offset, limit: Math.min(100, coverage - offset) }, signal);
    signal?.throwIfAborted();
    page = result.devices?.[0];
    if (!page || !Array.isArray(page.items)) throw new Error('设备资源响应无效');
    if (!page.available) return page;
    for (const row of page.items) {
      const key = resourceKey(row);
      if (!seen.has(key)) { seen.add(key); items.push(row); }
    }
    offset += page.items.length;
  } while (page.hasMore && page.items.length && offset < coverage);
  return { ...page, offset: 0, items };
}
export function mergeResourcePage(previous, page, append = false) {
  if (!page.available) {
    const revoked = ['UNAUTHORIZED', 'IDENTITY_CHANGED', 'NOT_FOUND'].includes(page.code);
    const cached = !revoked && previous?.items;
    return { ...page, ...(revoked ? { items: [], hasMore: false } : cached ? { items: cached, observedAt: previous.observedAt, hasMore: previous.hasMore, freshness: previous.observedAt ? 'stale' : page.freshness } : {}), offset: 0, loading: false, refreshing: false };
  }
  const items = append ? [...(previous?.items || []), ...page.items] : page.items;
  const seen = new Set();
  return { ...page, offset: 0, items: items.filter(row => { const key = resourceKey(row); if (seen.has(key)) return false; seen.add(key); return true; }), loading: false, refreshing: false };
}
/** Read-only reconnects never retry a stable permission, identity or protocol rejection. */
export function canRetryResource(page) {
  if (!page || page.available !== false) return false;
  if (['UNAUTHORIZED', 'IDENTITY_CHANGED', 'NOT_FOUND', 'UNSUPPORTED'].includes(page.code)) return false;
  return !(page.status >= 400 && page.status < 500 && ![408, 425, 429].includes(page.status));
}
export const resourceRetryDelay = attempt => Math.min(30_000, 1000 * 2 ** Math.min(5, Math.max(0, attempt - 1)));
export function resourceQueryFailure(error) {
  const code = [401, 403].includes(error.status) ? 'UNAUTHORIZED' : error.status === 404 ? 'NOT_FOUND' : error.code || 'QUERY_FAILED';
  return { available: false, code, status: error.status, reason: error.message, items: [], freshness: 'unknown' };
}
export const resourceRequestId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
export async function deviceRequest(action, args = {}, signal) {
  const paired = globalThis.__DSH_LINK_GROUP_RESOURCES__ === true;
  const url = paired ? new URL('api/group-resources', document.baseURI) : new URL('/api/commander-devices', location.origin);
  const response = await fetch(url, { method:'POST', credentials:'same-origin', headers:{'content-type':'application/json'}, body:JSON.stringify({action,...args,parentOrigin:location.origin}), signal });
  const value = await readJsonResponse(response,url);
  if(value.error)throw Object.assign(Error(typeof value.error==='string'?value.error:value.error.message || '设备资源读取失败'),{code:value.error?.code||value.code,status:value.status});
  return value;
}
