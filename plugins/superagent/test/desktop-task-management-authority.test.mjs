import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopTaskManagementScope, isDesktopTaskManagementScope } from '../src/desktop-task-management-authority.mjs';

function fixture(threadId = 'main') {
  const events = [{ type: 'turn/start' }, { type: 'user/message', data: { id: 'human', source: { kind: 'user' }, content: [{ type: 'text', text: '停止这张任务' }] } }];
  const agent = { id: 'owner', status: 'running', session: { header: {}, snapshotEvents: () => structuredClone(events) } };
  const state = { mainSessionId: agent.id, threads: [{ id: 'side', sessionId: agent.id }] };
  const ctx = { agents: { get: () => agent, currentInitiator: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) } };
  const store = { getState: async () => state };
  return { state, events, agent, ctx, store, scope: () => desktopTaskManagementScope({ ctx, store, agent, threadId }) };
}

test('only a live current local owner human turn receives a host-only management capability', async () => {
  const f = fixture();
  const scope = await f.scope();
  assert.deepEqual(scope, { owner: 'desktop-owner', mode: 'global' });
  assert.equal(isDesktopTaskManagementScope(scope), true);
  assert.equal(isDesktopTaskManagementScope(structuredClone(scope)), false);
  for (const mutation of [
    f => { f.agent.status = 'idle'; },
    f => { f.agent.session.header.origin = 'subagent'; },
    f => { f.events.push({ type: 'turn/end' }); },
    f => { f.events[1].data.source.kind = 'task-reply'; },
    f => { f.state.mainSessionId = 'replacement'; },
    f => { f.ctx.agents.currentInitiator = () => ({ id: 'child' }); },
  ]) {
    const denied = fixture(); mutation(denied);
    assert.equal(await denied.scope(), null);
  }
});

test('channel and archived side conversations cannot obtain global scope, including state-read races', async () => {
  for (const mutation of [
    f => { f.state.threads[0].sourceKey = 'channel:fixed'; },
    f => { f.state.threads[0].source = { channel: 'feishu' }; },
    f => { f.state.threads[0].archived = true; },
    f => { f.state.threads[0].sessionId = 'replacement'; },
    f => { f.store.getState = async () => { f.events[1].data.id = 'new-message'; return f.state; }; },
  ]) {
    const f = fixture('side'); mutation(f);
    assert.equal(await f.scope(), null);
  }
  assert.equal(isDesktopTaskManagementScope(await fixture('side').scope()), true);
});

test('same-turn internal notifications do not invalidate the real input', async () => {
  const f = fixture();
  f.events.push({ type: 'user/message', data: { id: 'internal', source: { kind: 'task-reply' } } });
  assert.equal(isDesktopTaskManagementScope(await f.scope()), true);
});
