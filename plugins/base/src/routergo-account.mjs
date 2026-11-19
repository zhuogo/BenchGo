import { randomUUID } from 'node:crypto';
import { routerGo } from '../shared/builtin-providers.mjs';
import { routerGoAccountPath, routerGoOrigin, isRouterGoAccountReference } from '../shared/routergo-account.mjs';
import { assertSameOrigin, HttpError, readJson, readLimited } from '../shared/http.mjs';
import { discoverRouterGoModels } from './model-providers.mjs';
import { createModelCapabilitySettings } from './model-capability-settings.mjs';
import { createRouterGoModelState, reconcileRouterGoModels } from './routergo-model-sync.mjs';

const namespace = 'llm-pi-ai';
const providerPath = ['providers', routerGo.id];
const set = (field, value) => ({ op: 'set', path: [...providerPath, field], value });
const accountFields = { displayName: routerGo.name, baseURL: routerGo.baseURL, api: routerGo.protocol };
const accountFieldOps = previous => Object.entries(accountFields)
  .filter(([field, value]) => previous[field] !== value)
  .map(([field, value]) => set(field, value));
const remotePath = routerGoOrigin + '/api/x/benchgo-auth';
const manualRef = 'ROUTERGO_API_KEY';
const tokenRef = ref => ref.replace('_KEY_', '_ACCOUNT_');
const deviceGrant = 'urn:ietf:params:oauth:grant-type:device_code';
const headers = { 'cache-control': 'no-store' };
const validText = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);
const validSecret = value => validText(value, 4096) && !/\s/u.test(value);
const fixedAddress = value => !value || typeof value === 'string' && value.replace(/\/$/u, '') === routerGo.baseURL;
const syncInterval = 60_000;

function accountIdentity(account, secrets) {
  const id = typeof account?.id === 'number' && Number.isSafeInteger(account.id) ? String(account.id) : account?.id;
  if (!validText(id, 128) || !validText(account?.name, 256) || secrets.some(secret => id.includes(secret) || account.name.includes(secret))) {
    throw new HttpError('RouterGo 返回的账号信息无效', 502);
  }
  const username = account.username;
  return { id, name: account.name,
    ...(validText(username, 256) && !secrets.some(secret => username.includes(secret)) ? { username } : {}),
  };
}

