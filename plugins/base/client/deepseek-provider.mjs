const officialProviderId = 'deepseek-official';
const detachedRefPrefix = 'BENCHGO_DEEPSEEK_OFFICIAL_';
const detachedRef = /^BENCHGO_DEEPSEEK_OFFICIAL_[0-9a-f]{32}$/u;

export function deepSeekProviderRow(row, namespace) {
  if (row.entry.provider !== officialProviderId || row.entry.settingsPath.length !== 0 || !namespace) return row;
  const customized = !!namespace.user && Object.keys(namespace.user).length > 0;
  const configured = row.credential?.configured === true || customized && !detachedRef.test(row.apiKeyEnv ?? '');
  return { ...row, configured, removable: configured };
}

export async function disconnectDeepSeekProvider(operations, controller, namespace, revision) {
  if (revision === undefined) return '供应商配置暂不可用，请刷新后重试。';
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const reference = detachedRefPrefix + suffix;
  const written = await operations.writeSettings(
    namespace,
    [{ op: 'set', path: ['apiKeyEnv'], value: reference }],
    revision,
  );
  if (written.kind !== 'written') return written.message;
  await controller.load();
  return undefined;
}
