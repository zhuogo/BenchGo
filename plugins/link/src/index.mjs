import { join } from 'node:path';
import { openStore, text } from './pairing/store.mjs';
import { loadIdentity } from './transport/tls.mjs';
import { listen, connectionAddresses, authority, validateConfig } from './transport/server.mjs';
import { createSessionAdapter } from './session/adapter.mjs';
import { createNativeAdapter } from './session/native.mjs';
import { createDeviceCenter } from './devices/center.mjs';
import { createWorkbench } from './transport/workbench.mjs';
import { createCloudAccess } from './cloud-access.mjs';
import { createCloudDeviceGateway } from './devices/cloud-gateway.mjs';
import { createRelayHost } from './transport/relay-host.mjs';
import { testRelayConnection } from './transport/relay-probe.mjs';
import { defaultLinkTransport, LINK_TRANSPORT_SCHEMA, LINK_RELAY_SCHEMA, normalizeLinkRelayPool } from './config.mjs';
import { createLinkSettingsAdapter, LINK_TRANSPORT_NAMESPACE, LINK_RELAY_NAMESPACE } from './settings-adapter.mjs';
import { settingsSnapshot, settingsFingerprint, assertSettingsExpected, applySettingsOps, notifySettings } from '../../benchgo/shared/settings-adapter-utils.mjs';

