/** BenchGo-owned provider identities; transport remains the official adapter's responsibility. */
export const routerGo = Object.freeze({ id: 'routergo', name: 'RouterGo', baseURL: 'https://routergo.cn/api/v1', protocol: 'openai-completions' });
export function builtinProvider(id) { return id === routerGo.id ? routerGo : undefined; }
