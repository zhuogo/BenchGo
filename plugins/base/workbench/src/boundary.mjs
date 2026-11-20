/** Third-party operations stay on the authenticated local owner surface. */
export function localOwnerRejection(request, connection, peer) {
  if (peer !== undefined) {
    if (peer?.principal?.kind !== 'owner' || peer.signal?.aborted) return 403;
  } else {
    if (typeof connection?.requestRejection !== 'function') return 503;
    const rejection = connection.requestRejection(request);
    if (rejection !== undefined) return rejection;
  }
  const headers = request.headers ?? {};
  if (['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'cf-connecting-ip', 'x-benchgo-device', 'x-dsh-link-device'].some(key => headers[key] !== undefined)) return 403;
  const address = request.socket?.remoteAddress?.replace(/^::ffff:/, '');
  if (address !== '::1' && !/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(address ?? '')) return 403;
  let host; try { host = new URL('http://' + headers.host).hostname; } catch { return 403; }
  if (!['localhost', '[::1]'].includes(host) && !/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)) return 403;
  if (headers['sec-fetch-site'] === 'cross-site') return 403;
  if (headers.origin) {
    try { if (new URL(headers.origin).host !== new URL('http://' + headers.host).host) return 403; }
    catch { return 403; }
  }
  return undefined;
}

const admittedRequests = new WeakSet();

/** The vendor's own fence accepts only requests admitted by our route wrapper. */
export function admittedWorkbenchRejection(request) {
  return admittedRequests.has(request) ? undefined : 403;
}

export function ownerWebServer(webServer, connection, { projectOnly = false } = {}) {
  return {
    register(route) {
      return webServer.register({ ...route, async handler(req, res, ...rest) {
        const status = localOwnerRejection(req, connection, rest[0]);
        if (status) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: '此运维入口仅供已登录的本机用户使用，请从设备中心打开目标工作台。' })); return; }
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (projectOnly && (/^\/sidebar\/api\/(?:sidechat|subagents|workflows|teams)\./.test(pathname) || pathname === '/sidebar/sidechat-image')) {
          res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: { code: 'forbidden', message: '对话和任务请使用 BenchGo 现有入口' } })); return;
        }
        admittedRequests.add(req);
        return route.handler(req, res, ...rest);
      } });
    },
    registerUpgrade(route) {
      return webServer.registerUpgrade({ ...route, handler(req, socket, ...rest) {
        const status = localOwnerRejection(req, connection, rest[1]);
        if (status) { socket.end(`HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\n\r\n`); return; }
        admittedRequests.add(req);
        return route.handler(req, socket, ...rest);
      } });
    },
  };
}

/** Keep Cordis effects owned by the real context while adapting public faces. */
export function contextFacade(ctx, overrides) {
  return new Proxy(ctx, { get(target, key) {
    if (Object.hasOwn(overrides, key)) return overrides[key];
    if (key === 'get') return service => Object.hasOwn(overrides, service) ? overrides[service] : target.get(service);
    if (key === 'inject') return (services, callback) => target.inject(services, child => callback(contextFacade(child, overrides)));
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
