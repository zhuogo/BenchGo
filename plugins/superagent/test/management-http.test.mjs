import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsManagement, applySettingsOps, settingsFingerprint } from '../../benchgo/src/settings-management.mjs';
import { createAssistantStore } from '../src/store.mjs';
import { createAssistantRuntimeStore } from '../src/runtime-store.mjs';
import { createTaskManagement } from '../src/task-management.mjs';
import { createAssistantSettingsAdapter } from '../src/settings-adapter.mjs';
import { createConnectionSettingsAdapter } from '../src/connection-settings-adapter.mjs';
import { createManagementHttp } from '../src/management-http.mjs';
import { registerAssistantFetchRoute } from '../src/assistant-fetch-route.mjs';

const owner = { principal: { kind: 'owner' } };
const ref = { adapterId: 'superagent', namespace: 'superagent' };
const set = (path, value) => ({ op: 'set', path, value });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-management-http-'));
  const store = await createAssistantStore({ dataDirectory: directory });
  const database = createAssistantRuntimeStore({ directory: store.paths.directory });
  const tasks = createTaskManagement({ database, orchestration: store.orchestration });
  let settings = createSettingsManagement({ directory: join(directory, 'settings') });
  t.after(async () => { await settings.close(); database.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const register = async () => {
    await settings.register(createAssistantSettingsAdapter(store, {
      applyConfig: ({ ops, expected, signal }) => store.updateConfig({}, { settingsOps: ops, expected, signal }),
    })).ready;
    await settings.register(createConnectionSettingsAdapter(store.connections)).ready;
  };
  await register();
  const createHttp = () => createManagementHttp({ settings, taskManagement: tasks, profileId: store.profileId,
    readConfig: () => store.getConfig(), readConnection: channel => store.connections.read(channel), readLearning: () => store.memory.learning() });
  let http = createHttp();
  store.orchestration.createThread({ id: 'main', source: { type: 'desktop', id: 'owner' } });
  const ticket = id => { store.orchestration.createTicket({ id, threadId: 'main', target: id, mandate: {} }); return store.orchestration.cancelTicket(id); };
  return { directory, store, database, tasks, ticket, get settings() { return settings; }, get http() { return http; },
    async reopenManagement() {
      await settings.close(); settings = createSettingsManagement({ directory: join(directory, 'settings') });
      await register(); http = createHttp();
    } };
}

test('management HTTP derives owner authority only from its trusted Peer', async t => {
  const f = await fixture(t);
  for (const peer of [undefined, {}, { principal: { kind: 'channel', id: 'desktop-owner' } }, { principal: { kind: 'worker' } }]) {
    const forged = { actor: { kind: 'owner', id: 'desktop-owner' }, principal: { kind: 'owner' }, confirmed: true, confirmedBy: true };
    await assert.rejects(f.http.patchAssistant({ ...forged, patch: { workerConcurrency: 3 } }, peer), { code: 'OWNER_REQUIRED' });
    await assert.rejects(f.http.dispatch({ ...forged, action: 'settingsCatalog' }, peer), { code: 'OWNER_REQUIRED' });
    assert.throws(() => f.http.cleanup({ ...forged, action: 'taskCleanupPreview' }, peer), { code: 'OWNER_REQUIRED' });
  }
  assert.equal((await f.store.getConfig()).workerConcurrency, 2);
  assert.equal(f.tasks.cleanupHistory().length, 0);
});

test('settings HTTP freezes exact safety changes, blocks prohibited paths and preserves siblings', async t => {
  const f = await fixture(t), read = () => f.http.dispatch({ action: 'settingsRead', ...ref }, owner);
  const initial = await read();
  const plan = await f.http.dispatch({ action: 'settingsPrepare', ...ref, expectedRevision: initial.revision,
    ops: [set(['capabilities', 'proactive'], true)], requestId: 'capability-plan' }, owner);
  assert.equal(plan.requiresConfirmation, true);
  await assert.rejects(f.http.dispatch({ action: 'settingsCommit', operationId: plan.operationId, digest: 'different', confirmed: true }, owner), { code: 'SETTINGS_CONFIRMATION_REQUIRED' });
  assert.equal((await f.store.getConfig()).capabilities.proactive, false);
  const receipt = await f.http.dispatch({ action: 'settingsCommit', operationId: plan.operationId, digest: plan.digest }, owner);
  assert.equal(receipt.verified, true);
  assert.deepEqual(await f.http.dispatch({ action: 'settingsCommit', operationId: plan.operationId, digest: plan.digest }, owner), receipt);
  const current = await read();
  await assert.rejects(f.http.dispatch({ action: 'settingsPrepare', ...ref, expectedRevision: current.revision,
    ops: [set(['pet'], null)] }, owner), { code: 'SETTINGS_BLOCKED' });
  await f.http.patchAssistant({ patch: { workerConcurrency: 3 }, revision: current.backendRevision }, owner);
  const saved = await f.store.getConfig();
  assert.equal(saved.workerConcurrency, 3); assert.equal(saved.capabilities.proactive, true);
});

test('page Save retries reuse the same request without another configuration write', async t => {
  const f = await fixture(t), initial = await f.store.getConfig();
  const input = { patch: { workerConcurrency: 4 }, revision: initial.revision, requestId: 'save-retry' };
  const first = await f.http.patchAssistant(input, owner);
  const repeated = await f.http.patchAssistant(input, owner);
  assert.deepEqual(repeated, first);
  assert.equal((await f.store.getConfig()).revision, initial.revision + 1);
  await assert.rejects(f.http.patchAssistant({ ...input, patch: { workerConcurrency: 5 } }, owner), { code: 'SETTINGS_IDEMPOTENCY_CONFLICT' });
  await f.reopenManagement();
  assert.deepEqual(await f.http.patchAssistant(input, owner), first);
  await assert.rejects(f.http.patchAssistant({ ...input, patch: { workerConcurrency: 5 } }, owner), { code: 'SETTINGS_IDEMPOTENCY_CONFLICT' });
  assert.equal((await f.store.getConfig()).revision, initial.revision + 1);
  const noRevision = { patch: { workerConcurrency: 5 }, requestId: 'save-without-revision' };
  const second = await f.http.patchAssistant(noRevision, owner);
  assert.deepEqual(await f.http.patchAssistant(noRevision, owner), second);
  await f.reopenManagement();
  assert.deepEqual(await f.http.patchAssistant(noRevision, owner), second);
  await assert.rejects(f.http.patchAssistant({ ...noRevision, patch: { workerConcurrency: 6 } }, owner), { code: 'SETTINGS_IDEMPOTENCY_CONFLICT' });
  assert.equal((await f.store.getConfig()).revision, initial.revision + 2);
});

test('cleanup HTTP binds manifest and operation type, archives only its subset, and restores with CAS', async t => {
  const f = await fixture(t); f.ticket('one'); f.ticket('two');
  const call = input => f.http.cleanup(input, owner);
  const preview = call({ action: 'taskCleanupPreview', ticketIds: ['one', 'two'] });
  const archive = { action: 'taskCleanupCommit', previewId: preview.previewId, manifestHash: preview.manifestHash,
    selectedTicketIds: ['one'], requestId: 'archive-http' };
  assert.throws(() => call({ ...archive, manifestHash: 'different', confirmedBy: true }), { code: 'CLEANUP_CONFLICT' });
  assert.throws(() => call({ ...archive, action: 'taskCleanupRestore' }), { code: 'CLEANUP_CONFLICT' });
  assert.throws(() => call({ ...archive, selectedTicketIds: ['missing'] }), { code: 'CLEANUP_CONFIRMATION_REQUIRED' });
  assert.throws(() => f.tasks.update({ kind: 'ticket', id: 'two', operation: 'delete', version: 0 }), { code: 'CLEANUP_PREVIEW_REQUIRED' });
  const archived = call(archive);
  assert.deepEqual(call(archive), archived);
  assert.throws(() => call({ ...archive, selectedTicketIds: ['two'] }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(f.store.orchestration.listTickets({ archived: false }).map(row => row.id), ['two']);
  let restore = call({ action: 'taskCleanupRestorePreview', ticketIds: ['one'] });
  let restoreInput = { action: 'taskCleanupRestore', previewId: restore.previewId, manifestHash: restore.manifestHash,
    selectedTicketIds: ['one'], requestId: 'restore-http' };
  assert.throws(() => call({ ...restoreInput, action: 'taskCleanupCommit' }), { code: 'CLEANUP_CONFLICT' });
  f.tasks.update({ kind: 'ticket', id: 'one', operation: 'rename', title: 'Changed', version: 1 });
  assert.throws(() => call(restoreInput), { code: 'CLEANUP_CONFLICT' });
  restore = call({ action: 'taskCleanupRestorePreview', ticketIds: ['one'] });
  restoreInput = { ...restoreInput, previewId: restore.previewId, manifestHash: restore.manifestHash };
  const restored = call(restoreInput);
  assert.deepEqual(call(restoreInput), restored);
  assert.equal(f.database.meta('task-presentation:ticket:one').title, 'Changed');
  assert.equal(call({ action: 'taskCleanupHistory', ticketId: 'one' }).history.length, 2);
});

test('settings HTTP read and history redact secrets and reject secret or blocked edits', async t => {
  const f = await fixture(t);
  const secretRef = { adapterId: 'secret-fixture', namespace: 'secret-fixture' };
  let value = { enabled: false, token: 'private-secret-sentinel' }, revision = 0;
  const snapshot = () => ({ value, revision, fingerprint: settingsFingerprint({ value, revision }), secrets: [{ path: ['token'], set: true }] });
  await f.settings.register({ id: secretRef.adapterId,
    schema: async () => [{ namespace: secretRef.namespace, risk: 'ordinary', sensitivePaths: [['token']], applies: 'live',
      schema: { type: 'object', properties: { enabled: { type: 'boolean' }, token: { type: 'string' } }, additionalProperties: false },
      pathPolicies: [{ path: ['enabled'], risk: 'blocked' }] }],
    read: async () => structuredClone(snapshot()),
    apply: async (_namespace, input) => { value = applySettingsOps(value, input.ops); revision++; return snapshot(); },
  }).ready;
  const read = await f.http.dispatch({ action: 'settingsRead', ...secretRef }, owner);
  assert.equal(read.value.token, '[REDACTED]');
  for (const [ops, code] of [[[set(['token'], 'new-secret')], 'SETTINGS_SECRET_BLOCKED'], [[set([], {})], 'SETTINGS_SECRET_BLOCKED'], [[set(['enabled'], true)], 'SETTINGS_BLOCKED']])
    await assert.rejects(f.http.dispatch({ action: 'settingsPrepare', ...secretRef, expectedRevision: read.revision, ops }, owner), { code });
  value = { ...value, token: 'rotated-secret-sentinel' }; revision++;
  await f.http.dispatch({ action: 'settingsRead', ...secretRef }, owner);
  const history = await f.http.dispatch({ action: 'settingsHistory', ...secretRef }, owner);
  assert.equal(history.history[0].reversible, false);
  await assert.rejects(f.http.dispatch({ action: 'settingsRollback', historyId: history.history[0].id,
    expectedRevision: history.history[0].revision }, owner), { code: 'SETTINGS_ROLLBACK_BLOCKED' });
  const bytes = (await readFile(join(f.directory, 'settings', 'settings-management.db'))).toString('utf8');
  for (const secret of ['private-secret-sentinel', 'rotated-secret-sentinel', 'new-secret']) {
    assert(!JSON.stringify({ read, history }).includes(secret)); assert(!bytes.includes(secret));
  }
});

test('fetch binding uses the official browser Peer and never a principal in request JSON', async () => {
  let route, received;
  const browserPeer = { principal: { kind: 'owner' } };
  registerAssistantFetchRoute({ connection: { browserPeer, fetch: { register(value) { route = value; return () => {}; } } },
    dispatch: async (input, peer) => { received = { input, peer }; return { ok: true }; } });
  const response = await route.fetch(new Request('http://localhost/api/commander/assistant', { method: 'POST',
    headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'settingsCatalog', principal: { kind: 'owner', id: 'forged' } }) }));
  assert.equal(response.status, 200); assert.equal(received.peer, browserPeer);
  assert.equal(received.peer.principal.id, undefined);
  const blocked = await route.fetch(new Request('http://localhost/api/commander/assistant', { method: 'POST',
    headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(blocked.status, 403);
});
