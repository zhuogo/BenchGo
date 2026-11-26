import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { request } from 'node:https';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { remoteAgent, relayTargetHeaders, upstreamOrigin } from './remote.mjs';
import { openRemoteWorkbench } from './routes.mjs';
const secret = () => randomBytes(32).toString('base64url');
const WORKBENCH = '/link/workbench/';
const legacyAuthError = JSON.stringify({ error: '设备授权已失效，请重新配对' });
const statePaths = new Set([WORKBENCH + 'api/commander', WORKBENCH + 'api/commander/assistant']);
const isStateRequest = body => {
  try {
    const value = JSON.parse(body);
    return value?.action === 'state' && Object.keys(value).length === 1;
  } catch { return false; }
};
/** Each host has its own origin. Remote scripts cannot read the device centre. */
export async function createDeviceProxy(target, { parentOrigin, onFailure, onSuccess, webRoot, publicOrigin, publicPrefix = '', workbenchLease } = {}) {
  const agent = remoteAgent(target), tickets = new Map(), sessions = new Set(), sockets = new Set();
  const remoteOrigin = upstreamOrigin(target);
  let origin, remoteCookie, closed = false, leaseUntil = 0, renewing, admission;
  let recoveryError, recoveryAfter = 0;
  const upstream = async () => {
    if (workbenchLease) {
      if (leaseUntil > Date.now()) return;
      renewing ??= Promise.resolve(remoteCookie ? workbenchLease() : target).then(lease => {
        if (lease.url !== target.url || lease.pin !== target.pin || lease.relayTarget !== target.relayTarget || lease.hostId !== target.hostId)
          throw new Error('共享工作台路线已更新，请重新连接');
        remoteCookie = lease.cookie.split(';')[0];
        leaseUntil = Date.now() + 55_000;
        recoveryError = undefined;
        recoveryAfter = 0;
      }).finally(() => { renewing = undefined; });
      return renewing;
    }
    const candidate = admission ? { ...target, hostId: admission.hostId, authorizationId: admission.authorizationId } : target;
    renewing ??= openRemoteWorkbench(candidate, { agent }).then(({ cookie, ...info }) => {
      remoteCookie = cookie.split(';', 1)[0];
      admission = info;
      recoveryError = undefined;
      recoveryAfter = 0;
    }).finally(() => { renewing = undefined; });
    return renewing;
  };
  const recover = async cookie => {
    if (closed) return false;
    if (cookie !== remoteCookie) return true;
    if (Date.now() < recoveryAfter) return false;
    if (workbenchLease) leaseUntil = 0;
    try { await upstream(); return !closed; }
    catch (error) {
      recoveryError = error;
      recoveryAfter = Date.now() + 5000;
      return false;
    }
  };
  try { await upstream(); }
  catch (error) { agent.destroy(); throw error; }
  const server = createServer(async (req, res) => {
    try {
      if (closed || req.headers.host !== new URL(origin).host) throw Object.assign(new Error('设备连接地址无效'), { status: 403 });
      const url = new URL(req.url, origin);
      if (url.pathname === '/enter' && req.method === 'GET') {
        const ticket = url.searchParams.get('ticket'), expires = tickets.get(ticket);
        tickets.delete(ticket);
        if (!expires || expires < Date.now()) throw Object.assign(new Error('工作台入口已过期，请重新选择设备'), { status: 401 });
        const token = sessions.values().next().value || secret(); sessions.add(token);
        if (sessions.size > 16) sessions.delete(sessions.values().next().value);
        res.writeHead(303, { location: publicPrefix + '/s/' + token + '/link/workbench/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); return;
      }
      const match = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{43})(\/.*)$/);
      if (!match || !sessions.has(match[1]) || req.headers.origin && req.headers.origin !== origin) throw Object.assign(new Error('设备工作台未授权'), { status: 403 });
      const prefix = publicPrefix + '/s/' + match[1]; url.pathname = match[2];
      if (url.pathname === '/local-proxy.js' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end('globalThis.__DSH_LINK_LOCAL_PROXY__=true;'); return; }
      if (webRoot && url.pathname === '/link/workbench/workbench.js' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(await readFile(new URL('workbench.js', webRoot))); return; }
      if (!url.pathname.startsWith('/link/workbench/') || !['GET', 'HEAD', 'POST'].includes(req.method)) throw Object.assign(new Error('路径未授权'), { status: 403 });
      if (workbenchLease) await upstream();
      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined && !['cookie','authorization','host','origin','referer','connection','upgrade','sec-websocket-key','sec-websocket-version','x-benchgo-relay-target'].includes(key)) headers[key] = value;
      Object.assign(headers, relayTargetHeaders(target));
      // Only static assets pass through unchanged. HTML must remain decodable for path/CSP rewriting.
      const staticAsset = url.pathname.startsWith('/link/workbench/plugins/') || url.pathname.startsWith('/link/workbench/assets/');
      headers['accept-encoding'] = staticAsset ? req.headers['accept-encoding'] || 'identity' : 'identity'; headers.origin = remoteOrigin;
      const bodyLength = Number(req.headers['content-length']);
      let body;
      if (req.method === 'POST' && statePaths.has(url.pathname) && bodyLength > 0 && bodyLength <= 256
        && req.headers['content-type']?.startsWith('application/json')) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = Buffer.concat(chunks);
      }
      const streamedBody = !body && (req.method === 'POST' || bodyLength > 0 || req.headers['transfer-encoding']);
      const retryable = !streamedBody && (req.method !== 'POST' || isStateRequest(body));
      const forward = (cookie, retried = false) => {
        if (res.destroyed) return;
        const remote = request(new URL(url.pathname + url.search, remoteOrigin), { agent, method: req.method, headers: { ...headers, cookie } }, response => {
          void sendResponse(response, cookie, retried).catch(error => res.destroy(error));
        });
        remote.on('error', error => { onFailure?.(error); if (res.headersSent) res.destroy(); else { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('主机暂时不可达，请返回设备列表重试'); } });
        remote.setTimeout(90000, () => remote.destroy(Object.assign(new Error('工作台响应超时'), { code: 'ETIMEDOUT' })));
        res.once('close', () => { if (!res.writableEnded) remote.destroy(); });
        if (streamedBody) req.pipe(remote);
        else remote.end(body);
      };
      const sendResponse = async (response, cookie, retried) => {
        response.on('error', error => res.destroy(error));
        let rejectedBody;
        const status = response.statusCode;
        const entry = url.pathname === WORKBENCH || url.pathname === WORKBENCH + 'index.html';
        let rejectedSession = entry && status === 303 && response.headers.location === '/link/';
        // Older peers report an invalid workbench cookie in the JSON body. Keep
        // application-level 401s intact, including those returned by tool routes.
        if (!retried && status === 401) {
          rejectedSession = response.headers['x-benchgo-workbench-session'] === 'expired';
          if (!rejectedSession && String(response.headers['content-type']).startsWith('application/json')) {
            const chunks = [];
            let bytes = 0;
            for await (const chunk of response.iterator({ destroyOnReturn: false })) {
              chunks.push(chunk); bytes += chunk.length;
              if (bytes > 4096) break;
            }
            rejectedBody = Buffer.concat(chunks);
            rejectedSession = response.readableEnded && rejectedBody.toString() === legacyAuthError;
          }
        }
        if (rejectedSession && !retried) {
          const recovered = await recover(cookie);
          if (res.destroyed) { response.resume(); return; }
          if (recovered) {
            response.resume();
            if (retryable) { forward(remoteCookie, true); return; }
            res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ error: '工作台连接已恢复，请重试本次操作' }));
            return;
          }
          if (recoveryError && recoveryError.status !== 401) {
            response.resume();
            res.writeHead(recoveryError.status || 502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ error: recoveryError.message }));
            return;
          }
        }
        if (status >= 200 && status < 300 && url.pathname === WORKBENCH + 'disconnect' && req.method === 'POST') {
          sessions.delete(match[1]);
        }
        if (status >= 200 && status < 400 && !rejectedSession) onSuccess?.();
        const outgoing = { ...response.headers, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
        delete outgoing['set-cookie']; delete outgoing['x-frame-options']; delete outgoing['strict-transport-security'];
        if (outgoing['content-security-policy']) outgoing['content-security-policy'] = outgoing['content-security-policy'].replace(/frame-ancestors[^;]*/g, "frame-ancestors 'self' " + parentOrigin + ' dsh-app:');
        if (response.statusCode >= 300 && response.statusCode < 400) {
          const location = new URL(response.headers.location || '/', remoteOrigin);
          if (location.origin !== remoteOrigin || !location.pathname.startsWith('/link/workbench/')) {
            response.resume(); res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end('设备授权已失效，请返回设备列表重新连接'); return;
          }
          outgoing.location = prefix + location.pathname + location.search;
        }
        if (String(outgoing['content-type']).startsWith('text/html')) {
          const chunks = []; let bytes = 0;
          response.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) response.destroy(new Error('工作台页面过大')); else chunks.push(chunk); });
          response.on('end', () => { if (res.destroyed) return; let html = Buffer.concat(chunks).toString().replaceAll('/link/workbench/', prefix + '/link/workbench/'); if (url.pathname === '/link/workbench/' || url.pathname === '/link/workbench/index.html') html = html.replace('<head>', '<head><script src="' + prefix + '/local-proxy.js"></script>'); const hashes = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => "'sha256-" + createHash('sha256').update(match[1]).digest('base64') + "'"); if (outgoing['content-security-policy']) { outgoing['content-security-policy'] = outgoing['content-security-policy'].replace(/'sha256-[^']+'/g, '').replace(/script-src([^;]*)/, (_, rules) => 'script-src' + rules + ' ' + hashes.join(' ')).replace(/connect-src([^;]*)/, (_, rules) => 'connect-src' + rules + ' ' + (publicOrigin || origin).replace(/^http/, 'ws')); } delete outgoing['content-length']; res.writeHead(response.statusCode, outgoing); res.end(html); });
        } else {
          res.writeHead(response.statusCode, outgoing);
          if (rejectedBody && req.method !== 'HEAD') res.write(rejectedBody);
          if (response.readableEnded) res.end();
          else response.pipe(res);
        }
      };
      forward(remoteCookie);
    } catch (error) { if (!res.headersSent) res.writeHead(error.status || 502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(error.message); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const activeSockets = new Set();
  const voiceSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const bridgeVoice = ws => {
    activeSockets.add(ws);
    const endpoint = new URL('/link/workbench/api/voice/realtime', remoteOrigin);
    endpoint.protocol = 'wss:';
    const remote = new WebSocket(endpoint, { agent, origin: remoteOrigin, headers: { ...relayTargetHeaders(target), cookie: remoteCookie }, handshakeTimeout: 10000, maxPayload: 64 * 1024, perMessageDeflate: false });
    const pending = []; let bytes = 0, ended = false;
    const stop = error => {
      if (ended) return;
      ended = true; pending.length = 0; bytes = 0; activeSockets.delete(ws);
      if (error) onFailure?.(error);
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      if (remote.readyState !== WebSocket.CLOSED) remote.terminate();
    };
    const send = (destination, data, binary) => {
      if (destination.readyState !== WebSocket.OPEN || destination.bufferedAmount + data.length > 64 * 1024) { stop(new Error('实时语音缓冲区已满')); return; }
      destination.send(data, { binary }, error => { if (error) stop(error); });
    };
    ws.on('message', (data, binary) => {
      if (ended) return;
      if (remote.readyState === WebSocket.CONNECTING) {
        if (bytes + data.length > 64 * 1024 || pending.length >= 40) { stop(new Error('实时语音连接尚未就绪')); return; }
        pending.push({ data, binary }); bytes += data.length;
      } else send(remote, data, binary);
    });
    remote.once('open', () => { for (const item of pending) { if (ended) break; send(remote, item.data, item.binary); } pending.length = 0; bytes = 0; });
    remote.on('message', (data, binary) => { if (!ended) send(ws, data, binary); });
    ws.on('error', stop); remote.on('error', stop);
    ws.once('close', () => stop()); remote.once('close', () => stop());
  };
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const match = req.url?.match(/^\/s\/([A-Za-z0-9_-]{43})(\/socket|\/link\/workbench\/api\/voice\/realtime)$/);
    if (closed || req.headers.host !== new URL(origin).host || req.headers.origin !== origin || !match || !sessions.has(match[1])) { socket.destroy(); return; }
    if (match[2] === '/link/workbench/api/voice/realtime') { voiceSockets.handleUpgrade(req, socket, head, bridgeVoice); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      activeSockets.add(ws); const requests = new Map();
      const send = data => { if (ws.readyState === 1) { if (ws.bufferedAmount > 8 * 1024 * 1024) ws.terminate(); else ws.send(JSON.stringify(data)); } };
      ws.on('message', raw => {
        let input;
        try {
          input = JSON.parse(raw.toString());
          if (input.type === 'cancel') { requests.get(input.id)?.destroy(); requests.delete(input.id); return; }
          if (typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.id) || requests.has(input.id) || requests.size >= 64) throw new Error('流请求无效');
          const body = JSON.stringify(input.body);
          if (input.type !== 'open' || typeof input.body !== 'object' || body.length > 1024 * 1024) throw new Error('流请求无效');
          const remote = request(new URL('/link/workbench/remote/open', remoteOrigin), { agent, method: 'POST', headers: { ...relayTargetHeaders(target), cookie: remoteCookie, origin: remoteOrigin, 'content-type': 'application/json' } }, response => {
            send({ id: input.id, type: 'headers', status: response.statusCode });
            let buffer = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { buffer += chunk; if (buffer.length > 4 * 1024 * 1024) { remote.destroy(new Error('流响应过大')); return; } let index; while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.trim()) { try { send({ id: input.id, type: 'data', value: JSON.parse(line) }); } catch { remote.destroy(new Error('流响应格式错误')); } } } });
            response.on('end', () => { requests.delete(input.id); send({ id: input.id, type: 'end' }); });
            response.on('error', error => remote.destroy(error));
          });
          requests.set(input.id, remote);
          remote.setTimeout(90000, () => remote.destroy(new Error('流连接超时')));
          remote.on('error', error => { requests.delete(input.id); send({ id: input.id, type: 'error', error: error.message }); });
          remote.end(body);
        } catch (error) { send({ id: input?.id, type: 'error', error: error.message }); }
      });
      ws.on('error', () => {});
      ws.on('close', () => { activeSockets.delete(ws); for (const remote of requests.values()) remote.destroy(); requests.clear(); });
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  return {
    origin,
    get admission() { return admission; },
    refresh: upstream,
    enter() {
      for (const [ticket, expires] of tickets) if (expires < Date.now()) tickets.delete(ticket);
      const ticket = secret(); tickets.set(ticket, Date.now() + 60000);
      return (publicOrigin || origin) + publicPrefix + '/enter?ticket=' + ticket;
    },
    async close() { closed = true; for (const ws of activeSockets) ws.terminate(); wss.close(); voiceSockets.close(); tickets.clear(); sessions.clear(); agent.destroy(); const done = new Promise(resolve => server.close(resolve)); for (const socket of sockets) socket.destroy(); await done; },
  };
}
