// Connection authorization is injected by the unified runtime, never inferred from channel config.
export async function authorizeChannel(options, operation, source, actor) {
  if (typeof options.authorizeConnection === 'function') {
    const result = await options.authorizeConnection({ operation, source, ...(actor ? { actor } : {}) });
    if (result === false || result?.allowed === false) throw Object.assign(new Error('渠道连接授权已撤销'), { status: 403 });
    return result;
  }
  if (options.allowUnboundAuthorization === true) return;
  throw Object.assign(new Error('渠道连接缺少统一授权服务'), { status: 403 });
}
