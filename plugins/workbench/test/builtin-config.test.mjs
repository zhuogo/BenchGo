import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountWorkbench } from '../src/plugin.mjs';
import { SIDEBAR_NS } from '../src/preferences.mjs';

function host(services) {
  const pending = [], children = [], effects = [];
  const ctx = {
    get: name => services[name], provide: (name, service) => { services[name] = service; },
    ...services, logger: { warn() {} },
    effect(callback) { effects.push(callback()); },
    inject(names, callback) {
      const child = host(services);
      const ready = names.every(name => services[name]) ? Promise.resolve().then(() => callback(child.ctx)) : Promise.resolve();
      pending.push(ready); children.push(child);
      return { async dispose() { await ready; await child.dispose(); } };
    },
  };
  ctx.fiber = { entry: { options: {} } };
  let stopped = false;
  return { ctx, async settle() { await Promise.all(pending); }, async dispose() {
    if (stopped) return; stopped = true;
    await Promise.all(pending);
    for (const dispose of effects.reverse()) await dispose?.();
    for (const child of children.reverse()) await child.dispose();
  } };
}

test('built-in workbench mounts once without registering a configuration surface', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-workbench-builtin-'));
  let sidebarMounts = 0, sidebarDisposals = 0, sshMounts = 0, settingsRegistrations = 0;
  const services = {
    connection: { requestRejection() {} }, webServer: { register() { return () => {}; } }, sessions: {}, tools: {}, systemPrompt: {},
    benchgoSettings: { register() { settingsRegistrations++; return () => {}; } },
  };
  const runtime = host(services);
  try {
    const workbench = await mountWorkbench(runtime.ctx, {
      directory,
      loadSidebar: async () => ({ async apply(ctx) {
        sidebarMounts++;
        assert.equal(ctx.get('settings').snapshot().value.editorExplorer, true);
        assert.equal(ctx.get('settings').snapshot().value.agentOpenTools, false);
        assert.equal(ctx.loader.entries()[0].options.id, SIDEBAR_NS);
        assert.equal(ctx.profileContext, undefined);
        ctx.effect(() => () => { sidebarDisposals++; });
      } }),
      loadSsh: async () => ({ async apply() { sshMounts++; } }),
    });
    await runtime.settle();
    assert.equal(sidebarMounts, 1); assert.equal(sshMounts, 1);
    assert.equal(settingsRegistrations, 0);
    await assert.rejects(workbench.preferences.update(SIDEBAR_NS, { editorExplorer: false }, 0), /固定配置/);
    assert.equal(sidebarMounts, 1); assert.equal(sidebarDisposals, 0); assert.equal(sshMounts, 1);
    assert.equal(workbench.snapshot().sidebar.status, 'ready');
    await runtime.dispose();
    assert.equal(sidebarDisposals, 1);
    assert.equal(settingsRegistrations, 0);
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
});
