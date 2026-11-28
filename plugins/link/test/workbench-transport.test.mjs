import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { get } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { WebSocket } from 'ws';
import { createDeviceProxy } from '../src/devices/proxy.mjs';
import { loadIdentity } from '../src/transport/tls.mjs';

for (const transport of ['http', 'stream']) {
  test(`cancelled proxy ${transport} releases a pending TLS handshake`, { timeout: 3000 }, async t => {
    const accepted = Promise.withResolvers();
    const sockets = new Set();
    const server = createServer(socket => {
      sockets.add(socket);
      socket.resume();
      socket.once('close', () => sockets.delete(socket));
      accepted.resolve(socket);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const target = { url: `https://127.0.0.1:${server.address().port}`, pin: Buffer.alloc(32).toString('base64'), cookie: 'fixture=session' };
    const failures = [];
    const proxy = await createDeviceProxy(target, { workbenchLease: async () => target, onFailure: error => failures.push(error) });
    t.after(async () => {
      await proxy.close();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    });
    const entry = await fetch(proxy.enter(), { redirect: 'manual' });
    const base = proxy.origin + entry.headers.get('location');
    let cancel;
    if (transport === 'http') {
      const request = get(base + 'api/status');
      request.on('error', () => {});
      t.after(() => request.destroy());
      cancel = () => request.destroy();
    } else {
      const prefix = entry.headers.get('location').replace('/link/workbench/', '');
      const socket = new WebSocket(proxy.origin.replace('http:', 'ws:') + prefix + '/socket', { origin: proxy.origin });
      t.after(() => socket.terminate());
      await once(socket, 'open');
      socket.send(JSON.stringify({ type: 'open', id: 'cancelled', body: { endpoint: 'fixture/read' } }));
      cancel = () => socket.send(JSON.stringify({ type: 'cancel', id: 'cancelled' }));
    }
    const pending = await accepted.promise;
    const closed = once(pending, 'close');
    cancel();
    let watchdog;
    try {
      await Promise.race([
        closed,
        new Promise((_, reject) => { watchdog = setTimeout(() => reject(Error('Cancelled TLS handshake still occupies a connection')), 500); }),
      ]);
    } finally { clearTimeout(watchdog); }
    assert.equal(failures.length, 0, 'user cancellation must not mark the device offline');
  });
}

for (const transport of ['HTTP', 'stream']) {
  test(`${transport} opening deadline includes waiting behind occupied agent sockets`, { timeout: 10000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'link-proxy-queue-'));
    const identity = await loadIdentity(directory);
    let upstreamRequests = 0;
    const server = createHttpsServer({ key: identity.key, cert: identity.cert }, (_req, res) => {
      upstreamRequests++;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write('{"type":"ready"}\n');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const target = { url: `https://127.0.0.1:${server.address().port}`, pin: identity.pin, cookie: 'fixture=session' };
    const proxy = await createDeviceProxy(target, { workbenchLease: async () => target });
    t.after(async () => {
      await proxy.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    });
    const entry = await fetch(proxy.enter(), { redirect: 'manual' });
    const prefix = entry.headers.get('location').replace('/link/workbench/', '');
    const socket = new WebSocket(proxy.origin.replace('http:', 'ws:') + prefix + '/socket', { origin: proxy.origin });
    t.after(() => socket.terminate());
    await once(socket, 'open');
    let ready = 0;
    const occupied = Promise.withResolvers();
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'data' && ++ready === 64) occupied.resolve();
    });
    for (let index = 0; index < 64; index++) {
      socket.send(JSON.stringify({ type: 'open', id: 'stream-' + index, body: { endpoint: 'fixture/read' } }));
    }
    await occupied.promise;
    assert.equal(upstreamRequests, 64);
    let queuedSocket;
    if (transport === 'stream') {
      queuedSocket = new WebSocket(proxy.origin.replace('http:', 'ws:') + prefix + '/socket', { origin: proxy.origin });
      t.after(() => queuedSocket.terminate());
      await once(queuedSocket, 'open');
    }
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const completed = Promise.withResolvers();
    if (transport === 'HTTP') {
      const request = get(proxy.origin + entry.headers.get('location') + 'api/status', response => {
        response.resume();
        response.once('end', () => completed.resolve(response.statusCode));
      });
      request.on('error', completed.reject);
      t.after(() => request.destroy());
    } else {
      queuedSocket.on('message', raw => completed.resolve(JSON.parse(raw.toString())));
      queuedSocket.send(JSON.stringify({ type: 'open', id: 'queued', body: { id: 'queued', endpoint: 'fixture/read' } }));
    }
    try {
      for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(upstreamRequests, 64, 'normal request is queued behind active streams');
      t.mock.timers.tick(90000);
      if (transport === 'HTTP') assert.equal(await completed.promise, 502);
      else assert.deepEqual(await completed.promise, { id: 'queued', type: 'error', error: '流连接超时' });
      assert.equal(upstreamRequests, 64, 'expired request never reaches the host');
    } finally { t.mock.timers.reset(); }
  });
}

test('a closing socket cannot interrupt streams on its replacement', async () => {
  const source = await readFile(new URL('../client/workbench-bridge.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  let localSocket;');
  const end = source.indexOf('  async function* lines(response)');
  assert.ok(start > 0 && end > start);
  const sockets = [];
  class FixtureSocket extends EventTarget {
    readyState = 1;
    constructor() { super(); sockets.push(this); }
    send(raw) { this.sent = JSON.parse(raw); }
    close() { this.readyState = 2; }
    frame(frame) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })); }
  }
  const open = runInNewContext(source.slice(start, end) + '\nlocalLines;', {
    WebSocket: FixtureSocket, URL, base: new URL('http://127.0.0.1/s/fixture/link/workbench/'),
  });
  const firstController = new AbortController();
  const first = open({ id: 'first' }, firstController.signal);
  const firstRead = first.next();
  await Promise.resolve();
  sockets[0].frame({ id: 'first', type: 'data', value: { type: 'ready' } });
  await firstRead;
  sockets[0].close();

  const secondController = new AbortController();
  const second = open({ id: 'second' }, secondController.signal);
  const secondRead = second.next();
  const firstFailure = assert.rejects(first.next(), /主机连接已断开/);
  await Promise.resolve();
  sockets[0].dispatchEvent(new Event('close'));
  sockets[1].frame({ id: 'second', type: 'data', value: { type: 'ready' } });
  try {
    assert.equal((await secondRead).value.type, 'ready');
    await firstFailure;
    const next = second.next();
    sockets[0].frame({ id: 'second', type: 'error', error: 'late old socket frame' });
    sockets[1].frame({ id: 'second', type: 'data', value: { type: 'item', value: 'healthy' } });
    assert.equal((await next).value.value, 'healthy');
  } finally {
    firstController.abort(); secondController.abort();
    await first.return(); await second.return();
  }
});
