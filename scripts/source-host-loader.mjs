import { registerHooks } from 'node:module';

// Only root source-host launchers preload this hook. tsx normally resolves
// workspace imports from the host's tsconfig, but installed plugins resolve
// their own npm copy. Scope tags and carriers contain module-local identities:
// both sides must use the same official source module, even at equal versions.
const scopeURL = new URL('../deepseek-harness/packages/core/scope/src/index.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === '@deepseek-ai/dsh-scope' ? scopeURL : specifier, context);
  },
});
