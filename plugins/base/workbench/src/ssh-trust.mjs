import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ssh2 from 'ssh2';

const { Client: RawClient } = ssh2;
let activeTrust;
const clients = new Set();
export const fingerprintOf = key => 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
export function hostIdentity(input) {
  const host = typeof input?.host === 'string' ? input.host.trim().replace(/^\[|\]$/g, '').toLowerCase() : '';
  const port = input?.port === undefined ? 22 : Number(input.port);
  if (!host || host.length > 253 || /[\s/@\\?#]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('请输入有效的服务器地址和 SSH 端口');
  return { host, port, id: JSON.stringify([host, port]) };
}
/** ssh2 calls hostVerifier during key exchange, before authentication. */
export class Client extends RawClient {
  connect(config) {
    const target = hostIdentity(config), expected = activeTrust?.get(target.id);
    if (!expected) throw new Error('请先在 BenchGo 工作台确认此服务器的 SSH 指纹');
    clients.add(this); this.once('close', () => clients.delete(this)); this.benchgoTarget = target.id;
    return super.connect({ ...config, hostHash: undefined, hostVerifier: key => activeTrust?.get(target.id) === expected && fingerprintOf(key) === expected });
  }
}

export async function openSshTrust(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'ssh-trust.json'); let records = {}, pending = Promise.resolve();
  try { records = JSON.parse(await readFile(path, 'utf8')); if (!records || Array.isArray(records) || Object.values(records).some(v => !/^SHA256:[A-Za-z0-9+/]{43}$/.test(v))) throw new Error('SSH 指纹记录损坏'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const trust = { get: id => records[id] }; activeTrust = trust;
  const save = action => { const task = pending.then(action); pending = task.catch(() => {}); return task; };
  return {
    list: () => Object.entries(records).map(([id, fingerprint]) => ({ ...hostIdentity({ host: JSON.parse(id)[0], port: JSON.parse(id)[1] }), fingerprint })),
    confirm(input) { return save(async () => {
      const target = hostIdentity(input);
      if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(input.fingerprint ?? '')) throw new Error('SSH 指纹无效');
      const next = { ...records, [target.id]: input.fingerprint }, temp = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(next), { mode: 0o600 }); await rename(temp, path); } finally { await rm(temp, { force: true }); }
      const changed = records[target.id] && records[target.id] !== input.fingerprint; records = next;
      if (changed) for (const client of clients) if (client.benchgoTarget === target.id) client.destroy();
      return { ...target, fingerprint: input.fingerprint };
    }); },
    async close() { if (activeTrust === trust) { activeTrust = undefined; for (const client of clients) client.destroy(); } await pending; },
  };
}

/** Probe only the public host key; authHandler refuses every authentication attempt. */
export async function probeFingerprint(input, { clientFactory = () => new RawClient(), timeout = 15000 } = {}) {
  const target = hostIdentity(input), client = clientFactory();
  return new Promise((resolve, reject) => {
    let done = false; const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); client.destroy(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('SSH 指纹探测超时')), timeout);
    client.on('error', error => finish(error)); client.on('close', () => finish(new Error('服务器未返回 SSH 指纹')));
    try { client.connect({ host: target.host, port: target.port, username: 'benchgo-key-probe', authHandler: () => false, readyTimeout: timeout,
      hostVerifier(key) { finish(null, { ...target, fingerprint: fingerprintOf(key) }); return false; },
    }); } catch (error) { finish(error); }
  });
}
