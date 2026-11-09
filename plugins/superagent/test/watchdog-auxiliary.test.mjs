import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConfiguredWatchdogJudge } from '../src/watchdog-plugin.mjs';
import { createWatchdogStore } from '../src/watchdog-store.mjs';
import { resolveWatchdogConfig } from '../src/watchdog-config.mjs';

test('local Watchdog auxiliary configuration requests only its exact role and persists judgement independently', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'watchdog-auxiliary-'));
  const config = resolveWatchdogConfig({ targetId: 'local', targetUrl: 'http://127.0.0.1:3000', tokenFile: join(directory, 'token') });
  let store = await createWatchdogStore({ directory, config });
  let judge; t.after(async () => { judge?.dispose(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const calls = [], llm = { async *stream(request) { calls.push(request); yield { type: 'text-delta', text: '{"classification":"insufficient-evidence","reason":"产出变化尚未知","evidenceRefs":[],"uncertainty":"high"}' }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
  assert.equal(createConfiguredWatchdogJudge({ llm, store, config }), undefined);
  judge = createConfiguredWatchdogJudge({ llm, store, config, auxiliary: { revision: 3, capabilities: ['summary'],
    models: [{ providerId: 'Aux/Exact', modelId: 'Opaque: Model@1', options: { maxTokens: 321 } }] } });
  const result = await judge({ evidence: { ticketId: 'ticket', runId: 'run', instructionRevision: 1, watermark: 1,
    observationStartedAt: Date.now() - 200000, anomalies: ['worker-inactive'], facts: {} } });
  assert.equal(result.status, 'judged'); assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'Aux/Exact'); assert.equal(calls[0].model, 'Opaque: Model@1');
  assert.equal(calls[0].maxTokens, 321); assert.deepEqual(calls[0].tools, []);
  const binding = { kind: 'judgement', ticketId: 'ticket', runId: 'run', instructionRevision: 1 };
  assert.equal(store.latestAuxiliaryActivity(binding).status, 'judged');
  const persisted = await readFile(store.filename, 'utf8'); assert.ok(persisted.includes('insufficient-evidence'));
  judge.dispose(); await store.close(); store = await createWatchdogStore({ directory, config });
  assert.equal(store.latestAuxiliaryActivity(binding).tracking.lastJudgedWatermark, 1);
});
