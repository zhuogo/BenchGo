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
  const known = [candidate.hostId, candidate.pin && 'sha256:' + candidate.pin,
    ...(candidate.routes?.filter(route => route.kind === 'direct').map(route => 'sha256:' + route.pin) ?? [])].filter(Boolean);
  if (hostId !== undefined && (typeof hostId !== 'string' || !/^sha256:[A-Za-z0-9+/]{43}=$/.test(hostId) || known.some(id => id !== hostId))
    || authorizationId !== undefined && (typeof authorizationId !== 'string' || !authorizationId || authorizationId.length > 256
      || candidate.authorizationId && candidate.authorizationId !== authorizationId)) {
    throw Object.assign(new Error('目标设备身份或配对授权已变化'), { code: 'IDENTITY_CHANGED', status: 409 });
  }
  const routes = normalizeRoutes(value?.routes);
  if (routes?.some(route => route.kind === 'direct' && 'sha256:' + route.pin !== hostId)) {
    throw Object.assign(new Error('主机提供的连接路线与已配对身份不一致'), { code: 'IDENTITY_CHANGED', status: 409 });
  }
  return { hostId, authorizationId, routes };
}
export async function readDeviceInfo(candidate, { signal } = {}) {
  const { value } = await remoteJson(candidate, '/link/api/info', undefined, { signal, timeout: 3500 });
  return deviceIdentity(candidate, value);
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
export async function selectRoute(target, { timeout = 2500, signal, probe = probeRemote, accept, onHealth } = {}) {
  const routes = normalizeRoutes(target.routes);
  // Older pairings have one saved endpoint and retain their established trust policy.
  if (!routes?.length) {
    const candidate = { ...target, ...normalizeTarget(target) };
    if (target.ssh) await probe(candidate, { timeout, signal });
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
    ordered.push({ kind: 'public', url: admitted });
  }
  const retryAt = Math.min(...candidates.filter(route => route.kind === 'relay' && cooling(route, now)).map(route => route.cooldownUntil));
  const recovering = () => Object.assign(new Error('中继连接正在恢复，请稍后重试或在设备中心检查连接'), { code: 'ROUTES_COOLDOWN', status: 503, retryAt });
  if (!ordered.length) {
    const error = Number.isFinite(retryAt)
      ? recovering()
      : Object.assign(new Error('目标未提供可用的设备连接地址，请在设备中心重新连接'), { code: 'OFFLINE' });
    throw error;
  }
  let lastError, retryQueued = false;
  const attempts = [...ordered];
  for (const route of attempts) {
    signal?.throwIfAborted();
    const candidate = { ...target, url: route.url, pin: route.kind === 'direct' ? route.pin : '' };
    try {
      await probe({ url: candidate.url, pin: candidate.pin }, { timeout, signal });
      await accept?.(candidate, route.kind === 'public' ? undefined : route);
    }
    catch (error) {
      signal?.throwIfAborted();
      const status = error.statusCode ?? error.status;
      if ([401, 403].includes(status) || !unreachable.has(error.code) && !gatewayUnavailable.has(status)) throw error;
      lastError = error;
      // Try other admitted routes first, then retry one transient connection check.
      if (!retryQueued && route.kind === 'relay' && transient.has(error.code)) { retryQueued = true; attempts.push(route); continue; }
      if (route.kind === 'relay') await onHealth?.(route, 'unhealthy', { cooldownUntil: Date.now() + 10_000, lastError: error.message });
      continue;
    }
    if (route.kind === 'relay') await onHealth?.(route, 'healthy', { cooldownUntil: 0, lastError: null });
    return candidate;
  }
  if (retryAt > Date.now() && Number.isFinite(retryAt)) throw recovering();
  throw lastError;
}
