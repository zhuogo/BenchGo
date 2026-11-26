import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { Agent, createServer as createHttpsServer } from 'node:https';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mountLink } from '../src/index.mjs';
import { createDeviceProxy } from '../src/devices/proxy.mjs';
import { openDeviceGroup } from '../src/devices/group.mjs';
import { remoteJson } from '../src/devices/remote.mjs';
import { connectionAddresses, listen, validateConfig } from '../src/transport/server.mjs';
import { openStore } from '../src/pairing/store.mjs';
import { loadIdentity } from '../src/transport/tls.mjs';
import { createRelayHost } from '../src/transport/relay-host.mjs';
import { createRelayServer } from '../src/transport/relay-server.mjs';
import { mountWeb } from '../../base/src/web.mjs';
import { createGroupProviders } from '../../base/src/group-providers.mjs';
import { createModelProviders } from '../../base/src/model-providers.mjs';
import { VoiceConfig } from '../../media/src/config.mjs';
import { createMediaGeneration } from '../../media/src/generation.mjs';
import { createGroupMedia } from '../../media/src/group-settings.mjs';
import { mountIntegrationApi } from '../../superagent/src/integration-api.mjs';

async function freePort() {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

async function host(t, name, projects, assistant, stored = {}, serviceContext = {}) {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-cross-device-')), directory = join(root, 'link');
  await mkdir(directory);
  await writeFile(join(root, 'index.html'), '<html><head></head></html>');
  await writeFile(join(directory, 'devices.json'), JSON.stringify({ name, host: '127.0.0.1', port: 0, ...stored }));
  const routes = [];
  const ctx = {
    webServer: { renderIndex: html => html },
    ...serviceContext,
    get: key => key === 'assistant' ? assistant : serviceContext.get?.(key),
    workspaceRegistry: { list: () => projects },
    connection: { fetch: { register: value => { routes.push(value); return () => {}; } } },
    effect: fn => fn(),
  };
  const start = () => mountLink(ctx, { directory, workbenchRoot: root, env: {}, testRelayConnection: async () => ({ ok: true, multipleHosts: true }),
    ...serviceContext.linkConfig });
  let link = await start();
  t.after(async () => { await link.close(); await rm(root, { recursive: true, force: true }); });
  const openCenter = async () => {
    const route = routes.findLast(route => route.path === '/api/commander-devices');
    const launchResponse = await route.fetch(new Request('http://127.0.0.1' + route.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'launch' }) }));
    assert.equal(launchResponse.status, 200);
    const launch = await launchResponse.json();
    const entry = await fetch(launch.url, { redirect: 'manual' });
    assert.equal(entry.status, 303);
    return new URL(entry.headers.get('location'), launch.url);
  };
  let base = await openCenter();
  const deviceApi = async input => {
    const response = await fetch(new URL('api/devices', base), {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base.origin }, body: JSON.stringify(input),
    });
    const value = await response.json();
    assert.equal(response.status, 200, value.error || 'device-center operation');
    return value;
  };
  return {
    get link() { return link; },
    ctx, directory, routes, deviceApi,
    async restart() { await link.close(); link = await start(); base = await openCenter(); },
  };
}

async function pair(source, target) {
  const invitation = await target.link.admin({ action: 'pairing', mode: 'lan' });
  const pending = await source.deviceApi({ action: 'pair', uri: invitation.uri });
  const requests = target.link.status().pending;
  assert.equal(requests.length, 1);
  await target.link.admin({ action: 'confirm', id: requests[0].id });
  const result = await source.deviceApi({ action: 'pairStatus', requestId: pending.requestId });
  assert.equal(result.status, 'approved');
  const saved = JSON.parse(await readFile(join(source.directory, 'outgoing', 'connections.json'), 'utf8')).devices.find(row => row.id === result.device.id);
  assert.equal(saved.routes.some(route => route.kind === 'direct' && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.url).hostname)), false, 'remote route advertisements must not include the host loopback');
  assert.equal(new URL(saved.url).hostname, '127.0.0.1', 'explicit local pairing endpoint remains usable independently of advertised routes');
  return result.device;
}

async function joinGroup(creator, peers) {
  for (const peer of peers) {
    const independent = peer.link.status().devices.map(device => device.id);
    const invitation = await peer.link.admin({ action: 'pairing', mode: 'lan' });
    const request = await creator.deviceApi({ action: 'pair', uri: invitation.uri, joinGroup: true });
    assert.equal(peer.link.status().pending[0].deviceGroup, true);
    await peer.link.admin({ action: 'confirm', id: peer.link.status().pending[0].id });
    assert.equal((await creator.deviceApi({ action: 'pairStatus', requestId: request.requestId })).direction, 'group');
    assert.deepEqual(peer.link.status().devices.map(device => device.id), independent, 'joining must preserve independent grants without creating one');
  }
}

