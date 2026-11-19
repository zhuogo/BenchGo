import { routerGo } from '../shared/builtin-providers.mjs';

export function isRouterGo(id) { return id === routerGo.id; }

export function prioritizeRouterGo(entries, fallback, getId = entry => entry.id) {
  const router = entries.find(entry => isRouterGo(getId(entry))) ?? fallback;
  const others = entries.filter(entry => !isRouterGo(getId(entry)));
  return router ? [router, ...others] : others;
}
