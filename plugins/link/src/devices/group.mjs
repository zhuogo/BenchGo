import { createCipheriv, createDecipheriv, createHash, createPublicKey, privateDecrypt, publicEncrypt, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeRoutes, normalizeTarget } from './registry.mjs';
import { PAIRED_DEVICE_CAPABILITIES, text } from '../pairing/store.mjs';

const fail = (message, status = 403) => Object.assign(new Error(message), { status, code: 'DEVICE_GROUP' });
const encode = value => Buffer.from(JSON.stringify(value));
const pinOf = key => createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('base64');
const hostIdOf = key => 'sha256:' + pinOf(key);
const readKey = value => {
  if (typeof value !== 'string' || value.length > 1024) throw fail('设备组公钥无效');
  return createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
};
function verified(key, value, signature) {
  return typeof signature === 'string' && signature.length <= 1024
    && verify('sha256', encode(value), key, Buffer.from(signature, 'base64'));
}

export async function openDeviceGroup(directory, identity, localDetails, onChange) {
  const file = join(directory, 'group.json');
  const publicKey = createPublicKey(identity.cert).export({ format: 'der', type: 'spki' }).toString('base64');
  const localId = 'sha256:' + identity.pin;
  const signValue = value => sign('sha256', encode(value), identity.key).toString('base64');
  const stored = await readFile(file, 'utf8').then(JSON.parse, error => { if (error.code !== 'ENOENT') throw error; });
  let manifest = stored?.manifest;
  let removals = new Map();
  let departures = stored?.departures ?? [];
  let changes = Promise.resolve();
  const serial = operation => {
    const result = changes.then(operation);
    changes = result.catch(() => {});
    return result;
  };
  const validateMember = row => {
    const key = readKey(row?.key);
    if (row.id !== hostIdOf(key) || typeof row.removed !== 'boolean') throw fail('设备组成员身份无效');
    text(row.name, '设备名称', 100);
    if (!Array.isArray(row.routes)) throw fail('设备组连接地址无效');
    normalizeRoutes(row.routes);
    if (row.routes.some(route => route.kind === 'direct' && 'sha256:' + route.pin !== row.id || route.relayTarget && route.relayTarget !== row.id)) throw fail('设备组连接地址与身份不一致');
    if (row.publicUrl) normalizeTarget({ url: row.publicUrl });
    if (row.deviceType !== undefined && (row.deviceType !== 'mobile' || row.routes.length || row.publicUrl)) throw fail('客户端成员不能发布主机路线');
    return row;
  };
  const validateBaseline = snapshot => {
    const { id, revision, authority, members, signature } = snapshot ?? {};
    const key = readKey(authority);
    const legacy = id === hostIdOf(key);
    const kind = legacy ? 'benchgo-group-v1' : 'benchgo-group-v2';
    if ((!legacy && (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) || revision !== 1 || members?.length !== 1)) ||
      !Number.isSafeInteger(revision) || revision < 1 || !Array.isArray(members) || members.length > 64 ||
      !verified(key, [kind, id, revision, members], signature)) throw fail('设备组成员签名无效');
    const ids = new Set();
    for (const member of members) {
      validateMember(member);
      if (ids.has(member.id)) throw fail('设备组成员重复');
      ids.add(member.id);
    }
    if (!members.some(member => member.id === hostIdOf(key) && !member.removed)) throw fail('设备组初始记录无效');
    return snapshot;
  };
  const operationClaim = (id, { clock, nonce, actor, generation, previous, row }) =>
    ['benchgo-group-member-v2', id, clock, nonce, actor, generation, previous, row];
  const renameClaim = (id, { clock, nonce, actor, actorGeneration, target, generation, name }) =>
    ['benchgo-group-rename-v1', id, clock, nonce, actor, actorGeneration, target, generation, name];
  const removalClaim = (id, entry) => entry.clock === undefined
    ? ['benchgo-group-remove-v1', id, entry.actor, entry.target, entry.generation]
    : ['benchgo-group-remove-v2', id, entry.clock, entry.actor, entry.actorGeneration, entry.target, entry.generation];
  const compareOperation = (left, right) => left.clock - right.clock ||
    (left.nonce < right.nonce ? -1 : left.nonce === right.nonce ? 0 : 1);
  const generationOf = member => member?.generation ?? null;
  const baselineOf = snapshot => snapshot?.baseline ?? snapshot;
  const removalKey = (id, generation) => JSON.stringify([id, generation]);
  const sameBaseline = (left, right) => left?.id === right?.id && left?.revision === right?.revision && left?.signature === right?.signature;
  function combine(baseline, operations, entries, renames = []) {
    validateBaseline(baseline);
    if (!Array.isArray(operations) || operations.length > 1024 || !Array.isArray(entries) || entries.length > 1024 ||
      !Array.isArray(renames) || renames.length > 1024)
      throw fail('设备组记录超出限制');
    const members = new Map(baseline.members.map(row => [row.id, row]));
    const names = new Map();
    const removed = new Map();
    const checked = new Set();
    const validatedOperations = [];
    const validatedRemovals = [];
    const validatedRenames = [];
    const changes = [...operations.map(value => ({ ...value, kind: 'member' })),
      ...renames.map(value => ({ ...value, kind: 'rename' })),
      ...entries.map(value => ({ ...value, kind: 'remove', clock: value.clock ?? 0, nonce: removalKey(value.target, value.generation) }))];
    for (const operation of changes.sort(compareOperation)) {
      if (!Number.isSafeInteger(operation.clock) || operation.clock < 0) throw fail('设备组记录版本无效');
      const actor = members.get(operation.actor);
      const actorRemoved = actor && removed.has(removalKey(actor.id, generationOf(actor)));
      if (operation.kind === 'member') {
        const { kind, ...change } = operation;
        if (!actor || actor.removed || actorRemoved || generationOf(actor) !== change.generation) continue;
        if (!/^[a-f0-9-]{36}$/.test(change.nonce ?? '') || !verified(readKey(actor.key), operationClaim(baseline.id, change), change.signature))
          throw fail('设备组成员签名无效');
        if (checked.has(change.nonce)) continue;
        checked.add(change.nonce);
        const row = validateMember(change.row);
        const previous = members.get(row.id);
        const alreadyActive = previous && !previous.removed && !removed.has(removalKey(row.id, generationOf(previous)));
        if (row.removed || generationOf(previous) !== change.previous ||
          (row.id === actor.id ? row.generation !== change.generation : alreadyActive || row.generation !== change.nonce)) continue;
        members.set(row.id, row);
        validatedOperations.push(change);
      } else if (operation.kind === 'rename') {
        const { kind, ...change } = operation;
        const target = members.get(change.target);
        const key = removalKey(change.target, change.generation);
        if (!actor || actor.removed || actorRemoved || generationOf(actor) !== change.actorGeneration ||
          !target || target.removed || generationOf(target) !== change.generation || removed.has(key)) continue;
        if (!/^[a-f0-9-]{36}$/.test(change.nonce ?? '') || !verified(readKey(actor.key), renameClaim(baseline.id, change), change.signature))
          throw fail('设备组名称签名无效');
        if (checked.has(change.nonce)) continue;
        checked.add(change.nonce);
        names.set(key, text(change.name, '设备名称', 100));
        validatedRenames.push(change);
      } else {
        const { kind, nonce, ...entry } = operation;
        if (!entry.clock) delete entry.clock;
        const target = members.get(entry.target);
        if (!actor || !target || generationOf(target) !== entry.generation) continue;
        if (entry.clock === undefined) {
          if (!baseline.id.startsWith('sha256:') || !baseline.members.some(row => row.id === target.id && generationOf(row) === entry.generation) ||
            !baseline.members.some(row => row.id === actor.id && !row.removed)) continue;
        } else if (actor.removed || actorRemoved || generationOf(actor) !== entry.actorGeneration) continue;
        if (!verified(readKey(actor.key), removalClaim(baseline.id, entry), entry.signature)) throw fail('设备组移除签名无效');
        const key = removalKey(entry.target, entry.generation);
        if (removed.has(key)) continue;
        removed.set(key, entry);
        validatedRemovals.push(entry);
      }
    }
    if (members.size > 64 || validatedOperations.length > 512 || validatedRemovals.length > 512 || validatedRenames.length > 512)
      throw fail('设备组记录超出限制');
    const manifest = { id: baseline.id, baseline, operations: validatedOperations, members: [...members.values()],
      ...(validatedRenames.length ? { renames: validatedRenames } : {}) };
    return { manifest, removals: removed, entries: validatedRemovals, names };
  }
  let names = new Map();
  if (manifest) {
    ({ manifest, removals, names } = combine(baselineOf(manifest), manifest.operations ?? [], stored.removals ?? [], manifest.renames));
  }
  const members = () => manifest?.members.map(row => {
    const key = removalKey(row.id, generationOf(row));
    return { ...row, name: names.get(key) ?? row.name, removed: row.removed || removals.has(key) };
  }) ?? [];
  const member = id => members().find(row => row.id === id && !row.removed);
  const enabled = () => Boolean(member(localId));
  const description = () => validateMember({ id: localId, key: publicKey, ...localDetails(), removed: false });
  async function persist(next, entries, nextDepartures) {
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify({ manifest: next, removals: entries, departures: nextDepartures }), { mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async function save({ manifest: next, removals: nextRemovals, entries, names: nextNames }) {
    if (JSON.stringify(next) === JSON.stringify(manifest) && JSON.stringify(entries) === JSON.stringify([...removals.values()])) return manifest;
    const previous = members();
    let nextDepartures = departures;
    if (manifest && manifest.id !== next.id && !enabled()) {
      const former = previous.find(row => row.id === localId);
      const removal = former && removals.get(removalKey(localId, generationOf(former)));
      const waiting = previous.filter(row => !row.removed && row.id !== localId && row.deviceType !== 'mobile').map(row => row.id);
      if (removal && waiting.length) nextDepartures = [...departures, { manifest, removals: [...removals.values()], waiting }];
    }
    await persist(next, entries, nextDepartures);
    manifest = next;
    removals = nextRemovals;
    names = nextNames;
    departures = nextDepartures;
    await onChange?.(previous, members(), enabled());
    return next;
  }
  const startGroup = () => {
    const id = randomUUID(), revision = 1, members = [{ ...description(), generation: randomUUID() }];
    return combine({ id, revision, authority: publicKey, members, signature: signValue(['benchgo-group-v2', id, revision, members]) }, [], []);
  };
  const nextClock = () => Math.max(0, ...(manifest.operations ?? []).map(change => change.clock),
    ...(manifest.renames ?? []).map(change => change.clock),
    ...[...removals.values()].map(entry => entry.clock ?? 0)) + 1;
  function tokenFor(snapshot, targetId, sync) {
    const expires = Date.now() + 120_000;
    const generation = generationOf(snapshot.members.find(row => row.id === localId));
    const claim = ['benchgo-group-auth-v1', snapshot.id, localId, targetId, expires, sync, generation];
    return 'group.' + encode(claim).toString('base64url') + '.' + signValue(claim);
  }
  return {
    localId, member, enabled, description,
    authorityMember() {
      if (!enabled()) return undefined;
      return member(hostIdOf(readKey(manifest.baseline.authority))) ?? members().filter(row => !row.removed && row.deviceType !== 'mobile').sort((a, b) => a.id < b.id ? -1 : 1)[0];
    },
    offer(groupId) {
      const row = description();
      return { row, signature: signValue(['benchgo-group-admission-v1', groupId, row]) };
    },
    verifyOffer(groupId, id, offer) {
      const row = validateMember(offer?.row);
      if (row.id !== id || !verified(readKey(row.key), ['benchgo-group-admission-v1', groupId, row], offer.signature))
        throw fail('设备组入组请求签名无效');
      return row;
    },
    verifyClient(key, id, invitationId, proof) {
      const publicKey = readKey(key);
      if (id !== hostIdOf(publicKey) || !verified(publicKey, ['benchgo-group-client-v1', localId, invitationId], proof))
        throw fail('设备组客户端签名无效');
    },
    snapshot: () => manifest,
    members,
    removals: () => [...removals.values()],
    status: () => ({
      enabled: enabled(), id: enabled() ? manifest.id : null, manageable: enabled(), canInvite: enabled(),
      members: members().map(({ id, name, removed, deviceType }) => ({ id, name, local: id === localId, removed, online: id === localId && !removed, ...(deviceType ? { deviceType } : {}) })),
    }),
    departures: () => departures.flatMap(record => record.waiting.map(id => ({
      manifest: record.manifest, removals: record.removals, row: record.manifest.members.find(row => row.id === id),
      authorize: () => tokenFor(record.manifest, id, true),
    }))),
    acknowledgeDeparture: (groupId, targetId, signature) => serial(async () => {
      const record = departures.find(record => record.manifest.id === groupId);
      if (!record?.waiting.includes(targetId) || !record.removals.some(entry => entry.target === localId && entry.signature === signature)) return;
      const waiting = record.waiting.filter(id => id !== targetId);
      const next = departures.flatMap(item => item !== record ? [item] : waiting.length ? [{ ...record, waiting }] : []);
      await persist(manifest, [...removals.values()], next);
      departures = next;
    }),
    include: (row, invite = false, expectedGroupId = enabled() ? manifest.id : undefined) => serial(async () => {
      if (expectedGroupId !== (enabled() ? manifest.id : undefined)) throw fail('设备组邀请已变更', 409);
      if (!enabled() && !invite) return manifest;
      validateMember(row);
      const initial = enabled() ? manifest : startGroup().manifest;
      const priorRemovals = enabled() ? [...removals.values()] : [];
      const previous = initial.members.find(item => item.id === row.id);
      if (row.id !== localId && member(row.id)) return manifest;
      if (row.id !== localId && !invite) throw fail('该设备需要核验后加入');
      const nonce = randomUUID(), generation = generationOf(initial.members.find(item => item.id === localId));
      const entry = { ...row, generation: row.id === localId ? generation : nonce };
      if (previous && JSON.stringify(previous) === JSON.stringify(entry)) return manifest;
      const change = { clock: enabled() ? nextClock() : 1, nonce, actor: localId, generation, previous: generationOf(previous), row: entry };
      change.signature = signValue(operationClaim(initial.id, change));
      return save(combine(initial.baseline, [...initial.operations, change], priorRemovals, initial.renames));
    }),
    remove: id => serial(async () => {
      if (!enabled()) throw fail('此设备已退出设备组');
      const target = member(id);
      if (!target) return manifest;
      const entry = { clock: nextClock(), actor: localId, actorGeneration: generationOf(member(localId)), target: id, generation: generationOf(target) };
      entry.signature = signValue(removalClaim(manifest.id, entry));
      return save(combine(manifest.baseline, manifest.operations, [...removals.values(), entry], manifest.renames));
    }),
    rename: (id, name) => serial(async () => {
      if (!enabled()) throw fail('此设备已退出设备组');
      const target = member(id);
      if (!target) throw fail('设备组成员不存在', 404);
      name = text(name, '设备名称', 100);
      if (target.name === name) return target;
      const change = { clock: nextClock(), nonce: randomUUID(), actor: localId, actorGeneration: generationOf(member(localId)),
        target: id, generation: generationOf(target), name };
      change.signature = signValue(renameClaim(manifest.id, change));
      await save(combine(manifest.baseline, manifest.operations, [...removals.values()], [...(manifest.renames ?? []), change]));
      return member(id);
    }),
    adopt: (snapshot, invitedBy, incoming = []) => serial(async () => {
      if (!snapshot || snapshot.id !== baselineOf(snapshot)?.id || !Array.isArray(incoming)) throw fail('设备组身份不一致');
      if (manifest && snapshot.id === manifest.id) {
        if (!sameBaseline(baselineOf(snapshot), manifest.baseline)) throw fail('设备组初始记录不一致');
        return save(combine(manifest.baseline, [...manifest.operations, ...(snapshot.operations ?? [])],
          [...removals.values(), ...incoming], [...(manifest.renames ?? []), ...(snapshot.renames ?? [])]));
      }
      if (enabled() || !invitedBy) throw fail('设备组身份不一致');
      const next = combine(baselineOf(snapshot), snapshot.operations ?? [], incoming, snapshot.renames);
      const admission = next.manifest.operations.find(change => change.row.id === localId &&
        generationOf(change.row) === generationOf(next.manifest.members.find(row => row.id === localId)));
      if (admission?.actor !== invitedBy || !next.manifest.members.some(row => row.id === localId && !row.removed && !next.removals.has(removalKey(row.id, generationOf(row)))) ||
        !next.manifest.members.some(row => row.id === invitedBy && !row.removed && !next.removals.has(removalKey(row.id, generationOf(row)))))
        throw fail('设备组邀请与成员身份不一致');
      return save(next);
    }),
    seal(targetId, value, purpose = 'providers') {
      const target = member(targetId);
      if (!enabled() || !target) throw fail('设备组成员资格已失效');
      const key = randomBytes(32), nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const payload = Buffer.concat([cipher.update(encode(value)), cipher.final()]);
      const fields = [publicEncrypt({ key: readKey(target.key), oaepHash: 'sha256' }, key), nonce, cipher.getAuthTag(), payload].map(item => item.toString('base64'));
      return { fields, signature: signValue([`benchgo-group-${purpose}-v1`, manifest.id, targetId, fields]) };
    },
    unseal(sourceId, envelope, purpose = 'providers') {
      const source = member(sourceId), fields = envelope?.fields;
      if (!enabled() || !source || !Array.isArray(fields) || fields.length !== 4
        || fields.some(item => typeof item !== 'string' || item.length > 900_000)
        || !verified(readKey(source.key), [`benchgo-group-${purpose}-v1`, manifest.id, localId, fields], envelope.signature)) throw fail('无法核验设备组同步数据');
      const [key, nonce, tag, payload] = fields.map(item => Buffer.from(item, 'base64'));
      const cipher = createDecipheriv('aes-256-gcm', privateDecrypt({ key: identity.key, oaepHash: 'sha256' }, key), nonce, { authTagLength: 16 });
      cipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([cipher.update(payload), cipher.final()]));
    },
    token(targetId, { sync = false } = {}) {
      if (!(enabled() && member(targetId) || sync && manifest?.members.some(row => row.id === targetId) && manifest.members.some(row => row.id === localId))) throw fail('设备组成员资格已失效');
      return tokenFor(manifest, targetId, sync);
    },
    authenticate(token) {
      if (typeof token !== 'string' || !token.startsWith('group.') || token.length > 2048 || !manifest) return;
      try {
        const [, payload, signature, extra] = token.split('.');
        if (extra !== undefined) return;
        const claim = JSON.parse(Buffer.from(payload, 'base64url'));
        const [kind, id, sourceId, targetId, expires, sync, generation] = claim;
        const source = sync ? manifest.members.find(row => row.id === sourceId) : enabled() && member(sourceId);
        if (claim.length !== 7 || typeof sync !== 'boolean' || kind !== 'benchgo-group-auth-v1' || id !== manifest.id || targetId !== localId
          || !Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + 180_000
          || !source || generation !== generationOf(source) || !verified(readKey(source.key), claim, signature)) return;
        return sync ? { id: sourceId, groupSyncOnly: true } : this.principal(sourceId);
      } catch { return undefined; }
    },
    principal(id) {
      const row = enabled() && member(id);
      if (row) return { id: row.id, tokenHash: createHash('sha256').update(encode([manifest.id, row.id, generationOf(row)])).digest('hex'),
        name: row.name, deviceType: row.deviceType ?? 'computer', groupMember: true, capabilities: [...PAIRED_DEVICE_CAPABILITIES] };
    },
    flush: () => changes,
  };
}
