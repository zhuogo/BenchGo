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
  } catch { throw fail('保险库数据无效或版本过旧，请重新录入凭据', 409, 'VAULT_LEGACY_REQUIRES_RESET'); }
}
function target(value) {
  let url; try { url = new URL(value); } catch { throw fail('目标必须为完整 HTTPS 地址'); }
  check(url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search, '目标必须为不含凭据、查询或片段的 HTTPS 地址');
  return url.href;
}
function binding(input) {
  check(typeof input.label === 'string' && input.label.trim().length > 0 && input.label.length <= 120, '请输入凭据名称');
  check(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(input.method), '不支持的 HTTP 方法');
  check(['header', 'json', 'form'].includes(input.placement), '不支持的代填方式');
  check(typeof input.field === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,100}$/.test(input.field), '代填字段无效');
  check(!['host', 'connection', 'content-length', 'transfer-encoding', 'cookie', 'set-cookie', 'content-type', '__proto__', 'prototype', 'constructor'].includes(input.field.toLowerCase()), '不支持该代填字段');
  check(input.placement === 'header' || input.method !== 'GET', 'GET 仅支持请求头代填');
  check(['none', 'bearer'].includes(input.prefix ?? 'none') && (!input.prefix || input.prefix !== 'bearer' || input.placement === 'header'), '不支持的凭据前缀');
  check(typeof input.secret === 'string' && input.secret.length > 0 && input.secret.length <= 16384 && !/[\r\n\0]/.test(input.secret), '凭据不能为空或包含换行');
  check(input.kind === undefined || ['key', 'password', 'otp'].includes(input.kind), '不支持的凭据类型');
  const kind = input.kind ?? 'key';
  return { label: input.label.trim(), target: target(input.target), method: input.method, placement: input.placement, field: input.field, prefix: input.prefix ?? 'none', kind, expiresAt: kind === 'otp' ? Date.now() + 5 * 60_000 : null, secret: input.secret };
}
const publicEntry = ({ secret, ...entry }) => ({ ...entry, configured: true, available: !entry.expiresAt || entry.expiresAt > Date.now() });

/** The host owns the encryption key. The owner API and Worker tools never return secrets. */
export function createVault({ credentials, fetcher = fetch } = {}) {
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
    return decrypt(record, await getKey());
  };
  const mutate = async fn => {
    // The host serializes all credential writes, including writes to other keys.
    const key = await getKey();
    return credentials.modifyRecord(recordKey, async current => {
      const data = current ? decrypt(current, key) : { entries: [] };
      await fn(data);
      return encrypt(data, key);
    });
  };
  const service = {
    status: () => serial(async () => ({ initialized: !!await credentials.readRecord(recordKey), locked: false })),
    list: () => serial(async () => ({ entries: (await open()).entries.map(publicEntry), locked: false })),
    save: input => serial(async () => {
      const item = binding(input); let result;
      await mutate(data => {
        check(data.entries.length < 200 || !!input.handle, '保险库最多保存 200 项凭据');
        const old = input.handle && data.entries.find(entry => entry.handle === input.handle);
        if (input.handle && (!old || old.revision !== input.revision)) throw fail('凭据已变更，请刷新后重试', 409, 'VAULT_CONFLICT');
        result = { ...item, handle: old?.handle ?? `vault-${randomUUID()}`, revision: (old?.revision ?? 0) + 1, updatedAt: Date.now() };
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
    execute: input => serial(async () => {
      const entry = (await open()).entries.find(item => item.handle === input.handle);
      if (!entry || entry.revision !== input.revision) throw fail('凭据已变更，请重新选择', 409, 'VAULT_CONFLICT');
      if (entry.expiresAt && entry.expiresAt <= Date.now()) throw fail('验证码已过期，请重新录入', 409, 'VAULT_EXPIRED');
      if (input.target !== entry.target || input.method !== entry.method) throw fail('凭据目标与绑定不一致', 403, 'VAULT_TARGET_MISMATCH');
      const body = input.body ?? {};
      check(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length <= 100, '请求正文必须为普通对象');
      for (const [field, value] of Object.entries(body)) check(/^[A-Za-z][A-Za-z0-9_-]{0,100}$/.test(field) && !['__proto__', 'prototype', 'constructor'].includes(field) && ['string', 'number', 'boolean'].includes(typeof value), '请求正文仅支持标量');
      check(JSON.stringify(body).length <= 32768, '请求正文过大');
      check(entry.method !== 'GET' || !Object.keys(body).length, 'GET 不支持正文');
      const headers = { accept: 'application/json' }, filled = { ...body };
      if (entry.placement === 'header') headers[entry.field] = (entry.prefix === 'bearer' ? 'Bearer ' : '') + entry.secret;
      else filled[entry.field] = entry.secret;
      let encoded;
      if (entry.method !== 'GET') {
        headers['content-type'] = entry.placement === 'form' ? 'application/x-www-form-urlencoded' : 'application/json';
        encoded = entry.placement === 'form' ? new URLSearchParams(filled).toString() : JSON.stringify(filled);
      }
      if (entry.kind === 'otp') await mutate(data => {
        const current = data.entries.find(item => item.handle === entry.handle);
        if (!current || current.revision !== entry.revision) throw fail('验证码已使用或变更，请重新录入', 409, 'VAULT_CONFLICT');
        data.entries = data.entries.filter(item => item.handle !== entry.handle);
      });
      let sent = false;
      const send = async () => {
        if (sent) throw fail('代填请求不得重复提交', 409, 'VAULT_ALREADY_SENT');
        input.signal?.throwIfAborted(); sent = true;
        try {
          const response = await fetcher(entry.target, { method: entry.method, headers, body: encoded, redirect: 'error', credentials: 'omit', signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(input.signal ? [input.signal] : [])]) });
          const result = { handle: entry.handle, status: response.status, ok: response.ok, redacted: true };
          await response.body?.cancel().catch(() => {}); return result;
        } catch { throw fail('代填请求未确认完成；不会自动重试，请核实目标状态', 502, 'VAULT_REQUEST_UNCERTAIN'); }
      };
      return input.dispatch ? input.dispatch(send) : send();
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
      const input = await readJson(request, 65536);
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
