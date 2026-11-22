import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { openStore, text, PAIRED_DEVICE_CAPABILITIES } from './pairing/store.mjs';
import { PAIR_RETURN_VERSION, validReturnTarget } from './pairing/return.mjs';
import { loadIdentity, signExecutionSource, verifyExecutionSource } from './transport/tls.mjs';
import { listen, connectionAddresses, authority, validateConfig } from './transport/server.mjs';
import { createSessionAdapter } from './session/adapter.mjs';
import { createNativeAdapter } from './session/native.mjs';
import { createSessionActions } from './session/actions.mjs';
import { projectResources, resourcePage } from './devices/resources.mjs';
import { createDeviceCenter } from './devices/center.mjs';
import { openDeviceGroup } from './devices/group.mjs';
import { remoteJson } from './devices/remote.mjs';
import { selectRoute } from './devices/routes.mjs';
import { createWorkbench } from './transport/workbench.mjs';
import { createCloudAccess } from './cloud-access.mjs';
import { createCloudDeviceGateway } from './devices/cloud-gateway.mjs';
import { createRelayHost } from './transport/relay-host.mjs';
import { testRelayConnection } from './transport/relay-probe.mjs';
import { defaultLinkTransport, LINK_TRANSPORT_SCHEMA, editLinkRelayPool, normalizeLinkRelayPool } from './config.mjs';
import { createLinkSettingsAdapter, LINK_TRANSPORT_NAMESPACE, LINK_RELAY_NAMESPACE } from './settings-adapter.mjs';
import { settingsSnapshot, settingsFingerprint, assertSettingsExpected, applySettingsOps, notifySettings } from '../../base/shared/settings-adapter-utils.mjs';
import { captureHostScope, hostScope } from '../../base/shared/host-scope.mjs';
import { useIntegrationToken } from '../../base/shared/integration-token.mjs';

const executionOperations = ['catalog','submit','get','input','control','ack','archive','archives'];

/** Owner admin uses Harness Connection; remote devices get a distinct TLS carrier. */
export function mountLink(ctx, config = {}) {
  return hostScope(ctx)(() => mountLinkHost(ctx, config));
}

