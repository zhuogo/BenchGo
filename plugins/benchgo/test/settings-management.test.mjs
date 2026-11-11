import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsManagement, applySettingsOps, settingsFingerprint } from '../src/settings-management.mjs';

const owner = { kind: 'owner', id: 'human', profileId: 'isolated', sessionId: 'router' };
function fixtureAdapter({ risk = 'ordinary', secret = false } = {}) {
  const base = { count: 1, enabled: false, keep: 'unchanged', ...(secret ? { token: 'private-secret-sentinel' } : {}) };
  let user = {}, revision = 0, calls = 0;
  const listeners = new Set();
  const descriptor = { namespace: 'sample', title: '示例配置', impact: '更新当前示例服务', applies: 'live', ...(risk ? { risk } : {}),
    sensitivePaths: secret ? [['token']] : [], schema: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 20 }, enabled: { type: 'boolean' }, keep: { type: 'string' }, ...(secret ? { token: { type: 'string' } } : {}) }, additionalProperties: false } };
  const read = async () => ({ value: { ...base, ...user }, user: structuredClone(user), base: structuredClone(base), revision, fingerprint: settingsFingerprint({ user, revision }) });
  const notify = () => listeners.forEach(listener => listener({ namespace: 'sample' }));
  const adapter = { id: 'fixture', schema: async () => [structuredClone(descriptor)], read,
    async apply(_namespace, { ops, expected }) {
      const current = await read();
      if (current.fingerprint !== expected.fingerprint || current.revision !== expected.revision) throw Object.assign(new Error('backend conflict'), { code: 'SETTINGS_CONFLICT' });
      user = applySettingsOps(user, ops); revision++; calls++; notify(); return read();
    }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  return { adapter, descriptor, calls: () => calls, external(patch) { user = { ...user, ...patch }; revision++; notify(); } };
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-settings-'));
  let manager = createSettingsManagement({ directory });
  const f = fixtureAdapter(options), register = manager.register(f.adapter);
  await register.ready;
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...f, directory, get manager() { return manager; }, async reopen() { await manager.close(); manager = createSettingsManagement({ directory }); await manager.register(f.adapter).ready; } };
}
const ref = { adapterId: 'fixture', namespace: 'sample' };
const set = (field, value) => ({ op: 'set', path: [field], value });
test('startup and notification bursts observe each namespace without reprojecting the whole directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-settings-scale-'));
  const manager = createSettingsManagement({ directory });
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  let listener, descriptions = 0, reads = 0, revision = 0;
  const rows = Array.from({ length: 40 }, (_, index) => ({ namespace: String(index), risk: 'ordinary', applies: 'live', schema: { type: 'object' } }));
  const registration = manager.register({ id: 'many',
    async schema() { descriptions++; if (descriptions === 1) for (const row of rows) listener({ namespace: row.namespace }); return rows; },
    async read() { reads++; return { value: { revision }, fingerprint: String(revision) }; },
    async apply() {}, subscribe(callback) { listener = callback; return () => {}; },
  });
  await registration.ready; await manager.flush();
  assert.equal(descriptions, 2, 'initial catalog plus one coalesced official discovery notification');
  assert.equal(reads, 80);
  revision++;
  for (const row of rows) listener({ namespace: row.namespace });
  await manager.flush();
  assert.equal(descriptions, 3, 'one catalog for the entire burst');
  assert.equal(manager.history({ limit: 100 }).length, 40);
  assert.equal((await manager.read({ adapterId: 'many', namespace: '0' })).value.revision, 1);
});
async function prepare(manager, ops, extra = {}) {
  const current = await manager.read(ref);
  return manager.prepare({ ...ref, ops, expectedRevision: current.revision, ...extra }, owner);
}

test('ordinary registered fields are discovered dynamically, preserve other values and commit once', async t => {
  const f = await fixture(t), manager = f.manager;
  f.descriptor.schema.properties.newSetting = { type: 'string', enum: ['new', 'old'] };
  assert.ok((await manager.catalog()).entries[0].schema.properties.newSetting);
  const plan = await prepare(manager, [set('newSetting', 'new')], { requestId: 'one-change' });
  assert.equal(plan.requiresConfirmation, false);
  const [first, second] = await Promise.all([manager.commit(plan, owner), manager.commit(plan, owner)]);
  assert.deepEqual(first, second); assert.equal(f.calls(), 1);
  const current = await manager.read(ref);
  assert.equal(current.value.newSetting, 'new'); assert.equal(current.value.keep, 'unchanged');
  assert.deepEqual((await manager.prepare({ ...ref, ops: [set('newSetting', 'new')], expectedRevision: plan.revision, requestId: 'one-change' }, owner)).operationId, plan.operationId);
  await assert.rejects(manager.prepare({ ...ref, ops: [set('newSetting', 'old')], expectedRevision: plan.revision, requestId: 'one-change' }, owner), { code: 'SETTINGS_IDEMPOTENCY_CONFLICT' });
  await assert.rejects(prepare(manager, [set('count', 0)]), { code: 'SETTINGS_SCHEMA_REJECTED' });
  await assert.rejects(prepare(manager, [set('undeclared', true)]), { code: 'SETTINGS_SCHEMA_REJECTED' });
});

