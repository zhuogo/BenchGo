import { selectRoute } from './routes.mjs';
import { remoteAgent, remoteJson } from './remote.mjs';
const kinds = new Set(['projects', 'sessions', 'recent', 'models', 'capabilities', 'tasks']);
const actions = new Set(['state', 'models', 'create', 'history', 'send', 'cancel', 'respond', 'resources', 'collaboration', 'management']);
const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const networkErrors = new Set(['OFFLINE', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ERR_SOCKET_CLOSED', 'ERR_STREAM_PREMATURE_CLOSE', 'ROUTES_COOLDOWN']);
/** Reachability is separate from authorization and resource/business failures. */
export function deviceConnectionFailure(error) {
  const status = error.statusCode ?? error.status;
  if (error.code === 'IDENTITY_CHANGED' || error.code === 'ERR_LINK_CERTIFICATE' || /CERT|TLS/.test(error.code || '')) return { code: 'IDENTITY_CHANGED', status: 'failed', reason: '主机身份或证书变化，请在设备中心重新核验' };
  if ([401, 403].includes(status) || error.code === 'UNAUTHORIZED') return { code: 'UNAUTHORIZED', status: 'failed', reason: '授权失效，请在设备中心重新核验' };
  if (networkErrors.has(error.code) || error.name === 'TimeoutError') return { code: 'OFFLINE', status: 'offline', reason: '设备暂不可达，请检查连接后重试' };
  if (error.code === 'UNSUPPORTED' || status === 422) return { code: 'UNSUPPORTED', status: 'online', reason: '目标尚不支持该资源' };
  return { code: 'QUERY_FAILED', status: status >= 400 ? 'online' : null, reason: '设备资源查询失败，请重试' };
}
export function resourcePage(input = {}) {
  const kind = input.kind || 'projects', offset = input.offset ?? 0, limit = input.limit ?? 30;
  if (!kinds.has(kind) || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('资源查询范围无效', 'INVALID_RESOURCE_QUERY');
  return { kind, offset, limit };
}
/** Allowlisted summaries; remote payloads never become configuration or authority. */
export function projectResources(state, input, deviceId) {
  const { kind, offset, limit } = resourcePage(input);
  let source = kind === 'recent' ? state.sessions : state[kind];
  if (!Array.isArray(source)) throw fail('目标尚不支持该资源', 'UNSUPPORTED', 422);
  if (input.projectId !== undefined) source = source?.filter(row => row.projectId === input.projectId);
  if (kind === 'recent') {
    const now = Date.now() + 86400000;
    source = source.map((row, index) => { const time = Number(row.updatedAt) || Date.parse(row.updatedAt); return { row, index, time: Number.isFinite(time) && time > 0 && time < now ? time : 0 }; })
      .sort((a, b) => Number(!!b.row.pinned) - Number(!!a.row.pinned) || b.time - a.time || a.index - b.index).map(({ row }) => row);
  }
  const fields = kind === 'projects' ? ['id','name','title','path','sessionIds','isDefault'] : kind === 'sessions' || kind === 'recent' ? ['id','projectId','title','running','updatedAt','archived','pinned','native','ungrouped','engine','status'] : kind === 'models' ? ['id','provider','model','label','available'] : kind === 'capabilities' ? ['id','available','reason','operations'] : ['id','title','status','projectId','updatedAt','executionRef'];
  const items = source.slice(offset, offset + limit).map(row => ({ ...Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key, row[key]])), deviceId, kind, resourceId: row.id ?? row.model }));
  return { deviceId, available: true, code: 'OK', reason: null, observedAt: Date.now(), freshness: 'fresh', items, offset, limit, total: source.length, hasMore: offset + limit < source.length };
}
export function createDeviceResources({ registry, local, request = remoteJson, route = selectRoute, timeout = 8000 }) {
  const cache = new Map(), connections = new Map();
  let epoch = 0, sequence = 0;
  const identity = saved => JSON.stringify([saved.url, saved.pin, saved.token, saved.hostId, saved.authorizationId, saved.routes?.map(({ kind, url, pin, relayId, id, priority }) => [kind, url, pin, relayId, id, priority])]);
  const invalidate = deviceId => {
    for (const key of cache.keys()) if (JSON.parse(key)[0] === deviceId) cache.delete(key);
    const connection = connections.get(deviceId);
    connections.delete(deviceId);
    connection?.controller.abort(Object.assign(fail('设备连接已更新', 'IDENTITY_CHANGED', 409), { stale: true }));
    connection?.agent?.destroy();
  };
  const devices = () => {
    const snapshot = registry.list();
    return { ...snapshot, devices: snapshot.devices.map(row => ({ ...row, direction: row.id === 'local' ? 'local' : 'outbound', observedAt: Date.now(), ...(row.id === 'local' ? {} : { hostId: registry.get(row.id).hostId || null, authorizationId: registry.get(row.id).authorizationId || null }) })) };
  };
  const current = (deviceId, connection) => {
    let saved;
    try { saved = registry.get(deviceId); } catch { throw Object.assign(fail('设备已移除', 'NOT_FOUND', 404), { stale: true }); }
    if (connections.get(deviceId) !== connection || identity(saved) !== connection.identity) throw Object.assign(fail('设备身份或连接已更新', 'IDENTITY_CHANGED', 409), { stale: true });
    return saved;
  };
  const observe = (deviceId, connection, order, status, reason = null) => {
    if (status && order >= connection.observed) { current(deviceId, connection); connection.observed = order; registry.mark(deviceId, status, reason); }
  };
  const callDevice = async ({ deviceId, input, signal }) => {
    if (!actions.has(input?.action)) throw fail('不支持的定向操作', 'UNSUPPORTED', 422);
    signal?.throwIfAborted();
    if (deviceId === 'local') return local(input, signal);
    const saved = registry.get(deviceId);
    let connection = connections.get(deviceId);
    if (!connection || connection.identity !== identity(saved)) {
      invalidate(deviceId);
      connection = { identity: identity(saved), controller: new AbortController(), observed: 0 };
      connections.set(deviceId, connection);
    }
    const bounded = AbortSignal.any([...(signal ? [signal] : []), connection.controller.signal, AbortSignal.timeout(timeout)]), order = ++sequence;
    let agent;
    try {
      // Share in-flight selection and briefly retain a verified route; never replay an RPC.
      if (!connection.selection || connection.expiresAt <= Date.now()) {
        connection.expiresAt = Infinity;
        connection.selection = route(saved, { signal: AbortSignal.any([connection.controller.signal, AbortSignal.timeout(timeout)]) }).then(target => {
          current(deviceId, connection);
          connection.expiresAt = Date.now() + 60_000;
          return target;
        }).catch(error => { connection.selection = null; throw error; });
      }
      const target = await new Promise((resolve, reject) => {
        const abort = () => { bounded.removeEventListener('abort', abort); reject(bounded.reason); };
        bounded.addEventListener('abort', abort, { once: true });
        if (bounded.aborted) abort();
        connection.selection.then(value => { bounded.removeEventListener('abort', abort); resolve(value); }, error => { bounded.removeEventListener('abort', abort); reject(error); });
      });
      bounded.throwIfAborted(); current(deviceId, connection);
      const routeKey = JSON.stringify([target.url, target.pin]);
      if (connection.routeKey !== routeKey || !connection.agent) {
        connection.agent?.destroy();
        connection.agent = remoteAgent(target, { maxSockets: 4, maxFreeSockets: 2 }); connection.routeKey = routeKey;
      }
      agent = connection.agent;
      const { value } = await request(target, '/link/api/rpc', input, { signal: bounded, agent });
      bounded.throwIfAborted(); current(deviceId, connection);
      if (saved.hostId && value?.hostId && saved.hostId !== value.hostId) throw fail('目标身份已变化，请重新配对', 'IDENTITY_CHANGED', 403);
      if (input.action === 'resources' && value?.available === false) throw fail('目标资源不可用', value.code || 'QUERY_FAILED');
      observe(deviceId, connection, order, 'online');
      return value;
    } catch (error) {
      signal?.throwIfAborted(); current(deviceId, connection);
      if (bounded.aborted && !connection.controller.signal.aborted) error = fail('连接超时', 'ETIMEDOUT');
      const failure = deviceConnectionFailure(error);
      observe(deviceId, connection, order, failure.status, failure.status === 'online' ? null : failure.reason);
      if (failure.status === 'offline' && order >= connection.observed && connection.agent === agent) { connection.agent?.destroy(); connection.agent = null; connection.selection = null; }
      if (order >= connection.observed && ['UNAUTHORIZED', 'IDENTITY_CHANGED'].includes(failure.code)) invalidate(deviceId);
      throw error;
    }
  };
  const resources = async (input = {}) => {
    const started = epoch;
    const page = resourcePage(input);
    const ids = [...new Set(input.deviceIds ?? (input.deviceId ? [input.deviceId] : devices().devices.map(row => row.id)))];
    if (ids.length > 33 || ids.some(id => typeof id !== 'string')) throw fail('设备查询范围无效', 'INVALID_RESOURCE_QUERY');
    input.signal?.throwIfAborted();
    const results = new Array(ids.length); let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (cursor < ids.length) {
        const index = cursor++, deviceId = ids[index], key = JSON.stringify([deviceId,page,input.projectId]);
        try {
          const queriedIdentity = deviceId === 'local' ? null : identity(registry.get(deviceId));
          let value;
          try { value = await callDevice({ deviceId, input: { action: 'resources', ...page, ...(input.projectId === undefined ? {} : { projectId: input.projectId }) }, signal: input.signal }); }
          catch (error) {
            // Older targets expose the same read-authorized facts through state.
            if (error.statusCode !== 400 || !/Unsupported Link action|不支持/.test(error.message)) throw error;
            if (page.kind === 'recent') throw fail('旧目标不支持最近候选语义', 'UNSUPPORTED', 422);
            value = projectResources(await callDevice({ deviceId, input: { action: 'state' }, signal: input.signal }), { ...page, projectId: input.projectId }, deviceId);
          }
          input.signal?.throwIfAborted();
          if (started !== epoch) throw new DOMException('资源服务已清理', 'AbortError');
          if (!value?.available || !Array.isArray(value.items)) throw fail(value?.reason || '目标资源不可用', value?.code || 'UNSUPPORTED');
          const saved = deviceId === 'local' ? null : registry.get(deviceId);
          if (saved && queriedIdentity !== identity(saved)) throw Object.assign(fail('设备身份已更新', 'IDENTITY_CHANGED', 409), { stale: true });
          if (saved?.hostId && value.hostId && saved.hostId !== value.hostId) throw fail('目标身份已变化，请重新配对', 'IDENTITY_CHANGED', 403);
          const projected = projectResources({ [page.kind === 'recent' ? 'sessions' : page.kind]: value.items.map(row => ({ ...row, id: row.resourceId ?? row.id })) }, { kind: page.kind, offset: 0, limit: page.limit }, deviceId);
          value = { deviceId, available: true, code: 'OK', reason: null, hostId: value.hostId, protocolVersion: value.protocolVersion, observedAt: Date.now(), items: projected.items, offset: page.offset, limit: page.limit, hasMore: value.hasMore === true, ...(Number.isSafeInteger(value.total) ? { total: value.total } : {}), freshness: 'fresh' };
          value.lastSuccessfulAt = value.observedAt;
          cache.set(key, value); if (cache.size > 128) cache.delete(cache.keys().next().value);
          results[index] = value;
        } catch (error) {
          input.signal?.throwIfAborted();
          if (started !== epoch) throw new DOMException('资源服务已清理', 'AbortError');
          let exists = deviceId === 'local'; try { if (!exists) exists = Boolean(registry.get(deviceId)); } catch {}
          const failure = deviceConnectionFailure(error), code = !exists ? 'NOT_FOUND' : failure.code;
          if (!error.stale && (code === 'NOT_FOUND' || deviceId === 'local' && ['UNAUTHORIZED', 'IDENTITY_CHANGED'].includes(code))) invalidate(deviceId);
          const prior = error.stale ? null : cache.get(key);
          results[index] = { ...(prior || page), deviceId, available: false, code, reason: code === 'NOT_FOUND' ? '设备已移除' : failure.reason, observedAt: prior?.observedAt ?? null, attemptedAt: Date.now(), freshness: prior ? 'stale' : 'unknown', items: prior?.items || [], hasMore: prior?.hasMore ?? false };
        }
      }
    }));
    return { devices: results, partial: results.some(row => !row.available) };
  };
  return { devices, resources, callDevice, invalidate, clear() { epoch++; for (const deviceId of connections.keys()) invalidate(deviceId); cache.clear(); } };
}
