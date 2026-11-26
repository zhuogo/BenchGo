import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { createSecureServer } from 'node:http2';
import { WebSocketServer } from 'ws';
import { RELAY_CHUNK_BYTES as CHUNK, RELAY_CONTROL_PATH as CONTROL, RELAY_DATA_PATH as DATA, RELAY_VOICE_PATH as VOICE, RELAY_WORKBENCH_PATH as WORKBENCH, RELAY_PROBE_PATH as PROBE, RELAY_PROTOCOL, RELAY_PROTOCOL_VERSION, RELAY_HTTP_REUSE_HEADER, relayHostClaim, relayPathAllowed, sendRelayFrame as send } from './relay-protocol.mjs';

const MAX_BUFFERED = 256 * 1024;
const MAX_STREAM_BYTES = 512 * 1024 * 1024;
const MAX_IDLE_HTTP_CHANNELS = 4;
const HTTP_CHANNEL_IDLE_MS = 25_000;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const digest = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => {
  const left = Buffer.from(digest(a)); const right = Buffer.from(digest(b));
  return left.length === right.length && timingSafeEqual(left, right);
};
const json = (ws, value) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(value));
const workbenchCookie = value => typeof value === 'string'
  ? value.split(';').map(item => item.trim()).filter(item => item.startsWith('dsh_link_workbench=')).join('; ')
  : '';
const requestHeaders = (headers, path) => {
  const result = {};
  for (const key of ['accept', 'accept-encoding', 'accept-language', 'content-type', 'content-length', 'range', 'if-none-match', 'if-modified-since', 'cookie']) {
    if (typeof headers[key] === 'string') result[key] = key === 'cookie' ? workbenchCookie(headers[key]) : headers[key];
  }
  if (['/link/api/info', '/link/api/rpc', '/link/api/workbench'].includes(path) && typeof headers.authorization === 'string') result.authorization = headers.authorization;
  return result;
};
const responseHeaders = headers => {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && !['connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(key)) result[key] = value;
  }
  return result;
};

