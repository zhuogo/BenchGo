import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, connect as tcpConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import ssh2 from 'ssh2';
import { createServer as createHttpsServer } from 'node:https';
import { loadIdentity } from '../src/transport/tls.mjs';
import { createDeviceProxy } from '../src/devices/proxy.mjs';
import { verifyServerWorkbench } from '../src/server/manager.mjs';
import { createServerManager, fingerprintOf, validateSshInput, shellQuote, redactServerLog, openSshTunnel, execute } from '../src/server/manager.mjs';
import { bash, requiresBash } from './platform.mjs';
import { ownerCommand, ownerDiscoverCommand } from '../src/server/owner-command.mjs';
const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-server-manager-'));
  const clients = new Set(); let authentications = 0;
  const server = new ssh2.Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', context => {
      authentications++;
      const publicKey = options.agentKey;
      if (context.method === 'password' && context.password === 'secret' || context.method === 'publickey' && publicKey?.getPublicSSH().equals(context.key.data) && (!context.signature || publicKey.verify(context.blob, context.signature, context.hashAlgo))) context.accept();
      else context.reject();
    });
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept();
        session.on('pty', accept => accept());
        session.on('shell', accept => { const stream = accept(); stream.on('data', chunk => stream.write(chunk)); });
        session.on('exec', (accept, _reject, info) => {
          const stream = accept();
          if (info.command === ownerDiscoverCommand) { stream.write(options.installed ? 'present' : 'absent'); stream.exit(0); stream.end(); return; }
          if (options.onExec?.(info.command, stream)) return;
          if (info.command === 'test echo') { stream.write('stdout'); stream.stderr.write('stderr'); stream.exit(0); stream.end(); } else { stream.stderr.write('expected-install-failure'); stream.exit(1); stream.end(); }
        });
      });
      client.on('tcpip', (accept, _reject, info) => { const stream = accept(); const socket = tcpConnect(info.destPort, info.destIP); socket.on('error', () => stream.destroy()); stream.on('error', () => socket.destroy()); stream.on('close', () => socket.destroy()); socket.pipe(stream).pipe(socket); });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const manager = createServerManager({ directory, ...options });
  t.after(async () => { await manager.close(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { directory, manager, input: { host: '127.0.0.1', port: server.address().port, username: 'tester' }, authentications: () => authentications, drop: () => { for (const client of clients) client.end(); } };
}
async function completed(manager, id) { for (let i = 0; i < 100; i++) { const value = await manager.job(id); if (value.state !== 'running') return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('job did not settle'); }
test('input validation preserves host values and rejects shell and malformed addresses', () => {
  for (const host of ['127.0.0.1', '::1', 'node.example.com']) assert.equal(validateSshInput({ host, username: 'user' }).host, host);
  for (const host of ['a; touch /tmp/pwn', '-oProxyCommand=x', 'https://host', 'a\nlocalhost']) assert.throws(() => validateSshInput({ host, username: 'user' }));
  assert.throws(() => validateSshInput({ host: 'host', username: 'user', port: 65536 }));
  assert.throws(() => validateSshInput({ host: 'host', username: 'user' }, { credentials: true }), /指纹/);
});

test('shell quoting passes opaque values through a real POSIX shell', requiresBash, () => {
  const input = "a'b $(touch /tmp/not-run)";
  const result = spawnSync(bash, ['-c', 'printf %s ' + shellQuote(input)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, input);
});
test('probe returns SSH SHA256 fingerprint before attempting any authentication', async t => {
  const f = await fixture(t); const result = await f.manager.probe(f.input);
  assert.match(result.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.authentications(), 0);
});
test('host fingerprint mismatch blocks password authentication and returns a failed job', async t => {
  const f = await fixture(t);
  const { jobId } = await f.manager.connect({ ...f.input, fingerprint: 'SHA256:' + 'A'.repeat(43), password: 'secret' });
  const job = await completed(f.manager, jobId); assert.equal(job.state, 'error'); assert.match(job.error, /指纹/); assert.equal(f.authentications(), 0); assert(!JSON.stringify(job).includes('secret'));
});
test('valid fingerprint authenticates but failed install neither persists nor returns a token', async t => {
  const f = await fixture(t); const { fingerprint } = await f.manager.probe(f.input);
  const { jobId } = await f.manager.connect({ ...f.input, fingerprint, password: 'secret' });
  const job = await completed(f.manager, jobId); assert.equal(job.state, 'error'); assert.equal(f.authentications(), 1); assert(!job.device); assert(!JSON.stringify(job).includes('secret'));
  await assert.rejects(readFile(join(f.directory, 'servers.json')), { code: 'ENOENT' });
});

test('SSH checks the shared installer before creating or uploading remote resources', async t => {
  let assets;
  const commands = [];
  const f = await fixture(t, {
    resourceFetcher: async () => ({ directory: assets, manifest: { pluginVersion: '0.1.5', bootstrapCheck: true } }),
    onExec(command, stream) {
      commands.push(command);
      assert.equal(command, "bash -s -- 'github' check");
      let input = '';
      stream.on('data', chunk => { input += chunk; });
      stream.on('end', () => {
        assert.equal(input, '#!/bin/bash\n# shared installer\n');
        stream.stderr.write('需要 glibc 2.28+ secret'); stream.exit(1); stream.end();
      });
      return true;
    },
  });
  assets = f.directory;
  await writeFile(join(assets, 'bootstrap.sh'), '#!/bin/bash\n# shared installer\n');
  const { fingerprint } = await f.manager.probe(f.input);
  const { jobId } = await f.manager.connect({ ...f.input, source: 'github', fingerprint, password: 'secret' });
  const job = await completed(f.manager, jobId);
  assert.equal(job.state, 'error'); assert.match(job.error, /glibc 2.28/);
  assert.equal(job.error.includes('secret'), false);
  assert.equal(job.steps.some(step => step.name === '检查服务器环境'), true);
  assert.equal(job.steps.some(step => step.name === '上传服务器安装资源'), false);
  assert.equal(commands.length, 1);
  await assert.rejects(readFile(join(f.directory, 'servers.json')), { code: 'ENOENT' });
});
test('real SSH execution and local-only tunnel carry independent streams', async t => {
  const f = await fixture(t); const { fingerprint } = await f.manager.probe(f.input);
  const client = new ssh2.Client(); client.on('error', () => {});
  await new Promise((resolve, reject) => { client.once('ready', resolve); client.once('error', reject); client.connect({ ...f.input, password: 'secret', hostVerifier: key => fingerprintOf(key) === fingerprint }); });
  const echo = createServer(socket => { socket.on('error', () => {}); socket.pipe(socket); }); await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  const tunnel = await openSshTunnel(client, echo.address().port);
  t.after(async () => { await tunnel.close(); client.end(); await new Promise(resolve => echo.close(resolve)); });
  assert.equal(new URL(tunnel.url).hostname, '127.0.0.1');
  const chunks = [];
  const result = await execute(client, 'test echo', { onData: (data, source) => chunks.push([source, data]) }); assert.deepEqual(result, { code: 0, stdout: 'stdout', stderr: 'stderr' });
  assert.deepEqual(chunks.sort(), [['stderr', 'stderr'], ['stdout', 'stdout']]);
  const socket = tcpConnect(Number(new URL(tunnel.url).port), '127.0.0.1');
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.once('connect', resolve); });
  const value = randomUUID(); const received = new Promise(resolve => socket.once('data', data => resolve(data.toString()))); socket.write(value); assert.equal(await received, value); socket.destroy();
});
test('relay deployment jobs can be recovered after the page reloads', async t => {
  const f = await fixture(t);
  const { jobId } = await f.manager.deployRelay({ ...f.input, publicIp: '8.8.8.8', relayPort: 24680, email: '', fingerprint: 'SHA256:' + 'A'.repeat(43), password: 'secret' });
  assert.equal(f.manager.activeRelayJob().id, jobId);
  const job = await completed(f.manager, jobId);
  assert.equal(job.state, 'error'); assert.equal(f.manager.activeRelayJob().state, 'error');
  assert.deepEqual(f.manager.dismissRelayJob(jobId), { ok: true }); assert.equal(f.manager.activeRelayJob(), null);
});
test('legacy servers migrate without the retired AI grant and disconnect removes the local record', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-server-saved-'));
  await writeFile(join(directory, 'servers.json'), JSON.stringify([{ id: 'device', kind: 'ssh', name: 'old', token: 'device-token', aiRevision: 'old-grant', url: 'https://127.0.0.1:1234', ssh: { host: '127.0.0.1', username: 'user', port: 22, fingerprint: 'SHA256:' + 'A'.repeat(43) } }]), { mode: 0o600 });
  const manager = createServerManager({ directory });
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  await manager.ready;
  assert.equal(manager.state('device').sshStatus, 'disconnected');
  await assert.rejects(readFile(join(directory, 'servers.json')), { code: 'ENOENT' });
  const migrated = JSON.parse(await readFile(join(directory, 'connections.json'), 'utf8'));
  assert.equal(migrated.devices[0].url, '');
  assert.equal(Object.hasOwn(migrated.devices[0], 'aiRevision'), false);
  assert.equal((await manager.sshTarget({ deviceId: 'device' })).username, 'user');
  await manager.disconnect('device'); assert.deepEqual(JSON.parse(await readFile(join(directory, 'connections.json'))).devices, []);
  // Windows mode bits do not represent POSIX owner-only permissions.
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'connections.json'))).mode & 0o777, 0o600);
});
test('server logs redact credentials, bearer, URL and private JSON fields', () => {
  const text = redactServerLog('Bearer abc-123 https://host/?token=hidden&code=paired {"token":"json-secret","password":"pass"} private-key-value', ['private-key-value']);
  for (const value of ['abc-123', 'hidden', 'paired', 'json-secret', 'pass"', 'private-key-value']) assert(!text.includes(value), value);
});

