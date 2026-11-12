import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { HttpError, assertSameOrigin, readJson } from '../shared/http.mjs';

const recordKey = 'benchgo-plugin/vault';
const keyRecordKey = 'benchgo-plugin/vault-key';
const aad = Buffer.from('BenchGo vault v2');
const fail = (message, status = 400, code = 'VAULT_INVALID') => new HttpError(message, status, code);
const check = (condition, message) => { if (!condition) throw fail(message); };

function encrypt(data, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return { kind: 'grant', payload: { version: 2, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') } };
}
function decrypt(record, key) {
  try {
    const p = record?.payload;
    if (p?.version !== 2) throw Error();
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(p.iv, 'base64'));
    cipher.setAAD(aad); cipher.setAuthTag(Buffer.from(p.tag, 'base64'));
    const data = JSON.parse(Buffer.concat([cipher.update(Buffer.from(p.ciphertext, 'base64')), cipher.final()]).toString('utf8'));
    if (!Array.isArray(data.entries)) throw Error();
    return data;
  } catch { throw fail('保险库数据无法解密，原数据已保留，请检查宿主凭据存储', 409, 'VAULT_DATA_INVALID'); }
}
// Only the storage shape is migrated; retired HTTP bindings never control execution.
function migrate(data) {
  let changed = false;
  data.entries = data.entries.map(entry => {
    if (Array.isArray(entry.credentials)) return entry;
    if (typeof entry.secret !== 'string') throw fail('保险库数据无法读取，原数据已保留', 409, 'VAULT_DATA_INVALID');
    changed = true;
    return { handle: entry.handle, revision: entry.revision, updatedAt: entry.updatedAt,
      address: entry.target || entry.label,
      credentials: [{ id: `credential-${randomUUID()}`, name: entry.label || entry.field || '凭证', value: entry.secret }] };
  });
  return changed;
}
function entryInput(input, old) {
  const address = input.address ?? old?.address;
  check(typeof address === 'string' && address.trim().length > 0 && address.length <= 2048, '请输入地址或名称（最多 2048 字）');
  const items = input.credentials ?? old?.credentials;
  check(Array.isArray(items) && items.length > 0 && items.length <= 50, '每个条目需要 1 至 50 项凭证');
  const seen = new Set();
  const credentials = items.map(item => {
    check(item && typeof item === 'object', '凭证格式无效');
    const previous = item.id && old?.credentials.find(value => value.id === item.id);
    check(!item.id || !!previous, '凭证引用已失效，请刷新后重试');
    const id = previous?.id ?? `credential-${randomUUID()}`;
    check(!seen.has(id), '凭证引用重复'); seen.add(id);
    check(typeof item.name === 'string' && item.name.trim().length > 0 && item.name.length <= 120, '请输入凭证名称（最多 120 字）');
    const value = item.value === undefined ? previous?.value : item.value;
    check(typeof value === 'string' && value.length > 0 && value.length <= 16384, '请输入凭证值（最多 16384 字）');
    return { id, name: item.name.trim(), value };
  });
  return { address: address.trim(), credentials };
}
const publicEntry = entry => ({ handle: entry.handle, revision: entry.revision, address: entry.address,
  updatedAt: entry.updatedAt, credentials: entry.credentials.map(({ id, name }) => ({ id, name, configured: true })) });

/** The host owns the encryption key. The owner API and Worker tools never return secrets. */
export function createVault({ credentials } = {}) {
  let queue = Promise.resolve();
  const serial = work => { const next = queue.then(work); queue = next.catch(() => {}); return next; };
  const getKey = async () => {
    const record = await credentials.readRecord(keyRecordKey);
    if (record?.payload?.key) {
      const key = Buffer.from(record.payload.key, 'base64');
      if (key.length === 32) return key;
    }
    const key = randomBytes(32);
    await credentials.modifyRecord(keyRecordKey, async current => current ?? { kind: 'grant', payload: { version: 1, key: key.toString('base64') } });
    const saved = await credentials.readRecord(keyRecordKey);
    const result = Buffer.from(saved?.payload?.key || '', 'base64');
    if (result.length !== 32) throw fail('保险库密钥不可用', 503, 'VAULT_UNAVAILABLE');
    return result;
  };
  const open = async () => {
    const record = await credentials.readRecord(recordKey);
    if (!record) return { entries: [] };
    const key = await getKey(), data = decrypt(record, key);
    if (!migrate(data)) return data;
    // Re-read under the host write lock so concurrent edits cannot be overwritten.
    let migrated;
    await credentials.modifyRecord(recordKey, current => {
      migrated = decrypt(current, key); migrate(migrated);
      return encrypt(migrated, key);
    });
    return migrated;
  };
  const mutate = async fn => {
    // The host serializes all credential writes, including writes to other keys.
    const key = await getKey();
    return credentials.modifyRecord(recordKey, async current => {
      const data = current ? decrypt(current, key) : { entries: [] };
      migrate(data);
      await fn(data);
      return encrypt(data, key);
    });
  };
  const service = {
    status: () => serial(async () => ({ initialized: !!await credentials.readRecord(recordKey), locked: false })),
    list: () => serial(async () => ({ entries: (await open()).entries.map(publicEntry), locked: false })),
    save: input => serial(async () => {
      let result;
      await mutate(data => {
        check(data.entries.length < 200 || !!input.handle, '保险库最多保存 200 项凭据');
        const old = input.handle && data.entries.find(entry => entry.handle === input.handle);
        if (input.handle && (!old || old.revision !== input.revision)) throw fail('凭据已变更，请刷新后重试', 409, 'VAULT_CONFLICT');
        result = { ...entryInput(input, old), handle: old?.handle ?? `vault-${randomUUID()}`, revision: (old?.revision ?? 0) + 1, updatedAt: Date.now() };
        data.entries = [...data.entries.filter(entry => entry.handle !== result.handle), result];
      });
      return { entry: publicEntry(result) };
    }),
    remove: input => serial(async () => {
      await mutate(data => {
        const entry = data.entries.find(item => item.handle === input.handle);
        if (!entry || entry.revision !== input.revision) throw fail('凭据已变更，请刷新后重试', 409, 'VAULT_CONFLICT');
        data.entries = data.entries.filter(item => item !== entry);
      }); return { removed: true };
    }),
    // Host-only seam. Never exposed as an HTTP action or a model tool. Consumers must
    // keep values inside their execution environment and return only safe receipts.
    withCredentials: (input, consume) => serial(async () => {
      check(typeof consume === 'function', '凭证使用能力尚未接入');
      const entry = (await open()).entries.find(item => item.handle === input.handle);
      if (!entry) throw fail('未找到对应凭据', 404, 'VAULT_NOT_FOUND');
      if (entry.revision !== input.revision) throw fail('凭据已变更，请重新选择', 409, 'VAULT_CONFLICT');
      const values = entry.credentials.map(item => ({ ...item }));
      try { await consume({ address: entry.address, credentials: values }); }
      catch { throw fail('凭证使用未完成，请在执行环境中核实结果', 502, 'VAULT_USE_FAILED'); }
      finally { for (const item of values) item.value = ''; }
      return { handle: entry.handle, revision: entry.revision, completed: true };
    }),
    dispose: () => {},
  };
  return service;
}

export function mountVault(ctx, options = {}) {
  const { registerRoute = true, ...vaultOptions } = options;
  const service = createVault({ credentials: ctx.credentials, ...vaultOptions });
  ctx.provide('benchgoVault', service);
  const fetch = async request => {
    try {
      assertSameOrigin(request, { allowDesktopOrigin: true });
      const address = new URL(request.url), origin = request.headers.get('origin');
      const localDesktop = address.protocol === 'dsh-app:' && address.hostname === 'app';
      const forwardedDesktop = !origin && Boolean(request.headers.get('cookie'));
      if (address.protocol !== 'https:' && !localDesktop && !forwardedDesktop && !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)) throw fail('保险库录入需要 HTTPS 或本机连接', 403, 'VAULT_INSECURE_TRANSPORT');
      const input = await readJson(request, 1048576);
      if (!['status', 'list', 'save', 'remove'].includes(input.action)) throw fail('未知保险库操作');
      const result = await service[input.action](input);
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      return Response.json({ error: error instanceof HttpError ? error.message : '保险库操作失败', code: error instanceof HttpError ? error.code : 'VAULT_UNAVAILABLE' }, { status: error instanceof HttpError ? error.status : 503, headers: { 'cache-control': 'no-store' } });
    }
  };
  if (registerRoute) ctx.effect(() => ctx.connection.fetch.register({ path: '/api/benchgo/vault', methods: ['POST'], requestBody: 'buffered', fetch }));
  ctx.effect(() => () => service.dispose());
  return { service, fetch };
}
