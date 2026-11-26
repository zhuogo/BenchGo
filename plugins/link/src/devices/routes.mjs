import { normalizeRoutes, normalizeTarget } from './registry.mjs';
import { probeRemote, remoteJson } from './remote.mjs';

const unreachable = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET']);
const transient = new Set(['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']);
const gatewayUnavailable = new Set([502, 503, 504]);
const routePriority = (route, index) => Number.isInteger(route.priority) ? route.priority : index;
const cooling = (route, now) => Number.isInteger(route.cooldownUntil) && route.cooldownUntil > now;
const loopback = value => {
  const host = new URL(value).hostname;
  return host === 'localhost' || host === '[::1]' || /^127\./.test(host);
};
export function deviceIdentity(candidate, value) {
  const { hostId, authorizationId } = value ?? {};
  const known = [candidate.hostId, candidate.relayTarget, candidate.pin && 'sha256:' + candidate.pin,
    ...(candidate.routes?.filter(route => route.kind === 'direct').map(route => 'sha256:' + route.pin) ?? [])].filter(Boolean);
  if (hostId !== undefined && (typeof hostId !== 'string' || !/^sha256:[A-Za-z0-9+/]{43}=$/.test(hostId) || known.some(id => id !== hostId))
    || authorizationId !== undefined && (typeof authorizationId !== 'string' || !authorizationId || authorizationId.length > 256
      || candidate.authorizationId && candidate.authorizationId !== authorizationId)) {
    throw Object.assign(new Error('目标设备身份或配对授权已变化'), { code: 'IDENTITY_CHANGED', status: 409 });
  }
  const routes = normalizeRoutes(value?.routes);
  if (routes?.some(route => route.kind === 'direct' && 'sha256:' + route.pin !== hostId || route.relayTarget && route.relayTarget !== hostId)) {
    throw Object.assign(new Error('主机提供的连接路线与已配对身份不一致'), { code: 'IDENTITY_CHANGED', status: 409 });
  }
  return { hostId, authorizationId, routes };
}
export async function openRemoteWorkbench(candidate, { agent, groupAssetLease } = {}) {
  const expectedHostId = candidate.hostId || candidate.relayTarget || (candidate.pin ? 'sha256:' + candidate.pin : undefined);
  const { value, headers } = await remoteJson(candidate, '/link/api/workbench', {
    expectedHostId, expectedAuthorizationId: candidate.authorizationId, ...(groupAssetLease && { groupAssetLease: true }),
  }, { agent, timeout: 3500 });
  const cookie = headers['set-cookie']?.find(value => value.startsWith('dsh_link_workbench='));
  if (!cookie || value?.url !== '/link/workbench/' || !value.hostId || !value.authorizationId || groupAssetLease && value.groupAssetLease !== true) {
    throw Object.assign(new Error('请更新目标主机上的 BenchGo 以打开工作台'), { status: 409 });
  }
  return { ...deviceIdentity(candidate, value), cookie };
}
/** Stable route order: direct first, then relays by configured priority. */
export function orderRoutes(routes, now = Date.now()) {
  const direct = routes.map((route, index) => ({ route, index })).filter(({ route }) => route.kind === 'direct');
  const relay = routes.map((route, index) => ({ route, index }))
    .filter(({ route }) => route.kind === 'relay')
    .sort((a, b) => routePriority(a.route, a.index) - routePriority(b.route, b.index) || a.index - b.index);
  return [...direct, ...relay].filter(({ route }) => !cooling(route, now)).map(({ route }) => route);
}
/** Choose only among authenticated pairing candidates, before any business request is sent. */
export async function selectRoute(target, { timeout = 2500, signal, probe = probeRemote, accept, onHealth, connectFirst = false } = {}) {
  const routes = normalizeRoutes(target.routes);
  // Older pairings have one saved endpoint and retain their established trust policy.
  if (!routes?.length) {
    const candidate = { ...target, ...normalizeTarget(target) };
    if (target.ssh && !connectFirst) await probe(candidate, { timeout, signal });
    signal?.throwIfAborted();
    await accept?.(candidate);
    return candidate;
  }
  // A remote host's loopback names this client after crossing a relay/LAN.
  // Keep it only when pairing explicitly admitted that same local endpoint
  // (including the SSH tunnel); never probe another machine's advertised one.
  const admitted = normalizeTarget(target).url;
  const candidates = routes.filter(route => route.kind !== 'direct' || !loopback(route.url) || loopback(admitted) && route.url === admitted);
  const now = Date.now(), ordered = orderRoutes(candidates, now);
  if (target.pairedEndpointFallback === true && !target.pin && !loopback(admitted) && !candidates.some(route => route.kind === 'relay' && route.url === admitted)) {
    ordered.push({ kind: 'public', url: admitted, relayTarget: target.relayTarget });
  }
  const retryAt = Math.min(...candidates.filter(route => route.kind === 'relay' && cooling(route, now)).map(route => route.cooldownUntil));
  const recovering = () => Object.assign(new Error('中继连接正在恢复，请稍后重试或在设备中心检查连接'), { code: 'ROUTES_COOLDOWN', status: 503, retryAt });
  if (!ordered.length) {
    const error = Number.isFinite(retryAt)
      ? recovering()
      : Object.assign(new Error('目标未提供可用的设备连接地址，请在设备中心重新连接'), { code: 'OFFLINE' });
    throw error;
  }
  const attempts = [...ordered];
  const controller = new AbortController();
  const probeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const preflights = new Map();
  const preflight = (index, delay) => {
    const pending = preflights.get(index);
    if (pending) {
      if (!delay) pending.start();
      return pending.result;
    }
    const route = attempts[index];
    const { promise: result, resolve } = Promise.withResolvers();
    let timer, started = false;
    const start = () => {
      if (started) return;
      started = true;
      clearTimeout(timer);
      probeSignal.removeEventListener('abort', cancel);
      Promise.resolve().then(() => {
        probeSignal.throwIfAborted();
        return probe({ url: route.url, pin: route.kind === 'direct' ? route.pin : '' }, { timeout, signal: probeSignal });
      }).then(() => resolve(null), resolve);
    };
    const cancel = () => { clearTimeout(timer); resolve(probeSignal.reason); };
    preflights.set(index, { result, start });
    if (delay) {
      timer = setTimeout(start, delay);
      probeSignal.addEventListener('abort', cancel, { once: true });
    } else start();
    return result;
  };
  let lastError, retryQueued = false;
  try {
    for (let index = 0; index < attempts.length; index++) {
      signal?.throwIfAborted();
      const route = attempts[index];
      const candidate = { ...target, url: route.url, pin: route.kind === 'direct' ? route.pin : '', relayTarget: route.relayTarget };
      const needsProbe = !connectFirst || index > 0;
      const current = needsProbe ? preflight(index) : null;
      for (let offset = 1; offset <= 2 && index + offset < ordered.length; offset++) preflight(index + offset, 100 * offset);
      try {
        if (current) {
          const error = await current;
          if (error) throw error;
        }
        signal?.throwIfAborted();
        await accept?.(candidate, route.kind === 'public' ? undefined : route);
        signal?.throwIfAborted();
      } catch (error) {
        signal?.throwIfAborted();
        const status = error.statusCode ?? error.status;
        if ([401, 403].includes(status) || !unreachable.has(error.code) && !gatewayUnavailable.has(status)) throw error;
        lastError = error;
        if (!retryQueued && route.kind === 'relay' && transient.has(error.code)) { retryQueued = true; attempts.push(route); continue; }
        if (route.kind === 'relay') await onHealth?.(route, 'unhealthy', { cooldownUntil: Date.now() + 10_000, lastError: error.message });
        continue;
      }
      if (route.kind === 'relay') await onHealth?.(route, 'healthy', { cooldownUntil: 0, lastError: null });
      return candidate;
    }
  } finally {
    controller.abort();
  }
  if (retryAt > Date.now() && Number.isFinite(retryAt)) throw recovering();
  throw lastError;
}
