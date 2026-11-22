import { Agent, request } from 'node:https';
import { connect } from 'node:tls';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
export const relayTargetHeaders = target => target.relayTarget ? { 'x-benchgo-relay-target': target.relayTarget } : {};
// An SSH tunnel changes the socket destination while Link still admits its own HTTP origin.
export function upstreamOrigin(target) {
  const tunnel = new URL(target.url);
  const port = target.ssh?.remotePort;
  return target.kind === 'ssh' && tunnel.hostname === '127.0.0.1' && Number.isInteger(port) && port > 0 && port <= 65535
    ? new URL(`https://127.0.0.1:${port}`).origin : tunnel.origin;
}
function verifyPinnedPeer(socket, pin) {
  const cert = socket.getPeerCertificate(true);
  const validFrom = Date.parse(cert.valid_from), validTo = Date.parse(cert.valid_to);
  if (!cert.pubkey || !Number.isFinite(validFrom) || !Number.isFinite(validTo) || validFrom >= validTo) {
    throw Object.assign(new Error('无法读取有效的主机证书'), { code: 'ERR_LINK_CERTIFICATE' });
  }
  const expected = Buffer.from(pin, 'base64');
  const actual = createHash('sha256').update(cert.pubkey).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Object.assign(new Error('主机公钥与保存的指纹不一致'), { code: 'ERR_LINK_CERTIFICATE' });
  const now = Date.now();
  if (validFrom > now) throw Object.assign(new Error('主机证书尚未生效，请同步本机与服务器的系统时间后重试'), { code: 'ERR_LINK_CERTIFICATE' });
  if (validTo <= now) throw Object.assign(new Error('主机证书已过期，请检查本机与服务器的系统时间及 Link 证书'), { code: 'ERR_LINK_CERTIFICATE' });
}
/** TLS-only reachability check: no HTTP bytes, bearer tokens or cookies leave the client. */
export function probeRemote(target, { timeout = 2500, signal } = {}) {
  const url = new URL(target.url), host = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port: Number(url.port || 443), servername: isIP(host) ? undefined : host, rejectUnauthorized: !target.pin, signal });
    let finished = false;
    const finish = error => { if (finished) return; finished = true; socket.destroy(); error ? reject(error) : resolve(); };
    socket.once('error', finish);
    socket.setTimeout(timeout, () => finish(Object.assign(new Error('连接超时，请检查主机是否在线'), { code: 'ETIMEDOUT' })));
    socket.once('secureConnect', () => {
      try { if (target.pin) verifyPinnedPeer(socket, target.pin); finish(); } catch (error) { finish(error); }
    });
  });
}
/** Verify pinned self-signed peers before sending HTTP bytes or credentials. */
export function remoteAgent(target, { maxSockets = 64, maxFreeSockets = 2 } = {}) {
  const agent = new Agent({ keepAlive: true, maxSockets, maxFreeSockets });
  const endpoint = new URL(target.url);
  const tunnel = upstreamOrigin(target) !== endpoint.origin ? endpoint : null;
  if (tunnel && !target.pin) throw new Error('缺少 SSH 隧道的主机公钥指纹');
  if (target.pin) agent.createConnection = (options, callback) => {
    const socket = connect({ ...options, ...(tunnel && { host: tunnel.hostname, port: Number(tunnel.port || 443) }), rejectUnauthorized: false, servername: undefined });
    const error = value => { socket.destroy(); callback(value); };
    socket.once('error', error);
    socket.once('secureConnect', () => {
      try {
        verifyPinnedPeer(socket, target.pin);
        socket.removeListener('error', error); callback(null, socket);
      } catch (reason) { error(reason); }
    });
    return undefined;
  };
  return agent;
}
export function remoteJson(target, path, input, { agent, token = target.authorize?.() ?? target.token, signal, timeout = 20000 } = {}) {
  const own = !agent; agent ??= remoteAgent(target);
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, upstreamOrigin(target)), { method: input === undefined ? 'GET' : 'POST', agent, signal, timeout, headers: { ...relayTargetHeaders(target), ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: 'Bearer ' + token } : {}) } }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) req.destroy(new Error('主机响应过大')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch (error) { if (res.statusCode < 400) { reject(error); return; } }
        if (res.statusCode >= 400) {
          reject(Object.assign(new Error(value?.error || '主机返回 HTTP ' + res.statusCode), { statusCode: res.statusCode, status: res.statusCode, code: value?.code }));
          return;
        }
        resolve({ value, headers: res.headers });
      });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(Object.assign(new Error('连接超时，请检查主机是否在线'), { code: 'ETIMEDOUT' })));
    req.end(JSON.stringify(input));
  }).finally(() => { if (own) agent.destroy(); });
}
