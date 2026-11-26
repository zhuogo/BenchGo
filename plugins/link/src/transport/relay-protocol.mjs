export const RELAY_CONTROL_PATH = '/__link/relay/control';
export const RELAY_PROBE_PATH = '/__link/relay/probe';
export const RELAY_PROTOCOL = 'benchgo-link-relay';
export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_DATA_PATH = '/__link/relay/data';
export const RELAY_WORKBENCH_PATH = '/link/workbench/';
export const RELAY_VOICE_PATH = '/link/workbench/api/voice/realtime';
export const RELAY_CHUNK_BYTES = 48 * 1024;
export const RELAY_HTTP_REUSE_HEADER = 'x-benchgo-relay-http-reuse';
export const relayHostClaim = (origin, id, expires, nonce) => JSON.stringify(['benchgo-relay-host-v1', origin, id, expires, nonce]);

// Each HTTP direction awaits its writes before reading more body data.
export function sendRelayFrame(socket, value, options = {}) {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== socket.OPEN) return reject(new Error('中继数据通道已关闭'));
    socket.send(value, options, error => error ? reject(error) : resolve());
  });
}

export function relayPathAllowed(method, path) {
  if (typeof method !== 'string' || typeof path !== 'string') return false;
  const pathname = path.split('?')[0];
  if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname.includes('\\') || /%(?:2f|5c|00)/i.test(pathname)) return false;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  if (decoded.split('/').some(part => part === '.' || part === '..')) return false;
  if (pathname === '/link/api/info') return method === 'GET';
  if (['/link/api/pair', '/link/api/pair/status', '/link/api/rpc', '/link/api/workbench'].includes(pathname)) return method === 'POST';
  if (['/link', '/link/', '/link/index.html', '/link/app.js', '/link/app.css'].includes(pathname)) return method === 'GET' || method === 'HEAD';
  if (!pathname.startsWith(RELAY_WORKBENCH_PATH) || !['GET', 'HEAD', 'POST'].includes(method)) return false;
  const route = pathname.slice(RELAY_WORKBENCH_PATH.length);
  return !/^(?:api\/commander-(?:link|devices)|api\/(?:owner|admin)(?:\/|$))/i.test(route);
}
