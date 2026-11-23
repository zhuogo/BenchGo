import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
const label = value => { if (typeof value !== 'string' || !value.trim() || value.length > 100) throw new Error('设备名称应为 1–100 个字符'); return value.trim(); };
const routeKey = ({ kind, url, pin, relayId, relayTarget }) => JSON.stringify([kind, url, pin, relayId, relayTarget]);
export function normalizeTarget(value) {
  const url = new URL(value.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('设备地址必须是 HTTPS 主机地址');
  const pin = String(value.pin || '').replace(/^sha256\//, '');
  if (pin && (!/^[A-Za-z0-9+/]{43}=$/.test(pin) || Buffer.from(pin, 'base64').length !== 32)) throw new Error('主机公钥指纹无效');
  return { url: url.origin, pin };
}
export function normalizeRoutes(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 16) throw new Error('设备连接路线无效');
  return value.map(route => {
    if (!route || typeof route !== 'object' || Array.isArray(route)) throw new Error('设备连接路线无效');
    const allowed = route.kind === 'direct' ? ['kind', 'url', 'pin'] : route.kind === 'relay' ? ['kind', 'url', 'relayId', 'id', 'priority', 'health', 'cooldownUntil', 'lastError', 'relayTarget'] : [];
    if (!allowed.length || Object.keys(route).some(key => !allowed.includes(key))) throw new Error('设备连接路线无效');
    const target = normalizeTarget({ url: route.url, pin: route.pin });
    if (route.kind === 'direct' && !target.pin) throw new Error('直连路线必须固定主机指纹');
    if (route.kind === 'relay' && route.pin) throw new Error('中继路线必须使用系统 CA 验证');
    if (route.kind === 'direct') return { kind: 'direct', ...target };
    const relayId = route.relayId ?? route.id;
    if (relayId !== undefined && (typeof relayId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(relayId))) throw new Error('中继 ID 无效');
    if (route.relayId !== undefined && route.id !== undefined && route.relayId !== route.id) throw new Error('中继 ID 不一致');
    if (route.relayTarget !== undefined && (typeof route.relayTarget !== 'string' || !/^sha256:[A-Za-z0-9+/]{43}=$/.test(route.relayTarget))) throw new Error('中继目标无效');
    if (route.priority !== undefined && (!Number.isInteger(route.priority) || route.priority < 0 || route.priority > 1_000_000)) throw new Error('中继优先级无效');
    if (route.health !== undefined && !['unknown', 'healthy', 'degraded', 'unhealthy'].includes(route.health)) throw new Error('中继健康状态无效');
    if (route.cooldownUntil !== undefined && (!Number.isInteger(route.cooldownUntil) || route.cooldownUntil < 0)) throw new Error('中继冷却时间无效');
    if (route.lastError !== undefined && (typeof route.lastError !== 'string' || route.lastError.length > 200)) throw new Error('中继错误信息无效');
    return {
      kind: 'relay', url: target.url,
      ...(relayId === undefined ? {} : { relayId }),
      ...(route.relayTarget === undefined ? {} : { relayTarget: route.relayTarget }),
      ...(route.priority === undefined ? {} : { priority: route.priority }),
      ...(route.health === undefined ? {} : { health: route.health }),
      ...(route.cooldownUntil === undefined ? {} : { cooldownUntil: route.cooldownUntil }),
      ...(route.lastError === undefined ? {} : { lastError: route.lastError }),
    };
  });
}
export async function openDeviceRegistry(directory, { localName = () => '本机', group } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'connections.json');
  let state = { version: 1, activeId: 'local', devices: [] };
  try { state = JSON.parse(await readFile(file, 'utf8')); await chmod(file, 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (state.version !== 1 || !Array.isArray(state.devices)) throw new Error('设备配置格式不受支持');
  // Runtime liveness must be checked again after restarting the local carrier.
  state.devices.forEach(value => { value.status = 'unknown'; value.lastError = null; if (value.kind === 'ssh') value.url = ''; });
  const activeRoutes = new Map();
  let writes = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify({ ...state, devices: state.devices.map(({ currentPath, ...device }) => device) }, null, 2), temporary = file + '.' + randomUUID() + '.tmp';
    const task = writes.then(async () => { try { await writeFile(temporary, snapshot, { mode: 0o600 }); await rename(temporary, file); } finally { await rm(temporary, { force: true }); } });
    writes = task.catch(() => {}); return task;
  };
  const oldServers = join(directory, 'servers.json');
  const legacy = await readFile(oldServers, 'utf8').then(JSON.parse, error => { if (error.code !== 'ENOENT') throw error; });
  if (legacy !== undefined) {
    if (!Array.isArray(legacy)) throw new Error('服务器登记格式不受支持');
    for (const row of legacy) {
      if (row.kind !== 'ssh' || !row.id || !row.ssh?.host) continue;
      const existing = state.devices.find(device => device.id === row.id);
      if (existing) {
        if (existing.hostId && row.hostId && existing.hostId !== row.hostId) throw new Error('旧服务器登记与设备实例不一致');
        existing.ssh = row.ssh;
      } else state.devices.push({ ...row, url: '', status: 'unknown' });
    }
  }
  const retiredAiGrants = state.devices.filter(device => Object.hasOwn(device, 'aiRevision'));
  for (const device of retiredAiGrants) delete device.aiRevision;
  if (legacy !== undefined || retiredAiGrants.length) await persist();
  if (legacy !== undefined) await rm(oldServers);
  const groupTargets = new Map();
  const targets = () => {
    const current = new Set();
    const stored = new Map();
    for (const row of state.devices) {
      if (!row.hostId) continue;
      const previous = stored.get(row.hostId);
      if (!previous || !previous.ssh && row.ssh) stored.set(row.hostId, row);
    }
    const groupEnabled = group?.enabled();
    const members = group?.members() ?? [];
    if (groupEnabled) for (const member of members) {
      if (member.removed || member.id === group.localId || member.deviceType === 'mobile') continue;
      const routes = group.routes?.(member) ?? member.routes;
      const route = routes[0];
      const registration = stored.get(member.id);
      const ssh = registration?.ssh;
      if (!route && !member.publicUrl && !ssh) continue;
      current.add(member.id);
      const key = JSON.stringify([member.generation, routes, member.publicUrl]);
      const previous = groupTargets.get(member.id);
      if (previous?.key === key && previous.registration === registration) {
        previous.target.name = member.name;
        continue;
      }
      const target = {
        id: registration?.id ?? member.id, kind: ssh ? 'ssh' : 'computer', name: member.name, hostId: member.id,
        authorizationId: group.localId, url: member.publicUrl || route?.url, pin: member.publicUrl ? undefined : route?.pin,
        routes, pairedEndpointFallback: Boolean(member.publicUrl), status: previous?.target.status ?? 'unknown',
        lastError: previous?.target.lastError, ...(ssh ? { ssh, warning: registration.warning } : {}),
        authorize: () => group.token(member.id),
      };
      groupTargets.set(member.id, { key, registration, target });
    }
    for (const [id, entry] of groupTargets) if (!current.has(id)) { groupTargets.delete(id); activeRoutes.delete(entry.target.id); }
    const groupMembers = new Map(members.map(member => [member.id, member]));
    return [...Array.from(groupTargets.values(), entry => entry.target), ...state.devices.filter(row => {
      if (!row.hostId) return true;
      if (row.hostId === group?.localId || stored.get(row.hostId) !== row) return false;
      const member = groupMembers.get(row.hostId);
      return !member || groupEnabled && !member.removed && !groupTargets.has(row.hostId);
    })];
  };
  const find = (devices, id) => {
    if (typeof id !== 'string' || !id || id === 'local') return;
    const exact = devices.find(row => row.id === id);
    if (exact) return exact;
    const hostId = state.devices.find(row => row.id === id)?.hostId ?? id;
    return devices.find(row => row.hostId === hostId);
  };
  const get = id => { const result = find(targets(), id); if (!result) throw new Error('设备不存在'); return result; };
  const publicDevice = value => {
    const route = activeRoutes.get(value.id);
    return { id: value.id, name: value.name, kind: value.kind, url: value.kind === 'ssh' ? value.ssh?.host : value.url,
      hostId: value.hostId ?? null, authorizationId: value.authorizationId ?? null,
      status: value.status || 'unknown', lastError: value.lastError || null, currentPath: route?.kind ?? null,
      ...(route?.kind === 'relay' ? { currentRelayId: route.relayId ?? null, currentRelayUrl: route.url } : {}), ...(value.warning ? { warning: value.warning } : {}), ...(value.pairingNotice ? { pairingNotice: value.pairingNotice } : {}) };
  };
  const localDevice = () => {
    const name = group?.enabled() ? group.member(group.localId)?.name : undefined;
    return { id: 'local', name: name ?? localName(), kind: 'local', status: 'online' };
  };
  return {
    get, publicDevice, isGroup: id => Boolean(find(targets(), id)?.authorize),
    findByHostId(hostId) {
      if (!hostId) return;
      const rows = state.devices.filter(value => value.hostId === hostId);
      return rows.find(row => row.ssh) ?? rows[0];
    },
    sshRecords() { return state.devices.filter(value => value.ssh?.host).map(value => ({ ...value, kind: 'ssh' })); },
    scope() {
      if (!state.resourceScope) return { mode: 'current', deviceIds: [] };
      const devices = targets();
      return { ...state.resourceScope, deviceIds: [...new Set(state.resourceScope.deviceIds.map(id => find(devices, id)?.id ?? id))] };
    },
    async setScope(value) {
      const devices = targets();
      if (!value || !['current','all','selected'].includes(value.mode) || !Array.isArray(value.deviceIds) || value.deviceIds.length > 64 || value.deviceIds.some(id => id !== 'local' && !find(devices, id))) throw new Error('资源显示范围无效');
      const previous = state.resourceScope; state.resourceScope = { mode: value.mode, deviceIds: [...new Set(value.deviceIds.map(id => find(devices, id)?.id ?? id))] };
      try { await persist(); } catch (error) { state.resourceScope = previous; throw error; } return state.resourceScope;
    },
    list() { const devices = targets(); return { activeId: find(devices, state.activeId)?.id ?? 'local', devices: [localDevice(), ...devices.map(publicDevice)] }; },
    async upsert(input) {
      const target = input.kind === 'ssh' ? { url: '', pin: input.pin } : normalizeTarget(input);
      const routes = normalizeRoutes(input.routes);
      const existing = input.id ? state.devices.find(value => value.id === input.id)
        : state.devices.find(value => input.hostId && value.hostId === input.hostId)
          ?? state.devices.find(value => value.kind !== 'ssh' && value.url === target.url && value.pin === target.pin
            && value.relayTarget === input.relayTarget && (!value.hostId || !input.hostId));
      if (state.devices.length >= 32 && !existing) throw new Error('最多保存 32 台设备');
      if (typeof input.token !== 'string' || !input.token || input.token.length > 4096) throw new Error('设备授权无效');
      const value = { ...existing, ...input, ...target, ...(routes === undefined ? {} : { routes }), id: existing?.id || input.id || randomUUID(), name: label(existing?.alias || input.name || existing?.name || `BenchGo-${randomUUID().slice(0, 6)}`), kind: input.kind === 'ssh' ? 'ssh' : 'computer', status: 'online', lastError: null };
      if (!input.hostId && existing?.hostId) value.hostId = existing.hostId;
      if (existing?.kind === 'computer' && input.kind === 'ssh') Object.assign(value, { kind: existing.kind, url: existing.url, pin: existing.pin, token: existing.token, authorizationId: existing.authorizationId });
      const previous = state.devices;
      activeRoutes.delete(value.id);
      state.devices = [...state.devices.filter(row => row.id !== value.id), value];
      try { await persist(); } catch (error) { state.devices = previous; throw error; }
      return publicDevice(value);
    },
    async select(id) { const value = id === 'local' ? null : get(id); state.activeId = value?.id ?? 'local'; await persist(); return value ? publicDevice(value) : localDevice(); },
    async rename(id, name) { const value = get(id); value.alias = value.name = label(name); await persist(); return publicDevice(value); },
    async remove(id) { const value = get(id); activeRoutes.delete(value.id); state.devices = state.devices.filter(row => row.id !== value.id); if (state.activeId === id || state.activeId === value.id) state.activeId = 'local'; await persist(); },
    mark(id, status, lastError = null) { const value = get(id); value.status = status; value.lastError = lastError; },
    async updateIdentity(id, expected, resolved) {
      const stored = get(id);
      if (stored !== expected || stored.hostId && stored.hostId !== resolved.hostId || stored.authorizationId && stored.authorizationId !== resolved.authorizationId) {
        throw Object.assign(new Error('设备身份或连接已更新，请重试'), { code: 'IDENTITY_CHANGED', status: 409 });
      }
      const { hostId, authorizationId } = stored;
      if (hostId && authorizationId) return;
      Object.assign(stored, resolved);
      try { await persist(); } catch (error) { Object.assign(stored, { hostId, authorizationId }); throw error; }
      if (get(id) !== expected) throw Object.assign(new Error('设备连接已更新，请重试'), { code: 'IDENTITY_CHANGED', status: 409 });
    },
    markRoute(id, route) {
      const value = get(id);
      if (!['direct', 'relay', 'ssh'].includes(route.kind)) throw new Error('设备连接路线无效');
      activeRoutes.set(value.id, route);
    },
    async updateRoutes(id, expected, routes) {
      if (get(id) !== expected) throw Object.assign(new Error('设备身份或连接已更新，请重试'), { code: 'IDENTITY_CHANGED', status: 409 });
      if (expected.authorize) return;
      const previous = expected.routes;
      const old = new Map(previous?.map(route => [routeKey(route), route]));
      const next = routes.map(({ kind, url, pin, relayId, relayTarget, priority }) => {
        if (kind === 'direct') return { kind, url, pin };
        const saved = old.get(routeKey({ kind, url, relayId, relayTarget }));
        return { kind, url, ...(relayId === undefined ? {} : { relayId }), ...(relayTarget === undefined ? {} : { relayTarget }), ...(priority === undefined ? {} : { priority }),
          ...(saved?.health === undefined ? {} : { health: saved.health }), ...(saved?.cooldownUntil === undefined ? {} : { cooldownUntil: saved.cooldownUntil }),
          ...(saved?.lastError === undefined ? {} : { lastError: saved.lastError }) };
      });
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      expected.routes = next;
      try { await persist(); } catch (error) { if (expected.routes === next) expected.routes = previous; throw error; }
    },
    async markRouteHealth(id, relayId, health, { cooldownUntil = 0, lastError = null } = {}) {
      if (!['unknown', 'healthy', 'degraded', 'unhealthy'].includes(health)) throw new Error('中继健康状态无效');
      const value = get(id), route = value.routes?.find(item => item.kind === 'relay' && (item.relayId || item.id || item.url) === relayId);
      if (value.authorize) return publicDevice(value);
      if (!route) throw new Error('中继路线不存在');
      if (!Number.isInteger(cooldownUntil) || cooldownUntil < 0) throw new Error('中继冷却时间无效');
      route.health = health; route.cooldownUntil = cooldownUntil;
      if (lastError == null) delete route.lastError;
      else if (typeof lastError !== 'string' || lastError.length > 200) throw new Error('中继错误信息无效');
      else route.lastError = lastError;
      await persist(); return publicDevice(value);
    },
    flush: () => writes,
  };
}
