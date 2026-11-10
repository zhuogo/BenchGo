import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { assertSameOrigin, readJson, HttpError } from '../../benchgo/shared/http.mjs';
import { mountOps, OPS_VERSION, OPS_PRESETS } from './ops.mjs';
import { mountCompaction, COMPACTION_VERSION } from './compaction.mjs';
import { applySettingsOps, assertSettingsExpected, normalizeSettingsOps, notifySettings, settingsSnapshot } from '../../benchgo/shared/settings-adapter-utils.mjs';
import { createEfficiencySettingsAdapter } from './settings-adapter.mjs';
import { EFFICIENCY_CONFIG_SCHEMA } from './config-schema.mjs';

const defaults = () => ({ revision: 0, features: { ops: { enabled: true, shell: false }, compaction: { enabled: true } } });
const names = Object.keys(EFFICIENCY_CONFIG_SCHEMA.properties.features.properties);
const requirements = { ops: ['tools', 'agentPresets', 'agents', 'sessionProjections', 'systemPrompt', 'sandboxPolicy', 'subprocess'], compaction: ['tools'] };
const mounts = { ops: mountOps, compaction: mountCompaction };

export function mergeEfficiencyConfig(current, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['revision', 'features'].includes(key))) throw new HttpError('增强配置无效');
  if (input.revision !== current.revision) throw new HttpError('配置已变化，请刷新后重试', 409, 'CONFIG_CHANGED');
  if (!input.features || typeof input.features !== 'object' || Array.isArray(input.features) || !Object.keys(input.features).length) throw new HttpError('请提供要修改的能力');
  const next = structuredClone(current);
  for (const [name, patch] of Object.entries(input.features)) {
    if (!names.includes(name) || !patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError('未知增强能力');
    const keys = Object.keys(EFFICIENCY_CONFIG_SCHEMA.properties.features.properties[name].properties);
    for (const [key, value] of Object.entries(patch)) {
      if (!keys.includes(key) || typeof value !== 'boolean') throw new HttpError(`增强配置 ${name}.${key} 无效`);
      next.features[name][key] = value;
    }
  }
  next.revision++;
  return next;
}

async function loadConfig(path, initial) {
  let saved;
  try { saved = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return initial; throw error; }
  if (!Number.isSafeInteger(saved.revision) || saved.revision < 0) throw new Error('增强配置版本无效');
  const checked = mergeEfficiencyConfig({ ...initial, revision: saved.revision }, saved);
  checked.revision = saved.revision;
  return checked;
}

