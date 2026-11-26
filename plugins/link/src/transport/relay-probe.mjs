import { request } from 'node:http';
import { connect as connectHttp2 } from 'node:http2';
import { connect } from 'node:tls';
import { once } from 'node:events';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { RELAY_PROBE_PATH, RELAY_PROTOCOL, RELAY_PROTOCOL_VERSION } from './relay-protocol.mjs';

async function readResponse(stream, status, type) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > 4096) throw Object.assign(new Error('response too large'), { code: 'RELAY_PROTOCOL' });
    chunks.push(chunk);
  }
  return { status, type, body: Buffer.concat(chunks).toString() };
}

/** Authenticated read-only probe and public ALPN check; never registers a host. */
export async function testRelayConnection({ url, token }, { timeout = 5_000, ca } = {}) {
  const started = performance.now();
  const result = (ok, message) => ({ ok, latencyMs: Math.round(performance.now() - started), message });
  let origin;
  try { origin = new URL(url); } catch { return result(false, '中继地址无效'); }
  if (origin.protocol !== 'https:' || origin.origin !== url || origin.username || origin.password) return result(false, '中继必须使用独立 HTTPS origin');
  if (typeof token !== 'string' || token.length < 6 || token.length > 256 || /[\r\n]/.test(token)) return result(false, '中继主机密钥无效，至少需要 6 个字符');
  const signal = AbortSignal.timeout(timeout);
  let socket, session;
  try {
    const host = origin.hostname.replace(/^\[|\]$/g, '');
    socket = connect({ host, port: Number(origin.port || 443), servername: isIP(host) ? undefined : host,
      rejectUnauthorized: true, ...(ca ? { ca } : {}), ALPNProtocols: ['h2', 'http/1.1'], signal });
    await once(socket, 'secureConnect', { signal });
    const h2 = socket.alpnProtocol === 'h2';
    const headers = { authorization: 'Bearer ' + token, accept: 'application/json' };
    let response;
    if (h2) {
      session = connectHttp2(origin, { createConnection: () => socket });
      session.on('error', () => {});
      const stream = session.request({ ':path': RELAY_PROBE_PATH, ...headers }, { signal });
      const [reply] = await once(stream, 'response', { signal });
      response = await readResponse(stream, reply[':status'], reply['content-type']);
    } else {
      response = await new Promise((resolve, reject) => {
        const req = request({ host, path: RELAY_PROBE_PATH, headers: { ...headers, host: origin.host }, signal, createConnection: () => socket }, res => {
          readResponse(res, res.statusCode, res.headers['content-type']).then(resolve, reject);
        });
        req.once('error', reject);
        req.end();
      });
    }
    if ([401, 403].includes(response.status)) return result(false, '中继拒绝认证，请检查主机密钥和中继地址');
    if (response.status === 404) return result(false, '中继不支持连接测试，请更新中继服务');
    let value; try { value = JSON.parse(response.body); } catch {}
    if (response.status !== 200 || !response.type?.startsWith('application/json') || value?.protocol !== RELAY_PROTOCOL || value?.version !== RELAY_PROTOCOL_VERSION || value?.authenticated !== true) return result(false, '中继协议验证失败，请检查地址或更新中继服务');
    if (!h2) return result(false, '公网入口未启用 HTTP/2，请在最外层反向代理启用 HTTP/2，避免工作台长连接阻塞聊天');
    return { ...result(true, '中继协议、主机密钥和 HTTP/2 验证通过'), multipleHosts: value.multipleHosts === true };
  } catch (error) {
    if (signal.aborted) return result(false, '连接测试超时，请检查中继地址和网络');
    if (error.code === 'RELAY_PROTOCOL') return result(false, '中继协议验证失败，请检查地址或更新中继服务');
    if (/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code || '')) return result(false, '中继 TLS 证书验证失败');
    return result(false, '无法连接中继，请检查地址、端口和网络');
  } finally {
    session?.destroy();
    socket?.destroy();
  }
}
