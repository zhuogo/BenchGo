import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { loadChannelModules, channelIds } from '../src/channel-catalog.mjs';
import { createAssistantConnections } from '../src/connections.mjs';
import { createChannelRuntime, mountChannelCallbacks } from '../src/channel-runtime.mjs';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';

test('channel CAS configuration isolates providers, retains opaque identifiers and rejects plaintext secrets', async () => {
  await loadChannelModules();
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-channel-core-'));
  let connections = createAssistantConnections({ directory });
  try {
    connections.update({ appId: 'Feishu:Opaque' }, { revision: 0 });
    connections.update({ botTokenRef: 'secret:Opaque/X', ownerIds: ['Owner:Case/X'] }, { channel: 'telegram', revision: 0 });
    connections.update({ botId: 'Wecom:Opaque' }, { channel: 'wecom', revision: 0 });
    assert.throws(() => connections.update({ ownerIds: [] }, { channel: 'telegram', revision: 0 }), { code: 'REVISION_CONFLICT' });
    assert.throws(() => connections.update({ token: 'plaintext' }, { channel: 'telegram', revision: 1 }));
    connections.close(); connections = createAssistantConnections({ directory });
    assert.equal(connections.read().config.appId, 'Feishu:Opaque');
    assert.equal(connections.read('telegram').config.botTokenRef, 'secret:Opaque/X');
    assert.deepEqual(connections.read('telegram').config.ownerIds, ['Owner:Case/X']);
    assert.equal(connections.read('wecom').revision, 1);
    assert.equal(connections.read('discord').revision, 0);
    assert.equal(connections.list().length, channelIds.length);
  } finally { connections.close(); await rm(directory, { recursive: true, force: true }); }
});

test('authenticated API direct messages enter durable Router queue and revoked sources cannot send', async () => {
  await loadChannelModules();
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-channel-router-'));
  const connections = createAssistantConnections({ directory });
  const orchestration = createAssistantOrchestrationStore({ directory });
  const runtime = createChannelRuntime({ ctx: {}, store: { connections, orchestration } });
  try {
    connections.update({ enabled: true, ownerIds: ['owner'] }, { channel: 'api', revision: 0 });
    await runtime.restart('api');
    const adapter = runtime.get('api'), input = { operation: 'submit', requestId: 'req-1', conversationId: 'conversation', text: 'Inspect project' };
    await assert.rejects(adapter.operation(input, { principal: { kind: 'visitor' } }));
    const accepted = await adapter.operation(input, { principal: { kind: 'owner' } });
    assert.equal(accepted.result.requiresEval, true);
    assert.equal(orchestration.candidates().length, 1);
    assert.equal(accepted.result.trigger.source.connectionRevision, 1);
    const replay = await adapter.operation(input, { principal: { kind: 'owner' } });
    assert.equal(replay.result.duplicate, true);
    connections.update({ enabled: false }, { channel: 'api', revision: 1 });
    await assert.rejects(adapter.send({ source: accepted.result.trigger.source, text: 'result', idempotencyKey: 'delivery-1' }));
  } finally { await runtime.dispose(); orchestration.close(); connections.close(); await rm(directory, { recursive: true, force: true }); }
});

test('disabled channel lifecycle needs no network and callbacks report missing carrier', async () => {
  await loadChannelModules();
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-channel-lifecycle-'));
  const connections = createAssistantConnections({ directory });
  const runtime = createChannelRuntime({ ctx: {}, store: { connections }, adapterOptions: { fetcher: () => { throw new Error('disabled channel requested network'); } } });
  try {
    await runtime.start();
    for (const channel of channelIds.slice(1)) {
      assert.ok(runtime.get(channel), channel);
      const status = await runtime.status(channel);
      assert.equal(status.enabled, false, channel);
      assert.notEqual(status.authentication, 'verified', channel);
    }
    assert.equal(mountChannelCallbacks({}, runtime, {}), false);
    assert.equal((await runtime.status('webhook')).callback.available, false);
    assert.equal((await runtime.status('webhook')).callback.path, '/api/commander/assistant/channels/webhook');
    const registrations = [];
    assert.equal(mountChannelCallbacks({ webServer: { register: route => { registrations.push(route); return () => {}; } }, effect: factory => factory() }, runtime, {}), true);
    assert.equal(registrations.length, 3);
    assert.ok(registrations.every(route => route.kind === 'exact' && !route.path.endsWith('/api')));
  } finally { await runtime.dispose(); connections.close(); await rm(directory, { recursive: true, force: true }); }
});

test('late HTTP carrier mounts signed callbacks and revokes routes on disposal', async () => {
  await loadChannelModules();
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-channel-http-'));
  const connections = createAssistantConnections({ directory }), orchestration = createAssistantOrchestrationStore({ directory });
  const secret = 'integration-signing-secret', routes = new Map(), cleanups = [];
  let inject;
  const runtime = createChannelRuntime({ ctx: {}, store: { connections, orchestration }, adapterOptions: { credentials: { resolve: async () => ({ value: secret }) } } });
  const server = createServer((req, res) => { const route = routes.get(req.url); if (route) void route.handler(req, res); else { res.writeHead(404); res.end(); } });
  try {
    connections.update({ enabled: true, ownerIds: ['trusted'], signingSecretRef: 'REF' }, { channel: 'webhook', revision: 0 });
    await runtime.restart('webhook');
    mountChannelCallbacks({ inject: (_services, callback) => { inject = callback; } }, runtime, {});
    assert.equal(runtime.callbackStatus('webhook').available, false);
    inject({ get: () => ({ register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } }), effect: factory => cleanups.push(factory()) });
    assert.equal(runtime.callbackStatus('webhook').available, true);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const raw = JSON.stringify({ requestId: 'HTTP:1', conversationId: 'room', text: 'Inspect project' }), timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/commander/assistant/channels/webhook`, { method: 'POST', body: raw, headers: { 'x-benchgo-timestamp': timestamp, 'x-benchgo-signature': createHmac('sha256', secret).update(timestamp + '.').update(raw).digest('hex') } });
    assert.equal(response.status, 202, await response.text());
    assert.equal(orchestration.candidates().length, 1);
    for (const cleanup of cleanups.reverse()) cleanup();
    assert.equal(routes.size, 0); assert.equal(runtime.callbackStatus('webhook').available, false);
  } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); await runtime.dispose(); orchestration.close(); connections.close(); await rm(directory, { recursive: true, force: true }); }
});