test('first page edit is journaled after registration, CAS and inverse rollback survive restart', async t => {
  const f = await fixture(t), initial = await f.manager.read(ref);
  f.external({ count: 7 }); await f.manager.flush();
  const [external] = f.manager.history();
  assert.equal(external.source, 'external'); assert.equal(external.reversible, true);
  assert.deepEqual(external.diff[0], { path: ['count'], before: { present: true, value: 1 }, after: { present: true, value: 7 } });
  await assert.rejects(f.manager.prepare({ ...ref, ops: [set('count', 2)], expectedRevision: initial.revision }, owner), { code: 'SETTINGS_CONFLICT' });
  const revision = (await f.manager.read(ref)).revision;
  await f.reopen(); assert.equal((await f.manager.read(ref)).revision, revision);
  const rollback = await f.manager.rollback({ historyId: external.id, expectedRevision: revision }, owner);
  await f.manager.commit(rollback, owner);
  assert.equal((await f.manager.read(ref)).value.count, 1);
  assert.equal(f.manager.history()[0].rollbackOf, external.id);
});

test('host request lookup reuses the persisted original intent across current revision changes and restart', async t => {
  const f = await fixture(t), request = { ...ref, requestId: 'http-save', ops: [set('count', 6)] };
  assert.equal(await f.manager.lookupRequest(request, owner), null);
  const current = await f.manager.read(ref);
  const plan = await f.manager.prepare({ ...request, expectedRevision: current.revision }, owner);
  assert.equal((await f.manager.lookupRequest(request, owner)).state, 'prepared');
  const receipt = await f.manager.commit(plan, owner);
  f.external({ count: 7 }); await f.manager.flush();
  await f.reopen();
  const replay = await f.manager.lookupRequest(request, owner);
  assert.equal(replay.operationId, plan.operationId); assert.equal(replay.state, 'completed'); assert.deepEqual(replay.receipt, receipt);
  assert.equal(f.calls(), 1); assert.equal((await f.manager.read(ref)).value.count, 7);
  await assert.rejects(f.manager.lookupRequest({ ...request, ops: [set('count', 8)] }, owner), { code: 'SETTINGS_IDEMPOTENCY_CONFLICT' });
  await assert.rejects(f.manager.prepare({ ...request, expectedRevision: (await f.manager.read(ref)).revision }, owner), { code: 'SETTINGS_IDEMPOTENCY_CONFLICT' });
  assert.equal(await f.manager.lookupRequest(request, { ...owner, sessionId: 'other-owner-session' }), null);
});

test('unknown risk requires exact one-time human confirmation; boolean, always and wrong digest fail', async t => {
  const f = await fixture(t, { risk: null }), manager = f.manager;
  for (const outcome of [true, 'allowed-always', { outcome: 'allowed-once', digest: 'other-diff' }]) {
    const plan = await prepare(manager, [set('enabled', true)]);
    assert.equal(plan.requiresConfirmation, true);
    await assert.rejects(manager.commit(plan, { ...owner, confirm: async () => outcome }), { code: 'SETTINGS_CONFIRMATION_DENIED' });
  }
  assert.equal(f.calls(), 0);
  let confirmations = 0;
  const plan = await prepare(manager, [set('enabled', true)]);
  const actor = { ...owner, confirm: async actual => {
    confirmations++; assert.equal(actual.digest, plan.digest);
    assert.deepEqual(actual.diff, [{ path: ['enabled'], before: { present: true, value: false }, after: { present: true, value: true } }]);
    return { outcome: 'allowed-once', digest: actual.digest };
  } };
  await Promise.all([manager.commit(plan, actor), manager.commit(plan, actor)]);
  await manager.commit(plan, actor);
  assert.equal(confirmations, 1); assert.equal(f.calls(), 1);
});

test('waiting for human confirmation leaves reads and writes responsive and rechecks CAS', async t => {
  const f = await fixture(t, { risk: 'confirm' }), manager = f.manager;
  const plan = await prepare(manager, [set('enabled', true)]);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const commit = manager.commit(plan, { ...owner, confirm: async actual => { entered(); await gate; return { outcome: 'allowed-once', digest: actual.digest }; } });
  await waiting;
  const read = await manager.read(ref); assert.equal(read.value.enabled, false);
  f.external({ keep: 'page-changed' }); await manager.flush();
  const other = await prepare(manager, [set('count', 3)]);
  await manager.commit(other, { ...owner, confirm: async actual => ({ outcome: 'allowed-once', digest: actual.digest }) });
  release(); await assert.rejects(commit, { code: 'SETTINGS_CONFLICT' });
  assert.equal((await manager.read(ref)).value.enabled, false);
});

