import test from 'node:test';
import assert from 'node:assert/strict';
import { registerConversationManagement } from '../src/conversation-management.mjs';
import { isRouterQuery } from '../src/model-fallback.mjs';

function fixture({ threadId = 'main', risk = false } = {}) {
  const events = [{ type: 'turn/start' }, { type: 'user/message', data: { id: 'human-1', source: { kind: 'user' }, content: [{ type: 'text', text: '修改设置并整理工单' }] } }];
  const agent = { id: 'owner-session', status: 'running', session: { header: {}, snapshotEvents: () => structuredClone(events) } };
  const state = { mainSessionId: agent.id, threads: [{ id: 'side', sessionId: agent.id }] };
  const calls = [], approvals = [], definitions = new Map(), tokens = new WeakSet();
  let outcome = 'allowed-once', approvalHook;
  const approval = { request: async request => { approvals.push(request); await approvalHook?.(); return outcome; } };
  const ctx = { agents: { get: id => id === agent.id ? agent : null, currentInitiator: () => agent,
    turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) }, get: () => approval };
  const settings = Object.fromEntries(['catalog', 'read', 'prepare', 'commit', 'history', 'rollback'].map(op => [op, async (args, actor) => {
    calls.push({ op, args, actor });
    if (op === 'prepare' || op === 'rollback') return { operationId: 'operation', digest: 'precise-diff', requiresConfirmation: risk };
    if (op === 'commit') {
      if (risk) assert.deepEqual(await actor.confirm({ digest: 'precise-diff', diff: [{ path: ['approval'], after: { value: false } }] }), { outcome: 'allowed-once', digest: 'precise-diff' });
      return { verified: true };
    }
    return { value: true };
  }]));
  const preview = { previewId: 'preview', manifestHash: 'exact-manifest', items: [{ id: 'one', title: '工单一', metaVersion: 3 }, { id: 'two', title: '工单二', metaVersion: 2 }], excluded: [{ id: 'running', reason: '执行中' }] };
  const restore = { ...preview, previewId: 'restore-preview', type: 'restore', receiptId: 'receipt' };
  const taskManagement = {
    previewCleanup: args => { calls.push({ op: 'previewCleanup', args }); return preview; },
    getCleanupPreview: id => { calls.push({ op: 'getCleanupPreview', args: id }); return id === restore.previewId ? restore : preview; },
    createCleanupConfirmation: args => { calls.push({ op: 'createCleanupConfirmation', args }); const token = Object.freeze(args); tokens.add(token); return token; },
    commitCleanup: args => { assert.ok(tokens.has(args.confirmedBy)); calls.push({ op: 'commitCleanup', args }); return { receiptId: 'receipt' }; },
    previewRestore: args => { calls.push({ op: 'previewRestore', args }); return restore; },
    restoreCleanup: args => { assert.ok(tokens.has(args.confirmedBy)); calls.push({ op: 'restoreCleanup', args }); return { receiptId: 'restored' }; },
    cleanupHistory: args => { calls.push({ op: 'cleanupHistory', args }); return []; },
  };
  const store = { profileId: 'profile', getState: async () => state };
  registerConversationManagement({ ctx, scope: { get: () => approval }, agent, threadId, store, settings, taskManagement,
    register: (name, description, properties, required, execute) => definitions.set(name, { description, properties, required, execute }) });
  const exec = { agent, callId: 'call', signal: new AbortController().signal };
  return { events, agent, state, calls, approvals, ctx, store, definitions, exec, preview,
    setOutcome: value => { outcome = value; }, onApproval: hook => { approvalHook = hook; },
    settings: (args, execution = exec) => definitions.get('assistant_settings').execute(args, execution),
    cleanup: (args, execution = exec) => definitions.get('assistant_task_cleanup').execute(args, execution) };
}

const prepare = f => f.settings({ op: 'prepare', adapterId: 'any-plugin', namespace: 'opaque.namespace', expectedRevision: 3,
  ops: [{ op: 'set', path: ['arbitrary', '0', 'modelId'], value: 'opaque/model:id' }] });

