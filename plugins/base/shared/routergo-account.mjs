export const routerGoAccountPath = '/api/benchgo/routergo';
export const routerGoOrigin = 'https://routergo.cn';
export const routerGoRecharge = routerGoOrigin + '/workbench/recharge';

export function isRouterGoAccountReference(ref) {
  return typeof ref === 'string' && /^BENCHGO_ROUTERGO_KEY_[a-f0-9]{32}$/.test(ref);
}