test('secret values never enter reads, history or the journal; ordinary secret mutations and rollback block', async t => {
  const f = await fixture(t, { secret: true }), manager = f.manager;
  assert(!JSON.stringify(await manager.read(ref)).includes('private-secret-sentinel'));
  for (const ops of [[set('token', 'new-secret')], [{ op: 'unset', path: ['token'] }], [{ op: 'set', path: [], value: { count: 1 } }]])
    await assert.rejects(prepare(manager, ops), { code: 'SETTINGS_SECRET_BLOCKED' });
  f.external({ token: 'rotated-secret-sentinel' }); await manager.flush();
  const history = manager.history()[0];
  assert.equal(history.reversible, false);
  await assert.rejects(manager.rollback({ historyId: history.id, expectedRevision: history.revision }, owner), { code: 'SETTINGS_ROLLBACK_BLOCKED' });
  const plan = await prepare(manager, [set('count', 4)]); await manager.commit(plan, owner);
  const bytes = (await readFile(join(f.directory, 'settings-management.db'))).toString('utf8');
  for (const secret of ['private-secret-sentinel', 'rotated-secret-sentinel', 'new-secret']) assert(!bytes.includes(secret));
});

test('masked required secrets retain their original types without blocking ordinary changes', async t => {
  const f = await fixture(t, { secret: true });
  f.descriptor.schema.properties.token = { type: 'object', properties: { credential: { type: 'string' } }, required: ['credential'] };
  f.descriptor.schema.required = ['token', 'count'];
  const plan = await prepare(f.manager, [set('count', 4)]);
  const receipt = await f.manager.commit(plan, owner);
  assert.equal(receipt.verified, true);
  f.external({ token: 'second-rotation' }); await f.manager.flush();
  assert.equal(f.manager.history()[0].reversible, false);
});

test('trusted normalization changes only requested values before diff, confirmation and readback', async t => {
  const f = await fixture(t, { risk: 'confirm' });
  f.adapter.normalizeOps = async (_namespace, { ops, current }) => {
    assert.equal(current.value.keep, 'unchanged');
    return ops.map(op => op.path[0] === 'keep' ? { ...op, value: op.value.trim() } : op);
  };
  const plan = await prepare(f.manager, [set('keep', '  canonical  ')], { requestId: 'normalized' });
  assert.equal(plan.diff[0].after.value, 'canonical');
  const receipt = await f.manager.commit(plan, { ...owner, confirm: async actual => {
    assert.equal(actual.diff[0].after.value, 'canonical');
    return { outcome: 'allowed-once', digest: actual.digest };
  } });
  assert.equal(receipt.verified, true); assert.equal((await f.manager.read(ref)).value.keep, 'canonical');
  f.adapter.normalizeOps = async () => [set('enabled', true)];
  await assert.rejects(prepare(f.manager, [set('count', 3)]), { code: 'SETTINGS_NORMALIZATION_INVALID' });
});

test('saved receipts distinguish pending, reload-required and failed runtime application', async t => {
  const f = await fixture(t), original = f.adapter.apply;
  for (const [i, state] of ['pending', 'reload-required', 'failed', 'applied'].entries()) {
    f.adapter.apply = async (...args) => ({ ...await original(...args), application: { state, reason: 'runtime-result' } });
    const plan = await prepare(f.manager, [set('count', i + 2)]);
    const receipt = await f.manager.commit(plan, owner);
    assert.equal(receipt.verified, true); assert.equal(receipt.application.state, state); assert.equal(receipt.application.reason, 'runtime-result');
  }
  f.adapter.apply = original;
  const receipt = await f.manager.commit(await prepare(f.manager, [set('count', 8)]), owner);
  assert.equal(receipt.application.state, 'pending');
});

test('readback detects unintended writes and an uncertain operation cannot be replayed', async t => {
  const f = await fixture(t), manager = f.manager, original = f.adapter.apply;
  f.adapter.apply = async (...args) => { await original(...args); f.external({ keep: 'unrequested-change' }); return { success: true }; };
  const plan = await prepare(manager, [set('count', 5)]);
  await assert.rejects(manager.commit(plan, owner), { code: 'SETTINGS_READBACK_FAILED' });
  await assert.rejects(manager.commit(plan, owner), { code: 'SETTINGS_OPERATION_SETTLED' });
  assert.equal(f.calls(), 1); assert.equal(manager.history()[0].state, 'uncertain');
});

test('trusted owner boundary, path protections and failed initial observations are explicit', async t => {
  const f = await fixture(t), manager = f.manager;
  await assert.rejects(manager.prepare({ ...ref, ops: [set('count', 2)], expectedRevision: 0 }, { kind: 'worker', id: 'worker' }), { code: 'SETTINGS_OWNER_REQUIRED' });
  await assert.rejects(prepare(manager, [{ op: 'set', path: ['__proto__'], value: {} }]), { code: 'SETTINGS_INPUT' });
  await assert.rejects(prepare(manager, [set('count', { __jsExpr: 'run code' })]), { code: 'SETTINGS_INPUT' });
  const dispose = manager.register({ id: 'unavailable', schema: async () => [{ namespace: 'missing', schema: {} }], read: async () => { throw new Error('storage unavailable'); }, apply() {} });
  await assert.rejects(dispose.ready); await assert.rejects(manager.flush(), { code: 'SETTINGS_OBSERVATION_FAILED' });
  dispose(); await manager.flush();
});