async function waitForGroup(condition) {
  const deadline = Date.now() + 15_000;
  do {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail('device group changes did not propagate');
}

test('one mobile approval syncs every saved host asset and grants revocable access', async t => {
  if (!connectionAddresses().length) { t.skip('No non-loopback interface available'); return; }
  const terminalCalls = [];
  const windows = await host(t, 'Windows', [], null, { host: '::' }, { linkConfig: {
    deviceManagerFactory: async () => ({
      sshTarget() {}, state() {}, agentAvailable: () => false,
      openTerminal: async deviceId => { terminalCalls.push(['open', deviceId]); return { id: 'pty-1' }; },
      writeTerminal: async input => { terminalCalls.push(['write', input.deviceId, input.data]); return { ok: true }; },
      closeTerminal: async input => { terminalCalls.push(['close', input.deviceId]); return { ok: true }; },
      disconnect: async () => {}, close: async () => {},
    }),
  } });
  const peer = await host(t, '组内服务器', [], null, { host: '::' });
  const target = await host(t, 'A', [], null, { host: '::' });
  target.ctx.connection.createPeer = () => ({ dispose() {} });
  const invite = await target.link.admin({ action: 'pairing', mode: 'lan' });
  const outgoing = await windows.deviceApi({ action: 'pair', uri: invite.uri });
  await target.link.admin({ action: 'confirm', id: target.link.status().pending[0].id });
  assert.equal((await windows.deviceApi({ action: 'pairStatus', requestId: outgoing.requestId })).status, 'approved');
  const savedPath = join(windows.directory, 'outgoing', 'connections.json');
  const saved = JSON.parse(await readFile(savedPath, 'utf8'));
  saved.devices.push(...[...'BCDEFG'].map(name => ({ id: name, name, kind: 'ssh', url: '',
    ssh: { host: name + '.example', username: 'account', password: 'private-ssh-fixture' } })));
  await writeFile(savedPath, JSON.stringify(saved));
  await windows.restart();
  await joinGroup(windows, [peer]);

  const pairCode = await windows.link.admin({ action: 'pairing', mode: 'lan' });
  const pairAddress = new URL(pairCode.uri).searchParams;
  const sponsor = { url: pairAddress.get('url'), pin: pairAddress.get('pin') };
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = keys.publicKey.export({ format: 'der', type: 'spki' });
  const mobileId = 'sha256:' + createHash('sha256').update(key).digest('base64');
  const signed = value => sign('sha256', Buffer.from(JSON.stringify(value)), keys.privateKey).toString('base64');
  const { value: request } = await remoteJson(sponsor, '/link/api/pair', { code: pairCode.code, name: '手机', groupClientKey: key.toString('base64') });
  assert.equal(request.deviceGroup, true);
  assert.equal(windows.link.status().pending[0].deviceGroup, true);
  const poll = async () => (await remoteJson(sponsor, '/link/api/pair/status', request)).value;
  assert.equal((await poll()).status, 'pending');
  await windows.link.admin({ action: 'confirm', id: request.requestId });
  const approved = await poll();
  const rpc = async (host, token, input) => (await remoteJson(host, '/link/api/rpc', { action: 'deviceGroup', ...input }, { token })).value;
  const admit = proof => rpc(sponsor, approved.token, { operation: 'admitClient', proof });
  await assert.rejects(admit('wrong-signature'), { status: 403 });
  const proof = signed(['benchgo-group-client-v1', approved.hostId, approved.deviceId]);
  const directory = await admit(proof);
  assert.equal(directory.self.id, mobileId);
  assert.equal(directory.self.deviceType, 'mobile');
  assert.deepEqual(directory.assets.map(row => row.name).sort(), [...'ABCDEFG']);
  assert.ok(directory.members.some(row => row.id === peer.link.status().hostId));
  assert.doesNotMatch(JSON.stringify(directory), /private-ssh-fixture|token|B\.example/);
  assert.equal(windows.link.status().devices.some(row => row.id === approved.deviceId), false);
  const tokenFor = (hostId, sync = false) => {
    const claim = ['benchgo-group-auth-v1', directory.groupId, mobileId, hostId, Date.now() + 90_000, sync, directory.self.generation];
    return 'group.' + Buffer.from(JSON.stringify(claim)).toString('base64url') + '.' + signed(claim);
  };
  const sponsorRpc = input => rpc(sponsor, tokenFor(approved.hostId), input);
  const computer = directory.assets.find(row => row.name === 'A');
  const lease = await sponsorRpc({ operation: 'asset', command: 'workspace', assetId: computer.id });
  assert.match(lease.cookie, /HttpOnly.+Max-Age=120/);
  assert.equal(lease.hostId, target.link.status().hostId);
  const leaseCookie = lease.cookie.split(';')[0];
  const open = () => remoteJson(lease, '/link/workbench/device-center/api/devices', { action: 'list' }, { cookie: leaseCookie });
  assert.equal((await open()).value.devices[0].name, 'A');
  const { token: personalToken } = saved.devices[0];
  assert.ok(!JSON.stringify(lease).includes(personalToken));
  const ssh = directory.assets.find(row => row.name === 'B');
  assert.deepEqual(await sponsorRpc({ operation: 'asset', command: 'serverTerminal', assetId: ssh.id }), { id: 'pty-1' });
  await sponsorRpc({ operation: 'asset', command: 'serverTerminalWrite', assetId: ssh.id, id: 'pty-1', data: 'test' });
  await assert.rejects(sponsorRpc({ operation: 'asset', command: 'serverTerminalRead', assetId: directory.assets.find(row => row.name === 'C').id, id: 'pty-1' }), { status: 404 });
  await waitForGroup(async () => (await peer.deviceApi({ action: 'list' })).devices.filter(row => row.groupAsset).length === 7);
  const peerMember = directory.members.find(row => row.id === peer.link.status().hostId);
  const peerClient = await rpc(peerMember.routes[0], tokenFor(peerMember.id), { operation: 'directory' });
  assert.deepEqual(peerClient.assets.map(row => row.name).sort(), [...'ABCDEFG']);
  await windows.deviceApi({ action: 'rename', deviceId: 'C', name: 'C renamed' });
  await windows.deviceApi({ action: 'remove', deviceId: 'G' });
  const fresh = await sponsorRpc({ operation: 'directory' });
  assert.deepEqual(fresh.assets.map(row => row.name).sort(), ['A', 'B', 'C renamed', 'D', 'E', 'F']);
  await waitForGroup(async () => (await peer.deviceApi({ action: 'list' })).devices.some(row => row.name === 'C renamed'));
  await windows.deviceApi({ action: 'groupRemove', deviceId: mobileId });
  assert.deepEqual(terminalCalls, [['open', 'B'], ['write', 'B', 'test'], ['close', 'B']]);
  await assert.rejects(sponsorRpc({ operation: 'directory' }), { status: 401 });
  await assert.rejects(open(), { status: 401 });
  assert.deepEqual(await rpc(sponsor, tokenFor(approved.hostId, true), { operation: 'clientDirectory' }), { groupId: directory.groupId, revoked: true });
  await assert.rejects(admit(proof), { status: 403 });
  await windows.link.close();
  const next = await host(t, '新组员', [], null, { host: '::' });
  await joinGroup(peer, [next]);
  await waitForGroup(async () => {
    const assets = (await next.deviceApi({ action: 'list' })).devices.filter(row => row.groupAsset);
    return JSON.stringify(assets.map(row => row.name).sort()) === JSON.stringify(['A', 'B', 'C renamed', 'D', 'E', 'F']);
  });
});

test('one device-group owner token works through the relay and expires on every device after rotation', async t => {
  if (!connectionAddresses().length) { t.skip('No non-loopback interface available'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-owner-relay-'));
  const relayIdentity = await loadIdentity(directory);
  const port = await freePort();
  const publicUrl = `https://127.0.0.1:${port}`;
  const relayKey = 'test-integration-relay-key';
  const relay = await createRelayServer({ host: '127.0.0.1', port, publicUrl, identity: relayIdentity, token: relayKey });
  t.after(async () => { await relay.close(); await rm(directory, { recursive: true, force: true }); });

  async function member(name, useRelay) {
    const values = new Map(), records = new Map(), fetchRoutes = new Map();
    const credentials = {
      readRecord: async key => records.get(key),
      async modifyRecord(key, mutate) {
        const value = await mutate(records.get(key));
        if (value !== undefined) records.set(key, value);
      },
    };
    const device = await host(t, name, [], null, { host: '::', ...(useRelay ? { relayPool: [{ url: publicUrl, token: relayKey, enabled: true, priority: 0 }] } : {}) }, {
      get: key => values.get(key), credentials,
      linkConfig: { createRelayHost: input => createRelayHost({ ...input, relayCa: relayIdentity.cert }) },
    });
    values.set('benchgoLink', device.link);
    const owner = { principal: { kind: 'owner' } };
    let webHandler;
    let enabled = true;
    mountIntegrationApi({
      get: key => values.get(key), provide: (key, value) => values.set(key, value), credentials,
      effect: operation => operation(), inject: (_services, mount) => mount({
        effect: operation => operation(), webServer: { register(route) { webHandler = route.handler; } },
      }),
      connection: {
        fetch: { register: route => fetchRoutes.set(route.path, route) }, browserPeer: owner,
        createSharedFetchHandler: () => ({ async fetch(request, peer) {
          assert.equal(peer, owner);
          assert.equal(new URL(request.url).pathname, '/api/commander/assistant');
          return Response.json({ device: name, input: await request.json() });
        } }),
      },
    }, () => enabled);
    async function token(operation = 'read', revision) {
      const path = '/api/commander-integration/token';
      const response = await fetchRoutes.get(path).fetch(new Request('https://benchgo.invalid' + path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, revision }),
      }));
      return { status: response.status, ...await response.json() };
    }
    return { ...device, token, webHandler, setEnabled: value => { enabled = value; } };
  }

  const a = await member('A', false), b = await member('B', true);
  await joinGroup(a, [b]);
  await waitForGroup(() => Boolean(b.link.integrationEndpoint()?.relay));
  const original = await a.token();
  const remote = await b.token();
  assert.equal(remote.status, 200);
  assert.equal(remote.token, original.token);
  assert.equal(remote.endpoint.url, `${publicUrl}/link/api/rpc`);
  const input = { path: '/api/commander/assistant', body: { action: 'tasks' } };
  const agent = new Agent({ ca: relayIdentity.cert });
  t.after(() => agent.destroy());
  async function request(token, body = input) {
    try {
      const result = await remoteJson({ url: publicUrl, relayTarget: remote.endpoint.relayTarget }, '/link/api/rpc', body, { token, agent });
      return result.value;
    } catch (error) { return { status: error.status, message: error.message }; }
  }
  assert.equal((await request(undefined)).status, 401);
  assert.deepEqual(await request(original.token), { device: 'B', input: input.body });
  assert.equal((await request(original.token, { path: '/api/commander-integration/token', body: { operation: 'rotate' } })).status, 403);
  const rotated = await b.token('rotate', original.revision);
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.token, original.token);
  assert.equal((await a.token()).token, rotated.token);
  assert.equal((await a.token('rotate', original.revision)).status, 409);
  assert.equal((await request(original.token)).status, 401);
  assert.deepEqual(await request(rotated.token), { device: 'B', input: input.body });
  const web = createHttpServer(a.webHandler);
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => web.close(resolve)));
  const direct = `http://127.0.0.1:${web.address().port}/api/commander-integration`;
  const directCall = token => fetch(direct, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(input) });
  const directResponse = await directCall(rotated.token);
  assert.equal(directResponse.status, 200);
  assert.deepEqual(await directResponse.json(), { device: 'A', input: input.body });
  assert.equal((await directCall(original.token)).status, 401);
  b.setEnabled(false);
  assert.equal((await request(rotated.token)).status, 401);
  b.setEnabled(true);

  const authorityPort = a.link.status().port;
  await a.link.close();
  const identity = await loadIdentity(a.directory);
  const group = await openDeviceGroup(a.directory, identity);
  const legacy = createHttpsServer({ key: identity.key, cert: identity.cert }, async (req, res) => {
    const device = group.authenticate(req.headers.authorization?.replace(/^Bearer /, ''));
    if (!device?.groupSyncOnly) { res.writeHead(401).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (input.action === 'deviceGroup' && input.operation === 'sync') {
      res.end(JSON.stringify({ manifest: group.snapshot(), removals: group.removals() }));
    } else {
      res.writeHead(403).end(JSON.stringify({ error: '此授权仅用于同步设备组' }));
    }
  });
  await new Promise((resolve, reject) => legacy.once('error', reject).listen(authorityPort, '::', resolve));
  t.after(() => new Promise(resolve => legacy.close(resolve)));
  assert.deepEqual(await b.token(), {
    status: 503, code: 'INTEGRATION_PEER_UPGRADE_REQUIRED',
    error: '请更新 Token 管理设备「A」上的 BenchGo，更新后重试',
  });
});

test('device group peers can access one another while the creator is offline', async t => {
  if (!connectionAddresses().length) { t.skip('No non-loopback interface available'); return; }
  const a = await host(t, 'A', [], null, { host: '::' });
  const b = await host(t, 'B', [{ id: 'b-project', title: 'B', sessionIds: [] }], null, { host: '::' });
  const c = await host(t, 'C', [{ id: 'c-project', title: 'C', sessionIds: [] }], null, { host: '::' });
  await joinGroup(a, [b]);
  assert.equal((await b.deviceApi({ action: 'groupStatus' })).canInvite, true);
  await joinGroup(b, [c]);
  const target = async (source, peer) => (await source.link.devices()).devices.find(row => row.hostId === peer.link.status().hostId);
  await waitForGroup(() => target(b, c));
  await a.link.close();
  const cOnB = await target(b, c);
  const bOnC = await target(c, b);
  const projectIds = async (source, device) => (await source.link.resources({ deviceId: device.id, kind: 'projects' })).devices[0].items.map(row => row.resourceId);
  assert.deepEqual(await projectIds(b, cOnB), ['c-project']);
  assert.deepEqual(await projectIds(c, bOnC), ['b-project']);
  await b.deviceApi({ action: 'groupRemove', deviceId: cOnB.id });
  await waitForGroup(async () => !(await c.deviceApi({ action: 'groupStatus' })).enabled);
  assert.equal(await target(b, c), undefined);
  assert.equal(await target(c, b), undefined);
});

