import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../src/pairing/store.mjs';
import { createSessionActions } from '../src/session/actions.mjs';
import { createSessionAdapter } from '../src/session/adapter.mjs';
import { createNativeAdapter } from '../src/session/native.mjs';
import { mountWeb } from '../../benchgo/src/web.mjs';

const baseTime = Date.now(), requestId = value => `sa:${baseTime}:${value}`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-session-actions-'));
  const store = await openStore(directory), calls = [], routes = new Map();
  const device = { id: 'paired-device' }, hidden = new Set(), officialRows = new Map([['session', { sessionId: 'session', running: false, updatedAt: 10, projections: { values: { title: 'Original' } } }]]);
  const project = { id: 'project', path: '/project', title: 'Project', sessionIds: ['session'] };
  const records = new Map([['direct', { id: 'direct', ownerSessionId: 'commander-web:project', projectId: 'project', cwd: '/project', status: 'idle', provider: 'codex', title: 'Native' }]]);
  let authorized = true, availableProjects = [project], currentTime = baseTime;
  const commander = { list: () => [...records.values()].map(row => ({ ...row })), async archive(id, archived) { calls.push(['native', archived ? 'archive' : 'unarchive', id]); records.get(id).archived = archived; }, async remove(id) { calls.push(['native', 'delete', id]); records.delete(id); } };
  const services = { commander, benchgo: { directory }, assistant: { sidebarPrivateSessionIds: async () => [...hidden] }, sessionTitle: {}, sessionController: { rename() {} }, workspaceController: Object.fromEntries(['pinSession', 'unpinSession', 'archiveSession', 'unarchiveSession'].map(method => [method, () => {}])) };
  const ctx = {
    get: name => services[name], effect: fn => fn(),
    workspaceRegistry: { list: () => availableProjects, archivedSessionIds: [], pinnedSessionIds: [] },
    connection: {
      fetch: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } },
      createPeer: () => ({ async dispose() {} }),
      createSharedFetchHandler: () => ({ fetch: request => routes.get(new URL(request.url).pathname).fetch(request) }),
    },
    typertGateway: {
      async invoke({ namespace, method, args }) {
        if (method === 'list') return { items: [...officialRows.values()] };
        calls.push([namespace, method, args.request]);
        const { sessionId } = args.request;
        if (method === 'rename') { officialRows.get(sessionId).projections.values.title = args.request.title; return { title: args.request.title }; }
        const key = ['pinSession', 'unpinSession'].includes(method) ? 'pinnedSessionIds' : 'archivedSessionIds';
        ctx.workspaceRegistry[key] = ['pinSession', 'archiveSession'].includes(method) ? [...new Set([...ctx.workspaceRegistry[key], sessionId])] : ctx.workspaceRegistry[key].filter(id => id !== sessionId);
        return { [key]: ctx.workspaceRegistry[key] };
      },
      wireStream: { open: async (_endpoint, _payload, _uplink, _peer, signal) => (async function* () { yield { type: 'ready', clientId: 'client' }; await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); }); })() },
    },
  };
  await mountWeb(ctx, { directory, mountFonts: async () => {} });
  const official = createSessionAdapter(ctx, { deletedIds: async () => { try { return JSON.parse(await readFile(join(directory, 'dismissed-harness.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } } });
  const native = createNativeAdapter(ctx), authorize = () => { if (!authorized) throw Object.assign(new Error('Revoked'), { status: 403, code: 'UNAUTHORIZED' }); };
  let actions = createSessionActions({ store, official, native, authorize, now: () => currentTime });
  t.after(async () => { await actions.close(); await official.close(); await rm(directory, { recursive: true, force: true }); });
  return { ctx, store, services, calls, official, native, records, hidden, officialRows, project, device, directory,
    invoke: (operation, extra = {}) => actions.dispatch({ id: 'session', native: false, operation, ...extra, requestId: extra.requestId?.startsWith('sa:') ? extra.requestId : requestId(extra.requestId ?? `${operation}-${Math.random().toString(36).slice(2)}`) }, device),
    setAuthorized: value => { authorized = value; }, setProjects: value => { availableProjects = value; }, capabilities: () => actions.capabilities(device),
    setTime: value => { currentTime = value; },
    async reopen() { const restored = await openStore(directory); actions = createSessionActions({ store: restored, official, native, authorize, now: () => currentTime }); return restored; },
  };
}

test('session actions expose exact capabilities and route explicit owner operations through official services', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.capabilities().map(({ id, operations }) => ({ id, operations })), [
    { id: 'sessionActions', operations: ['pin', 'unpin', 'archive', 'unarchive', 'rename', 'delete'] },
    { id: 'nativeSessionActions', operations: ['archive', 'unarchive', 'delete'] },
  ]);
  for (const operation of ['pin', 'pin', 'unpin', 'archive', 'unarchive']) assert.equal((await f.invoke(operation)).accepted, true);
  assert.deepEqual(f.ctx.workspaceRegistry.pinnedSessionIds, []); assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, []);
  const renamed = await f.invoke('rename', { title: 'Exact 新名称' });
  assert.equal(renamed.title, 'Exact 新名称'); assert.equal(f.officialRows.get('session').projections.values.title, 'Exact 新名称');
  assert.deepEqual(f.calls.map(row => row[1]), ['pinSession', 'pinSession', 'unpinSession', 'archiveSession', 'unarchiveSession', 'rename']);
  await assert.rejects(f.invoke('fork'), { code: 'UNSUPPORTED' });
  await assert.rejects(f.invoke('arbitraryRPC'), { code: 'UNSUPPORTED' });
  await assert.rejects(f.invoke('pin', { title: 'extra' }), { code: 'INVALID_SESSION_ACTION' });
  delete f.services.workspaceController.pinSession;
  assert.equal(f.capabilities()[0].operations.includes('pin'), false);
});

test('concurrent duplicates share one mutation and changed intent is rejected before another write', async t => {
  const f = await fixture(t), invoke = f.ctx.typertGateway.invoke;
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; }), waiting = new Promise(resolve => { release = resolve; });
  f.ctx.typertGateway.invoke = async call => { if (call.method === 'rename') { entered(); await waiting; } return invoke(call); };
  const input = { requestId: 'same-request', title: 'One' };
  const first = f.invoke('rename', input); await started;
  const duplicate = f.invoke('rename', input);
  await assert.rejects(f.invoke('rename', { ...input, title: 'Changed' }), { code: 'SESSION_ACTION_CONFLICT' });
  release(); assert.deepEqual(await first, await duplicate);
  assert.equal(f.calls.filter(row => row[1] === 'rename').length, 1);
});

test('durable receipts do not replay an older rename after a newer edit or a restart', async t => {
  const f = await fixture(t);
  await f.invoke('rename', { requestId: 'first', title: 'One' });
  await f.invoke('rename', { requestId: 'second', title: 'Two' });
  await f.reopen();
  const old = await f.invoke('rename', { requestId: 'first', title: 'One' });
  assert.equal(old.title, 'One'); assert.equal(f.officialRows.get('session').projections.values.title, 'Two');
  assert.equal(f.calls.length, 2);
});

test('attempted mutations and restart-interrupted receipts never replay automatically', async t => {
  const f = await fixture(t), invoke = f.ctx.typertGateway.invoke;
  f.ctx.typertGateway.invoke = call => call.method === 'archiveSession' ? (f.calls.push(['failed']), Promise.reject(new Error('Active session'))) : invoke(call);
  await assert.rejects(f.invoke('archive', { requestId: 'failed' }), { code: 'SESSION_ACTION_UNCERTAIN' });
  await assert.rejects(f.invoke('archive', { requestId: 'failed' }), { code: 'SESSION_ACTION_UNCERTAIN' });
  assert.equal(f.calls.length, 1);
  const saved = f.store.state.sessionActions.find(row => row.requestId === requestId('failed')); saved.state = 'applying'; await f.store.persist();
  await f.reopen();
  await assert.rejects(f.invoke('archive', { requestId: 'failed' }), { code: 'SESSION_ACTION_UNCERTAIN' });
  assert.equal(f.calls.length, 1);
});

test('a failed preflight receipt is returned without starting a later mutation', async t => {
  const f = await fixture(t), persist = f.store.persist;
  let first = true;
  f.store.persist = async () => { if (first) { first = false; throw new Error('Receipt disk full'); } await persist(); };
  await assert.rejects(f.invoke('pin', { requestId: 'failed-before-mutation' }), /Receipt disk full/);
  await assert.rejects(f.invoke('pin', { requestId: 'failed-before-mutation' }), /Receipt disk full/);
  assert.deepEqual(f.calls, []); assert.equal(f.store.state.sessionActions[0].state, 'failed');
});

test('private, subagent, moved and unregistered sessions cannot be managed', async t => {
  const f = await fixture(t);
  f.hidden.add('session'); await assert.rejects(f.invoke('pin'), { code: 'NOT_FOUND' }); f.hidden.clear();
  f.officialRows.get('session').origin = 'subagent'; await assert.rejects(f.invoke('pin'), { code: 'NOT_FOUND' }); delete f.officialRows.get('session').origin;
  await assert.rejects(f.invoke('pin', { id: 'foreign' }), { code: 'NOT_FOUND' });
  f.project.sessionIds = []; await assert.rejects(f.invoke('pin'), { code: 'NOT_FOUND' });
  assert.deepEqual(f.calls, []);
});

test('authorization and privacy are rechecked after receipt persistence and before mutation', async t => {
  for (const revoke of [f => f.setAuthorized(false), f => f.hidden.add('session'), f => f.setProjects([])]) {
    const f = await fixture(t), persist = f.store.persist;
    let first = true;
    f.store.persist = async () => { await persist(); if (first) { first = false; revoke(f); } };
    await assert.rejects(f.invoke('pin'));
    assert.deepEqual(f.calls, []);
  }
});

test('a completed receipt still requires current visibility and a lost final receipt never replays a mutation', async t => {
  const f = await fixture(t);
  const input = { requestId: 'completed', title: 'Saved' };
  await f.invoke('rename', input);
  f.hidden.add('session'); await assert.rejects(f.invoke('rename', input), { code: 'NOT_FOUND' }); f.hidden.clear();
  f.setAuthorized(false); await assert.rejects(f.invoke('rename', input), { code: 'UNAUTHORIZED' }); f.setAuthorized(true);
  const persist = f.store.persist;
  let writes = 0;
  f.store.persist = async () => { if (++writes === 2) throw new Error('Disk unavailable'); await persist(); };
  await assert.rejects(f.invoke('rename', { requestId: 'lost-receipt', title: 'Applied' }), { code: 'SESSION_ACTION_UNCERTAIN' });
  assert.equal(f.officialRows.get('session').projections.values.title, 'Applied');
  assert.equal(f.store.state.sessionActions.find(row => row.requestId === requestId('lost-receipt')).state, 'unknown');
  await assert.rejects(f.invoke('rename', { requestId: 'lost-receipt', title: 'Applied' }), { code: 'SESSION_ACTION_UNCERTAIN' });
  assert.equal(f.calls.filter(row => row[1] === 'rename').length, 2);
});

test('an asynchronous session lookup cannot bypass changed privacy or a mutable project path', async t => {
  for (const change of [f => f.hidden.add('session'), f => { f.project.path = '/moved'; }]) {
    const f = await fixture(t), invoke = f.ctx.typertGateway.invoke;
    f.ctx.typertGateway.invoke = async call => { const result = await invoke(call); if (call.method === 'list') change(f); return result; };
    await assert.rejects(f.invoke('pin'), { code: 'NOT_FOUND' });
    assert.deepEqual(f.calls, []);
  }
});

test('a partial delete becomes uncertain and revocation prevents even reading its receipt', async t => {
  const f = await fixture(t), invoke = f.ctx.typertGateway.invoke;
  f.ctx.typertGateway.invoke = async call => { const result = await invoke(call); if (call.method === 'archiveSession') f.setAuthorized(false); return result; };
  await assert.rejects(f.invoke('delete', { requestId: 'partial-delete' }), { code: 'SESSION_ACTION_UNCERTAIN' });
  assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, ['session']);
  assert.equal(f.store.state.sessionActions[0].state, 'unknown');
  await assert.rejects(f.invoke('delete', { requestId: 'partial-delete' }), { code: 'UNAUTHORIZED' });
  f.setAuthorized(true);
  await assert.rejects(f.invoke('delete', { requestId: 'partial-delete' }), { code: 'SESSION_ACTION_UNCERTAIN' });
  assert.equal(f.calls.length, 1);
});

