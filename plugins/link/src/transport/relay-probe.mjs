import { request } from 'node:https';
import { connect } from 'node:tls';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { RELAY_PROBE_PATH, RELAY_PROTOCOL, RELAY_PROTOCOL_VERSION } from './relay-protocol.mjs';

/** Authenticated read-only probe and public ALPN check; never registers a host. */
export async function testRelayConnection({ url, token }, { timeout = 5_000, ca } = {}) {
  const started = performance.now();
  const result = (ok, message) => ({ ok, latencyMs: Math.round(performance.now() - started), message });
  let origin;
  try { origin = new URL(url); } catch { return result(false, '中继地址无效'); }
  if (origin.protocol !== 'https:' || origin.origin !== url || origin.username || origin.password) return result(false, '中继必须使用独立 HTTPS origin');
  if (typeof token !== 'string' || token.length < 6 || token.length > 256 || /[\r\n]/.test(token)) return result(false, '中继主机密钥无效，至少需要 6 个字符');
  try {
    const response = await new Promise((resolve, reject) => {
      let timer;
      const req = request(new URL(RELAY_PROBE_PATH, origin), { method: 'GET', agent: false, ...(ca ? { ca } : {}), headers: { authorization: 'Bearer ' + token, accept: 'application/json' } }, res => {
        let bytes = 0; const chunks = [];
        res.on('data', chunk => { bytes += chunk.length; if (bytes > 4096) req.destroy(Object.assign(new Error('response too large'), { code: 'RELAY_PROTOCOL' })); else chunks.push(chunk); });
        res.once('error', reject);
        res.once('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks).toString() }));
      });
      timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'RELAY_TIMEOUT' })), timeout);
      timer.unref?.();
      const clear = () => clearTimeout(timer);
      req.once('error', reject); req.once('close', clear); req.end();
    });
    if ([401, 403].includes(response.status)) return result(false, '中继拒绝认证，请检查主机密钥和中继地址');
    if (response.status === 404) return result(false, '中继不支持连接测试，请更新中继服务');
    let value; try { value = JSON.parse(response.body); } catch {}
    if (response.status !== 200 || !response.type?.startsWith('application/json') || value?.protocol !== RELAY_PROTOCOL || value?.version !== RELAY_PROTOCOL_VERSION || value?.authenticated !== true) return result(false, '中继协议验证失败，请检查地址或更新中继服务');
    const remaining = timeout - (performance.now() - started);
    if (remaining <= 0) throw Object.assign(new Error('timeout'), { code: 'RELAY_TIMEOUT' });
    // Probe the browser-facing origin, not the relay's potentially H2-capable
    // upstream. H1-only proxies can strand navigation behind persistent streams.
    const alpn = await new Promise((resolve, reject) => {
      const host = origin.hostname.replace(/^\[|\]$/g, '');
      const socket = connect({ host, port: Number(origin.port || 443), servername: isIP(host) ? undefined : host,
        rejectUnauthorized: true, ...(ca ? { ca } : {}), ALPNProtocols: ['h2', 'http/1.1'] });
      const timer = setTimeout(() => socket.destroy(Object.assign(new Error('timeout'), { code: 'RELAY_TIMEOUT' })), remaining);
      timer.unref?.();
      socket.once('secureConnect', () => { const protocol = socket.alpnProtocol; socket.destroy(); resolve(protocol); });
      socket.once('error', reject);
      socket.once('close', () => { clearTimeout(timer); reject(new Error('TLS connection closed')); });
    });
    if (alpn !== 'h2') return result(false, '公网入口未启用 HTTP/2，请在最外层反向代理启用 HTTP/2，避免工作台长连接阻塞聊天');
    return { ...result(true, '中继协议、主机密钥和 HTTP/2 验证通过'), multipleHosts: value.multipleHosts === true };
  } catch (error) {
    if (error.code === 'RELAY_TIMEOUT') return result(false, '连接测试超时，请检查中继地址和网络');
    if (/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code || '')) return result(false, '中继 TLS 证书验证失败');
    return result(false, '无法连接中继，请检查地址、端口和网络');
  }
}
