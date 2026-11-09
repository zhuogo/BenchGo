import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Schema from '@deepseek-ai/schemastery';
import { boot, initProfile, readProfilePatches, createConfigProjector } from '../../../deepseek-harness/packages/boot/app-boot/lib/index.js';
import ConfigEditor from '../../../deepseek-harness/packages/boot/config-editor/lib/index.js';
import Settings from '../../../deepseek-harness/packages/settings/settings/lib/index.js';
import { createOfficialSettingsAdapter } from '../src/settings-official.mjs';
import { createSettingsManagement } from '../src/settings-management.mjs';

const owner = { kind: 'owner', id: 'isolated-human', sessionId: 'router' };
const ref = { adapterId: 'official', namespace: 'probe' };
const set = (field, value) => ({ op: 'set', path: [field], value });
async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'benchgo-official-settings-')));
  const directory = join(home, 'profiles', 'test');
  initProfile(directory, ['test-settings-bundle']);
  const bundle = join(directory, 'node_modules', 'test-settings-bundle');
  await mkdir(bundle, { recursive: true });
  await writeFile(join(home, 'package.json'), '{"name":"isolated-settings-test"}\n');
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-settings-bundle', version: '1', dsh: { bundle: { patch: 'cordis.patch.yml' } } }));
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: 'probe', name: 'cordis:probe', config: { ordinary: 'fixed', token: 'official-private-sentinel' } },
    { id: 'no-schema', name: 'cordis:untyped' },
  ] }]));
  await writeFile(join(directory, 'cordis.yml'), '[]\n');
  const profile = { name: 'test', startedBundles: ['test-settings-bundle'], dir: directory,
    patchPath: join(directory, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined };
  let consumer, mounts = 0, ownedAdapter;
  const Probe = { Config: Schema.object({ ordinary: Schema.string().required(), count: Schema.number().min(1).max(20).default(2).volatile(),
    token: Schema.string().required().role('secret').volatile() }),
    apply(ctx, config) { mounts++; consumer = config; ownedAdapter = createOfficialSettingsAdapter(ctx, { projectSchema: project }); } };
  const projector = await createConfigProjector();
  const project = schema => {
    const result = projector(schema, 'testConfig');
    return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...result.schema, $defs: { ...result.definitions, loaderExpression: false } };
  };
  const ctx = await boot('test', join(directory, 'cordis.yml'), readProfilePatches('test', profile), ctx => {
    ctx.provide('profileContext', profile);
    Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, probe: Probe, untyped: { apply() {} } });
  });
  const adapter = createOfficialSettingsAdapter(ctx, { projectSchema: project,
    resolveMetadata: () => ({ risk: 'ordinary', impact: '更改隔离探针配置' }) });
  const manager = createSettingsManagement({ directory: join(home, 'journal') });
  await manager.register(adapter).ready;
  t.after(async () => { await manager.close(); await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); });
  return { ctx, adapter, manager, profile, Probe, consumer: () => consumer, mounts: () => mounts, ownedAdapter: () => ownedAdapter };
}
async function change(f, ops) {
  const current = await f.manager.read(ref);
  const plan = await f.manager.prepare({ ...ref, expectedRevision: current.revision, ops }, owner);
  return f.manager.commit(plan, owner);
}

test('real official live settings and nonvolatile ConfigEditor writes preserve secrets and support rollback', async t => {
  const f = await fixture(t);
  assert.equal(f.consumer().count.get(), 2);
  const live = await change(f, [set('count', 5)]);
  assert.equal(live.application.state, 'applied'); assert.equal(f.consumer().count.get(), 5); assert.equal(f.mounts(), 1);
  const current = await f.manager.read(ref);
  assert(!JSON.stringify(current).includes('official-private-sentinel'));
  assert.equal(current.value.ordinary, 'fixed');
  const rollback = await f.manager.rollback({ historyId: live.historyId, expectedRevision: current.revision }, owner);
  await f.manager.commit(rollback, owner); assert.equal(f.consumer().count.get(), 2);
  const ordinary = await change(f, [set('ordinary', 'remounted')]);
  assert.equal(ordinary.application.state, 'applied'); assert.equal(f.consumer().ordinary, 'remounted'); assert.equal(f.mounts(), 2);
  const saved = await readFile(f.profile.patchPath, 'utf8');
  assert.match(saved, /official-private-sentinel/);
  assert(!JSON.stringify(f.manager.history()).includes('official-private-sentinel'));
  const revision = (await f.manager.read(ref)).revision;
  await f.manager.commit(await f.manager.rollback({ historyId: ordinary.historyId, expectedRevision: revision }, owner), owner);
  assert.equal(f.consumer().ordinary, 'fixed');
});

test('official native schemas retain blocked entries and discover newly declared fields', async t => {
  const f = await fixture(t), catalog = await f.manager.catalog();
  const noSchema = catalog.entries.find(row => row.namespace.endsWith('no-schema'));
  assert.ok(noSchema); assert.equal(noSchema.applies, 'blocked'); assert.match(noSchema.unavailableReason, /schema/);
  f.Probe.Config.dict.newField = Schema.boolean().default(false).volatile();
  const entries = (await f.manager.catalog()).entries;
  assert(JSON.stringify(entries.find(row => row.namespace === 'probe').schema).includes('newField'));
  await change(f, [set('newField', true)]);
  assert.equal(f.consumer().newField.get(), true);
});

test('official page mutations use the same version and journal while sensitive writes remain blocked', async t => {
  const f = await fixture(t), original = await f.manager.read(ref);
  await f.ctx.settings.mutate('probe', [set('count', 8)]);
  await f.manager.flush();
  const record = f.manager.history()[0];
  assert.equal(record.source, 'external'); assert.equal(record.reversible, true);
  await assert.rejects(f.manager.prepare({ ...ref, expectedRevision: original.revision, ops: [set('count', 4)] }, owner), { code: 'SETTINGS_CONFLICT' });
  const current = await f.manager.read(ref);
  await assert.rejects(f.manager.prepare({ ...ref, expectedRevision: current.revision, ops: [set('token', 'never-ordinary-json')] }, owner), { code: 'SETTINGS_SECRET_BLOCKED' });
  await f.manager.commit(await f.manager.rollback({ historyId: record.id, expectedRevision: current.revision }, owner), owner);
  assert.equal(f.consumer().count.get(), 2);
});

test('remounting the management owner is explicitly blocked while its volatile fields remain usable', async t => {
  const f = await fixture(t), adapter = f.ownedAdapter();
  const metadata = (await adapter.schema()).find(row => row.namespace === 'probe');
  assert.match(metadata.nonLiveBlockedReason, /销毁/);
  assert(metadata.pathPolicies.some(row => row.path.join('.') === 'ordinary' && row.risk === 'blocked'));
  const snapshot = await adapter.read('probe');
  await assert.rejects(adapter.apply('probe', { ops: [set('ordinary', 'must-not-remount')], expected: { fingerprint: snapshot.fingerprint, revision: snapshot.revision } }), { code: 'SETTINGS_BLOCKED' });
  assert.equal(f.mounts(), 1);
  await adapter.apply('probe', { ops: [set('count', 6)], expected: { fingerprint: snapshot.fingerprint, revision: snapshot.revision } });
  assert.equal(f.consumer().count.get(), 6); assert.equal(f.mounts(), 1);
});
