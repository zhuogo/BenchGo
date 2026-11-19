import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountWorkbench } from '../src/plugin.mjs';
import { prepareWorkbenchVendors } from '../scripts/vendor-adapter.mjs';

test('actual pinned vendor hosts mount through the composition without model tools', async () => {
  await prepareWorkbenchVendors();
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-workbench-host-'));
  const routes = [], upgrades = [], disposers = [], pending = [], warnings = [], tools = [];
  const ctx = {
    fiber: { entry: { options: {} } },
    connection: { requestRejection: () => undefined },
    webServer: { register(route) { routes.push(route); return () => {}; }, registerUpgrade(route) { upgrades.push(route); return () => {}; } },
    sessions: {}, tools: { register: tool => { tools.push(tool); return () => {}; } },
    systemPrompt: { section: () => { throw new Error('third-party model announcement must remain disabled'); } },
    logger: { warn: (...args) => warnings.push(args), info() {} },
    provide(name, service) { this[name] = service; },
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
    on() { return () => {}; },
    get(name) { return this[name]; },
    inject(services, callback) { const result = callback(this); if (result?.then) pending.push(result); },
  };
  try {
    const service = await mountWorkbench(ctx, { directory });
    while (pending.length) await Promise.all(pending.splice(0));
    assert.equal(service.snapshot().sidebar.status, 'ready', JSON.stringify(warnings));
    assert.equal(service.snapshot().ssh.status, 'ready', JSON.stringify(warnings));
    assert.ok(routes.some(route => route.path === '/sidebar/api'));
    assert.ok(upgrades.length > 0);
    assert.deepEqual(tools, []);
  } finally {
    for (const dispose of disposers.reverse()) await dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
