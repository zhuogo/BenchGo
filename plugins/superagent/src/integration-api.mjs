import { Readable } from 'node:stream';
import { integrationBearer, useIntegrationToken } from '../../base/shared/integration-token.mjs';
import { assertSameOrigin, HttpError, readJson } from '../../base/shared/http.mjs';

const apiPath = '/api/commander-integration';
const credentialPath = apiPath + '/token';
const noStore = { 'cache-control': 'no-store' };
const failure = error => Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}) },
  { status: error.status ?? 500, headers: noStore });

export function mountIntegrationApi(ctx, enabled) {
  const link = () => ctx.get?.('benchgoLink');
  const credential = (operation, input) => link()?.integrationToken?.(operation, input)
    ?? useIntegrationToken(ctx.credentials, 'local', operation, input);
  const authorize = async token => {
    if (!token || !enabled() || !(await credential('verify', { token })).valid || !enabled()) throw new HttpError('API Token 无效或外部集成未启用', 401);
  };
  const call = async (input, token, signal) => {
    const { path, method = 'POST', body } = input;
    if (!['GET', 'POST'].includes(method) || typeof path !== 'string' || !/^\/api\/[a-z0-9_/-]+(?:\?[^#\s]*)?$/iu.test(path)) throw new HttpError('请提供 BenchGo API 路径及 GET 或 POST 方法', 400);
    const url = new URL(path, 'http://benchgo.internal');
    if ([apiPath, credentialPath].includes(url.pathname)) throw new HttpError('请在已登录的工作台管理 API Token', 403);
    await authorize(token);
    const request = new Request(url, { method, signal, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const response = await ctx.connection.createSharedFetchHandler('/api').fetch(request, ctx.connection.browserPeer);
    const type = response.headers.get('content-type');
    if (type?.includes('application/json')) return { status: response.status, value: await response.json() };
    await response.body?.cancel();
    return { status: response.ok ? 415 : response.status, value: { error: response.ok ? '此 API 不返回 JSON' : `BenchGo API 返回 HTTP ${response.status}` } };
  };
  ctx.provide('benchgoIntegration', { authorize, call });
  ctx.effect(() => ctx.connection.fetch.register({
    path: credentialPath, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        assertSameOrigin(request);
        const endpoint = link()?.integrationEndpoint?.();
        if (!enabled()) return Response.json({ endpoint }, { headers: noStore });
        const { operation, revision } = await readJson(request, 1024);
        if (!['read', 'rotate'].includes(operation)) throw new HttpError('未知 API Token 操作', 400);
        const value = await credential(operation, { revision });
        if (!enabled()) throw new HttpError('外部集成未启用', 409);
        return Response.json({ ...value, endpoint }, { headers: noStore });
      } catch (error) { return failure(error); }
    },
  }));
  ctx.inject(['webServer'], web => web.effect(() => web.webServer.register({
    kind: 'exact', path: apiPath, auth: 'anonymous',
    async handler(req, res) {
      const cancellation = new AbortController();
      res.on('close', () => cancellation.abort());
      let result;
      try {
        if (req.method !== 'POST') throw new HttpError('请使用 POST', 405);
        const token = integrationBearer(req.headers);
        await authorize(token);
        const request = new Request('http://benchgo.internal' + apiPath, { method: 'POST', headers: req.headers, body: Readable.toWeb(req), duplex: 'half', signal: cancellation.signal });
        assertSameOrigin(request);
        const { status, value } = await call(await readJson(request, 4 * 1024 * 1024), token, cancellation.signal);
        result = Response.json(value, { status, headers: noStore });
      } catch (error) { result = failure(error); }
      if (res.destroyed) return;
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(await result.text());
    },
  })));
}
