/** BenchGo-owned provider identities; transport remains the official adapter's responsibility. */
export const routerGo = Object.freeze({ id: 'routergo', name: 'RouterGo', baseURL: 'https://routergo.cn/api/v1', protocol: 'openai-responses' });
export function isRouterGo(id) { return typeof id === 'string' && /^routergo(?:-[0-9a-f]{32})?$/u.test(id); }
export function builtinProvider(id) { return isRouterGo(id) ? routerGo : undefined; }
export function routerGoConnectionId() { return routerGo.id + '-' + globalThis.crypto.randomUUID().replaceAll('-', ''); }