test('the device center uses group authorization for a server already registered over SSH', async t => {
  if (!connectionAddresses().length) { t.skip('No non-loopback interface available'); return; }
  const a = await host(t, 'A', [], null, { host: '::' });
  const b = await host(t, '服务器 B', [{ id: 'b-project', title: 'B', sessionIds: [] }], null, { host: '::' });
  const hostId = b.link.status().hostId;
  const id = 'saved-ssh';
  await writeFile(join(a.directory, 'outgoing', 'connections.json'), JSON.stringify({
    version: 1, activeId: id, devices: [{ id, hostId, kind: 'ssh', url: '', name: '旧 SSH 名称',
      authorizationId: 'old-authorization', token: 'a-revoked-credential', ssh: { host: 'server.example' } }],
  }));
  await a.restart();
  await joinGroup(a, [b]);
  const { devices } = await a.deviceApi({ action: 'list' });
  const matching = devices.filter(device => device.hostId === hostId);
  assert.equal(matching.length, 1);
  const [device] = matching;
  assert.equal(device.id, id);
  assert.equal(device.kind, 'ssh');
  assert.equal(device.name, '服务器 B');
  assert.equal(device.sshManaged, true);
  assert.equal(device.authorizationId, a.link.status().hostId);
  const result = await a.link.resources({ deviceId: id, kind: 'projects' });
  assert.deepEqual(result.devices[0].items.map(row => row.resourceId), ['b-project']);
  await a.deviceApi({ action: 'groupRemove', deviceId: id });
  assert.equal((await a.link.devices()).devices.some(device => device.hostId === hostId), false);
  assert.equal((await a.link.resources({ deviceId: id, kind: 'projects' })).devices[0].code, 'NOT_FOUND');
});

test('removing C on A updates B and revokes C even when C is offline', async t => {
  if (!connectionAddresses().length) { t.skip('No non-loopback interface available'); return; }
  const a = await host(t, 'A', [], null, { host: '::' });
  const b = await host(t, 'B', [], null, { host: '::' });
  const c = await host(t, 'C', [], null, { host: '::' });
  await joinGroup(a, [b, c]);
  const bId = b.link.status().hostId, cId = c.link.status().hostId;
  const names = async host => (await host.deviceApi({ action: 'list' })).devices.map(row => row.name).sort();
  await waitForGroup(async () => (await names(b)).includes('C'));
  const cGroup = await openDeviceGroup(c.directory, await loadIdentity(c.directory));
  const oldGrant = { ...cGroup.member(bId).routes[0], token: cGroup.token(bId) };
  assert.equal((await remoteJson(oldGrant, '/link/api/info')).value.authorizationId, cId);

  await c.link.close();
  await a.deviceApi({ action: 'groupRemove', deviceId: cId });
  await waitForGroup(async () => !(await names(b)).includes('C'));
  assert.deepEqual(await names(a), ['A', 'B']);
  assert.deepEqual(await names(b), ['A', 'B']);
  await assert.rejects(remoteJson(oldGrant, '/link/api/info'), { status: 401 });
  await c.restart();
  await waitForGroup(async () => (await c.link.devices()).devices.length === 1);
  assert.deepEqual((await c.link.devices()).devices.map(row => row.name), ['C']);
  assert.deepEqual(await names(b), ['A', 'B']);
});

test('a group device rename reaches an offline member and survives a restart', async t => {
  if (!connectionAddresses().length) { t.skip('No non-loopback interface available'); return; }
  const a = await host(t, 'A', [], null, { host: '::', port: await freePort() });
  const b = await host(t, 'B', [], null, { host: '::', port: await freePort() });
  const c = await host(t, 'C', [], null, { host: '::', port: await freePort() });
  await joinGroup(a, [b, c]);
  const bId = b.link.status().hostId;
  const bOn = async source => (await source.link.devices()).devices.find(row => row.hostId === bId);
  await waitForGroup(() => bOn(c));

  await c.link.close();
  const aIdentity = await loadIdentity(a.directory);
  const oldSnapshot = (await openDeviceGroup(a.directory, aIdentity)).snapshot();
  assert.equal(oldSnapshot.renames, undefined);
  const changed = await a.deviceApi({ action: 'groupRename', deviceId: bId, name: '开发服务器' });
  assert.equal(changed.device.name, '开发服务器');
  const aGroup = await openDeviceGroup(a.directory, aIdentity);
  assert.deepEqual(aGroup.snapshot().operations, oldSnapshot.operations);
  assert.deepEqual(aGroup.snapshot().renames.map(({ target, name }) => ({ target, name })), [
    { target: bId, name: '开发服务器' },
  ]);
  await aGroup.adopt(oldSnapshot);
  assert.equal(aGroup.member(bId).name, '开发服务器');
  assert.deepEqual(aGroup.snapshot().members, oldSnapshot.members);
  await waitForGroup(() => b.link.status().hostName === '开发服务器');
  assert.equal((await b.link.devices()).devices.find(row => row.id === 'local').name, '开发服务器');

  await b.restart();
  assert.equal(b.link.status().hostName, '开发服务器');
  await c.restart();
  await waitForGroup(async () => (await bOn(c))?.name === '开发服务器');
  assert.equal((await bOn(c)).id, bId);
  assert.equal((await c.link.resources({ deviceId: bId, kind: 'projects' })).devices[0].available, true);
});

