import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { readDeviceInfo } from './routes.mjs';
import { remoteJson } from './remote.mjs';

const fail = (message, status = 403) => Object.assign(new Error(message), { status });
const assetId = (ownerId, id) => 'asset-' + createHash('sha256').update(JSON.stringify([ownerId, id])).digest('hex');
const terminalActions = new Set(['serverTerminal', 'serverTerminalRead', 'serverTerminalWrite', 'serverTerminalResize', 'serverTerminalClose']);
const assetClaim = (groupId, ownerId, snapshot) => Buffer.from(JSON.stringify([
  'benchgo-group-assets-v1', groupId, ownerId, snapshot.generation, snapshot.revision, snapshot.assets,
]));
const loopback = url => {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '[::1]' || /^127\./.test(host);
};

export function createGroupAssets({ group, store, identity, getCenter, request, targetFor }) {
  const sessions = new Map();
  const leases = new Map();
  const local = async () => (await getCenter()).localAssets();

  const validRows = assets => Array.isArray(assets) && assets.length <= 128 && assets.every(row => row &&
    typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 128 &&
    typeof row.name === 'string' && row.name.length > 0 && row.name.length <= 128 &&
    ['ssh', 'computer'].includes(row.kind) && (row.hostId === null || /^sha256:[A-Za-z0-9+/]{43}=$/.test(row.hostId)) &&
    Object.keys(row).sort().join(',') === 'hostId,id,kind,name');
  const ownersOf = groupId => store.state.groupAssets?.groupId === groupId ? store.state.groupAssets.owners : {};
  const generationOf = owner => owner.generation ?? null;
  const activeOwners = () => group.members().filter(row => !row.removed && row.deviceType !== 'mobile');

  async function publish() {
    const groupId = group.snapshot().id;
    const assets = (await local()).map(({ id, name, kind, hostId }) => ({ id, name, kind, hostId: hostId ?? null }));
    if (!group.enabled() || group.snapshot().id !== groupId) return;
    const owners = ownersOf(groupId), previous = owners[group.localId];
    const generation = generationOf(group.member(group.localId));
    if (previous?.generation !== generation || JSON.stringify(assets) !== JSON.stringify(previous?.assets)) {
      const snapshot = { generation, revision: (previous?.revision ?? 0) + 1, assets };
      snapshot.signature = sign('sha256', assetClaim(groupId, group.localId, snapshot), identity.key).toString('base64');
      store.state.groupAssets = { groupId, owners: { ...owners, [group.localId]: snapshot } };
      await store.persist();
    }
    const latest = ownersOf(groupId);
    return Object.fromEntries(activeOwners().filter(row => latest[row.id]?.generation === generationOf(row)).map(row => [row.id, latest[row.id]]));
  }

  async function receive(incoming) {
    if (!group.enabled() || !incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return;
    const groupId = group.snapshot().id;
    const owners = ownersOf(groupId), merged = { ...owners };
    let changed = false;
    for (const owner of activeOwners()) {
      if (owner.id === group.localId) continue;
      const snapshot = incoming[owner.id], prior = owners[owner.id];
      if (!snapshot || snapshot.generation !== generationOf(owner) || !Number.isSafeInteger(snapshot.revision) ||
        snapshot.revision <= (prior?.generation === snapshot.generation ? prior.revision : 0) ||
        typeof snapshot.signature !== 'string' || snapshot.signature.length > 1024 || !validRows(snapshot.assets)) continue;
      const key = createPublicKey({ key: Buffer.from(owner.key, 'base64'), type: 'spki', format: 'der' });
      if (!verify('sha256', assetClaim(groupId, owner.id, snapshot), key, Buffer.from(snapshot.signature, 'base64'))) continue;
      merged[owner.id] = snapshot;
      changed = true;
    }
    if (changed) {
      store.state.groupAssets = { groupId, owners: merged };
      await store.persist();
    }
  }

  function directory(localRows, { remoteOnly = false } = {}) {
    if (!group.enabled()) return [];
    const cache = store.state.groupAssets;
    const localHosts = new Set(localRows.map(row => row.hostId).filter(Boolean));
    const hosts = new Set(localHosts);
    const entries = [];
    for (const owner of group.members()) {
      if (owner.removed || owner.deviceType === 'mobile' || remoteOnly && owner.id === group.localId) continue;
      const saved = cache?.groupId === group.snapshot().id && cache.owners[owner.id];
      const assets = owner.id === group.localId ? localRows : saved?.generation === (owner.generation ?? null) ? saved.assets : [];
      for (const row of assets) {
        if (row.hostId && (row.hostId === group.localId || group.members().some(member => member.id === row.hostId && member.removed))) continue;
        if (owner.id !== group.localId && row.hostId && hosts.has(row.hostId) && row.kind !== 'ssh') continue;
        if (row.hostId && group.member(row.hostId) && row.kind !== 'ssh') continue;
        if (row.hostId) hosts.add(row.hostId);
        entries.push({ ...row, id: assetId(owner.id, row.id), ownerId: owner.id, ownerName: owner.name,
          groupAsset: true, sharedTerminal: row.kind === 'ssh', status: owner.id === group.localId ? row.status : 'unknown' });
      }
    }
    return entries;
  }

  const assertMember = device => {
    if (group.principal(device.id)?.tokenHash !== device.tokenHash) throw fail('设备组授权已撤销');
  };
  const close = (id, session) => {
    sessions.delete(id);
    return session.center.api({ action: 'serverTerminalClose', deviceId: session.deviceId, id }).catch(() => {});
  };
  const closeLease = (cookie, lease) => {
    leases.delete(cookie);
    return remoteJson(lease.target, '/link/workbench/disconnect', {}, { token: null, cookie, timeout: 2500 }).catch(() => {});
  };
  async function execute(device, input) {
    assertMember(device);
    const center = await getCenter();
    const row = center.localAssets().find(candidate => assetId(group.localId, candidate.id) === input.assetId);
    if (!row) throw fail('登记主机已移除此设备', 404);
    if (input.command === 'workspace') {
      if (row.kind === 'ssh' && !row.hostId) throw fail('此 SSH 服务器可从终端访问', 409);
      const target = await center.assetTarget(row.id);
      const info = await readDeviceInfo(target);
      if (!info.hostId || row.hostId && row.hostId !== info.hostId) throw fail('目标主机身份已变化', 409);
      if (!info.groupAssetLease) throw fail('请更新目标主机上的 BenchGo 以打开共享工作台', 409);
      const routes = info.routes?.filter(route => !loopback(route.url));
      const entry = loopback(target.url) ? routes?.[0] : target;
      if (!entry) throw fail(row.kind === 'ssh' ? '服务器当前只提供 SSH 隧道，可从组内设备卡片打开终端' : '目标工作台暂未提供可从组内设备访问的路线', 409);
      assertMember(device);
      const { headers, value } = await remoteJson(target, '/link/api/workbench', { groupAssetLease: true });
      const cookie = headers['set-cookie']?.find(value => value.startsWith('dsh_link_workbench='));
      if (value.groupAssetLease !== true || !cookie) throw fail('请更新目标主机上的 BenchGo 以打开共享工作台', 409);
      for (const [key, lease] of leases) if (lease.expires <= Date.now()) leases.delete(key);
      const key = cookie.split(';', 1)[0];
      const lease = { target, member: device.id, assetId: row.id, expires: Date.now() + 120_000 };
      try { assertMember(device); }
      catch (error) { await closeLease(key, lease); throw error; }
      leases.set(key, lease);
      return { url: entry.url, pin: entry.pin || '', relayTarget: entry.relayTarget || '', hostId: info.hostId, cookie, routes };
    }
    if (!terminalActions.has(input.command) || row.kind !== 'ssh') throw fail('此资产不支持该操作');
    if (input.command === 'serverTerminal') {
      for (const [id, session] of sessions) if (Date.now() - session.touched > 60_000) void close(id, session);
      const result = await center.api({ action: input.command, deviceId: row.id });
      const session = { member: device.id, grant: device.tokenHash, deviceId: row.id, center, touched: Date.now() };
      try { assertMember(device); }
      catch (error) { await close(result.id, session); throw error; }
      sessions.set(result.id, session);
      return result;
    }
    const session = sessions.get(input.id);
    if (session?.member !== device.id || session.grant !== device.tokenHash || session.deviceId !== row.id) throw fail('终端会话已关闭', 404);
    if (input.command === 'serverTerminalClose') { await close(input.id, session); return { ok: true }; }
    session.touched = Date.now();
    return center.api({ action: input.command, deviceId: row.id, id: input.id,
      offset: input.offset, data: input.data, cols: input.cols, rows: input.rows });
  }
  async function call(asset, command, input = {}) {
    const owner = group.member(asset.ownerId);
    if (!owner || owner.deviceType === 'mobile') throw fail('登记主机已退出设备组');
    return request(targetFor(owner), { operation: 'asset', command, assetId: asset.id,
      id: input.id, offset: input.offset, data: input.data, cols: input.cols, rows: input.rows });
  }
  return {
    local, publish, receive, directory, execute, call,
    revoke: ids => Promise.allSettled([
      ...[...sessions].filter(([, session]) => ids.includes(session.member)).map(([id, session]) => close(id, session)),
      ...[...leases].filter(([, lease]) => ids.includes(lease.member)).map(([cookie, lease]) => closeLease(cookie, lease)),
    ]),
    removeLocal: id => Promise.allSettled([...leases].filter(([, lease]) => lease.assetId === id).map(([cookie, lease]) => closeLease(cookie, lease))),
  };
}