/** TLS ends here; HTTP content is visible to this relay. */
export async function createRelayServer({ host = '0.0.0.0', port, identity, publicUrl, token, onError = () => {} }) {
  if (!identity?.key || !identity?.cert) throw new Error('中继 TLS 证书无效');
  if (typeof token !== 'string' || token.length < 6 || token.length > 256) throw new Error('中继主机密钥至少需要 6 个字符');
  const publicOrigin = new URL(publicUrl);
  if (publicOrigin.protocol !== 'https:' || publicOrigin.origin !== publicUrl || publicOrigin.username || publicOrigin.password) throw new Error('中继公网地址必须是独立 HTTPS origin');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('中继监听端口无效');
  let closed = false, defaultHost;
  const hosts = new Map();
  const hostKey = value => value === undefined || typeof value === 'string' && /^sha256:[A-Za-z0-9+/]{43}=$/.test(value);
  const proofs = new Map();
  const verifyHost = (id, proof) => {
    if (!id) return true;
    if (typeof proof !== 'string' || proof.length > 2048) return false;
    const [key, expiry, nonce, signature, extra] = proof.split('.');
    const now = Date.now(), expires = Number(expiry);
    if (extra !== undefined || !/^[\w-]{22}$/.test(nonce ?? '') || !signature
      || !Number.isSafeInteger(expires) || expires <= now || expires > now + 90_000) return false;
    for (const [prior, until] of proofs) if (until <= now) proofs.delete(prior);
    if (proofs.has(nonce) || proofs.size >= 4096) return false;
    try {
      const der = Buffer.from(key, 'base64url');
      const publicKey = createPublicKey({ key: der, type: 'spki', format: 'der' });
      if (id !== 'sha256:' + createHash('sha256').update(der).digest('base64')
        || !verify('sha256', Buffer.from(relayHostClaim(publicOrigin.origin, id, expires, nonce)), publicKey, Buffer.from(signature, 'base64url'))) return false;
      proofs.set(nonce, expires);
      return true;
    } catch { return false; }
  };
  const targetCookie = 'dsh_link_relay_target';
  const hostFor = (req, selected) => {
    const cookie = req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith(targetCookie + '='));
    const target = req.headers['x-benchgo-relay-target'] ?? selected ?? cookie?.slice(targetCookie.length + 1);
    if (!hostKey(target)) throw fail('中继目标无效', 400);
    return hosts.get(target ?? defaultHost);
  };
  const tickets = new Map(), transactions = new Set(), sockets = new Set();
  const anonymousRates = new Map();
  const limitAnonymous = req => {
    // The relay owns this public socket. Never accept a client-supplied
    // forwarding header as the source of an anonymous request.
    const key = req.socket.remoteAddress ?? 'unknown', tick = Math.floor(Date.now() / 60_000);
    if (anonymousRates.size >= 1024) for (const [key, rate] of anonymousRates) if (rate.tick !== tick) anonymousRates.delete(key);
    if (anonymousRates.size >= 1024 && !anonymousRates.has(key)) throw fail('请求过多', 429);
    const rate = anonymousRates.get(key)?.tick === tick ? anonymousRates.get(key) : { tick, count: 0 };
    anonymousRates.set(key, rate);
    if (++rate.count > 600) throw fail('请求过多，请稍后重试', 429);
  };
  const controls = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  const data = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  const voice = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const securityHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
  const parkHttp = (host, socket) => {
    if (host.control.readyState !== host.control.OPEN || socket.readyState !== socket.OPEN || host.idle.size >= MAX_IDLE_HTTP_CHANNELS) {
      socket.resume();
      socket.close(1000);
      return;
    }
    const release = () => {
      clearTimeout(timer);
      socket.off('message', discard);
      socket.off('close', release);
      host.idle.delete(socket);
    };
    const discard = () => { release(); socket.terminate(); };
    const timer = setTimeout(discard, HTTP_CHANNEL_IDLE_MS);
    timer.unref();
    host.idle.set(socket, release);
    socket.once('message', discard);
    socket.once('close', release);
    socket.resume();
  };
  const takeHttp = host => {
    for (const [socket, release] of host.idle) {
      release();
      if (socket.readyState === socket.OPEN) return socket;
    }
  };
  const openTicket = value => {
    if (typeof value !== 'string' || value.length > 128) return;
    const key = digest(value), entry = tickets.get(key);
    tickets.delete(key);
    if (!entry || entry.expires < Date.now() || !same(value, entry.ticket)) return;
    return entry;
  };
  const remove = transaction => { clearTimeout(transaction.attachTimer); clearTimeout(transaction.voiceTimer); if (transaction.ticketKey) tickets.delete(transaction.ticketKey); transactions.delete(transaction); };
  const disconnect = transaction => {
    if (!transactions.has(transaction)) return;
    remove(transaction);
    transaction.socket?.terminate();
    transaction.browser?.terminate();
    transaction.rejectData?.(new Error('主机已断开'));
    transaction.res?.destroy();
    transaction.rawSocket?.destroy();
  };
  const makeTransaction = (req, res, { selected, kind = 'http' } = {}) => {
    const activeHost = hostFor(req, selected);
    if (!activeHost || activeHost.control.readyState !== activeHost.control.OPEN) throw fail('目标设备离线', 503);
    if (transactions.size >= 64) throw fail('中继连接数已满', 429);
    const socket = kind === 'http' ? takeHttp(activeHost) : undefined;
    const transaction = { res, kind, socket, host: activeHost };
    transactions.add(transaction);
    if (!socket) {
      const ticket = randomBytes(32).toString('base64url'), ticketKey = digest(ticket);
      const { promise, resolve, reject } = Promise.withResolvers();
      promise.catch(() => {});
      const attachTimer = setTimeout(() => {
        remove(transaction); reject(new Error('主机接入超时'));
        if (transaction.rawSocket && !transaction.rawSocket.destroyed) transaction.rawSocket.end('HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      }, 15_000);
      attachTimer.unref();
      Object.assign(transaction, { ticket, ticketKey, attachTimer, expires: Date.now() + 15_000, dataReady: promise, resolveData: resolve, rejectData: reject });
      tickets.set(ticketKey, transaction);
    }
    return transaction;
  };
  const relayHttp = async (req, res, path) => {
    const url = new URL(req.url, publicOrigin);
    const selected = path === '/link/' && req.method === 'GET' ? url.searchParams.get('relayTarget') ?? undefined : undefined;
    if (selected !== undefined) url.searchParams.delete('relayTarget');
    const query = url.search;
    if (!relayPathAllowed(req.method, path + query)) throw fail('Link 路径未授权', 404);
    if (req.headers.origin && req.headers.origin !== publicOrigin.origin) throw fail('来源未授权', 403);
    const transaction = makeTransaction(req, res, { selected });
    const { host } = transaction;
    const reuse = host.reuse;
    const input = { type: 'http', method: req.method, path: path + query, headers: requestHeaders(req.headers, path), clientAddress: req.socket.remoteAddress, ...(reuse && { reuse }) };
    let socket = transaction.socket;
    let requestBytes = 0, responseBytes = 0, requestEnded = false, finished = false;
    const resumeDownload = () => socket.resume();
    const finish = () => {
      finished = true;
      remove(transaction);
      clearTimeout(timer);
      res.off('close', cancel);
      res.off('drain', resumeDownload);
      socket?.off('message', onMessage);
      socket?.off('close', onDisconnect);
    };
    const cancel = () => {
      transaction.rejectData?.(new Error('客户端已断开'));
      finish();
      socket?.terminate();
    };
    const failed = (status = 502, message = '目标设备连接中断') => {
      if (finished) return;
      finish();
      socket?.terminate();
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else { res.writeHead(status, { ...securityHeaders, 'content-type': 'text/plain; charset=utf-8' }); res.end(message); }
    };
    const onDisconnect = () => failed();
    const timer = setTimeout(onDisconnect, 120_000);
    timer.unref();
    const onMessage = (raw, binary) => {
      timer.refresh();
      if (binary) {
        if (!res.headersSent) return failed();
        responseBytes += raw.length;
        if (responseBytes > MAX_STREAM_BYTES) return failed();
        if (!res.write(raw) && !socket.isPaused) { socket.pause(); res.once('drain', resumeDownload); }
        return;
      }
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return failed(); }
      if (frame?.type === 'response' && !res.headersSent && Number.isInteger(frame.status) && frame.status >= 100 && frame.status <= 599 && frame.headers && typeof frame.headers === 'object') {
        const headers = responseHeaders(frame.headers);
        if (selected && frame.status === 200) headers['set-cookie'] = [...(headers['set-cookie'] ?? []), `${targetCookie}=${selected}; Path=/link; Secure; HttpOnly; SameSite=Lax`];
        try { res.writeHead(frame.status, { ...headers, ...securityHeaders }); } catch { failed(); }
      } else if (frame?.type === 'end' && res.headersSent) {
        finish();
        if (reuse && requestEnded && frame.reuse === true) parkHttp(host, socket);
        else { socket.resume(); socket.close(1000); }
        res.end();
      } else failed(502, frame?.type === 'error' ? '目标设备请求失败' : undefined);
    };
    res.once('close', cancel);
    try {
      const reused = Boolean(socket);
      if (!reused) {
        json(host.control, { ...input, ticket: transaction.ticket });
        socket = await transaction.dataReady;
      }
      if (finished) { socket.terminate(); return; }
      if (socket.readyState !== socket.OPEN) return failed();
      socket.on('message', onMessage);
      socket.once('close', onDisconnect);
      if (reused) await send(socket, JSON.stringify(input));
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        if (finished) { req.resume(); return; }
        requestBytes += chunk.length;
        if (requestBytes > MAX_STREAM_BYTES) { req.resume(); return failed(413, '请求过大'); }
        timer.refresh();
        for (let offset = 0; offset < chunk.length && !finished; offset += CHUNK) await send(socket, chunk.subarray(offset, offset + CHUNK), { binary: true });
      }
      if (!finished) { requestEnded = true; await send(socket, '{"type":"request-end"}'); }
    } catch { failed(); }
  };
  // Queue browser startup bursts at the HTTP/2 layer, leaving room in the
  // shared 64-transaction budget for another device and long-lived streams.
  const server = createSecureServer({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.2', allowHTTP1: true, settings: { maxConcurrentStreams: 32 } }, (req, res) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    try {
      const authority = req.headers[':authority'] || req.headers.host;
      if (closed || authority !== publicOrigin.host) throw fail('中继地址未授权', 403);
      const raw = req.url || '/';
      if (raw === PROBE && req.method === 'GET') {
        if (req.headers.origin && req.headers.origin !== publicOrigin.origin) throw fail('来源未授权', 403);
        const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '');
        if (!supplied || !same(supplied, token)) throw fail('中继主机密钥无效', 401);
        res.writeHead(200, { ...headers, 'content-type': 'application/json' });
        res.end(JSON.stringify({ protocol: RELAY_PROTOCOL, version: RELAY_PROTOCOL_VERSION, authenticated: true, multipleHosts: true })); return;
      }
      if (!relayPathAllowed(req.method, raw)) throw fail('Link 路径未授权', 404);
      const url = new URL(raw, publicOrigin);
      if (url.origin !== publicOrigin.origin || !(url.pathname === '/link' || url.pathname.startsWith('/link/'))) throw fail('Link 路径未授权', 404);
      // Credential-bearing routes are authenticated and limited by device on
      // Link. Public routes remain anonymous even if a fake token is supplied.
      if (!url.pathname.startsWith(WORKBENCH) && !['/link/api/rpc', '/link/api/workbench'].includes(url.pathname)) limitAnonymous(req);
      void relayHttp(req, res, url.pathname).catch(error => { if (!res.headersSent) { res.writeHead(error.status ?? 502, { ...securityHeaders, ...headers }); res.end(error.status ? error.message : '目标设备连接失败'); } else res.destroy(); });
    } catch (error) { res.writeHead(error.status ?? 400, headers); res.end(error.message); }
  });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const reject = status => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (req.url === CONTROL) {
      const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!supplied || !same(supplied, token)) { socket.destroy(); return; }
      const id = req.headers['x-benchgo-relay-target'];
      if (closed || !hostKey(id) || req.headers.host !== publicOrigin.host || req.headers.origin && req.headers.origin !== publicOrigin.origin
        || !verifyHost(id, req.headers['x-benchgo-relay-proof'])) return reject(403);
      const key = id ?? '';
      if (!hosts.has(key) && hosts.size >= 128) return reject(429);
      controls.handleUpgrade(req, socket, head, ws => {
        const previous = hosts.get(key);
        const host = { control: ws, reuse: req.headers[RELAY_HTTP_REUSE_HEADER] === '1', idle: new Map() };
        defaultHost ??= key;
        hosts.set(key, host); previous?.control.terminate();
        ws.on('message', () => ws.close(1008, 'control messages are server initiated'));
        ws.on('error', () => {});
        ws.once('close', () => {
          if (hosts.get(key) === host) hosts.delete(key);
          for (const channel of host.idle.keys()) channel.terminate();
          for (const entry of transactions) if (entry.host === host) disconnect(entry);
        });
      }); return;
    }
    if (req.url !== DATA) {
      if (req.url !== VOICE || req.headers.host !== publicOrigin.host || req.headers.origin !== publicOrigin.origin || closed) return reject(403);
      let transaction;
      try { transaction = makeTransaction(req, undefined, { kind: 'voice' }); }
      catch (error) { return reject(error.status ?? 502); }
      transaction.rawSocket = socket;
      socket.once('close', () => disconnect(transaction));
      json(transaction.host.control, { type: 'voice', ticket: transaction.ticket, path: VOICE, cookie: workbenchCookie(req.headers.cookie).slice(0, 4096), clientAddress: req.socket.remoteAddress });
      transaction.attachVoice = dataSocket => {
        const timeout = transaction.voiceTimer = setTimeout(() => { if (!transaction.browser) { reject(504); remove(transaction); dataSocket.terminate(); } }, 12_000); timeout.unref?.();
        dataSocket.on('message', (raw, binary) => {
          if (!transaction.browser) {
            if (binary) { dataSocket.close(1002, 'unexpected voice data'); return; }
            let frame; try { frame = JSON.parse(raw.toString()); } catch { dataSocket.close(1002, 'invalid voice handshake'); return; }
            if (frame.type !== 'voice-ready') { dataSocket.close(1002, 'invalid voice handshake'); return; }
            clearTimeout(timeout);
            voice.handleUpgrade(req, socket, head, browser => {
              transaction.browser = browser;
              browser.on('message', (value, isBinary) => {
                const payload = Buffer.from(value), framed = Buffer.allocUnsafe(payload.length + 1);
                framed[0] = isBinary ? 1 : 0; payload.copy(framed, 1);
                if (dataSocket.readyState !== dataSocket.OPEN || dataSocket.bufferedAmount + framed.length > MAX_BUFFERED * 4) { browser.close(1009, 'voice buffer full'); return; }
                dataSocket.send(framed, { binary: true });
              });
              dataSocket.on('message', (value, isBinary) => {
                if (!isBinary) { dataSocket.close(1002, 'invalid voice payload'); return; }
                const payload = Buffer.from(value);
                if (payload.length < 1 || payload[0] > 1 || browser.readyState !== browser.OPEN || browser.bufferedAmount + payload.length > MAX_BUFFERED * 4) { browser.close(1009, 'voice frame invalid'); return; }
                browser.send(payload.subarray(1), { binary: payload[0] === 1 });
              });
              const close = () => { browser.terminate(); dataSocket.terminate(); remove(transaction); };
              browser.once('close', close); dataSocket.once('close', close);
              browser.on('error', close); dataSocket.on('error', close);
            });
          }
        });
        dataSocket.once('close', () => { clearTimeout(timeout); if (!transaction.browser) reject(502); remove(transaction); socket.destroy(); });
      };
      return;
    }
    if (closed || req.headers.host !== publicOrigin.host || req.headers.origin && req.headers.origin !== publicOrigin.origin) return reject(403);
    const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const transaction = openTicket(supplied);
    if (!transaction || transaction.host.control.readyState !== transaction.host.control.OPEN) { socket.destroy(); return; }
    data.handleUpgrade(req, socket, head, ws => {
      clearTimeout(transaction.attachTimer);
      transaction.socket = ws;
      transaction.resolveData(ws);
      if (transaction.kind === 'voice') transaction.attachVoice(ws);
      ws.on('error', () => ws.terminate());
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.requestTimeout = 0; server.headersTimeout = 15_000; server.keepAliveTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
  server.on('error', onError);
  return {
    port: server.address().port,
    origin: publicOrigin.origin,
    async close() {
      closed = true;
      for (const host of hosts.values()) {
        host.control.terminate();
        for (const channel of host.idle.keys()) channel.terminate();
      }
      for (const transaction of transactions) disconnect(transaction);
      tickets.clear(); anonymousRates.clear();
      const done = new Promise(resolve => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      controls.close(); data.close(); voice.close(); await done;
    },
  };
}
