import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { createVault, mountVault } from '../src/vault.mjs';

function host() {
  const records = new Map();
  let queue = Promise.resolve();
  return { credentials: { readRecord: async key => structuredClone(records.get(key)), modifyRecord: (key, fn) => {
    const result = queue.then(async () => { const next = await fn(structuredClone(records.get(key))); records.set(key, structuredClone(next)); return structuredClone(next); });
    queue = result.catch(() => {}); return result;
  } }, dump: () => JSON.stringify([...records]) };
}
const saved = { address: '家庭设备', credentials: [{ name: '账号', value: 'private-user' }, { name: '密码', value: 's3cr3t-CANNOT-LEAK' }] };

test('concurrent first saves share the host key without blocking credential writes', { timeout: 2000 }, async () => {
  const h = host(), first = createVault({ credentials: h.credentials }), second = createVault({ credentials: h.credentials });
  await Promise.all([first.save(saved), second.save({ ...saved, address: 'second' })]);
  assert.equal((await first.list()).entries.length, 2);
  assert.equal((await second.list()).entries.length, 2);
  await h.credentials.modifyRecord('unrelated', () => ({ payload: { value: true } }));
  assert.equal((await h.credentials.readRecord('unrelated')).payload.value, true);
});

test('vault works without a passphrase or lock and never returns plaintext', async () => {
  const h = host(), v = createVault({ credentials: h.credentials });
  try {
    assert.deepEqual(await v.status(), { initialized: false, locked: false });
    assert.deepEqual(await v.list(), { entries: [], locked: false });
    const { entry } = await v.save(saved);
    assert.equal(entry.secret, undefined);
    assert.equal((await v.status()).initialized, true);
    assert.doesNotMatch(JSON.stringify(await v.list()), /private-user|s3cr3t/);
    assert.doesNotMatch(h.dump(), /private-user|s3cr3t/);
    const fresh = createVault({ credentials: h.credentials });
    try { assert.equal((await fresh.list()).entries[0].handle, entry.handle); } finally { fresh.dispose(); }
  } finally { v.dispose(); }
});

test('multiple credentials survive edits, rename, removal and reload; execution stays host-only', async () => {
  const h = host(), v = createVault({ credentials: h.credentials });
  const { entry } = await v.save(saved);
  const changed = await v.save({ ...entry, address: 'http://device.local/login?tab=1', credentials: entry.credentials.map((item, index) => ({ ...item, ...(index ? { name: '新密码', value: 'replacement\nmultiline' } : {}) })) });
  const fresh = createVault({ credentials: h.credentials });
  const result = await fresh.withCredentials(changed.entry, async data => {
    assert.equal(data.credentials[0].value, 'private-user');
    assert.equal(data.credentials[1].value, 'replacement\nmultiline');
    return data;
  });
  assert.doesNotMatch(JSON.stringify(result), /private-user|replacement/);
  assert.equal(v.execute, undefined);
  await assert.rejects(v.withCredentials(entry, () => {}), { code: 'VAULT_CONFLICT' });
  await assert.rejects(v.withCredentials(changed.entry, () => { throw Error('replacement'); }), error => error.code === 'VAULT_USE_FAILED' && !error.message.includes('replacement'));
  const removed = await v.save({ ...changed.entry, credentials: [changed.entry.credentials[0]] });
  await fresh.withCredentials(removed.entry, data => assert.equal(data.credentials.length, 1));
});

test('old encrypted entries migrate once without losing secrets or references', async () => {
  const h = host(), key = randomBytes(32), iv = randomBytes(12);
  const old = { entries: [{ handle: 'old-handle', revision: 3, updatedAt: 12, label: 'old-label', target: 'https://old.test/', secret: 'old-secret', kind: 'otp', expiresAt: 1, method: 'POST', placement: 'header', field: 'Authorization', prefix: 'bearer' }] };
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from('BenchGo vault v2'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(old)), cipher.final()]);
  await h.credentials.modifyRecord('benchgo-plugin/vault-key', () => ({ payload: { key: key.toString('base64') } }));
  await h.credentials.modifyRecord('benchgo-plugin/vault', () => ({ payload: { version: 2, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') } }));
  const v = createVault({ credentials: h.credentials }), { entries } = await v.list();
  assert.equal(entries[0].handle, 'old-handle'); assert.equal(entries[0].revision, 3);
  assert.equal(entries[0].credentials[0].name, 'old-label');
  const dump = h.dump(); await v.list(); assert.equal(h.dump(), dump);
  await v.withCredentials(entries[0], data => assert.equal(data.credentials[0].value, 'old-secret'));
  assert.doesNotMatch(JSON.stringify(entries), /old-secret|method|expiresAt|prefix/);
});

test('owner API rejects cross-origin and execute actions', async () => {
  const h = host(), effects = [], ctx = { credentials: h.credentials, provide() {}, effect(fn) { effects.push(fn()); }, connection: { fetch: { register() { return () => {}; } } } };
  const { fetch } = mountVault(ctx), request = input => new Request('https://benchgo.test/api/benchgo/vault', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  try {
    assert.equal((await fetch(request({ action: 'initialize' }))).status, 400);
    assert.equal((await fetch(new Request('https://benchgo.test/api/benchgo/vault', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.test' }, body: '{"action":"status"}' }))).status, 403);
    assert.equal((await fetch(request({ action: 'execute' }))).status, 400);
  } finally { for (const effect of effects.reverse()) await effect?.(); }
});

test('ciphertext authentication rejects tampering without exposing secrets', async () => {
  const h = host(), v = createVault({ credentials: h.credentials });
  try {
    await v.save(saved);
    const record = await h.credentials.readRecord('benchgo-plugin/vault');
    record.payload.tag = Buffer.alloc(16).toString('base64');
    await h.credentials.modifyRecord('benchgo-plugin/vault', async () => record);
    await assert.rejects(v.list(), error => error.code === 'VAULT_DATA_INVALID' && !error.message.includes(saved.credentials[1].value));
  } finally { v.dispose(); }
});
