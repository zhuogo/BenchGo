import { normalizeRoutes, normalizeTarget } from './registry.mjs';
import { probeRemote } from './remote.mjs';

const unreachable = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET']);
const transient = new Set(['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']);
const routePriority = (route, index) => Number.isInteger(route.priority) ? route.priority : index;
const cooling = (route, now) => Number.isInteger(route.cooldownUntil) && route.cooldownUntil > now;
const loopback = value => {
  const host = new URL(value).hostname;
  return host === 'localhost' || host === '[::1]' || /^127\./.test(host);
};
/** Stable route order: direct first, then relays by configured priority. */
export function orderRoutes(routes, now = Date.now()) {
  const direct = routes.map((route, index) => ({ route, index })).filter(({ route }) => route.kind === 'direct');
  const relay = routes.map((route, index) => ({ route, index }))
    .filter(({ route }) => route.kind === 'relay')
    .sort((a, b) => routePriority(a.route, a.index) - routePriority(b.route, b.index) || a.index - b.index);
  return [...direct, ...relay].filter(({ route }) => !cooling(route, now)).map(({ route }) => route);
}
/** Choose only among authenticated pairing candidates, before any business request is sent. */
export async function selectRoute(target, { timeout = 2500, signal, probe = probeRemote, onHealth } = {}) {
  const routes = normalizeRoutes(target.routes);
  // Older pairings have one saved endpoint and retain their established trust policy.
  if (!routes?.length) return { ...target, ...normalizeTarget(target) };
  // A remote host's loopback names this client after crossing a relay/LAN.
  // Keep it only when pairing explicitly admitted that same local endpoint
  // (including the SSH tunnel); never probe another machine's advertised one.
  const admitted = normalizeTarget(target).url;
  const candidates = routes.filter(route => route.kind !== 'direct' || !loopback(route.url) || loopback(admitted) && route.url === admitted);
  const now = Date.now(), ordered = orderRoutes(candidates, now);
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
    try { await probe({ url: candidate.url, pin: candidate.pin }, { timeout, signal }); if (route.kind === 'relay') await onHealth?.(route, 'healthy', { cooldownUntil: 0, lastError: null }); return candidate; }
    catch (error) {
      signal?.throwIfAborted();
      if (!unreachable.has(error.code) || [401, 403].includes(error.statusCode ?? error.status)) throw error;
      lastError = error;
      // Try other admitted routes first, then retry one transient relay TLS probe.
      // No business request or authorization credentials are sent by this probe.
      if (!retryQueued && route.kind === 'relay' && transient.has(error.code)) { retryQueued = true; attempts.push(route); continue; }
      if (route.kind === 'relay') await onHealth?.(route, 'unhealthy', { cooldownUntil: Date.now() + 10_000, lastError: error.message });
    }
  }
  if (retryAt > Date.now() && Number.isFinite(retryAt)) throw recovering();
  throw lastError;
}