test('bounded receipts retire completed history with a durable watermark instead of requiring pairing again', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 2000; i++) f.store.state.sessionActions.push({ deviceId: f.device.id, requestId: `sa:${baseTime - 3000 + i}:old-${i}`, issuedAt: baseTime - 3000 + i, createdAt: baseTime - 3000 + i, state: 'done' });
  await f.invoke('pin', { requestId: 'new-after-capacity' });
  const saved = JSON.parse(await readFile(join(f.directory, 'devices.json'), 'utf8'));
  assert.equal(saved.sessionActions.length, 2000);
  assert.deepEqual(saved.sessionActionWatermarks, [{ deviceId: f.device.id, issuedAt: baseTime - 3000 }]);
  assert.equal(saved.sessionActions.some(row => row.requestId.endsWith(':old-0')), false);
  await assert.rejects(f.invoke('pin', { requestId: `sa:${baseTime - 3000}:old-0` }), { code: 'SESSION_ACTION_EXPIRED' });
  await f.reopen();
  await assert.rejects(f.invoke('pin', { requestId: `sa:${baseTime - 3000}:old-0` }), { code: 'SESSION_ACTION_EXPIRED' });
  assert.equal(f.calls.length, 1);
});

test('retained receipts survive clock changes while expired or retired identifiers cannot replay', async t => {
  const f = await fixture(t);
  await f.invoke('rename', { requestId: 'before-clock-change', title: 'One' });
  const later = baseTime + 8 * 86400_000;
  f.setTime(later);
  assert.equal((await f.invoke('rename', { requestId: 'before-clock-change', title: 'One' })).title, 'One');
  await assert.rejects(f.invoke('pin', { requestId: 'unaccepted-old' }), { code: 'SESSION_ACTION_EXPIRED' });
  await assert.rejects(f.invoke('pin', { requestId: `sa:${later + 86400001}:too-future` }), { code: 'SESSION_ACTION_EXPIRED' });
  await f.invoke('pin', { requestId: `sa:${later + 23 * 3600000}:tolerated-skew` });
  assert.equal(f.store.state.sessionActions.length, 1);
  await assert.rejects(f.invoke('rename', { requestId: 'before-clock-change', title: 'One' }), { code: 'SESSION_ACTION_EXPIRED' });
  await f.reopen();
  await assert.rejects(f.invoke('rename', { requestId: 'before-clock-change', title: 'One' }), { code: 'SESSION_ACTION_EXPIRED' });
  assert.equal(f.calls.filter(row => row[1] === 'rename').length, 1);
});

