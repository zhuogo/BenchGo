import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import Schema from '@deepseek-ai/schemastery';
import { resolveConfig } from '@deepseek-ai/cordis';
import { interpolate } from '@deepseek-ai/cordis-plugin-loader';
import { isVolatile } from '@deepseek-ai/cosmokit';
import { redactSecrets } from '@deepseek-ai/dsh-settings';
import { applySettingsOps, settingsFingerprint } from './settings-management.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const native = value => !!value && value[Symbol.for('schemastery')] === true && typeof value.type === 'string';
const plain = value => {
  if (isVolatile(value)) return plain(value.get());
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]));
  return value;
};
const hasExpression = value => !!value && typeof value === 'object' && (Object.hasOwn(value, '__jsExpr') || Object.values(value).some(hasExpression));
function secretPaths(schema, path = [], parents = new Set()) {
  if (!schema || parents.has(schema)) return [];
  if (schema.meta?.role === 'secret') return [path];
  const next = new Set([...parents, schema]);
  return [...Object.entries(schema.dict || {}).flatMap(([key, child]) => secretPaths(child, [...path, key], next)),
    ...(schema.inner ? secretPaths(schema.inner, ['array', 'dict'].includes(schema.type) ? [...path, '*'] : path, next) : []),
    ...(schema.list || []).flatMap(child => secretPaths(child, path, next))];
}
function publicSchema(schema) {
  const copy = structuredClone(schema);
  // Zod's JSON-schema importer resolves object definitions; `not:{}` is the
  // same rejecting schema as false and never admits a Loader expression.
  if (copy.$defs?.loaderExpression === false) copy.$defs.loaderExpression = { not: {} };
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node['x-cordis']?.role === 'secret' || node.writeOnly === true) {
      for (const key of ['default', 'examples', 'enum', 'const']) delete node[key];
    }
    if (Array.isArray(node.required)) node.required = node.required.filter(key => {
      const property = node.properties?.[key];
      return property?.['x-cordis']?.role !== 'secret' && property?.writeOnly !== true;
    });
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(copy); return copy;
}
function volatilePath(schema, path) {
  if (schema?.meta?.volatile) return true;
  const [key, ...rest] = path;
  return key !== undefined && volatilePath(schema?.dict?.[key], rest);
}
function nonvolatilePaths(schema, path = []) {
  if (schema?.meta?.volatile) return [];
  if (schema?.type !== 'object') return [path];
  return Object.entries(schema.dict || {}).flatMap(([key, child]) => nonvolatilePaths(child, [...path, key]));
}

