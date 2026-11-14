import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantDeviceStatus } from '../src/device-status.mjs';

function fixture() {
  const events = [{ type: 'turn/start' }, { type: 'user/message', data: { id: 'question', source: { kind: 'user' } } }];
  const agent = { id: 'owner-session', status: 'running', session: { header: {}, snapshotEvents: () => events } };
  const state = { mainSessionId: agent.id, threads: [] };
  let calls = 0;
  let link = { status: () => { calls++; return { enabled: true, devices: [], pending: [], error: null }; } };
  const ctx = { agents: { get: id => id === agent.id ? agent : null, currentInitiator: () => agent,
    turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) }, get: name => { assert.equal(name, 'benchgoLink'); return link; } };
  const read = createAssistantDeviceStatus({ ctx, store: { getState: async () => state }, now: () => 1000 });
  return { agent, events, state, ctx, read: options => read({ agent, ownerAgent: agent, threadId: 'main', ...options }),
    setLink: value => { link = value; }, calls: () => calls };
}

test('projects only authorized device facts and never invents live connections', async () => {
  const f = fixture();
  f.setLink({ status: () => ({ enabled: true, error: null, host: 'PRIVATE HOST', addresses: ['PRIVATE ADDRESS'],
    relay: { token: 'PRIVATE TOKEN' }, pending: [{ id: 'PRIVATE PENDING', token: 'PRIVATE TOKEN' }],
    devices: [{ id: 'phone', name: '我的手机', deviceType: 'mobile', lastSeenAt: 123, tokenHash: 'PRIVATE HASH', pairedAt: 1, private: 'PRIVATE STATE' }] }) });
  assert.deepEqual(await f.read(), { available: true, enabled: true,
    devices: [{ id: 'phone', name: '我的手机', type: 'mobile', lastSeenAt: 123 }], pendingCount: 1,
    observedAt: '1970-01-01T00:00:01.000Z', liveConnections: 'unknown' });
  f.setLink({ status: () => ({ enabled: false, devices: [], pending: [] }) });
  assert.deepEqual(await f.read(), { available: true, enabled: false, devices: [], pendingCount: 0,
    observedAt: '1970-01-01T00:00:01.000Z', liveConnections: 'unknown' });
});

test('service changes are resolved per call; unavailable never looks like no devices or leaks errors', async () => {
  const f = fixture();
  for (const link of [undefined, {}, { status: () => { throw new Error('PRIVATE TOKEN'); } },
    { status: () => ({ enabled: false, error: 'PRIVATE ADDRESS', devices: [], pending: [] }) },
    { status: () => ({ enabled: true, devices: [], pending: null }) },
    { status: () => ({ enabled: true, devices: [{ id: 'bad' }], pending: [] }) }]) {
    f.setLink(link);
    const result = await f.read();
    assert.equal(result.available, false);
    assert.equal(Object.hasOwn(result, 'devices'), false);
    assert.equal(Object.hasOwn(result, 'pendingCount'), false);
    assert.equal(result.liveConnections, 'unknown');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
  f.ctx.get = () => { throw new Error('PRIVATE INTERNAL ERROR'); };
  assert.equal((await f.read()).available, false);
});

test('requires current real owner turn and exact local conversation before consulting Link', async () => {
  for (const mutate of [
    f => { f.agent.status = 'idle'; },
    f => { f.agent.session.header.origin = 'subagent'; },
    f => { f.events.push({ type: 'turn/end' }); },
    f => { f.events[1].data.source.kind = 'task-reply'; },
    f => { f.ctx.agents.currentInitiator = () => ({ id: f.agent.id }); },
    f => { f.ctx.agents.get = () => ({ id: f.agent.id }); },
    f => { f.state.mainSessionId = 'old-session'; },
  ]) {
    const f = fixture(); mutate(f);
    assert.equal((await f.read()).code, 'OWNER_REQUIRED');
    assert.equal(f.calls(), 0);
  }
  const f = fixture();
  assert.equal((await f.read({ agent: { id: f.agent.id } })).code, 'OWNER_REQUIRED');
  assert.equal((await f.read({ threadId: 'missing' })).code, 'OWNER_REQUIRED');
  for (const sourceType of ['direct', 'group', 'topic']) {
    f.state.threads = [{ id: 'channel', sessionId: f.agent.id, sourceKey: 'trusted-channel-key', source: { channel: 'feishu', sourceType } }];
    assert.equal((await f.read({ threadId: 'channel' })).code, 'OWNER_REQUIRED');
  }
  f.state.threads = [{ id: 'channel', sessionId: f.agent.id, source: { channel: 'feishu' } }];
  assert.equal((await f.read({ threadId: 'channel' })).code, 'OWNER_REQUIRED');
  assert.equal(f.calls(), 0);
  f.state.threads = [{ id: 'side', sessionId: f.agent.id }];
  assert.equal((await f.read({ threadId: 'side' })).available, true);
  assert.equal(f.calls(), 1);
});
