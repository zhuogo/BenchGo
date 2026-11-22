import { isRouterGo } from '../shared/builtin-providers.mjs';
export { isRouterGo };

export function prioritizeRouterGo(entries, fallback, getId = entry => entry.id) {
  const routers = entries.filter(entry => isRouterGo(getId(entry)));
  const others = entries.filter(entry => !isRouterGo(getId(entry)));
  return [...(routers.length ? routers : fallback ? [fallback] : []), ...others];
}