export function createRouterGoAccount(ctx, { fetcher = globalThis.fetch, discover = discoverRouterGoModels, now = Date.now, directory } = {}) {
  let current, timer, starting = false, lastSync, syncInFlight;
  const modelState = createRouterGoModelState(directory);
  const capabilitySettings = createModelCapabilitySettings(directory);
  const lifetime = new AbortController();
  const document = () => ctx.settings.describe().find(row => row.ns === namespace);
  const profile = doc => doc?.value?.providers?.[routerGo.id];
  const resolve = async ref => ref ? (await ctx.credentials.resolve(ref))?.value : undefined;
  const modelRows = doc => doc?.user?.providers?.[routerGo.id]?.models ?? profile(doc)?.models ?? [];
  const clear = () => { clearTimeout(timer); current = undefined; };
  const expire = (session, seconds) => {
    session.expiresAt = now() + seconds * 1000;
    clearTimeout(timer);
    timer = setTimeout(() => { if (current === session && !session.applying) clear(); }, seconds * 1000);
    timer.unref?.();
  };

  async function remote(path, { input, token, deviceCode, signal } = {}) {
    const timeout = AbortSignal.timeout(12000);
    const outbound = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetcher(remotePath + path, {
        method: input ? 'POST' : 'GET', redirect: 'error', signal: outbound,
        headers: {
          accept: 'application/json',
          ...(input && { 'content-type': 'application/json' }),
          ...(token && { 'X-BenchGo-Account-Proof': token }),
          ...(deviceCode && { 'X-BenchGo-Device-Code': deviceCode }),
        },
        ...(input && { body: JSON.stringify(input) }),
      });
      const body = JSON.parse(new TextDecoder().decode(await readLimited(response, 32768, outbound)));
      return { status: response.status, ok: response.ok, body };
    } catch {
      throw new HttpError('暂时无法联系 RouterGo，请重试', 502);
    }
  }

  async function account(token, apiKey, signal) {
    const { ok, status, body } = await remote('/account', { token, signal });
    if (status === 401 || status === 403) throw new HttpError('RouterGo 账号授权已失效，请重新登录', 401);
    if (!ok) throw new HttpError('暂时无法读取 RouterGo 余额，请重试', 502);
    const { amount, unit } = body?.balance ?? {};
    if (!validText(amount, 64) || !/^-?\d+(?:\.\d+)?$/u.test(amount) || !validText(unit, 32) || [token, apiKey].some(secret => unit.includes(secret))) {
      throw new HttpError('RouterGo 返回的余额格式无效', 502);
    }
    return { account: accountIdentity(body.account, [token, apiKey]), balance: { amount, unit } };
  }

  function requireSession(id) {
    if (!current || current.id !== id || current.expiresAt <= now()) throw new HttpError('RouterGo 授权已过期，请重新登录', 410);
    return current;
  }

  function writableDocument() {
    const doc = document();
    if (!doc || ctx.settings.writable === false) throw new HttpError('模型配置暂不可写入', 503);
    if (!fixedAddress(profile(doc)?.baseURL)) throw new HttpError('当前 RouterGo 使用自定义 API 地址。请先在模型设置切回 RouterGo 官方地址', 409);
    return doc;
  }

  async function modelChanges(doc, models, priorRef) {
    const existing = modelRows(doc);
    const prior = isRouterGoAccountReference(priorRef) ? await modelState.load(priorRef, existing) : { models: [], excluded: [] };
    const protectedIds = new Set([
      ...Object.keys(profile(doc)?.modelOverrides ?? {}),
      ...(await capabilitySettings.list(routerGo.id)).map(row => row.modelId),
    ]);
    return { prior, result: reconcileRouterGoModels(existing, models, prior, protectedIds) };
  }

  async function runSync(ref) {
    const key = await resolve(ref);
    if (!key) throw new HttpError('RouterGo 模型同步需要可用的账号凭据', 409);
    const models = await discover(key, lifetime.signal).catch(() => { throw new HttpError('暂时无法同步 RouterGo 模型，已保留现有列表', 502); });
    return modelState.lock(ref, async () => {
      lifetime.signal.throwIfAborted();
      const doc = writableDocument();
      if (profile(doc)?.apiKeyEnv !== ref || await resolve(ref) !== key) throw new HttpError('RouterGo 凭据已变更，请重新同步', 409);
      const { prior, result } = await modelChanges(doc, models, ref);
      lifetime.signal.throwIfAborted();
      const ops = accountFieldOps(profile(doc));
      if (Object.values(result.changes).some(Boolean)) ops.push(set('models', result.next));
      await modelState.commit(ref, prior, result, async () => {
        if (ops.length) await ctx.settings.mutate(namespace, ops, doc.revision);
      });
      return { state: 'synced', ...result.changes };
    });
  }

  async function sync(force = false) {
    if (syncInFlight) return syncInFlight;
    const configured = profile(document());
    const ref = configured?.apiKeyEnv;
    if (!isRouterGoAccountReference(ref) || !fixedAddress(configured.baseURL)) return { state: 'disconnected' };
    if (current?.applying) return { state: 'busy' };
    if (lastSync?.ref === ref && now() - lastSync.at < (force ? lastSync.error ? 0 : 2000 : syncInterval)) {
      if (lastSync.error) throw lastSync.error;
      return { ...lastSync.result, state: 'recent' };
    }
    syncInFlight = runSync(ref).then(result => {
      lastSync = { ref, at: now(), result };
      return result;
    }, error => {
      const reason = error instanceof HttpError ? error : new HttpError('RouterGo 模型同步失败，已保留现有列表，请重试', 409);
      lastSync = { ref, at: now(), error: reason };
      throw reason;
    });
    try { return await syncInFlight; }
    finally { syncInFlight = undefined; }
  }

  async function start(signal) {
    writableDocument();
    if (starting || current?.applying) throw new HttpError('正在处理 RouterGo 授权，请稍后重试', 409);
    starting = true;
    try {
      const { ok, body } = await remote('/device', { input: { client_id: 'benchgo' }, signal });
      if (!ok) throw new HttpError('RouterGo 暂时无法启动授权，请重试', 502);
      const { device_code: deviceCode, verification_uri_complete: verification, expires_in: expires, interval } = body ?? {};
      let url;
      try { url = new URL(verification); } catch { throw new HttpError('RouterGo 授权链接无效', 502); }
      if (!validSecret(deviceCode) || url.origin !== routerGoOrigin || url.pathname !== '/benchgo/authorize'
        || url.username || url.password || url.href.includes(deviceCode)
        || !Number.isInteger(expires) || expires < 1 || expires > 1800 || !Number.isInteger(interval) || interval < 1 || interval > 60) {
        throw new HttpError('RouterGo 授权信息无效', 502);
      }
      const session = { id: randomUUID(), deviceCode, interval, nextPollAt: now() + interval * 1000 };
      current = session;
      expire(session, expires);
      return { id: session.id, verificationURL: url.href, retryAfter: interval };
    } finally { starting = false; }
  }

  async function poll(id, signal) {
    const session = requireSession(id);
    if (session.approved) return session.approved.view;
    const remaining = session.nextPollAt - now();
    if (remaining > 0 || session.polling) return { state: 'pending', retryAfter: Math.max(session.interval, Math.ceil(remaining / 1000)) };
    session.polling = true;
    session.nextPollAt = now() + session.interval * 1000;
    try {
      const { ok, body } = await remote('/token', {
        input: { client_id: 'benchgo', grant_type: deviceGrant }, deviceCode: session.deviceCode, signal,
      });
      requireSession(id);
      if (!ok) {
        if (body?.error === 'access_denied' || body?.error === 'expired_token') {
          clear();
          return { state: body.error === 'access_denied' ? 'denied' : 'expired' };
        }
        if (body?.error === 'slow_down') {
          session.interval += 5;
          session.nextPollAt = now() + session.interval * 1000;
        } else if (body?.error !== 'authorization_pending') throw new HttpError('RouterGo 授权状态暂不可用，请重试', 502);
        return { state: 'pending', retryAfter: session.interval };
      }
      const { api_key: apiKey, access_token: token, token_type: tokenType } = body ?? {};
      if (!validSecret(apiKey) || !validSecret(token) || tokenType !== 'Bearer') throw new HttpError('RouterGo 返回的授权凭据无效', 502);
      const identity = accountIdentity(body.account, [apiKey, token, session.deviceCode]);
      const configured = profile(document());
      const previous = await resolve(configured ? configured.apiKeyEnv || manualRef : undefined);
      requireSession(id);
      const view = { state: 'authorized', account: identity, requireSwitch: !!previous && previous !== apiKey };
      session.approved = { apiKey, token, view };
      delete session.deviceCode;
      expire(session, 300);
      return view;
    } finally { session.polling = false; }
  }

  async function save(id, replace, signal) {
    const session = requireSession(id);
    if (!session.approved || session.applying) throw new HttpError('RouterGo 授权尚未就绪或正在保存', 409);
    const { apiKey, token, view } = session.approved;
    session.applying = true;
    try {
      await syncInFlight?.catch(() => {});
      const models = await discover(apiKey, signal).catch(() => { throw new HttpError('暂时无法获取该账号的 RouterGo 模型，请重试', 502); });
      if (!models.length) throw new HttpError('该账号暂无可通过 API 调用的模型，请检查账号权限后重试', 422);
      requireSession(id);
      const doc = writableDocument(), previous = profile(doc);
      const oldRef = previous ? previous.apiKeyEnv || manualRef : undefined;
      const previousKey = await resolve(oldRef);
      if (previousKey && previousKey !== apiKey && replace !== true) {
        view.requireSwitch = true;
        throw new HttpError('当前 RouterGo 已有凭据。确认使用账号凭据后再保存', 409, 'switch_required');
      }
      const sameKey = isRouterGoAccountReference(oldRef) && previousKey === apiKey;
      const keyRef = sameKey ? oldRef : 'BENCHGO_ROUTERGO_KEY_' + randomUUID().replaceAll('-', '');
      let changes;
      try {
        await modelState.lock(isRouterGoAccountReference(oldRef) ? oldRef : keyRef, async () => {
          const { prior, result } = await modelChanges(doc, models, oldRef);
          changes = result.changes;
          const changed = Object.values(changes).some(Boolean);
          const ops = previous ? [
            ...accountFieldOps(previous),
            ...(sameKey ? [] : [set('apiKeyEnv', keyRef)]),
            ...(changed ? [set('models', result.next)] : []),
          ] : [{ op: 'set', path: providerPath, value: {
            ...accountFields, apiKeyEnv: keyRef, models: result.next,
          } }];
          requireSession(id);
          if (!sameKey) await ctx.credentials.set(keyRef, apiKey);
          await ctx.credentials.set(tokenRef(keyRef), token);
          await modelState.commit(keyRef, sameKey ? prior : { models: [], excluded: [] }, result, async () => {
            if (ops.length) await ctx.settings.mutate(namespace, ops, doc.revision);
          });
        });
      } catch {
        const latest = document();
        if (!sameKey && latest && profile(latest)?.apiKeyEnv !== keyRef) {
          await Promise.allSettled([ctx.credentials.unset(keyRef), ctx.credentials.unset(tokenRef(keyRef))]);
        }
        throw new HttpError('RouterGo 配置保存失败。请刷新模型设置后重试', 409);
      }
      clear();
      lastSync = { ref: keyRef, at: now(), result: { state: 'synced', ...changes } };
      return { state: 'connected', account: view.account, imported: changes.added };
    } finally {
      session.applying = false;
      if (current === session && session.expiresAt <= now()) clear();
    }
  }

  async function status(signal) {
    const previous = profile(document());
    if (!isRouterGoAccountReference(previous?.apiKeyEnv) || !fixedAddress(previous.baseURL)) return { state: 'disconnected' };
    const [apiKey, token] = await Promise.all([resolve(previous.apiKeyEnv), resolve(tokenRef(previous.apiKeyEnv))]);
    if (!apiKey || !token) return { state: 'disconnected' };
    const view = await account(token, apiKey, signal);
    if (profile(document())?.apiKeyEnv !== previous.apiKeyEnv) return { state: 'disconnected' };
    return { state: 'connected', ...view };
  }

  async function dispatch(input, signal) {
    switch (input.action) {
      case 'status': return status(signal);
      case 'start': return start(signal);
      case 'poll': return poll(input.id, signal);
      case 'save': return save(input.id, input.replace, signal);
      case 'sync': return sync(input.force === true);
      case 'cancel': {
        const session = requireSession(input.id);
        if (session.applying) throw new HttpError('正在保存 RouterGo 配置', 409);
        clear();
        return { state: 'cancelled' };
      }
      default: throw new HttpError('未知 RouterGo 操作');
    }
  }

  return {
    clear,
    sync,
    dispose() { clear(); lifetime.abort(); },
    async fetch(request) {
      try {
        assertSameOrigin(request, { allowDesktopOrigin: true });
        return Response.json(await dispatch(await readJson(request, 2048), request.signal), { headers });
      } catch (error) {
        const known = error instanceof HttpError;
        return Response.json({ error: known ? error.message : 'RouterGo 操作失败，请重试', code: known ? error.code : undefined }, {
          status: known ? error.status : 500, headers,
        });
      }
    },
  };
}

export function mountRouterGoAccount(ctx, { directory } = {}) {
  const service = createRouterGoAccount(ctx, { directory });
  ctx.effect(() => ctx.connection.fetch.register({ path: routerGoAccountPath, methods: ['POST'], requestBody: 'buffered', fetch: service.fetch }));
  ctx.effect(() => {
    const refresh = () => { void service.sync().catch(() => {}); };
    const timer = setInterval(refresh, syncInterval);
    timer.unref?.();
    refresh();
    return () => { clearInterval(timer); service.dispose(); };
  });
}