/** Official services remain the source of configuration and lifecycle semantics. */
export function createOfficialSettingsAdapter(ctx, { resolveMetadata = () => ({}), projectSchema } = {}) {
  const epoch = randomUUID();
  let projector;
  const service = name => ctx.get?.(name) ?? ctx[name];
  const retained = fiber => {
    const seen = new Set(), visit = current => {
      if (!current || seen.has(current)) return false;
      if (current === fiber || current.uid != null && current.uid === fiber?.uid) return true;
      seen.add(current);
      return visit(current.parent?.fiber) || Object.values(current.committed || {}).some(implementation => visit(implementation.ctx?.fiber));
    };
    return visit(ctx.fiber);
  };
  const project = async schema => {
    if (projectSchema) return projectSchema(schema);
    if (!projector) {
      const anchor = service('profileContext')?.installAnchor;
      const require = createRequire(anchor || import.meta.url);
      const { createConfigProjector } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
      projector = await createConfigProjector();
    }
    const result = projector(schema, 'managedConfig');
    return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...result.schema,
      $defs: { ...result.definitions, loaderExpression: false } };
  };
  const forms = () => service('settings')?.describe({ redactSecrets: true }) ?? [];
  function records() {
    const editor = service('configEditor'), layers = editor?.configuration?.() ?? [];
    const editable = new Map(layers.map(row => [row.entry, row]));
    const entries = [...(service('loader')?.entries?.() ?? [])];
    for (const { entry } of layers) if (!entries.includes(entry)) entries.push(entry);
    const formRows = forms(), used = new Set(), result = [];
    for (const entry of entries) {
      const layer = editable.get(entry), form = layer ? formRows.find(row => row.ns === entry.options.id) : undefined;
      const namespace = layer ? entry.options.id : entry.id || entry.options.id;
      used.add(entry.options.id);
      const schema = entry.fiber?.runtime?.Config;
      let reason;
      if (!layer) reason = '此 Loader 项不属于官方 ConfigEditor 的唯一可编辑 profile 项';
      else if (entry.disabled || entry.fiber?.uid == null) reason = '此插件尚未活动或已停用';
      else if (!native(schema)) reason = '此插件没有原生 Config schema，不能核验类型与秘密边界';
      else if (hasExpression(entry.options.config) || hasExpression(layer.inherited)) reason = '此配置含 Loader 表达式，普通 JSON 接缝不能无损修改';
      result.push({ namespace, entry, layer, form, schema, reason });
    }
    for (const form of formRows) {
      if (used.has(form.ns)) continue;
      let schema;
      try { schema = new Schema(form.schema); } catch { /* Keep the blocked descriptor. */ }
      result.push({ namespace: String(form.ns), form, schema, reason: native(schema) ? undefined : '官方设置未提供可核验的原生 schema' });
    }
    const counts = new Map();
    for (const row of result) counts.set(row.namespace, (counts.get(row.namespace) ?? 0) + 1);
    return result.map(row => ({ ...row, reason: counts.get(row.namespace) > 1 ? '配置命名空间重复，无法确定唯一写入目标' : row.reason }));
  }
  function snapshot(row, { current, inherited } = {}) {
    if (row.reason) throw fail('SETTINGS_BLOCKED', row.reason);
    const form = row.form;
    const raw = current ?? row.entry?.options.config ?? form?.user ?? {};
    const rawBase = inherited ?? row.layer?.inherited ?? form?.base ?? {};
    let base = rawBase;
    if (row.entry) {
      try { base = plain(resolveConfig(row.entry.fiber.runtime, interpolate(row.entry.fiber.ctx, structuredClone(rawBase)))); }
      catch { /* Required fields may exist only in the profile override. */ }
    }
    const effective = row.entry ? plain(row.entry.fiber.effectiveConfig) : form?.value ?? {};
    const value = redactSecrets(row.schema, effective), user = redactSecrets(row.schema, row.layer ? row.layer.override : form?.user ?? {});
    return { value: value.value, user: user.value, base: redactSecrets(row.schema, base).value,
      revision: form?.revision,
      fingerprint: settingsFingerprint({ epoch, raw, base: rawBase, schema: row.schema.toJSON(), fiber: row.entry?.fiber?.uid ?? null, nativeRevision: form?.revision ?? null }),
      secrets: value.secrets };
  }
  const find = namespace => {
    const matching = records().filter(row => row.namespace === namespace);
    if (matching.length !== 1) throw fail('SETTINGS_BLOCKED', matching.length ? '配置命名空间不唯一' : '官方配置项已退出或未登记');
    return matching[0];
  };
  return {
    id: 'official',
    async schema() {
      let rows;
      try { rows = records(); }
      catch { return [{ namespace: '*', title: '官方配置', applies: 'blocked', risk: 'blocked', unavailableReason: '官方配置服务无法读取目录' }]; }
      return Promise.all(rows.map(async row => {
        let schema, reason = row.reason;
        if (!reason) {
          try { schema = publicSchema(await project(row.schema)); }
          catch { reason = '官方 schema 投影服务不可用，无法提供真实类型约束'; }
        }
        const metadata = await resolveMetadata({ entryId: row.namespace, pluginName: row.entry?.options.name, schema: row.schema });
        return { namespace: row.namespace, title: metadata.title || row.entry?.options.name || row.namespace,
          ...(schema ? { schema } : {}), ...metadata,
          sensitivePaths: [...secretPaths(row.schema), ...(metadata.sensitivePaths || [])],
          risk: reason ? 'blocked' : metadata.risk ?? 'confirm',
          impact: metadata.impact || '官方插件配置变更；未声明具体影响，本次需要确认',
          ...(row.entry && retained(row.entry.fiber) ? {
            nonLiveBlockedReason: '重挂此插件会销毁当前管理服务或其依赖，无法在原接缝完成读回',
            pathPolicies: [...(metadata.pathPolicies || []), ...nonvolatilePaths(row.schema).map(path => ({ path, risk: 'blocked' }))],
          } : {}),
          applies: reason ? 'blocked' : row.layer && !row.schema.meta?.volatile ? 'reload' : 'live',
          ...(reason ? { unavailableReason: reason } : {}) };
      }));
    },
    async read(namespace) { return snapshot(find(namespace)); },
    async apply(namespace, { ops, expected, signal }) {
      signal?.throwIfAborted();
      const row = find(namespace), current = snapshot(row);
      if (current.fingerprint !== expected.fingerprint || current.revision !== expected.revision) throw fail('SETTINGS_CONFLICT', '官方配置已变化，请重新读取');
      if (ops.every(op => volatilePath(row.schema, op.path)) && row.form) {
        await service('settings').mutate(row.form.ns, ops, expected.revision);
      } else {
        if (row.entry && retained(row.entry.fiber)) throw fail('SETTINGS_BLOCKED', '重挂此插件会销毁当前配置管理作用域，当前接缝不能安全完成');
        const editor = service('configEditor');
        if (!row.layer || !editor?.edit) throw fail('SETTINGS_BLOCKED', '官方 ConfigEditor 不支持此普通配置写入');
        await editor.edit(row.entry, (raw, inherited) => {
          signal?.throwIfAborted();
          const latest = find(namespace);
          if (latest.entry !== row.entry || snapshot(latest, { current: raw, inherited }).fingerprint !== expected.fingerprint) throw fail('SETTINGS_CONFLICT', '官方配置在写锁内已变化');
          return applySettingsOps(raw, ops, { base: inherited });
        });
      }
      return { ...snapshot(find(namespace)), application: { state: 'applied' } };
    },
    subscribe(listener) {
      const disposers = [];
      if (ctx.on) {
        disposers.push(ctx.on('settings/document-updated', namespace => listener({ namespace: String(namespace) })));
        disposers.push(ctx.on('app-boot/config-reload', () => listener({})));
      }
      return () => disposers.forEach(dispose => { if (typeof dispose === 'function') dispose(); });
    },
  };
}