async function mountLinkHost(ctx, config) {
  const env = config.env ?? process.env;
  const directory = config.directory ?? join(ctx.get('benchgo').directory, 'link');
  let group;
  const store = await openStore(directory, { groupPrincipal: id => group?.principal(id) });
  const managementOperations = store.state.managementOperations ??= [];
  for (const operation of managementOperations) {
    if (['applying', 'approved'].includes(operation.state)) operation.state = 'unknown';
    if (operation.state === 'pending') operation.state = 'expired';
  }
  const managementFlights = new Map();
  const managementView = ({ id, requestId, deviceId, namespace, expected, ops, createdAt, state, result, error }) => ({
    id, operationId: id, requestId, deviceId, namespace, expected, ops, createdAt, state,
    ...(result ? { result } : {}), ...(error ? { error } : {}),
  });
  const legacyRelay = store.state.relay;
  if (!Array.isArray(store.state.relayPool) && legacyRelay?.url) {
    store.state.relayPool = [{ id: 'primary', url: legacyRelay.url, token: legacyRelay.token || env.DSH_LINK_RELAY_TOKEN, priority: 0, enabled: legacyRelay.enabled !== false }];
  }
  delete store.state.relay;
  let relayPool = Array.isArray(store.state.relayPool)
    ? store.state.relayPool
    : (env.DSH_LINK_RELAY_URL ? [{ id: 'primary', url: env.DSH_LINK_RELAY_URL, token: env.DSH_LINK_RELAY_TOKEN, priority: 0, enabled: true }] : []);
  const relayRevision = value => value && [value.revision, value.writer];
  const sameRelayRevision = (a, b) => a?.[0] === b?.[0] && a?.[1] === b?.[1];
  const enabledNodes = nodes => nodes.filter(node => node.enabled !== false && node.url && node.token);
  const relayState = () => store.state.groupRelay?.groupId === group.snapshot()?.id ? store.state.groupRelay : undefined;
  const relayNodes = new Map();
  const stopRelay = async () => {
    const active = [...relayNodes.values()];
    relayNodes.clear();
    await Promise.allSettled(active.map(node => node.instance?.close()));
  };
  const enabledRelay = () => relayPool.some(node => node.enabled !== false);
  const rankedRelays = () => [...relayPool].sort((a, b) => a.priority - b.priority);
  const connectedRelay = id => rankedRelays().find(node => node.enabled !== false && (!id || node.id === id)
    && relayNodes.get(node.url)?.instance?.status().connected);
  const probeRelay = node => (config.testRelayConnection ?? testRelayConnection)(node, config.relayTestOptions);
  validateConfig({}, store.state);
  const sessions = createSessionAdapter(ctx, { deletedIds: async () => {
    try { return JSON.parse(await readFile(join(config.directory ? join(directory, '..') : ctx.get('benchgo').directory, 'dismissed-harness.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  } });
  const native = createNativeAdapter(ctx);
  const authorizePairedDevice = device => {
    if (closed || !device || device.id !== 'local' && store.principal(device.id)?.tokenHash !== device.tokenHash) throw Object.assign(new Error('设备授权已失效，请重新配对'), { status: 403, code: 'UNAUTHORIZED' });
  };
  const sessionActions = createSessionActions({ store, official: sessions, native, authorize: authorizePairedDevice });
  const cloudAccess = await createCloudAccess(directory, { env: config.env ?? process.env, probe: config.cloudProbe });
  const dispatch = async (input, device) => {
    if (!device?.groupInvitation && !device?.groupSyncOnly) authorizePairedDevice(device);
    if (input?.action === 'deviceGroup') {
      if (['describe', 'join', 'admit'].includes(input.operation)) {
        if (!store.groupInvitation(device.id, input.inviter)) throw Object.assign(new Error('请先批准此设备组邀请'), { status: 403 });
        if (input.operation === 'describe') {
          if (group.enabled() && input.groupId && group.snapshot().id !== input.groupId) {
            throw Object.assign(new Error('目标设备已关联其他设备组'), { status: 409 });
          }
          return { member: group.description(), ...(group.enabled() ? { groupId: group.snapshot().id } : {}) };
        }
        if (input.operation === 'admit') {
          if (!group.enabled() || group.snapshot().id !== input.groupId)
            throw Object.assign(new Error('设备组邀请已变更'), { status: 409 });
          const row = group.verifyOffer(input.groupId, input.inviter, input.offer);
          const manifest = await group.include(row, true, input.groupId);
          return { manifest, removals: group.removals(), relay: relayEnvelope(row.id) };
        }
        if (input.groupId && input.groupId !== input.manifest?.id) throw Object.assign(new Error('设备组邀请已变更'), { status: 409 });
        await clearDepartedSettings();
        await group.adopt(input.manifest, input.inviter, input.removals);
        return { joined: true, relay: await exchangeRelay(input.inviter, input.relay) };
      }
      if (input.operation === 'integrationToken' && device.groupSyncOnly) {
        const authority = group.authorityMember();
        if (!group.member(device.id) || authority?.id !== group.localId) throw Object.assign(new Error('设备组 Token 管理设备已变更'), { status: 403 });
        const { operation, token, revision } = group.unseal(device.id, input.credential, 'integration-request');
        const result = await useIntegrationToken(ctx.credentials, integrationScope(authority), operation, { token, revision });
        return { credential: group.seal(device.id, result, 'integration-response') };
      }
      if (input.operation === 'sync' && device.groupSyncOnly) {
        if (input.manifest && (group.member(device.id) || !group.enabled())) await group.adopt(input.manifest, undefined, input.removals);
        const membership = { manifest: group.snapshot(), removals: group.removals() };
        if (!group.enabled() || !group.member(device.id)) return membership;
        const providerService = ctx.get?.('benchgoGroupProviders');
        const relay = await exchangeRelay(device.id, input.relay);
        const providers = providerService && input.providers && group.member(device.id)
          ? group.seal(device.id, await providerService.exchange({ groupId: group.snapshot().id, hostId: group.localId, entries: group.unseal(device.id, input.providers) }))
          : undefined;
        const media = input.media ? await exchangeMedia(membership.manifest.id, device.id, input.media).catch(() => undefined) : undefined;
        return { ...membership, providers, relay, media };
      }
      throw Object.assign(new Error('不支持的设备组操作'), { status: 422 });
    }
    const archive = input?.action === 'sessionAction' && ['archive', 'unarchive'].includes(input.operation);
    const sessionId = input?.id && (input.native === true && input.id.startsWith?.('native:') ? input.id.slice(7) : input.id);
    const owner = sessionId && ctx.get?.('benchgoExecution')?.ownerOfSession?.(sessionId);
    if (owner && !archive && ['send', 'cancel', 'respond', 'sessionAction'].includes(input.action)) throw Object.assign(new Error('远端执行会话只读，请在业务宿主的原工单提交输入或控制'), { status: 403, code: 'EXECUTION_INPUT_REQUIRES_OWNER' });
    if (input?.action === 'sessionAction') return sessionActions.dispatch(input, device);
    if (input?.action === 'execution') {
      if (input.version !== 2 || !executionOperations.includes(input.operation)) throw Object.assign(new Error('不支持的执行协议版本或操作'), { status: 422, code: 'UNSUPPORTED_EXECUTION_PROTOCOL' });
      const execution = ctx.get?.('benchgoExecution');
      if (typeof execution?.dispatch !== 'function') throw Object.assign(new Error('目标执行服务尚不可用'), { status: 422, code: 'UNSUPPORTED' });
      const { principal, sourceProof, ...safe } = input;
      const hostId = 'sha256:' + identity.pin;
      const verifiedSourceHostId = safe.operation === 'submit' && sourceProof !== undefined
        ? verifyExecutionSource(sourceProof, hostId, device.id, safe) : undefined;
      const value = await execution.dispatch(safe, { hostId, verifiedSourceHostId, principal: { kind: 'device', deviceId: device.id, capabilities: [...PAIRED_DEVICE_CAPABILITIES] } });
      return { ...value, hostId, authorizationId: device.id, ...(safe.operation === 'catalog' ? { executionSourceProof: 1 } : {}) };
    }
    if (input?.action === 'management') {
      if (input.operation === 'status') { const value = status(); return { enabled: value.enabled, hostName: value.hostName, error: value.error, relay: value.relay }; }
      if (input.operation === 'relay-test') return admin({ action: 'relay-test', id: input.id });
      if (input.operation === 'settings-read' && [LINK_TRANSPORT_NAMESPACE, LINK_RELAY_NAMESPACE].includes(input.namespace)) return configurationSnapshot(input.namespace);
      if (input.operation === 'operation') {
        const operation = managementOperations.find(row => row.deviceId === device.id && (input.operationId ? row.id === input.operationId : row.requestId === input.requestId));
        if (!operation) throw Object.assign(new Error('管理操作不存在'), { status: 404, code: 'NOT_FOUND' });
        return managementView(operation);
      }
      if (input.operation === 'settings-apply') return applyRemoteSettings(input, device);
      throw Object.assign(new Error('不支持的管理操作'), { status: 422, code: 'UNSUPPORTED' });
    }
    if (input?.action === 'resources') {
      const page = resourcePage(input);
      const hasReturnPairing = device.pairingReturn === 'mutual';
      const capabilities = [
        { id: 'resources', available: true, operations: ['projects','sessions','recent','models','capabilities'] },
        ...sessionActions.capabilities(device),
        { id: 'execution', version: 2, available: typeof ctx.get?.('benchgoExecution')?.dispatch === 'function', reason: typeof ctx.get?.('benchgoExecution')?.dispatch === 'function' ? null : '目标执行服务尚不可用', operations: executionOperations },
        { id: 'management', available: true, reason: null, operations: ['status','relay-test','settings-read','settings-apply','operation'] },
        { id: 'reverse', available: hasReturnPairing, reason: hasReturnPairing ? null : '此连接尚未建立回程配对', operations: [] },
      ];
      let state, recent;
      if (page.kind === 'projects' || page.kind === 'recent') {
        try { recent = JSON.parse(await readFile(join(config.directory ? join(directory, '..') : ctx.get('benchgo').directory, 'recent-workspace.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (page.kind === 'capabilities') state = { capabilities };
      else if (page.kind === 'projects') state = { projects: ctx.workspaceRegistry.list().map(project => ({ id: project.id, name: project.title || project.id, path: project.path, sessionIds: project.sessionIds, isDefault: recent?.id ? project.id === recent.id : project.isDefault === true })) };
      else if (page.kind === 'models') state = await sessions.dispatch({ action: 'models' }, device);
      else {
        if (page.kind === 'tasks') throw Object.assign(new Error('业务工单仅由发起宿主持有；目标设备只提供执行实例与官方会话'), { status: 422, code: 'UNSUPPORTED' });
        const availableProjects = ctx.workspaceRegistry.list();
        state = { sessions: [...await sessions.list(device, availableProjects), ...native.list(availableProjects, { includeArchived: true })] };
        if (page.kind === 'recent') {
          state.sessions = state.sessions.filter(row => row.ungrouped || (recent && row.projectId === recent.id));
        }
      }
      return { ...projectResources(state, { ...input, ...page }, 'local'), hostId: identity ? 'sha256:' + identity.pin : null, protocolVersion: 1 };
    }
    if (input?.id?.startsWith('native:')) return native.dispatch(input);
    const result = await sessions.dispatch(input, device);
    if (input.action === 'state') result.sessions.push(...native.list());
    return result;
  };
  let listener, identity, workbench, error = '', closed = false, closing, changes = Promise.resolve();
  identity = await loadIdentity(directory);
  const settingsListeners = new Set(), transportDefaults = defaultLinkTransport();
  const transportValue = () => Object.fromEntries(Object.keys(LINK_TRANSPORT_SCHEMA.properties).map(key => [key, store.state[key]]));
  const configurationSnapshot = namespace => {
    if (closed) throw new Error('Link 已关闭');
    if (namespace === LINK_TRANSPORT_NAMESPACE) return settingsSnapshot(transportValue(), undefined, { base: transportDefaults });
    if (namespace === LINK_RELAY_NAMESPACE) {
      const nodes = relayPool.map(({ token, ...node }, index) => ({ ...node, id: node.id || `relay-${index + 1}`, priority: Number.isInteger(node.priority) ? node.priority : index, enabled: node.enabled !== false }));
      return settingsSnapshot({ nodes }, undefined, {
        fingerprint: settingsFingerprint(relayPool),
        secrets: relayPool.map((node, index) => ({ path: ['nodes', String(index), 'token'], set: !!node.token })),
      });
    }
    throw new Error('未知 Link 设置');
  };
  const notifyConfiguration = () => notifySettings(settingsListeners, { namespace: null });
  const webRoot = config.webRoot ?? new URL('../dist/web/', import.meta.url);
  const connectRelays = async () => {
    if (!listener) return;
    const targetHost = ['::', '::1'].includes(store.state.host) ? '[::1]' : store.state.host === '0.0.0.0' ? '127.0.0.1' : store.state.host;
    const desired = new Map(enabledNodes(relayPool).map(node => [node.url, node]));
    for (const node of store.state.groupRelay?.previous ?? []) if (!desired.has(node.url)) desired.set(node.url, node);
    const retired = [];
    for (const [url, runtime] of relayNodes) {
      const next = desired.get(url);
      if (next && next.url === runtime.url && next.token === runtime.token) {
        desired.delete(url);
      } else {
        relayNodes.delete(url);
        retired.push(runtime.instance?.close());
      }
    }
    await Promise.allSettled(retired);
    for (const [url, node] of desired) {
      const runtime = { url: node.url, token: node.token };
      try {
        runtime.instance = await (config.createRelayHost ?? createRelayHost)({
          relayUrl: node.url, token: node.token, relayHeaders: listener.relayHeaders, hostKey: identity.key,
          target: { url: `https://${targetHost}:${listener.port}`, pin: identity.pin },
        });
      } catch {
        runtime.lastError = '中继配置无效，请检查 HTTPS 地址、主机密钥及本机监听地址';
        runtime.checkedAt = Date.now();
      }
      relayNodes.set(url, runtime);
    }
  };
  const connectionRoutes = () => {
    const relays = enabledNodes(rankedRelays())
      .map(({ url, id, priority }) => ({ url, kind: 'relay', relayId: id, priority,
        ...(relayState() ? { relayTarget: group.localId } : {}) }));
    const direct = connectionAddresses(store.state.host).filter(address => !['localhost', '::1'].includes(address) && !/^127\./.test(address))
      .slice(0, 16 - relays.length).map(address => ({ url: `https://${authority(address, listener?.port ?? store.state.port)}`, pin: identity.pin, kind: 'direct' }));
    return [...direct, ...relays];
  };
  group = await openDeviceGroup(directory, identity, () => ({
    name: store.state.name, routes: connectionRoutes(), publicUrl: store.state.publicUrl || '',
  }), async (previous, next, enabled) => {
    const revoked = previous.filter(row => !row.removed && (!enabled || !next.some(member =>
      member.id === row.id && !member.removed && member.generation === row.generation))).map(row => row.id);
    const joined = enabled ? next.filter(row => !row.removed && !previous.some(member =>
      member.id === row.id && !member.removed && member.generation === row.generation)).map(row => row.id) : [];
    const changed = [...new Set([...revoked, ...joined])];
    if (!changed.length) return;
    await Promise.allSettled([
      ...revoked.flatMap(id => [sessions.revoke(id), workbench?.revoke(id), sessionActions.revoke(id), ctx.get?.('benchgoExecution')?.revokePrincipal?.(id)]),
      deviceCenter?.then(center => center.invalidateGroup(changed)),
      cloudCenter?.then(center => center.invalidateGroup(changed)),
    ]);
  });
  const groupRoutes = (row, { sync = false, groupId = group.snapshot()?.id } = {}) => {
    const state = groupId === group.snapshot()?.id ? relayState() : undefined;
    const history = store.state.groupRelayHistory;
    const nodes = state ? [...enabledNodes(state.nodes), ...state.previous.filter(node => node.targeted)]
      : sync && history?.groupId === groupId ? history.nodes : [];
    if ((!group.enabled() && !sync) || !nodes.length) return row.routes;
    const shared = nodes
      .map(({ id, url, priority }) => ({ kind: 'relay', relayId: id, url, priority, relayTarget: row.id }));
    const known = new Set(shared.map(route => route.url));
    const direct = row.routes.filter(route => route.kind === 'direct');
    const prior = row.routes.filter(route => route.kind === 'relay' && !known.has(route.url));
    return [...direct.slice(0, 16 - shared.length), ...shared, ...prior].slice(0, 16);
  };
  const groupRequest = async (target, input, signal) => (await remoteJson(target, '/link/api/rpc', { action: 'deviceGroup', ...input }, { signal, timeout: 4000 })).value;
  const integrationScope = authority => JSON.stringify([group.snapshot().id, authority.id, authority.generation]);
  async function integrationToken(operation, input) {
    if (!group.enabled()) return useIntegrationToken(ctx.credentials, 'local', operation, input);
    const authority = group.authorityMember();
    if (!authority) throw Object.assign(new Error('设备组的 Token 管理设备已退出，请恢复该设备的成员资格'), { status: 503 });
    const groupId = group.snapshot().id;
    if (authority.id === group.localId) return useIntegrationToken(ctx.credentials, integrationScope(authority), operation, input);
    const routes = groupRoutes(authority).map(route => route.kind === 'relay' ? { ...route, relayTarget: authority.id } : route);
    const first = routes[0];
    if (!first && !authority.publicUrl) throw Object.assign(new Error('无法连接设备组的 Token 管理设备'), { status: 503 });
    const target = { ...first, url: authority.publicUrl || first?.url, pin: authority.publicUrl ? undefined : first?.pin,
      routes, pairedEndpointFallback: Boolean(authority.publicUrl), authorize: () => group.token(authority.id, { sync: true }) };
    const signal = AbortSignal.any([groupStop.signal, AbortSignal.timeout(6000)]);
    const credential = group.seal(authority.id, { operation, token: input.token, revision: input.revision }, 'integration-request');
    let result;
    try {
      // The expected revision prevents a retried rotation from committing twice.
      await selectRoute(target, { signal, timeout: 600, accept: async selected => {
        result = await groupRequest(selected, { operation: 'integrationToken', credential }, signal);
      } });
    } catch (error) {
      if (error.status === 403 && error.message === '此授权仅用于同步设备组') {
        throw Object.assign(new Error(`请更新 Token 管理设备「${authority.name}」上的 BenchGo，更新后重试`), {
          status: 503, code: 'INTEGRATION_PEER_UPGRADE_REQUIRED',
        });
      }
      if ([401, 403, 409].includes(error.status)) throw error;
      throw Object.assign(new Error('无法连接设备组的 Token 管理设备'), { status: 503 });
    }
    if (group.snapshot()?.id !== groupId || !group.enabled()) throw Object.assign(new Error('设备组已变更'), { status: 409 });
    return group.unseal(authority.id, result.credential, 'integration-response');
  }
  const mediaIdentity = (groupId, peerId) => ({ groupId, hostId: group.localId,
    active: () => !closed && group.snapshot()?.id === groupId && group.enabled() && (!peerId || Boolean(group.member(peerId))),
  });
  async function exchangeMedia(groupId, peerId, envelope) {
    const service = ctx.get?.('benchgoGroupMedia');
    const identity = mediaIdentity(groupId, peerId);
    if (!service || !identity.active()) return;
    const entries = await service.exchange({ ...identity, entries: group.unseal(peerId, envelope, 'media') });
    if (entries && identity.active()) return group.seal(peerId, entries, 'media');
  }
  async function clearDepartedSettings() {
    if (group.enabled() || !group.snapshot()) return;
    const groupId = group.snapshot().id;
    const results = await Promise.allSettled([
      ctx.get?.('benchgoGroupProviders')?.leave({ groupId }),
      ctx.get?.('benchgoGroupMedia')?.leave({ groupId, active: () => !closed && !group.enabled() && group.snapshot()?.id === groupId }),
      leaveRelay(),
    ]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
  const enrollGroup = async target => {
    const invite = { inviter: group.localId, groupId: group.enabled() ? group.snapshot().id : undefined };
    const { member, groupId } = await groupRequest(target, { ...invite, operation: 'describe' });
    if (member?.id !== target.hostId || target.pin && member.id !== 'sha256:' + target.pin || target.relayTarget && member.id !== target.relayTarget) throw new Error('设备组成员与配对主机身份不一致');
    const routes = member.routes.map(route => target.relayTarget && route.kind === 'relay' && route.url === target.url
      ? { ...route, relayTarget: target.relayTarget } : route);
    await clearDepartedSettings();
    if (groupId && !invite.groupId) {
      const response = await groupRequest(target, { ...invite, groupId, operation: 'admit', offer: group.offer(groupId) });
      if (response.manifest?.id !== groupId) throw new Error('设备组邀请已变更');
      await group.adopt(response.manifest, member.id, response.removals);
      if (response.relay) await exchangeRelay(member.id, response.relay);
      return { id: member.id, hostId: member.id, kind: 'computer', name: member.name, status: 'online' };
    }
    const manifest = await group.include({ ...member, routes,
      ...(!target.pin && !target.relayTarget && !member.publicUrl ? { publicUrl: target.url } : {}) }, true, invite.groupId);
    const response = await groupRequest(target, { ...invite, groupId: manifest.id, operation: 'join', manifest,
      removals: group.removals(), relay: relayEnvelope(member.id) });
    if (response.relay) await exchangeRelay(member.id, response.relay);
    return { id: member.id, hostId: member.id, kind: 'computer', name: member.name, status: 'online' };
  };
  let groupSync;
  const groupStop = new AbortController();
  async function synchronizeMembership({ row, manifest, removals, authorize }, payload = {}) {
    const routes = groupRoutes(row, { sync: true, groupId: manifest.id }), first = routes[0];
    if (!first && !row.publicUrl) return;
    const signal = AbortSignal.any([groupStop.signal, AbortSignal.timeout(6000)]);
    const target = { ...first, url: row.publicUrl || first?.url, pin: row.publicUrl ? undefined : first?.pin,
      routes, pairedEndpointFallback: Boolean(row.publicUrl), authorize };
    let response;
    await selectRoute(target, { signal, timeout: 600, accept: async selected => {
      response = await groupRequest(selected, { operation: 'sync', manifest, removals, ...payload }, signal);
    } });
    return response;
  }
  const syncGroup = () => {
    if (closed || !group.snapshot() || groupSync) return groupSync;
    groupSync = hostScope(ctx)(async () => {
      if (group.status().canInvite) await group.include(group.description());
      const manifest = group.snapshot(), providerService = ctx.get?.('benchgoGroupProviders');
      await clearDepartedSettings().catch(() => {});
      const entries = group.enabled() ? await providerService?.snapshot({ groupId: manifest.id, hostId: group.localId }).catch(() => undefined) : undefined;
      const identity = mediaIdentity(manifest.id);
      const media = identity.active() ? await ctx.get?.('benchgoGroupMedia')?.exchange(identity).catch(() => undefined) : undefined;
      const active = group.snapshot()?.id === manifest.id ? group.members().filter(row => row.id !== group.localId) : [];
      await Promise.allSettled([...active.map(async row => {
        const response = await synchronizeMembership({ row, manifest, removals: group.removals(),
          authorize: () => group.token(row.id, { sync: true }) }, {
            ...(entries && group.enabled() && group.member(row.id) ? { providers: group.seal(row.id, entries) } : {}),
            ...(media && mediaIdentity(manifest.id, row.id).active() ? { media: group.seal(row.id, media, 'media') } : {}),
            relay: relayEnvelope(row.id),
        });
        if (response?.manifest?.id !== manifest.id || group.snapshot()?.id !== manifest.id) return;
        if (group.member(row.id) || !group.enabled()) await group.adopt(response.manifest, undefined, response.removals);
        if (response.relay && group.enabled() && group.member(row.id)) await exchangeRelay(row.id, response.relay);
        if (response.providers && group.enabled() && group.member(row.id)) await providerService?.exchange({ groupId: manifest.id, hostId: group.localId, entries: group.unseal(row.id, response.providers) });
        if (response.media) await exchangeMedia(manifest.id, row.id, response.media);
      }), ...group.departures().map(async departure => {
        const response = await synchronizeMembership(departure);
        const removal = response?.removals?.find(entry => entry.target === group.localId);
        if (response?.manifest?.id === departure.manifest.id && removal) {
          await group.acknowledgeDeparture(departure.manifest.id, departure.row.id, removal.signature);
        }
      })]);
    }).finally(() => { groupSync = undefined; });
    return groupSync;
  };
  const groupTimer = setInterval(() => void syncGroup()?.catch(() => {}), 4000);
  groupTimer.unref();
  const syncGroupSoon = () => {
    void Promise.resolve(groupSync).catch(() => {}).then(syncGroup).catch(() => {});
  };
  const start = () => hostScope(ctx)(async () => {
    identity ??= await loadIdentity(directory);
    workbench = createWorkbench(ctx, store, { webRoot, workbenchRoot: config.workbenchRoot, deviceCenter: pairedDeviceCenter, resourceNavigation: pairedResourceNavigation });
    listener = await listen({ identity, config: { ...store.state }, webRoot, store, dispatch, workbench, runRequest: operation => hostScope(ctx)(operation), routes: connectionRoutes, hostName: () => group.member(group.localId)?.name ?? store.state.name, authenticateGroup: (token, path) => {
      const member = group.authenticate(token);
      return member?.groupSyncOnly && path !== '/link/api/rpc' ? undefined : member;
    }, integration: () => ctx.get?.('benchgoIntegration'),
      registerReturn: async (...args) => (await getCenter()).acceptReturn(...args), onError: e => { error = e.message; } });
    error = '';
    await connectRelays();
  });
  const status = () => {
    const selectedRelay = connectedRelay();
    const ranked = rankedRelays();
    const preferred = ranked.find(node => node.enabled !== false);
    const nodes = ranked.map(({ token, ...node }) => {
      const runtime = relayNodes.get(node.url), channel = runtime?.instance?.status();
      return { ...node, connected: channel?.connected ?? false,
        lastError: channel?.lastError ?? runtime?.lastError ?? null, checkedAt: channel?.checkedAt ?? runtime?.checkedAt ?? null };
    });
    return {
    enabled: Boolean(listener), host: store.state.host, port: listener?.port ?? store.state.port, publicUrl: store.state.publicUrl,
    hostName: group.member(group.localId)?.name ?? store.state.name, hostId: 'sha256:' + identity.pin, scopedPairing: true, error: error || null,
    addresses: connectionAddresses(store.state.host).map(a => `https://${authority(a, listener?.port ?? store.state.port)}`),
    devices: store.state.devices.map(({ tokenHash, alias, pairingReturnExpiresAt, ...device }) => ({ ...device, ...(pairingReturnExpiresAt && pairingReturnExpiresAt <= Date.now() ? { pairingReturn: 'unreachable' } : {}), capabilities: [...PAIRED_DEVICE_CAPABILITIES], name: alias || device.name, ...(alias ? { originalName: device.name } : {}) })), pending: store.pending(),
    relay: { configured: Boolean(nodes.length), enabled: Boolean(preferred), url: selectedRelay?.url || preferred?.url || nodes[0]?.url || '',
      preferredId: preferred?.id ?? null, selectedId: selectedRelay?.id ?? null, fingerprint: configurationSnapshot(LINK_RELAY_NAMESPACE).fingerprint,
      connected: Boolean(selectedRelay), lastError: selectedRelay ? null : nodes.find(node => node.enabled)?.lastError ?? null, nodes },
    };
  };
  const serializeChange = operation => {
    const task = changes.then(operation);
    changes = task.catch(() => {}); return task;
  };
  const canListenForRelay = () => ['0.0.0.0', '::', '127.0.0.1', 'localhost', '::1'].includes(store.state.host);
  async function applyRelayState(nodes, shared, history) {
    const previous = store.state.relayPool, previousShared = store.state.groupRelay, previousHistory = store.state.groupRelayHistory;
    store.state.relayPool = nodes;
    if (shared) store.state.groupRelay = shared;
    else delete store.state.groupRelay;
    if (history) store.state.groupRelayHistory = history;
    else if (shared) delete store.state.groupRelayHistory;
    try { await store.persist(); }
    catch (reason) {
      store.state.relayPool = previous;
      store.state.groupRelay = previousShared;
      store.state.groupRelayHistory = previousHistory;
      throw reason;
    }
    relayPool = nodes;
    if (listener) await connectRelays();
    else if (enabledRelay()) try { await start(); } catch (reason) { error = reason.message; }
    notifyConfiguration();
  }
  function sharedRelayState(current, version, nodes) {
    const active = new Set(enabledNodes(nodes).map(node => node.url));
    const previous = new Map((current?.previous ?? []).map(node => [node.url, node]));
    for (const node of enabledNodes(relayPool)) previous.set(node.url, { ...node, targeted: Boolean(current) });
    for (const url of active) previous.delete(url);
    return { ...version, groupId: group.snapshot().id, nodes, before: current?.before ?? relayPool,
      previous: [...previous.values()], seen: {} };
  }
  const relayEnvelope = id => {
    const state = relayState();
    if (!group.enabled() || !group.member(id)) return;
    if (state) return group.seal(id, { revision: state.revision, writer: state.writer, nodes: state.nodes }, 'relay');
  };
  const exchangeRelay = (id, envelope) => serializeChange(async () => {
    if (closed || !group.enabled() || !group.member(id)) return;
    if (envelope) {
      const incoming = group.unseal(id, envelope, 'relay');
      if (!Number.isSafeInteger(incoming?.revision) || incoming.revision < 1
        || !group.members().some(member => member.id === incoming.writer)) throw new Error('设备组中继配置版本无效');
      const nodes = normalizeLinkRelayPool(incoming.nodes);
      let current = relayState();
      if (!current || incoming.revision > current.revision || incoming.revision === current.revision && incoming.writer > current.writer) {
        current = sharedRelayState(current, { revision: incoming.revision, writer: incoming.writer }, nodes);
        current.seen[id] = relayRevision(incoming);
        await applyRelayState(nodes, current);
      } else if (current.previous.length && sameRelayRevision(relayRevision(current), relayRevision(incoming))) {
        const seen = { ...current.seen, [id]: relayRevision(incoming) };
        const allSeen = group.members().every(member => member.removed || member.id === group.localId || sameRelayRevision(seen[member.id], relayRevision(current)));
        if (allSeen || !sameRelayRevision(seen[id], current.seen[id])) {
          await applyRelayState(current.nodes, { ...current, seen, previous: allSeen ? [] : current.previous });
        }
      }
    }
    return relayEnvelope(id);
  });
  const leaveRelay = () => relayState() ? serializeChange(async () => {
    const state = relayState();
    if (!state || group.enabled()) return;
    // Keep public route coordinates for delivering membership removals after exiting.
    const nodes = [...enabledNodes(state.nodes), ...state.previous.filter(node => node.targeted)].map(({ id, url, priority }) => ({ id, url, priority }));
    await applyRelayState(state.before, undefined, { groupId: state.groupId, nodes });
  }) : undefined;
  const configureTransport = (input, transaction) => serializeChange(async () => {
    if (closed) throw new Error('Link 已关闭');
    if (transaction) {
      assertSettingsExpected(configurationSnapshot(LINK_TRANSPORT_NAMESPACE), transaction.expected, transaction.signal);
      const candidate = applySettingsOps(transportValue(), transaction.ops, { blockedPaths: [['enabled']] });
      if (Object.keys(candidate).some(key => !Object.hasOwn(LINK_TRANSPORT_SCHEMA.properties, key))) throw new Error('未知 Link 设置字段');
      input = { ...transportDefaults, ...candidate };
    }
    const value = validateConfig(input, store.state), previous = transportValue();
    if (transaction && Object.keys(input).some(key => input[key] !== value[key])) throw new Error('请使用规范化的设备名称和 HTTPS origin');
    const restart = !listener || !['host', 'port', 'publicUrl'].every(key => value[key] === store.state[key]);
    if (restart) { store.clearPairings(); await stopRelay(); await listener?.close(); listener = undefined; await sessions.close(); }
    Object.assign(store.state, value);
    try {
      if (restart && value.enabled) await start();
      transaction?.signal?.throwIfAborted();
      await store.persist();
    } catch (reason) {
      Object.assign(store.state, previous);
      if (restart) {
        await stopRelay(); await listener?.close(); listener = undefined;
        try { await start(); } catch (recovery) { error = recovery.message; }
      }
      throw reason;
    }
    notifyConfiguration();
    return transaction ? { ...configurationSnapshot(LINK_TRANSPORT_NAMESPACE), application: { state: 'applied' } } : status();
  });
  const configureRelayPool = (input, transaction) => serializeChange(async () => {
    if (closed) throw new Error('Link 已关闭');
    transaction?.authorize?.();
    assertSettingsExpected(configurationSnapshot(LINK_RELAY_NAMESPACE), transaction?.expected ?? input?.expected, transaction?.signal);
    let inputNodes;
    if (transaction) {
      if (!Array.isArray(transaction.ops) || transaction.ops.some(op => op.path?.length !== 3 || op.path[0] !== 'nodes' || !['priority', 'enabled'].includes(op.path[2]))) throw Object.assign(new Error('中继地址、节点与密钥请使用设备中心安全入口'), { code: 'SETTINGS_PATH_BLOCKED' });
      inputNodes = applySettingsOps({ nodes: relayPool }, transaction.ops).nodes;
    } else {
      inputNodes = editLinkRelayPool(relayPool, input);
    }
    const normalized = normalizeLinkRelayPool(inputNodes, relayPool);
    if (transaction && settingsFingerprint(normalized) !== settingsFingerprint(inputNodes)) throw new Error('请使用规范化的中继节点字段');
    if (normalized.some(node => node.enabled) && !canListenForRelay()) throw new Error('启用中继需要 Link 监听全部网卡或 loopback');
    if (input && ['add', 'update'].includes(input.operation)) {
      const next = normalized.find(node => node.id === input.id.trim()), prior = relayPool.find(node => node.id === next.id);
      if ((!group.enabled() || !next.enabled) && (!prior || next.url !== prior.url || next.token !== prior.token)) {
        const result = await probeRelay({ url: next.url, token: next.token });
        if (!result.ok) throw new Error(result.message);
      }
    }
    if (closed) throw new Error('Link 已关闭');
    transaction?.signal?.throwIfAborted();
    let shared;
    if (group.enabled()) {
      const current = relayState();
      for (const node of enabledNodes(normalized)) {
        if (current?.nodes.some(prior => prior.enabled && prior.url === node.url && prior.token === node.token)) continue;
        const probe = await probeRelay(node);
        if (!probe.ok || !probe.multipleHosts) throw new Error(probe.ok ? '请先更新中继服务以支持设备组共享' : probe.message);
      }
      transaction?.authorize?.();
      transaction?.signal?.throwIfAborted();
      if (!group.enabled()) throw new Error('此设备已退出设备组');
      shared = sharedRelayState(current, { revision: (current?.revision ?? 0) + 1, writer: group.localId }, normalized);
    }
    await applyRelayState(normalized, shared);
    return transaction ? { ...configurationSnapshot(LINK_RELAY_NAMESPACE), application: enabledRelay() && !connectedRelay()
      ? { state: 'pending', reason: '中继配置已保存，连接状态尚未就绪，请查看设备页面实时状态' }
      : { state: 'applied' } } : status();
  });
  const applyRemoteSettings = (input, device, centerFingerprint) => {
    const requestId = text(input.requestId, '请求 ID');
    if (input.namespace !== LINK_RELAY_NAMESPACE || !Array.isArray(input.ops) || !input.ops.length || input.ops.length > 20 || input.ops.some(op =>
      op?.op !== 'set' || !Array.isArray(op.path) || op.path.length !== 3 || op.path[0] !== 'nodes'
      || typeof op.path[1] !== 'string' || !/^(0|[1-9]\d*)$/.test(op.path[1])
      || !['priority', 'enabled'].includes(op.path[2])
      || (op.path[2] === 'priority' ? !Number.isSafeInteger(op.value) || op.value < 0 || op.value > 1000000 : typeof op.value !== 'boolean')
    )) throw Object.assign(new Error('远端仅支持已配置中继优先级与启停的精确修改'), { status: 422, code: 'UNSUPPORTED' });
    const ops = input.ops.map(({ path, value }) => ({ op: 'set', path: [...path], value }));
    const expected = { fingerprint: input.expected?.fingerprint };
    const namespace = LINK_RELAY_NAMESPACE;
    const fingerprint = settingsFingerprint({ namespace, expected, ops });
    const prior = managementOperations.find(row => row.deviceId === device.id && row.requestId === requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw Object.assign(new Error('请求 ID 已用于其他配置修改'), { status: 409, code: 'SETTINGS_IDEMPOTENCY_CONFLICT' });
      return managementFlights.get(prior.id) ?? managementView(prior);
    }
    if (typeof expected.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(expected.fingerprint)) {
      throw Object.assign(new Error('配置已变化，请重新读取'), { code: 'REVISION_CONFLICT', status: 409 });
    }
    if (managementOperations.length >= 128) {
      const retired = managementOperations.findIndex(row => row.state !== 'applying' && row.state !== 'unknown' && !managementFlights.has(row.id));
      if (retired < 0) throw Object.assign(new Error('当前管理操作已达上限'), { status: 429, code: 'CAPACITY_REACHED' });
      managementOperations.splice(retired, 1);
    }
    const operation = { id: 'management-' + randomUUID(), requestId, deviceId: device.id, namespace, expected, ops, fingerprint, createdAt: Date.now(), state: 'applying' };
    if (centerFingerprint) operation.centerFingerprint = centerFingerprint;
    managementOperations.push(operation);
    const task = (async () => {
      try { await store.persist(); } catch (reason) {
        managementOperations.splice(managementOperations.indexOf(operation), 1);
        throw reason;
      }
      try {
        operation.result = await configureRelayPool(undefined, { expected, ops, authorize: () => authorizePairedDevice(device) });
        operation.state = 'applied';
      } catch (reason) {
        operation.state = 'failed';
        operation.error = { code: reason.code || 'APPLY_FAILED', message: reason.message };
      }
      await store.persist();
      return managementView(operation);
    })().finally(() => managementFlights.delete(operation.id));
    managementFlights.set(operation.id, task);
    return task;
  };
  const pairedResourceNavigation = async (input, device, { signal, origin }) => {
    const authorize = () => {
      authorizePairedDevice(device);
      if (!device.groupMember || !group.enabled() || !group.member(device.id))
        throw Object.assign(new Error('当前工作台未获设备组资源授权'), { status: 403, code: 'GROUP_REQUIRED' });
      signal.throwIfAborted();
    };
    authorize();
    const center = await getCenter();
    if (input.action !== 'select') return center.groupResourceApi({ ...input, signal }, authorize);
    await center.groupResourceApi({ action: 'devices' }, authorize).then(value => {
      if (!value.devices.some(row => row.id === input.deviceId && row.kind !== 'local')) throw Object.assign(new Error('此设备不在工作台所属设备组中'), { status: 403 });
    });
    if (!cloudGateway) throw Object.assign(new Error('请使用桌面工作台打开其他组成员的资源，或配置云端设备网关'), { status: 409, code: 'CLOUD_DEVICE_GATEWAY_REQUIRED' });
    const cloud = await getCloudCenter();
    authorize();
    const value = await cloud.select(input.deviceId, origin, input.resource);
    authorize();
    return value;
  };
  const pairedDeviceCenter = async (input, device) => {
    authorizePairedDevice(device);
    if (input.action === 'list') {
      const devices = [{ id: 'local', kind: 'local', name: group.member(group.localId)?.name ?? store.state.name }, ...store.state.devices.map(({ id, name, alias, deviceType, lastSeenAt }) => ({
        id, name: alias || name, kind: 'paired', deviceType, lastSeenAt,
      }))];
      return { devices, activeId: 'local', capabilities: { relayManagement: true } };
    }
    if (input.action === 'hostStatus') return dispatch({ action: 'management', operation: 'status' }, device);
    if (input.action === 'hostRelayTest') return dispatch({ action: 'management', operation: 'relay-test', id: text(input.id, '中继 ID', 128) }, device);
    if (input.action === 'hostRelayOperation') return dispatch({ action: 'management', operation: 'operation', requestId: text(input.requestId, '请求 ID') }, device);
    if (input.action === 'hostRelayPoolConfigure') {
      const { id, operation, expected, enabled } = input;
      const requestId = text(input.requestId, '请求 ID');
      const centerFingerprint = settingsFingerprint({ id, operation, expected, enabled });
      if (input.url !== undefined || input.token !== undefined || !(operation === 'update' && typeof enabled === 'boolean' || operation === 'prefer')) {
        throw Object.assign(new Error('此入口仅支持已有中继的启停与首选设置'), { status: 422, code: 'UNSUPPORTED' });
      }
      const previous = managementOperations.find(row => row.deviceId === device.id && row.requestId === requestId);
      if (previous) {
        if (previous.centerFingerprint !== centerFingerprint) {
          throw Object.assign(new Error('请求 ID 已用于其他配置修改'), { status: 409, code: 'SETTINGS_IDEMPOTENCY_CONFLICT' });
        }
        return managementFlights.get(previous.id) ?? managementView(previous);
      }
      const snapshot = configurationSnapshot(LINK_RELAY_NAMESPACE);
      assertSettingsExpected(snapshot, expected);
      const { nodes } = snapshot.value;
      const edited = editLinkRelayPool(nodes, { id, operation, enabled });
      const ops = nodes.flatMap((node, index) => {
        const next = edited.find(row => row.id === node.id);
        const key = operation === 'prefer' ? 'priority' : 'enabled';
        if (node[key] === next[key] && node.id !== id) return [];
        return [{ op: 'set', path: ['nodes', String(index), key], value: next[key] }];
      });
      return applyRemoteSettings({ namespace: LINK_RELAY_NAMESPACE, expected, ops, requestId }, device, centerFingerprint);
    }
    throw Object.assign(new Error('此设备操作需要在目标设备本机完成'), { status: 403, code: 'OWNER_REQUIRED' });
  };
  const admin = async (input, pairingCenter = getCenter) => {
    if (closed) throw new Error('Link 已关闭');
    const action = text(input?.action, '操作');
    if (action === 'status') return input.pairingCode === undefined ? status() : { pending: store.pending(input.pairingCode) };
    if (action === 'pairing-probe') return store.beginProbe();
    if (action === 'relay-test') {
      const previous = input.id ? relayPool.find(node => node.id === input.id) : undefined;
      if (input.id && !previous) return { ok: false, latencyMs: 0, message: '中继不存在，请刷新后重试' };
      const url = input.url ?? previous?.url;
      if (previous && url !== previous.url && !input.token) return { ok: false, latencyMs: 0, message: '更换中继地址时请重新输入主机密钥' };
      return probeRelay({ url, token: input.token || previous?.token });
    }
    if (action === 'relay-pool-configure') return configureRelayPool(input);
    if (action === 'configure') {
      return configureTransport(input);
    }
    if (action === 'pairing') {
      if (!listener) throw new Error(error || '设备连接服务暂不可用，请检查监听地址和端口');
      const mode = input.mode ?? 'lan';
      if (!['lan', 'public', 'relay'].includes(mode)) throw new Error('连接模式无效');
      const relayId = input.relayId === undefined ? undefined : text(input.relayId, '中继 ID', 128);
      if (relayId && mode !== 'relay') throw new Error('仅中继配对可指定中继节点');
      const selectedRelay = mode === 'relay' ? connectedRelay(relayId) : undefined;
      if (mode === 'relay' && !selectedRelay) throw new Error('自有中继尚未连接，请检查中继配置和网络');
      const addresses = status().addresses;
      let url = mode === 'relay' ? selectedRelay.url : mode === 'public' ? store.state.publicUrl : addresses[0];
      if (mode === 'public' && !store.state.publicUrl) throw new Error('请先保存可达的公网 HTTPS 地址');
      if (input.address !== undefined) {
        if (mode !== 'lan' || !addresses.includes(input.address)) throw new Error('局域网地址无效');
        url = input.address;
      }
      if (!url) throw new Error('未找到可用的连接地址，请检查网络或在高级设置中指定监听地址');
      const pair = store.begin(async (...args) => (await pairingCenter()).acceptReturn(...args));
      const relayTarget = mode === 'relay' && relayState() ? group.localId : undefined;
      const query = new URLSearchParams({ url, pin: mode === 'lan' ? identity.pin : '', code: pair.code, name: store.state.name,
        ...(relayTarget ? { relayTarget } : {}) });
      const webTarget = relayTarget ? '?relayTarget=' + encodeURIComponent(relayTarget) : '';
      return { ...pair, mode, uri: `benchgo://pair?${query}`, ...(mode !== 'lan' ? { webUrl: `${url}/link/${webTarget}#code=${encodeURIComponent(pair.code)}` } : {}), url };
    }
    if (action === 'confirm' || action === 'reject') {
      const id = text(input.id, '设备 ID');
      if (input.pairingCode !== undefined && !store.pending(input.pairingCode).some(row => row.id === id)) throw new Error('配对申请已过期或不存在');
      await store.decide(id, action === 'confirm');
      return status();
    }
    if (action === 'rename-device') { await store.renameDevice(text(input.id, '设备 ID'), input.name); return status(); }
    if (action === 'revoke') { const id = text(input.id, '设备 ID'); await store.revoke(id); await Promise.all([sessions.revoke(id), workbench?.revoke(id), sessionActions.revoke(id), ctx.get?.('benchgoExecution')?.revokePrincipal?.(id)]); return status(); }
    throw new Error('不支持的管理操作');
  };
  let deviceCenter, cloudCenter, cloudGateway;
  const pairing = {
    offer() {
      if (!listener) return undefined;
      const routes = connectionRoutes().filter(validReturnTarget);
      const publicTarget = store.state.publicUrl ? { url: store.state.publicUrl, pin: '' } : undefined;
      const target = publicTarget && validReturnTarget(publicTarget) ? publicTarget : routes[0];
      if (!target) return undefined;
      return { version: PAIR_RETURN_VERSION, hostId: 'sha256:' + identity.pin, target: { url: target.url, pin: target.pin }, routes, proof: store.beginReturnProof() };
    },
    clearProof: id => store.clearReturnProof(id),
    issue: (name, expiresAt) => store.issueReturn(name, expiresAt),
    record: (id, direction) => store.recordReturn(id, direction),
    revoke: id => store.revoke(id),
  };
  const centerOptions = { webRoot, credentials: ctx.credentials, localDispatch: input => dispatch(input, { id: 'local' }), localName: () => store.state.name, pairing,
    signSource: (target, command) => signExecutionSource(identity, target, command) };
  const getCenter = () => deviceCenter ??= createDeviceCenter({ ...centerOptions, directory: join(directory, 'outgoing'), hostAdmin: input => admin(input),
    group: { ...group, routes: groupRoutes, enroll: enrollGroup, syncSoon: syncGroupSoon } }).catch(error => { deviceCenter = undefined; throw error; });
  const deviceAction = async input => {
    input = { ...input, action: input.action || ({ diagnose: 'hostStatus' }[input.operation] || input.operation) };
    if (input.action === 'connect' && input.deviceId && input.deviceId !== 'local') return (await getCenter()).resources({ deviceId: input.deviceId, kind: 'capabilities' });
    if (input.action === 'hostStatus' && input.deviceId && input.deviceId !== 'local') return (await getCenter()).callDevice({ deviceId: input.deviceId, input: { action: 'management', operation: 'status' } });
    if (['password','privateKey','token','uri'].some(key => input?.[key] !== undefined)) return { available: false, code: 'SECURE_INPUT_REQUIRED', reason: '请在侧栏设备中心安全入口补齐凭据或配对地址', handoff: { kind: 'device-center' } };
    if (!['list','devices','rename','remove','reconnect','job','relayProbe','hostStatus'].includes(input?.action)) return { available: false, code: 'SECURE_INPUT_REQUIRED', reason: '请在侧栏设备中心完成连接、授权或受控管理', handoff: { kind: 'device-center' } };
    return (await getCenter()).api(input);
  };
  const getCloudCenter = () => cloudCenter ??= createDeviceCenter({ ...centerOptions, directory: join(directory, 'cloud-outgoing'), hostAdmin: input => admin(input, getCloudCenter), publicOrigin: cloudAccess.origin, workbenchOrigin: env.DSH_LINK_WORKBENCH_ORIGIN, registerProxy: () => cloudGateway.registerProxy(), group: { ...group, routes: groupRoutes, enroll: enrollGroup, syncSoon: syncGroupSoon } }).catch(error => { cloudCenter = undefined; throw error; });
  if (env.DSH_LINK_DEVICE_GATEWAY_PORT && cloudAccess.origin && env.DSH_LINK_WORKBENCH_ORIGIN) {
    cloudGateway = await createCloudDeviceGateway({ ownerOrigin: cloudAccess.origin, workbenchOrigin: env.DSH_LINK_WORKBENCH_ORIGIN, port: Number(env.DSH_LINK_DEVICE_GATEWAY_PORT), getCenter: getCloudCenter });
  }
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/commander-devices', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      captureHostScope(ctx);
      try {
        if (closed) throw new Error('Link 已关闭');
        const input = await request.json();
        if (!['launch', 'devices', 'select', 'resources', 'resourceScope', 'setResourceScope', 'sessionAction'].includes(input.action)) throw new Error('不支持的设备操作');
        const requestedParent = input.parentOrigin;
        // The official HTTP bridge uses dsh.internal in request.url; browser
        // Origin and the carrier Host retain the actual admitted page address.
        const origin = request.headers.get('origin');
        const host = request.headers.get('host');
        const carrier = host ? new URL('http://' + host) : new URL(request.url);
        const local = value => ['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname);
        const native = !origin && local(carrier) && ['dsh-app://app', 'dsh-app://localhost'].includes(requestedParent);
        const page = origin ? new URL(origin) : carrier;
        const parent = native ? requestedParent : page.origin;
        if (!native && (!['http:', 'https:'].includes(page.protocol) || !local(page))) {
          if (input.action === 'select') throw new Error('请在本机切换已保存的设备');
          if (!cloudGateway || page.origin !== cloudAccess.origin) return Response.json({ error: '请配置云端设备网关后重试；本机 BenchGo 可继续管理设备。', code: 'CLOUD_DEVICE_GATEWAY_REQUIRED' }, { status: 409, headers: { 'cache-control': 'no-store' } });
          const center = await getCloudCenter();
          const value = input.action === 'devices' ? center.devices() : ['resources','resourceScope','setResourceScope','sessionAction'].includes(input.action) ? await center.api({ ...input, signal: request.signal }) : center.launch(page.origin);
          return Response.json(value, { headers: { 'cache-control': 'no-store' } });
        }
        const center = await getCenter();
        if (closed) throw new Error('Link 已关闭');
        if (input.action === 'select' && (typeof input.deviceId !== 'string' || !input.deviceId)) throw new Error('请选择已保存的设备');
        const value = input.action === 'devices' ? center.devices() : ['resources','resourceScope','setResourceScope','sessionAction'].includes(input.action) ? await center.api({ ...input, signal: request.signal }) : input.action === 'select'
          ? await center.select(input.deviceId, parent, input.resource) : center.launch(parent);
        return Response.json(value, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status ?? error.statusCode ?? 400, headers: { 'cache-control': 'no-store' } }); }
    },
  }));
  const close = () => {
    if (closing) return closing;
    closed = true;
    clearInterval(groupTimer);
    groupStop.abort();
    closing = (async () => {
      await groupSync?.catch(() => {});
      await group.flush();
      const cloudClosing = cloudAccess.close();
      await (await deviceCenter?.catch(() => undefined))?.close();
      await cloudGateway?.close();
      await (await cloudCenter?.catch(() => undefined))?.close();
      await cloudClosing;
      await Promise.allSettled(managementFlights.values());
      await changes; await stopRelay(); await listener?.close(); listener = undefined; await sessionActions.close(); await sessions.close(); store.clearPairings(); await store.flush();
    })();
    return closing;
  };
  await store.persist();
  try { await start(); } catch (e) { error = e.message; }
  ctx.effect(() => () => close());
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/commander-link', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      captureHostScope(ctx);
      try {
        const input = await request.json(), value = await admin(input);
        const headers = { 'cache-control': 'no-store' };
        if (input.action === 'cloud-access' && ['enable', 'rotate'].includes(input.operation) && request.headers.get('origin') === cloudAccess.origin) headers['set-cookie'] = cloudAccess.sessionCookie();
        return Response.json(value, { headers });
      }
      catch (e) { return Response.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status ?? 400, headers: { 'cache-control': 'no-store' } }); }
    },
  }));
  const service = {
    admin, status, close, configurationSnapshot,
    integrationToken,
    integrationEndpoint() {
      const relay = connectedRelay();
      const origin = relay?.url || (listener && store.state.publicUrl);
      if (!origin) return undefined;
      return { url: new URL('/link/api/rpc', origin).href, relay: Boolean(relay), ...(relay ? { relayTarget: group.localId } : {}) };
    },
    devices: async () => { const snapshot = (await getCenter()).devices(); const hostId = 'sha256:' + identity.pin; return { ...snapshot, hostId, devices: snapshot.devices.map(device => device.id === 'local' ? { ...device, hostId, authorizationId: null } : device) }; },
    resources: async input => (await getCenter()).resources(input),
    resolveDeviceIdentity: async input => (await getCenter()).resolveDeviceIdentity(input),
    callDevice: async input => (await getCenter()).callDevice(input),
    sshTarget: async input => (await getCenter()).sshTarget(input),
    sshCommand: async input => (await getCenter()).sshCommand(input),
    deviceAction,
    configureSettings(namespace, transaction) {
      if (namespace === LINK_TRANSPORT_NAMESPACE) return configureTransport({}, transaction);
      if (namespace === LINK_RELAY_NAMESPACE) return configureRelayPool(undefined, transaction);
      throw new Error('未知 Link 设置');
    },
    subscribe(fn) { settingsListeners.add(fn); return () => settingsListeners.delete(fn); },
  };
  ctx.inject?.(['benchgoSettings'], child => child.effect(() => child.get('benchgoSettings').register(createLinkSettingsAdapter(service))));
  return service;
}
