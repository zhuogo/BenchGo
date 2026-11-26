import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerConversationManagement } from '../src/conversation-management.mjs';
import { isRouterQuery } from '../src/model-fallback.mjs';

function fixture({ threadId = 'main', risk = false, approvalPolicy = 'ask' } = {}) {
  const events = [{ type: 'turn/start' }, { type: 'user/message', data: { id: 'human-1', source: { kind: 'user' }, content: [{ type: 'text', text: '修改设置并整理任务' }] } }];
  const agent = { id: 'owner-session', status: 'running', session: { header: {}, snapshotEvents: () => structuredClone(events) } };
  const state = { mainSessionId: agent.id, threads: [{ id: 'side', sessionId: agent.id }] };
  const calls = [], approvals = [], definitions = new Map(), tokens = new WeakSet();
  let outcome = 'allowed-once', approvalHook;
  agent.session.append = (type, data) => { if (type === 'approval/policy') approvalPolicy = data.policy; };
  const approval = { overrideOf: () => approvalPolicy, request: async request => {
    if (approvalPolicy === 'never') return 'rejected';
    approvals.push(request);
    await approvalHook?.();
    return outcome;
  } };
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
  return { events, agent, state, calls, approvals, ctx, store, definitions, exec, preview, taskManagement, approval,
    setOutcome: value => { outcome = value; }, onApproval: hook => { approvalHook = hook; },
    settings: (args, execution = exec) => definitions.get('assistant_settings').execute(args, execution),
    manage: (args, execution = exec) => definitions.get('assistant_task_manage').execute(args, execution),
    sessions: ({ op, ...args }, execution = exec) => definitions.get(`assistant_session_archive_${op === 'archive' ? 'apply' : op}`).execute(args, execution),
    cleanup: (args, execution = exec) => definitions.get('assistant_task_cleanup').execute(args, execution) };
}

async function sessionArchiveFixture(t) {
  const f = fixture({ approvalPolicy: 'never' });
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-session-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'dismissed-harness.json'), '["dismissed"]');
  const row = (sessionId, updatedAt, options = {}) => ({ sessionId, updatedAt, projections: { values: { title: `Chat ${sessionId}` } }, ...options });
  const items = [
    row(f.agent.id, 20), row('new', 16), row('linked', 14), row('active', 13, { running: true }), row('pinned', 12),
    row('old', 10), row('dismissed', 9), row('worker', 8), row('fork', 7, { parentSessionId: 'old' }),
    row('subagent', 6, { parentSessionId: 'old', origin: 'subagent' }), row('archived', 5), row('unrelated', 4),
  ];
  const native = [
    { id: 'link-peer', ownerSessionId: 'linked', updatedAt: 14, status: 'idle' },
    { id: 'detached', ownerSessionId: 'commander-web:detached:test', title: 'Chat native', projectId: 'demo', updatedAt: 11, status: 'idle' },
    { id: 'execution', executionId: 'exec', title: 'Execution', projectId: 'demo', updatedAt: 3, status: 'idle' },
  ];
  const writes = [];
  const registry = { archivedSessionIds: ['archived'], pinnedSessionIds: ['pinned'],
    list: () => [{ id: 'demo', title: '演示', sessionIds: items.filter(row => row.sessionId !== 'unrelated').map(row => row.sessionId) }],
    async archiveSession(id, options) {
      assert.equal(options, undefined, 'batch archive must use normal activity checks');
      writes.push(`official:${id}`);
      this.archivedSessionIds.push(id);
    } };
  const commander = {
    list: () => structuredClone(native),
    snapshot: id => structuredClone(native.find(row => row.id === id)),
    async archive(id, value, options) {
      assert.equal(value, true);
      assert.equal(options, undefined);
      writes.push(`native:${id}`);
      native.find(row => row.id === id).archived = true;
    },
  };
  f.ctx.benchgo = { directory };
  f.ctx.workspaceRegistry = registry;
  const get = f.ctx.get;
  f.ctx.get = name => ({ sessionController: { list: async () => ({ items: structuredClone(items) }) },
    commander, benchgoExecution: {} })[name] ?? get(name);
  f.store.orchestration = { listSessionRoles: () => [{ sessionId: 'worker', role: 'worker' }],
    executionProjections: () => [], listTasks: () => [] };
  return { ...f, items, native, writes, registry, commander };
}

