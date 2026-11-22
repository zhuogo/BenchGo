import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { HttpError } from '../shared/http.mjs';
import { isRouterGo } from '../shared/builtin-providers.mjs';
import { isRouterGoAccountReference, routerGoAccountTokenReference } from '../shared/routergo-account.mjs';

const namespace = 'llm-pi-ai';
const storageKey = 'benchgo-plugin/group-providers';
const validRoute = /^(?=.{1,100}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const validIdentity = /^[a-zA-Z0-9:/+_=-]{1,160}$/u;
const generatedRoute = /^(?:routergo|benchgo-[a-z0-9-]+)-[a-f0-9]{32}$/u;
const credentialName = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/u;
const recordLimit = 2048;
const workflowError = () => new HttpError('供应商同步数据无效', 400, 'PROVIDER_SYNC_INVALID');
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const providers = doc => (doc?.user ?? doc?.value)?.providers ?? {};
const jsonCopy = value => JSON.parse(JSON.stringify(value));

function configuration(profile) {
  const { apiKeyEnv, ...fields } = profile;
  return jsonCopy(fields);
}

function entryVersion(entry, previous) {
  if (!previous) return true;
  if (entry.deleted !== previous.deleted) return entry.deleted === true;
  if (entry.revision !== previous.revision) return entry.revision > previous.revision;
  return entry.writer > previous.writer;
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length > recordLimit) throw workflowError();
  const seen = new Set();
  return entries.map(entry => {
    if (!plain(entry) || typeof entry.id !== 'string' || !validRoute.test(entry.id)
      || typeof entry.writer !== 'string' || !validIdentity.test(entry.writer)
      || typeof entry.route !== 'string' || !validRoute.test(entry.route) || !Number.isSafeInteger(entry.revision)
      || entry.revision < 1 || typeof entry.deleted !== 'boolean' || seen.has(entry.id)) throw workflowError();
    seen.add(entry.id);
    const { id, route, revision, writer, deleted } = entry;
    if (deleted) return { id, route, revision, writer, deleted };
    const { profile, key, managedRouterGo } = entry;
    if (!plain(profile) || Object.hasOwn(profile, 'apiKeyEnv') || JSON.stringify(profile).length > 524288
      || typeof key !== 'string' || !key || key.length > 65536 || typeof managedRouterGo !== 'boolean') {
      throw workflowError();
    }
    return { id, route, revision, writer, deleted, profile: jsonCopy(profile), key, managedRouterGo };
  });
}

function aliasFor(entry) {
  const family = isRouterGo(entry.route) ? 'routergo' : 'benchgo-shared';
  return family + '-' + digest(entry.id);
}

function referenceFor(groupId, entry) {
  const family = entry.managedRouterGo ? 'BENCHGO_ROUTERGO_KEY_' : 'BENCHGO_GROUP_PROVIDER_';
  return family + digest(JSON.stringify([groupId, entry.id, entry.revision, entry.writer]));
}

function projection(entry) {
  return { profile: entry.profile, key: entry.key, managedRouterGo: entry.managedRouterGo };
}

/**
 * Host-side replication. The caller must authenticate membership and protect
 * snapshots as credentials.
 */
