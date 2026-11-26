import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { createModuleSource, startModuleLifecycle } from '../client/modules.mjs';
import { readJsonResponse } from '../client/http-response.mjs';
import { ensureSidebarWorkspace } from '../client/sidebar-state.mjs';
import { perfTrace } from '../../shared/client/perf-trace.mjs';

const response = enabled => ({ modules: Object.fromEntries(['base', 'harness', 'superagent', 'voice', 'link'].map(name => [name, { available: enabled.includes(name) }])) });

test('module availability mounts, disposes and remounts optional official fibers', async () => {
  const ctx = new Context(), source = createModuleSource(), live = new Set(), mounts = new Map();
  let enabled = ['base'], refresh, stopped = false;
  const entries = Object.fromEntries(['harness', 'superagent', 'voice'].map(name => [name, child => child.effect(() => {
    assert.equal(live.has(name), false, 'a module cannot have duplicate active effects');
    live.add(name); mounts.set(name, (mounts.get(name) || 0) + 1);
    return () => { live.delete(name); };
  })]));
  const stop = startModuleLifecycle(ctx, entries, { source, read: async () => response(enabled), poll: options => { refresh = options.refresh; return () => { stopped = true; }; } });
  try {
    await refresh();
    assert.deepEqual([...live], []);
    assert.equal(source.getSnapshot().superagent, false);
    enabled = ['base', 'harness', 'superagent', 'voice', 'link'];
    await refresh(); await refresh();
    assert.deepEqual([...live], ['harness', 'superagent', 'voice']);
    assert.equal(mounts.get('voice'), 1);
    assert.equal(source.getSnapshot().link, true);
    enabled = ['base', 'harness'];
    await refresh();
    assert.deepEqual([...live], ['harness']);
    assert.equal(source.getSnapshot().voice, false);
    assert.equal(source.getSnapshot().link, false);
    enabled = ['base', 'voice'];
    await refresh();
    assert.deepEqual([...live], ['voice']);
    assert.equal(mounts.get('voice'), 2);
    await stop();
    assert.equal(stopped, true);
    assert.deepEqual([...live], []);
    assert(Object.values(source.getSnapshot()).every(value => value === false));
  } finally { await stop(); await ctx.fiber.dispose(); }
  assert.equal(live.size, 0);
});

test('a pending availability response cannot remount modules after client disposal', async () => {
  const ctx = new Context(), source = createModuleSource();
  let resolve, refresh, mounted = 0;
  const stop = startModuleLifecycle(ctx, { voice() { mounted++; } }, { source, read: () => new Promise(done => { resolve = done; }), poll: options => { refresh = options.refresh; return () => {}; } });
  const pending = refresh();
  await stop();
  resolve(response(['base', 'voice']));
  await pending;
  assert.equal(mounted, 0);
  assert.equal(source.getSnapshot().voice, false);
  await ctx.fiber.dispose();
});

test('a confirmed unavailable base disposes every optional fiber', async () => {
  const ctx = new Context(), source = createModuleSource(), live = new Set();
  let refresh, enabled = ['base', 'harness', 'superagent', 'voice', 'link'];
  const entries = Object.fromEntries(['harness', 'superagent', 'voice'].map(name => [name, child => child.effect(() => {
    live.add(name); return () => { live.delete(name); };
  })]));
  const stop = startModuleLifecycle(ctx, entries, { source, read: async () => response(enabled), poll: options => { refresh = options.refresh; return () => {}; } });
  try {
    await refresh();
    assert.equal(live.size, 3); assert.equal(source.getSnapshot().link, true);
    enabled = ['voice', 'superagent', 'link'];
    await refresh();
    assert.equal(live.size, 0, 'a missing base cannot leave optional entries active');
    assert(Object.values(source.getSnapshot()).every(value => value === false));
  } finally { await stop(); await ctx.fiber.dispose(); }
});

test('transient availability failures retain styles, slots and drafts without remounting modules', async () => {
  const ctx = new Context(), source = createModuleSource(), live = new Set();
  let refresh, failure, payload = response(['base', 'harness', 'superagent', 'voice', 'link']), mounts = 0, disposals = 0;
  const entries = Object.fromEntries(['harness', 'superagent', 'voice'].map(name => [name, child => child.effect(() => {
    mounts++; live.add(name); return () => { disposals++; live.delete(name); };
  })]));
  const stop = startModuleLifecycle(ctx, entries, { source, read: async () => {
    if (failure) throw failure;
    return payload;
  }, poll: options => { refresh = options.refresh; return () => {}; } });
  try {
    // Before the first confirmed response a failed read must not invent availability.
    failure = new TypeError('Failed to fetch');
    await assert.rejects(refresh(), failure);
    assert.equal(mounts, 0);
    assert(Object.values(source.getSnapshot()).every(value => value === false));
    failure = undefined; await refresh();
    const confirmed = source.getSnapshot();
    for (const error of [...[401, 403, 404, 410, 502, 503].map(status => Object.assign(new Error('probe failed'), { status })), new TypeError('Failed to fetch'),
      new DOMException('Probe timed out', 'TimeoutError')]) {
      failure = error;
      await assert.rejects(refresh(), error);
      assert.equal(source.getSnapshot(), confirmed);
      assert.equal(live.size, 3); assert.equal(mounts, 3); assert.equal(disposals, 0);
      failure = undefined; await refresh();
      assert.equal(mounts, 3);
    }
    for (const invalid of [null, {}, {modules: {base: {available: true}}}, {modules: {...payload.modules, voice: {available: 'false'}}}]) {
      const valid = payload; payload = invalid;
      await assert.rejects(refresh(), /Invalid BenchGo module availability response/);
      assert.equal(source.getSnapshot(), confirmed);
      assert.equal(mounts, 3); assert.equal(disposals, 0);
      payload = valid;
    }
  } finally { await stop(); await ctx.fiber.dispose(); }
  assert.equal(disposals, 3);
});

