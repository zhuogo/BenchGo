import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { openDeviceRegistry, normalizeTarget } from './registry.mjs';
import { remoteJson } from './remote.mjs';
import { createDeviceResources, deviceConnectionFailure } from './resources.mjs';
import { readDeviceInfo, selectRoute } from './routes.mjs';
import { createDeviceProxy } from './proxy.mjs';
import { createServerManager } from '../server/manager.mjs';
import { verifyReturnRoute } from '../pairing/return.mjs';
const secret = () => randomBytes(32).toString('base64url');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function parsePairingUri(input) {
  let uri; try { uri = new URL(input); } catch { throw fail('请粘贴完整 Link 配对地址'); }
  let target, code, name;
  if (['benchgo:', 'dshlink:'].includes(uri.protocol) && uri.hostname === 'pair' && !uri.username && !uri.password && !uri.port && ['', '/'].includes(uri.pathname) && !uri.hash) {
    target = normalizeTarget({ url: uri.searchParams.get('url'), pin: uri.searchParams.get('pin') });
    const relayTarget = uri.searchParams.get('relayTarget');
    if (relayTarget) {
      if (target.pin || !/^sha256:[A-Za-z0-9+/]{43}=$/.test(relayTarget)) throw fail('中继目标无效');
      target.relayTarget = relayTarget;
    }
    code = uri.searchParams.get('code');
    name = uri.searchParams.get('name')?.trim().slice(0, 100);
  } else if (uri.protocol === 'https:' && !uri.username && !uri.password && uri.pathname === '/link/') {
    target = normalizeTarget({ url: uri.origin });
    if (uri.search) {
      const relayTarget = uri.searchParams.get('relayTarget');
      if (uri.searchParams.size !== 1 || !/^sha256:[A-Za-z0-9+/]{43}=$/.test(relayTarget ?? '')) throw fail('中继目标无效');
      target.relayTarget = relayTarget;
    }
    const fragment = new URLSearchParams(uri.hash.slice(1));
    if ([...fragment.keys()].some(key => key !== 'code') || fragment.getAll('code').length !== 1) throw fail('请粘贴完整 Link 配对地址');
    code = fragment.get('code');
  } else throw fail('请粘贴完整 Link 配对地址');
  if (!code || code.length > 256) throw fail('配对码无效');
  return { target, code, ...(name ? { name } : {}) };
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail('需要 application/json', 415);
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 128 * 1024) throw fail('请求过大', 413); chunks.push(chunk); }
  const input = JSON.parse(Buffer.concat(chunks).toString());
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('请求必须是对象'); return input;
}
export async function createDeviceCenter({ directory, webRoot, managerFactory = createServerManager, hostAdmin, localName, localDispatch, publicOrigin, workbenchOrigin, registerProxy, pairing, signSource, group, credentials }) {
  let renamedLocal;
  const registry = await openDeviceRegistry(directory, { localName: () => localName?.() || renamedLocal || '本机', group }), pending = new Map(), proxies = new Map(), tickets = new Map(), sessions = new Map(), parents = new Set(), sockets = new Set();
  let origin, closed = false;
  const selections = new Map();
  const workbenchRoute = async (target, options = {}) => {
    if (target.kind !== 'ssh' || target.authorize && target.url) {
      try { return await selectRoute(target, options); }
      catch (error) {
        if (!manager?.state?.(target.id) || !['OFFLINE', 'ROUTES_COOLDOWN'].includes(deviceConnectionFailure(error).code)) throw error;
      }
    }
    if (!manager?.workbenchTarget) return selectRoute(target, options);
    const route = await manager.workbenchTarget(target.id);
    options.signal?.throwIfAborted();
    if (target.authorize && (route.hostId !== target.hostId || route.authorizationId !== target.authorizationId)) {
      throw Object.assign(fail('设备连接已更新，请重试', 409), { code: 'IDENTITY_CHANGED' });
    }
    await options.accept?.(route, { kind: 'ssh' });
    return route;
  };
  const resources = createDeviceResources({ registry, route: workbenchRoute, signSource, local: localDispatch || (() => { throw fail('本机资源暂不可用'); }) });
  const markFailure = (id, target, error) => {
    if (closed) return;
    try {
      if (registry.get(id) !== target) return;
      const failure = deviceConnectionFailure(error);
      if (failure.status) registry.mark(id, failure.status, failure.status === 'online' ? null : failure.reason);
    } catch {}
  };
  const markSuccess = (id, target) => {
    if (closed) return;
    try {
      if (registry.get(id) === target) registry.mark(id, 'online');
    } catch {}
  };
  const manager = await managerFactory({ directory, registry, credentials, onRelay: async value => {
    if (typeof hostAdmin !== 'function') throw fail('此客户端不支持配置主机中继');
    const current = await hostAdmin({ action: 'status' });
    const nodes = Array.isArray(current.relay?.nodes) ? current.relay.nodes : [];
    const node = nodes.find(item => item.url === value.url);
    await hostAdmin({ action: 'relay-pool-configure', expected: { fingerprint: current.relay.fingerprint },
      operation: node ? 'update' : 'add', id: node?.id ?? randomUUID(), url: value.url, token: value.token, enabled: true });
  }, runtimeRoot: new URL('../server/', webRoot), onDevice: async device => {
    let saved;
    try { saved = registry.get(device.id); } catch {}
    if (device.status === 'offline') {
      if (saved?.kind === 'ssh' && (!saved.authorize || registry.publicDevice(saved).currentPath === 'ssh')) registry.mark(device.id, 'offline');
      return;
    }
    resources.invalidate(device.id);
    const proxy = proxies.get(device.id); if (proxy) { proxies.delete(device.id); await proxy.close(); }
  } });
  await manager?.ready;
  const serverManagement = !publicOrigin && typeof manager?.sshTarget === 'function';
  const decorate = device => ({ ...device, ...(serverManagement ? manager.state(device.id) : undefined) });
  const devices = () => {
    const data = resources.devices();
    const groupEnabled = group?.enabled();
    return { ...data, devices: data.devices.map(device => ({
      ...decorate(device),
      ...(groupEnabled && device.kind === 'local' ? { hostId: group.localId, groupMember: true } : {}),
      ...(groupEnabled && registry.isGroup(device.id) ? { groupMember: true } : {}),
    })), ...(groupEnabled ? { groupEnabled: true } : {}) };
  };
  const savePairing = async input => {
    const device = await registry.upsert({ ...input, kind: 'computer' });
    resources.invalidate(device.id);
    const proxy = proxies.get(device.id);
    if (proxy) { proxies.delete(device.id); await proxy.close(); }
    return device;
  };
  const acceptReturn = async (offer, credential, authorize, name) => {
    const target = await verifyReturnRoute(offer, credential);
    if (!target) return 'unreachable';
    authorize();
    if (closed) throw fail('设备中心已关闭', 503);
    await savePairing({ ...target, name, pairingNotice: null });
    return 'mutual';
  };
  const releaseProof = pair => { if (pair.offer) pairing.clearProof(pair.offer.proof.id); };
  const pairingNotice = direction => ({
    'local-unavailable': '已单向连接。本机没有可供目标访问的连接地址。',
    'remote-unavailable': '已单向连接。目标设备未支持双向配对。',
    'source-unavailable': '已单向连接。本机的授权设备数已达上限。',
    unreachable: '已单向连接。目标设备未能验证本机的连接路线。',
  })[direction];
  const finishPairing = async pair => {
    const query = { requestId: pair.remote.requestId, pollToken: pair.remote.pollToken };
    const { value } = await remoteJson(pair, '/link/api/pair/status', query);
    if (value.status !== 'approved') {
      if (value.status === 'rejected') releaseProof(pair);
      return { status: value.status };
    }
    if (pair.pin && value.hostId && value.hostId !== 'sha256:' + pair.pin || pair.relayTarget && value.hostId !== pair.relayTarget) throw fail('配对主机身份不一致');
    const name = value.hostName || value.name || pair.name;
    let direction = pair.offer ? 'remote-unavailable' : 'local-unavailable';
    if (!pair.remote.deviceGroup && pair.offer && pair.remote.reciprocal === true && value.reciprocal === true) {
      if (typeof value.hostId !== 'string' || value.hostId === pair.offer.hostId) throw fail('配对主机身份不一致');
      if (pair.credential === undefined) pair.credential = await pairing.issue(name, pair.expiresAt);
      const { value: result } = await remoteJson(pair, '/link/api/pair/status', { ...query, credential: pair.credential }, { timeout: 12_000 });
      direction = result.direction;
      if (!['mutual', 'unreachable', 'source-unavailable'].includes(direction)) throw fail('双向配对结果无效');
      if (pair.credential) {
        if (direction === 'mutual') await pairing.record(pair.credential.deviceId, direction);
        else await pairing.revoke(pair.credential.deviceId);
      }
    }
    let device = pair.remote.deviceGroup
      ? await group.enroll({ url: pair.url, pin: pair.pin, relayTarget: pair.relayTarget, token: value.token, hostId: value.hostId, authorizationId: value.deviceId })
      : await savePairing({ url: pair.url, pin: pair.pin, relayTarget: pair.relayTarget, token: value.token, routes: value.routes, hostId: value.hostId, authorizationId: value.deviceId, capabilities: value.capabilities, name, pairedEndpointFallback: !pair.pin, pairingNotice: pairingNotice(direction) ?? null });
    if (pair.remote.deviceGroup) device = devices().devices.find(row => row.hostId === device.hostId) ?? device;
    releaseProof(pair);
    return pair.result = { status: 'approved', device, direction: pair.remote.deviceGroup ? 'group' : direction };
  };
  const idOf = input => input.deviceId || input.targetId || input.id;
  const groupResourceApi = async (input, authorize) => {
    authorize();
    const directory = devices();
    const members = directory.devices.filter(device => device.kind === 'local' || registry.isGroup(device.id));
    const allowed = new Set(members.map(device => device.id));
    const requireDevice = id => {
      if (!allowed.has(id)) throw fail('此设备不在工作台所属设备组中', 403);
      return id;
    };
    const scopeView = scope => ({ ...scope, deviceIds: scope.deviceIds.filter(id => allowed.has(id)) });
    switch (input.action) {
      case 'devices':
        return { devices: members, activeId: 'local', groupEnabled: true };
      case 'resourceScope':
        return { scope: scopeView(registry.scope()) };
      case 'setResourceScope': {
        const scope = input.scope;
        if (!Array.isArray(scope?.deviceIds) || scope.deviceIds.length > 64) throw fail('资源显示范围无效');
        scope.deviceIds.forEach(requireDevice);
        const retained = registry.scope().deviceIds.filter(id => !allowed.has(id) && directory.devices.some(device => device.id === id));
        const saved = await registry.setScope({ mode: scope.mode, deviceIds: [...new Set([...scope.deviceIds, ...retained])] });
        authorize();
        return { scope: scopeView(saved) };
      }
      case 'resources': {
        if (!['projects', 'sessions', 'recent', 'capabilities'].includes(input.kind)) throw fail('不支持此资源类型', 403);
        const deviceId = requireDevice(input.deviceId);
        const value = await resources.resources({ deviceId, kind: input.kind, projectId: input.projectId, archived: input.archived, offset: input.offset, limit: input.limit, signal: input.signal });
        authorize();
        if (deviceId !== 'local' && !registry.isGroup(deviceId)) throw fail('目标设备已退出设备组', 403);
        return value;
      }
      case 'sessionAction':
        requireDevice(input.deviceId);
        return api(input);
      default:
        throw fail('此操作需要在目标设备本机完成', 403);
    }
  };
  const api = async input => {
    if (closed) throw fail('设备中心已关闭', 503);
    let id = idOf(input);
    if (input.action === 'resources') return resources.resources(input);
    if (input.action === 'callDevice') return resources.callDevice(input);
    if (input.action === 'sessionAction') {
      if (typeof input.deviceId !== 'string' || !input.deviceId) throw fail('请选择会话所属设备');
      return resources.callDevice({ deviceId: input.deviceId, expectedHostId: input.expectedHostId, expectedAuthorizationId: input.expectedAuthorizationId, input: { action: 'sessionAction', id: input.id, native: input.native, operation: input.operation, requestId: input.requestId, ...(input.title === undefined ? {} : { title: input.title }), ...(input.stopActivity === undefined ? {} : { stopActivity: input.stopActivity }) }, signal: input.signal });
    }
    if (input.action === 'devices') return devices();
    if (input.action === 'groupStatus') return group?.status() ?? { enabled: false, members: [] };
    if (input.action === 'groupRename' && group) {
      const hostId = id === 'local' ? group.localId : group.member(id)?.id ?? registry.get(id).hostId;
      const member = await group.rename(hostId, input.name);
      group.syncSoon?.();
      return { device: { id, name: member.name } };
    }
    if (input.action === 'groupRemove' && group) {
      await group.remove(group.member(id)?.id ?? registry.get(id).hostId);
      return group.status();
    }
    if (input.action === 'groupLeave' && group) { await group.remove(group.localId); return group.status(); }
    if (input.action === 'resourceScope') return { scope: registry.scope() };
    if (input.action === 'setResourceScope') return { scope: await registry.setScope(input.scope) };
    if (input.action === 'list') { const data = registry.list(); return { ...data, devices: data.devices.map(decorate), ...(group ? { group: group.status() } : {}), relayJob: manager?.activeRelayJob?.() ?? null, capabilities: { ssh: Boolean(manager), serverManagement, sshAgent: serverManagement && await manager.agentAvailable(), serverTerminalResize: serverManagement, relayDeploy: Boolean(manager?.deployRelay) && typeof hostAdmin === 'function', hostAdmin: typeof hostAdmin === 'function' } }; }
    const hostActions = { hostRelayTest: 'relay-test', hostRelayPoolConfigure: 'relay-pool-configure', hostStatus: 'status', hostConfigure: 'configure', hostPairing: 'pairing', hostConfirm: 'confirm', hostReject: 'reject', hostRevoke: 'revoke', hostRenameDevice: 'rename-device' };
    if (Object.hasOwn(hostActions, input.action)) {
      if (typeof hostAdmin !== 'function') throw fail('此客户端不支持本机连接管理，请更新应用');
      const fields = { hostRelayTest: ['id', 'url', 'token'], hostRelayPoolConfigure: ['expected', 'operation', 'id', 'url', 'token', 'enabled'], hostStatus: ['activePairingCode'], hostConfigure: ['enabled', 'host', 'port', 'publicUrl', 'name'], hostPairing: ['mode', 'address', 'relayId'], hostConfirm: ['id'], hostReject: ['id'], hostRevoke: ['id'], hostRenameDevice: ['id', 'name'] }[input.action];
      return hostAdmin({ action: hostActions[input.action], ...Object.fromEntries(fields.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]])) });
    }
    if (input.action === 'pair') {
      for (const [key, item] of pending) if (item.expiresAt < Date.now()) { releaseProof(item); pending.delete(key); }
      if (pending.size >= 16) throw fail('配对请求过多');
      const { target, code, name } = parsePairingUri(input.uri);
      const host = typeof hostAdmin === 'function' ? await hostAdmin({ action: 'status' }) : undefined;
      const groupInvitation = group?.enabled() || input.joinGroup === true ? group?.localId : undefined;
      const offer = groupInvitation ? undefined : pairing?.offer();
      let value;
      try {
        ({ value } = await remoteJson(target, '/link/api/pair', { code, name: localName?.() || host?.hostName || renamedLocal || `BenchGo-${randomBytes(3).toString('hex')}`, ...(offer ? { returnOffer: offer } : {}), ...(groupInvitation ? { groupInvitation } : {}) }));
      } catch (error) { releaseProof({ offer }); throw error; }
      if (groupInvitation && value.deviceGroup !== true) throw fail('请更新目标主机的 BenchGo 后加入设备组', 409);
      const requestId = randomUUID();
      pending.set(requestId, { ...target, name, offer, remote: value, expiresAt: Math.min(value.expiresAt || Date.now() + 300000, Date.now() + 300000) });
      return { requestId, expiresAt: value.expiresAt };
    }
    if (input.action === 'pairStatus') {
      const pair = pending.get(input.requestId);
      if (!pair || pair.expiresAt < Date.now()) {
        if (pair) releaseProof(pair);
        pending.delete(input.requestId);
        throw fail('配对已过期，请重新扫码');
      }
      if (pair.result) return pair.result;
      pair.poll ??= finishPairing(pair).finally(() => { pair.poll = undefined; });
      return pair.poll;
    }
    if (input.action === 'select') {
      if (input.resource && (!['projects','sessions'].includes(input.resource.kind) || typeof input.resource.resourceId !== 'string' || !input.resource.resourceId || input.resource.resourceId.length > 200)) throw fail('资源引用无效');
      if (id === 'local') return { device: await registry.select(id), url: null };
      if (publicOrigin && !workbenchOrigin) throw fail('请先配置独立 HTTPS 工作台域名，云端连接不能使用本机地址', 409);
      id = registry.get(id).id;
      const connect = async () => {
        if (closed) throw fail('设备中心已关闭', 503);
        let savedTarget = registry.get(id);
        let url, activeRoute, freshInfo;
        try {
          const accept = async (target, route) => {
              const info = route?.kind !== 'ssh' ? await readDeviceInfo(target) : undefined;
              const previous = proxies.get(id), routeKey = JSON.stringify([target.url, target.pin, target.relayTarget]);
              let proxy = previous?.routeKey === routeKey && previous.target === savedTarget ? previous : undefined;
              const published = !proxy && publicOrigin ? registerProxy() : null;
              try {
                if (!proxy) proxy = await createDeviceProxy(target, { webRoot, ...(published ? { publicOrigin: workbenchOrigin, publicPrefix: published.prefix } : {}), parentOrigin: [origin, publicOrigin, ...parents].filter(Boolean).join(' '), onSuccess: () => markSuccess(id, savedTarget), onFailure: error => markFailure(id, savedTarget, error) });
                url = await proxy.enter({ verifyPage: true });
                if (closed || registry.get(id) !== savedTarget) throw fail('设备连接已更新，请重试', 409);
                if (proxy !== previous) {
                  proxy.routeKey = routeKey;
                  proxy.target = savedTarget;
                  published?.attach(proxy); proxies.set(id, proxy);
                  await previous?.close();
                }
                activeRoute = route ?? { kind: 'direct' };
                freshInfo = info;
              } catch (error) {
                if (proxy !== previous) await proxy?.close();
                published?.remove();
                throw error;
              }
          };
          await workbenchRoute(savedTarget, {
            onHealth: (route, health, details) => registry.markRouteHealth(id, route.relayId || route.url, health, { ...details, lastError: details.lastError?.slice(0, 200) }),
            accept,
          });
          if (freshInfo?.hostId && freshInfo.authorizationId && (!savedTarget.hostId || !savedTarget.authorizationId)) {
            const { hostId, authorizationId } = freshInfo;
            await registry.updateIdentity(id, savedTarget, { hostId, authorizationId });
            resources.invalidate(id);
          }
          if (freshInfo?.routes) await registry.updateRoutes(id, savedTarget, freshInfo.routes);
          registry.markRoute(id, activeRoute); registry.mark(id, 'online');
          return { device: decorate(await registry.select(id)), url, ...(input.resource ? { resource: { deviceId: id, kind: input.resource.kind, resourceId: input.resource.resourceId } } : {}) };
        } catch (error) {
          markFailure(id, savedTarget, error);
          const failure = deviceConnectionFailure(error);
          if (['OFFLINE', 'UNAUTHORIZED', 'IDENTITY_CHANGED'].includes(failure.code)) {
            throw Object.assign(new Error(failure.reason), { code: failure.code, status: error.status || 503, cause: error });
          }
          throw error;
        }
      };
      const selection = (selections.get(id) ?? Promise.resolve()).catch(() => {}).then(connect);
      selections.set(id, selection);
      try { return await selection; } finally { if (selections.get(id) === selection) selections.delete(id); }
    }
    if (['rename', 'remove'].includes(input.action) && registry.isGroup(id ?? '')) throw fail('请在「我的设备」管理组成员', 409);
    if (input.action === 'rename') {
      if (id !== 'local') return { device: await registry.rename(id, input.name) };
      if (group?.enabled()) {
        await group.rename(group.localId, input.name);
        group.syncSoon?.();
        return { device: registry.list().devices[0] };
      }
      if (typeof hostAdmin !== 'function') throw fail('此客户端不支持本机名称管理，请更新应用');
      const host = await hostAdmin({ action: 'configure', name: input.name });
      renamedLocal = host.hostName;
      return { device: registry.list().devices[0] };
    }
    if (input.action === 'remove') {
      id = registry.get(id).id;
      await manager?.disconnect?.(id);
      await registry.remove(id);
      resources.invalidate(id);
      const proxy = proxies.get(id);
      proxies.delete(id);
      await proxy?.close();
      return { ok: true };
    }
    if (!manager) throw fail('此客户端不支持 SSH，请更新应用');
    if (input.action === 'relayProbe') return manager.relayProbe(input);
    if (input.action === 'relayDeploy') {
      if (typeof hostAdmin !== 'function') throw fail('此客户端不支持配置主机中继');
      return manager.deployRelay(input);
    }
    if (input.action === 'relayAction') return manager.manageRelay(input);
    if (input.action === 'relayJobDismiss') return manager.dismissRelayJob(input.jobId);
    if (input.action === 'sshProbe') return manager.probe(input);
    if (input.action === 'sshConnect') {
      if (input.deviceId) {
        if (!serverManagement) throw fail('请在本机设备中心补绑 SSH', 403);
        await resources.resolveDeviceIdentity({ deviceId: input.deviceId, signal: input.signal });
        return manager.connect({ ...input, device: registry.get(input.deviceId) });
      }
      return manager.connect({ ...input, device: undefined });
    }
    if (serverManagement) {
      if (input.action === 'serverTerminal') return manager.openTerminal(id);
      if (input.action === 'serverTerminalRead') return manager.readTerminal(input);
      if (input.action === 'serverTerminalWrite') return manager.writeTerminal(input);
      if (input.action === 'serverTerminalResize') return manager.resizeTerminal(input);
      if (input.action === 'serverTerminalClose') return manager.closeTerminal(input);
      if (input.action === 'serverPairing') return manager.pairing({ deviceId: id, operation: 'generate' });
      if (input.action === 'serverPairingConfigure') return manager.pairing({ deviceId: id, operation: 'configure', publicUrl: input.publicUrl });
      if (input.action === 'serverPairingStatus') return manager.pairing({ deviceId: id, operation: 'status' });
      if (input.action === 'serverPairingDecide') {
        if (!['confirm', 'reject'].includes(input.decision)) throw fail('无效配对操作');
        return manager.pairing({ deviceId: input.deviceId, operation: input.decision, requestId: input.id });
      }
    }
    if (input.action === 'serverPrefetch') return manager.prefetch(input);
    if (input.action === 'jobCancel') return manager.cancelJob(input.jobId || input.id);
    if (input.action === 'job') return manager.job(input.jobId || input.id);
    if (input.action === 'reconnect') return manager.reconnect({ id, password: input.password, privateKey: input.privateKey, passphrase: input.passphrase });
    if (input.action === 'serverAction') return manager.manage({ id, operation: input.operation });
    throw fail('不支持的操作');
  };
  const server = createServer(async (req, res) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    try {
      if (closed || req.headers.host !== new URL(origin).host) throw fail('本机设备地址无效', 403);
      const url = new URL(req.url, origin);
      if (url.pathname === '/enter' && req.method === 'GET') {
        const ticket = url.searchParams.get('ticket'), value = tickets.get(ticket); tickets.delete(ticket);
        if (!value || value.expires < Date.now()) throw fail('设备入口已过期，请从侧栏重新打开', 401);
        const token = secret(); sessions.set(token, value.parentOrigin); if (sessions.size > 16) sessions.delete(sessions.keys().next().value);
        if (value.parentOrigin) parents.add(value.parentOrigin);
        res.writeHead(303, { ...headers, location: (publicOrigin ? '/devices' : '') + '/s/' + token + '/' }); res.end(); return;
      }
      const match = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{43})(\/.*)$/);
      if (!match || !sessions.has(match[1])) throw fail('设备中心未授权', 401);
      url.pathname = match[2];
      if (url.pathname === '/device-config.js' && req.method === 'GET') {
        res.writeHead(200, { ...headers, 'content-type': 'text/javascript' }); res.end('globalThis.__DSH_DEVICE_CENTER__=true;globalThis.__DSH_DEVICE_PARENT_ORIGIN__=' + JSON.stringify(sessions.get(match[1])) + ';'); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/devices') {
        if (![origin, publicOrigin].filter(Boolean).includes(req.headers.origin)) throw fail('来源未授权', 403);
        const value = await api(await body(req)); res.writeHead(200, { ...headers, 'content-type': 'application/json' }); res.end(JSON.stringify(value)); return;
      }
      if (req.method !== 'GET') throw fail('不支持的方法', 405);
      const file = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/app.css': 'app.css' }[url.pathname];
      if (!file) throw fail('未找到', 404);
      let data = await readFile(new URL(file, webRoot));
      if (file === 'index.html') data = Buffer.from(data.toString().replace('<head>', '<head><script src="./device-config.js"></script>'));
      const policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src " + (publicOrigin ? (workbenchOrigin || "'none'") : 'http://127.0.0.1:*') + "; connect-src 'self'; frame-ancestors " + ([...parents, 'dsh-app:'].join(' ')) + "; base-uri 'none'; form-action 'self'";
      res.writeHead(200, { ...headers, 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8', 'content-security-policy': policy }); res.end(data);
    } catch (error) { if (!res.headersSent) res.writeHead(error.status || 400, { ...headers, 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message, ...(error.code ? { code: error.code } : {}) })); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  return {
    origin, api, groupResourceApi, ...resources, devices, acceptReturn,
    async invalidateGroup(hostIds) {
      const ids = new Set(hostIds.flatMap(hostId => [hostId, registry.findByHostId(hostId)?.id].filter(Boolean)));
      await Promise.allSettled([...ids].map(async id => {
        resources.invalidate(id);
        const proxy = proxies.get(id);
        proxies.delete(id);
        await proxy?.close();
      }));
    },
    sshTarget: input => manager.sshTarget(input),
    sshCommand: input => manager.sshCommand(input),
    select(deviceId, parentOrigin, resource) { if (parentOrigin) parents.add(parentOrigin); return api({ action: 'select', deviceId, resource }); },
    launch(parentOrigin) { for (const [key, value] of tickets) if (value.expires < Date.now()) tickets.delete(key); const ticket = secret(); tickets.set(ticket, { expires: Date.now() + 60000, parentOrigin }); return { url: (publicOrigin || origin) + (publicOrigin ? '/devices' : '') + '/enter?ticket=' + ticket }; },
    /** Saved names for the sidebar. No tokens, routes or management actions. */
    summary() { return { devices: registry.list().devices.map(({ id, name, kind, status }) => ({ id, name, kind, status })) }; },
    async close() { closed = true; resources.clear(); tickets.clear(); sessions.clear(); await Promise.all([...proxies.values()].map(proxy => proxy.close())); proxies.clear(); await manager?.close(); await registry.flush(); const done = new Promise(resolve => server.close(resolve)); sockets.forEach(socket => socket.destroy()); await done; },
  };
}