test('the creator can leave without breaking the remaining device group', async t => {
  if (!connectionAddresses().length) { t.skip('No non-loopback interface available'); return; }
  const member = async name => host(t, name, [], null, { host: '::', port: await freePort() });
  const a = await member('A');
  const b = await member('B');
  const c = await member('C');
  const d = await member('D');
  await joinGroup(a, [b, c]);
  const oldGroupId = (await a.deviceApi({ action: 'groupStatus' })).id;
  await waitForGroup(async () => (await b.link.devices()).devices.some(row => row.name === 'C'));
  await b.link.close();
  await c.link.close();
  assert.equal((await a.deviceApi({ action: 'groupLeave' })).enabled, false);
  await joinGroup(a, [d]);
  await a.restart();
  await b.restart();
  await c.restart();
  const deadline = Date.now() + 15000;
  for (const [source, peer] of [[b, c], [c, b]]) {
    let devices;
    do {
      devices = (await source.link.devices()).devices;
      if (devices.length === 2 && devices.some(row => row.hostId === peer.link.status().hostId)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.deepEqual(devices.map(row => row.name).sort(), ['B', 'C']);
    const target = devices.find(row => row.hostId === peer.link.status().hostId);
    assert.equal((await source.link.resources({ deviceId: target.id, kind: 'projects' })).devices[0].available, true);
  }
  const regrouped = await a.deviceApi({ action: 'groupStatus' });
  assert.notEqual(regrouped.id, oldGroupId);
  assert.deepEqual(regrouped.members.map(row => row.name).sort(), ['A', 'D']);
  assert.equal((await d.deviceApi({ action: 'groupStatus' })).id, regrouped.id);
});

test('relay configuration from a group member reaches the whole group including an offline peer', async t => {
  if (!connectionAddresses().length) { t.skip('No non-loopback interface available'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-group-relays-'));
  const trusted = getCACertificates('default');
  const relays = [];
  t.after(async () => {
    setDefaultCACertificates(trusted);
    await Promise.all(relays.map(relay => relay.close()));
    await rm(directory, { recursive: true, force: true });
  });
  const relayIdentity = await loadIdentity(directory);
  setDefaultCACertificates([...trusted, relayIdentity.cert]);
  const token = 'test-group-relay-key';
  const relayUrl = async () => {
    const port = await freePort();
    const publicUrl = `https://127.0.0.1:${port}`;
    relays.push(await createRelayServer({ host: '127.0.0.1', port, publicUrl, identity: relayIdentity, token }));
    return publicUrl;
  };
  const options = { linkConfig: { createRelayHost: input => createRelayHost({ ...input, relayCa: relayIdentity.cert }) } };
  const a = await host(t, 'A', [], null, { host: '::' }, options);
  const b = await host(t, 'B', [], null, { host: '::' }, options);
  b.ctx.connection.createPeer = () => ({ dispose() {} });
  const c = await host(t, 'C', [], null, { host: '127.0.0.1' }, options);
  await joinGroup(a, [b]);
  const initialUrl = await relayUrl(), nextUrl = await relayUrl();
  const configure = (host, edit) => host.link.admin({ action: 'relay-pool-configure',
    expected: { fingerprint: host.link.status().relay.fingerprint }, id: 'shared', ...edit });
  const onRelay = (peer, url) => peer.link.status().relay.connected && peer.link.status().relay.url === url;
  await configure(b, { operation: 'add', url: initialUrl, token });
  await waitForGroup(() => [a, b].every(peer => onRelay(peer, initialUrl)));
  const invite = await b.link.admin({ action: 'pairing', mode: 'relay' });
  const request = await c.deviceApi({ action: 'pair', uri: invite.uri, joinGroup: true });
  await b.link.admin({ action: 'confirm', id: b.link.status().pending[0].id });
  assert.equal((await c.deviceApi({ action: 'pairStatus', requestId: request.requestId })).direction, 'group');
  await waitForGroup(() => [a, b, c].every(peer => onRelay(peer, initialUrl)));
  await waitForGroup(async () => (await a.link.devices()).devices.length === 3);
  const cOnA = (await a.link.devices()).devices.find(row => row.name === 'C');
  assert.equal((await a.link.resources({ deviceId: cOnA.id, kind: 'projects' })).devices[0].available, true);
  assert.equal(JSON.stringify(a.link.status()).includes(token), false);
  for (const peer of [a, b, c]) await peer.link.admin({ action: 'configure', host: '127.0.0.1' });
  await waitForGroup(() => [a, b, c].every(peer => onRelay(peer, initialUrl)));

  const bId = b.link.status().hostId;
  const group = await openDeviceGroup(a.directory, await loadIdentity(a.directory));
  const proxy = await createDeviceProxy({ url: initialUrl, relayTarget: bId, token: group.token(bId) });
  t.after(() => proxy.close());
  const entry = await fetch(proxy.enter(), { redirect: 'manual' });
  assert.equal(entry.status, 303);
  const base = new URL(entry.headers.get('location'), proxy.origin);
  const relayPost = (path, action) => fetch(new URL(path, base), {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base.origin },
    body: JSON.stringify({ action, parentOrigin: base.origin }),
  });
  const directoryResponse = await relayPost('api/group-resources', 'devices');
  const directoryResult = await directoryResponse.json();
  assert.equal(directoryResponse.status, 200, directoryResult.error);
  assert.deepEqual(directoryResult.devices.map(row => row.name).sort(), ['A', 'B', 'C']);
  assert.equal((await relayPost('api/group-resources', 'launch')).status, 403);
  assert.equal((await relayPost('api/commander-devices', 'devices')).status, 404);

  await c.link.close();
  await configure(b, { operation: 'update', url: nextUrl, token });
  await waitForGroup(() => [a, b].every(peer => onRelay(peer, nextUrl)));
  await c.restart();
  await waitForGroup(() => onRelay(c, nextUrl));
  await configure(a, { operation: 'update', enabled: false });
  await configure(a, { operation: 'remove' });
  await waitForGroup(() => [b, c].every(host => !host.link.status().relay.configured));
});

test('device group synchronizes RouterGo connections and preserves deletion across an offline restart', async t => {
  if (!connectionAddresses().length) { t.skip('No non-loopback interface available'); return; }
  const personal = 'routergo-' + 'a'.repeat(32);
  const work = 'routergo-' + 'b'.repeat(32);
  async function providerHost(name) {
    const providers = {};
    const records = new Map(), credentials = new Map();
    let revision = 1;
    const ctx = {
      settings: {
        describe: () => [{ ns: 'llm-pi-ai', revision, value: { providers: structuredClone(providers) } }],
        async mutate(namespace, operations, expectedRevision) {
          assert.equal(namespace, 'llm-pi-ai');
          if (expectedRevision !== revision) throw new Error('Settings revision changed');
          for (const { op, path: [, id], value } of operations) {
            if (op === 'unset') delete providers[id];
            else providers[id] = structuredClone(value);
          }
          revision++;
        },
      },
      credentials: {
        resolve: async ref => credentials.get(ref),
        set: async (ref, value) => credentials.set(ref, { value, source: 'file' }),
        unset: async ref => credentials.delete(ref),
        readRecord: async key => structuredClone(records.get(key)),
        modifyRecord: async (key, update) => records.set(key, structuredClone(update(records.get(key)))),
      },
      llm: {
        listConfigurableProviders: () => Object.keys(providers).map(provider => ({
          provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider],
        })),
      },
    };
    let groupProviders = createGroupProviders(ctx);
    ctx.get = name => name === 'benchgoGroupProviders' ? groupProviders : undefined;
    const peer = await host(t, name, [], null, { host: '::' }, ctx);
    return {
      peer, providers, credentials, modelProviders: createModelProviders(ctx),
      bindings: groupId => groupProviders.bindings(groupId),
      async configure(id, displayName, key) {
        const apiKeyEnv = 'BENCHGO_ROUTERGO_KEY_' + id.slice('routergo-'.length);
        await ctx.credentials.set(apiKeyEnv, key);
        await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', id], value: {
          displayName, apiKeyEnv, baseURL: 'https://routergo.cn/api/v1', api: 'openai-responses',
          models: [{ id: 'Vendor/Exact:Model' }],
        } }], revision);
      },
      remove: id => ctx.settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', id] }], revision),
      rename: (id, displayName) => ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', id],
        value: { ...providers[id], displayName } }], revision),
      async restart() {
        groupProviders = createGroupProviders(ctx);
        await peer.restart();
      },
    };
  }

  async function waitFor(condition, label) {
    const deadline = Date.now() + 20_000;
    do {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.fail(label);
  }

  const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(providerHost));
  for (const target of [b, c]) {
    const invitation = await target.peer.link.admin({ action: 'pairing', mode: 'lan' });
    const request = await a.peer.deviceApi({ action: 'pair', uri: invitation.uri, joinGroup: true });
    await target.peer.link.admin({ action: 'confirm', id: target.peer.link.status().pending[0].id });
    const joined = await a.peer.deviceApi({ action: 'pairStatus', requestId: request.requestId });
    assert.equal(joined.direction, 'group');
  }
  await a.configure(personal, '个人账号', 'fixture-personal-model-key');
  await b.configure(work, '工作账号', 'fixture-work-model-key');
  const workSourceRef = b.providers[work].apiKeyEnv;
  const workTokenRef = workSourceRef.replace('_KEY_', '_ACCOUNT_');
  b.credentials.set(workTokenRef, { value: 'fixture-work-account-token', source: 'file' });
  await waitFor(() => [a, b, c].every(member => member.providers[personal] && member.providers[work]), 'both RouterGo accounts reach every member');
  const { id: groupId } = await a.peer.deviceApi({ action: 'groupStatus' });

  for (const member of [b, c]) {
    assert.equal((await member.bindings(groupId)).get(personal), personal);
    assert.equal((await member.bindings(groupId)).get(work), work);
    assert.deepEqual((await member.modelProviders.list()).map(row => row.name).sort(), ['个人账号', '工作账号']);
    assert.equal((await member.modelProviders.resolve(personal)).apiKey, 'fixture-personal-model-key');
    assert.equal((await member.modelProviders.resolve(work)).apiKey, 'fixture-work-model-key');
    assert.equal(member.providers[work].models[0].id, 'Vendor/Exact:Model');
  }

  const staleRef = c.providers[work].apiKeyEnv;
  await c.peer.link.close();
  await c.rename(work, '离线修改');
  await a.remove(work);
  await waitFor(() => !b.providers[work] && !b.credentials.has(workSourceRef) && !b.credentials.has(workTokenRef),
    'A sends the deletion to B and B clears its RouterGo authorization while C is offline');
  await a.peer.link.close();
  await c.restart();
  await waitFor(() => !c.providers[work] && !c.credentials.has(staleRef), 'B replays the deletion to C after restart');
  assert.deepEqual(Object.keys(b.providers), [personal]);
  assert.deepEqual(Object.keys(c.providers), [personal]);
  assert.equal((await c.modelProviders.resolve(personal)).apiKey, 'fixture-personal-model-key');
});

