import { AsyncLocalStorage } from 'node:async_hooks';
import { hostRootContext } from './host-root-context.mjs';

// Root lifetimes outlive a plugin reload. Keep the startup scope across module
// replacement so new sockets do not inherit HMR's transaction-local state.
const key = Symbol.for('benchgo.host-scopes');
const scopes = globalThis[key] ??= new WeakMap();

/** Native owner HTTP callbacks are outside Gateway and HMR transactions. This
 * also establishes the boundary when BenchGo itself was first enabled by HMR. */
export function captureHostScope(ctx) {
  const scope = AsyncLocalStorage.snapshot();
  scopes.set(hostRootContext(ctx), scope);
  return scope;
}

export function hostScope(ctx) {
  const owner = hostRootContext(ctx);
  return scopes.get(owner) ?? captureHostScope(ctx);
}
