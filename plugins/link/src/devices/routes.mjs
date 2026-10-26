import { normalizeRoutes, normalizeTarget } from './registry.mjs';
import { probeRemote } from './remote.mjs';

const unreachable = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET']);
const routePriority = (route, index) => Number.isInteger(route.priority) ? route.priority : index;
const cooling = (route, now) => Number.isInteger(route.cooldownUntil) && route.cooldownUntil > now;
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
  const now = Date.now(), ordered = orderRoutes(routes, now);
  if (!ordered.length) {
    const retryAt = Math.min(...routes.filter(route => route.kind === 'relay').map(route => route.cooldownUntil).filter(Number.isInteger));
    const error = Object.assign(new Error('所有中继路线正在冷却，请稍后重试'), { code: 'ROUTES_COOLDOWN', retryAt });
    throw error;
  }
  let lastError;
  for (const route of ordered) {
    signal?.throwIfAborted();
    const candidate = { ...target, url: route.url, pin: route.kind === 'direct' ? route.pin : '' };
    try { await probe({ url: candidate.url, pin: candidate.pin }, { timeout, signal }); if (route.kind === 'relay') await onHealth?.(route, 'healthy', { cooldownUntil: 0, lastError: null }); return candidate; }
    catch (error) {
      if (!unreachable.has(error.code) || error.statusCode === 401 || error.statusCode === 403) throw error;
      lastError = error;
      if (route.kind === 'relay') await onHealth?.(route, 'unhealthy', { cooldownUntil: Date.now() + 10_000, lastError: error.message });
    }
  }
  throw lastError;
}
