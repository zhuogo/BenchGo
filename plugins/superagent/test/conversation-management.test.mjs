import test from 'node:test';
import assert from 'node:assert/strict';
import { registerConversationManagement } from '../src/conversation-management.mjs';
import { isRouterQuery } from '../src/model-fallback.mjs';

function fixture({ threadId = 'main', risk = false, approvalPolicy = 'ask' } = {}) {
  const events = [{ type: 'turn/start' }, { type: 'user/message', data: { id: 'human-1', source: { kind: 'user' }, content: [{ type: 'text', text: '修改设置并整理任务' }] } }];
  const agent = { id: 'owner-session', status: 'running', session: { header: {}, snapshotEvents: () => structuredClone(events) } };
  const state = { mainSessionId: agent.id, threads: [{ id: 'side', sessionId: agent.id }] };
  const calls = [], approvals = [], definitions = new Map(), tokens = new WeakSet();
  let outcome = 'allowed-once', approvalHook;
  const approval = { overrideOf: () => approvalPolicy, request: async request => { approvals.push(request); await approvalHook?.(); return outcome; } };
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
  const preview = { previewId: 'preview', manifestHash: 'exact-manifest', items: [{ id: 'one', title: '任务一', metaVersion: 3 }, { id: 'two', title: '任务二', metaVersion: 2 }], excluded: [{ id: 'running', reason: '执行中' }] };
  const restore = { ...preview, previewId: 'restore-preview', type: 'restore', receiptId: 'receipt' };
  const taskManagement = {
    update: args => { calls.push({ op: 'update', args }); return { id: args.id, kind: 'task', taskMeta: { title: args.title, version: args.version + 1 } }; },
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
  return { events, agent, state, calls, approvals, ctx, store, definitions, exec, preview, taskManagement,
    setOutcome: value => { outcome = value; }, onApproval: hook => { approvalHook = hook; },
    settings: (args, execution = exec) => definitions.get('assistant_settings').execute(args, execution),
    manage: (args, execution = exec) => definitions.get('assistant_task_manage').execute(args, execution),
    cleanup: (args, execution = exec) => definitions.get('assistant_task_cleanup').execute(args, execution) };
}

const prepare = f => f.settings({ op: 'prepare', adapterId: 'any-plugin', namespace: 'opaque.namespace', expectedRevision: 3,
  ops: [{ op: 'set', path: ['arbitrary', '0', 'modelId'], value: 'opaque/model:id' }] });

test('generic settings preserve exact paths and IDs; ordinary explicit edits need no approval or task', async () => {
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

test('never policy keeps protected settings blocked but permits reversible owner archive and restore', async () => {
  const settings = fixture({ risk: true, approvalPolicy: 'never' });
  settings.setOutcome('rejected'); await prepare(settings);
  await assert.rejects(settings.settings({ op: 'commit', operationId: 'operation' }), { code: 'APPROVAL_POLICY_NEVER' });
  for (const operation of [
    { op: 'commit', previewId: 'preview', ids: ['one'], requestId: 'archive' },
    { op: 'restore', previewId: 'restore-preview', ids: ['one'], requestId: 'restore' },
  ]) {
    const f = fixture({ approvalPolicy: 'never' }); f.setOutcome('rejected');
    await f.cleanup(operation.op === 'restore' ? { op: 'restore', receiptId: 'receipt' } : { op: 'preview', ids: ['one'] });
    assert.ok((await f.cleanup(operation)).receiptId);
    assert.equal(f.approvals.length, 0);
    assert.equal(f.calls.some(call => call.op === 'createCleanupConfirmation'), true);
  }
  const ordinary = fixture({ approvalPolicy: 'never' }); await prepare(ordinary);
  assert.deepEqual(await ordinary.settings({ op: 'commit', operationId: 'operation' }), { verified: true });
  assert.equal(ordinary.approvals.length, 0, 'ordinary explicit settings changes do not acquire an approval requirement');
});

test('tools reject model-supplied confirmation and identity even when schema validation is bypassed', async () => {
  for (const key of ['confirmed', 'authorized', 'actor', 'confirmedBy', 'scope']) {
    const f = fixture();
    await assert.rejects(f.settings({ op: 'catalog', [key]: true }), { code: 'MANAGEMENT_INPUT' });
    await assert.rejects(f.cleanup({ op: 'preview', [key]: true }), { code: 'MANAGEMENT_INPUT' });
    await assert.rejects(f.manage({ op: 'rename', id: 'one', title: '新标题', version: 3, [key]: true }), { code: 'MANAGEMENT_INPUT' });
    assert.equal(f.calls.length, 0);
  }
});

test('owner authority excludes workers, channels, machine turns, stale sessions and closed turns', async () => {
  const mutations = [
    f => { f.exec.agent = { ...f.agent }; }, f => { f.agent.session.header.origin = 'subagent'; },
    f => { f.agent.status = 'idle'; }, f => { f.ctx.agents.get = () => ({ ...f.agent }); },
    f => { f.ctx.agents.currentInitiator = () => ({ ...f.agent }); }, f => { f.state.mainSessionId = 'other'; },
    f => { f.events.push({ type: 'turn/end' }); }, f => { f.events[1].data.source.kind = 'notification'; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.settings({ op: 'catalog' }), { code: 'MANAGEMENT_OWNER_REQUIRED' });
    await assert.rejects(f.cleanup({ op: 'preview' }), { code: 'MANAGEMENT_OWNER_REQUIRED' });
    await assert.rejects(f.manage({ op: 'rename', id: 'one', title: '新标题', version: 3 }), { code: 'MANAGEMENT_OWNER_REQUIRED' });
    assert.equal(f.calls.length, 0);
  }
  const channel = fixture({ threadId: 'side' }); channel.state.threads[0].sourceKey = 'channel';
  await assert.rejects(channel.settings({ op: 'catalog' }), { code: 'MANAGEMENT_OWNER_REQUIRED' });
  channel.state.threads[0].sourceKey = undefined; channel.state.threads[0].source = { channel: 'feishu' };
  await assert.rejects(channel.settings({ op: 'catalog' }), { code: 'MANAGEMENT_OWNER_REQUIRED' });
  await assert.rejects(channel.manage({ op: 'rename', id: 'one', title: '新标题', version: 3 }), { code: 'MANAGEMENT_OWNER_REQUIRED' });
});

test('ordinary plan cannot be committed from another human instruction', async () => {
  const f = fixture(); await prepare(f); f.events[1].data.id = 'new-message';
  await assert.rejects(f.settings({ op: 'commit', operationId: 'operation' }), { code: 'MANAGEMENT_STALE_INSTRUCTION' });
  assert.equal(f.calls.length, 1);
});

test('approval revalidates original human and authoritative local session before applying', async () => {
  for (const change of [f => { f.events[1].data.content[0].text = '取消'; }, f => { f.state.mainSessionId = 'replaced'; }]) {
    const f = fixture({ risk: true }); await prepare(f); f.onApproval(() => change(f));
    await assert.rejects(f.settings({ op: 'commit', operationId: 'operation' }), /主人|会话/);
  }
});

test('cleanup previews globally, then binds the exact selected subset to the real owner instruction', async () => {
  const f = fixture();
  assert.equal(await f.cleanup({ op: 'preview', includeUnsettled: true }), f.preview);
  assert.deepEqual(f.calls[0].args, { includeUnsettled: true, scope: { owner: 'desktop-owner', mode: 'global' } });
  assert.deepEqual(await f.cleanup({ op: 'commit', previewId: 'preview', ids: ['two'], requestId: 'archive-1' }), { receiptId: 'receipt' });
  assert.equal(f.approvals.length, 0);
  const token = f.calls.find(call => call.op === 'createCleanupConfirmation').args;
  assert.deepEqual(token.ids, ['two']);
  assert.equal(token.source.messageId, 'human-1');
  assert.equal(token.actorId, 'desktop-owner');
  assert.equal(token.manifestHash, 'exact-manifest');
});

test('cleanup rejects expanded scope, duplicate IDs and a preview not prepared for this instruction', async () => {
  for (const selected of [['missing'], ['one', 'one']]) {
    const f = fixture(); await f.cleanup({ op: 'preview', ids: ['one', 'two'] });
    await assert.rejects(f.cleanup({ op: 'commit', previewId: 'preview', ids: selected, requestId: 'archive' }), { code: 'CLEANUP_SCOPE_DENIED' });
    assert.equal(f.approvals.length, 0);
  }
  for (const prepare of [async () => {}, async f => { await f.cleanup({ op: 'preview', ids: ['one'] }); f.events[1].data.id = 'human-2'; }]) {
    const f = fixture(); await prepare(f);
    await assert.rejects(f.cleanup({ op: 'commit', previewId: 'preview', ids: ['one'] }), { code: 'MANAGEMENT_STALE_INSTRUCTION' });
    assert.equal(f.calls.some(call => call.op === 'createCleanupConfirmation'), false);
  }
});

test('cleanup revalidates the human instruction after asynchronous preview reads and before committing', async () => {
  for (const operation of ['preview', 'restore', 'commit']) {
    const f = fixture();
    if (operation === 'commit') await f.cleanup({ op: 'preview', ids: ['one'] });
    const method = { preview: 'previewCleanup', restore: 'previewRestore', commit: 'getCleanupPreview' }[operation];
    const read = f.taskManagement[method];
    f.taskManagement[method] = async args => { const value = read(args); f.events[1].data.content[0].text = '不要再整理了'; return value; };
    await assert.rejects(f.cleanup(operation === 'preview' ? { op: 'preview', ids: ['one'] }
      : operation === 'restore' ? { op: 'restore', receiptId: 'receipt' } : { op: 'commit', previewId: 'preview', ids: ['one'] }), { code: 'MANAGEMENT_STALE_INSTRUCTION' });
    assert.equal(f.calls.some(call => call.op === 'createCleanupConfirmation'), false);
  }
});

test('rename is direct product management and only supports changing the versioned display title', async () => {
  for (const threadId of ['main', 'side']) {
    const f = fixture({ threadId, approvalPolicy: 'never' });
    const result = await f.manage({ op: 'rename', id: 'one', title: '项目文档', version: 3 });
    assert.deepEqual(result, { id: 'one', kind: 'task', taskMeta: { title: '项目文档', version: 4 } });
    assert.deepEqual(f.calls, [{ op: 'update', args: { kind: 'task', operation: 'rename', id: 'one', title: '项目文档', version: 3 } }]);
    assert.equal(f.approvals.length, 0);
    for (const op of ['delete', 'complete', 'reopen']) await assert.rejects(f.manage({ op, id: 'one', version: 4 }), { code: 'MANAGEMENT_INPUT' });
  }
});

test('a current local side chat can preview, archive and restore global task history', async () => {
  const f = fixture({ threadId: 'side' });
  await f.cleanup({ op: 'preview', ids: ['one'] });
  assert.deepEqual(f.calls[0].args.scope, { owner: 'desktop-owner', mode: 'global' });
  await f.cleanup({ op: 'commit', previewId: 'preview', ids: ['one'], requestId: 'side-archive' });
  assert.equal(f.calls.at(-1).op, 'commitCleanup');
  await f.cleanup({ op: 'restore', receiptId: 'receipt' });
  await f.cleanup({ op: 'restore', previewId: 'restore-preview', ids: ['one'], requestId: 'side-restore' });
  assert.equal(f.calls.at(-1).op, 'restoreCleanup');
  assert.equal(f.approvals.length, 0);
  f.state.threads[0].source = { channel: 'feishu' };
  await assert.rejects(f.cleanup({ op: 'preview' }), { code: 'MANAGEMENT_OWNER_REQUIRED' });
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
  await f.cleanup({ op: 'history', taskId: 'one', limit: 3 });
  assert.equal(f.calls.at(-1).op, 'cleanupHistory');
});

test('fallback replay query classification never treats settings changes or cleanup commits as reads', () => {
  for (const op of ['catalog', 'read', 'history']) assert.equal(isRouterQuery('assistant_settings', { op }), true);
  for (const op of ['prepare', 'commit', 'rollback']) assert.equal(isRouterQuery('assistant_settings', { op }), false);
  for (const op of ['preview', 'history']) assert.equal(isRouterQuery('assistant_task_cleanup', { op }), true);
  assert.equal(isRouterQuery('assistant_task_cleanup', { op: 'restore', receiptId: 'receipt' }), true);
  assert.equal(isRouterQuery('assistant_task_cleanup', { op: 'restore', previewId: 'preview', requestId: 'restore-1' }), false);
  assert.equal(isRouterQuery('assistant_task_cleanup', { op: 'commit' }), false);
  assert.equal(isRouterQuery('assistant_task_manage', { op: 'rename' }), false);
  assert.equal(isRouterQuery('assistant_config', {}), false, 'removed legacy tool has no fallback read exemption');
});

test('cleanup keeps real input after an internal notice and generates its request identity', async () => {
  const f = fixture();
  f.events.push({ type: 'user/message', data: { id: 'notice', source: { kind: 'task-reply' } } });
  await f.cleanup({ op: 'preview', ids: ['one'] });
  await f.cleanup({ op: 'commit', previewId: 'preview', ids: ['one'] });
  assert.equal(f.approvals.length, 0);
  const committed = f.calls.find(row => row.op === 'commitCleanup').args;
  assert.match(committed.requestId, /^[a-f0-9]{64}$/);
  assert.equal(committed.confirmedBy.source.messageId, 'human-1');
});

test('replayed cleanup reads its durable receipt without a second confirmation', async () => {
  const f = fixture();
  let receipt;
  f.taskManagement.commitCleanup = args => {
    receipt = { receiptId: 'saved', requestId: args.requestId, confirmedBy: { ids: args.ids }, items: args.ids.map(id => ({ id, after: { archived: true } })) };
    f.preview.consumedBy = receipt.receiptId;
    return receipt;
  };
  f.taskManagement.cleanupHistory = args => { assert.deepEqual(args, { receiptId: 'saved' }); return [receipt]; };
  await f.cleanup({ op: 'preview', ids: ['one'] });
  const input = { op: 'commit', previewId: 'preview', ids: ['one'] };
  assert.equal(await f.cleanup(input), await f.cleanup(input));
  assert.equal(f.approvals.length, 0);
  assert.deepEqual(receipt.items, [{ id: 'one', after: { archived: true } }]);
});

 test('cleanup history accepts exact receipt lookup and identifies unsupported parameters accurately', async () => {
  const f = fixture();
  await f.cleanup({ op: 'history', receiptId: 'receipt', limit: 10 });
  assert.deepEqual(f.calls.at(-1).args, { receiptId: 'receipt', limit: 10 });
  assert.equal(f.approvals.length, 0);
  await assert.rejects(f.cleanup({ op: 'history', unknownField: true }), error => error.code === 'MANAGEMENT_INPUT'
    && error.message.includes('history') && error.message.includes('unknownField'));
  await assert.rejects(f.cleanup({ op: 'history', receiptId: 'receipt', confirmed: true }), { code: 'MANAGEMENT_INPUT' });
});

 test('cleanup history passes the official object output contract through real tool execution', async t => {
  const { loadRolePackage } = await import('./role-host-fixture.mjs');
  const load = name => loadRolePackage('core/agent-loop', name);
  const { Context } = await load('@deepseek-ai/cordis');
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  for (const name of ['session', 'session-projection', 'system-prompt', 'tools', 'agent']) await ctx.plugin((await load(`@deepseek-ai/dsh-${name}`)).default);
  const f = fixture();
  await ctx.plugin(await loadRolePackage('core/tool-executor-native', '@deepseek-ai/dsh-tool-executor-native'));
  const definition = f.definitions.get('assistant_task_cleanup');
  ctx.tools.register({ name: 'history_contract', description: 'History contract', parameters: { type: 'object', properties: definition.properties, required: definition.required },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: args => f.cleanup(args) });
  const batch = await ctx.tools.execute({ signal: new AbortController().signal, calls: [{ type: 'tool-call', id: 'history-output', name: 'history_contract', arguments: JSON.stringify({ op: 'history', receiptId: 'receipt', limit: 10 }) }] });
  const result = batch.results[0].result;
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.content[0].text), { history: [] });
});