export function createGroupProviders(ctx) {
  let operations = Promise.resolve();
  const serial = operation => {
    const next = operations.then(operation);
    operations = next.catch(() => {});
    return next;
  };
  const settings = () => ctx.settings.describe().find(row => row.ns === namespace);
  const read = async () => structuredClone((await ctx.credentials.readRecord(storageKey))?.payload ?? { groups: {} });
  const save = current => ctx.credentials.modifyRecord(storageKey, () => ({ kind: 'grant', payload: current }));

  async function readProjection(profile) {
    const ref = profile.apiKeyEnv;
    if (typeof ref !== 'string' || !credentialName.test(ref)) return null;
    const credential = await ctx.credentials.resolve(ref);
    if (typeof credential?.value !== 'string' || !credential.value || credential.value.length > 65536) return null;
    // Environment bindings are provisioned outside BenchGo and stay on the host.
    if (credential.source && credential.source !== 'file') return null;
    return { profile: configuration(profile), key: credential.value, managedRouterGo: isRouterGoAccountReference(ref) };
  }

  function writeEntry(group, entry, hostId, fields) {
    const revision = group.revision + 1;
    group.revision = revision;
    group.entries[entry.id] = { id: entry.id, route: entry.route, revision, writer: hostId, ...fields };
  }

  async function capture(group, rows, hostId, migratedRoutes) {
    const occupied = new Set();
    for (const [id, binding] of Object.entries(group.bindings)) {
      const entry = group.entries[id];
      const row = Object.hasOwn(rows, binding.route) ? rows[binding.route] : undefined;
      occupied.add(binding.route);
      if (!entry || entry.deleted) continue;
      if (!row) {
        if (binding.applied) writeEntry(group, entry, hostId, { deleted: true });
        continue;
      }
      const found = await readProjection(row);
      if (!found) continue;
      if (found.managedRouterGo && isRouterGo(binding.route) && row.apiKeyEnv !== binding.pendingRef && row.apiKeyEnv !== binding.ref) {
        binding.accountRef = row.apiKeyEnv;
      }
      if (!isDeepStrictEqual(found, projection(entry))
        && binding.applied?.revision === entry.revision && binding.applied.writer === entry.writer) {
        writeEntry(group, entry, hostId, { deleted: false, ...found });
        const updated = group.entries[id];
        binding.applied = { revision: updated.revision, writer: updated.writer };
      }
    }
    for (const [route, profile] of Object.entries(rows)) {
      if (occupied.has(route) || !validRoute.test(route)) continue;
      const found = await readProjection(profile);
      if (!found) continue;
      let stableRoute = generatedRoute.test(route) ? route : 'provider-' + digest(JSON.stringify([hostId, route]));
      if (migratedRoutes.has(route) || group.entries[stableRoute]?.deleted) stableRoute = 'provider-' + randomUUID().replaceAll('-', '');
      writeEntry(group, { id: stableRoute, route }, hostId, { deleted: false, ...found });
      const entry = group.entries[stableRoute];
      group.bindings[stableRoute] = {
        route, owned: true, applied: { revision: entry.revision, writer: entry.writer },
        ...(found.managedRouterGo && isRouterGo(route) ? { accountRef: profile.apiKeyEnv } : {}),
      };
    }
  }

  async function prepare(groupId, group, doc) {
    const rows = providers(doc);
    const routes = new Set([...Object.keys(rows), ...Object.values(group.bindings).map(binding => binding.route)]);
    const operations = [];
    const writes = [];
    const obsoleteRefs = new Set();
    for (const [id, binding] of Object.entries(group.bindings)) {
      if (!group.entries[id]?.deleted) continue;
      if (Object.hasOwn(rows, binding.route)) operations.push({ op: 'unset', path: ['providers', binding.route] });
      routes.delete(binding.route);
      if (binding.ref) obsoleteRefs.add(binding.ref);
      if (binding.pendingRef) obsoleteRefs.add(binding.pendingRef);
      if (binding.accountRef) obsoleteRefs.add(binding.accountRef);
    }
    for (const entry of Object.values(group.entries)) {
      if (entry.deleted) continue;
      let binding = group.bindings[entry.id];
      if (binding?.applied?.revision === entry.revision && binding.applied.writer === entry.writer) continue;
      if (!binding) {
        const route = routes.has(entry.route) ? aliasFor(entry) : entry.route;
        if (routes.has(route)) throw new HttpError('供应商连接 ID 冲突', 409, 'PROVIDER_SYNC_CONFLICT');
        routes.add(route);
        binding = group.bindings[entry.id] = { route };
      }
      const row = Object.hasOwn(rows, binding.route) ? rows[binding.route] : undefined;
      const local = row && await readProjection(row);
      const reusableRef = local?.key === entry.key
        && local.managedRouterGo === entry.managedRouterGo ? row.apiKeyEnv : undefined;
      const ref = reusableRef ?? referenceFor(groupId, entry);
      const managedRef = !reusableRef || binding.ref === ref || binding.pendingRef === ref;
      writes.push({ binding, entry, ref });
      if (binding.ref && binding.ref !== ref) obsoleteRefs.add(binding.ref);
      if (binding.pendingRef && binding.pendingRef !== ref) obsoleteRefs.add(binding.pendingRef);
      if (managedRef) binding.pendingRef = ref;
      else delete binding.pendingRef;
      const value = { ...entry.profile, apiKeyEnv: ref };
      if (!Object.hasOwn(rows, binding.route) || !isDeepStrictEqual(rows[binding.route], value)
        || operations.some(operation => operation.path[1] === binding.route)) {
        operations.push({ op: 'set', path: ['providers', binding.route], value });
      }
    }
    return { operations, writes, obsoleteRefs };
  }

  async function apply(group, doc, { operations, writes, obsoleteRefs }) {
    for (const { ref, entry } of writes) {
      if ((await ctx.credentials.resolve(ref))?.value !== entry.key) await ctx.credentials.set(ref, entry.key);
    }
    if (operations.length) await ctx.settings.mutate(namespace, operations, doc.revision);
    if (obsoleteRefs.size) {
      const current = settings();
      const activeRefs = new Set(Object.values(current?.value?.providers ?? providers(current)).map(row => row.apiKeyEnv));
      for (const ref of obsoleteRefs) {
        if (activeRefs.has(ref)) continue;
        await ctx.credentials.unset(ref);
        if (isRouterGoAccountReference(ref)) await ctx.credentials.unset(routerGoAccountTokenReference(ref));
      }
    }
    for (const { binding, entry } of writes) {
      binding.ref = binding.pendingRef;
      if (!binding.ref) delete binding.ref;
      binding.applied = { revision: entry.revision, writer: entry.writer };
      delete binding.pendingRef;
    }
    for (const id of Object.keys(group.bindings)) {
      if (group.entries[id]?.deleted) delete group.bindings[id];
    }
  }

  async function reconcile({ groupId, hostId, entries = [] }) {
    if (typeof groupId !== 'string' || !validIdentity.test(groupId)
      || typeof hostId !== 'string' || !validIdentity.test(hostId)) throw workflowError();
    const incoming = validateEntries(entries);
    const doc = settings();
    if (!doc || ctx.settings.writable === false) throw new HttpError('模型配置暂不可写入', 503, 'PROVIDER_SYNC_UNAVAILABLE');
    const current = await read();
    const group = Object.hasOwn(current.groups, groupId)
      ? current.groups[groupId]
      : current.groups[groupId] = { revision: 0, entries: {}, bindings: {} };
    const before = jsonCopy(current);
    // Former local connections may have a tombstone for their previous shared ID.
    const migratedRoutes = new Set([...(current.localOnly ?? []), ...Object.keys(current.shareAgain ?? {})]);
    await capture(group, providers(doc), hostId, migratedRoutes);
    delete current.localOnly;
    delete current.shareAgain;
    for (const entry of incoming) {
      const prior = Object.hasOwn(group.entries, entry.id) ? group.entries[entry.id] : undefined;
      if (entryVersion(entry, prior)) group.entries[entry.id] = entry;
      group.revision = Math.max(group.revision, entry.revision);
    }
    if (Object.keys(group.entries).length > recordLimit || group.revision >= Number.MAX_SAFE_INTEGER) {
      throw new HttpError('设备组的供应商同步记录已达上限', 409, 'PROVIDER_SYNC_LIMIT');
    }
    const changes = await prepare(groupId, group, doc);
    const durable = jsonCopy(current);
    if (!isDeepStrictEqual(durable, before)) await save(durable);
    await apply(group, doc, changes);
    if (!isDeepStrictEqual(current, durable)) await save(current);
    return Object.values(group.entries);
  }

  return {
    snapshot: identity => serial(() => reconcile(identity)),
    exchange: input => serial(() => reconcile(input)),
    bindings: groupId => serial(async () => {
      const { groups } = await read();
      const group = Object.hasOwn(groups, groupId) && groups[groupId];
      return new Map(Object.entries(group?.bindings ?? {}).flatMap(([id, binding]) => {
        const entry = group.entries[id];
        return entry && !entry.deleted && !binding.pendingRef && binding.applied?.revision === entry.revision
          && binding.applied.writer === entry.writer ? [[id, binding.route]] : [];
      }));
    }),
    leave: ({ groupId }) => serial(async () => {
      const current = await read();
      const group = Object.hasOwn(current.groups, groupId) && current.groups[groupId];
      if (!group) return;
      const doc = settings();
      if (!doc || ctx.settings.writable === false) throw new HttpError('模型配置暂不可写入', 503, 'PROVIDER_SYNC_UNAVAILABLE');
      const rows = providers(doc);
      const replicas = Object.values(group.bindings)
        .filter(binding => !binding.owned || binding.ref || binding.pendingRef);
      const ops = replicas.filter(binding => Object.hasOwn(rows, binding.route)
        && (!binding.owned || [binding.ref, binding.pendingRef].includes(rows[binding.route].apiKeyEnv)))
        .map(binding => ({ op: 'unset', path: ['providers', binding.route] }));
      if (ops.length) await ctx.settings.mutate(namespace, ops, doc.revision);
      for (const binding of replicas) {
        if (binding.ref) await ctx.credentials.unset(binding.ref);
        if (binding.pendingRef && binding.pendingRef !== binding.ref) await ctx.credentials.unset(binding.pendingRef);
      }
      delete current.groups[groupId];
      await save(current);
    }),
  };
}