test('media settings converge across the device group and catch up after an offline restart', async t => {
  if (!connectionAddresses().length) { t.skip('No non-loopback interface available'); return; }
  async function mediaHost(name, route) {
    const directory = await mkdtemp(join(tmpdir(), 'benchgo-media-group-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const voice = await new VoiceConfig({ dataDir: directory }).open();
    const generation = await createMediaGeneration({ directory });
    const records = new Map();
    const credentials = {
      readRecord: async key => structuredClone(records.get(key)),
      modifyRecord: async (key, update) => records.set(key, structuredClone(update(records.get(key)))),
      deleteRecord: async key => records.delete(key),
    };
    const bindings = new Map([['shared-provider', route]]);
    const makeService = () => createGroupMedia({ voice, generation, credentials, providerBindings: async () => bindings });
    let service = makeService();
    const peer = await host(t, name, [], null, { host: '::' }, { get: key => key === 'benchgoGroupMedia' ? service : undefined });
    return { peer, voice, generation, bindings,
      async restart() { service = makeService(); await peer.restart(); },
      async update(patch) { await generation.updateSettings(patch, (await generation.getSettings()).revision); },
    };
  }
  async function waitFor(condition, description) {
    const deadline = Date.now() + 20_000;
    do {
      if (await condition()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.fail(description);
  }
  const [a, b] = await Promise.all([mediaHost('A', 'routergo-a'), mediaHost('B', 'routergo-b')]);
  b.bindings.clear();
  await a.update({
    image: { enabled: true, routes: [{ providerId: 'routergo-a', modelId: 'Vendor/Image:01', size: '1024x1024' }] },
    video: { enabled: false, routes: [{ providerId: 'routergo-a', modelId: 'Vendor/Video:02' }] },
    audio: { enabled: true, routes: [{ providerId: 'routergo-a', modelId: 'Vendor/Audio:03', voices: [{ name: 'voice-1' }] }] },
  });
  await a.voice.configure({ call: true, asr: { baseURL: 'https://speech.example/v1', model: 'ASR:01', apiKey: 'fixture-asr' },
    conversation: { providerId: 'routergo-a', model: 'Vendor/Call:04' } });
  await b.voice.configure({ readAloud: true, tts: { baseURL: 'https://speech.example/v1', model: 'TTS:01', apiKey: 'fixture-tts', voice: 'voice-2', speed: 1.35 } });
  await joinGroup(a.peer, [b.peer]);
  await waitFor(() => b.voice.value.asr.apiKey === 'fixture-asr' && a.voice.value.tts.apiKey === 'fixture-tts', 'independent voice sections and credentials converge');
  assert.deepEqual((await b.generation.getSettings()).image.routes, []);
  assert.equal(b.voice.value.conversation.providerId, '');
  b.bindings.set('shared-provider', 'routergo-b');
  await waitFor(async () => (await b.generation.getSettings()).audio.enabled && b.voice.value.conversation.providerId === 'routergo-b', 'provider bindings unblock pending media settings');
  const loaded = await b.generation.getSettings();
  assert.deepEqual(loaded.image.routes, [{ providerId: 'routergo-b', modelId: 'Vendor/Image:01', size: '1024x1024' }]);
  assert.deepEqual(loaded.video, { enabled: false, routes: [{ providerId: 'routergo-b', modelId: 'Vendor/Video:02' }] });
  assert.equal(loaded.audio.routes[0].defaultVoice, 'voice-1');
  assert.equal(b.voice.value.conversation.model, 'Vendor/Call:04');
  assert.doesNotMatch(JSON.stringify(b.voice.snapshot()), /fixture-asr|fixture-tts/);
  assert.equal(b.voice.value.call, true);
  assert.equal(a.voice.value.readAloud, true);

  await b.peer.link.close();
  await a.update({ image: { enabled: false, routes: [] } });
  await b.update({ image: { ...loaded.image, routes: [{ ...loaded.image.routes[0], quality: 'high' }] } });
  await a.voice.configure({ asr: { apiKey: '' } });
  await b.voice.configure({ tts: { speed: 1.5 } });
  await b.restart();
  await waitFor(async () => !(await b.generation.getSettings()).image.routes.length && b.voice.value.asr.apiKey === ''
    && a.voice.value.tts.speed === 1.5, 'offline member receives removals while its separate edit reaches the group');
  await b.peer.deviceApi({ action: 'groupLeave' });
  await waitFor(async () => !(await b.generation.getSettings()).audio.routes.length && !b.voice.value.asr.baseURL, 'leaving restores local settings');
  assert.equal(b.voice.value.tts.apiKey, 'fixture-tts');
  assert.equal(b.voice.value.tts.speed, 1.5);
});

test('one approval pairs both Link hosts over real TLS and each host can revoke its grant', async t => {
  if (!connectionAddresses().length) { t.skip('No non-loopback interface available'); return; }
  const a = await host(t, 'A', [{ id: 'a-project', title: 'A project', path: '/a/work', sessionIds: [] }], null, { host: '::' });
  const b = await host(t, 'B', [{ id: 'b-project', title: 'B project', path: '/b/work', sessionIds: [] }], null);
  for (const peer of [a, b]) {
    const get = peer.ctx.get;
    peer.ctx.get = name => name === 'benchgoExecution' ? { dispatch: async (input, access) => ({
      version: 2, available: true, operation: input.operation, sourceHost: access.verifiedSourceHostId ?? null,
    }) } : get(name);
  }
  const invitation = await b.deviceApi({ action: 'hostPairing', mode: 'lan' });
  const invitationStatus = () => b.deviceApi({ action: 'hostStatus', activePairingCode: invitation.code });
  assert.equal((await invitationStatus()).pairingActive, true);
  const pending = await a.deviceApi({ action: 'pair', uri: invitation.uri });
  assert.deepEqual(await a.deviceApi({ action: 'pairStatus', requestId: pending.requestId }), { status: 'pending' });
  assert.equal(a.link.status().devices.length, 0);
  assert.equal(b.link.status().devices.length, 0);
  const scanned = await invitationStatus();
  assert.equal(scanned.pairingActive, false);
  const [request] = scanned.pending;
  const next = await b.deviceApi({ action: 'hostPairing', mode: 'lan' });
  assert.notEqual(next.code, invitation.code);
  assert.deepEqual((await invitationStatus()).pending, [request]);
  assert.equal(request.reciprocal, true);
  assert.deepEqual(a.link.status().pending, []);
  await b.link.admin({ action: 'confirm', id: request.id });
  const finish = () => a.deviceApi({ action: 'pairStatus', requestId: pending.requestId });
  const [forward, duplicate] = await Promise.all([finish(), finish()]);
  assert.equal(forward.direction, 'mutual');
  assert.deepEqual(duplicate, forward);
  assert.equal(a.link.status().devices.length, 1);
  assert.equal(b.link.status().devices.length, 1);
  const back = (await b.link.devices()).devices.find(device => device.name === 'A');
  assert.equal(back.hostId, a.link.status().hostId);
  assert.equal(back.authorizationId, a.link.status().devices[0].id);
  assert.equal(a.link.status().devices[0].pairingReturn, 'mutual');
  assert.equal(b.link.status().devices[0].pairingReturn, 'mutual');
  assert.equal(b.link.status().devices[0].id, (await a.link.devices()).devices.find(device => device.id === forward.device.id).authorizationId);
  const projects = async (source, id) => (await source.link.resources({ deviceId: id, kind: 'projects' })).devices[0];
  assert.deepEqual((await projects(a, forward.device.id)).items.map(project => project.resourceId), ['b-project']);
  assert.deepEqual((await projects(b, back.id)).items.map(project => project.resourceId), ['a-project']);
  const execution = (source, target, operation = 'catalog') => source.link.callDevice({
    deviceId: target.id, expectedHostId: target.hostId, expectedAuthorizationId: target.authorizationId,
    input: { action: 'execution', version: 2, operation, ...(operation === 'submit'
      ? { executionId: 'execution-' + source.link.status().hostName, identity: { ownerHostId: 'business-host' } } : {}) },
  });
  for (const [source, target] of [[a, forward.device], [b, back]]) {
    const capabilities = (await source.link.resources({ deviceId: target.id, kind: 'capabilities' })).devices[0].items;
    assert.equal(capabilities.find(item => item.id === 'reverse').available, true);
    assert.equal((await execution(source, target)).available, true);
    const submitted = await execution(source, target, 'submit');
    assert.equal(submitted.operation, 'submit');
    assert.equal(submitted.sourceHost, source.link.status().hostId);
  }
  await a.link.admin({ action: 'revoke', id: back.authorizationId });
  assert.equal((await projects(b, back.id)).code, 'UNAUTHORIZED');
  await assert.rejects(execution(b, back), error => error.statusCode === 401 || error.code === 'UNAUTHORIZED');
  assert.deepEqual((await projects(a, forward.device.id)).items.map(project => project.resourceId), ['b-project']);
  await b.link.admin({ action: 'revoke', id: b.link.status().devices[0].id });
  assert.equal((await projects(a, forward.device.id)).code, 'UNAUTHORIZED');
});

test('an unreachable return route leaves a usable one-way pairing without a reverse grant', async t => {
  const a = await host(t, 'A', [], null, { publicUrl: 'https://pairing-link-test.invalid' });
  const b = await host(t, 'B', [{ id: 'b-project', title: 'B project', path: '/b/work', sessionIds: [] }], null);
  const invitation = await b.link.admin({ action: 'pairing' });
  const pending = await a.deviceApi({ action: 'pair', uri: invitation.uri });
  const [request] = b.link.status().pending;
  assert.equal(request.reciprocal, true);
  await b.link.admin({ action: 'confirm', id: request.id });
  const result = await a.deviceApi({ action: 'pairStatus', requestId: pending.requestId });
  assert.equal(result.direction, 'unreachable');
  assert.match(result.device.pairingNotice, /单向连接/);
  assert.equal((await b.link.devices()).devices.length, 1);
  assert.equal(b.link.status().devices[0].pairingReturn, 'unreachable');
  assert.equal(a.link.status().devices.length, 0);
  assert.deepEqual((await a.link.resources({ deviceId: result.device.id, kind: 'projects' })).devices[0].items.map(project => project.resourceId), ['b-project']);
  const capabilities = (await a.link.resources({ deviceId: result.device.id, kind: 'capabilities' })).devices[0].items;
  assert.equal(capabilities.find(item => item.id === 'reverse').available, false);
});

test('a legacy peer that ignores the return offer still completes one-way pairing', async t => {
  const a = await host(t, 'A', [], null, { publicUrl: 'https://pairing-link-test.invalid' });
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-legacy-pairing-'));
  const store = await openStore(directory), identity = await loadIdentity(directory);
  const config = validateConfig({ enabled: true, host: '127.0.0.1', port: 0 }, store.state);
  const server = await listen({ identity, config, webRoot: new URL('../dist/web/', import.meta.url), store,
    routes: () => [], dispatch: async input => ({ action: input.action }), onError: () => {} });
  t.after(async () => { await server.close(); await store.flush(); await rm(directory, { recursive: true, force: true }); });
  const invitation = store.begin();
  const query = new URLSearchParams({ url: 'https://127.0.0.1:' + server.port, pin: identity.pin, code: invitation.code });
  const pending = await a.deviceApi({ action: 'pair', uri: 'benchgo://pair?' + query });
  const [request] = store.pending();
  assert.equal(request.reciprocal, false);
  await store.decide(request.id, true);
  const result = await a.deviceApi({ action: 'pairStatus', requestId: pending.requestId });
  assert.equal(result.direction, 'remote-unavailable');
  assert.match(result.device.pairingNotice, /未支持双向配对/);
  assert.equal(a.link.status().devices.length, 0);
  assert.deepEqual(await a.link.callDevice({ deviceId: result.device.id, input: { action: 'state' } }), { action: 'state' });
});

async function sessionHost(t, name) {
  const project = { id: 'same-project', title: `${name} project`, path: `/${name}/work`, sessionIds: ['same-session'] };
  const hidden = new Set(), hostValue = await host(t, name, [project], { sidebarPrivateSessionIds: async () => [...hidden] });
  const calls = [], rows = [{ sessionId: 'same-session', updatedAt: 10, projections: { values: { title: `${name} session` } } }];
  const nativeRows = new Map([['same-native', { id: 'same-native', projectId: project.id, cwd: project.path, ownerSessionId: 'commander-web:detached:owner', provider: 'codex', status: 'idle' }]]);
  const commander = {
    list: () => [...nativeRows.values()],
    async archive(id, archived) { calls.push(['native', archived ? 'archive' : 'unarchive', id]); nativeRows.get(id).archived = archived; },
    async remove(id) { calls.push(['native', 'delete', id]); nativeRows.delete(id); },
  };
  const services = { commander, benchgo: { directory: join(hostValue.directory, '..') }, sessionTitle: {}, sessionController: { rename() {} }, workspaceController: Object.fromEntries(['pinSession', 'unpinSession', 'archiveSession', 'unarchiveSession'].map(method => [method, () => {}])) };
  const get = hostValue.ctx.get;
  hostValue.ctx.get = name => services[name] ?? get(name);
  hostValue.ctx.connection.createPeer = () => ({ dispose() {} });
  hostValue.ctx.connection.createSharedFetchHandler = () => ({ fetch: request => hostValue.routes.find(route => route.path === new URL(request.url).pathname).fetch(request) });
  hostValue.ctx.typertGateway = {
    async invoke({ namespace, method, args }) {
      if (method === 'list') return { items: rows };
      calls.push([namespace, method, args.request]);
      if (method === 'archiveSession' && rows.find(row => row.sessionId === args.request.sessionId)?.running && args.request.stopActivity !== true) {
        throw Object.assign(new Error('Session is active'), { code: 'workspace/session-active' });
      }
      if (method === 'rename') { rows[0].projections.values.title = args.request.title; return { title: args.request.title }; }
      const key = ['pinSession', 'unpinSession'].includes(method) ? 'pinnedSessionIds' : 'archivedSessionIds';
      const ids = hostValue.ctx.workspaceRegistry[key] ?? [];
      hostValue.ctx.workspaceRegistry[key] = ['pinSession', 'archiveSession'].includes(method) ? [...new Set([...ids, args.request.sessionId])] : ids.filter(id => id !== args.request.sessionId);
      return {};
    },
    wireStream: { open: async (_endpoint, _payload, _uplink, _peer, signal) => (async function* () {
      yield { type: 'ready', clientId: 'client' };
      await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    })() },
  };
  await mountWeb(hostValue.ctx, { directory: services.benchgo.directory, mountFonts: async () => {} });
  const ownerApi = async input => {
    const route = hostValue.routes.find(route => route.path === '/api/commander-devices');
    const response = await route.fetch(new Request('http://127.0.0.1' + route.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }));
    return { status: response.status, value: await response.json() };
  };
  return { ...hostValue, calls, rows, hidden, nativeRows, ownerApi };
}

test('a paired user can confirm native stop-and-archive on an ungrouped delegated session', async t => {
  const a = await sessionHost(t, 'A'), b = await sessionHost(t, 'B');
  const device = await pair(a, b);
  const sessionId = 'delegated-session';
  b.rows.push({ sessionId, running: true, updatedAt: 20 });
  const get = b.ctx.get;
  b.ctx.get = name => name === 'benchgoExecution' ? { ownerOfSession: id => id === sessionId ? { executionId: 'delegated-run' } : null } : get(name);
  const call = input => a.ownerApi({ action: 'sessionAction', deviceId: device.id, expectedHostId: device.hostId, expectedAuthorizationId: device.authorizationId,
    native: false, id: sessionId, operation: 'archive', ...input, requestId: `sa:${Date.now()}:${input.requestId}` });
  const refused = await call({ requestId: 'unconfirmed' });
  assert.equal(refused.status, 409);
  assert.equal(refused.value.code, 'workspace/session-active');
  assert.deepEqual(b.ctx.workspaceRegistry.archivedSessionIds ?? [], []);
  const confirmed = await call({ requestId: 'confirmed', stopActivity: true });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(b.ctx.workspaceRegistry.archivedSessionIds, [sessionId]);
  assert.deepEqual(b.calls, [
    ['workspace', 'archiveSession', { sessionId }],
    ['workspace', 'archiveSession', { sessionId, stopActivity: true }],
  ]);
  assert.deepEqual(a.calls, []);
  assert.equal((await call({ requestId: 'delete', operation: 'delete' })).status, 403);
});

test('owner session actions cross real TLS to only the resource device with durable intent and live authorization', async t => {
  const a = await sessionHost(t, 'A'), b = await sessionHost(t, 'B');
  const device = await pair(a, b);
  let displayedDevice = (await a.link.devices()).devices.find(row => row.id === device.id);
  const issuedAt = Date.now(), call = input => a.ownerApi({ action: 'sessionAction', deviceId: device.id, expectedHostId: displayedDevice.hostId ?? null, expectedAuthorizationId: displayedDevice.authorizationId ?? null, native: false, id: 'same-session', ...input, requestId: `sa:${issuedAt}:${input.requestId}` });
  const capabilities = (await a.link.resources({ deviceId: device.id, kind: 'capabilities' })).devices[0].items;
  assert.deepEqual(capabilities.find(row => row.id === 'sessionActions').operations, ['pin', 'unpin', 'archive', 'unarchive', 'rename', 'delete']);
  assert.deepEqual(capabilities.find(row => row.id === 'nativeSessionActions').operations, ['archive', 'unarchive', 'delete']);
  assert.equal(capabilities.find(row => row.id === 'management').available, true, 'pairing approval uniformly grants supported BenchGo management');
  const pin = { operation: 'pin', requestId: 'same-pin' };
  assert.equal((await call(pin)).status, 200); assert.equal((await call(pin)).status, 200);
  assert.deepEqual(b.ctx.workspaceRegistry.pinnedSessionIds, ['same-session']); assert.equal(b.calls.length, 1); assert.deepEqual(a.calls, []);
  assert.equal((await call({ ...pin, operation: 'unpin' })).status, 409);
  for (const operation of ['pin', 'unpin', 'archive', 'unarchive']) assert.equal((await call({ operation, requestId: operation + '-next' })).status, 200);
  assert.deepEqual(b.ctx.workspaceRegistry.pinnedSessionIds, []); assert.deepEqual(b.ctx.workspaceRegistry.archivedSessionIds, []);
  const rename = { operation: 'rename', requestId: 'rename-once', title: 'B 新名称', method: 'arbitraryRPC', principal: { kind: 'owner' } };
  assert.equal((await call(rename)).value.title, 'B 新名称'); assert.equal((await call(rename)).status, 200);
  assert.equal(b.rows[0].projections.values.title, 'B 新名称'); assert.equal(a.rows[0].projections.values.title, 'A session');
  assert.equal(b.calls.filter(row => row[1] === 'rename').length, 1);
  let count = b.calls.length;
  b.hidden.add('same-session'); assert.equal((await call(rename)).status, 404); b.hidden.clear();
  for (const input of [{ operation: 'fork' }, { operation: 'arbitraryRPC' }, { id: 'native:same-native', native: true, operation: 'rename', title: 'No' }]) {
    const response = await call({ requestId: 'unsupported-' + input.operation + (input.id ?? ''), ...input });
    assert.equal(response.status, 422); assert.equal(response.value.code, 'UNSUPPORTED');
  }
  assert.equal(b.calls.length, count);
  assert.equal((await a.ownerApi({ action: 'sessionAction', id: 'same-session', operation: 'pin', requestId: 'missing-device' })).status, 400);
  assert.equal((await a.ownerApi({ action: 'sessionAction', deviceId: device.id, id: 'same-session', native: false, operation: 'pin', requestId: `sa:${issuedAt}:missing-identity` })).status, 400);
  assert.equal((await call({ id: 'native:same-native', native: true, operation: 'archive', requestId: 'archive-native' })).status, 200);
  const archived = (await a.link.resources({ deviceId: device.id, kind: 'sessions', archived: true })).devices[0].items;
  assert.deepEqual(archived.map(row => row.id), ['native:same-native']);
  const deleted = { operation: 'delete', requestId: 'delete-once' };
  assert.equal((await call(deleted)).value.deleted, true); assert.equal((await call(deleted)).status, 200);
  assert.equal(b.rows.length, 1, 'official history is retained');
  assert.deepEqual(JSON.parse(await readFile(join(b.directory, '..', 'dismissed-harness.json'), 'utf8')), ['same-session']);
  for (const archived of [false, true]) assert.equal((await a.link.resources({ deviceId: device.id, kind: 'sessions', archived })).devices[0].items.some(row => row.id === 'same-session'), false);
  count = b.calls.length;
  const pairedAgain = await pair(a, b);
  assert.equal(pairedAgain.id, device.id, 're-pairing retains the directory identity while replacing its authorization');
  assert.equal((await call({ id: 'native:same-native', native: true, operation: 'unarchive', requestId: 'stale-ui-grant' })).status, 409);
  assert.equal(b.calls.length, count);
  displayedDevice = (await a.link.devices()).devices.find(row => row.id === device.id);
  assert.equal((await call({ id: 'native:same-native', native: true, operation: 'unarchive', requestId: 'refreshed-ui-grant' })).status, 200);
  count = b.calls.length;
  await b.link.admin({ action: 'revoke', id: displayedDevice.authorizationId });
  const revoked = await call({ id: 'native:same-native', native: true, operation: 'unarchive', requestId: 'after-revoke' });
  assert.equal(revoked.status, 401); assert.match(revoked.value.error, /授权|配对|Unauthorized/i); assert.equal(b.calls.length, count); assert.deepEqual(a.calls, []);
});

test('project summaries mark only the durable default workspace for Recent across devices', async t => {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-default-resource-')), directory = join(root, 'link');
  await mkdir(directory);
  await writeFile(join(directory, 'devices.json'), JSON.stringify({ name: 'B', host: '127.0.0.1', port: 0 }));
  const recentFile = join(root, 'recent-workspace.json');
  await writeFile(recentFile, JSON.stringify({ id: 'default-id', path: '/b/default-workspace' }));
  const projects = [{ id: 'default-id', title: 'default-workspace', path: '/b/default-workspace', sessionIds: [] }, { id: 'user-id', title: 'default-workspace', path: '/b/user/default-workspace', sessionIds: [] }];
  const ctx = { workspaceRegistry: { list: () => projects }, get() {}, effect: fn => fn(), connection: { fetch: { register: () => () => {} } } };
  const link = await mountLink(ctx, { directory, env: {} });
  t.after(async () => { await link.close(); await rm(root, { recursive: true, force: true }); });
  const result = await link.resources({ deviceId: 'local', kind: 'projects' });
  assert.deepEqual(result.devices[0].items.map(row => [row.resourceId, row.isDefault]), [['default-id', true], ['user-id', false]]);
  await writeFile(recentFile, JSON.stringify({ id: 'user-id', path: '/b/user/default-workspace' }));
  const changed = await link.resources({ deviceId: 'local', kind: 'projects' });
  assert.deepEqual(changed.devices[0].items.map(row => row.isDefault), [false, true]);
});

test('two actual Link hosts discover their own resources over TLS and preserve device ownership', async t => {
  const a = await host(t, 'A', [{ id: 'same-id', title: 'A project', path: '/a/work', sessionIds: [] }]);
  const b = await host(t, 'B', [
    { id: 'same-id', title: 'B project', path: '/b/work', sessionIds: [] },
    { id: 'b-second', title: 'B second', path: '/b/other', sessionIds: [] },
  ]);
  const bOnA = await pair(a, b);
  const aOnB = await pair(b, a);
  assert.deepEqual(a.link.status().devices[0].capabilities, ['collaboration', 'management']);
  assert.deepEqual(b.link.status().devices[0].capabilities, ['collaboration', 'management']);
  const aggregate = await a.link.resources({ deviceIds: ['local', bOnA.id], kind: 'projects', limit: 1 });
  assert.equal(aggregate.partial, false);
  assert.equal(aggregate.devices[0].items[0].name, 'A project');
  assert.equal(aggregate.devices[1].items[0].name, 'B project');
  assert.equal(aggregate.devices[1].items[0].deviceId, bOnA.id);
  assert.equal(aggregate.devices[1].items[0].resourceId, 'same-id');
  assert.equal(aggregate.devices[1].hasMore, true);
  const second = await a.link.resources({ deviceId: bOnA.id, kind: 'projects', limit: 1, offset: 1 });
  assert.equal(second.devices[0].items[0].resourceId, 'b-second');
  const reverse = await b.link.resources({ deviceId: aOnB.id, kind: 'projects' });
  assert.equal(reverse.devices[0].items[0].path, '/a/work');
  assert.equal(reverse.devices[0].items[0].deviceId, aOnB.id);
  assert.ok((await a.link.devices()).devices.some(device => device.id === bOnA.id && device.direction === 'outbound'));
  const empty = await a.link.resources({ deviceId: bOnA.id, kind: 'projects', offset: 10 });
  assert.equal(empty.devices[0].available, true);
  assert.deepEqual(empty.devices[0].items, []);
});

test('session resources share one project snapshot and remain readable over TLS without a model catalog', async t => {
  const a = await host(t, 'A', []);
  const projects = [
    { id: 'default', title: 'Default', path: '/default', sessionIds: ['first', 'private', 'child', 'subagent'] },
    { id: 'other', title: 'Other', path: '/other', sessionIds: ['second'] },
  ];
  const b = await host(t, 'B', projects, { sidebarPrivateSessionIds: async () => ['private'] });
  await writeFile(join(b.directory, '..', 'recent-workspace.json'), JSON.stringify({ id: 'default', path: '/default' }));
  const calls = [];
  let projectReads = 0, catalogAvailable = false;
  b.ctx.workspaceRegistry.list = () => { projectReads++; return projects; };
  const get = b.ctx.get;
  b.ctx.get = name => name === 'commander' ? { list: () => [
    { id: 'native-default', ownerSessionId: 'commander-web:detached:owner', projectId: 'default', cwd: '/default', provider: 'native-provider', updatedAt: 30 },
    { id: 'native-other', ownerSessionId: 'commander-web:detached:owner', projectId: 'other', cwd: '/other', provider: 'native-provider', updatedAt: 40 },
  ] } : name === 'benchgoExecution' ? { ownerOfSession: id => id === 'worker' ? { promptable: false } : null } : get(name);
  b.ctx.connection.createPeer = () => ({ dispose() {} });
  b.ctx.typertGateway = {
    invoke: async call => {
      calls.push(call.method);
      if (call.method === 'list') return { items: [
        { sessionId: 'first', updatedAt: 10, projections: { values: { modelSelection: { next: { provider: 'Opaque/LLM', model: 'Model@1' } } } } },
        { sessionId: 'second', updatedAt: 20 },
        { sessionId: 'private', updatedAt: 100 },
        { sessionId: 'child', parentSessionId: 'first', updatedAt: 100 },
        { sessionId: 'subagent', origin: 'subagent', updatedAt: 100 },
        { sessionId: 'unregistered', updatedAt: 100 },
        { sessionId: 'worker', updatedAt: 15 },
      ] };
      assert.equal(call.method, 'modelCatalog');
      if (!catalogAvailable) throw new Error('Catalog unavailable');
      return { groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'model', name: 'Model' }] }] };
    },
    wireStream: { open: async (_endpoint, _payload, _uplink, _peer, signal) => (async function* () {
      yield { type: 'ready', clientId: 'client' };
      await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    })() },
  };
  const device = await pair(a, b);
  for (const [kind, expected] of [
    ['sessions', ['native:native-other', 'native:native-default', 'second', 'worker', 'first']],
    ['recent', ['native:native-default', 'worker', 'first']],
  ]) {
    calls.length = 0; projectReads = 0;
    const result = await a.link.resources({ deviceId: device.id, kind });
    assert.equal(result.devices[0].available, true);
    assert.deepEqual(result.devices[0].items.map(row => row.resourceId), expected);
    assert.equal(projectReads, 1, `${kind} shares its project snapshot with native sessions`);
    assert.deepEqual(calls, ['list']);
  }
  b.ctx.workspaceRegistry.archivedSessionIds = ['first'];
  b.ctx.workspaceRegistry.pinnedSessionIds = ['second'];
  const firstPage = (await a.link.resources({ deviceId: device.id, kind: 'sessions', archived: false, limit: 2 })).devices[0];
  const secondPage = (await a.link.resources({ deviceId: device.id, kind: 'sessions', archived: false, limit: 2, offset: 2 })).devices[0];
  assert.deepEqual(firstPage.items.map(row => row.id), ['second', 'native:native-other']);
  assert.deepEqual(secondPage.items.map(row => row.id), ['native:native-default', 'worker']);
  assert.equal(firstPage.items[0].pinned, true); assert.equal(firstPage.total, 4); assert.equal(firstPage.hasMore, true); assert.equal(secondPage.hasMore, false);
  const archive = (await a.link.resources({ deviceId: device.id, kind: 'sessions', archived: true, limit: 1 })).devices[0];
  assert.deepEqual(archive.items.map(row => row.id), ['first']); assert.equal(archive.total, 1); assert.equal(archive.hasMore, false);
  assert.equal(archive.items[0].provider, 'deepseek'); assert.equal(archive.items[0].modelProvider, 'Opaque/LLM'); assert.equal(archive.items[0].model, 'Model@1');
  await assert.rejects(a.link.callDevice({ deviceId: device.id, input: { action: 'state' } }), /Catalog unavailable/);
  catalogAvailable = true;
  calls.length = 0; projectReads = 0;
  const models = await a.link.resources({ deviceId: device.id, kind: 'models' });
  assert.deepEqual(models.devices[0].items.map(row => row.model), ['model']);
  assert.deepEqual(calls, ['modelCatalog']);
  assert.equal(projectReads, 0);
  const state = await a.link.callDevice({ deviceId: device.id, input: { action: 'state' } });
  assert.deepEqual(state.projects.map(row => row.id), ['default', 'other']);
  assert.deepEqual(state.sessions.map(row => row.id), ['first', 'second', 'worker', 'native:native-default', 'native:native-other']);
  assert.deepEqual(state.models, [{ provider: 'provider', model: 'model', label: 'Provider · Model' }]);
  assert.deepEqual(await a.link.callDevice({ deviceId: device.id, input: { action: 'models' } }), { models: state.models });
});

