import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fromJSONSchema } from 'zod';

const forbidden = new Set(['__proto__', 'prototype', 'constructor', '__jsExpr']);
const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => Object.assign(new Error(message), { code });
const clone = value => structuredClone(value);
function json(value) {
  const seen = new Set();
  const walk = item => {
    if (item === null || ['string', 'boolean'].includes(typeof item)) return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || seen.has(item)
      || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw fail('SETTINGS_INPUT', '配置只能包含有限 JSON 数据');
    seen.add(item);
    const result = Array.isArray(item) ? item.map(walk) : Object.fromEntries(Object.entries(item).map(([key, child]) => {
      if (forbidden.has(key)) throw fail('SETTINGS_INPUT', '配置包含不支持的表达式或对象键');
      return [key, walk(child)];
    }));
    seen.delete(item); return result;
  };
  return walk(value);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const settingsFingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const equal = (a, b) => settingsFingerprint(a) === settingsFingerprint(b);
const validPath = path => Array.isArray(path) && path.length <= 32 && path.every(key => typeof key === 'string' && key.length > 0 && key.length <= 512 && !forbidden.has(key));
const prefix = (a, b) => a.length <= b.length && a.every((key, i) => key === '*' || key === b[i]);
const overlap = (a, b) => prefix(a, b) || prefix(b, a);
function previewSchema(schema, paths) {
  const result = clone(schema);
  const visit = (node, path) => {
    if (!object(node)) return;
    if (!path.length) {
      for (const key of Object.keys(node)) delete node[key];
      return;
    }
    const [key, ...rest] = path;
    if (key === '*') {
      visit(node.items, rest);
      for (const child of Object.values(node.properties || {})) visit(child, rest);
      visit(node.additionalProperties, rest);
    } else if (node.properties?.[key]) {
      if (!rest.length && Array.isArray(node.required)) node.required = node.required.filter(name => name !== key);
      visit(node.properties[key], rest);
    }
    for (const variant of ['allOf', 'anyOf', 'oneOf']) for (const child of node[variant] || []) visit(child, path);
  };
  for (const path of paths) visit(result, path);
  return result;
}
const slot = (value, path) => {
  for (const key of path) { if (!own(value, key)) return { present: false }; value = value[key]; }
  return value === undefined ? { present: false } : { present: true, value: clone(value) };
};
function operations(input) {
  if (!Array.isArray(input) || !input.length || input.length > 128) throw fail('SETTINGS_INPUT', '请提供 1 至 128 个路径修改');
  return input.map(op => {
    if (!object(op) || !['set', 'unset'].includes(op.op) || !validPath(op.path)
      || Object.keys(op).some(key => !['op', 'path', ...(op.op === 'set' ? ['value'] : [])].includes(key))
      || op.op === 'set' && !own(op, 'value')) throw fail('SETTINGS_INPUT', '配置路径修改格式无效');
    return { op: op.op, path: [...op.path], ...(op.op === 'set' ? { value: json(op.value) } : {}) };
  });
}

/** Shared path semantics: arrays use canonical indexes; unset removes an item. */
export function applySettingsOps(input, inputOps, { base } = {}) {
  let result = clone(input);
  for (const op of operations(inputOps)) {
    let change = op;
    if (base !== undefined && op.op === 'unset') {
      const inherited = slot(base, op.path);
      if (inherited.present) change = { ...op, op: 'set', value: inherited.value };
    }
    const edit = (node, path) => {
      if (!path.length) return change.op === 'set' ? clone(change.value) : {};
      const [key, ...rest] = path;
      if (Array.isArray(node)) {
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) > node.length || Number(key) === node.length && (rest.length || change.op === 'unset')) throw fail('SETTINGS_INPUT', '配置数组索引无效');
        const array = clone(node), index = Number(key);
        if (!rest.length && change.op === 'unset') array.splice(index, 1);
        else array[index] = edit(array[index], rest);
        return array;
      }
      if (node !== undefined && !object(node)) throw fail('SETTINGS_INPUT', '配置路径不能穿过标量');
      const next = { ...node };
      if (!rest.length && change.op === 'unset') delete next[key];
      else next[key] = edit(next[key], rest);
      return next;
    };
    result = edit(result, change.path);
  }
  if (!object(result)) throw fail('SETTINGS_INPUT', '配置根必须是对象');
  return result;
}

