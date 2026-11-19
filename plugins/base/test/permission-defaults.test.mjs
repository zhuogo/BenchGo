import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { installRoleHost } from '../../superagent/test/role-host-fixture.mjs';

const official = new URL('../../../deepseek-harness/', import.meta.url);
const coreRequire = createRequire(new URL('packages/core/agent-loop/package.json', official));
const includeRequire = createRequire(new URL('vendor/include/package.json', official));
const load = name => import(pathToFileURL(coreRequire.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const services = await Promise.all([
  '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
].map(load));
const { Session } = services[1];
const { applyEntryPatches, entryListSchema } = await import(new URL('vendor/include/lib/index.js', official));
const { load: parseYaml } = includeRequire('js-yaml');
const yaml = source => parseYaml(source, { schema: entryListSchema });

async function permissionRow(surface = 'web', profilePreset) {
  const files = ['packages/bundle/base/cordis.patch.yml'];
  if (surface === 'web') files.push('packages/bundle/web-app/cordis.patch.yml');
  const layers = await Promise.all(files.map(async path => yaml(await readFile(new URL(path, official), 'utf8'))));
  layers.push(yaml(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')));
  const warnings = [];
  const warn = (...warning) => warnings.push(warning);
  let rows = applyEntryPatches([], layers.flat(), warn);
  if (profilePreset) {
    // Official patches replace the whole config; a valid profile keeps its
    // preset catalog while selecting a different default in the final layer.
    const config = { ...rows.find(row => row.id === 'permission').config, defaultPreset: profilePreset };
    rows = applyEntryPatches(rows, yaml(`- id: permission\n  config: ${JSON.stringify(config)}\n`), warn);
  }
  assert.deepEqual(warnings, []);
  const matches = rows.filter(row => row.id === 'permission');
  assert.equal(matches.length, 1, 'the existing official permission service is configured once');
  assert.equal(matches[0].name, '@deepseek-ai/dsh-permission-presets');
  return matches[0];
}

async function host(t, row) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const [index, service] of services.entries()) {
    await ctx.plugin(service.default, index === services.length - 1 ? { agents: [] } : undefined);
  }
  // Real official permission, sandbox and approval services; the shared host
  // deliberately cannot execute a shell, and these tests never submit a prompt.
  await installRoleHost(ctx, { permissionPresetConfig: row.config });
  assert.ok(ctx.permissionPresets);
  return ctx;
}

async function freshAgent(ctx, sessionId, seed) {
  return (await ctx.agents.create({ sessionId, ...(seed === undefined ? {} : { seed }) })).agent;
}

function permission(ctx, session) {
  return {
    preset: ctx.permissionPresets.current(session),
    sandbox: ctx.sandboxPolicy.resolve({ session }).mode,
    approval: ctx.approval.overrideOf(session) ?? ctx.approval.config.policy,
  };
}

const full = { preset: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' };
const limited = preset => ({ preset, sandbox: preset, approval: 'ask' });

for (const surface of ['base', 'web']) {
  test(`${surface} composes Full as the ordinary fresh Agent permission without changing the official preset table`, async t => {
    const row = await permissionRow(surface);
    assert.equal(row.config.defaultPreset, 'danger-full-access');
    assert.deepEqual(Object.keys(row.config.presets), ['read-only', 'workspace-write', 'danger-full-access']);
    const ctx = await host(t, row);
    const agent = await freshAgent(ctx, `fresh-${surface}`);
    assert.equal(ctx.permissionPresets.defaultPreset, 'danger-full-access');
    assert.deepEqual(permission(ctx, agent.session), full);
    assert.deepEqual(agent.session.snapshotEvents().filter(event => ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type)).map(event => [event.type, event.data]), [
      ['permission/preset', { preset: 'danger-full-access' }],
      ['sandbox/mode', { mode: 'danger-full-access' }],
      ['approval/policy', { policy: 'never' }],
    ]);
  });
}

for (const preset of ['workspace-write', 'read-only']) {
  test(`the Full default preserves an explicitly ${preset} seeded session`, async t => {
    const ctx = await host(t, await permissionRow());
    const old = Session.create(`old-${preset}`);
    old.append('permission/preset', { preset });
    old.append('sandbox/mode', { mode: preset });
    old.append('approval/policy', { policy: 'ask' });
    const restored = await freshAgent(ctx, `restored-${preset}`, old.snapshotEvents());
    assert.deepEqual(permission(ctx, restored.session), limited(preset));
    assert.equal(restored.session.snapshotEvents().some(event => event.type === 'permission/preset' && event.data.preset === 'danger-full-access'), false);
    assert.deepEqual(permission(ctx, (await freshAgent(ctx, `new-after-${preset}`)).session), full);
  });
}

test('an explicit lower permission on a new session stays local to that session and survives restoration', async t => {
  const ctx = await host(t, await permissionRow());
  for (const preset of ['workspace-write', 'read-only']) {
    const agent = await freshAgent(ctx, `lower-${preset}`);
    assert.deepEqual(permission(ctx, agent.session), full);
    ctx.permissionPresets.set(agent.session, preset);
    assert.deepEqual(permission(ctx, agent.session), limited(preset));
    const restored = await freshAgent(ctx, `lower-restored-${preset}`, agent.session.snapshotEvents());
    assert.deepEqual(permission(ctx, restored.session), limited(preset));
  }
  assert.equal(ctx.permissionPresets.defaultPreset, 'danger-full-access');
  assert.deepEqual(permission(ctx, (await freshAgent(ctx, 'independent-fresh')).session), full);
});

for (const preset of ['workspace-write', 'read-only']) {
  test(`an explicit user profile ${preset} default takes precedence over BenchGo Full`, async t => {
    const row = await permissionRow('web', preset);
    assert.equal(row.config.defaultPreset, preset);
    assert.deepEqual(Object.keys(row.config.presets), ['read-only', 'workspace-write', 'danger-full-access']);
    const ctx = await host(t, row);
    assert.equal(ctx.permissionPresets.defaultPreset, preset);
    assert.deepEqual(permission(ctx, (await freshAgent(ctx, `profile-${preset}`)).session), limited(preset));
  });
}
