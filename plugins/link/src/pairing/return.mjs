import { normalizeRoutes, normalizeTarget } from '../devices/registry.mjs';
import { remoteAgent, remoteJson } from '../devices/remote.mjs';
import { selectRoute } from '../devices/routes.mjs';
import { PAIRED_DEVICE_CAPABILITIES, sameSecret, text } from './store.mjs';

export const PAIR_RETURN_VERSION = 1;
export function validReturnTarget({ url }) {
  const host = new URL(url).hostname;
  return !['localhost', '[::1]', '[::]', '0.0.0.0'].includes(host) && !/^127\./.test(host) && !/^\[::ffff:7f/i.test(host);
}

export function normalizeReturnOffer(input) {
  if (input?.version !== PAIR_RETURN_VERSION) return undefined;
  const { hostId, proof } = input;
  const routes = normalizeRoutes(input.routes);
  const target = normalizeTarget(input.target);
  if (typeof hostId !== 'string' || !/^sha256:[A-Za-z0-9+/]{43}=$/.test(hostId)
    || !routes || [target, ...routes].some(route => !validReturnTarget(route) || route.pin && 'sha256:' + route.pin !== hostId)
    || typeof proof?.id !== 'string' || !/^[a-f0-9-]{36}$/.test(proof.id)
    || typeof proof.digest !== 'string' || !/^[a-f0-9]{64}$/.test(proof.digest)) throw new Error('回程连接信息无效');
  return { hostId, proof: { id: proof.id, digest: proof.digest }, target, routes };
}

export function returnCredential(input) {
  if (input === null) return null;
  return { token: text(input?.token, '回程授权', 256), deviceId: text(input?.deviceId, '回程设备 ID', 200) };
}

export async function verifyReturnRoute(offer, credential) {
  const { target, routes, hostId, proof } = offer;
  const signal = AbortSignal.timeout(8_000);
  const verify = async (route, signal) => {
    const agent = remoteAgent(route);
    try {
      const query = new URLSearchParams({ returnProof: proof.id });
      const { value } = await remoteJson(route, '/link/api/info?' + query, undefined, { agent, signal, timeout: 2_000 });
      if (!sameSecret(value.proof, proof.digest)) throw new Error('回程主机证明无效');
      const { value: admitted } = await remoteJson(route, '/link/api/info', undefined, { agent, token: credential.token, signal, timeout: 2_000 });
      if (admitted.hostId !== hostId || admitted.authorizationId !== credential.deviceId) throw new Error('回程主机或授权身份不一致');
      const routes = normalizeRoutes(admitted.routes);
      if (routes?.some(candidate => candidate.kind === 'direct' && 'sha256:' + candidate.pin !== hostId)) throw new Error('回程连接路线身份不一致');
      return { ...route, routes, pairedEndpointFallback: !route.pin, hostId, token: credential.token, authorizationId: credential.deviceId, capabilities: [...PAIRED_DEVICE_CAPABILITIES], kind: 'computer' };
    } finally { agent.destroy(); }
  };
  let verified;
  if (routes.length) {
    const alternates = AbortSignal.any([signal, AbortSignal.timeout(6_000)]);
    try {
      await selectRoute({ ...target, routes }, { signal: alternates, timeout: 1_500, accept: async candidate => {
        try { verified = await verify({ url: candidate.url, pin: candidate.pin }, alternates); }
        catch { throw Object.assign(new Error('回程路线不可达'), { code: 'ECONNREFUSED' }); }
      } });
    } catch { /* Try the advertised connection address when alternate routes fail. */ }
  }
  if (!verified && !signal.aborted) {
    try { verified = await verify(target, signal); } catch { return undefined; }
  }
  return verified;
}