function differences(before, after, path = []) {
  if (equal(before, after)) return [];
  if (object(before) && object(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => {
    if (own(before, key) && own(after, key)) return differences(before[key], after[key], [...path, key]);
    return [{ path: [...path, key], before: slot(before, [key]), after: slot(after, [key]) }];
  });
  return [{ path, before: { present: true, value: clone(before) }, after: { present: true, value: clone(after) } }];
}
export function redactSettingsValue(value, paths = []) {
  const walk = (item, path) => {
    if (paths.some(pattern => prefix(pattern, path))) return '[REDACTED]';
    if (Array.isArray(item)) return item.map((child, i) => walk(child, [...path, String(i)]));
    if (object(item)) return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, walk(child, [...path, key])]));
    return item;
  };
  return walk(clone(value), []);
}
const actorValue = actor => {
  if (actor?.kind !== 'owner' || typeof actor.id !== 'string' || !actor.id) throw fail('SETTINGS_OWNER_REQUIRED', '配置修改需要可信主人来源');
  return { kind: 'owner', id: actor.id, ...(actor.profileId ? { profileId: actor.profileId } : {}), ...(actor.sessionId ? { sessionId: actor.sessionId } : {}) };
};

/** Service registry and mutation journal. Values stay in their authoritative adapters. */
export function createSettingsManagement({ directory, requestConfirmation, now = () => Date.now() } = {}) {
  if (!directory) throw new Error('Settings management requires a data directory');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'settings-management.db'));
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings_versions (adapter TEXT NOT NULL, namespace TEXT NOT NULL, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(adapter,namespace));
    CREATE TABLE IF NOT EXISTS settings_operations (id TEXT PRIMARY KEY, request_key TEXT UNIQUE, input_hash TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, adapter TEXT NOT NULL, namespace TEXT NOT NULL, payload TEXT NOT NULL);`);
  const adapters = new Map(), snapshots = new Map(), subscriptions = new Map(), observationErrors = new Map(), commits = new Map();
  let pending = Promise.resolve(), closed = false;
  const serial = work => {
    if (closed) return Promise.reject(fail('SETTINGS_CLOSED', '配置管理已关闭'));
    const task = pending.then(work); pending = task.catch(() => {}); return task;
  };
  const key = ref => JSON.stringify([ref.adapterId, ref.namespace]);
  const writeHistory = record => {
    const row = { id: randomUUID(), at: new Date(now()).toISOString(), ...record };
    db.prepare('INSERT INTO settings_history(id,adapter,namespace,payload) VALUES (?,?,?,?)').run(row.id, row.adapterId, row.namespace, JSON.stringify(row));
    return row;
  };
  const saveOperation = (id, state, payload) => db.prepare('UPDATE settings_operations SET state=?,payload=? WHERE id=?').run(state, JSON.stringify(payload), id);
  const descriptor = async ref => {
    const adapter = adapters.get(ref.adapterId);
    if (!adapter) throw fail('SETTINGS_UNAVAILABLE', '配置服务未注册或已退出');
    const entries = await adapter.schema();
    const item = entries.find(row => row.namespace === ref.namespace);
    if (!item) throw fail('SETTINGS_UNAVAILABLE', '配置项未登记或已退出');
    const result = { ...item, adapterId: adapter.id, risk: item.risk ?? 'confirm', impact: item.impact || '未声明具体影响，本次修改需要确认', sensitivePaths: item.sensitivePaths ?? [] };
    if (!['ordinary', 'confirm', 'blocked'].includes(result.risk) || !Array.isArray(result.sensitivePaths) || !result.sensitivePaths.every(validPath)
      || !Array.isArray(result.pathPolicies ?? []) || !(result.pathPolicies ?? []).every(row => validPath(row.path) && ['ordinary', 'confirm', 'blocked'].includes(row.risk))) throw fail('SETTINGS_METADATA', '受信配置元信息无效');
    return { adapter, descriptor: result };
  };
  const safeSnapshot = (value, metadata) => {
    if (typeof value?.fingerprint !== 'string' || !value.fingerprint) throw fail('SETTINGS_CAS_UNAVAILABLE', '配置服务没有提供可核验版本');
    if (!Array.isArray(value.secrets ?? []) || !(value.secrets ?? []).every(row => validPath(row.path))) throw fail('SETTINGS_METADATA', '配置秘密路径声明无效');
    const paths = [...metadata.sensitivePaths, ...(value.secrets || []).map(row => row.path)];
    return { value: redactSettingsValue(json(value.value), paths),
      ...(value.user !== undefined ? { user: redactSettingsValue(json(value.user), paths) } : {}),
      ...(value.base !== undefined ? { base: redactSettingsValue(json(value.base), paths) } : {}),
      ...(value.revision !== undefined ? { revision: value.revision } : {}),
      fingerprint: value.fingerprint, secrets: (value.secrets || []).map(row => ({ path: [...row.path], set: !!row.set })) };
  };
  const observe = async (ref, { source = 'external', record = true } = {}) => {
    const { adapter, descriptor: metadata } = await descriptor(ref);
    if (metadata.applies === 'blocked' || metadata.risk === 'blocked') throw fail('SETTINGS_BLOCKED', metadata.unavailableReason || '此配置当前不可管理');
    const snapshot = safeSnapshot(await adapter.read(ref.namespace), metadata);
    const prior = db.prepare('SELECT fingerprint,revision FROM settings_versions WHERE adapter=? AND namespace=?').get(ref.adapterId, ref.namespace);
    const previous = snapshots.get(key(ref));
    const { revision } = db.prepare('INSERT INTO settings_versions VALUES (?,?,?,0) ON CONFLICT(adapter,namespace) DO UPDATE SET revision=settings_versions.revision+CASE WHEN settings_versions.fingerprint=excluded.fingerprint THEN 0 ELSE 1 END,fingerprint=excluded.fingerprint RETURNING revision')
      .get(ref.adapterId, ref.namespace, snapshot.fingerprint);
    snapshots.set(key(ref), snapshot);
    if (record && prior && prior.fingerprint !== snapshot.fingerprint) {
      const changes = previous ? differences(previous.value, snapshot.value) : [];
      const rawChanges = previous ? differences(previous.user ?? previous.value, snapshot.user ?? snapshot.value) : [];
      const sensitive = [...metadata.sensitivePaths, ...snapshot.secrets.map(row => row.path), ...(previous?.secrets || []).map(row => row.path)];
      const reversible = !!previous && rawChanges.length > 0 && !rawChanges.some(change => sensitive.some(path => overlap(change.path, path)));
      writeHistory({ adapterId: ref.adapterId, namespace: ref.namespace, source, revision, previousRevision: prior.revision, diff: changes,
        inverse: reversible ? rawChanges.map(change => change.before.present ? { op: 'set', path: change.path, value: change.before.value } : { op: 'unset', path: change.path }) : [],
        reversible, ...(reversible ? {} : { rollbackBlockedReason: !previous ? '重启后没有可核验的变更前值' : !rawChanges.length ? '版本变化没有可安全恢复的公开差异' : '涉及秘密的历史不能通过普通配置恢复' }) });
    }
    return { adapterId: ref.adapterId, namespace: ref.namespace, ...snapshot, revision, backendRevision: snapshot.revision, metadata };
  };
  const publicPlan = plan => ({ operationId: plan.id, adapterId: plan.adapterId, namespace: plan.namespace,
    revision: plan.revision, digest: plan.digest, diff: clone(plan.diff), requiresConfirmation: plan.requiresConfirmation,
    impact: plan.impact, applies: plan.applies, state: plan.state ?? 'prepared' });

  async function prepare(input, trustedActor) {
    const actor = actorValue(trustedActor), ref = { adapterId: input.adapterId, namespace: input.namespace };
    let ops = operations(input.ops);
    const requestKey = input.requestId ? JSON.stringify([actor, input.requestId]) : null;
    const intentHash = settingsFingerprint({ ...ref, ops, actor });
    const inputHash = settingsFingerprint({ ...ref, ops, expectedRevision: input.expectedRevision, actor });
    if (requestKey) {
      const existing = db.prepare('SELECT * FROM settings_operations WHERE request_key=?').get(requestKey);
      if (existing) {
        if (existing.input_hash !== inputHash) throw fail('SETTINGS_IDEMPOTENCY_CONFLICT', '请求标识已绑定其他配置差异');
        return publicPlan({ ...JSON.parse(existing.payload), state: existing.state });
      }
    }
    const current = await observe(ref);
    if (!Number.isSafeInteger(input.expectedRevision) || current.revision !== input.expectedRevision) throw fail('SETTINGS_CONFLICT', '配置已变化，请重新读取后修改');
    const metadata = current.metadata;
    const paths = [...metadata.sensitivePaths, ...current.secrets.map(row => row.path)];
    if (ops.some(op => paths.some(path => overlap(op.path, path)))) throw fail('SETTINGS_SECRET_BLOCKED', '秘密及其父路径不能通过普通 JSON 修改，请使用已有安全输入；此管理接缝不提供秘密恢复');
    const adapter = adapters.get(ref.adapterId);
    if (adapter.normalizeOps) {
      const normalized = operations(await adapter.normalizeOps(ref.namespace, { ops: clone(ops), current: clone(current) }));
      if (normalized.length !== ops.length || normalized.some((op, i) => op.op !== ops[i].op || !equal(op.path, ops[i].path))) throw fail('SETTINGS_NORMALIZATION_INVALID', '配置规范化不能增加、删除或改写请求路径');
      ops = normalized;
    }
    const policies = (metadata.pathPolicies || []).filter(policy => ops.some(op => overlap(op.path, policy.path)));
    if (policies.some(policy => policy.risk === 'blocked')) throw fail('SETTINGS_BLOCKED', '此字段由原服务禁止修改');
    const next = applySettingsOps(current.value, ops, { base: current.base });
    if (!metadata.schema) throw fail('SETTINGS_SCHEMA_UNAVAILABLE', '配置缺少可核验的类型约束');
    try { fromJSONSchema(previewSchema(metadata.schema, paths)).parse(next); }
    catch { throw fail('SETTINGS_SCHEMA_REJECTED', '配置修改不符合登记的类型或取值约束'); }
    const user = current.user ?? current.value, nextUser = applySettingsOps(user, ops);
    const rawDiff = differences(user, nextUser), diff = differences(current.value, next);
    const inverse = rawDiff.map(change => change.before.present ? { op: 'set', path: change.path, value: change.before.value } : { op: 'unset', path: change.path });
    const plan = { id: randomUUID(), ...ref, actor, ops, inverse, diff, intentHash, revision: current.revision,
      expected: { fingerprint: current.fingerprint, revision: current.backendRevision },
      nextValueHash: settingsFingerprint(next), metadataHash: settingsFingerprint(metadata), requiresConfirmation: metadata.risk !== 'ordinary' || policies.some(policy => policy.risk !== 'ordinary'),
      impact: metadata.impact, applies: metadata.applies, rollbackOf: input.rollbackOf ?? null };
    plan.digest = settingsFingerprint(plan);
    db.prepare('INSERT INTO settings_operations VALUES (?,?,?,?,?)').run(plan.id, requestKey, inputHash, 'prepared', JSON.stringify(plan));
    return publicPlan(plan);
  }

  const manager = {
    register(adapter) {
      if (!adapter?.id || adapters.has(adapter.id) || !['schema', 'read', 'apply'].every(method => typeof adapter[method] === 'function')) throw new Error('Invalid or duplicate settings adapter');
      adapters.set(adapter.id, adapter);
      const ready = serial(async () => {
        for (const row of await adapter.schema()) {
          if (row.applies !== 'blocked' && row.risk !== 'blocked') await observe({ adapterId: adapter.id, namespace: row.namespace });
        }
        observationErrors.delete(adapter.id);
      });
      ready.catch(() => { observationErrors.set(adapter.id, fail('SETTINGS_OBSERVATION_FAILED', '配置初始快照无法核实')); });
      const unsubscribe = adapter.subscribe?.(change => {
        const namespaces = change?.namespace ? [change.namespace] : null;
        serial(async () => {
          if (adapters.get(adapter.id) !== adapter) return;
          for (const row of await adapter.schema()) {
            if (namespaces && !namespaces.includes(row.namespace) || row.applies === 'blocked' || row.risk === 'blocked') continue;
            await observe({ adapterId: adapter.id, namespace: row.namespace });
          }
          observationErrors.delete(adapter.id);
        }).catch(() => { observationErrors.set(adapter.id, fail('SETTINGS_OBSERVATION_FAILED', '配置变更观察失败，历史尚未核实')); });
      });
      subscriptions.set(adapter.id, unsubscribe);
      const dispose = () => { if (adapters.get(adapter.id) === adapter) { unsubscribe?.(); subscriptions.delete(adapter.id); adapters.delete(adapter.id); observationErrors.delete(adapter.id); } };
      dispose.ready = ready;
      return dispose;
    },
    async catalog({ adapterId } = {}) {
      const entries = [];
      for (const [id, adapter] of adapters) {
        if (adapterId && id !== adapterId) continue;
        try {
          for (const item of await adapter.schema()) entries.push({ ...item, adapterId: id, risk: item.risk ?? 'confirm', impact: item.impact || '未声明具体影响，本次修改需要确认', sensitivePaths: item.sensitivePaths ?? [] });
        } catch { entries.push({ adapterId: id, namespace: '*', title: id, risk: 'blocked', applies: 'blocked', unavailableReason: '配置目录暂时无法核实' }); }
      }
      return { entries };
    },
    read: ref => serial(() => observe(ref)),
    prepare: (input, actor) => serial(() => prepare(input, actor)),
    lookupRequest(input, trustedActor) {
      return serial(() => {
        const actor = actorValue(trustedActor);
        if (!input.requestId) return null;
        const row = db.prepare('SELECT * FROM settings_operations WHERE request_key=?').get(JSON.stringify([actor, input.requestId]));
        if (!row) return null;
        const plan = JSON.parse(row.payload);
        const intentHash = settingsFingerprint({ adapterId: input.adapterId, namespace: input.namespace, ops: operations(input.ops), actor });
        if (plan.intentHash !== intentHash) throw fail('SETTINGS_IDEMPOTENCY_CONFLICT', '请求标识已绑定其他配置差异');
        return { ...publicPlan({ ...plan, state: row.state }), ...(row.state === 'completed' ? { receipt: clone(plan.receipt) } : {}) };
      });
    },
    commit(input, trustedActor) {
      let actor;
      try { actor = actorValue(trustedActor); } catch (error) { return Promise.reject(error); }
      const existing = commits.get(input.operationId);
      if (existing) return equal(existing.actor, actor) ? existing.promise : Promise.reject(fail('SETTINGS_OWNER_REQUIRED', '配置计划不属于当前主人来源'));
      const load = () => {
        const row = db.prepare('SELECT * FROM settings_operations WHERE id=?').get(input.operationId);
        if (!row) throw fail('SETTINGS_OPERATION_MISSING', '配置修改计划不存在');
        const plan = JSON.parse(row.payload);
        if (!equal(plan.actor, actor)) throw fail('SETTINGS_OWNER_REQUIRED', '配置计划不属于当前主人来源');
        if (!['prepared', 'completed'].includes(row.state)) throw fail('SETTINGS_OPERATION_SETTLED', '此配置计划已处理，未知结果不得重放');
        return { row, plan };
      };
      const check = async plan => {
        const current = await observe(plan);
        if (current.revision !== plan.revision || current.fingerprint !== plan.expected.fingerprint || settingsFingerprint(current.metadata) !== plan.metadataHash) throw fail('SETTINGS_CONFLICT', '配置或登记约束已变化，请重新准备差异');
      };
      const work = (async () => {
        const initial = await serial(async () => {
          const loaded = load();
          if (loaded.row.state !== 'completed') await check(loaded.plan);
          return loaded;
        });
        if (initial.row.state === 'completed') return clone(initial.plan.receipt);
        if (initial.plan.requiresConfirmation) {
          const confirm = trustedActor.confirm ?? requestConfirmation;
          if (!confirm) throw fail('SETTINGS_CONFIRMATION_REQUIRED', '本次精确配置差异需要真人确认');
          // Human interaction must not hold the registry/write queue.
          const outcome = await confirm(Object.freeze({ ...publicPlan(initial.plan), actor: clone(actor) }));
          if (outcome?.outcome !== 'allowed-once' || outcome.digest !== initial.plan.digest) {
            await serial(() => {
              const { row, plan } = load();
              if (row.state !== 'prepared') return;
              saveOperation(plan.id, 'denied', plan);
              writeHistory({ adapterId: plan.adapterId, namespace: plan.namespace, source: 'managed', state: 'denied', actor, diff: plan.diff, digest: plan.digest, revision: plan.revision, inverse: [], reversible: false });
            });
            throw fail('SETTINGS_CONFIRMATION_DENIED', '本次配置差异未获真人单次确认');
          }
        }
        return serial(async () => {
          const { row, plan } = load();
          if (row.state === 'completed') return clone(plan.receipt);
          await check(plan);
          const adapter = adapters.get(plan.adapterId);
          saveOperation(plan.id, 'committing', plan);
          try {
            const applied = await adapter.apply(plan.namespace, { ops: clone(plan.ops), expected: clone(plan.expected), signal: trustedActor.signal });
            const application = applied?.application ?? { state: 'pending', reason: '配置已保存，运行时应用结果尚未由原服务核实' };
            if (!['applied', 'pending', 'reload-required', 'failed'].includes(application.state)) throw fail('SETTINGS_APPLICATION_INVALID', '原服务返回的应用状态无效');
            const after = await observe(plan, { record: false });
            // Read the authoritative values, not the adapter's write response.
            if (settingsFingerprint(after.value) !== plan.nextValueHash) throw fail('SETTINGS_READBACK_FAILED', '配置写后读回改变了未请求的字段');
            for (const change of plan.diff) {
              const actual = slot(after.value, change.path);
              if (!equal(actual, change.after)) throw fail('SETTINGS_READBACK_FAILED', '配置写后读回与精确差异不一致');
            }
            const record = writeHistory({ adapterId: plan.adapterId, namespace: plan.namespace, source: 'managed', state: 'completed',
              actor, digest: plan.digest, diff: plan.diff, inverse: plan.inverse, reversible: true,
              revision: after.revision, previousRevision: plan.revision, rollbackOf: plan.rollbackOf });
            plan.receipt = { changed: plan.inverse.length > 0 || plan.diff.length > 0, operationId: plan.id, historyId: record.id, adapterId: plan.adapterId,
              namespace: plan.namespace, revision: after.revision, diff: clone(plan.diff), verified: true, applies: plan.applies,
              application: { state: application.state, ...(typeof application.reason === 'string' ? { reason: application.reason.slice(0, 1000) } : {}) } };
            saveOperation(plan.id, 'completed', plan);
            return clone(plan.receipt);
          } catch (error) {
            saveOperation(plan.id, 'uncertain', plan);
            writeHistory({ adapterId: plan.adapterId, namespace: plan.namespace, source: 'managed', state: 'uncertain', actor,
              revision: plan.revision, digest: plan.digest, diff: plan.diff, inverse: [], reversible: false,
              code: /^SETTINGS_[A-Z_]+$/.test(error.code) ? error.code : 'SETTINGS_APPLY_FAILED' });
            throw fail(error.code?.startsWith('SETTINGS_') ? error.code : 'SETTINGS_APPLY_FAILED', '配置修改结果未完成核实；请读取真实状态，不要重放');
          }
        });
      })();
      commits.set(input.operationId, { actor, promise: work });
      work.finally(() => { if (commits.get(input.operationId)?.promise === work) commits.delete(input.operationId); }).catch(() => {});
      return work;
    },
    history({ adapterId, namespace, limit = 50, before = Number.MAX_SAFE_INTEGER } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw fail('SETTINGS_INPUT', '历史条数无效');
      return db.prepare('SELECT seq,payload FROM settings_history WHERE seq<? AND (? IS NULL OR adapter=?) AND (? IS NULL OR namespace=?) ORDER BY seq DESC LIMIT ?')
        .all(before, adapterId ?? null, adapterId ?? null, namespace ?? null, namespace ?? null, limit).map(row => ({ seq: row.seq, ...JSON.parse(row.payload) }));
    },
    rollback(input, actor) {
      return serial(async () => {
        const row = db.prepare('SELECT payload FROM settings_history WHERE id=?').get(input.historyId);
        if (!row) throw fail('SETTINGS_HISTORY_MISSING', '配置历史不存在');
        const record = JSON.parse(row.payload);
        if (!record.reversible || !record.inverse?.length) throw fail('SETTINGS_ROLLBACK_BLOCKED', record.rollbackBlockedReason || '此历史没有可安全恢复的旧值');
        return prepare({ adapterId: record.adapterId, namespace: record.namespace, ops: record.inverse,
          expectedRevision: input.expectedRevision, requestId: input.requestId, rollbackOf: record.id }, actor);
      });
    },
    async flush() { await pending; if (observationErrors.size) throw observationErrors.values().next().value; },
    async close() { for (const dispose of subscriptions.values()) dispose?.(); subscriptions.clear(); await pending; closed = true; db.close(); },
  };
  return manager;
}
