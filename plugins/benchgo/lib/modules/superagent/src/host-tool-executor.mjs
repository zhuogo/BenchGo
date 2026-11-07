// The host's native tool executor, loaded through Cordis so the Router and Worker
// run the official tool pipeline instance the host composed instead of a second
// module copy resolved beside this plugin.

export const OFFICIAL_NATIVE_EXECUTOR = '@deepseek-ai/dsh-tool-executor-native';

/**
 * Obtain the host-owned native executor for this scope.
 *
 * Loading the package beside this plugin would instantiate a second official
 * tool pipeline whose scope filter knows nothing about host-tagged agent
 * scopes, so one agent's `tools/execute` listeners receive every agent's call.
 * Resolving through the loader instead reaches the same module instance the
 * host mounted, whichever installation scope declares it first, and adapts a
 * missing host instance to an explicit error rather than a duplicate copy.
 */
export async function createOfficialHostExecutor(scope, { specifier = OFFICIAL_NATIVE_EXECUTOR, load } = {}) {
  if (scope?.tools == null) throw new Error('工具服务未就绪，无法取得宿主执行器');
  const loader = scope.loader ?? scope.ctx?.loader;
  let loaded;
  if (typeof load === 'function') loaded = await load(specifier);
  else if (loader?.import != null) loaded = await loader.import(specifier);
  const NativeToolExecutor = loaded?.NativeToolExecutor ?? loaded?.default?.NativeToolExecutor;
  if (typeof NativeToolExecutor !== 'function') throw new Error(`宿主未提供官方原生执行器：${specifier}`);
  return new NativeToolExecutor(scope);
}
