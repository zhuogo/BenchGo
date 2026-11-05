import { registerHooks } from 'node:module';

const packageURL = new URL('../plugins/benchgo/package.json', import.meta.url).href;
const sourceRoots = ['harness', 'superagent', 'voice'].map(name => new URL(`../plugins/${name}/`, import.meta.url).href);
const builtCompaction = new URL('../deepseek-harness/packages/compaction/compaction-basic/lib/index.js', import.meta.url).href;

// Source packages share the installed BenchGo dependency tree. Published modules
// live inside that package and use Node's ordinary resolver without this hook.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || /^(?:[./]|[a-z]+:)/i.test(specifier) || !sourceRoots.some(root => context.parentURL?.startsWith(root))) throw error;
      try { return nextResolve(specifier, { ...context, parentURL: packageURL }); }
      catch (missing) {
        // A built engine checkout can supply this official plugin before npm ci.
        if (missing.code !== 'ERR_MODULE_NOT_FOUND' || specifier !== '@deepseek-ai/dsh-compaction-basic') throw missing;
        return nextResolve(builtCompaction, context);
      }
    }
  },
});
