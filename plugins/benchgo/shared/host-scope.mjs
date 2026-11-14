import { AsyncLocalStorage } from 'node:async_hooks';

// Root lifetimes outlive a plugin reload. Keep the startup scope across module
// replacement so new sockets do not inherit HMR's transaction-local state.
const key = Symbol.for('benchgo.host-scopes');
const scopes = globalThis[key] ??= new WeakMap();

/** Native owner HTTP callbacks are outside Gateway and HMR transactions. This
 * also establishes the boundary when BenchGo itself was first enabled by HMR. */
export function captureHostScope(ctx) {
  const scope = AsyncLocalStorage.snapshot();
  scopes.set(ctx.root ?? ctx, scope);
  return scope;
}

export function hostScope(ctx) {
  const owner = ctx.root ?? ctx;
  return scopes.get(owner) ?? captureHostScope(ctx);
}