test('generic settings preserve exact paths and IDs; ordinary explicit edits need no approval or ticket', async () => {
  const f = fixture();
  await f.settings({ op: 'catalog' });
  await f.settings({ op: 'read', adapterId: 'any-plugin', namespace: 'opaque.namespace' });
  await prepare(f);
  assert.deepEqual(await f.settings({ op: 'commit', operationId: 'operation' }), { verified: true });
  assert.equal(f.approvals.length, 0);
  assert.equal(f.calls[2].args.ops[0].value, 'opaque/model:id');
  assert.equal(f.calls[2].actor.id, 'desktop-owner');
  assert.equal(f.calls[2].actor.profileId, 'profile');
  await f.settings({ op: 'history', limit: 10 });
  await f.settings({ op: 'rollback', historyId: 'old', expectedRevision: 4 });
  assert.deepEqual(f.calls.map(call => call.op), ['catalog', 'read', 'prepare', 'commit', 'history', 'rollback']);
});

test('settings safety approval comes from the official service and accepts only allowed-once', async () => {
  for (const outcome of ['allowed-once', true, 'allowed-always', { allow: true }, { outcome: 'allowed-once' }, 'rejected']) {
    const f = fixture({ risk: true }); f.setOutcome(outcome); await prepare(f);
    const pending = f.settings({ op: 'commit', operationId: 'operation' });
    if (outcome === 'allowed-once') await pending;
    else await assert.rejects(pending, { code: 'MANAGEMENT_APPROVAL_DENIED' });
    assert.equal(f.approvals[0].agent, f.agent);
    assert.equal(f.approvals[0].toolName, 'assistant_settings');
    assert.match(f.approvals[0].reason, /precise-diff/);
    assert.deepEqual(JSON.parse(f.approvals[0].reason.split('\n')[1]).diff,
      [{ path: ['approval'], after: { value: false } }], 'official approval displays the exact frozen setting diff');
  }
});

test('tools reject model-supplied confirmation and identity even when schema validation is bypassed', async () => {
  for (const key of ['confirmed', 'authorized', 'actor', 'confirmedBy', 'scope']) {
    const f = fixture();
    await assert.rejects(f.settings({ op: 'catalog', [key]: true }), { code: 'MANAGEMENT_INPUT' });
    await assert.rejects(f.cleanup({ op: 'preview', [key]: true }), { code: 'MANAGEMENT_INPUT' });
    assert.equal(f.calls.length, 0);
  }
});

test('owner authority excludes workers, channels, machine turns, stale sessions and closed turns', async () => {
  const mutations = [
    f => { f.exec.agent = { ...f.agent }; }, f => { f.agent.session.header.origin = 'subagent'; },
    f => { f.agent.status = 'idle'; }, f => { f.ctx.agents.get = () => ({ ...f.agent }); },
    f => { f.ctx.agents.currentInitiator = () => ({ ...f.agent }); }, f => { f.state.mainSessionId = 'other'; },
    f => { f.events.push({ type: 'turn/end' }); }, f => { f.events[1].data.source.kind = 'notification'; },
    f => { f.events.push({ type: 'user/message', data: { id: 'machine', source: { kind: 'ticket-reply' } } }); },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.settings({ op: 'catalog' }), { code: 'MANAGEMENT_OWNER_REQUIRED' });
    await assert.rejects(f.cleanup({ op: 'preview' }), { code: 'MANAGEMENT_OWNER_REQUIRED' });
    assert.equal(f.calls.length, 0);
  }
  const channel = fixture({ threadId: 'side' }); channel.state.threads[0].sourceKey = 'channel';
  await assert.rejects(channel.settings({ op: 'catalog' }), { code: 'MANAGEMENT_OWNER_REQUIRED' });
  channel.state.threads[0].sourceKey = undefined; channel.state.threads[0].source = { channel: 'feishu' };
  await assert.rejects(channel.settings({ op: 'catalog' }), { code: 'MANAGEMENT_OWNER_REQUIRED' });
});

test('ordinary plan cannot be committed from another human instruction', async () => {
  const f = fixture(); await prepare(f); f.events[1].data.id = 'new-message';
  await assert.rejects(f.settings({ op: 'commit', operationId: 'operation' }), { code: 'MANAGEMENT_STALE_INSTRUCTION' });
  assert.equal(f.calls.length, 1);
});

test('approval revalidates original human and authoritative local session before applying', async () => {
  for (const change of [f => { f.events[1].data.content[0].text = '取消'; }, f => { f.state.mainSessionId = 'replaced'; },
    f => { f.events.push({ type: 'user/message', data: { id: 'machine', source: { kind: 'ticket-reply' } } }); }]) {
    const f = fixture({ risk: true }); await prepare(f); f.onApproval(() => change(f));
    await assert.rejects(f.settings({ op: 'commit', operationId: 'operation' }), /主人|会话/);
  }
});

