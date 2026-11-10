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

test('preferences remount the original sidebar scope and await actual apply while preserving SSH scope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-workbench-remount-'));
  let adapter, sidebarMounts = 0, sidebarDisposals = 0, sshMounts = 0, unregisters = 0;
  const services = {
    connection: { requestRejection() {} }, webServer: { register() { return () => {}; } }, sessions: {}, tools: {}, systemPrompt: {},
    benchgoSettings: { register(value) { adapter = value; return () => { unregisters++; }; } },
  };
  const runtime = host(services);
  try {
    const workbench = await mountWorkbench(runtime.ctx, {
      directory,
      loadSidebar: async () => ({ async apply(ctx) {
        sidebarMounts++;
        if (ctx.get('settings').snapshot().value.customCss === 'fail-remount') throw new Error('真实侧栏挂载失败');
        ctx.effect(() => () => { sidebarDisposals++; });
      } }),
      loadSsh: async () => ({ async apply() { sshMounts++; } }),
    });
    await runtime.settle();
    assert.equal(sidebarMounts, 1); assert.equal(sshMounts, 1);
    let current = await adapter.read(SIDEBAR_NS);
    let saved = await adapter.apply(SIDEBAR_NS, { ops: [{ op: 'set', path: ['editorExplorer'], value: false }], expected: { fingerprint: current.fingerprint, revision: current.revision } });
    assert.equal(saved.application.state, 'applied');
    assert.equal(sidebarMounts, 2); assert.equal(sidebarDisposals, 1); assert.equal(sshMounts, 1);
    assert.equal(workbench.snapshot().sidebar.status, 'ready');
    current = await adapter.read(SIDEBAR_NS);
    saved = await adapter.apply(SIDEBAR_NS, { ops: [{ op: 'set', path: ['customCss'], value: 'fail-remount' }], expected: { fingerprint: current.fingerprint, revision: current.revision } });
    assert.equal(saved.application.state, 'failed');
    assert.match(saved.application.reason, /原侧栏运行时挂载失败/u);
    assert.equal(workbench.snapshot().sidebar.status, 'error');
    await runtime.dispose();
    assert.equal(unregisters, 1);
    const mountsAtDispose = sidebarMounts;
    await workbench.preferences.update(SIDEBAR_NS, { customCss: '' }, workbench.preferences.snapshot().revision);
    assert.equal(sidebarMounts, mountsAtDispose);
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
});