test('revocation removes cached remote resources without clearing healthy local results', async t => {
  const a = await host(t, 'A', [{ id: 'a', title: 'local', path: '/a', sessionIds: [] }]);
  const b = await host(t, 'B', [{ id: 'b', title: 'remote', path: '/b', sessionIds: [] }]);
  const device = await pair(a, b);
  assert.equal((await a.link.resources({ deviceId: device.id, kind: 'projects' })).devices[0].available, true);
  await b.link.admin({ action: 'revoke', id: b.link.status().devices[0].id });
  const result = await a.link.resources({ deviceIds: ['local', device.id], kind: 'projects' });
  assert.equal(result.partial, true);
  assert.equal(result.devices[0].available, true);
  assert.equal(result.devices[1].available, false);
  assert.equal(result.devices[1].code, 'UNAUTHORIZED');
  assert.deepEqual(result.devices[1].items, []);
  assert.equal(result.devices[1].freshness, 'unknown');
});

test('execution works without SuperAgent and binds the real paired principal and target identity', async t => {
  const calls = [];
  const b = await host(t, 'B', []);
  b.ctx.get = name => name === 'benchgoExecution' ? { async dispatch(input, access) { calls.push({ input, access }); return { version: 2, available: true }; } } : undefined;
  const a = await host(t, 'A', []);
  const device = await pair(a, b);
  const input = { action: 'execution', version: 2, operation: 'catalog', principal: { kind: 'owner' } };
  const target = (await a.link.devices()).devices.find(row => row.id === device.id);
  const call = value => a.link.callDevice({ deviceId: device.id, expectedHostId: target.hostId, expectedAuthorizationId: target.authorizationId, input: value });
  const inboundId = b.link.status().devices[0].id;
  await assert.rejects(a.link.callDevice({ deviceId: device.id, input }), { code: 'INVALID_EXECUTION_IDENTITY' });
  const reply = await call(input);
  assert.equal(reply.available, true);
  assert.equal(reply.hostId, target.hostId); assert.equal(reply.authorizationId, target.authorizationId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.principal, undefined);
  assert.equal(calls[0].access.principal.kind, 'device');
  assert.equal(calls[0].access.principal.deviceId, inboundId);
  assert.deepEqual(calls[0].access.principal.capabilities, ['collaboration','management']);
  await call({ ...input, operation: 'submit', requestId: 'example-request', executionId: 'example-execution', identity: { ownerHostId: 'business-host' } });
  assert.equal(calls[1].access.verifiedSourceHostId, a.link.status().hostId);
  assert.equal(calls[1].input.sourceProof, undefined);
  const capabilities = (await a.link.resources({ deviceId: device.id, kind: 'capabilities' })).devices[0].items;
  assert.equal(capabilities.find(item => item.id === 'execution').version, 2);
  assert.equal(capabilities.some(item => item.id === 'collaboration'), false);
  await assert.rejects(call({ action: 'collaboration', operation: 'delegate' }), { code: 'UNSUPPORTED' });
  assert.equal((await a.link.callDevice({ deviceId: device.id, input: { action: 'management', operation: 'status' } })).enabled,true);
  await b.link.admin({action:'revoke',id:inboundId});
  await assert.rejects(call(input),error=>error.statusCode===401);
  assert.equal(calls.length,2,'revoked pairing cannot invoke execution again');
});

