export function hostRootContext(ctx) {
  // The Host and the npm package can expose different Context APIs at the same version.
  const rootKey = ctx.constructor?.root;
  return typeof rootKey === 'symbol' ? ctx[rootKey] : (ctx.root ?? ctx);
}
