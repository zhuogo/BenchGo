import test from 'node:test';
import assert from 'node:assert/strict';
import { createVault, mountVault } from '../src/vault.mjs';

function host() {
  const records = new Map();
  let queue = Promise.resolve();
  return { credentials: { readRecord: async key => structuredClone(records.get(key)), modifyRecord: (key, fn) => {
    const result = queue.then(async () => { const next = await fn(structuredClone(records.get(key))); records.set(key, structuredClone(next)); return structuredClone(next); });
    queue = result.catch(() => {}); return result;
  } }, dump: () => JSON.stringify([...records]) };
}
const saved = { label: '测试凭据', secret: 's3cr3t-CANNOT-LEAK', target: 'https://api.example.test/auth', method: 'POST', placement: 'header', field: 'Authorization', prefix: 'bearer' };

test('concurrent first saves share the host key without blocking credential writes', { timeout: 2000 }, async () => {
  const h = host(), first = createVault({ credentials: h.credentials }), second = createVault({ credentials: h.credentials });
  await Promise.all([first.save(saved), second.save({ ...saved, label: 'second' })]);
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
    assert.doesNotMatch((await v.list()).entries[0].label, /s3cr3t/);
    assert.doesNotMatch(h.dump(), /correct horse/);
    const fresh = createVault({ credentials: h.credentials });
    try { assert.equal((await fresh.list()).entries[0].handle, entry.handle); } finally { fresh.dispose(); }
  } finally { v.dispose(); }
});

test('system fills only owner bound destination and returns status only', async () => {
  const h = host(), calls = [], v = createVault({ credentials: h.credentials, fetcher: async (url, init) => { calls.push({ url, init }); return new Response(saved.secret, { status: 201, headers: { authorization: saved.secret } }); } });
  try {
    const { entry } = await v.save(saved), input = { handle: entry.handle, revision: 1, target: entry.target, method: entry.method, body: { task: 'do' } };
    await assert.rejects(v.execute({ ...input, target: 'https://evil.example.test/auth' }), { code: 'VAULT_TARGET_MISMATCH' });
    const result = await v.execute(input);
    assert.deepEqual(result, { handle: entry.handle, ok: true, status: 201, redacted: true });
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${saved.secret}`);
  } finally { v.dispose(); }
});

test('OTP is consumed before uncertain send and form filling preserves fields', async () => {
  const h = host(), calls = [], v = createVault({ credentials: h.credentials, fetcher: async (_, init) => { calls.push(init); throw Error(saved.secret); } });
  try {
    const { entry } = await v.save({ ...saved, placement: 'form', prefix: 'none', field: 'otp', kind: 'otp' });
    await assert.rejects(v.execute({ ...entry, body: { account: 'alice' } }), error => error.code === 'VAULT_REQUEST_UNCERTAIN' && !error.message.includes(saved.secret));
    assert.equal(new URLSearchParams(calls[0].body).get('otp'), saved.secret);
    assert.deepEqual((await v.list()).entries, []);
  } finally { v.dispose(); }
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
    await assert.rejects(v.list(), error => error.code === 'VAULT_LEGACY_REQUIRES_RESET' && !error.message.includes(saved.secret));
  } finally { v.dispose(); }
});