test('remote relay settings apply once, with a durable receipt and independent concurrent intent', async t => {
  const a = await host(t, 'A', []), b = await host(t, 'B', []);
  for (const node of [
    { id: 'first', url: 'https://relay-one.example', token: 'test-first-secret' },
    { id: 'second', url: 'https://relay-two.example', token: 'test-second-secret' },
  ]) await b.link.admin({ action: 'relay-pool-configure', operation: 'add', expected: { fingerprint: b.link.status().relay.fingerprint }, ...node, enabled: false });
  const device = await pair(a, b);
  const call = input => a.link.callDevice({ deviceId: device.id, input: { action: 'management', ...input } });
  const snapshot = await call({ operation: 'settings-read', namespace: 'benchgo-link-relay' });
  assert.ok(!JSON.stringify(snapshot).includes('test-first-secret'));
  const request = { operation: 'settings-apply', requestId: 'same-relay-change', namespace: 'benchgo-link-relay', expected: { fingerprint: snapshot.fingerprint }, ops: [{ op: 'set', path: ['nodes', '0', 'priority'], value: 8 }] };
  const [receipt, repeat] = await Promise.all([call(request), call(request)]);
  assert.equal(receipt.state, 'applied', JSON.stringify(receipt.error));
  assert.deepEqual(repeat, receipt);
  assert.equal((await call({ operation: 'operation', operationId: receipt.operationId })).state, 'applied');
  assert.equal((await call({ operation: 'operation', requestId: request.requestId })).operationId, receipt.operationId);
  await assert.rejects(call({ ...request, ops: [{ ...request.ops[0], value: 9 }] }), { code: 'SETTINGS_IDEMPOTENCY_CONFLICT' });
  const conflict = await call({ ...request, requestId: 'stale' });
  assert.equal(conflict.state, 'failed');
  assert.equal(conflict.error.code, 'REVISION_CONFLICT');
  await assert.rejects(call({ ...request, requestId: 'secret', ops: [{ op: 'set', path: ['nodes', '0', 'token'], value: 'other-secret' }] }), { code: 'UNSUPPORTED' });
  assert.deepEqual(b.link.status().relay.nodes.map(({ id, priority, enabled }) => ({ id, priority, enabled })), [
    { id: 'second', priority: 1, enabled: false }, { id: 'first', priority: 8, enabled: false },
  ]);
  const saved = JSON.parse(await readFile(join(b.directory, 'devices.json'), 'utf8'));
  assert.equal(saved.managementOperations.filter(row => row.requestId === request.requestId).length, 1);
  assert.equal(saved.managementOperations.find(row => row.requestId === request.requestId).state, 'applied');
  assert.equal(saved.relayPool[0].token, 'test-first-secret');
  await b.link.admin({ action: 'revoke', id: b.link.status().devices[0].id });
  await assert.rejects(call({ operation: 'operation', operationId: receipt.id }), error => error.statusCode === 401);
});

