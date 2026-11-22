import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { LINK_DEFAULTS } from '../config.mjs';

export const secret = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const PAIRED_DEVICE_CAPABILITIES = Object.freeze(['collaboration', 'management']);
export function sameSecret(value, digest) {
  if (typeof value !== 'string' || typeof digest !== 'string') return false;
  const a = Buffer.from(hash(value)), b = Buffer.from(digest);
  return a.length === b.length && timingSafeEqual(a, b);
}
export const text = (value, name, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`无效的 ${name}`);
  return value.trim();
};

/** Device credentials are persisted as hashes. Pairing secrets exist for five minutes only. */
export async function openStore(directory, { groupPrincipal = () => undefined } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'devices.json');
  let saved = {};
  try { saved = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const state = { ...LINK_DEFAULTS, ...saved, enabled: true };
  state.name = typeof saved.name === 'string' && saved.name.trim() ? text(saved.name, '设备名称', 100) : (hostname().trim().slice(0, 100) || `BenchGo-${randomBytes(3).toString('hex')}`);
  state.devices ??= [];
  // Approval is the permission boundary; retire the former per-device grant switches.
  const retiredGrants = state.devices.some(device => Object.hasOwn(device, 'capabilities'));
  for (const device of state.devices) delete device.capabilities;
  const validSession = value => value && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest)
    && typeof value.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(value.tokenHash)
    && Number.isFinite(value.expires) && value.expires > Date.now()
    && (state.devices.some(device => device.id === value.id && device.tokenHash === value.tokenHash)
      || groupPrincipal(value.id)?.tokenHash === value.tokenHash);
  const pruneSessions = sessions => {
    const counts = new Map();
    return sessions.filter(validSession).reverse().filter(session => {
      const count = counts.get(session.id) || 0; counts.set(session.id, count + 1); return count < 8;
    }).reverse();
  };
  state.workbenchSessions = Array.isArray(saved.workbenchSessions) ? saved.workbenchSessions : [];
  const pairings = new Map(), pending = new Map(), probes = new Map(), returnProofs = new Map();
  let writes = Promise.resolve();
  let sessionChanges = Promise.resolve();
  const changeSessions = operation => {
    const task = sessionChanges.then(operation);
    sessionChanges = task.catch(() => {});
    return task;
  };
  function persist() {
    const data = JSON.stringify(state, null, 2);
    const task = writes.then(async () => {
      const tmp = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(tmp, data, { mode: 0o600 }); await rename(tmp, file); }
      finally { await rm(tmp, { force: true }); }
    });
    writes = task.catch(() => {});
    return task;
  }
  function prune() {
    for (const [key, value] of pairings) if (value.expiresAt <= Date.now()) pairings.delete(key);
    for (const [key, value] of pending) if (value.expiresAt <= Date.now()) pending.delete(key);
    for (const [key, value] of probes) if (value.expiresAt <= Date.now()) probes.delete(key);
    for (const [key, value] of returnProofs) if (value.expiresAt <= Date.now()) returnProofs.delete(key);
  }
  function pairedRequest(id, pollToken) {
    prune();
    const value = pending.get(id);
    if (!value || !sameSecret(pollToken, value.pollHash)) throw new Error('配对请求已过期或验证失败');
    return value;
  }
  const issueDevice = async ({ name, deviceType, pairingReturnExpiresAt }) => {
    if (state.devices.length >= 32) throw new Error('最多配对 32 台设备，请先撤销不用的设备');
    const token = secret(), device = { id: randomUUID(), name, deviceType, tokenHash: hash(token), pairedAt: Date.now(), lastSeenAt: Date.now(), ...(pairingReturnExpiresAt ? { pairingReturn: 'pending', pairingReturnExpiresAt } : {}) };
    state.devices.push(device);
    try { await persist(); } catch (error) { state.devices = state.devices.filter(row => row !== device); throw error; }
    return { token, deviceId: device.id };
  };
  if (retiredGrants) await persist();
  return {
    state, persist, flush: async () => { await sessionChanges; await writes; },
    principal(id) { return state.devices.find(device => device.id === id) ?? groupPrincipal(id); },
    groupInvitation(id, inviter) {
      prune();
      return [...pending.values()].some(row => row.status === 'approved' && row.deviceId === id && row.groupInvitation && row.groupInvitation === inviter);
    },
    workbenchSession(digest) { return state.workbenchSessions.find(session => session.digest === digest && validSession(session)); },
    saveWorkbenchSession(digest, session) {
      return changeSessions(async () => {
        const value = { digest, id: session.id, tokenHash: session.tokenHash, expires: session.expires };
        if (!validSession(value)) throw new Error('设备授权已失效，请重新配对');
        const previous = state.workbenchSessions;
        state.workbenchSessions = pruneSessions([...previous.filter(row => row.digest !== digest), value]);
        try { await persist(); } catch (error) { state.workbenchSessions = previous; throw error; }
      });
    },
    removeWorkbenchSessions({ id, digest }) {
      return changeSessions(async () => {
        const previous = state.workbenchSessions;
        state.workbenchSessions = previous.filter(row => id ? row.id !== id : row.digest !== digest);
        try { await persist(); } catch (error) { state.workbenchSessions = previous; throw error; }
      });
    },
    pending(code) {
      prune();
      const pairingHash = code === undefined ? undefined : hash(text(code, '配对码', 128));
      return [...pending.values()].filter(p => p.status === 'pending' && (pairingHash === undefined || p.pairingHash === pairingHash)).map(({ id, name, createdAt, expiresAt, returnOffer, groupInvitation }) => ({ id, name, createdAt, expiresAt, reciprocal: Boolean(returnOffer), ...(groupInvitation ? { deviceGroup: true } : {}), capabilities: [...PAIRED_DEVICE_CAPABILITIES] }));
    },
    beginProbe() {
      prune();
      if (probes.size >= 32) throw new Error('连接检查过多，请稍后重试');
      const id = randomUUID(), proof = secret();
      probes.set(id, { proof, expiresAt: Date.now() + 15000 });
      return { id, proof };
    },
    takeProbe(id) {
      prune();
      const probe = probes.get(id);
      probes.delete(id);
      return probe?.proof;
    },
    beginReturnProof() {
      prune();
      if (returnProofs.size >= 32) throw new Error('配对请求过多，请稍后重试');
      const id = randomUUID(), proof = secret();
      returnProofs.set(id, { proof, expiresAt: Date.now() + 300_000 });
      return { id, digest: hash(proof) };
    },
    returnProof(id) { prune(); return returnProofs.get(id)?.proof; },
    clearReturnProof(id) { returnProofs.delete(id); },
    begin(registerReturn) {
      prune(); if (pairings.size + pending.size >= 32) throw new Error('配对请求过多，请稍后重试');
      const code = secret(), expiresAt = Date.now() + 300_000;
      pairings.set(hash(code), { expiresAt, registerReturn }); return { code, expiresAt };
    },
    request(code, name, deviceType = 'unknown', returnOffer, groupInvitation) {
      prune(); const key = hash(text(code, '配对码', 128)); const value = pairings.get(key);
      if (!value) throw new Error('配对码已使用或过期');
      pairings.delete(key);
      const pollToken = secret(), id = randomUUID();
      pending.set(id, { id, name: text(name || `BenchGo-${randomBytes(3).toString('hex')}`, '设备名称', 100), deviceType: returnOffer ? 'computer' : ['mobile', 'computer', 'tablet'].includes(deviceType) ? deviceType : 'unknown', createdAt: Date.now(), expiresAt: value.expiresAt, pairingHash: key, pollHash: hash(pollToken), status: 'pending', returnOffer, groupInvitation, registerReturn: value.registerReturn });
      return { requestId: id, pollToken, expiresAt: value.expiresAt, ...(returnOffer ? { reciprocal: true } : {}), ...(groupInvitation ? { deviceGroup: true } : {}) };
    },
    poll(id, pollToken) {
      const p = pairedRequest(id, pollToken);
      return { status: p.status, ...(p.status === 'approved' ? { token: p.token, deviceId: p.deviceId, hostName: state.name, name: state.name, capabilities: [...PAIRED_DEVICE_CAPABILITIES], ...(p.returnOffer ? { reciprocal: true } : {}) } : {}) };
    },
    async decide(id, allow) {
      prune(); const p = pending.get(id);
      if (!p || p.status !== 'pending') throw new Error('配对请求已失效');
      if (!allow) { p.status = 'rejected'; return; }
      p.status = 'approving';
      try {
        if (p.groupInvitation) Object.assign(p, { token: secret(), deviceId: randomUUID() });
        else Object.assign(p, await issueDevice({ name: p.name, deviceType: p.deviceType, pairingReturnExpiresAt: p.returnOffer ? p.expiresAt : undefined }));
      }
      catch (error) { p.status = 'pending'; throw error; }
      p.status = 'approved';
    },
    issueReturn(name, expiresAt) {
      if (state.devices.length >= 32) return null;
      return issueDevice({ name: text(name, '设备名称', 100), deviceType: 'computer', pairingReturnExpiresAt: expiresAt });
    },
    async recordReturn(id, pairingReturn) {
      const device = state.devices.find(row => row.id === id);
      if (!device) throw new Error('设备授权已撤销');
      const previous = device.pairingReturn, expiresAt = device.pairingReturnExpiresAt;
      device.pairingReturn = pairingReturn;
      delete device.pairingReturnExpiresAt;
      try { await persist(); } catch (error) { device.pairingReturn = previous; device.pairingReturnExpiresAt = expiresAt; throw error; }
    },
    async complete(id, pollToken, credential, register) {
      const p = pairedRequest(id, pollToken);
      if (p.status !== 'approved' || !p.returnOffer) throw new Error('配对请求尚未批准或不支持双向连接');
      const device = () => {
        if (pending.get(id) !== p || !state.devices.some(row => row.id === p.deviceId)) throw new Error('配对已过期或授权已撤销');
      };
      device();
      if (p.completion) return p.completion;
      const completion = (async () => {
        const result = credential ? await (p.registerReturn || register)(p.returnOffer, credential, device, p.name) : 'source-unavailable';
        device();
        await this.recordReturn(p.deviceId, result);
        return result;
      })();
      p.completion = completion;
      try { return await completion; } catch (error) { delete p.completion; throw error; }
    },
    authenticate(token) {
      if (typeof token !== 'string' || token.length > 256) return;
      const d = state.devices.find(d => sameSecret(token, d.tokenHash));
      if (d) { d.lastSeenAt = Date.now(); return { ...d, capabilities: [...PAIRED_DEVICE_CAPABILITIES] }; }
    },
    authenticateInvitation(token) {
      if (typeof token !== 'string' || token.length !== 43) return;
      prune();
      const p = [...pending.values()].find(row => row.status === 'approved' && row.groupInvitation && row.token === token);
      if (p) return { id: p.deviceId, groupInvitation: p.groupInvitation };
    },
    async renameDevice(id, name) {
      const device = state.devices.find(device => device.id === id);
      if (!device) throw new Error('设备不存在');
      const alias = text(name, '设备备注', 100), previous = device.alias;
      device.alias = alias;
      try { await persist(); } catch (error) { if (previous === undefined) delete device.alias; else device.alias = previous; throw error; }
    },
    async revoke(id) {
      await changeSessions(async () => {
        state.devices = state.devices.filter(d => d.id !== id);
        state.workbenchSessions = state.workbenchSessions.filter(session => session.id !== id);
        for (const [key, value] of pending) if (value.deviceId === id) pending.delete(key);
        await persist();
      });
    },
    clearPairings() { pairings.clear(); pending.clear(); probes.clear(); returnProofs.clear(); },
  };
}
