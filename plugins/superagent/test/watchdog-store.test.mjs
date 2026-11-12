import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWatchdogStore } from '../src/watchdog-store.mjs';
import { resolveWatchdogConfig } from '../src/watchdog-config.mjs';

test('restart preserves unfinished check as interrupted, without claiming completion', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-watchdog-interrupted-'));
  const config = resolveWatchdogConfig({ targetId: 'audit-target', targetUrl: 'http://127.0.0.1:3000', tokenFile: join(directory, 'token') });
  let store = await createWatchdogStore({ directory, config });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.update(state => state.checks.push({ id: 'check', status: 'running', completedAt: null }));
  await store.close();
  store = await createWatchdogStore({ directory, config });
  assert.equal(store.snapshot().checks[0].status, 'interrupted');
  assert.equal(store.snapshot().checks[0].completedAt, null);
  assert.equal(store.snapshot().lastCheckAt, null);
});