test('completed management receipts leave capacity for a new relay change', async t => {
  const completed = Array.from({ length: 128 }, (_, i) => ({ id: `old-${i}`, requestId: `old-request-${i}`, deviceId: 'retired-device', state: 'applied', createdAt: i }));
  const a = await host(t, 'A', []), b = await host(t, 'B', [], undefined, { managementOperations: completed });
  await b.link.admin({ action: 'relay-pool-configure', operation: 'add', expected: { fingerprint: b.link.status().relay.fingerprint },
    id: 'only', url: 'https://relay.example', token: 'private-relay-secret', enabled: false });
  const device = await pair(a, b);
  const call = input => a.link.callDevice({ deviceId: device.id, input: { action: 'management', ...input } });
  const snapshot = await call({ operation: 'settings-read', namespace: 'benchgo-link-relay' });
  const request = { operation: 'settings-apply', requestId: 'next-change', namespace: 'benchgo-link-relay', expected: { fingerprint: snapshot.fingerprint }, ops: [{ op: 'set', path: ['nodes', '0', 'priority'], value: 3 }] };
  const receipt = await call(request);
  assert.equal(receipt.state, 'applied');
  assert.equal((await call(request)).operationId, receipt.operationId);
  assert.equal(b.link.status().relay.nodes[0].priority, 3);
  const saved = JSON.parse(await readFile(join(b.directory, 'devices.json'), 'utf8'));
  assert.equal(saved.managementOperations.length, 128);
  assert.equal(saved.managementOperations.some(row => row.id === 'old-0'), false);
  assert.equal(saved.managementOperations.some(row => row.id === 'old-127'), true);
});

test('paired workbench device center uses the target session without granting access to a third device', async t => {
  const a = await host(t, 'A', []), b = await host(t, 'B', []), c = await host(t, 'C', []);
  b.ctx.connection.createPeer = () => ({ dispose() {} });
  const device = await pair(a, b);
  await pair(b, c);
  await b.link.admin({ action: 'relay-pool-configure', operation: 'add', expected: { fingerprint: b.link.status().relay.fingerprint },
    id: 'relay', url: 'https://relay.example', token: 'private-relay-secret', enabled: false });
  const target = (JSON.parse(await readFile(join(a.directory, 'outgoing', 'connections.json'), 'utf8')).devices).find(row => row.id === device.id);
  const proxy = await createDeviceProxy(target);
  t.after(() => proxy.close());
  const entry = await fetch(await proxy.enter(), { redirect: 'manual' });
  assert.equal(entry.status, 303);
  const base = new URL(entry.headers.get('location'), proxy.origin);
  const post = async (path, body) => {
    const response = await fetch(new URL(path, base), { method: 'POST', headers: { 'content-type': 'application/json', origin: base.origin }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  const call = input => post('device-center/api/devices', input);
  const directory = await call({ action: 'list' });
  assert.equal(directory.status, 200);
  assert.deepEqual(directory.value.devices.map(row => row.name), ['B', 'A']);
  assert.deepEqual(directory.value.capabilities, { relayManagement: true });
  assert.ok(!JSON.stringify(directory).includes(target.token));
  const status = await call({ action: 'hostStatus' });
  assert.ok(!JSON.stringify(status).includes('private-relay-secret'));
  const change = { action: 'hostRelayPoolConfigure', operation: 'update', id: 'relay', enabled: false, requestId: 'paired-center-update', expected: { fingerprint: status.value.relay.fingerprint } };
  const updated = await call(change);
  assert.equal(updated.value.state, 'applied');
  assert.deepEqual(await call(change), updated);
  assert.deepEqual(await call({ action: 'hostRelayOperation', requestId: change.requestId }), updated);
  assert.equal((await call({ ...change, token: 'forged-secret' })).status, 422);
  for (const action of ['select', 'pair', 'hostPairing', 'hostRevoke', 'callDevice', 'sshProbe']) assert.equal((await call({ action })).status, 403);
  for (const action of ['devices', 'resourceScope', 'setResourceScope', 'resources', 'sessionAction']) assert.equal((await post('api/commander-devices', { action })).status, 403);
  assert.equal((await post('api/group-resources', { action: 'devices' })).status, 403);
  assert.equal((await post('api/commander-devices', { action: 'launch' })).status, 403);
  await b.link.admin({ action: 'revoke', id: directory.value.devices[1].id });
  assert.equal((await call({ action: 'list' })).status, 401);
});

test('group workbench lists and saves the target host resource scope without exposing independent devices', async t => {
  if (!connectionAddresses().length) { t.skip('No non-loopback interface available'); return; }
  const a = await host(t, 'A', [], null, { host: '::' });
  const b = await host(t, 'B', [{ id: 'b-project', title: 'B project', sessionIds: [] }], null, { host: '::' });
  const c = await host(t, 'C', [{ id: 'c-project', title: 'C project', sessionIds: [] }], null, { host: '::' });
  const isolated = await host(t, 'Private');
  b.ctx.connection.createPeer = () => ({ dispose() {} });
  const privateDevice = await pair(b, isolated);
  await joinGroup(a, [b, c]);
  const aId = a.link.status().hostId, bId = b.link.status().hostId, cId = c.link.status().hostId;
  await waitForGroup(async () => (await b.link.devices()).devices.some(row => row.hostId === cId));
  const aGroup = await openDeviceGroup(a.directory, await loadIdentity(a.directory));
  const target = { ...aGroup.member(bId).routes[0], token: aGroup.token(bId) };
  const proxy = await createDeviceProxy(target);
  t.after(() => proxy.close());
  const entry = await fetch(await proxy.enter(), { redirect: 'manual' });
  const base = new URL(entry.headers.get('location'), proxy.origin);
  const call = async (input, path = 'api/group-resources') => {
    const response = await fetch(new URL(path, base), { method: 'POST', headers: { 'content-type': 'application/json', origin: base.origin }, body: JSON.stringify(input) });
    return { status: response.status, value: await response.json() };
  };
  const list = await call({ action: 'devices' });
  assert.equal(list.status, 200);
  assert.deepEqual(list.value.devices.map(row => row.name).sort(), ['A', 'B', 'C']);
  const legacy = await call({ action: 'devices' }, 'api/commander-devices');
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.value.devices.map(row => row.name).sort(), ['A', 'B', 'C']);
  assert.deepEqual((await call({ action: 'resourceScope' })).value.scope, { mode: 'current', deviceIds: [] });
  const scope = { mode: 'selected', deviceIds: ['local', cId] };
  assert.deepEqual((await call({ action: 'setResourceScope', scope })).value.scope, scope);
  assert.deepEqual((await call({ action: 'resourceScope' })).value.scope, scope);
  assert.deepEqual((await b.deviceApi({ action: 'resourceScope' })).scope, scope);
  assert.deepEqual((await a.deviceApi({ action: 'resourceScope' })).scope, { mode: 'current', deviceIds: [] });
  for (const [deviceId, resourceId] of [['local', 'b-project'], [cId, 'c-project']]) {
    const result = await call({ action: 'resources', deviceId, kind: 'projects' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.value.devices[0].items.map(row => row.resourceId), [resourceId]);
  }
  assert.equal((await call({ action: 'resources', deviceId: privateDevice.id, kind: 'projects' })).status, 403);
  assert.equal((await call({ action: 'setResourceScope', scope: { mode: 'all', deviceIds: [privateDevice.id] } })).status, 403);
  assert.equal((await call({ action: 'launch' })).status, 403);
  await b.deviceApi({ action: 'groupRemove', deviceId: aId });
  assert.equal((await call({ action: 'devices' })).status, 401);
});