test('existing Link server binds in place, restores SSH through an agent, and separates command and terminal from workbench', async t => {
  const hostKey = ssh2.utils.parseKey(key);
  const agentServer = createServer(socket => {
    const protocol = new ssh2.AgentProtocol(false);
    protocol.on('identities', request => protocol.getIdentitiesReply(request, [hostKey]));
    protocol.on('sign', (request, _publicKey, data, flags) => protocol.signReply(request, hostKey.sign(data, flags?.hash)));
    socket.pipe(protocol).pipe(socket);
  });
  const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\benchgo-test-' + randomUUID() : join(tmpdir(), 'bg-' + randomUUID() + '.sock');
  const priorAgent = process.env.SSH_AUTH_SOCK;
  await new Promise(resolve => agentServer.listen(socketPath, resolve));
  process.env.SSH_AUTH_SOCK = socketPath;
  t.after(() => {
    if (priorAgent === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = priorAgent;
    return new Promise(resolve => agentServer.close(resolve));
  });
  let port, hostId, interrupt;
  const f = await fixture(t, {
    installed: true, agentKey: hostKey,
    resourceFetcher: async () => assert.fail('existing instance used deployment resources'),
    onExec(command, stream) {
      if (command === 'pending command') { interrupt?.(); return true; }
      if (command !== ownerCommand) return false;
      stream.on('data', () => {});
      stream.on('end', () => { stream.write(JSON.stringify({ hostId, port })); stream.exit(0); stream.end(); });
      return true;
    },
  });
  const paired = { id: 'paired-id', name: '原有别名', hostId: '', token: 'paired', authorizationId: 'auth' };
  const identity = await loadIdentity(f.directory);
  hostId = 'sha256:' + identity.pin;
  paired.hostId = hostId;
  await writeFile(join(f.directory, 'connections.json'), JSON.stringify({ version: 1, activeId: 'local', devices: [{ ...paired, url: 'https://relay.example', kind: 'computer' }] }));
  const registry = await import('../src/devices/registry.mjs').then(({ openDeviceRegistry }) => openDeviceRegistry(f.directory));
  const manager = createServerManager({ directory: f.directory, registry, resourceFetcher: async () => assert.fail('existing instance used deployment resources') });
  t.after(() => manager.close());
  let workbenchOnline = true;
  const https = createHttpsServer({ key: identity.key, cert: identity.cert }, (req, res) => {
    if (!workbenchOnline) { res.writeHead(503); res.end('{"error":"offline"}'); return; }
    if (req.url === '/link/api/workbench') {
      assert.equal(req.headers.authorization, 'Bearer paired');
      res.writeHead(200, { 'set-cookie': 'dsh_link_workbench=test' }); res.end('{"url":"/link/workbench/"}');
    } else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>workbench</html>'); }
  });
  await new Promise(resolve => https.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => https.close(resolve)));
  port = https.address().port;
  const { fingerprint } = await f.manager.probe(f.input);
  const { jobId } = await manager.connect({ ...f.input, fingerprint, password: 'secret', device: registry.get('paired-id') });
  const result = await completed(manager, jobId);
  assert.equal(result.state, 'done', result.error);
  assert.equal(result.device.id, 'paired-id');
  assert.equal(registry.list().devices.length, 2);
  assert.equal(registry.get('paired-id').url, 'https://relay.example');
  const first = await manager.sshTarget({ deviceId: 'paired-id' });
  await manager.close();
  const restored = createServerManager({ directory: f.directory });
  t.after(() => restored.close());
  await restored.ready;
  assert.equal(restored.state('paired-id').sshStatus, 'disconnected');
  assert.equal(await restored.agentAvailable(), true);
  workbenchOnline = false;
  const terminal = await restored.openTerminal('paired-id');
  restored.writeTerminal({ deviceId: 'paired-id', id: terminal.id, data: 'terminal input' });
  for (let i = 0; i < 100 && !restored.readTerminal({ deviceId: 'paired-id', id: terminal.id, offset: 0 }).output; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(restored.readTerminal({ deviceId: 'paired-id', id: terminal.id, offset: 0 }).output, 'terminal input');
  assert.equal(restored.state('paired-id').sshStatus, 'connected');
  await assert.rejects(verifyServerWorkbench(await restored.workbenchTarget('paired-id')), /offline/);
  const target = await restored.sshTarget({ deviceId: 'paired-id' });
  await assert.rejects(restored.sshCommand({ deviceId: 'paired-id', command: 'test echo', expectedRevision: first.revision }), { code: 'IDENTITY_CHANGED' });
  const command = { deviceId: 'paired-id', command: 'test echo', expectedRevision: target.revision };
  assert.deepEqual(await restored.sshCommand(command), { code: 0, stdout: 'stdout', stderr: 'stderr', status: 'completed' });
  const pending = new Promise(resolve => { interrupt = resolve; });
  const running = restored.sshCommand({ ...command, command: 'pending command' });
  await pending;
  f.drop();
  assert.equal((await running).status, 'unknown');
  await restored.disconnect('paired-id');
  await assert.rejects(restored.sshCommand(command), { code: 'SSH_NOT_CONFIGURED' });
});
test('server workbench verification requires pinned TLS, valid token, cookie and ready HTML', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-server-ready-')), identity = await loadIdentity(directory);
  let calls = 0, ready = false, cookie = true;
  const remoteAuthority = '127.0.0.1:4430';
  const server = createHttpsServer({ key: identity.key, cert: identity.cert }, (req, res) => {
    calls++;
    assert.equal(req.headers.host, remoteAuthority);
    if (req.headers.origin) assert.equal(req.headers.origin, 'https://' + remoteAuthority);
    if (req.url === '/link/api/workbench') {
      if (req.headers.authorization !== 'Bearer good-token') { res.writeHead(401); res.end('{"error":"invalid token"}'); return; }
      res.writeHead(200, cookie ? { 'set-cookie': 'dsh_link_workbench=session; HttpOnly; Secure; Path=/link/workbench/' } : {});
      res.end('{"url":"/link/workbench/"}'); return;
    }
    assert.equal(req.headers.cookie, 'dsh_link_workbench=session');
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(ready ? 200 : 503, { 'content-type': 'text/html' }); res.end('<html>workbench</html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const target = { url: 'https://127.0.0.1:' + server.address().port, kind: 'ssh', ssh: { remotePort: 4430 }, pin: identity.pin, token: 'good-token' };
  await assert.rejects(verifyServerWorkbench({ ...target, pin: Buffer.alloc(32, 1).toString('base64') }), /指纹/); assert.equal(calls, 0);
  await assert.rejects(verifyServerWorkbench({ ...target, token: 'bad-token' }), /invalid token/);
  cookie = false; await assert.rejects(verifyServerWorkbench(target), /工作台授权/);
  cookie = true; await assert.rejects(verifyServerWorkbench(target), /尚未就绪/);
  ready = true; await verifyServerWorkbench(target);
  const proxy = await createDeviceProxy(target);
  try {
    const page = await fetch(await proxy.enter({ verifyPage: true }));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html>workbench<\/html>/);
  } finally { await proxy.close(); }
});