test('owner can batch archive a scoped Workbench preview under never and keep protected sessions', async t => {
  const f = await sessionArchiveFixture(t);
  const preview = await f.sessions({ op: 'preview', project: '演示', title: 'chat', keepLatest: 1,
    before: '1970-01-01T00:00:00.015Z' });
  assert.deepEqual(preview.items.map(row => row.id), ['official:linked', 'native:detached', 'official:old', 'official:fork']);
  assert.equal(preview.protected, 2);
  assert.deepEqual(f.writes, []);
  const input = { op: 'archive', previewId: preview.previewId, all: true };
  const results = await Promise.all([f.sessions(input), f.sessions(input)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].archived, 4);
  assert.deepEqual(f.writes, ['official:linked', 'native:link-peer', 'native:detached', 'official:old', 'official:fork']);
  assert.deepEqual(f.approvals, []);
  assert.equal(isRouterQuery('assistant_session_archive_preview', {}), true);
  assert.equal(isRouterQuery('assistant_session_archive_apply', {}), false);
  assert.equal(isRouterQuery('assistant_session_archive_official', {}), false);
});

test('official tool execution archives the full frozen DeepSeek scope, including ungrouped sessions', async t => {
  const { loadRolePackage } = await import('./role-host-fixture.mjs');
  const load = name => loadRolePackage('core/agent-loop', name);
  const { Context } = await load('@deepseek-ai/cordis');
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  for (const name of ['session', 'session-projection', 'system-prompt', 'tools', 'agent']) await ctx.plugin((await load(`@deepseek-ai/dsh-${name}`)).default);
  await ctx.plugin(await loadRolePackage('core/tool-executor-native', '@deepseek-ai/dsh-tool-executor-native'));
  const f = await sessionArchiveFixture(t);
  for (let index = 0; index < 32; index++) f.items.push({ sessionId: `extra-${index}`, updatedAt: index + 100 });
  for (const operation of ['preview', 'apply', 'official']) {
    const name = `assistant_session_archive_${operation}`;
    const definition = f.definitions.get(name);
    ctx.tools.register({ name, description: definition.description, parameters: { type: 'object', properties: definition.properties, required: definition.required, additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: args => definition.execute(args, f.exec) });
  }
  let call = 0;
  const run = async ({ op, ...args }) => {
    const name = `assistant_session_archive_${op === 'archive' ? 'apply' : op}`;
    const batch = await ctx.tools.execute({ signal: f.exec.signal, calls: [{ type: 'tool-call', id: `archive-${++call}`, name, arguments: JSON.stringify(args) }] });
    const result = batch.results[0].result;
    assert.equal(result.isError, false, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const ungrouped = await run({ op: 'preview', harness: 'official', ids: ['official:unrelated'] });
  assert.deepEqual(ungrouped.items[0], { id: 'official:unrelated', harness: 'official', title: 'Chat unrelated', updatedAt: 4, projectId: null, project: null });
  const mixed = await run({ op: 'preview', ids: ['official:linked', 'native:detached'] });
  assert.deepEqual(mixed.items.map(row => row.harness), ['native', 'native']);
  const preview = await run({ op: 'preview', harness: 'official' });
  assert.equal(preview.total, 36);
  assert.equal(preview.items.length, 30);
  assert.equal(preview.truncated, true);
  assert.equal(preview.protected, 2);
  // The migrated session acquires an external Harness between preview and commit.
  f.native.push({ id: 'new-peer', ownerSessionId: 'new', updatedAt: 16, status: 'idle' });
  const receipt = await run({ op: 'archive', previewId: preview.previewId, all: true });
  assert.equal(receipt.archived, 35);
  assert.equal(receipt.skipped, 1);
  assert.equal(receipt.issues[0].id, 'official:new');
  assert.ok(f.writes.includes('official:unrelated'));
  assert.deepEqual(f.writes.filter(id => !id.startsWith('official:extra-')).sort(), ['official:fork', 'official:old', 'official:unrelated']);
  assert.deepEqual(await run({ op: 'official' }), { archived: 0, alreadyArchived: 0, skipped: 0, failed: 0, partial: 0,
    total: 0, issues: [], issuesTruncated: false, protected: 2 });
});

test('one no-argument official call archives eligible sessions, and replay preserves the original selection', async t => {
  const f = await sessionArchiveFixture(t);
  const definition = f.definitions.get('assistant_session_archive_official');
  assert.deepEqual(definition.properties, {});
  assert.deepEqual(definition.required, []);
  assert.equal('previewId' in f.definitions.get('assistant_session_archive_preview').properties, false);
  assert.equal('harness' in f.definitions.get('assistant_session_archive_apply').properties, false);
  await assert.rejects(f.sessions({ op: 'official', all: true }), { code: 'MANAGEMENT_INPUT' });
  const [first, second] = await Promise.all([f.sessions({ op: 'official' }), f.sessions({ op: 'official' })]);
  assert.equal(first.archived, 4);
  assert.deepEqual(second, first);
  assert.deepEqual(f.writes.sort(), ['official:fork', 'official:new', 'official:old', 'official:unrelated']);
  f.items.push({ sessionId: 'arrived', updatedAt: 32 });
  assert.deepEqual(await f.sessions({ op: 'official' }), first);
  assert.equal(f.writes.length, 4);
});

test('Workbench archive rejects expanded and stale previews and preserves newly active chats', async t => {
  const f = await sessionArchiveFixture(t);
  await assert.rejects(f.sessions({ op: 'preview', before: '2026-11-26' }), /before.+带时区/);
  await assert.rejects(f.sessions({ op: 'preview', ids: ['official:old', 'official:old'] }), /ids.+不可重复/);
  const preview = await f.sessions({ op: 'preview', ids: ['official:old', 'official:linked', 'official:fork'] });
  const apply = { op: 'archive', previewId: preview.previewId };
  await assert.rejects(f.sessions(apply), /all:true.+至少一个.+ids/);
  await assert.rejects(f.sessions({ ...apply, all: true, ids: ['official:old'] }), /all 和 ids 只能传一个/);
  await assert.rejects(f.sessions({ ...apply, ids: ['official:old', 'official:old'] }), /ids.+不可重复/);
  await assert.rejects(f.sessions({ ...apply, ids: ['official:new'] }), { code: 'SESSION_ARCHIVE_SCOPE', message: /不在该预览可归档清单/ });
  assert.deepEqual(f.writes, []);
  f.items.find(row => row.sessionId === 'old').updatedAt = 30;
  f.native.find(row => row.id === 'link-peer').status = 'waiting';
  const result = await f.sessions({ op: 'archive', previewId: preview.previewId,
    ids: ['official:old', 'official:linked', 'official:fork'] });
  assert.equal(result.archived, 1);
  assert.equal(result.skipped, 2);
  assert.deepEqual(f.writes, ['official:fork']);
  f.events.at(-1).data.id = 'human-2';
  await assert.rejects(f.sessions({ op: 'archive', previewId: preview.previewId, all: true }), { code: 'MANAGEMENT_STALE_INSTRUCTION' });
  await assert.rejects(f.sessions({ op: 'preview' }, { ...f.exec, agent: {} }), { code: 'MANAGEMENT_OWNER_REQUIRED' });
});

test('Workbench archive retries only an incomplete target and finishes native synchronization', async t => {
  const f = await sessionArchiveFixture(t);
  const archive = f.commander.archive.bind(f.commander);
  f.commander.archive = async () => { throw new Error('write interrupted'); };
  const preview = await f.sessions({ op: 'preview', ids: ['official:linked', 'official:old'] });
  const input = { op: 'archive', previewId: preview.previewId, all: true };
  const result = await f.sessions(input);
  assert.equal(result.archived, 1);
  assert.equal(result.partial, 1);
  f.commander.archive = archive;
  assert.equal((await f.sessions(input)).archived, 2);
  assert.deepEqual(f.writes, ['official:linked', 'official:old', 'native:link-peer']);
});

test('Workbench archive uses the native tool executor and persists recoverable official archive state', async t => {
  const { loadRolePackage } = await import('./role-host-fixture.mjs');
  const load = name => loadRolePackage('core/agent-loop', name);
  const { Context } = await load('@deepseek-ai/cordis');
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const name of ['session', 'session-projection', 'system-prompt', 'tools', 'agent']) {
    await ctx.plugin((await load(`@deepseek-ai/dsh-${name}`)).default);
  }
  await ctx.plugin(await loadRolePackage('core/tool-executor-native', '@deepseek-ai/dsh-tool-executor-native'));
  const f = await sessionArchiveFixture(t);
  const loadWorkspace = name => loadRolePackage('workspace/workspace', `@deepseek-ai/dsh-${name}`);
  const { SESSION_FORMAT_VERSION } = await loadWorkspace('session');
  const { DomainFacility } = await loadWorkspace('storage-domain');
  const root = join(f.ctx.benchgo.directory, 'storages');
  await ctx.plugin((await loadWorkspace('storage')).default);
  await ctx.plugin(await loadRolePackage('storage/storage-json', '@deepseek-ai/dsh-storage-json'), { root });
  const domain = new DomainFacility(ctx, { backend: 'json' });
  ctx.storage.mount('domain', domain);
  ctx.provide('storageDomain', domain);
  ctx.provide('sessionPersistence', { list: async () => [{
    header: { id: 'old', version: SESSION_FORMAT_VERSION, cwd: f.ctx.benchgo.directory, createdAt: 10, isSeeded: false },
    revision: 'persisted-old',
  }] });
  await ctx.plugin((await loadWorkspace('workspace')).default);
  f.ctx.workspaceRegistry = ctx.workspaceRegistry;
  for (const operation of ['preview', 'apply']) {
    const name = `assistant_session_archive_${operation}`;
    const { description, properties, required, execute } = f.definitions.get(name);
    ctx.tools.register({ name, description, parameters: { type: 'object', properties, required, additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: args => execute(args, f.exec) });
  }
  const invoke = async ({ op, ...args }) => {
    const name = `assistant_session_archive_${op === 'archive' ? 'apply' : op}`;
    const signal = new AbortController().signal;
    const batch = await ctx.tools.execute({ signal, calls: [{ type: 'tool-call', id: op, name, arguments: JSON.stringify(args) }] });
    const result = batch.results[0].result;
    assert.equal(result.isError, false, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const preview = await invoke({ op: 'preview', ids: ['official:old'] });
  assert.equal(preview.total, 1);
  assert.equal((await invoke({ op: 'archive', previewId: preview.previewId, all: true })).archived, 1);
  const storedArchives = async () => JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8')).global.archivedSessionIds;
  assert.deepEqual(await storedArchives(), ['old']);
  assert.equal((await invoke({ op: 'preview', ids: ['official:old'] })).total, 0);
  await ctx.workspaceRegistry.unarchiveSession('old');
  assert.deepEqual(await storedArchives(), []);
  assert.equal((await invoke({ op: 'preview', ids: ['official:old'] })).total, 1);
});

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

test('protected settings open a single approval under never and recover the session policy', async () => {
  for (const outcome of ['allowed-once', 'rejected', 'cancelled']) {
    const f = fixture({ risk: true, approvalPolicy: 'never' });
    f.setOutcome(outcome);
    await prepare(f);
    const submitted = f.settings({ op: 'commit', operationId: 'operation' });
    if (outcome === 'allowed-once') assert.deepEqual(await submitted, { verified: true });
    else await assert.rejects(submitted, { code: 'MANAGEMENT_APPROVAL_DENIED' });
    assert.equal(f.approvals.length, 1);
    assert.equal(f.approval.overrideOf(), 'never');
  }
});

test('never policy permits reversible owner archive and restore', async () => {
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
  assert.equal(await f.cleanup({ op: 'preview' }), f.preview);
  assert.deepEqual(f.calls[0].args, { scope: { owner: 'desktop-owner', mode: 'global' } });
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

test('cleanup projects compatible ID parameters and rejects duplicates before dispatch', async () => {
  const f = fixture();
  const { properties } = f.definitions.get('assistant_task_cleanup');
  assert.equal(Object.hasOwn(properties.ids, 'uniqueItems'), false);
  for (const input of [
    { op: 'preview' },
    { op: 'commit', previewId: 'preview' },
    { op: 'restore', receiptId: 'receipt' },
    { op: 'restore', previewId: 'restore-preview' },
  ]) {
    await assert.rejects(f.cleanup({ ...input, ids: ['one', 'one'] }), { code: 'CLEANUP_SCOPE_DENIED' });
  }
  assert.deepEqual(f.calls, []);
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
