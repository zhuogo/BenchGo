import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { startSidebarPolling } from '../client/sidebar-refresh.mjs';
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
function fixture(refresh) {
  const listeners = new Map(), jobs = new Map(), errors = []; let sequence = 0, active = false;
  const page = { hidden: false, addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
  const stop = startSidebarPolling({ refresh, onError: error => errors.push(error), isActive: () => active, document: page, schedule: (fn, ms) => { const id = ++sequence; jobs.set(id, { fn, ms }); return id; }, unschedule: id => jobs.delete(id) });
  return { page, listeners, jobs, errors, stop, active: value => { active = value; }, visibility(hidden) { page.hidden = hidden; listeners.get('visibilitychange')?.(); }, tick() { const [id, job] = jobs.entries().next().value; jobs.delete(id); void job.fn(); } };
}
test('sidebar polls slowly when idle, quickly when running, and suspends hidden tabs', async () => {
  let reads = 0; const f = fixture(async () => { reads++; }); await flush();
  assert.equal(reads, 1); assert.equal([...f.jobs.values()][0].ms, 10000);
  f.active(true); f.tick(); await flush(); assert.equal([...f.jobs.values()][0].ms, 2000);
  f.visibility(true); assert.equal(f.jobs.size, 0); assert.equal(reads, 2);
  f.visibility(false); await flush(); assert.equal(reads, 3); assert.equal(f.jobs.size, 1);
  f.stop(); assert.equal(f.jobs.size, 0); assert.equal(f.listeners.size, 0);
});
test('visibility changes never overlap requests and disposed failures do not notify', async () => {
  let reject, signal, reads = 0; const f = fixture(s => { reads++; signal = s; return new Promise((_, no) => { reject = no; }); });
  f.visibility(true); f.visibility(false); f.visibility(false); assert.equal(reads, 1);
  f.stop(); assert.equal(signal.aborted, true); reject(Error('aborted')); await flush();
  assert.equal(f.jobs.size, 0); assert.deepEqual(f.errors, []);
});
test('a failed visible request retries instead of stopping the sidebar', async () => {
  let reads = 0; const f = fixture(async () => { if (++reads === 1) throw Error('offline'); }); await flush();
  assert.equal(f.errors.length, 1); assert.equal([...f.jobs.values()][0].ms, 1000); f.tick(); await flush(); assert.equal(reads, 2); assert.equal([...f.jobs.values()][0].ms, 10000); f.stop();
});

test('late sidebar failures and cancellation cannot replace a newer healthy snapshot', async () => {
  const source = await readFile(new URL('../client/index.jsx', import.meta.url), 'utf8');
  const { code } = transformSync(source + '\nexport { refresh }; export const snapshot = () => data;', { loader: 'jsx', format: 'cjs' });
  const pending = [], module = { exports: {} };
  runInNewContext(code, {
    module, exports: module.exports, AbortSignal, URL,
    document: { baseURI: 'http://localhost/' },
    fetch: () => { const request = Promise.withResolvers(); pending.push(request); return request.promise; },
    require: id => id.endsWith('perf-trace.mjs') ? { perfTrace: { time: () => () => {} } }
      : id.endsWith('http-response.mjs') ? { readJsonResponse: response => response.json() } : {},
  });
  const { refresh, snapshot } = module.exports;
  const old = refresh(), latest = refresh();
  pending[1].resolve({ json: async () => ({ selected: 'fresh', projects: [], sessions: [] }) });
  await latest;
  pending[0].reject(Error('old network failure'));
  await old;
  assert.equal(snapshot().selected, 'fresh');
  assert.equal(snapshot().error, '');

  const controller = new AbortController(), cancelled = refresh(controller.signal), next = refresh();
  controller.abort();
  pending[3].resolve({ json: async () => ({ selected: 'newest', projects: [], sessions: [] }) });
  await next;
  pending[2].resolve({ json: async () => ({ selected: 'stale', projects: [], sessions: [] }) });
  await cancelled;
  assert.equal(snapshot().selected, 'newest');

  const failed = refresh();
  pending[4].reject(Error('current network failure'));
  await assert.rejects(failed, /current network failure/);
});

test('project registration closes the dialog while session initialization and sidebar reads are pending', async () => {
  const source = await readFile(new URL('../client/index.jsx', import.meta.url), 'utf8');
  const body = source.split('onSelected={(project, device) => {')[1]?.split('\n    }} />}')[0];
  assert(body, 'The sidebar project completion callback must exist');
  const session = Promise.withResolvers(), sidebar = Promise.withResolvers();
  const effects = [];
  let error = '';
  const selected = runInNewContext('((project, device) => {' + body + '\n})', {
    navigation: { activeId: 'host', refreshProjects: device => effects.push(['refresh', device.id]) },
    setAddingProject: value => effects.push(['dialog', value]),
    newLocalSession: (id, propagate) => { effects.push(['session', id, propagate]); return session.promise; },
    refresh: () => { effects.push(['state']); return sidebar.promise; },
    openRemote: (device, resource) => effects.push(['remote', device.id, resource.resourceId, resource.intent]),
    connectionMessage: cause => cause.message,
    setError: value => { error = typeof value === 'function' ? value(error) : value; },
  });
  assert.equal(selected({ id: 'project' }, { id: 'host' }), undefined);
  assert.deepEqual(effects, [['dialog', false], ['session', 'project', true], ['state']]);
  session.reject(Error('初始化失败'));
  sidebar.reject(Error('侧栏刷新失败'));
  await flush();
  assert.equal(error, '初始化失败');

  effects.length = 0;
  assert.equal(selected({ id: 'remote-project' }, { id: 'remote' }), undefined);
  assert.deepEqual(effects, [['dialog', false], ['remote', 'remote', 'remote-project', 'newSession'], ['refresh', 'remote']]);
});