test('official delete archives and durably dismisses the row without deleting its official history', async t => {
  const f = await fixture(t);
  const result = await f.invoke('delete', { requestId: 'delete' });
  assert.equal(result.deleted, true); assert.equal(f.officialRows.has('session'), true);
  assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, ['session']);
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'dismissed-harness.json'), 'utf8')), ['session']);
  assert.deepEqual(await f.official.list(f.device), []);
  assert.equal((await f.invoke('delete', { requestId: 'delete' })).deleted, true);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.invoke('unarchive'), { code: 'NOT_FOUND' });
});

test('native actions preserve ownership and archived listings, and unsupported mutations fail explicitly', async t => {
  const f = await fixture(t), native = { id: 'native:direct', native: true };
  await f.invoke('archive', native);
  assert.equal(f.native.list([f.project]).length, 0);
  assert.equal(f.native.list([f.project], { includeArchived: true })[0].archived, true);
  await f.invoke('unarchive', native); assert.equal(f.records.get('direct').archived, false);
  for (const operation of ['pin', 'unpin', 'rename', 'fork']) await assert.rejects(f.invoke(operation, { ...native, ...(operation === 'rename' ? { title: 'New' } : {}) }), { code: 'UNSUPPORTED' });
  f.hidden.add('commander-web:project'); await assert.rejects(f.invoke('delete', native), { code: 'NOT_FOUND' }); f.hidden.clear();
  f.records.get('direct').cwd = '/moved'; await assert.rejects(f.invoke('delete', native), { code: 'NOT_FOUND' }); f.records.get('direct').cwd = '/project';
  const result = await f.invoke('delete', { ...native, requestId: 'native-delete' }); assert.equal(result.deleted, true);
  assert.equal((await f.invoke('delete', { ...native, requestId: 'native-delete' })).deleted, true);
  assert.equal(f.calls.filter(row => row[1] === 'delete').length, 1);
  f.setProjects([]); await assert.rejects(f.invoke('delete', { ...native, requestId: 'native-delete' }), { code: 'NOT_FOUND' });
});

test('explicit native identity preserves opaque official prefixes and binds idempotency to the session type', async t => {
  const f = await fixture(t), id = 'native:direct';
  f.project.sessionIds.push(id); f.officialRows.set(id, { sessionId: id, projections: { values: { title: 'Official' } } });
  await f.invoke('rename', { id, native: false, title: 'Official renamed' });
  assert.equal(f.officialRows.get(id).projections.values.title, 'Official renamed'); assert.equal(f.records.get('direct').title, 'Native');
  await f.invoke('archive', { id, native: false, requestId: 'same-type-intent' });
  await assert.rejects(f.invoke('archive', { id, native: true, requestId: 'same-type-intent' }), { code: 'SESSION_ACTION_CONFLICT' });
  assert.equal(f.records.get('direct').archived, undefined);
  await f.invoke('archive', { id, native: true, requestId: 'real-native' });
  assert.equal(f.records.get('direct').archived, true);
  await assert.rejects(f.invoke('pin', { native: undefined }), { code: 'INVALID_SESSION_ACTION' });
});
