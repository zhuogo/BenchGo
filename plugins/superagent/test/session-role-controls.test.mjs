import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRoleDirectory, roleDetails } from '../client/session-role-controls.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const role = (sessionId, extra = {}) => ({ sessionId, role: 'router', status: 'ready', actual: { model: { provider: 'p', model: 'opaque/id' } }, ...extra });

test('role reads share a session request, ordinary is explicit and failures never imply ordinary', async () => {
  const reads = [];
  const directory = createSessionRoleDirectory((sessionId, signal) => new Promise((resolve, reject) => reads.push({ sessionId, signal, resolve, reject })));
  const owned = directory.sourceFor('owned'), ordinary = directory.sourceFor('ordinary');
  assert.equal(directory.sourceFor(undefined).getSnapshot().phase, 'ready');
  assert.equal(owned.getSnapshot().phase, 'loading');
  const stopA = owned.subscribe(() => {}), stopB = owned.subscribe(() => {}), stopC = ordinary.subscribe(() => {});
  await tick(); assert.deepEqual(reads.map(row => row.sessionId), ['owned', 'ordinary']);
  reads[0].resolve({ role: role('owned') }); reads[1].resolve({ role: null }); await tick();
  assert.equal(owned.getSnapshot().role.role, 'router'); assert.equal(ordinary.getSnapshot().role, null);
  assert.equal(ordinary.getSnapshot().phase, 'ready');
  const before = ordinary.getSnapshot(); ordinary.refresh(); await tick();
  assert.equal(ordinary.getSnapshot(), before, 'background read keeps the confirmed ordinary component mounted');
  reads[2].reject(new Error('offline')); await tick(); assert.equal(ordinary.getSnapshot().phase, 'error');
  ordinary.refresh(); await tick(); assert.equal(ordinary.getSnapshot().phase, 'loading');
  reads[3].resolve({}); await tick(); assert.equal(ordinary.getSnapshot().phase, 'error');
  assert.match(ordinary.getSnapshot().error, /归属/);
  stopA(); stopB(); stopC(); directory.dispose();
});

test('session switches, re-entry and connection generations discard stale role responses', async () => {
  const reads = [];
  const directory = createSessionRoleDirectory((sessionId, signal) => new Promise(resolve => reads.push({ sessionId, signal, resolve })));
  const source = directory.sourceFor('one'); let stop = source.subscribe(() => {});
  await tick(); stop(); await tick(); assert(reads[0].signal.aborted);
  stop = source.subscribe(() => {}); await tick();
  reads[0].resolve({ role: null }); await tick(); assert.equal(source.getSnapshot().phase, 'loading');
  reads[1].resolve({ role: role('other') }); await tick(); assert.equal(source.getSnapshot().phase, 'error');
  source.refresh(); await tick(); directory.refresh({ reset: true, defer: true });
  assert(reads[2].signal.aborted); assert.equal(source.getSnapshot().phase, 'loading');
  reads[2].resolve({ role: null }); await tick(); assert.equal(source.getSnapshot().phase, 'loading');
  assert.equal(reads.length, 3, 'disconnect invalidates without starting another request');
  directory.refresh({ reset: true }); await tick();
  reads[3].resolve({ role: role('one', { status: 'pending', actual: null }) }); await tick();
  assert.equal(source.getSnapshot().role.status, 'pending');
  stop(); directory.dispose();
});

test('repeated invalidations coalesce and unmount prevents the queued read', async () => {
  const reads = [];
  const directory = createSessionRoleDirectory(() => new Promise(resolve => reads.push(resolve)));
  const source = directory.sourceFor('one'), stop = source.subscribe(() => {});
  await tick(); source.refresh(); source.refresh(); source.refresh();
  reads[0]({ role: null }); await tick(); assert.equal(reads.length, 2);
  source.refresh(); stop(); await tick(); reads[1]({ role: null }); await tick();
  assert.equal(reads.length, 2); assert.equal(source.getSnapshot().phase, 'loading'); directory.dispose();
});

test('a stalled role query exposes retry without accepting its late reply', async () => {
  const reads = [];
  const directory = createSessionRoleDirectory((sessionId, signal) => new Promise(resolve => reads.push({ signal, resolve })), { timeoutMs: 15 });
  const source = directory.sourceFor('one'), stop = source.subscribe(() => {});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(source.getSnapshot().phase, 'error'); assert.match(source.getSnapshot().error, /超时/); assert(reads[0].signal.aborted);
  source.refresh(); await tick(); reads[0].resolve({ role: null }); await tick(); assert.equal(source.getSnapshot().phase, 'loading');
  reads[1].resolve({ role: role('one') }); await tick(); assert.equal(source.getSnapshot().role.role, 'router');
  stop(); directory.dispose();
});

test('read-only details use actual values and preserve opaque provider/model ids', () => {
  const value = roleDetails(role('one', { expected: { sandbox: 'expected-not-effective' }, actual: {
    agentPreset: 'standard', permissionPreset: 'custom', sandbox: 'workspace-write', approval: 'never',
    model: { provider: 'opaque-provider', model: 'model/EXACT?v=2', reasoningEffort: 'vendor-effort' }, tools: ['x', 'y'],
  }, reason: { message: '子代理由父 Worker 处理审批' } }));
  assert.match(value, /model\/EXACT\?v=2/); assert.match(value, /审批策略：never/); assert.match(value, /工具：2 项/);
  assert.doesNotMatch(value, /expected-not-effective/); assert.match(roleDetails(role('one', { actual: null })), /未核验/);
});