/** Owner admin uses Harness Connection; remote devices get a distinct TLS carrier. */
export async function mountLink(ctx, config = {}) {
  const env = config.env ?? process.env;
  let relayError = '';
  let relayUrl, relayToken;
  const directory = config.directory ?? join(ctx.get('benchgo').directory, 'link');
  const store = await openStore(directory);
  const relayPool = Array.isArray(store.state.relayPool)
    ? store.state.relayPool
    : ((store.state.relay?.url || env.DSH_LINK_RELAY_URL) ? [{ id: 'primary', url: store.state.relay?.url || env.DSH_LINK_RELAY_URL, token: store.state.relay?.token || env.DSH_LINK_RELAY_TOKEN, priority: 0, enabled: store.state.relay?.enabled !== false }] : []);
  const relayNodes = new Map();
  const stopRelay = async () => { await Promise.all([...relayNodes.values()].map(node => node.instance?.close())); relayNodes.clear(); };
  relayUrl = relayPool[0]?.url ?? '';
  relayToken = relayPool[0]?.token ?? '';
  let relayEnabled = relayPool.some(node => node.enabled !== false);
  const connectedRelay = () => relayPool
    .map((node, index) => ({ ...node, priority: Number.isInteger(node.priority) ? node.priority : index, runtime: relayNodes.get(node.id || `relay-${index + 1}`) }))
    .filter(node => node.enabled !== false && node.runtime?.instance.status().connected)
    .sort((a, b) => a.priority - b.priority)[0];
  validateConfig({}, store.state);
  const sessions = createSessionAdapter(ctx);
  const native = createNativeAdapter(ctx);
  const cloudAccess = await createCloudAccess(directory, { env: config.env ?? process.env, probe: config.cloudProbe });
  const dispatch = async (input, device) => {
    if (input?.id?.startsWith('native:')) return native.dispatch(input);
    const result = await sessions.dispatch(input, device);
    if (input.action === 'state') result.sessions.push(...native.list());
    return result;
  };
  let listener, identity, workbench, error = '', closed = false, closing, changes = Promise.resolve();
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
    if (!listener || !relayEnabled || !relayPool.length) return;
    const targetHost = ['::', '::1'].includes(store.state.host) ? '[::1]' : store.state.host === '0.0.0.0' ? '127.0.0.1' : store.state.host;
    for (const [index, node] of relayPool.entries()) if (node.enabled !== false && node.url && node.token) {
      try { const instance = await (config.createRelayHost ?? createRelayHost)({ relayUrl: node.url, token: node.token, relayHeaders: listener.relayHeaders, target: { url: `https://${targetHost}:${listener.port}`, pin: identity.pin }, onError: () => {} }); relayNodes.set(node.id || `relay-${index + 1}`, { ...node, id: node.id || `relay-${index + 1}`, instance }); }
      catch { relayError = '中继配置无效，请检查 HTTPS 地址、主机密钥及本机监听地址'; }
    }
  };
  const start = async () => {
    identity ??= await loadIdentity(directory);
    workbench = createWorkbench(ctx, store, { webRoot, workbenchRoot: config.workbenchRoot });
    listener = await listen({ identity, config: { ...store.state }, webRoot, store, dispatch, workbench, routes: () => [
      ...connectionAddresses(store.state.host).slice(0, 15).map(address => ({ url: `https://${authority(address, listener?.port ?? store.state.port)}`, pin: identity.pin, kind: 'direct' })),
      ...relayPool.filter(node => node.enabled !== false && node.url && node.token).map((node, index) => ({ url: node.url, kind: 'relay', relayId: node.id || `relay-${index + 1}`, priority: Number.isInteger(node.priority) ? node.priority : index })),
    ], onError: e => { error = e.message; } });
    error = '';
    relayError = '';
    await connectRelays();
  };
  const status = () => {
    const selectedRelay = connectedRelay();
    return {
    enabled: Boolean(listener), host: store.state.host, port: listener?.port ?? store.state.port, publicUrl: store.state.publicUrl,
    hostName: store.state.name, error: error || null,
    addresses: connectionAddresses(store.state.host).map(a => `https://${authority(a, listener?.port ?? store.state.port)}`),
    devices: store.state.devices.map(({ tokenHash, alias, ...device }) => ({ ...device, name: alias || device.name, ...(alias ? { originalName: device.name } : {}) })), pending: store.pending(),
    relay: { configured: Boolean(relayPool.length || relayUrl), enabled: relayEnabled, url: selectedRelay?.url ?? relayUrl, nodes: relayPool.map((node, index) => { const runtime = relayNodes.get(node.id || `relay-${index + 1}`); const { token, instance, ...publicNode } = node; return { ...publicNode, id: node.id || `relay-${index + 1}`, ...(runtime?.instance?.status() ?? { connected: false, lastError: relayError || null }) }; }), ...(selectedRelay?.runtime.instance.status() ?? { connected: false, lastError: relayNodes.values().next().value?.instance.status().lastError || relayError || null }) },
    };
  };
  const serializeChange = operation => {
    const task = changes.then(operation);
    changes = task.catch(() => {}); return task;
  };
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
  const configureRelayPool = (inputNodes, transaction) => serializeChange(async () => {
    if (closed) throw new Error('Link 已关闭');
    if (transaction) {
      assertSettingsExpected(configurationSnapshot(LINK_RELAY_NAMESPACE), transaction.expected, transaction.signal);
      // Whole-node writes contain credentials; only existing public fields use this seam.
      const publicFields = new Set(Object.keys(LINK_RELAY_SCHEMA.properties.nodes.items.properties).filter(key => key !== 'token'));
      if (!Array.isArray(transaction.ops) || transaction.ops.some(op => op.path?.length !== 3 || op.path[0] !== 'nodes' || !publicFields.has(op.path[2]))) throw Object.assign(new Error('中继节点与密钥请使用安全入口'), { code: 'SETTINGS_PATH_BLOCKED' });
      inputNodes = applySettingsOps({ nodes: relayPool }, transaction.ops).nodes;
    }
    const normalized = normalizeLinkRelayPool(inputNodes, relayPool);
    if (transaction && settingsFingerprint(normalized) !== settingsFingerprint(inputNodes)) throw new Error('请使用规范化的中继节点字段');
    if (relayPool.some(node => node.enabled !== false && !normalized.some(next => next.id === node.id))) throw new Error('请先停用中继，再删除');
    const previous = store.state.relayPool, previousRelay = store.state.relay;
    store.state.relayPool = normalized;
    store.state.relay = normalized[0] ? { url: normalized[0].url, token: normalized[0].token, enabled: normalized[0].enabled } : { url: '', token: '', enabled: false };
    try { await store.persist(); } catch (reason) { store.state.relayPool = previous; store.state.relay = previousRelay; throw reason; }
    await stopRelay();
    relayPool.splice(0, relayPool.length, ...normalized);
    relayUrl = normalized[0]?.url || ''; relayToken = normalized[0]?.token || '';
    relayEnabled = normalized.some(node => node.enabled); relayError = '';
    if (relayEnabled && !listener) { store.state.enabled = true; try { await start(); } catch (reason) { error = reason.message; } }
    else if (relayEnabled && listener) await connectRelays();
    notifyConfiguration();
    return transaction ? { ...configurationSnapshot(LINK_RELAY_NAMESPACE), application: relayEnabled && !connectedRelay()
      ? { state: 'pending', reason: '中继配置已保存，连接状态尚未就绪，请查看设备页面实时状态' }
      : { state: 'applied' } } : status();
  });
  const admin = async input => {
    if (closed) throw new Error('Link 已关闭');
    const action = text(input?.action, '操作');
    if (action === 'status') return status();
    if (action === 'relay-test') {
      const previous = input.id ? relayPool.find(node => node.id === input.id) : undefined;
      if (input.id && !previous) return { ok: false, latencyMs: 0, message: '中继不存在，请刷新后重试' };
      return testRelayConnection({ url: input.url ?? previous?.url, token: input.token || previous?.token }, config.relayTestOptions);
    }
    if (action === 'relay-pool-configure') {
      return configureRelayPool(input.nodes);
    }
    if (action === 'relay-configure') {
      const task = changes.then(async () => {
        if (closed) throw new Error('Link 已关闭');
        const url = input.url === undefined ? relayUrl : text(input.url, '中继地址', 2048);
        let parsed; try { parsed = new URL(url); } catch { throw new Error('中继地址无效'); }
        if (parsed.protocol !== 'https:' || parsed.origin !== url || parsed.username || parsed.password) throw new Error('中继必须使用独立 HTTPS origin');
        const token = input.token === undefined ? relayToken : text(input.token, '中继主机密钥', 256);
        if (token.length < 6) throw new Error('中继主机密钥至少需要 6 个字符');
        const enabled = input.enabled === undefined ? true : input.enabled;
        if (typeof enabled !== 'boolean') throw new Error('中继启用状态无效');
        if (enabled && !['0.0.0.0', '::', '127.0.0.1', 'localhost', '::1'].includes(store.state.host)) throw new Error('启用中继需要 Link 监听全部网卡或 loopback');
        const previous = store.state.relay;
        store.state.relay = { url, token, enabled };
        const primary = { id: relayPool[0]?.id || 'primary', url, token, priority: 0, enabled };
        relayPool.splice(0, relayPool.length, primary);
        store.state.relayPool = relayPool.map(({ instance, ...node }) => node);
        try { await store.persist(); } catch (error) { store.state.relay = previous; throw error; }
        relayUrl = url; relayToken = token; relayEnabled = enabled;
        store.clearPairings(); await stopRelay();
        if (enabled) {
          if (!listener) { store.state.enabled = true; await start(); await store.persist(); }
          else {
            relayError = '';
            await connectRelays();
          }
        }
        notifyConfiguration(); return status();
      });
      changes = task.catch(() => {}); return task;
    }
    if (action === 'configure') {
      return configureTransport(input);
    }
    if (action === 'pairing') {
      if (!listener) throw new Error(error || '设备连接服务暂不可用，请检查监听地址和端口');
      const mode = input.mode ?? 'lan';
      if (!['lan', 'public', 'relay'].includes(mode)) throw new Error('连接模式无效');
      const selectedRelay = mode === 'relay' ? connectedRelay() : undefined;
      if (mode === 'relay' && !selectedRelay) throw new Error('自有中继尚未连接，请检查中继配置和网络');
      const addresses = status().addresses;
      let url = mode === 'relay' ? selectedRelay.url : mode === 'public' ? store.state.publicUrl : addresses[0];
      if (mode === 'public' && !store.state.publicUrl) throw new Error('请先保存可达的公网 HTTPS 地址');
      if (input.address !== undefined) {
        if (mode !== 'lan' || !addresses.includes(input.address)) throw new Error('局域网地址无效');
        url = input.address;
      }
      if (!url) throw new Error('未找到可用的连接地址，请检查网络或在高级设置中指定监听地址');
      const pair = store.begin();
      const query = new URLSearchParams({ url, pin: mode === 'lan' ? identity.pin : '', code: pair.code, name: store.state.name });
      return { ...pair, mode, uri: `benchgo://pair?${query}`, ...(mode !== 'lan' ? { webUrl: `${url}/link/#code=${encodeURIComponent(pair.code)}` } : {}), url };
    }
    if (action === 'confirm' || action === 'reject') { await store.decide(text(input.id, '设备 ID'), action === 'confirm'); return status(); }
    if (action === 'rename-device') { await store.renameDevice(text(input.id, '设备 ID'), input.name); return status(); }
    if (action === 'revoke') { const id = text(input.id, '设备 ID'); await store.revoke(id); await Promise.all([sessions.revoke(id), workbench?.revoke(id)]); return status(); }
    throw new Error('不支持的管理操作');
  };
  let deviceCenter, cloudCenter, cloudGateway;
  const getCloudCenter = () => cloudCenter ??= createDeviceCenter({ directory: join(directory, 'cloud-outgoing'), webRoot, hostAdmin: admin, localName: () => store.state.name, publicOrigin: cloudAccess.origin, workbenchOrigin: env.DSH_LINK_WORKBENCH_ORIGIN, registerProxy: () => cloudGateway.registerProxy() }).catch(error => { cloudCenter = undefined; throw error; });
  if (env.DSH_LINK_DEVICE_GATEWAY_PORT && cloudAccess.origin && env.DSH_LINK_WORKBENCH_ORIGIN) {
    cloudGateway = await createCloudDeviceGateway({ ownerOrigin: cloudAccess.origin, workbenchOrigin: env.DSH_LINK_WORKBENCH_ORIGIN, port: Number(env.DSH_LINK_DEVICE_GATEWAY_PORT), getCenter: getCloudCenter });
  }
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/commander-devices', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        if (closed) throw new Error('Link 已关闭');
        const input = await request.json();
        if (!['launch', 'devices'].includes(input.action)) throw new Error('不支持的设备操作');
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
          if (!cloudGateway || page.origin !== cloudAccess.origin) return Response.json({ error: '请配置云端设备网关后重试；本机 BenchGo 可继续管理设备。', code: 'CLOUD_DEVICE_GATEWAY_REQUIRED' }, { status: 409, headers: { 'cache-control': 'no-store' } });
          const center = await getCloudCenter();
          return Response.json(center.launch(page.origin), { headers: { 'cache-control': 'no-store' } });
        }
        deviceCenter ??= createDeviceCenter({ directory: join(directory, 'outgoing'), webRoot, hostAdmin: admin, localName: () => store.state.name }).catch(error => { deviceCenter = undefined; throw error; });
        const center = await deviceCenter;
        if (closed) throw new Error('Link 已关闭');
        return Response.json(input.action === 'devices' ? center.summary() : center.launch(parent), { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return Response.json({ error: error.message }, { status: 400, headers: { 'cache-control': 'no-store' } }); }
    },
  }));
  const close = () => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      const cloudClosing = cloudAccess.close();
      await (await deviceCenter?.catch(() => undefined))?.close();
      await cloudGateway?.close();
      await (await cloudCenter?.catch(() => undefined))?.close();
      await cloudClosing;
      await changes; await stopRelay(); await listener?.close(); listener = undefined; await sessions.close(); store.clearPairings(); await store.flush();
    })();
    return closing;
  };
  await store.persist();
  try { await start(); } catch (e) { error = e.message; }
  ctx.effect(() => () => close());
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/commander-link', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const input = await request.json(), value = await admin(input);
        const headers = { 'cache-control': 'no-store' };
        if (input.action === 'cloud-access' && ['enable', 'rotate'].includes(input.operation) && request.headers.get('origin') === cloudAccess.origin) headers['set-cookie'] = cloudAccess.sessionCookie();
        return Response.json(value, { headers });
      }
      catch (e) { return Response.json({ error: e.message }, { status: 400, headers: { 'cache-control': 'no-store' } }); }
    },
  }));
  const service = {
    admin, status, close, configurationSnapshot,
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