test('cleanup previews globally, then confirms the exact selected subset and creates a host token', async () => {
  const f = fixture();
  assert.equal(await f.cleanup({ op: 'preview', includeUnsettled: true }), f.preview);
  assert.deepEqual(f.calls[0].args, { includeUnsettled: true, scope: { owner: 'desktop-owner', mode: 'global' } });
  assert.deepEqual(await f.cleanup({ op: 'commit', previewId: 'preview', ids: ['two'], requestId: 'archive-1' }), { receiptId: 'receipt' });
  const approved = JSON.parse(f.approvals[0].reason.split('\n')[1]);
  assert.deepEqual(approved.items.map(row => row.id), ['two']);
  assert.equal(approved.manifestHash, 'exact-manifest');
  const token = f.calls.find(call => call.op === 'createCleanupConfirmation').args;
  assert.deepEqual(token.ids, ['two']);
  assert.equal(token.source.messageId, 'human-1');
  assert.equal(token.actorId, 'desktop-owner');
});

test('cleanup rejects expanded scope, duplicate IDs, non-one-time approval and local side chats', async () => {
  for (const selected of [['missing'], ['one', 'one']]) {
    const f = fixture(); await assert.rejects(f.cleanup({ op: 'commit', previewId: 'preview', ids: selected, requestId: 'archive' }), { code: 'CLEANUP_SCOPE_DENIED' });
    assert.equal(f.approvals.length, 0);
  }
  for (const outcome of [true, 'allowed-always', 'rejected']) {
    const f = fixture(); f.setOutcome(outcome);
    await assert.rejects(f.cleanup({ op: 'commit', previewId: 'preview', ids: ['one'], requestId: 'archive' }), { code: 'MANAGEMENT_APPROVAL_DENIED' });
    assert.equal(f.calls.some(call => call.op === 'createCleanupConfirmation'), false);
  }
  const f = fixture({ threadId: 'side' });
  await f.settings({ op: 'catalog' });
  await assert.rejects(f.cleanup({ op: 'preview' }), { code: 'CLEANUP_SCOPE_DENIED' });
});

test('restore uses its persisted manifest and exact host-approved subset', async () => {
  const f = fixture();
  const preview = await f.cleanup({ op: 'restore', receiptId: 'receipt' });
  assert.equal(preview.previewId, 'restore-preview'); assert.equal(f.approvals.length, 0);
  assert.deepEqual(await f.cleanup({ op: 'restore', previewId: preview.previewId, ids: ['one'], requestId: 'restore-1' }), { receiptId: 'restored' });
  const call = f.calls.find(call => call.op === 'restoreCleanup');
  assert.equal(call.args.previewId, 'restore-preview');
  assert.equal(Object.hasOwn(call.args, 'versions'), false);
  await assert.rejects(f.cleanup({ op: 'commit', previewId: preview.previewId, ids: ['one'], requestId: 'wrong-type' }), { code: 'CLEANUP_SCOPE_DENIED' });
  await f.cleanup({ op: 'history', ticketId: 'one', limit: 3 });
  assert.equal(f.calls.at(-1).op, 'cleanupHistory');
});

test('fallback replay query classification never treats settings changes or cleanup commits as reads', () => {
  for (const op of ['catalog', 'read', 'history']) assert.equal(isRouterQuery('assistant_settings', { op }), true);
  for (const op of ['prepare', 'commit', 'rollback']) assert.equal(isRouterQuery('assistant_settings', { op }), false);
  for (const op of ['preview', 'history']) assert.equal(isRouterQuery('assistant_task_cleanup', { op }), true);
  assert.equal(isRouterQuery('assistant_task_cleanup', { op: 'restore', receiptId: 'receipt' }), true);
  assert.equal(isRouterQuery('assistant_task_cleanup', { op: 'restore', previewId: 'preview', requestId: 'restore-1' }), false);
  assert.equal(isRouterQuery('assistant_task_cleanup', { op: 'commit' }), false);
  assert.equal(isRouterQuery('assistant_config', {}), false, 'removed legacy tool has no fallback read exemption');
});