test('the actual base UI belongs to the client owner, independently of optional-module probes', async () => {
  const ctx = new Context(), source = createModuleSource(), requests = [], styles = new Set();
  let refresh, enabled = [], moduleReads = 0, sidebarStarts = 0, sidebarStops = 0, failure, sidebar, initialize;
  const firstWorkspace = new Promise(resolve => { initialize = resolve; });
  let workspaceInitializations = 0;
  ctx.provide('slots', { inject(name, setup) { if (name === 'sidebar.workspaces') setup(); }, register(options) { sidebar = options.inject(); return () => {}; } });
  ctx.provide('sessions', { list: { getSnapshot: () => ({ids: []}), subscribe: () => () => {} } });
  ctx.provide('workspaces', { initializeDefault: async () => ++workspaceInitializations === 1 ? firstWorkspace : ({workspaceId: 'recent'}) });
  const code = transformSync(readFileSync(new URL('../client/index.jsx', import.meta.url), 'utf8'), {loader: 'jsx', format: 'cjs'}).code;
  const module = {exports: {}}, noopExports = new Proxy({}, {get: () => () => {}});
  runInNewContext(code, {
    module, exports: module.exports, URL, AbortController, AbortSignal,
    document: {baseURI: 'https://benchgo.test/', addEventListener() {}, removeEventListener() {}, createElement: () => {const style = {remove() {styles.delete(style);}}; return style;}, head: {append: style => styles.add(style)}},
    fetch: async (_url, options) => {const body = JSON.parse(options.body); requests.push(body.action); return Response.json({workspaceId: 'recent', projects: [], sessions: []});},
    require: Object.assign(id => id.endsWith('modules.mjs') ? {
      moduleSource: source,
      startModuleLifecycle: (owner, entries) => startModuleLifecycle(owner, entries, {
        source, read: async () => {moduleReads++; if (failure) throw failure; return response(enabled);},
        poll: options => {refresh = options.refresh; return () => {};},
      }),
    } : id.endsWith('sidebar-refresh.mjs') ? {startSidebarPolling: () => {sidebarStarts++; return () => {sidebarStops++;};}}
      : id.endsWith('sidebar-state.mjs') ? {ensureSidebarWorkspace}
      : id.endsWith('http-response.mjs') ? {readJsonResponse}
      : id.endsWith('perf-trace.mjs') ? {perfTrace}
      : noopExports, { async: async id => {
        assert.equal(id, './client.fonts.js');
        return { css: '/* fixture fonts */' };
      } }),
  });
  const fiber = ctx.plugin({inject: ['slots', 'workspaces', 'sessions'], apply: module.exports.apply});
  try {
    await fiber;
    assert.deepEqual(requests, []); assert.equal(sidebarStarts, 1); assert.equal(styles.size, 1);
    await refresh();
    assert.equal(moduleReads, 1); assert.deepEqual(requests, []); assert.equal(styles.size, 1);
    enabled = ['base']; await refresh(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests, []);
    const waitingDefault = sidebar.ensureRecent();
    assert.equal(sidebar.ensureRecent(), waitingDefault, 'embedded deletion joins the ongoing default initialization');
    assert.equal(workspaceInitializations, 1);
    initialize({workspaceId: 'recent'}); await waitingDefault;
    assert.deepEqual(requests, ['ensureRecent']); assert.equal(sidebarStarts, 1); assert.equal(styles.size, 1);
    failure = Object.assign(new Error('base endpoint disappeared'), {status: 404});
    await assert.rejects(refresh(), failure);
    assert.equal(sidebarStops, 0); assert.equal(styles.size, 1);
    assert.equal(source.getSnapshot().base, true);
    failure = undefined; enabled = []; await refresh();
    assert.equal(sidebarStops, 0); assert.equal(styles.size, 1);
    assert.equal(source.getSnapshot().base, false);
    assert.deepEqual(requests, ['ensureRecent']); assert.equal(sidebarStarts, 1);
    enabled = ['base']; await refresh(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests, ['ensureRecent']); assert.equal(sidebarStarts, 1);
  } finally { await ctx.fiber.dispose(); }
  assert.equal(sidebarStops, 1); assert.equal(styles.size, 0);
});
