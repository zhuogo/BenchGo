import { randomUUID } from 'node:crypto';
import { contextFacade, ownerWebServer } from './boundary.mjs';
import { openPreferences, SIDEBAR_NS } from './preferences.mjs';
import { openSshTrust, probeFingerprint } from './ssh-trust.mjs';
import { createWorkbenchSettingsAdapter } from './settings-adapter.mjs';

async function readBody(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new Error('请使用 JSON 请求');
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 32768) throw new Error('请求过大'); chunks.push(chunk); }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求格式无效');
  return body;
}

export async function mountWorkbench(ctx, { directory, loadSidebar = () => import('dsh-better-sidebar'), loadSsh = () => import('../lib/ssh-host.mjs'), probe = probeFingerprint } = {}) {
  const preferences = await openPreferences(directory), trust = await openSshTrust(directory);
  const state = { sidebar: { available: false, status: 'loading' }, ssh: { available: false, status: 'loading' } };
  const challenges = new Map();
  const snapshot = () => ({ ...structuredClone(state), boundary: 'local-owner', trustedHosts: trust.list() });
  ctx.provide('benchgoWorkbench', { snapshot, preferences });
  ctx.effect(() => () => Promise.all([preferences.flush(), trust.close()]));
  ctx.inject(['connection', 'webServer'], child => {
    const server = ownerWebServer(child.webServer, child.connection);
    child.effect(() => server.register({ kind: 'exact', path: '/api/benchgo/workbench', async handler(req, res) {
      try {
        let value;
        if (req.method === 'GET') value = snapshot();
        else if (req.method === 'POST') {
          const input = await readBody(req);
          if (input.action === 'ssh.probe') {
            for (const [key, item] of challenges) if (item.expiresAt < Date.now()) challenges.delete(key);
            if (challenges.size >= 16) throw new Error('待确认连接过多，请稍后重试');
            const result = await probe(input), challenge = randomUUID();
            challenges.set(challenge, { ...result, expiresAt: Date.now() + 120000 });
            value = { ...result, challenge };
          } else if (input.action === 'ssh.confirm') {
            const candidate = challenges.get(input.challenge);
            if (!candidate || candidate.expiresAt < Date.now() || input.fingerprint !== candidate.fingerprint) throw new Error('SSH 指纹确认已过期，请重新探测');
            value = await trust.confirm(candidate); challenges.delete(input.challenge);
          } else throw new Error('不支持的工作台操作');
        } else { res.writeHead(405, { Allow: 'GET, POST' }); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
      } catch (error) { res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: error.message })); }
    } }));
  });
  let disposed = false;
  const mount = (key, load, services, overrides) => {
    let settle;
    const ready = new Promise(resolve => { settle = resolve; });
    state[key] = { available: false, status: 'loading' };
    const fiber = ctx.inject(services, async child => {
      try {
        if (disposed) { settle({ state: 'failed', reason: '工作台服务已停止' }); return; }
        const plugin = await load();
        if (disposed) { settle({ state: 'failed', reason: '工作台服务已停止' }); return; }
        const faces = overrides(child);
        const facade = contextFacade(child, { webServer: ownerWebServer(child.webServer, child.connection, { projectOnly: key === 'sidebar' }), ...faces });
        await plugin.apply(facade, key === 'ssh' ? { enabled: true, announceToAgent: false } : {});
        state[key] = { available: true, status: 'ready' };
        settle({ state: 'applied' });
        child.effect(() => () => { state[key] = { available: false, status: 'loading' }; });
      } catch (error) { state[key] = { available: false, status: 'error', error: error.message }; settle({ state: 'failed', reason: '原侧栏运行时挂载失败，配置已保存；请修正后重试' }); child.logger?.warn?.(`BenchGo ${key}: ${error.message}`); }
    });
    return { fiber, ready };
  };
  const mountSidebar = () => mount('sidebar', loadSidebar, ['connection', 'webServer', 'sessions', 'tools'], child => ({
    settings: preferences,
    loader: { entries: () => [{ options: { id: SIDEBAR_NS, name: 'dsh-better-sidebar' }, fiber: child.fiber }], await: async () => {} },
    profileContext: undefined,
  }));
  let sidebar = mountSidebar(), remounts = Promise.resolve({ state: 'pending', reason: '等待侧栏宿主服务' });
  const unsubscribePreferences = preferences.subscribe(() => {
    remounts = remounts.catch(() => {}).then(async () => {
      if (disposed) return { state: 'failed', reason: '工作台服务已停止' };
      if (typeof sidebar.fiber?.dispose !== 'function') return { state: 'failed', reason: '当前宿主未提供侧栏作用域释放能力，无法安全重装' };
      await sidebar.fiber.dispose();
      if (disposed) return { state: 'failed', reason: '工作台服务已停止' };
      sidebar = mountSidebar();
      let timer;
      try {
        const result = await Promise.race([sidebar.ready, new Promise(resolve => { timer = setTimeout(() => resolve({ state: 'pending', reason: '配置已保存，等待原侧栏宿主完成重新挂载' }), 2000); })]);
        if (result.state === 'failed') { await sidebar.fiber.dispose(); state.sidebar = { available: false, status: 'error', error: result.reason }; }
        return result;
      }
      finally { clearTimeout(timer); }
    }).catch(() => ({ state: 'failed', reason: '配置已保存，原侧栏作用域释放或重新挂载失败' }));
  });
  ctx.effect(() => () => { disposed = true; unsubscribePreferences(); return remounts; });
  ctx.inject(['benchgoSettings'], child => {
    const manager = child.get?.('benchgoSettings');
    if (manager) child.effect(() => manager.register(createWorkbenchSettingsAdapter(preferences, { applyConfig: async ({ namespace, ops, expected, signal }) => {
      await preferences.update(namespace, {}, undefined, { ops, expected, signal });
      return { application: await remounts };
    } })));
  });
  mount('ssh', loadSsh, ['connection', 'webServer', 'tools', 'systemPrompt'], child => ({
    tools: { ...child.tools, register: () => () => {} },
  }));
  return { snapshot, preferences };
}