/** Mounted by BenchGo's existing base entry; not a sixth Cordis entry. */
export async function mountEfficiency(ctx, { directory, config, adapters = mounts } = {}) {
  if (!directory) throw new Error('BenchGo 数据目录不可用');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'efficiency.json');
  let initial = defaults();
  if (config) { initial = mergeEfficiencyConfig(initial, { revision: 0, features: config.features ?? config }); initial.revision = 0; }
  let saved = await loadConfig(path, initial), disposed = false, writes = Promise.resolve();
  const handles = new Map(), states = new Map(), listeners = new Set();
  const configurationSnapshot = () => settingsSnapshot({ features: saved.features }, saved.revision, { base: { features: defaults().features } });

  const snapshot = () => ({
    revision: saved.revision, scope: 'official-harness',
    features: Object.fromEntries(names.map(name => [name, {
      ...saved.features[name], installed: false, available: false, state: 'waiting_services',
      version: name === 'ops' ? OPS_VERSION : COMPACTION_VERSION,
      ...(name === 'ops' ? { presets: [...OPS_PRESETS] } : { safePointRatio: false }),
      ...states.get(name),
    }])),
  });

  const stop = async name => {
    const handle = handles.get(name); handles.delete(name);
    if (handle) { handle.active = false; await handle.fiber.dispose(); }
  };
  const start = name => {
    if (disposed || !saved.features[name].enabled) { states.set(name, { state: 'disabled', available: false }); return; }
    const state = { active: true, generation: 0, adapter: undefined, fiber: undefined };
    handles.set(name, state);
    states.set(name, { state: 'waiting_services', available: false, error: '等待官方宿主服务就绪' });
    // The API stays mounted while optional services come and go. Cordis owns
    // remounting and releases all tools/listeners when the injected scope exits.
    state.fiber = ctx.inject(requirements[name], async child => {
      if (!state.active || disposed) return;
      const generation = ++state.generation;
      let live = true;
      states.set(name, { state: 'loading', installed: false, available: false });
      let adapter;
      child.effect(() => async () => {
        live = false;
        await adapter?.dispose();
        if (state.generation === generation) state.adapter = undefined;
        if (state.active && !disposed && state.generation === generation) states.set(name, { state: 'waiting_services', available: false, error: '官方宿主服务不可用' });
      });
      try {
        adapter = await adapters[name](child, saved.features[name]);
        if (!live || !state.active || disposed || state.generation !== generation) { await adapter.dispose(); return; }
        state.adapter = adapter;
        states.set(name, { state: 'ready', installed: true, available: true, verification: 'host' });
        child.emit?.('tools/change');
      } catch (error) {
        if (!live || !state.active || disposed || state.generation !== generation) return;
        states.set(name, { state: 'unavailable', installed: error.code !== 'ERR_MODULE_NOT_FOUND', available: false, error: String(error.message || error) });
        child.logger?.warn?.(`BenchGo ${name}: ${error.message}`);
      }
    });
  };
  for (const name of names) start(name);

  const update = (input, options = {}) => {
    const task = writes.then(async () => {
      if (disposed) throw new HttpError('增强服务已停止', 503);
      if (options.expected || options.ops) assertSettingsExpected(configurationSnapshot(), options.expected, options.signal);
      if (options.ops) {
        const value = applySettingsOps({ features: saved.features }, options.ops), fallback = defaults();
        for (const name of names) value.features = { ...value.features, [name]: { ...fallback.features[name], ...value.features?.[name] } };
        input = { revision: saved.revision, features: value.features };
      }
      const next = mergeEfficiencyConfig(saved, input);
      const changed = names.filter(name => JSON.stringify(next.features[name]) !== JSON.stringify(saved.features[name]));
      const temp = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }); await rename(temp, path); }
      finally { await rm(temp, { force: true }); }
      saved = next;
      notifySettings(listeners, { namespace: 'benchgo-efficiency' });
      for (const name of changed) {
        try { await stop(name); start(name); }
        catch (error) { states.set(name, { state: 'unavailable', available: false, error: `配置已保存，重载失败：${error.message}` }); }
      }
      return snapshot();
    });
    writes = task.catch(() => {});
    return task;
  };

  const fetch = async request => {
    try {
      assertSameOrigin(request, { allowDesktopOrigin: true });
      if (request.method === 'GET') return Response.json(snapshot(), { headers: { 'cache-control': 'no-store' } });
      if (request.method !== 'POST') throw new HttpError('不支持的请求方法', 405);
      return Response.json(await update(await readJson(request, 4096)), { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      return Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status ?? 503, headers: { 'cache-control': 'no-store' } });
    }
  };

  let cleanup;
  const service = {
    snapshot, update, fetch, configurationSnapshot,
    normalizeSettingsOps(ops, current) {
      const revision = current.backendRevision ?? current.revision;
      const submitted = applySettingsOps(current.value, ops, { base: current.base });
      const actual = mergeEfficiencyConfig({ revision, features: current.value.features }, { revision, features: submitted.features });
      return normalizeSettingsOps(current.value, ops, { features: actual.features }, { base: current.base });
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    contextTools: () => handles.get('compaction')?.adapter?.contextTools?.() ?? [],
    async diagnose(agent) {
      const result = snapshot();
      for (const name of names) if (handles.get(name)?.adapter) {
        try { result.features[name].session = await handles.get(name).adapter.diagnose(agent); }
        catch (error) { result.features[name].session = { state: 'unavailable', error: error.message }; }
      }
      return result;
    },
    async dispose() {
      if (cleanup) return cleanup;
      disposed = true;
      cleanup = (async () => { await writes; for (const name of names) await stop(name); })();
      return cleanup;
    },
  };
  ctx.provide('benchgoEfficiency', service);
  ctx.inject(['benchgoSettings'], child => { const manager = child.get?.('benchgoSettings'); if (manager) child.effect(() => manager.register(createEfficiencySettingsAdapter(service))); });
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/benchgo/efficiency', methods: ['GET', 'POST'], requestBody: 'buffered', fetch }));
  ctx.effect(() => () => service.dispose());
  return service;
}
