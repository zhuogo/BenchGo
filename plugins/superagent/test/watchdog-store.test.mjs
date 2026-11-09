import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWatchdogStore } from '../src/watchdog-store.mjs';
import { resolveWatchdogConfig } from '../src/watchdog-config.mjs';

test('independent audit persists bounded judgement tracking without raw response or routing credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-watchdog-audit-'));
  const config = resolveWatchdogConfig({ targetId: 'audit-target', targetUrl: 'http://127.0.0.1:3000',
    tokenFile: join(directory, 'secret-token-path'), retentionChecks: 10 });
  let store = await createWatchdogStore({ directory, config });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const binding = { kind: 'judgement', ticketId: 'ticket', runId: 'run', instructionRevision: 1 };
  for (let watermark = 0; watermark < 43; watermark++) await store.recordAuxiliaryActivity({ ...binding, watermark,
    status: 'judged', code: 'JUDGED', startedAt: 100, completedAt: 200, rawResponse: 'DO-NOT-PERSIST',
    routing: { token: 'DO-NOT-PERSIST' }, result: { classification: 'no-progress', reason: 'token=DO-NOT-PERSIST',
      evidenceWatermark: watermark, signalEligible: true, evidenceRefs: ['session:1'], uncertainty: 'high', hits: 2 },
    tracking: { lastAttemptAt: 100, lastJudgedWatermark: watermark, lastEvidenceFingerprint: 'a'.repeat(64), classification: 'no-progress', hits: 2 } });
  assert.equal(store.snapshot().auxiliaryActivity.length, 40);
  assert.equal(store.latestAuxiliaryActivity(binding).tracking.lastJudgedWatermark, 42);
  const filename = store.filename;
  const persisted = await readFile(filename, 'utf8');
  assert.ok(!persisted.includes('DO-NOT-PERSIST'));
  assert.ok(!persisted.includes('secret-token-path'));
  await store.close();
  store = await createWatchdogStore({ directory, config });
  assert.equal(store.latestAuxiliaryActivity(binding).tracking.hits, 2);
  assert.equal(store.latestAuxiliaryActivity({ ...binding, runId: 'replacement-run' }), null);
  assert.equal(store.latestAuxiliaryActivity({ ...binding, instructionRevision: 2 }), null);
});

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
